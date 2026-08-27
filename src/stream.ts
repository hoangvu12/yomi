import type { z } from "zod";
import { coercePartialToSchema, coerceToSchema } from "./coerce.js";
import { JsonParseError, parseJson } from "./parse.js";
import { createContext, type CoerceError } from "./types.js";
import type { FlagWithContext } from "./flags.js";
import type { ParseError, ParseResult } from "./index.js";
import type { Diagnostic } from "./diagnostics.js";
import { diagnosticsFromFlags, inspectValue, resolveLimits, ResourceLimitError, type ParserOptions } from "./diagnostics.js";
import { inspectCompletion, type CompletionNode } from "./syntax.js";
import { runAdvisoryChecks } from "./advisory.js";
import { applyStateWrappers, createSemanticProjectionState, projectStreamingValue, validateStreamPolicies } from "./semantic.js";

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
  /** Monotonically increasing when the semantic projection changes. */
  revision: number;
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
  options?: ParserOptions<z.infer<S>>
): StreamParser<z.infer<S>> {
  const limits = resolveLimits(options);
  validateStreamPolicies(schema, options);
  let buffer = "";
  let receivedBytes = 0;
  const decoder = new TextDecoder();
  const semanticState = createSemanticProjectionState();
  let revision = 0;
  let previousSemantic: string | undefined;
  let previousSnapshot: StreamSnapshot<z.infer<S>> | undefined;

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
        const visible = projectStreamingValue(schema, parsed.value, completion, options, semanticState);
        const ctx = createContext(limits);
        ctx.unionTieBreaker = options?.unionTieBreaker;
        ctx.flags.push(...parsed.flags);
        const result = coercePartialToSchema(schema, visible, ctx);
        if (!result.success) return { success: false, pending: true, completion, error: result.error };
        const data = applyStateWrappers(schema, result.value, completion, options) as DeepPartial<z.infer<S>>;
        const semantic = stableSemanticString([data, completion]);
        if (semantic === previousSemantic && previousSnapshot) return { success: true, snapshot: previousSnapshot };
        const snapshot = deepFreeze({
            data,
            flags: result.flags,
            diagnostics: [...diagnosticsFromFlags(result.flags, limits), ...ctx.diagnostics].slice(0, limits.maxDiagnostics),
            completion,
            done: false as const,
            text: buffer,
            revision: ++revision,
          });
        previousSemantic = semantic;
        previousSnapshot = snapshot;
        return {
          success: true,
          snapshot,
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
        ctx.unionTieBreaker = options?.unionTieBreaker;
        ctx.flags.push(...parsed.flags);
        const result = coerceToSchema(schema, parsed.value, ctx);
        if (result.success) {
          const validated = schema.safeParse(result.value);
          if (validated.success) {
            const advisory = runAdvisoryChecks(validated.data, options?.advisoryChecks, limits);
            const diagnostics = [...diagnosticsFromFlags(result.flags, limits), ...ctx.diagnostics, ...advisory.checks.flatMap((check) => check.diagnostic ? [check.diagnostic] : [])].slice(0, limits.maxDiagnostics);
            return { success: true, data: validated.data, flags: result.flags, diagnostics, advisory };
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
            type: result.error.type === "ambiguity_error" ? "ambiguity_error" : "coercion_error",
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
  options?: ParserOptions<z.infer<S>>
): AsyncGenerator<StreamSnapshot<z.infer<S>>, ParseResult<z.infer<S>>, void> {
  const parser = createStreamParser(schema, options);
  let revision = 0;
  for await (const chunk of chunks) {
    const result = parser.push(chunk);
    if (result.success && result.snapshot.revision !== revision) {
      revision = result.snapshot.revision;
      yield result.snapshot;
    }
  }
  return parser.finish();
}

function stableSemanticString(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item instanceof Date ? item.toISOString() : item);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
