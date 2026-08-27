import { describe, it, expect } from "vitest";
import { z } from "zod";
import { coerce, Flag } from "../src/index.js";

describe("coerce", () => {
  describe("primitives", () => {
    describe("string", () => {
      const schema = z.string();

      it("passes through strings", () => {
        const result = coerce(schema, "hello");
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.value).toBe("hello");
          expect(result.flags).toHaveLength(0);
        }
      });

      it("coerces number to string", () => {
        const result = coerce(schema, 123);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.value).toBe("123");
          expect(result.flags.map((f) => f.flag)).toContain(Flag.NumberToString);
        }
      });

      it("coerces boolean to string", () => {
        const result = coerce(schema, true);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.value).toBe("true");
          expect(result.flags.map((f) => f.flag)).toContain(Flag.BoolToString);
        }
      });

      it("fails for null", () => {
        const result = coerce(schema, null);
        expect(result.success).toBe(false);
      });
    });

    describe("number", () => {
      const schema = z.number();

      it("passes through numbers", () => {
        const result = coerce(schema, 42);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.value).toBe(42);
          expect(result.flags).toHaveLength(0);
        }
      });

      it("coerces string to number", () => {
        const result = coerce(schema, "123.45");
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.value).toBe(123.45);
          expect(result.flags.map((f) => f.flag)).toContain(Flag.StringToNumber);
        }
      });

      it("handles negative numbers in strings", () => {
        const result = coerce(schema, "-42.5");
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.value).toBe(-42.5);
        }
      });

      it("fails for non-numeric strings", () => {
        const result = coerce(schema, "not a number");
        expect(result.success).toBe(false);
      });

      it("fails for NaN", () => {
        const result = coerce(schema, NaN);
        expect(result.success).toBe(false);
      });
    });

    describe("boolean", () => {
      const schema = z.boolean();

      it("passes through booleans", () => {
        expect(coerce(schema, true).success && coerce(schema, true).value).toBe(true);
        expect(coerce(schema, false).success && coerce(schema, false).value).toBe(false);
      });

      it("coerces 'true'/'false' strings", () => {
        const trueResult = coerce(schema, "true");
        expect(trueResult.success).toBe(true);
        if (trueResult.success) {
          expect(trueResult.value).toBe(true);
          expect(trueResult.flags.map((f) => f.flag)).toContain(Flag.StringToBool);
        }

        const falseResult = coerce(schema, "false");
        expect(falseResult.success).toBe(true);
        if (falseResult.success) {
          expect(falseResult.value).toBe(false);
        }
      });

      it("coerces 'yes'/'no' strings", () => {
        const yesResult = coerce(schema, "yes");
        expect(yesResult.success && yesResult.value).toBe(true);

        const noResult = coerce(schema, "no");
        expect(noResult.success && noResult.value).toBe(false);
      });

      it("coerces '1'/'0' strings", () => {
        expect(coerce(schema, "1").success && coerce(schema, "1").value).toBe(true);
        expect(coerce(schema, "0").success && coerce(schema, "0").value).toBe(false);
      });

      it("is case-insensitive", () => {
        expect(coerce(schema, "TRUE").success && coerce(schema, "TRUE").value).toBe(true);
        expect(coerce(schema, "FALSE").success && coerce(schema, "FALSE").value).toBe(false);
        expect(coerce(schema, "Yes").success && coerce(schema, "Yes").value).toBe(true);
      });

      it("coerces numbers 1/0", () => {
        expect(coerce(schema, 1).success && coerce(schema, 1).value).toBe(true);
        expect(coerce(schema, 0).success && coerce(schema, 0).value).toBe(false);
      });

      it("fails for other values", () => {
        expect(coerce(schema, "maybe").success).toBe(false);
        expect(coerce(schema, 42).success).toBe(false);
      });
    });
  });

  describe("arrays", () => {
    const schema = z.array(z.number());

    it("passes through arrays", () => {
      const result = coerce(schema, [1, 2, 3]);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toEqual([1, 2, 3]);
      }
    });

    it("coerces array elements", () => {
      const result = coerce(schema, ["1", "2", "3"]);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toEqual([1, 2, 3]);
        expect(result.flags.map((f) => f.flag)).toContain(Flag.StringToNumber);
      }
    });

    it("wraps single value in array", () => {
      const result = coerce(schema, 42);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toEqual([42]);
        expect(result.flags.map((f) => f.flag)).toContain(Flag.SingleToArray);
      }
    });

    it("handles empty arrays", () => {
      const result = coerce(schema, []);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toEqual([]);
      }
    });

    it("fails if element coercion fails", () => {
      const result = coerce(schema, [1, "not a number", 3]);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.path).toEqual([1]);
      }
    });
  });

  describe("objects", () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
    });

    it("passes through valid objects", () => {
      const result = coerce(schema, { name: "John", age: 25 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toEqual({ name: "John", age: 25 });
      }
    });

    it("coerces object properties", () => {
      const result = coerce(schema, { name: "John", age: "25" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toEqual({ name: "John", age: 25 });
        expect(result.flags.map((f) => f.flag)).toContain(Flag.StringToNumber);
      }
    });

    it("ignores extra keys with flag", () => {
      const result = coerce(schema, { name: "John", age: 25, extra: "ignored" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toEqual({ name: "John", age: 25 });
        expect(result.flags.map((f) => f.flag)).toContain(Flag.ExtraKeysIgnored);
      }
    });

    it("fails for missing required keys", () => {
      const result = coerce(schema, { name: "John" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.path).toContain("age");
      }
    });

    it("fails for non-objects", () => {
      const result = coerce(schema, "not an object");
      expect(result.success).toBe(false);
    });
  });

  describe("optional", () => {
    const schema = z.object({
      name: z.string(),
      age: z.number().optional(),
    });

    it("allows missing optional fields", () => {
      const result = coerce(schema, { name: "John" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toEqual({ name: "John" });
      }
    });

    it("accepts present optional fields", () => {
      const result = coerce(schema, { name: "John", age: 25 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toEqual({ name: "John", age: 25 });
      }
    });

    it("treats null as undefined for optional", () => {
      const result = coerce(z.string().optional(), null);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toBeUndefined();
        expect(result.flags.map((f) => f.flag)).toContain(Flag.NullToUndefined);
      }
    });
  });

  describe("nullable", () => {
    const schema = z.string().nullable();

    it("allows null", () => {
      const result = coerce(schema, null);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toBeNull();
      }
    });

    it("allows actual values", () => {
      const result = coerce(schema, "hello");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toBe("hello");
      }
    });
  });

  describe("default", () => {
    const schema = z.string().default("default value");

    it("uses default for undefined", () => {
      const result = coerce(schema, undefined);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toBe("default value");
        expect(result.flags.map((f) => f.flag)).toContain(Flag.DefaultUsed);
      }
    });

    it("uses default for null", () => {
      const result = coerce(schema, null);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toBe("default value");
      }
    });

    it("uses actual value when provided", () => {
      const result = coerce(schema, "actual");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toBe("actual");
      }
    });
  });

  describe("union", () => {
    it("accepts first matching type (string)", () => {
      const schema = z.union([z.string(), z.number()]);
      const result = coerce(schema, "hello");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toBe("hello");
      }
    });

    it("accepts number when number comes first", () => {
      const schema = z.union([z.number(), z.string()]);
      const result = coerce(schema, 42);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toBe(42);
      }
    });

    it("prefers an exact number even if a coercible string comes first", () => {
      const schema = z.union([z.string(), z.number()]);
      const result = coerce(schema, 42);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toBe(42);
      }
    });

    it("fails for non-matching types", () => {
      const schema = z.union([z.number(), z.boolean()]);
      const result = coerce(schema, { not: "valid" });
      expect(result.success).toBe(false);
    });
  });

  describe("enum", () => {
    const schema = z.enum(["red", "green", "blue"]);

    it("accepts exact matches", () => {
      const result = coerce(schema, "red");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toBe("red");
      }
    });

    it("handles case-insensitive matching", () => {
      const result = coerce(schema, "RED");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toBe("red");
        expect(result.flags.map((f) => f.flag)).toContain(Flag.EnumCaseInsensitive);
      }
    });

    it("handles mixed case", () => {
      const result = coerce(schema, "Green");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toBe("green");
      }
    });

    it("fails for invalid values", () => {
      const result = coerce(schema, "yellow");
      expect(result.success).toBe(false);
    });
  });

  describe("literal", () => {
    it("accepts exact string literal", () => {
      const schema = z.literal("hello");
      const result = coerce(schema, "hello");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toBe("hello");
      }
    });

    it("accepts exact number literal", () => {
      const schema = z.literal(42);
      const result = coerce(schema, 42);
      expect(result.success).toBe(true);
    });

    it("coerces string to number literal", () => {
      const schema = z.literal(42);
      const result = coerce(schema, "42");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toBe(42);
      }
    });

    it("fails for non-matching values", () => {
      const schema = z.literal("hello");
      const result = coerce(schema, "world");
      expect(result.success).toBe(false);
    });
  });

  describe("nested structures", () => {
    const schema = z.object({
      user: z.object({
        name: z.string(),
        roles: z.array(z.string()),
      }),
      active: z.boolean(),
    });

    it("handles deeply nested coercion", () => {
      const result = coerce(schema, {
        user: {
          name: 123, // should coerce to "123"
          roles: "admin", // should wrap in array
        },
        active: "yes", // should coerce to true
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toEqual({
          user: {
            name: "123",
            roles: ["admin"],
          },
          active: true,
        });
        expect(result.flags.map((f) => f.flag)).toContain(Flag.NumberToString);
        expect(result.flags.map((f) => f.flag)).toContain(Flag.SingleToArray);
        expect(result.flags.map((f) => f.flag)).toContain(Flag.StringToBool);
      }
    });
  });

  describe("tuple", () => {
    const schema = z.tuple([z.string(), z.number(), z.boolean()]);

    it("passes through valid tuple", () => {
      const result = coerce(schema, ["hello", 42, true]);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toEqual(["hello", 42, true]);
      }
    });

    it("coerces tuple elements", () => {
      const result = coerce(schema, [123, "42", "yes"]);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toEqual(["123", 42, true]);
      }
    });

    it("fails for wrong length", () => {
      const result = coerce(schema, ["hello", 42]);
      expect(result.success).toBe(false);
    });
  });

  describe("record", () => {
    const schema = z.record(z.string(), z.number());

    it("passes through valid record", () => {
      const result = coerce(schema, { a: 1, b: 2 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toEqual({ a: 1, b: 2 });
      }
    });

    it("coerces record values", () => {
      const result = coerce(schema, { a: "1", b: "2" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toEqual({ a: 1, b: 2 });
      }
    });
  });
});
