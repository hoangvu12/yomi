import { z } from "zod";
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
  return coerceZodType(schema, value, context);
}

/**
 * Internal dispatcher for Zod types.
 */
function coerceZodType(
  schema: z.ZodTypeAny,
  value: unknown,
  ctx: CoerceContext
): CoerceResult<unknown> {
  const def = schema._def;
  const typeName = def.typeName as z.ZodFirstPartyTypeKind;

  switch (typeName) {
    // Primitives
    case z.ZodFirstPartyTypeKind.ZodString:
      return coerceString(value, ctx);

    case z.ZodFirstPartyTypeKind.ZodNumber:
      return coerceNumber(value, ctx);

    case z.ZodFirstPartyTypeKind.ZodBigInt:
      return coerceInt(value, ctx); // Use int coercion for bigint

    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return coerceBoolean(value, ctx);

    case z.ZodFirstPartyTypeKind.ZodNull:
      return coerceNull(value, ctx);

    case z.ZodFirstPartyTypeKind.ZodUndefined:
      if (value === undefined || value === null) {
        return { success: true, value: undefined, flags: ctx.flags };
      }
      return failure("Expected undefined", ctx, "undefined", describeType(value));

    case z.ZodFirstPartyTypeKind.ZodVoid:
      return { success: true, value: undefined, flags: ctx.flags };

    case z.ZodFirstPartyTypeKind.ZodAny:
    case z.ZodFirstPartyTypeKind.ZodUnknown:
      return { success: true, value, flags: ctx.flags };

    case z.ZodFirstPartyTypeKind.ZodNever:
      return failure("ZodNever cannot match any value", ctx, "never", describeType(value));

    // Literals
    case z.ZodFirstPartyTypeKind.ZodLiteral:
      return coerceLiteral(value, def.value, ctx);

    // Arrays
    case z.ZodFirstPartyTypeKind.ZodArray:
      return coerceArray(value, (v, c) => coerceZodType(def.type, v, c), ctx);

    // Tuples
    case z.ZodFirstPartyTypeKind.ZodTuple: {
      const items = def.items as z.ZodTypeAny[];
      const coercers = items.map(
        (item) => (v: unknown, c: CoerceContext) => coerceZodType(item, v, c)
      );
      return coerceTuple(value, coercers, ctx);
    }

    // Objects
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const shape = def.shape() as Record<string, z.ZodTypeAny>;
      const objectSchema: ObjectSchema = {};

      for (const [key, propSchema] of Object.entries(shape)) {
        const isOptional = propSchema.isOptional();
        const hasDefault = propSchema._def.typeName === z.ZodFirstPartyTypeKind.ZodDefault;

        objectSchema[key] = {
          coercer: (v, c) => coerceZodType(propSchema, v, c),
          optional: isOptional,
          ...(hasDefault ? { default: propSchema._def.defaultValue() } : {}),
        };
      }

      return coerceObject(value, objectSchema, ctx);
    }

    // Records
    case z.ZodFirstPartyTypeKind.ZodRecord:
      return coerceRecord(value, (v, c) => coerceZodType(def.valueType, v, c), ctx);

    // Maps
    case z.ZodFirstPartyTypeKind.ZodMap:
      // Treat as record for now
      return coerceRecord(value, (v, c) => coerceZodType(def.valueType, v, c), ctx);

    // Unions
    case z.ZodFirstPartyTypeKind.ZodUnion: {
      const options = def.options as z.ZodTypeAny[];
      const coercers = options.map(
        (opt) => (v: unknown, c: CoerceContext) => coerceZodType(opt, v, c)
      );
      return coerceUnion(value, coercers, ctx);
    }

    case z.ZodFirstPartyTypeKind.ZodDiscriminatedUnion: {
      const options = def.options as z.ZodTypeAny[];
      const coercers = options.map(
        (opt) => (v: unknown, c: CoerceContext) => coerceZodType(opt, v, c)
      );
      return coerceUnion(value, coercers, ctx);
    }

    // Optionals and Nullables
    case z.ZodFirstPartyTypeKind.ZodOptional:
      return coerceOptional(value, (v, c) => coerceZodType(def.innerType, v, c), ctx);

    case z.ZodFirstPartyTypeKind.ZodNullable:
      return coerceNullable(value, (v, c) => coerceZodType(def.innerType, v, c), ctx);

    // Defaults
    case z.ZodFirstPartyTypeKind.ZodDefault:
      return coerceDefault(
        value,
        (v, c) => coerceZodType(def.innerType, v, c),
        def.defaultValue(),
        ctx
      );

    // Catch
    case z.ZodFirstPartyTypeKind.ZodCatch: {
      const result = coerceZodType(def.innerType, value, ctx);
      if (result.success) return result;
      return { success: true, value: def.catchValue({ error: result.error, input: value }), flags: ctx.flags };
    }

    // Enums
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return coerceEnum(value, def.values, ctx);

    case z.ZodFirstPartyTypeKind.ZodNativeEnum:
      return coerceNativeEnum(value, def.values, ctx);

    // Effects/Transforms
    case z.ZodFirstPartyTypeKind.ZodEffects: {
      // First coerce the inner type
      const innerResult = coerceZodType(def.schema, value, ctx);
      if (!innerResult.success) return innerResult;

      // Then apply the effect
      // Note: We only handle refinements here, not transforms
      // Transforms would need async support
      if (def.effect.type === "refinement") {
        const refinement = def.effect.refinement;
        try {
          const isValid = refinement(innerResult.value);
          if (!isValid) {
            return failure("Refinement failed", ctx, "refined value", describeType(innerResult.value));
          }
        } catch (e) {
          return failure(
            `Refinement error: ${e instanceof Error ? e.message : String(e)}`,
            ctx,
            "refined value",
            describeType(innerResult.value)
          );
        }
      }
      return innerResult;
    }

    // Lazy
    case z.ZodFirstPartyTypeKind.ZodLazy:
      return coerceZodType(def.getter(), value, ctx);

    // Branded
    case z.ZodFirstPartyTypeKind.ZodBranded:
      return coerceZodType(def.type, value, ctx);

    // Pipeline
    case z.ZodFirstPartyTypeKind.ZodPipeline: {
      const inResult = coerceZodType(def.in, value, ctx);
      if (!inResult.success) return inResult;
      return coerceZodType(def.out, inResult.value, ctx);
    }

    // Readonly
    case z.ZodFirstPartyTypeKind.ZodReadonly:
      return coerceZodType(def.innerType, value, ctx);

    // Date - special handling
    case z.ZodFirstPartyTypeKind.ZodDate: {
      if (value instanceof Date) {
        if (isNaN(value.getTime())) {
          return failure("Invalid Date", ctx, "Date", "Invalid Date");
        }
        return { success: true, value, flags: ctx.flags };
      }
      if (typeof value === "string" || typeof value === "number") {
        const date = new Date(value);
        if (isNaN(date.getTime())) {
          return failure(`Cannot parse "${value}" as Date`, ctx, "Date", describeType(value));
        }
        return { success: true, value: date, flags: ctx.flags };
      }
      return failure("Expected Date", ctx, "Date", describeType(value));
    }

    // Intersection - coerce to both types
    case z.ZodFirstPartyTypeKind.ZodIntersection: {
      const leftResult = coerceZodType(def.left, value, ctx);
      if (!leftResult.success) return leftResult;
      const rightResult = coerceZodType(def.right, leftResult.value, ctx);
      if (!rightResult.success) return rightResult;
      // Merge results for objects
      if (typeof leftResult.value === "object" && typeof rightResult.value === "object") {
        return { success: true, value: { ...leftResult.value, ...rightResult.value }, flags: ctx.flags };
      }
      return rightResult;
    }

    // Set
    case z.ZodFirstPartyTypeKind.ZodSet: {
      const arrayResult = coerceArray(value, (v, c) => coerceZodType(def.valueType, v, c), ctx);
      if (!arrayResult.success) return arrayResult;
      return { success: true, value: new Set(arrayResult.value), flags: ctx.flags };
    }

    // Promise - just pass through
    case z.ZodFirstPartyTypeKind.ZodPromise:
      return { success: true, value, flags: ctx.flags };

    // Function - just pass through
    case z.ZodFirstPartyTypeKind.ZodFunction:
      if (typeof value === "function") {
        return { success: true, value, flags: ctx.flags };
      }
      return failure("Expected function", ctx, "function", describeType(value));

    // Symbol
    case z.ZodFirstPartyTypeKind.ZodSymbol:
      if (typeof value === "symbol") {
        return { success: true, value, flags: ctx.flags };
      }
      return failure("Expected symbol", ctx, "symbol", describeType(value));

    default:
      return failure(`Unsupported Zod type: ${typeName}`, ctx, typeName, describeType(value));
  }
}
