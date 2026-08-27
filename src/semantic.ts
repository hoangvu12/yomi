import * as z from "zod";
import type { ParserOptions } from "./diagnostics.js";
import type { CompletionNode } from "./syntax.js";

const HIDDEN = Symbol("hidden streaming value");
type Hidden = typeof HIDDEN;

/** State retained for one stream attempt so complete atomic values cannot regress. */
export interface SemanticProjectionState {
  readonly completed: Map<string, unknown>;
}

export function createSemanticProjectionState(): SemanticProjectionState {
  return { completed: new Map() };
}

/** Apply schema semantics to a repairable value without changing final parsing. */
export function projectStreamingValue(
  schema: z.ZodTypeAny,
  value: unknown,
  completion: CompletionNode,
  options: ParserOptions | undefined,
  state: SemanticProjectionState
): unknown {
  const projected = project(schema, value, completion, [], options, state, false);
  return projected === HIDDEN ? undefined : projected;
}

function project(
  schema: z.ZodTypeAny,
  value: unknown,
  node: CompletionNode | undefined,
  path: (string | number)[],
  options: ParserOptions | undefined,
  state: SemanticProjectionState,
  discriminator: boolean
): unknown | Hidden {
  const key = path.map(String).join(".");
  const revealComplete = options?.fields?.[policyPath(path)]?.reveal === "complete";
  const atomic = options?.atomic !== "none" && (discriminator || isAtomic(schema));
  const guarded = revealComplete || atomic;

  if (guarded && node?.state !== "complete") {
    return state.completed.has(key) ? state.completed.get(key) : HIDDEN;
  }

  const unwrapped = unwrap(schema);
  let result: unknown = value;

  if (unwrapped instanceof z.ZodObject && isRecord(value)) {
    const output: Record<string, unknown> = {};
    const shape = unwrapped.shape as Record<string, z.ZodTypeAny>;
    const children = node?.children as Readonly<Record<string, CompletionNode>> | undefined;
    for (const [name, childSchema] of Object.entries(shape)) {
      if (!(name in value)) continue;
      const child = project(childSchema, value[name], children?.[name], [...path, name], options, state, false);
      if (child !== HIDDEN) output[name] = child;
    }
    result = output;
  } else if (unwrapped instanceof z.ZodArray && Array.isArray(value)) {
    const children = node?.children as readonly CompletionNode[] | undefined;
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index++) {
      const child = project(unwrapped.element as z.ZodTypeAny, value[index], children?.[index], [...path, index], options, state, false);
      // Filtering avoids holes and misleading indexes for incomplete atomic elements.
      if (child !== HIDDEN) output.push(child);
    }
    result = output;
  } else if (unwrapped instanceof z.ZodTuple && Array.isArray(value)) {
    const items = unwrapped.def.items as z.ZodTypeAny[];
    const children = node?.children as readonly CompletionNode[] | undefined;
    const output: unknown[] = [];
    for (let index = 0; index < Math.min(value.length, items.length); index++) {
      const child = project(items[index]!, value[index], children?.[index], [...path, index], options, state, false);
      if (child !== HIDDEN) output.push(child);
    }
    result = output;
  } else if (unwrapped instanceof z.ZodRecord && isRecord(value)) {
    const children = node?.children as Readonly<Record<string, CompletionNode>> | undefined;
    const output: Record<string, unknown> = {};
    for (const [name, item] of Object.entries(value)) {
      const child = project(unwrapped.valueType as z.ZodTypeAny, item, children?.[name], [...path, name], options, state, false);
      if (child !== HIDDEN) output[name] = child;
    }
    result = output;
  } else if (unwrapped instanceof z.ZodDiscriminatedUnion) {
    const discriminatorKey = (unwrapped.def as unknown as { discriminator: string }).discriminator;
    const option = selectObjectOption(unwrapped.options as z.ZodTypeAny[], value, discriminatorKey);
    if (option) result = projectObjectOption(option, value, node, path, options, state, discriminatorKey);
  } else if (unwrapped instanceof z.ZodUnion) {
    const option = (unwrapped.options as z.ZodTypeAny[]).find((candidate) => candidate.safeParse(value).success);
    if (option) result = project(option, value, node, path, options, state, false);
  }

  if (guarded && node?.state === "complete") state.completed.set(key, result);
  return result;
}

function projectObjectOption(schema: z.ZodTypeAny, value: unknown, node: CompletionNode | undefined, path: (string | number)[], options: ParserOptions | undefined, state: SemanticProjectionState, discriminatorKey: string): unknown {
  const object = unwrap(schema);
  if (!(object instanceof z.ZodObject) || !isRecord(value)) return value;
  const output: Record<string, unknown> = {};
  const children = node?.children as Readonly<Record<string, CompletionNode>> | undefined;
  for (const [name, childSchema] of Object.entries(object.shape as Record<string, z.ZodTypeAny>)) {
    if (!(name in value)) continue;
    const child = project(childSchema, value[name], children?.[name], [...path, name], options, state, name === discriminatorKey);
    if (child !== HIDDEN) output[name] = child;
  }
  return output;
}

function selectObjectOption(options: z.ZodTypeAny[], value: unknown, discriminatorKey: string): z.ZodTypeAny | undefined {
  if (!isRecord(value) || !(discriminatorKey in value)) return undefined;
  return options.find((option) => {
    const object = unwrap(option);
    if (!(object instanceof z.ZodObject)) return false;
    const discriminator = (object.shape as Record<string, z.ZodTypeAny>)[discriminatorKey];
    return discriminator?.safeParse(value[discriminatorKey]).success;
  });
}

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  while (current instanceof z.ZodOptional || current instanceof z.ZodNullable || current instanceof z.ZodDefault || current instanceof z.ZodReadonly || current instanceof z.ZodCatch) {
    current = current.unwrap() as z.ZodTypeAny;
  }
  if (current instanceof z.ZodPipe) return current.in as z.ZodTypeAny;
  return current;
}

function isAtomic(schema: z.ZodTypeAny): boolean {
  const current = unwrap(schema);
  if (current instanceof z.ZodUnion) {
    return (current.options as z.ZodTypeAny[]).every(isAtomic);
  }
  return current instanceof z.ZodNumber || current instanceof z.ZodBigInt ||
    current instanceof z.ZodBoolean || current instanceof z.ZodNull ||
    current instanceof z.ZodLiteral || current instanceof z.ZodEnum ||
    current instanceof z.ZodDate;
}

function policyPath(path: (string | number)[]): string {
  return path.map((part) => typeof part === "number" ? "*" : part).join(".");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
