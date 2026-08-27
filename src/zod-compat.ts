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

export function zodDefaultValue(schema: z.ZodTypeAny): unknown {
  return (schema.def as unknown as { defaultValue: unknown }).defaultValue;
}

export function zodCatchValue(schema: z.ZodTypeAny, value: unknown): unknown {
  const fn = (schema.def as unknown as { catchValue: (ctx: { error: z.ZodError; value: unknown; input: unknown; issues: z.ZodIssue[] }) => unknown }).catchValue;
  return fn({ error: new z.ZodError([]), value, input: value, issues: [] });
}

/** Remove input-transparent wrappers without exposing Zod internals to consumers. */
export function unwrapZod(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  for (;;) {
    const inspected = inspectZod(current);
    if (inspected.kind === "optional" || inspected.kind === "nullable" || inspected.kind === "readonly" || inspected.kind === "default" || inspected.kind === "catch") {
      current = inspected.inner;
      continue;
    }
    return inspected.kind === "pipe" ? inspected.input : current;
  }
}

/**
 * Side-effect-free compatibility check used while ranking union candidates.
 * It deliberately checks only JSON-visible structure: refinements and transforms
 * belong to the single, final public safeParse boundary.
 */
export function structurallyAccepts(schema: z.ZodTypeAny, value: unknown, seen = new WeakSet<object>()): boolean {
  const inspected = inspectZod(schema);
  switch (inspected.kind) {
    case "optional": return value === undefined || structurallyAccepts(inspected.inner, value, seen);
    case "nullable": return value === null || structurallyAccepts(inspected.inner, value, seen);
    case "default": case "catch": case "readonly": return structurallyAccepts(inspected.inner, value, seen);
    case "pipe": return structurallyAccepts(inspected.input, value, seen);
    case "lazy": return structurallyAccepts(inspected.get(), value, seen);
    case "string": return typeof value === "string" && builtInChecksAccept(schema, value);
    case "number": return typeof value === "number" && Number.isFinite(value) && builtInChecksAccept(schema, value);
    case "bigint": return typeof value === "bigint";
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    case "undefined": return value === undefined;
    case "never": return false;
    case "date": return value instanceof Date && !Number.isNaN(value.getTime());
    case "literal": return inspected.values.some((item) => Object.is(item, value));
    case "enum": return inspected.values.some((item) => Object.is(item, value));
    case "unknown": return true;
    case "array": return Array.isArray(value) && value.every((item) => structurallyAccepts(inspected.element, item, seen));
    case "tuple": return Array.isArray(value) && value.length >= inspected.items.length && value.every((item, index) => structurallyAccepts(inspected.items[index] ?? inspected.rest ?? z.never(), item, seen));
    case "record": return isObject(value) && Object.values(value).every((item) => structurallyAccepts(inspected.value, item, seen));
    case "object": {
      if (!isObject(value)) return false;
      if (seen.has(value)) return true;
      seen.add(value);
      return Object.entries(inspected.shape).every(([key, child]) => key in value ? structurallyAccepts(child, value[key], seen) : child.isOptional());
    }
    case "union": return inspected.options.some((option) => structurallyAccepts(option, value, seen));
    case "intersection": return structurallyAccepts(inspected.left, value, seen) && structurallyAccepts(inspected.right, value, seen);
    case "unsupported": return true;
  }
}

/** Evaluate declarative built-in checks only; custom checks are intentionally deferred. */
function builtInChecksAccept(schema: z.ZodTypeAny, value: string | number): boolean {
  const checks = (schema.def as unknown as { checks?: unknown[] }).checks ?? [];
  return checks.every((check) => {
    const def = (check as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
    if (!def || def.check === "custom") return true;
    switch (def.check) {
      case "greater_than": return typeof value === "number" && (def.inclusive ? value >= (def.value as number) : value > (def.value as number));
      case "less_than": return typeof value === "number" && (def.inclusive ? value <= (def.value as number) : value < (def.value as number));
      case "multiple_of": return typeof value === "number" && value % (def.value as number) === 0;
      case "min_length": return typeof value === "string" && value.length >= (def.minimum as number);
      case "max_length": return typeof value === "string" && value.length <= (def.maximum as number);
      case "length_equals": return typeof value === "string" && value.length === (def.length as number);
      case "string_format": return typeof value === "string" && (!(def.pattern instanceof RegExp) || new RegExp(def.pattern.source, def.pattern.flags).test(value));
      default: return true;
    }
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
