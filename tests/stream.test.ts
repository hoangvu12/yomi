import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createStreamParser, parseStream } from "../src/index.js";

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
