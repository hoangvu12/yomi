import { describe, expect, it } from "vitest";
import { z } from "zod";
import { compileSchema, parse, parserContractFingerprint, renderFormat, schemaFingerprint, yomi } from "../src/index.js";

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
    const expected = '{ "alpha"?: number, "nested": { "beta": string | null, "delta": boolean }, "zebra": string }';
    expect(renderFormat(pinned).format).toBe(expected);
    expect(renderFormat(pinned, { fieldOrder: "sorted" }).format).toBe(expected);
  });

  it("renders declaration order when asked, nested objects included", () => {
    expect(renderFormat(pinned, { fieldOrder: "declared" }).format).toBe(
      '{ "zebra": string, "alpha"?: number, "nested": { "delta": boolean, "beta": string | null } }',
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

describe("render layout", () => {
  const nested = z.object({
    zebra: z.string(),
    alpha: z.number().optional(),
    nested: z.object({ delta: z.boolean(), beta: z.string().nullable() }),
  });
  const declared = { fieldOrder: "declared" } as const;

  it("defaults to the single-line layout, fingerprint included", () => {
    const explicit = renderFormat(nested, { multiline: false, hoistEnums: "never", orSplitter: "|" });
    expect(explicit).toEqual(renderFormat(nested));
    expect(explicit.fingerprint).toBe(schemaFingerprint(nested));
  });

  it("breaks objects one field per line when asked", () => {
    expect(renderFormat(nested, { ...declared, multiline: true }).format).toBe(
      [
        "{",
        '  "zebra": string,',
        '  "alpha"?: number,',
        '  "nested": {',
        '    "delta": boolean,',
        '    "beta": string | null',
        "  }",
        "}",
      ].join("\n"),
    );
  });

  it("indents objects nested inside arrays and keeps empty objects compact", () => {
    const schema = z.object({ rows: z.array(z.object({ id: z.string() })), blank: z.object({}) });
    expect(renderFormat(schema, { ...declared, multiline: true }).format).toBe(
      [
        "{",
        '  "rows": {',
        '    "id": string',
        "  }[],",
        '  "blank": {}',
        "}",
      ].join("\n"),
    );
  });

  it("keeps recursive schemas finite and short when broken across lines", () => {
    type Category = { name: string; children?: Category[] };
    const category: z.ZodType<Category> = z.lazy(() => z.object({
      name: z.string(), children: z.array(category).optional(),
    }));
    const rendered = renderFormat(category, { multiline: true });
    expect(rendered.format).toMatch(/@T\d+/);
    expect(rendered.format.length).toBeLessThan(500);
    expect(rendered.diagnostics).toEqual([]);
  });

  it("splits unions, nullables, and inline enums with plain English on request", () => {
    const schema = z.object({
      status: z.enum(["new", "done"]),
      value: z.union([z.string(), z.number()]).nullable(),
    });
    expect(renderFormat(schema, { ...declared, orSplitter: "or" }).format).toBe(
      '{ "status": "new" or "done", "value": string or number or null }',
    );
    expect(renderFormat(schema, declared).format).toContain('"new" | "done"');
  });

  it("distinguishes every layout in the fingerprint and reuses it for the same layout", () => {
    const layouts = [
      undefined,
      { multiline: true },
      { hoistEnums: "always" as const },
      { orSplitter: "or" as const },
      { multiline: true, hoistEnums: "always" as const, orSplitter: "or" as const },
    ];
    const fingerprints = layouts.map((layout) => renderFormat(nested, layout).fingerprint);
    expect(new Set(fingerprints).size).toBe(layouts.length);
    expect(renderFormat(nested, { multiline: true }).fingerprint).toBe(renderFormat(nested, { multiline: true }).fingerprint);
  });
});

describe("enum hoisting", () => {
  const declared = { fieldOrder: "declared" } as const;
  const Confidence = yomi(z.enum(["high", "low"]).describe("Evidence strength"))
    .valueDescription("high", "Directly measured")
    .valueDescription("low", "Largely guessed");

  it("leaves enums inline by default", () => {
    const schema = z.object({ confidence: Confidence });
    expect(renderFormat(schema, declared).format).toBe(
      '{ "confidence": "high" /* Directly measured */ | "low" /* Largely guessed */ /* Evidence strength */ }',
    );
  });

  it('hoists only described enums under "described", and every enum under "always"', () => {
    const schema = z.object({ confidence: Confidence, status: z.enum(["new", "done"]) });
    const described = renderFormat(schema, { ...declared, hoistEnums: "described" }).format;
    expect(described).toBe(
      'enum Confidence { "high" /* Directly measured */, "low" /* Largely guessed */ } /* Evidence strength */\n\n' +
      '{ "confidence": Confidence, "status": "new" | "done" }',
    );
    expect(renderFormat(schema, { ...declared, hoistEnums: "always" }).format).toContain('enum Status { "new", "done" }');
  });

  it("defines a shared enum once and references it by name everywhere", () => {
    const schema = z.object({ confidence: Confidence, items: z.array(z.object({ confidence: Confidence })) });
    const format = renderFormat(schema, { ...declared, hoistEnums: "described" }).format;
    expect(format.match(/enum Confidence/g)).toHaveLength(1);
    expect(format).toContain('"confidence": Confidence, "items": { "confidence": Confidence }[]');
  });

  it("names enums from yomi().named(), else the first field that reaches them", () => {
    const named = z.object({ confidence: yomi(Confidence).named("EvidenceGrade") });
    expect(renderFormat(named, { ...declared, hoistEnums: "described" }).format).toContain("enum EvidenceGrade {");

    const throughArray = z.object({ tags: z.array(yomi(z.enum(["a"])).valueDescription("a", "first")) });
    expect(renderFormat(throughArray, { ...declared, hoistEnums: "described" }).format).toContain("enum Tags {");

    const rootEnum = z.enum(["a", "b"]);
    expect(renderFormat(rootEnum, { hoistEnums: "always" }).format).toBe(
      'enum Enum { "a", "b" }\n\nEnum',
    );
  });

  it("keeps derived names unique when two enums share a field name", () => {
    const schema = z.object({
      first: z.object({ confidence: z.enum(["high"]) }),
      second: z.object({ confidence: z.enum(["low"]) }),
    });
    const format = renderFormat(schema, { ...declared, hoistEnums: "always" }).format;
    expect(format).toContain('enum Confidence { "high" }');
    expect(format).toContain('enum Confidence2 { "low" }');
    expect(format).toContain('"first": { "confidence": Confidence }, "second": { "confidence": Confidence2 }');
  });

  it("breaks hoisted blocks across lines with the schema body", () => {
    const schema = z.object({ confidence: Confidence, note: z.string() });
    expect(renderFormat(schema, { ...declared, multiline: true, hoistEnums: "described" }).format).toBe(
      [
        "enum Confidence {",
        '  "high" /* Directly measured */,',
        '  "low" /* Largely guessed */',
        "} /* Evidence strength */",
        "",
        "{",
        '  "confidence": Confidence,',
        '  "note": string',
        "}",
      ].join("\n"),
    );
  });

  it("hoists through optionality and renders enum aliases in the block", () => {
    const aliased = yomi(z.enum(["pending", "complete"]))
      .valueAlias("pending", "P")
      .valueDescription("pending", "Not started");
    const schema = z.object({ status: aliased.optional() });
    expect(renderFormat(schema, { ...declared, hoistEnums: "described" }).format).toBe(
      'enum Status { "P" /* Not started */, "complete" }\n\n{ "status"?: Status }',
    );
  });

  it("never hoists literals, which share the enum node", () => {
    const schema = z.object({ kind: z.literal("fixed") });
    expect(renderFormat(schema, { hoistEnums: "always" }).format).toBe(
      '{ "kind": "fixed" }',
    );
  });
});
