import type { z } from "zod";
import type { FlagWithContext } from "./flags.js";
import type { Diagnostic, ParserLimits } from "./diagnostics.js";

/**
 * Result of successful coercion, including the value and any transformation flags.
 */
export interface CoerceSuccess<T> {
  success: true;
  value: T;
  flags: FlagWithContext[];
  diagnostics?: Diagnostic[];
}

/**
 * Result of failed coercion, including error details.
 */
export interface CoerceFailure {
  success: false;
  error: CoerceError;
  diagnostics?: Diagnostic[];
}

/**
 * Combined result type for coercion.
 */
export type CoerceResult<T> = CoerceSuccess<T> | CoerceFailure;

/**
 * Error that occurred during coercion.
 */
export interface CoerceError {
  type?: "coercion_error" | "resource_limit_error" | "ambiguity_error";
  message: string;
  path: (string | number)[];
  expected: string;
  received: string;
  budget?: import("./diagnostics.js").ParserBudget;
  limit?: number;
}

/**
 * Context passed through the coercion process.
 */
export interface CoerceContext {
  /** Current path in the object (for error messages) */
  path: (string | number)[];
  /** Accumulated flags */
  flags: FlagWithContext[];
  /** Allow structurally incomplete containers while an LLM response is streaming. */
  partial?: boolean;
  limits?: ParserLimits;
  candidates?: number;
  /** Shared instrumentation across nested candidate contexts. */
  work?: { candidateAttempts: number };
  diagnostics: Diagnostic[];
  unionTieBreaker?: import("./diagnostics.js").UnionTieBreaker;
}

/**
 * Create a new coercion context.
 */
export function createContext(limits?: ParserLimits, work?: { candidateAttempts: number }): CoerceContext {
  return { path: [], flags: [], diagnostics: [], limits, candidates: 0, work };
}

/**
 * Create a child context with an extended path.
 */
export function childContext(ctx: CoerceContext, segment: string | number): CoerceContext {
  return {
    path: [...ctx.path, segment],
    flags: ctx.flags, // Share flags array
    partial: ctx.partial,
    limits: ctx.limits,
    candidates: ctx.candidates,
    work: ctx.work,
    diagnostics: ctx.diagnostics,
    unionTieBreaker: ctx.unionTieBreaker,
  };
}

export function addFlag(ctx: CoerceContext, item: FlagWithContext): void {
  ctx.flags.push({ ...item, path: [...ctx.path] });
}

/**
 * Create a success result.
 */
export function success<T>(value: T, ctx: CoerceContext): CoerceSuccess<T> {
  return { success: true, value, flags: ctx.flags, diagnostics: ctx.diagnostics };
}

/**
 * Create a failure result.
 */
export function failure(
  message: string,
  ctx: CoerceContext,
  expected: string,
  received: string
): CoerceFailure {
  return {
    success: false,
    error: {
      message,
      path: ctx.path,
      expected,
      received,
    },
  };
}

/**
 * Type helper to extract the inferred type from a Zod schema.
 */
export type InferSchema<T extends z.ZodTypeAny> = z.infer<T>;

/**
 * Get a human-readable type description for an unknown value.
 */
export function describeType(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
