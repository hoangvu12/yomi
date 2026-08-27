import { Flag } from "../flags.js";
import {
  type CoerceContext,
  type CoerceResult,
  type CoerceFailure,
  success,
  failure,
  createContext,
  describeType,
  addFlag,
} from "../types.js";
import { ResourceLimitError } from "../diagnostics.js";
import { interpretationCost } from "../diagnostics.js";

export type Coercer<T> = (value: unknown, ctx: CoerceContext) => CoerceResult<T>;

export interface UnionCandidate<T> {
  index?: number;
  coercer: Coercer<T>;
  validate?: (value: unknown) => { success: boolean; error?: { issues?: { message: string; path: PropertyKey[] }[] } };
}

function materiallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left as object).sort();
  const rightKeys = Object.keys(right as object).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index]) &&
    leftKeys.every((key) => materiallyEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

/**
 * Evaluate every eligible union candidate in an isolated context, validate its
 * produced value, and select the lowest-cost interpretation.
 */
export function coerceUnion<T>(
  value: unknown,
  candidates: UnionCandidate<T>[],
  ctx: CoerceContext
): CoerceResult<T> {
  const errors: CoerceFailure[] = [];
  const successes: { index: number; result: Extract<CoerceResult<T>, { success: true }>; cost: number }[] = [];

  for (const [index, candidate] of candidates.entries()) {
    const candidateIndex = candidate.index ?? index;
    ctx.candidates = (ctx.candidates ?? 0) + 1;
    if (ctx.limits && ctx.candidates > ctx.limits.maxCandidates) {
      throw new ResourceLimitError("maxCandidates", ctx.limits.maxCandidates);
    }
    const tempCtx = createContext();
    tempCtx.path = ctx.path;
    tempCtx.partial = ctx.partial;
    tempCtx.limits = ctx.limits;
    tempCtx.candidates = ctx.candidates;
    tempCtx.unionTieBreaker = ctx.unionTieBreaker;
    tempCtx.diagnostics = ctx.diagnostics;

    const result = candidate.coercer(value, tempCtx);

    if (result.success) {
      const validation = candidate.validate?.(result.value);
      if (!validation || validation.success) {
        successes.push({ index: candidateIndex, result, cost: interpretationCost(tempCtx.flags) });
        continue;
      }
      const issue = validation.error?.issues?.[0];
      ctx.diagnostics.push({ code: "union_candidate_rejected", phase: "validation", path: ctx.path, severity: "info", cost: interpretationCost(tempCtx.flags), candidate: candidateIndex, evidence: issue ? `${issue.path.map(String).join(".")}: ${issue.message}` : "candidate validation failed" });
      errors.push(failure(issue?.message ?? "Candidate validation failed", tempCtx, "valid union candidate", describeType(result.value)));
      continue;
    }

    ctx.diagnostics.push({ code: "union_candidate_rejected", phase: "coercion", path: ctx.path, severity: "info", cost: interpretationCost(tempCtx.flags), candidate: candidateIndex, evidence: result.error.message });
    errors.push(result);
  }

  if (successes.length > 0) {
    const bestCost = Math.min(...successes.map((item) => item.cost));
    const best = successes.filter((item) => item.cost === bestCost);
    const distinct = best.filter((item, index) => !best.slice(0, index).some((other) => materiallyEqual(item.result.value, other.result.value)));
    if (distinct.length > 1) {
      for (const item of best) ctx.diagnostics.push({ code: "union_ambiguous_candidate", phase: "coercion", path: ctx.path, severity: "warning", cost: item.cost, candidate: item.index });
      if ((ctx.unionTieBreaker ?? "error") === "error") {
        const ambiguous = failure("Ambiguous union: equal-cost candidates produced different values", ctx, "unambiguous union value", describeType(value));
        ambiguous.error.type = "ambiguity_error";
        ambiguous.diagnostics = ctx.diagnostics;
        return ambiguous;
      }
    }
    const chosen = best[0]!;
    ctx.flags.push(...chosen.result.flags);
    ctx.diagnostics.push({ code: "union_candidate_chosen", phase: "coercion", path: ctx.path, severity: distinct.length > 1 ? "warning" : "info", cost: chosen.cost, candidate: chosen.index });
    for (const item of successes) if (item !== chosen) ctx.diagnostics.push({ code: "union_candidate_rejected", phase: "coercion", path: ctx.path, severity: "info", cost: item.cost, candidate: item.index, evidence: item.cost === bestCost ? "equal-cost alternative" : `higher cost than chosen candidate (${bestCost})` });
    return success(chosen.result.value, ctx);
  }

  const expectedTypes = errors.map((e) => e.error.expected).join(" | ");
  return failure(
    `Value does not match any union type`,
    ctx,
    expectedTypes,
    describeType(value)
  );
}


/**
 * For z.optional(T), both undefined and null become undefined.
 * This bridges JSON's null with TypeScript's optional fields.
 */
export function coerceOptional<T>(
  value: unknown,
  innerCoercer: Coercer<T>,
  ctx: CoerceContext
): CoerceResult<T | undefined> {
  if (value === undefined) {
    return success(undefined, ctx);
  }

  // JSON has null, TypeScript has undefined - treat them the same for optional
  if (value === null) {
    addFlag(ctx, { flag: Flag.NullToUndefined });
    return success(undefined, ctx);
  }

  return innerCoercer(value, ctx);
}

/**
 * For z.nullable(T), both null and undefined become null.
 * The inverse of optional - useful when the schema explicitly expects null.
 */
export function coerceNullable<T>(
  value: unknown,
  innerCoercer: Coercer<T>,
  ctx: CoerceContext
): CoerceResult<T | null> {
  if (value === null) {
    return success(null, ctx);
  }

  if (value === undefined) {
    addFlag(ctx, { flag: Flag.NullToUndefined });
    return success(null, ctx);
  }

  return innerCoercer(value, ctx);
}

/**
 * For z.default(value), use the default when input is missing.
 * Tracks when defaults are used so callers can distinguish explicit
 * values from fallbacks.
 */
export function coerceDefault<T>(
  value: unknown,
  innerCoercer: Coercer<T>,
  defaultValue: T,
  ctx: CoerceContext
): CoerceResult<T> {
  if (value === undefined || value === null) {
    addFlag(ctx, { flag: Flag.DefaultUsed });
    return success(defaultValue, ctx);
  }

  return innerCoercer(value, ctx);
}

/**
 * For z.catch(value), return the catch value if coercion fails.
 * Unlike default (which handles missing values), catch handles invalid values.
 */
export function coerceCatch<T>(
  value: unknown,
  innerCoercer: Coercer<T>,
  catchValue: T,
  ctx: CoerceContext
): CoerceResult<T> {
  const result = innerCoercer(value, ctx);

  if (result.success) {
    return result;
  }

  addFlag(ctx, { flag: Flag.DefaultUsed });
  return success(catchValue, ctx);
}
