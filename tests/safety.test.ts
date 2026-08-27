import { describe, expect, it } from "vitest";
import { z } from "zod";
import { coerce, createStreamParser, DEFAULT_PARSER_LIMITS, parse, ResourceLimitError } from "../src/index.js";
import { parseJson } from "../src/parse.js";

describe("bounded structured diagnostics", () => {
  it("reports repairs and coercions with the stable diagnostic vocabulary", () => {
    const result = parse(z.object({ count: z.number() }), "{count: '2',}");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({ count: 2 });
    expect(result.diagnostics.map(({ code, phase, severity, path, cost }) => ({ code, phase, severity, path, cost }))).toEqual([
      { code: "json_repaired", phase: "syntax", severity: "warning", path: [], cost: 1 },
      { code: "string_to_number", phase: "coercion", severity: "warning", path: ["count"], cost: 2 },
    ]);
  });

  it("publishes finite defaults", () => {
    for (const value of Object.values(DEFAULT_PARSER_LIMITS)) expect(Number.isFinite(value)).toBe(true);
  });

  it.each([
    ["maxInputBytes", z.unknown(), '"abcd"', { maxInputBytes: 3 }],
    ["maxNestingDepth", z.unknown(), '[[[0]]]', { maxNestingDepth: 2 }],
    ["maxCollectionSize", z.array(z.number()), '[1,2]', { maxCollectionSize: 1 }],
    ["maxCandidates", z.union([z.number(), z.boolean()]), '"nope"', { maxCandidates: 1 }],
    ["maxRepairWork", z.object({ a: z.number() }), '{a:1}', { maxRepairWork: 0 }],
  ] as const)("returns a typed deterministic %s failure", (budget, schema, input, limits) => {
    const result = parse(schema, input, { limits });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.type).toBe("resource_limit_error");
    expect(result.error.budget).toBe(budget);
  });

  it("bounds diagnostic count and retained evidence independently", () => {
    const result = parse(z.object({ n: z.number() }), "```json\n{n:'2'}\n```", { limits: { maxDiagnostics: 1, maxRetainedEvidenceBytes: 0 } });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).not.toHaveProperty("evidence");
  });

  it("checks budgets for already-parsed values", () => {
    const result = coerce(z.array(z.number()), [1, 2], { limits: { maxCollectionSize: 1 } });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatchObject({ type: "resource_limit_error", budget: "maxCollectionSize" });
  });

  it("constructs records without invoking prototype-sensitive setters", () => {
    const input = JSON.parse('{"__proto__":{"polluted":true},"safe":1}');
    const result = coerce(z.record(z.string(), z.unknown()), input);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(result.value.safe).toBe(1);
    expect((result.value as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("throws the exported typed error at the low-level parser boundary", () => {
    expect(() => parseJson("xxxx", { ...DEFAULT_PARSER_LIMITS, maxInputBytes: 1 })).toThrow(ResourceLimitError);
  });

  it("enforces input budgets at the streaming public boundary", () => {
    const result = createStreamParser(z.string(), { limits: { maxInputBytes: 1 } }).push('"ab"');
    expect(result).toMatchObject({ success: false, pending: false, error: { type: "resource_limit_error", budget: "maxInputBytes" } });
  });
});
