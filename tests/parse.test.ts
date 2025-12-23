import { describe, it, expect } from "vitest";
import { parseJson, JsonParseError } from "../src/parse.js";
import { Flag } from "../src/flags.js";

describe("parseJson", () => {
  describe("valid JSON", () => {
    it("parses valid JSON object", () => {
      const result = parseJson('{"name": "John", "age": 25}');
      expect(result.value).toEqual({ name: "John", age: 25 });
      expect(result.flags).toHaveLength(0);
    });

    it("parses valid JSON array", () => {
      const result = parseJson("[1, 2, 3]");
      expect(result.value).toEqual([1, 2, 3]);
      expect(result.flags).toHaveLength(0);
    });

    it("parses valid JSON primitives", () => {
      expect(parseJson("123").value).toBe(123);
      expect(parseJson('"hello"').value).toBe("hello");
      expect(parseJson("true").value).toBe(true);
      expect(parseJson("null").value).toBe(null);
    });
  });

  describe("markdown extraction", () => {
    it("extracts JSON from markdown code block", () => {
      const input = `Here's the data:
\`\`\`json
{"name": "John"}
\`\`\`
That's it!`;
      const result = parseJson(input);
      expect(result.value).toEqual({ name: "John" });
      expect(result.flags.map((f) => f.flag)).toContain(Flag.ExtractedFromMarkdown);
    });

    it("extracts JSON from code block without language", () => {
      const input = `\`\`\`
{"value": 42}
\`\`\``;
      const result = parseJson(input);
      expect(result.value).toEqual({ value: 42 });
      expect(result.flags.map((f) => f.flag)).toContain(Flag.ExtractedFromMarkdown);
    });
  });

  describe("text extraction", () => {
    it("extracts JSON object from surrounding text", () => {
      const input = 'Here is the result: {"name": "John", "age": 25} hope this helps!';
      const result = parseJson(input);
      expect(result.value).toEqual({ name: "John", age: 25 });
      expect(result.flags.map((f) => f.flag)).toContain(Flag.ExtractedFromText);
    });

    it("extracts JSON array from surrounding text", () => {
      const input = "The numbers are: [1, 2, 3] as requested.";
      const result = parseJson(input);
      expect(result.value).toEqual([1, 2, 3]);
      expect(result.flags.map((f) => f.flag)).toContain(Flag.ExtractedFromText);
    });

    it("handles nested objects in text", () => {
      const input = 'Result: {"user": {"name": "John"}, "active": true}';
      const result = parseJson(input);
      expect(result.value).toEqual({ user: { name: "John" }, active: true });
    });
  });

  describe("JSON repair", () => {
    it("fixes trailing commas", () => {
      const result = parseJson('{"name": "John", "age": 25,}');
      expect(result.value).toEqual({ name: "John", age: 25 });
      expect(result.flags.map((f) => f.flag)).toContain(Flag.JsonRepaired);
    });

    it("fixes unquoted keys", () => {
      const result = parseJson("{name: 'John', age: 25}");
      expect(result.value).toEqual({ name: "John", age: 25 });
      expect(result.flags.map((f) => f.flag)).toContain(Flag.JsonRepaired);
    });

    it("fixes single quotes", () => {
      const result = parseJson("{'name': 'John'}");
      expect(result.value).toEqual({ name: "John" });
      expect(result.flags.map((f) => f.flag)).toContain(Flag.JsonRepaired);
    });

    it("handles comments", () => {
      const input = `{
        // This is a comment
        "name": "John",
        /* Another comment */
        "age": 25
      }`;
      const result = parseJson(input);
      expect(result.value).toEqual({ name: "John", age: 25 });
      expect(result.flags.map((f) => f.flag)).toContain(Flag.JsonRepaired);
    });

    it("fixes missing quotes around string values", () => {
      const result = parseJson("{name: John}");
      expect(result.value).toEqual({ name: "John" });
      expect(result.flags.map((f) => f.flag)).toContain(Flag.JsonRepaired);
    });
  });

  describe("error handling", () => {
    it("handles plain text by repairing to string", () => {
      // jsonrepair can turn plain text into a valid JSON string
      const result = parseJson("not json at all");
      expect(result.value).toBe("not json at all");
      expect(result.flags.map((f) => f.flag)).toContain(Flag.JsonRepaired);
    });

    it("throws for empty input", () => {
      expect(() => parseJson("")).toThrow(JsonParseError);
    });

    it("throws for whitespace-only input", () => {
      expect(() => parseJson("   ")).toThrow(JsonParseError);
    });
  });

  describe("edge cases", () => {
    it("handles whitespace around JSON", () => {
      const result = parseJson('   {"name": "John"}   ');
      expect(result.value).toEqual({ name: "John" });
    });

    it("handles deeply nested objects", () => {
      const input = '{"a": {"b": {"c": {"d": 1}}}}';
      const result = parseJson(input);
      expect(result.value).toEqual({ a: { b: { c: { d: 1 } } } });
    });

    it("handles arrays of objects", () => {
      const input = '[{"id": 1}, {"id": 2}]';
      const result = parseJson(input);
      expect(result.value).toEqual([{ id: 1 }, { id: 2 }]);
    });

    it("handles unicode", () => {
      const result = parseJson('{"name": "日本語", "emoji": "🎉"}');
      expect(result.value).toEqual({ name: "日本語", emoji: "🎉" });
    });
  });
});
