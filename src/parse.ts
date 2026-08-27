import { jsonrepair } from "jsonrepair";
import { Flag, flag, type FlagWithContext } from "./flags.js";
import { ResourceLimitError, type ParserLimits } from "./diagnostics.js";

export interface ParseResult {
  value: unknown;
  flags: FlagWithContext[];
}

/**
 * LLM outputs are notoriously messy - they wrap JSON in markdown, add
 * explanatory text, use single quotes, leave trailing commas, etc.
 *
 * We try progressively more aggressive strategies to extract valid JSON,
 * preferring minimal intervention (so we try JSON.parse first before repair).
 */
export function parseJson(input: string, limits?: ParserLimits): ParseResult {
  if (limits && new TextEncoder().encode(input).byteLength > limits.maxInputBytes) {
    throw new ResourceLimitError("maxInputBytes", limits.maxInputBytes);
  }
  let repairWork = 0;
  const spendRepair = (): void => {
    repairWork++;
    if (limits && repairWork > limits.maxRepairWork) throw new ResourceLimitError("maxRepairWork", limits.maxRepairWork);
  };
  const trimmed = input.trim();
  const flags: FlagWithContext[] = [];

  // Fast path: if it's already valid JSON, don't waste time on extraction/repair
  try {
    return { value: JSON.parse(trimmed), flags };
  } catch {
    // Expected for most LLM outputs - continue to extraction strategies
  }

  // LLMs love wrapping responses in ```json blocks, especially ChatGPT
  const markdownResult = extractFromMarkdown(trimmed);
  if (markdownResult !== null) {
    flags.push(flag(Flag.ExtractedFromMarkdown));
    try {
      return { value: JSON.parse(markdownResult), flags };
    } catch {
      // The extracted content might still have syntax issues
      try {
        spendRepair();
        const repaired = jsonrepair(markdownResult);
        flags.push(flag(Flag.JsonRepaired));
        return { value: JSON.parse(repaired), flags };
      } catch (error) {
        if (error instanceof ResourceLimitError) throw error;
        // Markdown extraction didn't help, try other strategies
      }
    }
  }

  // LLMs often prefix JSON with "Here's the result:" or similar
  const extracted = extractJsonFromText(trimmed);
  if (extracted !== null && extracted !== trimmed) {
    flags.push(flag(Flag.ExtractedFromText));
    try {
      return { value: JSON.parse(extracted), flags };
    } catch {
      try {
        spendRepair();
        const repaired = jsonrepair(extracted);
        flags.push(flag(Flag.JsonRepaired));
        return { value: JSON.parse(repaired), flags };
      } catch (error) {
        if (error instanceof ResourceLimitError) throw error;
        // Extraction didn't help, try repairing the whole thing
      }
    }
  }

  // Last resort: let jsonrepair try to fix whatever syntax issues exist
  // (trailing commas, unquoted keys, single quotes, comments, etc.)
  try {
    spendRepair();
    const repaired = jsonrepair(trimmed);
    flags.push(flag(Flag.JsonRepaired));
    return { value: JSON.parse(repaired), flags };
  } catch (error) {
    if (error instanceof ResourceLimitError) throw error;
    throw new JsonParseError(`Failed to parse JSON: ${trimmed.slice(0, 100)}...`);
  }
}

/**
 * ChatGPT and Claude often wrap JSON in markdown code blocks.
 * We extract the content between the backticks.
 */
function extractFromMarkdown(input: string): string | null {
  const codeBlockMatch = input.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch?.[1]) {
    return codeBlockMatch[1].trim();
  }
  return null;
}

/**
 * LLMs often add context around JSON: "Here's your data: {...} Let me know if..."
 * We find balanced braces/brackets to extract just the JSON portion.
 *
 * Uses a simple state machine to handle strings (so braces inside strings
 * don't confuse the matching) and escape sequences.
 */
function extractJsonFromText(input: string): string | null {
  const objectStart = input.indexOf("{");
  const arrayStart = input.indexOf("[");

  let start: number;
  let openChar: string;
  let closeChar: string;

  if (objectStart === -1 && arrayStart === -1) {
    return null;
  } else if (objectStart === -1) {
    start = arrayStart;
    openChar = "[";
    closeChar = "]";
  } else if (arrayStart === -1) {
    start = objectStart;
    openChar = "{";
    closeChar = "}";
  } else {
    // Use whichever structure appears first in the text
    if (objectStart < arrayStart) {
      start = objectStart;
      openChar = "{";
      closeChar = "}";
    } else {
      start = arrayStart;
      openChar = "[";
      closeChar = "]";
    }
  }

  // Track nesting depth, ignoring braces inside strings
  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = start; i < input.length; i++) {
    const char = input[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === "\\") {
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === openChar) {
      depth++;
    } else if (char === closeChar) {
      depth--;
      if (depth === 0) {
        return input.slice(start, i + 1);
      }
    }
  }

  // Unclosed JSON - return what we have, jsonrepair might fix it
  return input.slice(start);
}

export class JsonParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonParseError";
  }
}
