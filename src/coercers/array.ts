import { Flag } from "../flags.js";
import {
  type CoerceContext,
  type CoerceResult,
  childContext,
  success,
  failure,
  describeType,
} from "../types.js";

export type ElementCoercer<T> = (value: unknown, ctx: CoerceContext) => CoerceResult<T>;

/**
 * LLMs often return a single item when we expect an array (especially when
 * there's only one result). Rather than failing, we wrap it in an array.
 */
export function coerceArray<T>(
  value: unknown,
  elementCoercer: ElementCoercer<T>,
  ctx: CoerceContext
): CoerceResult<T[]> {
  if (value === null || value === undefined) {
    return failure("Expected array, got null/undefined", ctx, "array", describeType(value));
  }

  if (Array.isArray(value)) {
    const results: T[] = [];

    for (let i = 0; i < value.length; i++) {
      // Each element gets its own path context for error reporting
      const elementCtx = childContext(ctx, i);
      const result = elementCoercer(value[i], elementCtx);

      if (!result.success) {
        return result;
      }

      results.push(result.value);
    }

    return success(results, ctx);
  }

  // Single value → wrap in array (common LLM behavior)
  ctx.flags.push({ flag: Flag.SingleToArray });
  const elementCtx = childContext(ctx, 0);
  const result = elementCoercer(value, elementCtx);

  if (!result.success) {
    return result;
  }

  return success([result.value], ctx);
}

/**
 * The reverse case: schema expects single value but LLM returned [value].
 * If the array has exactly one element, unwrap it.
 */
export function coerceArrayToSingle<T>(
  value: unknown,
  elementCoercer: ElementCoercer<T>,
  ctx: CoerceContext
): CoerceResult<T> {
  if (!Array.isArray(value)) {
    return elementCoercer(value, ctx);
  }

  if (value.length === 0) {
    return failure("Expected single value, got empty array", ctx, "single value", "empty array");
  }

  if (value.length > 1) {
    return failure(
      `Expected single value, got array with ${value.length} elements`,
      ctx,
      "single value",
      `array[${value.length}]`
    );
  }

  ctx.flags.push({ flag: Flag.ArrayToSingle });
  const elementCtx = childContext(ctx, 0);
  return elementCoercer(value[0], elementCtx);
}

/**
 * Tuples are fixed-length arrays where each position has a specific type.
 * We validate length matches and coerce each element to its expected type.
 */
export function coerceTuple<T extends unknown[]>(
  value: unknown,
  elementCoercers: { [K in keyof T]: ElementCoercer<T[K]> },
  ctx: CoerceContext
): CoerceResult<T> {
  if (!Array.isArray(value)) {
    return failure("Expected tuple (array), got " + describeType(value), ctx, "tuple", describeType(value));
  }

  if (value.length !== elementCoercers.length) {
    return failure(
      `Expected tuple of length ${elementCoercers.length}, got length ${value.length}`,
      ctx,
      `tuple[${elementCoercers.length}]`,
      `array[${value.length}]`
    );
  }

  const results: unknown[] = [];

  for (let i = 0; i < elementCoercers.length; i++) {
    const elementCtx = childContext(ctx, i);
    const coercer = elementCoercers[i];
    if (!coercer) {
      return failure(`Missing coercer for index ${i}`, ctx, "coercer", "undefined");
    }
    const result = coercer(value[i], elementCtx);

    if (!result.success) {
      return result;
    }

    results.push(result.value);
  }

  return success(results as T, ctx);
}
