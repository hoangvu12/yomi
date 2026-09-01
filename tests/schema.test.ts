import { describe, expect, it } from "vitest";
import { z } from "zod";
import { compileSchema, parse, parserContractFingerprint, renderFormat, schemaFingerprint } from "../src/index.js";

describe("compiled schema graph and compact rendering", () => {
  it("compiles and caches by schema identity and metadata revision", () => {
    const schema = z.object({ name: z.string(), age: z.number().optional() });
    expect(compileSchema(schema)).toBe(compileSchema(schema));
    expect(compileSchema(schema, { metadataRevision: 2 })).not.toBe(compileSchema(schema));
    expect(compileSchema(schema, { metadataRevision: 2 })).toBe(compileSchema(schema, { metadataRevision: 2 }));
  });

  it("renders deterministic compact instructions for supported constructs", () => {
    const schema = z.object({
      status: z.enum(["new", "done"]).describe("workflow state"),
      values: z.array(z.union([z.number(), z.literal(null)])),
      note: z.string().nullable().optional(),
    });
    const first = renderFormat(schema);
    const second = renderFormat(schema);
    expect(first).toEqual(second);
    expect(first.format).toContain('"note"?: string | null');
    expect(first.format).toContain('"new" | "done"');
    expect(first.format).toContain("workflow state");
    expect(first.fingerprint).toBe(schemaFingerprint(schema));
  });

  it("uses stable references for recursive schemas", () => {
    type Category = { name: string; children?: Category[] };
    const category: z.ZodType<Category> = z.lazy(() => z.object({
      name: z.string(), children: z.array(category).optional(),
    }));
    const rendered = renderFormat(category);
    expect(rendered.format).toMatch(/@T\d+/);
    expect(rendered.format.length).toBeLessThan(500);
    expect(rendered.diagnostics).toEqual([]);
  });

  it("fingerprints relevant policies and diagnoses unsupported schemas", () => {
    const schema = z.string();
    expect(schemaFingerprint(schema, { policies: { reveal: "complete" } }))
      .not.toBe(schemaFingerprint(schema, { policies: { reveal: "incremental" } }));
    expect(compileSchema(z.function()).diagnostics).toMatchObject([
      { code: "unsupported_schema", severity: "error", path: [] },
    ]);
  });

  it("remains compatible with parsing from the same schema", () => {
    const schema = z.object({ value: z.number() });
    const compiled = compileSchema(schema);
    const result = parse(schema, '{"value":"42"}');
    expect(compiled.diagnostics).toEqual([]);
    expect(result.success && result.data).toEqual({ value: 42 });
  });
});

describe("field order", () => {
  const pinned = z.object({
    zebra: z.string(),
    alpha: z.number().optional(),
    nested: z.object({ delta: z.boolean(), beta: z.string().nullable() }),
  });

  it("sorts object fields alphabetically by default", () => {
    const expected = 'Return only JSON matching { "alpha"?: number, "nested": { "beta": string | null, "delta": boolean }, "zebra": string }.';
    expect(renderFormat(pinned).format).toBe(expected);
    expect(renderFormat(pinned, { fieldOrder: "sorted" }).format).toBe(expected);
  });

  it("renders declaration order when asked, nested objects included", () => {
    expect(renderFormat(pinned, { fieldOrder: "declared" }).format).toBe(
      'Return only JSON matching { "zebra": string, "alpha"?: number, "nested": { "delta": boolean, "beta": string | null } }.',
    );
  });

  it("caches compiled schemas separately per field order", () => {
    expect(compileSchema(pinned, { fieldOrder: "declared" })).not.toBe(compileSchema(pinned));
    expect(compileSchema(pinned, { fieldOrder: "declared" })).toBe(compileSchema(pinned, { fieldOrder: "declared" }));
    expect(compileSchema(pinned, { fieldOrder: "sorted" })).toBe(compileSchema(pinned));
  });

  it("fingerprints field order, even when the fields are the same schema instances", () => {
    const shared = z.string();
    const a = z.object({ portion: shared, basis: shared, sourceId: shared });
    const b = z.object({ basis: shared, sourceId: shared, portion: shared });

    expect(renderFormat(a, { fieldOrder: "declared" }).format)
      .not.toBe(renderFormat(b, { fieldOrder: "declared" }).format);
    expect(schemaFingerprint(a, { fieldOrder: "declared" }))
      .not.toBe(schemaFingerprint(b, { fieldOrder: "declared" }));

    expect(renderFormat(a).format).toBe(renderFormat(b).format);
    expect(schemaFingerprint(a)).toBe(schemaFingerprint(b));
  });

  it("separates the two orders in schema and parser contract fingerprints", () => {
    expect(schemaFingerprint(pinned, { fieldOrder: "declared" })).not.toBe(schemaFingerprint(pinned));
    expect(parserContractFingerprint(pinned, undefined, { fieldOrder: "declared" }))
      .not.toBe(parserContractFingerprint(pinned));
    expect(parserContractFingerprint(pinned, undefined, { fieldOrder: "sorted" }))
      .toBe(parserContractFingerprint(pinned));
  });
});
