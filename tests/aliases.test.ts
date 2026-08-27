import { describe, expect, it } from "vitest";
import { z } from "zod";
import { compileSchema, coerce, renderFormat, yomi } from "../src/index.js";

describe("model-facing aliases and descriptions", () => {
  it("renders descriptions and maps field and enum aliases to canonical output", () => {
    const status = yomi(z.enum(["pending", "done"]).describe("Current state"))
      .valueAlias("pending", "waiting")
      .valueDescription("pending", "Work has not finished");
    const schema = z.object({
      displayName: yomi(z.string()).alias("name").describe("Human-readable name"),
      status,
    }).describe("A job response");
    const rendered = renderFormat(schema).format;
    expect(rendered).toContain('"name": string /* Human-readable name */');
    expect(rendered).toContain('"waiting" /* Work has not finished */');
    expect(rendered).toContain("A job response");
    const result = coerce(schema, { name: "Ada", status: "waiting" });
    expect(result.success && result.value).toEqual({ displayName: "Ada", status: "pending" });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "alias_used", path: ["displayName"], cost: 1 }),
      expect.objectContaining({ code: "alias_used", path: ["status"], cost: 1 }),
    ]));
  });

  it("gives exact canonical names precedence", () => {
    const schema = z.object({ value: yomi(z.number()).alias("model.value").optional() });
    const result = coerce(schema, { value: 1, "model.value": 2 });
    expect(result.success && result.value).toEqual({ value: 1 });
    expect(result.success && result.flags.some((flag) => flag.flag === "alias_used")).toBe(false);
  });

  it("uses alias cost during union selection", () => {
    const schema = z.union([
      z.object({ canonical: yomi(z.string()).alias("value") }),
      z.object({ value: z.string() }),
    ]);
    const result = coerce(schema, { value: "x" });
    expect(result.success && result.value).toEqual({ value: "x" });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "union_candidate_rejected", candidate: 0, cost: 1 }));
  });

  it("supports aliases in recursive schemas", () => {
    type Node = { label: string; child?: Node };
    const node: z.ZodType<Node> = z.lazy(() => z.object({
      label: yomi(z.string()).alias("title"), child: node.optional(),
    }));
    const result = coerce(node, { title: "a", child: { title: "b" } });
    expect(result.success && result.value).toEqual({ label: "a", child: { label: "b" } });
  });

  it("reports path-aware field and enum collisions", () => {
    const fields = z.object({ a: yomi(z.string()).alias("b"), b: z.string() });
    expect(compileSchema(fields).diagnostics).toContainEqual(expect.objectContaining({ code: "alias_collision", path: ["a"] }));
    const values = yomi(z.enum(["a", "b"])).valueAlias("a", "b");
    expect(compileSchema(values).diagnostics).toContainEqual(expect.objectContaining({ code: "alias_collision", path: ["a"] }));
  });
});
