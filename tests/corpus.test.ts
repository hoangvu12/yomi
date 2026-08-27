import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createStreamParser,
  parse,
  yomi,
  type Diagnostic,
  type ParserOptions,
  type StreamSnapshot,
} from "../src/index.js";

type SchemaFixture = {
  schema: z.ZodTypeAny;
  options?: ParserOptions;
};

type ExpectedOutcome =
  | { success: true; data: unknown }
  | { success: false; errorType: string; budget?: string };

type CorpusCase = {
  name: string;
  schema: SchemaFixture;
  raw: string;
  expected: ExpectedOutcome;
  diagnostics?: readonly Partial<Pick<Diagnostic, "code" | "phase" | "path" | "severity" | "cost">>[];
  replay?: "characters" | "characters-and-bytes" | "final-only";
  assertPrefix?: (prefix: string, snapshot: StreamSnapshot<unknown> | undefined) => void;
};

const recursiveNode: z.ZodType<{ label: string; child?: { label: string; child?: unknown } }> = z.lazy(() =>
  z.object({ label: yomi(z.string()).alias("title"), child: recursiveNode.optional() }),
);

const fixtures = {
  article: {
    schema: z.object({ title: z.string(), count: z.number(), tags: z.array(z.string()) }),
  },
  nestedUnion: {
    schema: z.object({ event: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("text"), payload: z.object({ text: z.string() }) }),
      z.object({ kind: z.literal("score"), payload: z.object({ score: z.number() }) }),
    ]) }),
    options: { fields: { "event.kind": { requiredForParent: true } } },
  },
  aliasedRecursive: { schema: recursiveNode },
  unicode: { schema: z.object({ text: z.string(), ok: z.boolean() }) },
} satisfies Record<string, SchemaFixture>;

/**
 * Regression corpus for real-world response shapes. A parser bug should be added
 * as one object here: raw response, schema identity, outcome, diagnostics, and
 * (when needed) a semantic prefix assertion.
 */
const corpus: readonly CorpusCase[] = [
  {
    name: "markdown, prose, escapes, and repairs",
    schema: fixtures.article,
    raw: 'I extracted this:\n```json\n{title: "A \\"quoted\\" title", count: "2", tags: ["one", "two",],}\n```\nDone.',
    expected: { success: true, data: { title: 'A "quoted" title', count: 2, tags: ["one", "two"] } },
    diagnostics: [
      { code: "json_repaired", phase: "syntax", severity: "warning", path: [], cost: 1 },
      { code: "extracted_from_markdown", phase: "syntax", severity: "warning", path: [], cost: 1 },
      { code: "string_to_number", phase: "coercion", severity: "warning", path: ["count"], cost: 2 },
    ],
  },
  {
    name: "nested union with discriminator parent gating",
    schema: fixtures.nestedUnion,
    raw: '{"event":{"payload":{"text":"hello"},"kind":"text"}}',
    expected: { success: true, data: { event: { kind: "text", payload: { text: "hello" } } } },
    assertPrefix(prefix, snapshot) {
      const discriminatorComplete = prefix.includes('"kind":"text"');
      if (!discriminatorComplete && snapshot) expect(snapshot.data).toEqual({});
    },
  },
  {
    name: "aliases and recursive schemas",
    schema: fixtures.aliasedRecursive,
    raw: '{"title":"root","child":{"title":"leaf"}}',
    expected: { success: true, data: { label: "root", child: { label: "leaf" } } },
    diagnostics: [{ code: "alias_used", phase: "coercion", severity: "warning", path: ["label"], cost: 1 }],
  },
  {
    name: "unicode split at every UTF-8 byte boundary",
    schema: fixtures.unicode,
    raw: 'Result: {"text":"日本語 café 🚀","ok":true}',
    expected: { success: true, data: { text: "日本語 café 🚀", ok: true } },
    replay: "characters-and-bytes",
  },
  {
    name: "truncated response remains a strict final failure",
    schema: fixtures.article,
    raw: '{"title":"unfinished","count":',
    expected: { success: false, errorType: "coercion_error" },
  },
  {
    name: "incomplete atomic values are never exposed",
    schema: { schema: z.object({ count: z.number(), ready: z.boolean() }) },
    raw: '{"count":-12.5e2,"ready":true}',
    expected: { success: true, data: { count: -1250, ready: true } },
    assertPrefix(prefix, snapshot) {
      if (!snapshot) return;
      if (!prefix.includes(",")) expect(snapshot.data).not.toHaveProperty("count");
      if (!prefix.endsWith("}")) expect(snapshot.data).not.toHaveProperty("ready");
    },
  },
  {
    name: "malformed response records a stable failure kind",
    schema: fixtures.article,
    raw: "This response contains no structured value at all.",
    expected: { success: false, errorType: "coercion_error" },
  },
  {
    name: "oversized input fails before unbounded replay work",
    schema: { schema: z.object({ value: z.string() }), options: { limits: { maxInputBytes: 32 } } },
    raw: JSON.stringify({ value: "x".repeat(64) }),
    expected: { success: false, errorType: "resource_limit_error", budget: "maxInputBytes" },
    replay: "final-only",
  },
];

describe("durable parser corpus", () => {
  // The corpus is intentionally small and bounded: normal cases are <= 256
  // characters and only explicitly tagged Unicode cases receive byte replay.
  it("keeps exhaustive replay bounded for normal CI", () => {
    expect(corpus.filter((item) => item.replay !== "final-only").every((item) => item.raw.length <= 256)).toBe(true);
    expect(corpus.filter((item) => item.replay === "characters-and-bytes")).toHaveLength(1);
  });

  for (const fixture of corpus) {
    it(fixture.name, () => runCorpusCase(fixture), 10_000);
  }
});

function runCorpusCase(fixture: CorpusCase): void {
  const { schema, options } = fixture.schema;
  const batch = parse(schema, fixture.raw, options);
  assertOutcome(batch, fixture.expected);
  if (batch.success && fixture.diagnostics) {
    for (const diagnostic of fixture.diagnostics) {
      expect(batch.diagnostics).toContainEqual(expect.objectContaining(diagnostic));
    }
  }

  if (fixture.replay === "final-only") {
    const stream = createStreamParser(schema, options);
    const pushed = stream.push(fixture.raw);
    if (!fixture.expected.success && pushed.success === false && pushed.pending === false) {
      expect(pushed.error.type).toBe(fixture.expected.errorType);
      if (fixture.expected.budget) expect(pushed.error.budget).toBe(fixture.expected.budget);
    } else {
      assertOutcome(stream.finish(), fixture.expected);
    }
    return;
  }

  // Every meaningful character prefix is independently interpreted. This
  // catches accidental dependence on a provider's earlier chunk boundaries.
  for (let end = 1; end <= fixture.raw.length; end++) {
    const prefix = fixture.raw.slice(0, end);
    const stream = createStreamParser(schema, options);
    const pushed = stream.push(prefix);
    const snapshot = pushed.success ? pushed.snapshot as StreamSnapshot<unknown> : undefined;
    assertSnapshotInvariants(stream, snapshot);
    fixture.assertPrefix?.(prefix, snapshot);
  }

  // Replay all two-chunk partitions, including boundaries inside keys, escapes,
  // scalars, containers, fences, and surrounding prose.
  for (let split = 0; split <= fixture.raw.length; split++) {
    const stream = createStreamParser(schema, options);
    let previousRevision = 0;
    for (const chunk of [fixture.raw.slice(0, split), fixture.raw.slice(split)]) {
      const pushed = stream.push(chunk);
      if (!pushed.success) continue;
      expect(pushed.snapshot.revision).toBeGreaterThanOrEqual(previousRevision);
      previousRevision = pushed.snapshot.revision;
      assertSnapshotInvariants(stream, pushed.snapshot as StreamSnapshot<unknown>);
    }
    assertOutcome(stream.finish(), fixture.expected);
  }

  if (fixture.replay === "characters-and-bytes") replayEveryByteBoundary(fixture);
}

function replayEveryByteBoundary(fixture: CorpusCase): void {
  const bytes = new TextEncoder().encode(fixture.raw);
  for (let split = 0; split <= bytes.length; split++) {
    const stream = createStreamParser(fixture.schema.schema, fixture.schema.options);
    stream.push(bytes.slice(0, split));
    stream.push(bytes.slice(split));
    assertOutcome(stream.finish(), fixture.expected);
  }
}

function assertSnapshotInvariants(stream: ReturnType<typeof createStreamParser>, snapshot?: StreamSnapshot<unknown>): void {
  if (!snapshot) return;
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot.data)).toBe(true);
  expect(snapshot.revision).toBeGreaterThan(0);

  // A chunk that changes no semantic value/state must be deduplicated and must
  // not mutate a previously published snapshot.
  const before = JSON.stringify(snapshot.data);
  const duplicate = stream.push("");
  expect(duplicate.success).toBe(true);
  if (duplicate.success) {
    expect(duplicate.snapshot).toBe(snapshot);
    expect(duplicate.snapshot.revision).toBe(snapshot.revision);
  }
  expect(JSON.stringify(snapshot.data)).toBe(before);
}

function assertOutcome(result: ReturnType<typeof parse>, expected: ExpectedOutcome): void {
  expect(result.success).toBe(expected.success);
  if (expected.success) {
    if (!result.success) return;
    expect(result.data).toEqual(expected.data);
  } else {
    if (result.success) return;
    expect(result.error.type).toBe(expected.errorType);
    if (expected.budget) expect(result.error.budget).toBe(expected.budget);
  }
}
