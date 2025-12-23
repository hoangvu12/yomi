import { Flag } from "../flags.js";
import {
  type CoerceContext,
  type CoerceResult,
  type CoerceFailure,
  success,
  failure,
  createContext,
  describeType,
} from "../types.js";

export type Coercer<T> = (value: unknown, ctx: CoerceContext) => CoerceResult<T>;

/**
 * For z.union([A, B, C]), we try each type in order and return the first success.
 *
 * Order matters! If you have z.union([z.string(), z.number()]), a number will
 * become a string because string coercion accepts numbers. Put more specific
 * types first if you want them to take priority.
 *
 * We use a temporary context for each attempt so failed attempts don't
 * pollute the flags of the successful one.
 */
export function coerceUnion<T>(
  value: unknown,
  coercers: Coercer<T>[],
  ctx: CoerceContext
): CoerceResult<T> {
  const errors: CoerceFailure[] = [];

  for (const coercer of coercers) {
    const tempCtx = createContext();
    tempCtx.path = ctx.path;

    const result = coercer(value, tempCtx);

    if (result.success) {
      // Only merge flags from the successful path
      ctx.flags.push(...tempCtx.flags);
      return success(result.value, ctx);
    }

    errors.push(result);
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
    ctx.flags.push({ flag: Flag.NullToUndefined });
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
    ctx.flags.push({ flag: Flag.NullToUndefined });
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
    ctx.flags.push({ flag: Flag.DefaultUsed });
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

  ctx.flags.push({ flag: Flag.DefaultUsed });
  return success(catchValue, ctx);
}
