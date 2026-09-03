import type { z } from "zod";

const METADATA_KEY = "yomi";

export interface YomiMetadata {
  aliases?: readonly string[];
  /** Model-facing type name, used when an enum is hoisted into its own block. */
  name?: string;
  enumAliases?: Readonly<Record<string, readonly string[]>>;
  enumValueDescriptions?: Readonly<Record<string, string>>;
}

export type YomiSchema<T extends z.ZodTypeAny> = T & {
  alias(...names: string[]): YomiSchema<T>;
  named(name: string): YomiSchema<T>;
  valueAlias(value: string | number, ...names: string[]): YomiSchema<T>;
  valueDescription(value: string | number, description: string): YomiSchema<T>;
};

export function getYomiMetadata(schema: z.ZodTypeAny): YomiMetadata {
  const metadata = schema.meta() as Record<string, unknown> | undefined;
  const own = metadata?.[METADATA_KEY] as YomiMetadata | undefined;
  if (own) return own;
  // Zod wrappers do not copy registry metadata. Follow public unwrapping methods
  // so `yomi(z.string()).alias("name").optional()` remains model-facing.
  const wrapped = schema as z.ZodTypeAny & { unwrap?: () => z.ZodTypeAny; removeDefault?: () => z.ZodTypeAny; removeCatch?: () => z.ZodTypeAny; in?: z.ZodTypeAny };
  const inner = wrapped.unwrap?.() ?? wrapped.removeDefault?.() ?? wrapped.removeCatch?.() ?? wrapped.in;
  return inner && inner !== schema ? getYomiMetadata(inner) : {};
}

function decorate<T extends z.ZodTypeAny>(schema: T): YomiSchema<T> {
  const target = schema as unknown as YomiSchema<T>;
  Object.defineProperties(target, {
    alias: { configurable: true, value: (...names: string[]) => yomi(withMetadata(schema, { aliases: [...(getYomiMetadata(schema).aliases ?? []), ...names] })) },
    named: { configurable: true, value: (name: string) => yomi(withMetadata(schema, { name })) },
    valueAlias: { configurable: true, value: (value: string | number, ...names: string[]) => {
      const current = getYomiMetadata(schema); const key = String(value);
      return yomi(withMetadata(schema, { enumAliases: { ...current.enumAliases, [key]: [...(current.enumAliases?.[key] ?? []), ...names] } }));
    } },
    valueDescription: { configurable: true, value: (value: string | number, description: string) => {
      const current = getYomiMetadata(schema); return yomi(withMetadata(schema, { enumValueDescriptions: { ...current.enumValueDescriptions, [String(value)]: description } }));
    } },
  });
  return target;
}

function withMetadata<T extends z.ZodTypeAny>(schema: T, update: Partial<YomiMetadata>): T {
  const existing = getYomiMetadata(schema);
  return schema.meta({ [METADATA_KEY]: { ...existing, ...update } }) as T;
}

/** Attach model-facing names and enum guidance without changing the inferred output type. */
export function yomi<T extends z.ZodTypeAny>(schema: T): YomiSchema<T> { return decorate(schema); }
