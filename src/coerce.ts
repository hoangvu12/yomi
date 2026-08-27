import * as z from "zod";
import {
  type CoerceContext,
  type CoerceResult,
  createContext,
  failure,
  describeType,
} from "./types.js";
import {
  coerceString,
  coerceNumber,
  coerceInt,
  coerceBoolean,
  coerceNull,
  coerceLiteral,
} from "./coercers/primitive.js";
import { coerceArray, coerceTuple } from "./coercers/array.js";
import { coerceObject, coerceRecord, type ObjectSchema } from "./coercers/object.js";
import { coerceUnion, coerceOptional, coerceNullable, coerceDefault } from "./coercers/union.js";
import { coerceEnum, coerceNativeEnum } from "./coercers/enum.js";
import { compileSchema } from "./schema.js";

/**
 * Coerce a value to match a Zod schema.
 * This is the main entry point for schema-aligned coercion.
 */
export function coerceToSchema<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
  ctx?: CoerceContext
): CoerceResult<z.infer<T>> {
  const context = ctx ?? createContext();
  const compileDiagnostic = compileSchema(schema).diagnostics.find((item) => item.severity === "error");
  if (compileDiagnostic) {
    const result = failure(`Unsupported Zod schema: ${compileDiagnostic.evidence ?? compileDiagnostic.code}`, context, "supported Zod schema", schema.constructor.name);
    result.diagnostics = [compileDiagnostic];
    return result;
  }
  return coerceZodType(schema, value, context) as CoerceResult<z.infer<T>>;
}

/** @internal Coerce a repairable streaming snapshot, tolerating missing fields. */
export function coercePartialToSchema<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
  ctx: CoerceContext
): CoerceResult<unknown> {
  ctx.partial = true;
  return coerceZodType(schema, value, ctx);
}

/**
 * Zod v4 removed ZodFirstPartyTypeKind enum, so we use instanceof checks instead.
 * Type assertions are needed because v4's internal $ZodType doesn't match public ZodType.
 */
function coerceZodType(
  schema: z.ZodTypeAny,
  value: unknown,
  ctx: CoerceContext
): CoerceResult<unknown> {
  if (schema instanceof z.ZodString) {
    return coerceString(value, ctx);
  }

  if (schema instanceof z.ZodNumber) {
    return coerceNumber(value, ctx);
  }

  if (schema instanceof z.ZodBigInt) {
    return coerceInt(value, ctx);
  }

  if (schema instanceof z.ZodBoolean) {
    return coerceBoolean(value, ctx);
  }

  if (schema instanceof z.ZodNull) {
    return coerceNull(value, ctx);
  }

  if (schema instanceof z.ZodUndefined) {
    if (value === undefined || value === null) {
      return { success: true, value: undefined, flags: ctx.flags };
    }
    return failure("Expected undefined", ctx, "undefined", describeType(value));
  }

  if (schema instanceof z.ZodVoid) {
    return { success: true, value: undefined, flags: ctx.flags };
  }

  if (schema instanceof z.ZodAny || schema instanceof z.ZodUnknown) {
    return { success: true, value, flags: ctx.flags };
  }

  if (schema instanceof z.ZodNever) {
    return failure("ZodNever cannot match any value", ctx, "never", describeType(value));
  }

  if (schema instanceof z.ZodLiteral) {
    // v4 changed from single value to Set to support z.literal("a", "b")
    const literalValue = schema.values.values().next().value as string | number | boolean;
    return coerceLiteral(value, literalValue, ctx);
  }

  if (schema instanceof z.ZodArray) {
    const elementSchema = schema.element as z.ZodTypeAny;
    return coerceArray(value, (v, c) => coerceZodType(elementSchema, v, c), ctx);
  }

  if (schema instanceof z.ZodTuple) {
    // v4 exposes items via def, not as a direct property
    const items = schema.def.items as z.ZodTypeAny[];
    const coercers = items.map(
      (item) => (v: unknown, c: CoerceContext) => coerceZodType(item, v, c)
    );
    return coerceTuple(value, coercers, ctx);
  }

  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const objectSchema: ObjectSchema = {};

    for (const [key, propSchema] of Object.entries(shape)) {
      const isOptional = propSchema.isOptional();
      const hasDefault = propSchema instanceof z.ZodDefault;

      objectSchema[key] = {
        coercer: (v, c) => coerceZodType(propSchema, v, c),
        optional: isOptional,
        // v4 changed defaultValue from function to direct value
        ...(hasDefault ? { default: (propSchema.def as { defaultValue: unknown }).defaultValue } : {}),
      };
    }

    return coerceObject(value, objectSchema, ctx);
  }

  if (schema instanceof z.ZodRecord) {
    const valueSchema = schema.valueType as z.ZodTypeAny;
    return coerceRecord(value, (v, c) => coerceZodType(valueSchema, v, c), ctx);
  }

  if (schema instanceof z.ZodMap) {
    // Treat Map as Record for JSON coercion since JSON has no Map type
    const valueSchema = schema.valueType as z.ZodTypeAny;
    return coerceRecord(value, (v, c) => coerceZodType(valueSchema, v, c), ctx);
  }

  if (schema instanceof z.ZodUnion) {
    const options = schema.options as z.ZodTypeAny[];
    const coercers = options.map(
      (opt) => (v: unknown, c: CoerceContext) => coerceZodType(opt, v, c)
    );
    return coerceUnion(value, coercers, ctx);
  }

  if (schema instanceof z.ZodDiscriminatedUnion) {
    const options = schema.options as z.ZodTypeAny[];
    const coercers = options.map(
      (opt) => (v: unknown, c: CoerceContext) => coerceZodType(opt, v, c)
    );
    return coerceUnion(value, coercers, ctx);
  }

  if (schema instanceof z.ZodOptional) {
    const innerSchema = schema.unwrap() as z.ZodTypeAny;
    return coerceOptional(value, (v, c) => coerceZodType(innerSchema, v, c), ctx);
  }

  if (schema instanceof z.ZodNullable) {
    const innerSchema = schema.unwrap() as z.ZodTypeAny;
    return coerceNullable(value, (v, c) => coerceZodType(innerSchema, v, c), ctx);
  }

  if (schema instanceof z.ZodDefault) {
    const innerSchema = schema.removeDefault() as z.ZodTypeAny;
    // v4 changed defaultValue from function to direct value
    const defaultValue = (schema.def as { defaultValue: unknown }).defaultValue;
    return coerceDefault(
      value,
      (v, c) => coerceZodType(innerSchema, v, c),
      defaultValue,
      ctx
    );
  }

  if (schema instanceof z.ZodCatch) {
    const innerSchema = schema.removeCatch() as z.ZodTypeAny;
    const result = coerceZodType(innerSchema, value, ctx);
    if (result.success) return result;
    // v4 catchValue requires error/value/input/issues context
    const catchDef = schema.def as unknown as { catchValue: (ctx: { error: z.ZodError; value: unknown; input: unknown; issues: z.ZodIssue[] }) => unknown };
    const catchValue = catchDef.catchValue({ error: new z.ZodError([]), value, input: value, issues: [] });
    return { success: true, value: catchValue, flags: ctx.flags };
  }

  if (schema instanceof z.ZodEnum) {
    // v4 uses ZodEnum for both z.enum() and z.nativeEnum() - differentiate by 'enum' property
    const schemaAny = schema as unknown as { enum?: Record<string, string | number>; options: string[] };
    if (schemaAny.enum && typeof schemaAny.enum === 'object' && !Array.isArray(schemaAny.enum)) {
      return coerceNativeEnum(value, schemaAny.enum, ctx);
    }
    return coerceEnum(value, schemaAny.options, ctx);
  }

  if (schema instanceof z.ZodLazy) {
    const lazyDef = schema.def as unknown as { getter: () => z.ZodTypeAny };
    const lazySchema = lazyDef.getter();
    return coerceZodType(lazySchema, value, ctx);
  }

  if (schema instanceof z.ZodPipe) {
    // Coerce only the input side. The public validation boundary executes the
    // complete pipe exactly once, including refinements and transforms.
    const inSchema = schema.in as z.ZodTypeAny;
    return coerceZodType(inSchema, value, ctx);
  }

  if (schema instanceof z.ZodReadonly) {
    const readonlyDef = schema.def as unknown as { innerType: z.ZodTypeAny };
    return coerceZodType(readonlyDef.innerType, value, ctx);
  }

  if (schema instanceof z.ZodDate) {
    if (value instanceof Date) {
      if (isNaN(value.getTime())) {
        return failure("Invalid Date", ctx, "Date", "Invalid Date");
      }
      return { success: true, value, flags: ctx.flags };
    }
    // LLMs often return dates as strings - attempt parsing
    if (typeof value === "string" || typeof value === "number") {
      const date = new Date(value);
      if (isNaN(date.getTime())) {
        return failure(`Cannot parse "${value}" as Date`, ctx, "Date", describeType(value));
      }
      return { success: true, value: date, flags: ctx.flags };
    }
    return failure("Expected Date", ctx, "Date", describeType(value));
  }

  if (schema instanceof z.ZodIntersection) {
    const intersectionDef = schema.def as unknown as { left: z.ZodTypeAny; right: z.ZodTypeAny };
    const leftResult = coerceZodType(intersectionDef.left, value, ctx);
    if (!leftResult.success) return leftResult;
    const rightResult = coerceZodType(intersectionDef.right, leftResult.value, ctx);
    if (!rightResult.success) return rightResult;
    // Merge object results since intersection typically combines object types
    if (typeof leftResult.value === "object" && typeof rightResult.value === "object") {
      return { success: true, value: { ...leftResult.value, ...rightResult.value }, flags: ctx.flags };
    }
    return rightResult;
  }

  if (schema instanceof z.ZodSet) {
    // Coerce as array first, then convert to Set (JSON has no Set type)
    const setDef = schema.def as unknown as { valueType: z.ZodTypeAny };
    const arrayResult = coerceArray(value, (v, c) => coerceZodType(setDef.valueType, v, c), ctx);
    if (!arrayResult.success) return arrayResult;
    return { success: true, value: new Set(arrayResult.value), flags: ctx.flags };
  }

  if (schema instanceof z.ZodPromise) {
    // Can't coerce promises - pass through
    return { success: true, value, flags: ctx.flags };
  }

  if (schema instanceof z.ZodFunction) {
    if (typeof value === "function") {
      return { success: true, value, flags: ctx.flags };
    }
    return failure("Expected function", ctx, "function", describeType(value));
  }

  if (schema instanceof z.ZodSymbol) {
    if (typeof value === "symbol") {
      return { success: true, value, flags: ctx.flags };
    }
    return failure("Expected symbol", ctx, "symbol", describeType(value));
  }

  const typeName = schema.constructor.name;
  return failure(`Unsupported Zod type: ${typeName}`, ctx, typeName, describeType(value));
}
