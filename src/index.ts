import { z } from "zod";
import { parseJson, JsonParseError } from "./parse.js";
import { coerceToSchema } from "./coerce.js";
import { type CoerceResult, createContext } from "./types.js";
import { Flag, type FlagWithContext } from "./flags.js";
import { diagnosticsFromFlags, inspectValue, resolveLimits, ResourceLimitError, type Diagnostic, type ParserOptions } from "./diagnostics.js";
import { runAdvisoryChecks, type AdvisoryReport } from "./advisory.js";

// Re-export types and utilities
export { Flag, type FlagWithContext } from "./flags.js";
export { type CoerceResult, type CoerceSuccess, type CoerceFailure, type CoerceError } from "./types.js";
export { JsonParseError } from "./parse.js";
export { DEFAULT_PARSER_LIMITS, ResourceLimitError, type Diagnostic, type ParserLimits, type ParserOptions, type ParserBudget } from "./diagnostics.js";
export { advisoryPolicyFingerprint, type AdvisoryCheck, type AdvisoryCheckOutcome, type AdvisoryReport, type AdvisoryStatus } from "./advisory.js";
export { inspectCompletion, type CompletionNode, type CompletionState } from "./syntax.js";
export {
  createStreamParser,
  parseStream,
  type DeepPartial,
  type StreamParser,
  type StreamPushResult,
  type StreamSnapshot,
} from "./stream.js";

/**
 * Parse result from the main parse function.
 */
export type ParseResult<T> =
  | { success: true; data: T; flags: FlagWithContext[]; diagnostics: Diagnostic[]; advisory: AdvisoryReport }
  | { success: false; error: ParseError };

/**
 * Error from parsing.
 */
export interface ParseError {
  type: "json_parse_error" | "coercion_error" | "zod_validation_error" | "resource_limit_error";
  message: string;
  path?: (string | number)[];
  expected?: string;
  received?: string;
  budget?: import("./diagnostics.js").ParserBudget;
  limit?: number;
  diagnostics?: Diagnostic[];
}

/**
 * Parse a string into a typed value using a Zod schema.
 *
 * This is the main entry point for the Schema-Aligned Parser.
 * It combines flexible JSON parsing with schema-aligned coercion.
 *
 * @example
 * ```ts
 * const UserSchema = z.object({
 *   name: z.string(),
 *   age: z.number(),
 * });
 *
 * // Handles malformed JSON
 * const result = parse(UserSchema, `{name: 'John', age: "25",}`);
 * // → { success: true, data: { name: "John", age: 25 }, flags: [...] }
 * ```
 */
export function parse<T extends z.ZodTypeAny>(
  schema: T,
  input: string,
  options?: ParserOptions<z.infer<T>>
): ParseResult<z.infer<T>> {
  const limits = resolveLimits(options);
  // Phase 1: Flexible JSON parsing
  let parsed: unknown;
  let parseFlags: FlagWithContext[] = [];

  try {
    const parseResult = parseJson(input, limits);
    parsed = parseResult.value;
    inspectValue(parsed, limits);
    parseFlags = parseResult.flags;
  } catch (e) {
    if (e instanceof ResourceLimitError) {
      return { success: false, error: { type: "resource_limit_error", message: e.message, budget: e.budget, limit: e.limit, diagnostics: [{ code: "resource_limit_exceeded", phase: "safety", path: [], severity: "error", cost: 0 }] } };
    }
    if (e instanceof JsonParseError) {
      return {
        success: false,
        error: {
          type: "json_parse_error",
          message: e.message,
        },
      };
    }
    throw e;
  }

  // Phase 2: Schema-aligned coercion
  const ctx = createContext(limits);
  ctx.flags.push(...parseFlags);

  let result: CoerceResult<z.infer<T>>;
  try { result = coerceToSchema(schema, parsed, ctx); }
  catch (e) {
    if (e instanceof ResourceLimitError) return { success: false, error: { type: "resource_limit_error", message: e.message, budget: e.budget, limit: e.limit } };
    throw e;
  }
  const diagnostics = diagnosticsFromFlags(ctx.flags, limits);

  if (result.success) {
    const validated = schema.safeParse(result.value);
    if (!validated.success) {
      const issue = validated.error.issues[0];
      return {
        success: false,
        error: {
          type: "zod_validation_error",
          message: issue?.message ?? "Zod validation failed",
          path: issue?.path.map(String),
          expected: issue?.code,
          received: typeof result.value,
        },
      };
    }
    const advisory = runAdvisoryChecks(validated.data, options?.advisoryChecks, limits);
    return {
      success: true,
      data: validated.data,
      flags: result.flags,
      diagnostics: [...diagnostics, ...advisory.checks.flatMap((check) => check.diagnostic ? [check.diagnostic] : [])].slice(0, limits.maxDiagnostics),
      advisory,
    };
  }

  return {
    success: false,
    error: {
      type: "coercion_error",
      message: result.error.message,
      path: result.error.path,
      expected: result.error.expected,
      received: result.error.received,
      diagnostics,
    },
  };
}

/**
 * Parse a string into a typed value, throwing on error.
 *
 * @throws {Error} If parsing or coercion fails
 */
export function parseOrThrow<T extends z.ZodTypeAny>(
  schema: T,
  input: string,
  options?: ParserOptions<z.infer<T>>,
): z.infer<T> {
  const result = parse(schema, input, options);

  if (!result.success) {
    const error = result.error;
    const path = error.path?.join(".") ?? "";
    throw new Error(
      `Parse error${path ? ` at ${path}` : ""}: ${error.message}`
    );
  }

  return result.data;
}

/**
 * Coerce an already-parsed value to match a schema.
 *
 * Use this when you already have a parsed JavaScript value
 * and just need schema-aligned coercion.
 *
 * @example
 * ```ts
 * const data = JSON.parse(rawJson);
 * const result = coerce(UserSchema, data);
 * ```
 */
export function coerce<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
  options?: ParserOptions
): CoerceResult<z.infer<T>> {
  const limits = resolveLimits(options);
  try { inspectValue(value, limits); } catch (e) {
    if (e instanceof ResourceLimitError) return { success: false, error: { type: "resource_limit_error", message: e.message, path: [], expected: e.budget, received: "limit exceeded", budget: e.budget, limit: e.limit }, diagnostics: [{ code: "resource_limit_exceeded", phase: "safety", path: [], severity: "error", cost: 0 }] };
    throw e;
  }
  const ctx = createContext(limits);
  let result: CoerceResult<z.infer<T>>;
  try { result = coerceToSchema(schema, value, ctx); } catch (e) {
    if (e instanceof ResourceLimitError) return { success: false, error: { type: "resource_limit_error", message: e.message, path: [], expected: e.budget, received: "limit exceeded", budget: e.budget, limit: e.limit }, diagnostics: [{ code: "resource_limit_exceeded", phase: "safety", path: [], severity: "error", cost: 0 }] };
    throw e;
  }
  if (!result.success) {
    result.diagnostics = diagnosticsFromFlags(ctx.flags, limits);
    return result;
  }
  result.diagnostics = diagnosticsFromFlags(result.flags, limits);
  const validated = schema.safeParse(result.value);
  if (validated.success) return { ...result, value: validated.data };
  const issue = validated.error.issues[0];
  return {
    success: false,
    error: {
      message: issue?.message ?? "Zod validation failed",
      path: issue?.path.map((part) => typeof part === "symbol" ? part.description ?? String(part) : part) ?? [],
      expected: issue?.code ?? "valid value",
      received: typeof result.value,
    },
  };
}

/**
 * Coerce a value to match a schema, throwing on error.
 *
 * @throws {Error} If coercion fails
 */
export function coerceOrThrow<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown
): z.infer<T> {
  const result = coerce(schema, value);

  if (!result.success) {
    const path = result.error.path.join(".") || "<root>";
    throw new Error(`Coercion error at ${path}: ${result.error.message}`);
  }

  return result.value;
}

/**
 * Check if a parse result has any coercion flags.
 * Useful for detecting when values were transformed.
 */
export function hasFlags(result: ParseResult<unknown>): boolean {
  return result.success && result.flags.length > 0;
}

/**
 * Get the flag types from a parse result.
 */
export function getFlags(result: ParseResult<unknown>): Flag[] {
  if (!result.success) return [];
  return result.flags.map((f) => f.flag);
}
