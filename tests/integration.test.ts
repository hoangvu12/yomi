import { describe, it, expect } from "vitest";
import { z } from "zod";
import { parse, parseOrThrow, Flag } from "../src/index.js";

describe("integration: parse", () => {
  describe("real-world LLM outputs", () => {
    const UserSchema = z.object({
      name: z.string(),
      age: z.number(),
      email: z.string().optional(),
      active: z.boolean().default(true),
    });

    it("handles clean JSON", () => {
      const result = parse(UserSchema, '{"name": "John", "age": 25}');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ name: "John", age: 25, active: true });
      }
    });

    it("handles JSON with trailing comma", () => {
      const result = parse(UserSchema, '{"name": "John", "age": 25,}');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ name: "John", age: 25, active: true });
        expect(result.flags.map((f) => f.flag)).toContain(Flag.JsonRepaired);
      }
    });

    it("handles JSON in markdown code block", () => {
      const input = `Here's the user data:

\`\`\`json
{
  "name": "John",
  "age": 25,
  "email": "john@example.com"
}
\`\`\`

Let me know if you need anything else!`;

      const result = parse(UserSchema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({
          name: "John",
          age: 25,
          email: "john@example.com",
          active: true,
        });
        expect(result.flags.map((f) => f.flag)).toContain(Flag.ExtractedFromMarkdown);
      }
    });

    it("handles JSON with string numbers", () => {
      const result = parse(UserSchema, '{"name": "John", "age": "25"}');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.age).toBe(25);
        expect(result.flags.map((f) => f.flag)).toContain(Flag.StringToNumber);
      }
    });

    it("handles JSON with boolean strings", () => {
      const result = parse(UserSchema, '{"name": "John", "age": 25, "active": "yes"}');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.active).toBe(true);
        expect(result.flags.map((f) => f.flag)).toContain(Flag.StringToBool);
      }
    });

    it("handles unquoted keys", () => {
      const result = parse(UserSchema, "{name: 'John', age: 25}");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ name: "John", age: 25, active: true });
      }
    });

    it("ignores extra fields from LLM", () => {
      const result = parse(
        UserSchema,
        '{"name": "John", "age": 25, "explanation": "This is the user data"}'
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ name: "John", age: 25, active: true });
        expect(result.flags.map((f) => f.flag)).toContain(Flag.ExtraKeysIgnored);
      }
    });
  });

  describe("complex schemas", () => {
    const OrderSchema = z.object({
      id: z.string(),
      items: z.array(
        z.object({
          name: z.string(),
          quantity: z.number(),
          price: z.number(),
        })
      ),
      total: z.number(),
      status: z.enum(["pending", "shipped", "delivered"]),
    });

    it("handles nested arrays and objects", () => {
      const input = `{
        "id": "order-123",
        "items": [
          {"name": "Widget", "quantity": "2", "price": 9.99},
          {"name": "Gadget", "quantity": 1, "price": "19.99"}
        ],
        "total": "39.97",
        "status": "PENDING"
      }`;

      const result = parse(OrderSchema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe("order-123");
        expect(result.data.items).toHaveLength(2);
        expect(result.data.items[0]?.quantity).toBe(2);
        expect(result.data.items[1]?.price).toBe(19.99);
        expect(result.data.total).toBe(39.97);
        expect(result.data.status).toBe("pending");
        expect(result.flags.map((f) => f.flag)).toContain(Flag.StringToNumber);
        expect(result.flags.map((f) => f.flag)).toContain(Flag.EnumCaseInsensitive);
      }
    });

    it("wraps single item in array", () => {
      const input = `{
        "id": "order-456",
        "items": {"name": "Solo Item", "quantity": 1, "price": 5.00},
        "total": 5.00,
        "status": "shipped"
      }`;

      const result = parse(OrderSchema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.items).toHaveLength(1);
        expect(result.data.items[0]?.name).toBe("Solo Item");
        expect(result.flags.map((f) => f.flag)).toContain(Flag.SingleToArray);
      }
    });
  });

  describe("edge cases", () => {
    it("handles empty object", () => {
      const schema = z.object({
        name: z.string().optional(),
      });
      const result = parse(schema, "{}");
      expect(result.success).toBe(true);
    });

    it("handles empty array", () => {
      const schema = z.array(z.string());
      const result = parse(schema, "[]");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual([]);
      }
    });

    it("handles deeply nested markdown", () => {
      const schema = z.object({ value: z.number() });
      const input = `
        I'll return the data now:

        \`\`\`json
        {"value": "42"}
        \`\`\`

        That's a great number!
      `;
      const result = parse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.value).toBe(42);
      }
    });

    it("handles JSON with comments", () => {
      const schema = z.object({ x: z.number(), y: z.number() });
      const input = `{
        // X coordinate
        "x": 10,
        /* Y coordinate */
        "y": 20
      }`;
      const result = parse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ x: 10, y: 20 });
      }
    });
  });

  describe("error handling", () => {
    it("returns error for missing required field", () => {
      const schema = z.object({ required: z.string() });
      const result = parse(schema, "{}");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe("coercion_error");
        expect(result.error.path).toContain("required");
      }
    });

    it("returns coercion error when repaired JSON doesn't match schema", () => {
      // jsonrepair turns plain text into a string, which then fails coercion
      const schema = z.object({ x: z.number() });
      const result = parse(schema, "this is not json at all");
      expect(result.success).toBe(false);
      if (!result.success) {
        // The text gets repaired to a string, but string doesn't match object schema
        expect(result.error.type).toBe("coercion_error");
      }
    });

    it("returns json_parse_error for empty input", () => {
      const schema = z.object({ x: z.number() });
      const result = parse(schema, "");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe("json_parse_error");
      }
    });

    it("returns error path for nested failures", () => {
      const schema = z.object({
        outer: z.object({
          inner: z.number(),
        }),
      });
      const result = parse(schema, '{"outer": {"inner": "not a number"}}');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.path).toContain("outer");
        expect(result.error.path).toContain("inner");
      }
    });
  });

  describe("parseOrThrow", () => {
    const schema = z.object({ name: z.string() });

    it("returns value on success", () => {
      const result = parseOrThrow(schema, '{"name": "John"}');
      expect(result).toEqual({ name: "John" });
    });

    it("throws on failure", () => {
      expect(() => parseOrThrow(schema, "{}")).toThrow();
    });

    it("includes path in error message", () => {
      const nestedSchema = z.object({ user: z.object({ id: z.number() }) });
      expect(() => parseOrThrow(nestedSchema, '{"user": {}}')).toThrow(/user.*id/);
    });
  });

  describe("realistic LLM scenarios", () => {
    it("handles ChatGPT-style response with explanation", () => {
      const schema = z.object({
        answer: z.string(),
        confidence: z.number(),
      });

      const input = `Based on my analysis, here's the result:

\`\`\`json
{
  "answer": "The capital of France is Paris",
  "confidence": 0.95
}
\`\`\`

I hope this helps!`;

      const result = parse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.answer).toBe("The capital of France is Paris");
        expect(result.data.confidence).toBe(0.95);
      }
    });

    it("handles response with inline JSON", () => {
      const schema = z.object({
        items: z.array(z.string()),
      });

      const input = 'The extracted items are: {"items": ["apple", "banana", "cherry"]}';

      const result = parse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.items).toEqual(["apple", "banana", "cherry"]);
      }
    });

    it("handles sloppy LLM JSON", () => {
      const schema = z.object({
        name: z.string(),
        tags: z.array(z.string()),
        score: z.number(),
        verified: z.boolean(),
      });

      // Common LLM mistakes: trailing commas, unquoted keys, single quotes,
      // string numbers, string booleans
      const input = `{
        name: 'Test Item',
        tags: ['one', 'two', 'three',],
        score: "85",
        verified: "true",
      }`;

      const result = parse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({
          name: "Test Item",
          tags: ["one", "two", "three"],
          score: 85,
          verified: true,
        });
      }
    });
  });
});
