import type { z } from "zod";
import { coercePartialToSchema, coerceToSchema } from "./coerce.js";
import { JsonParseError, parseJson } from "./parse.js";
import { createContext, type CoerceError } from "./types.js";
import type { FlagWithContext } from "./flags.js";
import type { ParseError, ParseResult } from "./index.js";
import type { Diagnostic } from "./diagnostics.js";
import { diagnosticsFromFlags, inspectValue, resolveLimits, ResourceLimitError, type ParserOptions } from "./diagnostics.js";
import { inspectCompletion, type CompletionNode } from "./syntax.js";

export type DeepPartial<T> =
  T extends readonly (infer U)[] ? DeepPartial<U>[] :
  T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

export interface StreamSnapshot<T> {
  data: DeepPartial<T>;
  flags: FlagWithContext[];
  diagnostics: Diagnostic[];
  /** Lexical completion based only on delimiters emitted by the producer. */
  completion: CompletionNode;
  /** Always false for push snapshots; only finish() can establish completeness. */
  done: false;
  text: string;
}

export type StreamPushResult<T> =
  | { success: true; snapshot: StreamSnapshot<T> }
  | { success: false; pending: true; completion: CompletionNode; error?: CoerceError }
  | { success: false; pending: false; error: ParseError };

export interface StreamParser<T> {
  push(chunk: string | Uint8Array): StreamPushResult<T>;
  finish(): ParseResult<T>;
  readonly text: string;
}

/**
 * Incrementally interprets cumulative LLM text as schema-aligned snapshots.
 * A push may be pending when no meaningful root value is repairable yet.
 * finish() always runs Yomi's strict, final parser and is the validation boundary.
 */
export function createStreamParser<S extends z.ZodTypeAny>(
  schema: S,
  options?: ParserOptions
): StreamParser<z.infer<S>> {
  const limits = resolveLimits(options);
  let buffer = "";
  let receivedBytes = 0;
  const decoder = new TextDecoder();

  return {
    get text() { return buffer; },
    push(chunk) {
      receivedBytes += typeof chunk === "string" ? new TextEncoder().encode(chunk).byteLength : chunk.byteLength;
      if (receivedBytes > limits.maxInputBytes) {
        const error = new ResourceLimitError("maxInputBytes", limits.maxInputBytes);
        return { success: false, pending: false, error: { type: "resource_limit_error", message: error.message, budget: error.budget, limit: error.limit } };
      }
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      const completion = inspectCompletion(buffer);
      try {
        const parsed = parseJson(buffer, limits);
        inspectValue(parsed.value, limits);
        const ctx = createContext(limits);
        ctx.flags.push(...parsed.flags);
        const result = coercePartialToSchema(schema, parsed.value, ctx);
        if (!result.success) return { success: false, pending: true, completion, error: result.error };
        return {
          success: true,
          snapshot: {
            data: result.value as DeepPartial<z.infer<S>>,
            flags: result.flags,
            diagnostics: diagnosticsFromFlags(result.flags, limits),
            completion,
            done: false,
            text: buffer,
          },
        };
      } catch (error) {
        if (error instanceof ResourceLimitError) {
          return { success: false, pending: false, error: { type: "resource_limit_error", message: error.message, budget: error.budget, limit: error.limit } };
        }
        return { success: false, pending: true, completion };
      }
    },
    finish() {
      buffer += decoder.decode();
      try {
        const parsed = parseJson(buffer, limits);
        inspectValue(parsed.value, limits);
        const ctx = createContext(limits);
        ctx.flags.push(...parsed.flags);
        const result = coerceToSchema(schema, parsed.value, ctx);
        if (result.success) {
          const validated = schema.safeParse(result.value);
          if (validated.success) {
            return { success: true, data: validated.data, flags: result.flags, diagnostics: diagnosticsFromFlags(result.flags, limits) };
          }
          const issue = validated.error.issues[0];
          return {
            success: false,
            error: {
              type: "zod_validation_error",
              message: issue?.message ?? "Zod validation failed",
              path: issue?.path.map(String),
              expected: issue?.code,
              received: typeof result.value,
            },
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
      } catch (error) {
        if (error instanceof ResourceLimitError) return { success: false, error: { type: "resource_limit_error", message: error.message, budget: error.budget, limit: error.limit } };
        if (!(error instanceof JsonParseError)) throw error;
        return {
          success: false,
          error: { type: "json_parse_error", message: error.message },
        };
      }
    },
  };
}

/** Consume any async stream of text/bytes and yield each parseable snapshot. */
export async function* parseStream<S extends z.ZodTypeAny>(
  schema: S,
  chunks: AsyncIterable<string | Uint8Array>,
  options?: ParserOptions
): AsyncGenerator<StreamSnapshot<z.infer<S>>, ParseResult<z.infer<S>>, void> {
  const parser = createStreamParser(schema, options);
  for await (const chunk of chunks) {
    const result = parser.push(chunk);
    if (result.success) yield result.snapshot;
  }
  return parser.finish();
}
