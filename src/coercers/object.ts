import { Flag } from "../flags.js";
import {
  type CoerceContext,
  type CoerceResult,
  childContext,
  success,
  failure,
  describeType,
} from "../types.js";

export type PropertyCoercer<T> = (value: unknown, ctx: CoerceContext) => CoerceResult<T>;

export interface ObjectSchema {
  [key: string]: {
    coercer: PropertyCoercer<unknown>;
    optional: boolean;
    default?: unknown;
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * LLMs often add extra fields we didn't ask for (explanations, confidence scores,
 * reasoning). We ignore these rather than failing, but track them in flags.
 *
 * Missing optional fields are also tracked - callers can detect when defaults
 * were used vs when the LLM explicitly provided values.
 */
export function coerceObject<T extends Record<string, unknown>>(
  value: unknown,
  schema: ObjectSchema,
  ctx: CoerceContext
): CoerceResult<T> {
  if (!isPlainObject(value)) {
    return failure(
      `Expected object, got ${describeType(value)}`,
      ctx,
      "object",
      describeType(value)
    );
  }

  const result: Record<string, unknown> = {};
  const inputKeys = new Set(Object.keys(value));
  const schemaKeys = new Set(Object.keys(schema));

  for (const key of schemaKeys) {
    const propSchema = schema[key];
    if (!propSchema) continue;

    const propCtx = childContext(ctx, key);
    const inputValue = value[key];

    if (!(key in value) || inputValue === undefined) {
      if (propSchema.optional) {
        if ("default" in propSchema) {
          ctx.flags.push({ flag: Flag.DefaultUsed });
          result[key] = propSchema.default;
        } else {
          ctx.flags.push({ flag: Flag.MissingOptionalKey });
          // Leave undefined - don't add to result
        }
        continue;
      } else {
        return failure(`Missing required property "${key}"`, propCtx, "value", "undefined");
      }
    }

    const propResult = propSchema.coercer(inputValue, propCtx);
    if (!propResult.success) {
      return propResult;
    }

    result[key] = propResult.value;
    inputKeys.delete(key);
  }

  // Track extra keys so callers know the LLM added unrequested fields
  if (inputKeys.size > 0) {
    const extraKeys = Array.from(inputKeys);
    ctx.flags.push({ flag: Flag.ExtraKeysIgnored, keys: extraKeys });
  }

  return success(result as T, ctx);
}

/**
 * For z.record() - a map with string keys and uniform value types.
 * Unlike objects, we don't have a fixed schema - just coerce each value.
 */
export function coerceRecord<T>(
  value: unknown,
  valueCoercer: PropertyCoercer<T>,
  ctx: CoerceContext
): CoerceResult<Record<string, T>> {
  if (!isPlainObject(value)) {
    return failure(
      `Expected object, got ${describeType(value)}`,
      ctx,
      "object",
      describeType(value)
    );
  }

  const result: Record<string, T> = {};

  for (const [key, val] of Object.entries(value)) {
    const propCtx = childContext(ctx, key);
    const propResult = valueCoercer(val, propCtx);

    if (!propResult.success) {
      return propResult;
    }

    result[key] = propResult.value;
  }

  return success(result, ctx);
}
