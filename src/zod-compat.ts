import * as z from "zod";

export type InspectedZod =
  | { kind: "string" | "number" | "bigint" | "boolean" | "null" | "undefined" | "unknown" | "never" | "date" }
  | { kind: "literal"; values: unknown[] }
  | { kind: "enum"; values: (string | number)[] }
  | { kind: "array"; element: z.ZodTypeAny }
  | { kind: "tuple"; items: z.ZodTypeAny[]; rest?: z.ZodTypeAny }
  | { kind: "object"; shape: Record<string, z.ZodTypeAny> }
  | { kind: "record"; value: z.ZodTypeAny }
  | { kind: "intersection"; left: z.ZodTypeAny; right: z.ZodTypeAny }
  | { kind: "union"; options: z.ZodTypeAny[]; discriminator?: string }
  | { kind: "optional" | "nullable" | "readonly" | "default" | "catch"; inner: z.ZodTypeAny }
  | { kind: "lazy"; get: () => z.ZodTypeAny }
  | { kind: "pipe"; input: z.ZodTypeAny; output: z.ZodTypeAny }
  | { kind: "unsupported"; typeName: string };

/** The only module allowed to translate version-sensitive Zod runtime details. */
export function inspectZod(schema: z.ZodTypeAny): InspectedZod {
  if (schema instanceof z.ZodString) return { kind: "string" };
  if (schema instanceof z.ZodNumber) return { kind: "number" };
  if (schema instanceof z.ZodBigInt) return { kind: "bigint" };
  if (schema instanceof z.ZodBoolean) return { kind: "boolean" };
  if (schema instanceof z.ZodNull) return { kind: "null" };
  if (schema instanceof z.ZodUndefined || schema instanceof z.ZodVoid) return { kind: "undefined" };
  if (schema instanceof z.ZodAny || schema instanceof z.ZodUnknown) return { kind: "unknown" };
  if (schema instanceof z.ZodNever) return { kind: "never" };
  if (schema instanceof z.ZodDate) return { kind: "date" };
  if (schema instanceof z.ZodLiteral) return { kind: "literal", values: [...schema.values] };
  if (schema instanceof z.ZodEnum) {
    const values = [...new Set(Object.values(schema.enum).filter((v): v is string | number => typeof v === "string" || typeof v === "number"))];
    return { kind: "enum", values };
  }
  if (schema instanceof z.ZodArray) return { kind: "array", element: schema.element as z.ZodTypeAny };
  if (schema instanceof z.ZodTuple) {
    const def = schema.def as unknown as { items: readonly z.ZodTypeAny[]; rest?: z.ZodTypeAny };
    return { kind: "tuple", items: [...def.items], ...(def.rest ? { rest: def.rest } : {}) };
  }
  if (schema instanceof z.ZodObject) return { kind: "object", shape: schema.shape };
  if (schema instanceof z.ZodRecord) return { kind: "record", value: schema.valueType as z.ZodTypeAny };
  if (schema instanceof z.ZodMap) return { kind: "record", value: schema.valueType as z.ZodTypeAny };
  if (schema instanceof z.ZodSet) return { kind: "array", element: (schema.def as unknown as { valueType: z.ZodTypeAny }).valueType };
  if (schema instanceof z.ZodIntersection) {
    const def = schema.def as unknown as { left: z.ZodTypeAny; right: z.ZodTypeAny };
    return { kind: "intersection", left: def.left, right: def.right };
  }
  if (schema instanceof z.ZodDiscriminatedUnion) return { kind: "union", options: [...schema.options] as z.ZodTypeAny[], discriminator: schema.def.discriminator };
  if (schema instanceof z.ZodUnion) return { kind: "union", options: [...schema.options] as z.ZodTypeAny[] };
  if (schema instanceof z.ZodOptional) return { kind: "optional", inner: schema.unwrap() as z.ZodTypeAny };
  if (schema instanceof z.ZodNullable) return { kind: "nullable", inner: schema.unwrap() as z.ZodTypeAny };
  if (schema instanceof z.ZodDefault) return { kind: "default", inner: schema.removeDefault() as z.ZodTypeAny };
  if (schema instanceof z.ZodCatch) return { kind: "catch", inner: schema.removeCatch() as z.ZodTypeAny };
  if (schema instanceof z.ZodReadonly) return { kind: "readonly", inner: (schema.def as unknown as { innerType: z.ZodTypeAny }).innerType };
  if (schema instanceof z.ZodLazy) return { kind: "lazy", get: (schema.def as unknown as { getter: () => z.ZodTypeAny }).getter };
  if (schema instanceof z.ZodPipe) return { kind: "pipe", input: schema.in as z.ZodTypeAny, output: schema.out as z.ZodTypeAny };
  return { kind: "unsupported", typeName: schema.constructor.name };
}

export function zodDescription(schema: z.ZodTypeAny): string | undefined {
  return schema.description;
}
