import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createStreamParser, inspectCompletion, parse, parseStream } from "../src/index.js";

const Profile = z.object({
  name: z.string(),
  age: z.number(),
  tags: z.array(z.string()),
});

describe("createStreamParser", () => {
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
