import { describe, expect, it } from "vitest";
import { z } from "zod";
import { coerce, parse } from "../src/index.js";

describe("schema-scored union selection", () => {
  it("is independent of declaration order when one candidate is exact", () => {
    for (const schema of [z.union([z.string(), z.number()]), z.union([z.number(), z.string()])]) {
      const result = coerce(schema, 42);
      expect(result.success && result.value).toBe(42);
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "union_candidate_chosen", cost: 0 }),
        expect.objectContaining({ code: "union_candidate_rejected", cost: 2 }),
      ]));
    }
  });

  it("uses exact discriminator evidence before broad alternatives", () => {
    const cat = z.object({ kind: z.literal("cat"), lives: z.number() });
    const dog = z.object({ kind: z.literal("dog"), bark: z.string().default("woof") });
    const schema = z.discriminatedUnion("kind", [cat, dog]);
    const result = coerce(schema, { kind: "cat", lives: "9", bark: "ignored" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.value).toEqual({ kind: "cat", lives: 9 });
  });

  it("reports materially different equal-cost values as ambiguous by default", () => {
    const schema = z.union([z.number(), z.boolean()]);
    const result = coerce(schema, "1");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe("ambiguity_error");
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "union_ambiguous_candidate", candidate: 0, cost: 2 }),
        expect.objectContaining({ code: "union_ambiguous_candidate", candidate: 1, cost: 2 }),
      ]));
    }
  });

  it("can compatibility-tie-break without hiding ambiguity", () => {
    const schema = z.union([z.string(), z.boolean()]);
    const result = coerce(schema, 1, { unionTieBreaker: "first" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toBe("1");
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "union_ambiguous_candidate" }),
        expect.objectContaining({ code: "union_candidate_chosen", candidate: 0 }),
      ]));
    }
  });

  it("scores nested unions and exposes validation failures", () => {
    const schema = z.object({ item: z.union([z.number().min(10), z.string()]) });
    const result = parse(schema, '{"item":5}');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ item: "5" });
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "union_candidate_rejected", phase: "validation", candidate: 0 }),
        expect.objectContaining({ code: "union_candidate_chosen", candidate: 1, cost: 2 }),
      ]));
    }
  });
});
