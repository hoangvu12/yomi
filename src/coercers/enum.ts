import { Flag } from "../flags.js";
import {
  type CoerceContext,
  type CoerceResult,
  success,
  failure,
  describeType,
} from "../types.js";

/**
 * LLMs often return enum values with wrong casing - "PENDING" instead of "pending".
 * Rather than failing, we do case-insensitive matching and track when it happens.
 */
export function coerceEnum<T extends string>(
  value: unknown,
  allowedValues: readonly T[],
  ctx: CoerceContext
): CoerceResult<T> {
  if (typeof value !== "string") {
    return failure(
      `Expected enum value, got ${describeType(value)}`,
      ctx,
      allowedValues.join(" | "),
      describeType(value)
    );
  }

  // Fast path: exact match
  if (allowedValues.includes(value as T)) {
    return success(value as T, ctx);
  }

  // Fallback: case-insensitive match
  const lowerValue = value.toLowerCase();
  const match = allowedValues.find((v) => v.toLowerCase() === lowerValue);

  if (match) {
    ctx.flags.push({ flag: Flag.EnumCaseInsensitive, input: value, matched: match });
    return success(match, ctx);
  }

  return failure(
    `Value "${value}" is not a valid enum value`,
    ctx,
    allowedValues.join(" | "),
    `"${value}"`
  );
}

/**
 * TypeScript enums have reverse mappings for numeric values.
 * We filter those out and match against both keys and values.
 */
export function coerceNativeEnum<T extends Record<string, string | number>>(
  value: unknown,
  enumObject: T,
  ctx: CoerceContext
): CoerceResult<T[keyof T]> {
  // Filter out numeric keys (reverse mappings from numeric enums)
  const enumValues = Object.entries(enumObject)
    .filter(([key]) => isNaN(Number(key)))
    .map(([_, val]) => val);

  if (enumValues.includes(value as T[keyof T])) {
    return success(value as T[keyof T], ctx);
  }

  // Try matching by key or value name, case-insensitive
  if (typeof value === "string") {
    const lowerValue = value.toLowerCase();

    for (const [key, enumValue] of Object.entries(enumObject)) {
      if (isNaN(Number(key))) {
        // Match against enum key name
        if (key.toLowerCase() === lowerValue) {
          ctx.flags.push({ flag: Flag.EnumCaseInsensitive, input: value, matched: key });
          return success(enumValue as T[keyof T], ctx);
        }

        // Match against string enum value
        if (typeof enumValue === "string" && enumValue.toLowerCase() === lowerValue) {
          ctx.flags.push({ flag: Flag.EnumCaseInsensitive, input: value, matched: enumValue });
          return success(enumValue as T[keyof T], ctx);
        }
      }
    }
  }

  // For numeric enums, also accept the number directly
  if (typeof value === "number") {
    if (enumValues.includes(value)) {
      return success(value as T[keyof T], ctx);
    }
  }

  return failure(
    `Value "${String(value)}" is not a valid enum value`,
    ctx,
    enumValues.map((v) => String(v)).join(" | "),
    describeType(value)
  );
}
