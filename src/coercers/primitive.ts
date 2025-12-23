import { Flag } from "../flags.js";
import {
  type CoerceContext,
  type CoerceResult,
  success,
  failure,
  describeType,
} from "../types.js";

/**
 * String is the most permissive type - almost anything can become a string.
 * This is intentional since LLMs generate text, so stringification is natural.
 */
export function coerceString(value: unknown, ctx: CoerceContext): CoerceResult<string> {
  if (typeof value === "string") {
    return success(value, ctx);
  }

  // Numbers and booleans have obvious string representations
  if (typeof value === "number") {
    ctx.flags.push({ flag: Flag.NumberToString });
    return success(String(value), ctx);
  }

  if (typeof value === "boolean") {
    ctx.flags.push({ flag: Flag.BoolToString });
    return success(String(value), ctx);
  }

  // null/undefined have no meaningful string form - fail rather than return "null"
  if (value === null || value === undefined) {
    return failure("Expected string, got null/undefined", ctx, "string", describeType(value));
  }

  return failure(
    `Cannot coerce ${describeType(value)} to string`,
    ctx,
    "string",
    describeType(value)
  );
}

/**
 * LLMs often return numbers as strings because they're generating text.
 * "25" is obviously meant to be 25, so we parse it.
 */
export function coerceNumber(value: unknown, ctx: CoerceContext): CoerceResult<number> {
  if (typeof value === "number") {
    // NaN is technically a number but useless - treat as error
    if (Number.isNaN(value)) {
      return failure("Got NaN", ctx, "number", "NaN");
    }
    return success(value, ctx);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    const parsed = parseFloat(trimmed);
    if (!Number.isNaN(parsed)) {
      ctx.flags.push({ flag: Flag.StringToNumber });
      return success(parsed, ctx);
    }
    return failure(`Cannot parse "${trimmed}" as number`, ctx, "number", "string");
  }

  if (value === null || value === undefined) {
    return failure("Expected number, got null/undefined", ctx, "number", describeType(value));
  }

  return failure(
    `Cannot coerce ${describeType(value)} to number`,
    ctx,
    "number",
    describeType(value)
  );
}

/**
 * When the schema expects an integer but LLM returns a float,
 * rounding is more useful than failing. We track the precision loss.
 */
export function coerceInt(value: unknown, ctx: CoerceContext): CoerceResult<number> {
  const numResult = coerceNumber(value, ctx);
  if (!numResult.success) {
    return numResult;
  }

  const num = numResult.value;
  if (Number.isInteger(num)) {
    return success(num, ctx);
  }

  const rounded = Math.round(num);
  ctx.flags.push({ flag: Flag.FloatToInt, original: num, rounded });
  return success(rounded, ctx);
}

/**
 * LLMs return booleans in many forms: "true", "yes", "1", etc.
 * We accept common truthy/falsy representations humans use.
 */
export function coerceBoolean(value: unknown, ctx: CoerceContext): CoerceResult<boolean> {
  if (typeof value === "boolean") {
    return success(value, ctx);
  }

  if (typeof value === "string") {
    const lower = value.toLowerCase().trim();

    // Common truthy strings across languages and conventions
    if (lower === "true" || lower === "yes" || lower === "1" || lower === "on") {
      ctx.flags.push({ flag: Flag.StringToBool });
      return success(true, ctx);
    }

    if (lower === "false" || lower === "no" || lower === "0" || lower === "off") {
      ctx.flags.push({ flag: Flag.StringToBool });
      return success(false, ctx);
    }

    return failure(`Cannot parse "${value}" as boolean`, ctx, "boolean", "string");
  }

  // 1/0 are common boolean representations in APIs
  if (typeof value === "number") {
    if (value === 1) {
      ctx.flags.push({ flag: Flag.StringToBool });
      return success(true, ctx);
    }
    if (value === 0) {
      ctx.flags.push({ flag: Flag.StringToBool });
      return success(false, ctx);
    }
    return failure(`Cannot coerce number ${value} to boolean`, ctx, "boolean", "number");
  }

  if (value === null || value === undefined) {
    return failure("Expected boolean, got null/undefined", ctx, "boolean", describeType(value));
  }

  return failure(
    `Cannot coerce ${describeType(value)} to boolean`,
    ctx,
    "boolean",
    describeType(value)
  );
}

/**
 * JSON has null but TypeScript often uses undefined.
 * We treat them as interchangeable for flexibility.
 */
export function coerceNull(value: unknown, ctx: CoerceContext): CoerceResult<null> {
  if (value === null) {
    return success(null, ctx);
  }

  if (value === undefined) {
    ctx.flags.push({ flag: Flag.NullToUndefined });
    return success(null, ctx);
  }

  return failure(
    `Expected null, got ${describeType(value)}`,
    ctx,
    "null",
    describeType(value)
  );
}

export function coerceUndefined(value: unknown, ctx: CoerceContext): CoerceResult<undefined> {
  if (value === undefined) {
    return success(undefined, ctx);
  }

  if (value === null) {
    ctx.flags.push({ flag: Flag.NullToUndefined });
    return success(undefined, ctx);
  }

  return failure(
    `Expected undefined, got ${describeType(value)}`,
    ctx,
    "undefined",
    describeType(value)
  );
}

/**
 * For z.literal(42), we first try exact match, then try coercing
 * to the literal's type. So z.literal(42) accepts both 42 and "42".
 */
export function coerceLiteral<T extends string | number | boolean>(
  value: unknown,
  literal: T,
  ctx: CoerceContext
): CoerceResult<T> {
  if (value === literal) {
    return success(literal, ctx);
  }

  // Try coercing to the literal's type, then check equality
  if (typeof literal === "string") {
    const result = coerceString(value, ctx);
    if (result.success && result.value === literal) {
      return success(literal, ctx);
    }
  } else if (typeof literal === "number") {
    const result = coerceNumber(value, ctx);
    if (result.success && result.value === literal) {
      return success(literal, ctx);
    }
  } else if (typeof literal === "boolean") {
    const result = coerceBoolean(value, ctx);
    if (result.success && result.value === literal) {
      return success(literal, ctx);
    }
  }

  return failure(
    `Expected literal ${JSON.stringify(literal)}, got ${JSON.stringify(value)}`,
    ctx,
    JSON.stringify(literal),
    describeType(value)
  );
}
