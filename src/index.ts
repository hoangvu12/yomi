import { z } from "zod";
import { parseJson, JsonParseError } from "./parse.js";
import { coerceToSchema } from "./coerce.js";
import { type CoerceResult, createContext } from "./types.js";
import { Flag, type FlagWithContext } from "./flags.js";

// Re-export types and utilities
export { Flag, type FlagWithContext } from "./flags.js";
export { type CoerceResult, type CoerceSuccess, type CoerceFailure, type CoerceError } from "./types.js";
export { JsonParseError } from "./parse.js";

/**
 * Parse result from the main parse function.
 */
export type ParseResult<T> =
  | { success: true; data: T; flags: FlagWithContext[] }
  | { success: false; error: ParseError };

/**
 * Error from parsing.
 */
export interface ParseError {
  type: "json_parse_error" | "coercion_error";
  message: string;
  path?: (string | number)[];
  expected?: string;
  received?: string;
}

/**
 * Parse a string into a typed value using a Zod schema.
 *
 * This is the main entry point for the Schema-Aligned Parser.
 * It combines flexible JSON parsing with schema-aligned coercion.
 *
 * @example
 * ```ts
 * const UserSchema = z.object({
 *   name: z.string(),
 *   age: z.number(),
 * });
 *
 * // Handles malformed JSON
 * const result = parse(UserSchema, `{name: 'John', age: "25",}`);
 * // → { success: true, data: { name: "John", age: 25 }, flags: [...] }
 * ```
 */
export function parse<T extends z.ZodTypeAny>(
  schema: T,
  input: string
): ParseResult<z.infer<T>> {
  // Phase 1: Flexible JSON parsing
  let parsed: unknown;
  let parseFlags: FlagWithContext[] = [];

  try {
    const parseResult = parseJson(input);
    parsed = parseResult.value;
    parseFlags = parseResult.flags;
  } catch (e) {
    if (e instanceof JsonParseError) {
      return {
        success: false,
        error: {
          type: "json_parse_error",
          message: e.message,
        },
      };
    }
    throw e;
  }

  // Phase 2: Schema-aligned coercion
  const ctx = createContext();
  ctx.flags.push(...parseFlags);

  const result = coerceToSchema(schema, parsed, ctx);

  if (result.success) {
    return {
      success: true,
      data: result.value,
      flags: result.flags,
    };
  }

  return {
    success: false,
    error: {
      type: "coercion_error",
      message: result.error.message,
      path: result.error.path,
      expected: result.error.expected,
      received: result.error.received,
    },
  };
}

/**
 * Parse a string into a typed value, throwing on error.
 *
 * @throws {Error} If parsing or coercion fails
 */
export function parseOrThrow<T extends z.ZodTypeAny>(
  schema: T,
  input: string
): z.infer<T> {
  const result = parse(schema, input);

  if (!result.success) {
    const error = result.error;
    const path = error.path?.join(".") ?? "";
    throw new Error(
      `Parse error${path ? ` at ${path}` : ""}: ${error.message}`
    );
  }

  return result.data;
}

/**
 * Coerce an already-parsed value to match a schema.
 *
 * Use this when you already have a parsed JavaScript value
 * and just need schema-aligned coercion.
 *
 * @example
 * ```ts
 * const data = JSON.parse(rawJson);
 * const result = coerce(UserSchema, data);
 * ```
 */
export function coerce<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown
): CoerceResult<z.infer<T>> {
  return coerceToSchema(schema, value);
}

/**
 * Coerce a value to match a schema, throwing on error.
 *
 * @throws {Error} If coercion fails
 */
export function coerceOrThrow<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown
): z.infer<T> {
  const result = coerce(schema, value);

  if (!result.success) {
    const path = result.error.path.join(".") || "<root>";
    throw new Error(`Coercion error at ${path}: ${result.error.message}`);
  }

  return result.value;
}

/**
 * Check if a parse result has any coercion flags.
 * Useful for detecting when values were transformed.
 */
export function hasFlags(result: ParseResult<unknown>): boolean {
  return result.success && result.flags.length > 0;
}

/**
 * Get the flag types from a parse result.
 */
export function getFlags(result: ParseResult<unknown>): Flag[] {
  if (!result.success) return [];
  return result.flags.map((f) => f.flag);
}
