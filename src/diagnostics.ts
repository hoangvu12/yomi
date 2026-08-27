import { Flag, type FlagWithContext } from "./flags.js";

export type DiagnosticPhase = "syntax" | "coercion" | "validation" | "safety";
export type DiagnosticSeverity = "info" | "warning" | "error";

export interface Diagnostic {
  code: string;
  phase: DiagnosticPhase;
  path: (string | number)[];
  severity: DiagnosticSeverity;
  cost: number;
  evidence?: string;
}

export interface ParserLimits {
  maxInputBytes: number;
  maxNestingDepth: number;
  maxCollectionSize: number;
  maxCandidates: number;
  maxRepairWork: number;
  maxRetainedEvidenceBytes: number;
  maxDiagnostics: number;
}

export type ParserOptions = { limits?: Partial<ParserLimits> };

export const DEFAULT_PARSER_LIMITS: Readonly<ParserLimits> = Object.freeze({
  maxInputBytes: 1_048_576,
  maxNestingDepth: 64,
  maxCollectionSize: 10_000,
  maxCandidates: 128,
  maxRepairWork: 16,
  maxRetainedEvidenceBytes: 1_024,
  maxDiagnostics: 100,
});

export type ParserBudget = keyof ParserLimits;

export class ResourceLimitError extends Error {
  readonly type = "resource_limit_error" as const;
  constructor(public readonly budget: ParserBudget, public readonly limit: number) {
    super(`Parser resource limit exceeded: ${budget} (${limit})`);
    this.name = "ResourceLimitError";
  }
}

export function resolveLimits(options?: ParserOptions): ParserLimits {
  const limits = { ...DEFAULT_PARSER_LIMITS, ...options?.limits };
  for (const [budget, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${budget} must be a non-negative safe integer`);
    }
  }
  return limits;
}

export function inspectValue(value: unknown, limits: ParserLimits): void {
  const seen = new WeakSet<object>();
  const visit = (current: unknown, depth: number): void => {
    if (depth > limits.maxNestingDepth) throw new ResourceLimitError("maxNestingDepth", limits.maxNestingDepth);
    if (current === null || typeof current !== "object") return;
    if (seen.has(current)) return;
    seen.add(current);
    const entries = Array.isArray(current) ? current.map((v, i) => [i, v] as const) : Object.entries(current);
    if (entries.length > limits.maxCollectionSize) throw new ResourceLimitError("maxCollectionSize", limits.maxCollectionSize);
    for (const [, child] of entries) visit(child, depth + 1);
  };
  visit(value, 0);
}

const COST: Partial<Record<Flag, number>> = {
  [Flag.JsonRepaired]: 1,
  [Flag.ExtractedFromMarkdown]: 1,
  [Flag.ExtractedFromText]: 1,
  [Flag.DefaultUsed]: 2,
  [Flag.ExtraKeysIgnored]: 1,
};

export function diagnosticsFromFlags(flags: FlagWithContext[], limits: ParserLimits): Diagnostic[] {
  let retained = 0;
  return flags.slice(0, limits.maxDiagnostics).map((item) => {
    const phase = item.flag === Flag.JsonRepaired || item.flag === Flag.ExtractedFromMarkdown || item.flag === Flag.ExtractedFromText ? "syntax" : "coercion";
    let evidence: string | undefined;
    const serialized = JSON.stringify(item);
    const bytes = new TextEncoder().encode(serialized).byteLength;
    if (retained + bytes <= limits.maxRetainedEvidenceBytes) {
      evidence = serialized;
      retained += bytes;
    }
    return { code: item.flag, phase, path: item.path ?? [], severity: "warning", cost: COST[item.flag] ?? 1, ...(evidence ? { evidence } : {}) };
  });
}
