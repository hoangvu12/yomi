import type { z } from "zod";
import type { FlagWithContext } from "./flags.js";

/**
 * Result of successful coercion, including the value and any transformation flags.
 */
export interface CoerceSuccess<T> {
  success: true;
  value: T;
  flags: FlagWithContext[];
}

/**
 * Result of failed coercion, including error details.
 */
export interface CoerceFailure {
  success: false;
  error: CoerceError;
}

/**
 * Combined result type for coercion.
 */
export type CoerceResult<T> = CoerceSuccess<T> | CoerceFailure;

/**
 * Error that occurred during coercion.
 */
export interface CoerceError {
  message: string;
  path: (string | number)[];
  expected: string;
  received: string;
}

/**
 * Context passed through the coercion process.
 */
export interface CoerceContext {
  /** Current path in the object (for error messages) */
  path: (string | number)[];
  /** Accumulated flags */
  flags: FlagWithContext[];
}

/**
 * Create a new coercion context.
 */
export function createContext(): CoerceContext {
  return { path: [], flags: [] };
}

/**
 * Create a child context with an extended path.
 */
export function childContext(ctx: CoerceContext, segment: string | number): CoerceContext {
  return {
    path: [...ctx.path, segment],
    flags: ctx.flags, // Share flags array
  };
}

/**
 * Create a success result.
 */
export function success<T>(value: T, ctx: CoerceContext): CoerceSuccess<T> {
  return { success: true, value, flags: ctx.flags };
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
