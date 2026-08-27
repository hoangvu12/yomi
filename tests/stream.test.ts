import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createStreamParser, inspectCompletion, parse, parseStream } from "../src/index.js";
import type { CompletionNode } from "../src/index.js";

const Profile = z.object({
  name: z.string(),
  age: z.number(),
  tags: z.array(z.string()),
});

describe("createStreamParser", () => {
  it("wraps configured paths with honest pending, incomplete, and complete state", () => {
    const schema = z.object({ message: z.string().nullable(), meta: z.object({ label: z.string() }).optional() });
    const stream = createStreamParser(schema, {
      fields: { message: { withState: true }, meta: { withState: true }, "meta.label": { withState: true } },
    });

    const pending = stream.push("{");
    expect(pending.success && pending.snapshot.data).toEqual({
      message: { value: undefined, state: "pending" },
      meta: { value: { label: { value: undefined, state: "pending" } }, state: "pending" },
    });
    const incomplete = stream.push('\"message\":\"hel');
    expect(incomplete.success && incomplete.snapshot.data).toMatchObject({
      message: { value: "hel", state: "incomplete" },
    });
    const explicitNull = createStreamParser(schema, { fields: { message: { withState: true } } });
    const complete = explicitNull.push('{"message":null}');
    expect(complete.success && complete.snapshot.data).toEqual({ message: { value: null, state: "complete" } });
  });

  it("freezes revisions and reuses a revision for a semantic duplicate", () => {
    const stream = createStreamParser(z.object({ text: z.string() }), { fields: { text: { withState: true } } });
    const first = stream.push('{"text":"done"}');
    const duplicate = stream.push("");
    expect(first.success && first.snapshot.revision).toBe(1);
    expect(duplicate.success && duplicate.snapshot.revision).toBe(1);
    if (first.success && duplicate.success) {
      expect(duplicate.snapshot).toBe(first.snapshot);
      expect(Object.isFrozen(first.snapshot)).toBe(true);
      expect(Object.isFrozen(first.snapshot.data)).toBe(true);
    }
  });

  it("does not let a state wrapper bypass parent gating", () => {
    const stream = createStreamParser(z.object({ card: z.object({ kind: z.literal("note"), body: z.string() }) }), {
      fields: { "card.kind": { withState: true, requiredForParent: true } },
    });
    const hidden = stream.push('{"card":{"body":"draft","kind":"no');
    expect(hidden.success && hidden.snapshot.data).toEqual({});
  });

  it("retains pending atomic collection positions when elements are state wrapped", () => {
    const stream = createStreamParser(z.object({ values: z.array(z.number()) }), {
      fields: { "values.*": { withState: true } },
    });
    const update = stream.push('{"values":[1,2');
    expect(update.success && update.snapshot.data).toEqual({ values: [
      { value: 1, state: "complete" },
      { value: undefined, state: "incomplete" },
    ] });
  });
  it("withholds atomic scalars until their emitted token boundary", () => {
    const schema = z.object({
      number: z.number(),
      boolean: z.boolean(),
      nothing: z.null(),
      literal: z.literal("ready"),
      status: z.enum(["ready", "done"]),
      date: z.date(),
    });
    const stream = createStreamParser(schema);

    for (const [chunk, expected] of [
      ['{"number":-1', {}],
      ['.2e3, "boolean":tru', { number: -1200 }],
      ['e, "nothing":nul', { number: -1200, boolean: true }],
      ['l, "literal":"rea', { number: -1200, boolean: true, nothing: null }],
      ['dy", "status":"rea', { number: -1200, boolean: true, nothing: null, literal: "ready" }],
      ['dy", "date":"2026-08', { number: -1200, boolean: true, nothing: null, literal: "ready", status: "ready" }],
    ] as const) {
      const result = stream.push(chunk);
      expect(result.success).toBe(true);
      if (result.success) expect(result.snapshot.data).toEqual(expected);
    }
    const closed = stream.push('-27"}');
    expect(closed.success).toBe(true);
    if (closed.success) expect(closed.snapshot.data).toMatchObject({
      number: -1200,
      boolean: true,
      nothing: null,
      literal: "ready",
      status: "ready",
      date: new Date("2026-08-27"),
    });
  });

  it("keeps strings and containers incremental unless configured complete-only", () => {
    const schema = z.object({ title: z.string(), card: z.object({ body: z.string() }) });
    const normal = createStreamParser(schema);
    const growing = normal.push('{"title":"hel');
    expect(growing.success && growing.snapshot.data).toEqual({ title: "hel" });

    const guarded = createStreamParser(schema, {
      fields: { title: { reveal: "complete" }, card: { reveal: "complete" } },
    });
    const hiddenTitle = guarded.push('{"title":"hello');
    expect(hiddenTitle.success && hiddenTitle.snapshot.data).toEqual({});
    const titleDone = guarded.push('","card":{"body":"grow');
    expect(titleDone.success && titleDone.snapshot.data).toEqual({ title: "hello" });
    const cardDone = guarded.push('ing"}}');
    expect(cardDone.success && cardDone.snapshot.data).toEqual({ title: "hello", card: { body: "growing" } });
    const final = guarded.finish();
    expect(final.success && final.data).toEqual({ title: "hello", card: { body: "growing" } });
  });

  it("filters incomplete atomic and configured collection elements without holes", () => {
    const numbers = createStreamParser(z.array(z.number()));
    const partialNumber = numbers.push("[1,2");
    expect(partialNumber.success && partialNumber.snapshot.data).toEqual([1]);
    const completedNumber = numbers.push("]");
    expect(completedNumber.success && completedNumber.snapshot.data).toEqual([1, 2]);

    const objects = createStreamParser(z.object({ items: z.array(z.object({ name: z.string() })) }), {
      fields: { "items.*": { reveal: "complete" } },
    });
    const partialObject = objects.push('{"items":[{"name":"first"},{"name":"sec');
    expect(partialObject.success && partialObject.snapshot.data).toEqual({ items: [{ name: "first" }] });
    const completedObject = objects.push('ond"}]}');
    expect(completedObject.success && completedObject.snapshot.data).toEqual({ items: [{ name: "first" }, { name: "second" }] });
  });

  it("applies reveal-on-completion to a union node", () => {
    const schema = z.object({ value: z.union([z.string(), z.object({ text: z.string() })]) });
    const stream = createStreamParser(schema, { fields: { value: { reveal: "complete" } } });
    const partial = stream.push('{"value":{"text":"grow');
    expect(partial.success && partial.snapshot.data).toEqual({});
    const complete = stream.push('ing"}}');
    expect(complete.success && complete.snapshot.data).toEqual({ value: { text: "growing" } });
  });

  it("gates a parent on the semantically visible required child", () => {
    const schema = z.object({ card: z.object({ kind: z.literal("note"), body: z.string() }) });
    const stream = createStreamParser(schema, { fields: { "card.kind": { requiredForParent: true } } });
    const absent = stream.push('{"card":{"body":"draft"');
    expect(absent.success && absent.snapshot.data).toEqual({});
    const incomplete = stream.push(',"kind":"no');
    expect(incomplete.success && incomplete.snapshot.data).toEqual({});
    const visible = stream.push('te"}}');
    expect(visible.success && visible.snapshot.data).toEqual({ card: { kind: "note", body: "draft" } });
  });

  it("keeps nested collection parents hidden for null and all-null gates", () => {
    const schema = z.object({ items: z.array(z.object({ identity: z.object({ primary: z.string().nullable(), secondary: z.string().nullable() }), text: z.string() })) });
    const stream = createStreamParser(schema, { fields: { "items.*.identity": { requiredForParent: true } } });
    const hidden = stream.push('{"items":[{"identity":{"primary":null,"secondary":null},"text":"hidden"},');
    expect(hidden.success && hidden.snapshot.data).toEqual({ items: [] });
    const shown = stream.push('{"identity":{"primary":"id","secondary":null},"text":"shown"}]}');
    expect(shown.success && shown.snapshot.data).toEqual({ items: [{ identity: { primary: "id", secondary: null }, text: "shown" }] });
  });

  it("reveals only the discriminator-selected union variant", () => {
    const schema = z.object({ event: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("text"), text: z.string() }),
      z.object({ kind: z.literal("image"), url: z.string() }),
    ]) });
    const stream = createStreamParser(schema, { fields: { "event.kind": { requiredForParent: true } } });
    const absent = stream.push('{"event":{"text":"hello"');
    expect(absent.success && absent.snapshot.data).toEqual({});
    const incomplete = stream.push(',"kind":"te');
    expect(incomplete.success && incomplete.snapshot.data).toEqual({});
    const selected = stream.push('xt"}}');
    expect(selected.success && selected.snapshot.data).toEqual({ event: { kind: "text", text: "hello" } });
  });

  it("validates streaming policy paths when the parser is created", () => {
    const schema = z.object({ items: z.array(z.object({ kind: z.string() })) });
    expect(() => createStreamParser(schema, { fields: { "items.kind": { reveal: "complete" } } })).toThrow(/does not exist/);
    expect(() => createStreamParser(schema, { fields: { items: { requiredForParent: true } } })).not.toThrow();
    expect(() => createStreamParser(z.array(z.string()), { fields: { "*": { requiredForParent: true } } })).toThrow(/object child/);
  });

  it("does not regress a completed atomic value within an attempt", () => {
    const stream = createStreamParser(z.object({ count: z.number() }));
    const complete = stream.push('{"count":12}');
    expect(complete.success && complete.snapshot.data).toEqual({ count: 12 });
    const trailingProse = stream.push(" and explanatory prose");
    expect(trailingProse.success && trailingProse.snapshot.data).toEqual({ count: 12 });
  });

  it("never exposes incomplete atomic values under prefix replay", () => {
    const response = '{"values":[-12.5e2,true,null],"status":"done"}';
    const schema = z.object({ values: z.array(z.union([z.number(), z.boolean(), z.null()])), status: z.enum(["done", "pending"]) });
    for (let end = 1; end <= response.length; end++) {
      const prefix = response.slice(0, end);
      const stream = createStreamParser(schema);
      const result = stream.push(prefix);
      if (!result.success) continue;
      const completion = result.snapshot.completion.children as Record<string, CompletionNode> | undefined;
      const valueNodes = completion?.values?.children as readonly CompletionNode[] | undefined;
      const visible = result.snapshot.data.values ?? [];
      expect(visible.length).toBe(valueNodes?.filter((node) => node.state === "complete").length ?? 0);
      if (result.snapshot.data.status !== undefined) expect(completion?.status?.state).toBe("complete");
    }
  });

  it("emits deep partial snapshots and strictly validates at finish", () => {
    const stream = createStreamParser(Profile);

    const first = stream.push('{"name":"Ada');
    expect(first.success).toBe(true);
    if (first.success) expect(first.snapshot.data).toEqual({ name: "Ada" });

    const second = stream.push('","age":"37","tags":["math"');
    expect(second.success).toBe(true);
    if (second.success) {
      expect(second.snapshot.data).toEqual({ name: "Ada", age: 37, tags: ["math"] });
      expect(second.snapshot.done).toBe(false);
    }

    stream.push("]}");
    const final = stream.finish();
    expect(final.success).toBe(true);
    if (final.success) expect(final.data).toEqual({ name: "Ada", age: 37, tags: ["math"] });
  });

  it("keeps incomplete or invalid roots pending instead of throwing", () => {
    const stream = createStreamParser(Profile);
    expect(stream.push("Here is the result: ")).toMatchObject({ success: false, pending: true });
    stream.push('{"name":"Ada"}');
    const final = stream.finish();
    expect(final.success).toBe(false);
    if (!final.success) expect(final.error.path).toEqual(["age"]);
  });

  it("decodes UTF-8 byte chunks without splitting characters", () => {
    const stream = createStreamParser(z.object({ name: z.string() }));
    const bytes = new TextEncoder().encode('{"name":"日本語"}');
    for (const byte of bytes) stream.push(new Uint8Array([byte]));
    const final = stream.finish();
    expect(final.success && final.data.name).toBe("日本語");
  });

  it("uses only emitted delimiters as completion evidence", () => {
    const stream = createStreamParser(z.object({ message: z.string(), count: z.number() }));
    const stringPrefix = stream.push('{"message":"hello');
    expect(stringPrefix.success).toBe(true);
    if (stringPrefix.success) {
      expect(stringPrefix.snapshot.data).toEqual({ message: "hello" });
      expect(stringPrefix.snapshot.completion).toEqual({
        state: "incomplete",
        children: { message: { state: "incomplete" } },
      });
    }

    const numberPrefix = stream.push('","count":12');
    expect(numberPrefix.success).toBe(true);
    if (numberPrefix.success) {
      expect(numberPrefix.snapshot.completion).toEqual({
        state: "incomplete",
        children: {
          message: { state: "complete" },
          count: { state: "incomplete" },
        },
      });
    }

    const closed = stream.push("}");
    expect(closed.success).toBe(true);
    if (closed.success) {
      expect(closed.snapshot.completion.state).toBe("complete");
      expect((closed.snapshot.completion.children as Record<string, { state: string }>).count.state).toBe("complete");
    }
  });

  it("reports pending separately from incomplete", () => {
    const stream = createStreamParser(z.object({ value: z.string() }));
    expect(stream.push("Some introductory prose")).toMatchObject({
      success: false,
      pending: true,
      completion: { state: "pending" },
    });
    expect(inspectCompletion('{"value":')).toEqual({
      state: "incomplete",
      children: { value: { state: "pending" } },
    });
  });

  it("tracks quoted root strings without mistaking their contents for structure", () => {
    expect(inspectCompletion('"unfinished [text')).toEqual({ state: "incomplete" });
    expect(inspectCompletion('"finished [text"')).toEqual({ state: "complete" });
  });

  it("applies byte budgets before an incomplete UTF-8 sequence is decoded", () => {
    const stream = createStreamParser(z.string(), { limits: { maxInputBytes: 1 } });
    const bytes = new TextEncoder().encode("æ—¥");
    expect(stream.push(bytes.slice(0, 1))).toMatchObject({ success: false, pending: true });
    expect(stream.push(bytes.slice(1, 2))).toMatchObject({
      success: false,
      pending: false,
      error: { type: "resource_limit_error", budget: "maxInputBytes" },
    });
  });

  it("keeps completion invariant across every character and UTF-8 byte boundary", () => {
    const response = 'Result:\n```json\n{"text":"A \\"quote\\" and æ—¥æœ¬èªž","items":[true,null,-1.2e3]}\n```';
    const expected = inspectCompletion(response);
    expect(expected.state).toBe("complete");

    for (let split = 0; split <= response.length; split++) {
      const stream = createStreamParser(z.object({
        text: z.string(),
        items: z.array(z.union([z.boolean(), z.null(), z.number()])),
      }));
      stream.push(response.slice(0, split));
      stream.push(response.slice(split));
      const last = stream.push("");
      expect(last.success).toBe(true);
      if (last.success) expect(last.snapshot.completion).toEqual(expected);
      expect(stream.finish()).toEqual(parse(z.object({
        text: z.string(),
        items: z.array(z.union([z.boolean(), z.null(), z.number()])),
      }), response));
    }

    const bytes = new TextEncoder().encode(response);
    for (let split = 0; split <= bytes.length; split++) {
      const stream = createStreamParser(z.object({
        text: z.string(),
        items: z.array(z.union([z.boolean(), z.null(), z.number()])),
      }));
      stream.push(bytes.slice(0, split));
      const last = stream.push(bytes.slice(split));
      expect(last.success).toBe(true);
      if (last.success) expect(last.snapshot.completion).toEqual(expected);
      expect(stream.finish().success).toBe(true);
    }
  });
});

describe("parseStream", () => {
  it("consumes provider-agnostic async iterables", async () => {
    async function* chunks() {
      yield '{"name":"Ada",';
      yield '"age":37,"tags":[]}' ;
    }
    const snapshots = [];
    for await (const snapshot of parseStream(Profile, chunks())) snapshots.push(snapshot.data);
    expect(snapshots.at(-1)).toEqual({ name: "Ada", age: 37, tags: [] });
  });
});
