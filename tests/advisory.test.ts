import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { advisoryPolicyFingerprint, createStreamParser, parse } from "../src/index.js";

describe("advisory validation", () => {
  it("reports passing and failing named checks without changing data", () => {
    const input = '{"items":[{"score":4},{"score":9}]}';
    const schema = z.object({ items: z.array(z.object({ score: z.number() })) });
    const result = parse(schema, input, { advisoryChecks: [
      { name: "has-items", check: (value) => value.items.length > 0 },
      { name: "all-high", check: (value) => ({ success: value.items.every((item) => item.score >= 5), message: "score below five", path: ["items"] }) },
    ] });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.items).toEqual([{ score: 4 }, { score: 9 }]);
    expect(result.advisory.passed).toBe(false);
    expect(result.advisory.checks.map((check) => [check.name, check.passed])).toEqual([["has-items", true], ["all-high", false]]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "advisory_check_failed", path: ["items"], severity: "warning" }));
  });

  it("turns thrown checks into bounded failures", () => {
    const result = parse(z.object({ value: z.number() }), '{"value":1}', {
      limits: { maxRetainedEvidenceBytes: 5 },
      advisoryChecks: [{ name: "throws", check: () => { throw new Error("sensitive long detail"); } }],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const diagnostic = result.advisory.checks[0]?.diagnostic;
    expect(diagnostic?.code).toBe("advisory_check_threw");
    expect(new TextEncoder().encode(diagnostic?.evidence).byteLength).toBeLessThanOrEqual(5);
  });

  it("does not run advisory checks when strict validation fails", () => {
    const check = vi.fn(() => true);
    const result = parse(z.object({ score: z.number().max(10) }), '{"score":11}', { advisoryChecks: [{ name: "quality", check }] });
    expect(result.success).toBe(false);
    expect(check).not.toHaveBeenCalled();
  });

  it("evaluates stream checks only at the honest strict final boundary", () => {
    const check = vi.fn((value: { answer: string }) => value.answer.length > 2);
    const parser = createStreamParser(z.object({ answer: z.string() }), { advisoryChecks: [{ name: "long-enough", check }] });
    const snapshot = parser.push('{"answer":"o');
    expect(snapshot.success).toBe(true);
    expect(check).not.toHaveBeenCalled();
    parser.push('k!"}');
    expect(check).not.toHaveBeenCalled();
    const final = parser.finish();
    expect(final.success && final.advisory.passed).toBe(true);
    expect(check).toHaveBeenCalledOnce();
  });

  it("fingerprints named advisory policy deterministically and in order", () => {
    const a = { name: "a", check: () => true };
    const b = { name: "b", check: () => true };
    expect(advisoryPolicyFingerprint([a, b])).toBe(advisoryPolicyFingerprint([a, b]));
    expect(advisoryPolicyFingerprint([a, b])).not.toBe(advisoryPolicyFingerprint([b, a]));
  });

  it("rejects duplicate names", () => {
    expect(() => parse(z.string(), '"ok"', { advisoryChecks: [
      { name: "same", check: () => true }, { name: "same", check: () => true },
    ] })).toThrow(/Duplicate advisory check name/);
  });
});
