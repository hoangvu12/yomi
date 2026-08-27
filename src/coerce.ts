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
import { getYomiMetadata } from "./metadata.js";
import { inspectZod, structurallyAccepts, zodCatchValue, zodDefaultValue } from "./zod-compat.js";

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
  const inspected = inspectZod(schema);
  if (inspected.kind === "string") {
    return coerceString(value, ctx);
  }

  if (inspected.kind === "number") {
    return coerceNumber(value, ctx);
  }

  if (inspected.kind === "bigint") {
    return coerceInt(value, ctx);
  }

  if (inspected.kind === "boolean") {
    return coerceBoolean(value, ctx);
  }

  if (inspected.kind === "null") {
    return coerceNull(value, ctx);
  }

  if (inspected.kind === "undefined") {
    if (value === undefined || value === null) {
      return { success: true, value: undefined, flags: ctx.flags };
    }
    return failure("Expected undefined", ctx, "undefined", describeType(value));
  }

  if (inspected.kind === "unknown") {
    return { success: true, value, flags: ctx.flags };
  }

  if (inspected.kind === "never") {
    return failure("ZodNever cannot match any value", ctx, "never", describeType(value));
  }

  if (inspected.kind === "literal") {
    const literalValue = inspected.values[0] as string | number | boolean;
    return coerceLiteral(value, literalValue, ctx);
  }

  if (inspected.kind === "array" && schema instanceof z.ZodArray) {
    const elementSchema = inspected.element;
    return coerceArray(value, (v, c) => coerceZodType(elementSchema, v, c), ctx);
  }

  if (inspected.kind === "tuple") {
    const items = inspected.items;
    const coercers = items.map(
      (item) => (v: unknown, c: CoerceContext) => coerceZodType(item, v, c)
    );
    return coerceTuple(value, coercers, ctx);
  }

  if (inspected.kind === "object") {
    const shape = inspected.shape;
    const objectSchema: ObjectSchema = {};

    for (const [key, propSchema] of Object.entries(shape)) {
      const isOptional = propSchema.isOptional();
      const propInspection = inspectZod(propSchema);
      const hasDefault = propInspection.kind === "default";

      objectSchema[key] = {
        coercer: (v, c) => coerceZodType(propSchema, v, c),
        optional: isOptional,
        aliases: getYomiMetadata(propSchema).aliases,
        // v4 changed defaultValue from function to direct value
        ...(hasDefault ? { default: zodDefaultValue(propSchema) } : {}),
      };
    }

    return coerceObject(value, objectSchema, ctx);
  }

  if (inspected.kind === "record" && schema instanceof z.ZodRecord) {
    const valueSchema = inspected.value;
    return coerceRecord(value, (v, c) => coerceZodType(valueSchema, v, c), ctx);
  }

  if (schema instanceof z.ZodMap) {
    // Treat Map as Record for JSON coercion since JSON has no Map type
    const valueSchema = schema.valueType as z.ZodTypeAny;
    return coerceRecord(value, (v, c) => coerceZodType(valueSchema, v, c), ctx);
  }

  if (inspected.kind === "union" && inspected.discriminator) {
    const options = inspected.options;
    const discriminator = inspected.discriminator;
    let eligible = options.map((option, index) => ({ option, index }));
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const discriminatorValue = (value as Record<string, unknown>)[discriminator];
      const exact = eligible.filter(({ option }) => {
        const optionInspection = inspectZod(option);
        if (optionInspection.kind !== "object") return false;
        const discriminatorSchema = optionInspection.shape[discriminator];
        return discriminatorSchema ? structurallyAccepts(discriminatorSchema, discriminatorValue) : false;
      });
      if (exact.length > 0) eligible = exact;
    }
    const candidates = eligible.map(({ option, index }) => ({
      index,
      coercer: (v: unknown, c: CoerceContext) => coerceZodType(option, v, c),
      validate: (v: unknown) => ({ success: structurallyAccepts(option, v) }),
    }));
    return coerceUnion(value, candidates, ctx);
  }

  if (inspected.kind === "union") {
    const options = inspected.options;
    const candidates = options.map((option) => ({
      coercer: (v: unknown, c: CoerceContext) => coerceZodType(option, v, c),
      validate: (v: unknown) => ({ success: structurallyAccepts(option, v) }),
    }));
    return coerceUnion(value, candidates, ctx);
  }

  if (inspected.kind === "optional") {
    const innerSchema = inspected.inner;
    return coerceOptional(value, (v, c) => coerceZodType(innerSchema, v, c), ctx);
  }

  if (inspected.kind === "nullable") {
    const innerSchema = inspected.inner;
    return coerceNullable(value, (v, c) => coerceZodType(innerSchema, v, c), ctx);
  }

  if (inspected.kind === "default") {
    const innerSchema = inspected.inner;
    const defaultValue = zodDefaultValue(schema);
    return coerceDefault(
      value,
      (v, c) => coerceZodType(innerSchema, v, c),
      defaultValue,
      ctx
    );
  }

  if (inspected.kind === "catch") {
    const innerSchema = inspected.inner;
    const result = coerceZodType(innerSchema, value, ctx);
    if (result.success) return result;
    // v4 catchValue requires error/value/input/issues context
    const catchValue = zodCatchValue(schema, value);
    return { success: true, value: catchValue, flags: ctx.flags };
  }

  if (schema instanceof z.ZodEnum) {
    // v4 uses ZodEnum for both z.enum() and z.nativeEnum() - differentiate by 'enum' property
    const schemaAny = schema as unknown as { enum?: Record<string, string | number>; options: string[] };
    const enumAliases = getYomiMetadata(schema).enumAliases;
    if (enumAliases && schemaAny.options.every((item) => typeof item === "string")) {
      const aliased = coerceEnum(value, schemaAny.options, ctx, enumAliases);
      if (aliased.success || typeof value === "string") return aliased;
    }
    if (schemaAny.enum && typeof schemaAny.enum === 'object' && !Array.isArray(schemaAny.enum)) {
      return coerceNativeEnum(value, schemaAny.enum, ctx);
    }
    return coerceEnum(value, schemaAny.options, ctx, enumAliases);
  }

  if (inspected.kind === "lazy") {
    const lazySchema = inspected.get();
    return coerceZodType(lazySchema, value, ctx);
  }

  if (inspected.kind === "pipe") {
    // Coerce only the input side. The public validation boundary executes the
    // complete pipe exactly once, including refinements and transforms.
    const inSchema = inspected.input;
    return coerceZodType(inSchema, value, ctx);
  }

  if (inspected.kind === "readonly") {
    return coerceZodType(inspected.inner, value, ctx);
  }

  if (inspected.kind === "date") {
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

  if (inspected.kind === "intersection") {
    const leftResult = coerceZodType(inspected.left, value, ctx);
    if (!leftResult.success) return leftResult;
    const rightResult = coerceZodType(inspected.right, leftResult.value, ctx);
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
