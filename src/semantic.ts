import * as z from "zod";
import type { ParserOptions } from "./diagnostics.js";
import type { CompletionNode } from "./syntax.js";
import { inspectZod, structurallyAccepts, unwrapZod } from "./zod-compat.js";

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

/** Fail early for policy paths that cannot address the supplied schema. */
export function validateStreamPolicies(schema: z.ZodTypeAny, options?: ParserOptions): void {
  for (const [path, policy] of Object.entries(options?.fields ?? {})) {
    if (!path || path.split(".").some((part) => part.length === 0)) throw new TypeError(`Invalid stream policy path "${path}"`);
    const parts = path.split(".");
    const targets = resolvePolicyPath(schema, parts);
    if (targets.length === 0) throw new TypeError(`Stream policy path "${path}" does not exist in the schema`);
    if (policy.requiredForParent && targets.some((target) => inspectZod(unwrapZod(target.parent)).kind !== "object")) {
      throw new TypeError(`Stream policy "${path}" with requiredForParent must target an object child`);
    }
  }
}

export type StreamStateName = "pending" | "incomplete" | "complete";

export interface StreamState<T> {
  readonly value: T | undefined;
  readonly state: StreamStateName;
}

/**
 * Add configured state wrappers after schema coercion. Keeping this separate from
 * projection means wrappers can never be mistaken for input values by Zod.
 */
export function applyStateWrappers(
  schema: z.ZodTypeAny,
  projected: unknown,
  completion: CompletionNode,
  options?: ParserOptions
): unknown {
  if (!Object.values(options?.fields ?? {}).some((policy) => policy.withState)) return projected;
  return wrap(schema, projected, completion, [], options);
}

function wrap(schema: z.ZodTypeAny, value: unknown, node: CompletionNode | undefined, path: (string | number)[], options?: ParserOptions): unknown {
  const current = unwrapZod(schema);
  const inspected = inspectZod(current);
  let nested = value;
  if (inspected.kind === "object") {
    const input = isRecord(value) ? value : {};
    const output: Record<string, unknown> = { ...input };
    const children = node?.children as Readonly<Record<string, CompletionNode>> | undefined;
    for (const [name, childSchema] of Object.entries(inspected.shape)) {
      const childPath = [...path, name];
      const configuredHere = options?.fields?.[policyPath(childPath)]?.withState === true;
      if (!(name in input) && !configuredHere) continue;
      output[name] = wrap(childSchema, input[name], children?.[name], childPath, options);
    }
    nested = output;
  } else if (inspected.kind === "array" && Array.isArray(value)) {
    const children = node?.children as readonly CompletionNode[] | undefined;
    const itemPolicy = options?.fields?.[policyPath([...path, 0])];
    if (itemPolicy?.withState && children && children.length > value.length) {
      let visibleIndex = 0;
      nested = children.map((child, index) => {
        const guarded = itemPolicy.reveal === "complete" || itemPolicy.requiredForParent || (options?.atomic !== "none" && isAtomic(inspected.element));
        const visible = !guarded || child.state === "complete";
        const item = visible ? value[visibleIndex++] : undefined;
        return wrap(inspected.element, item, child, [...path, index], options);
      });
    } else {
      nested = value.map((item, index) => wrap(inspected.element, item, children?.[index], [...path, index], options));
    }
  } else if (inspected.kind === "tuple" && Array.isArray(value)) {
    const children = node?.children as readonly CompletionNode[] | undefined;
    const items = inspected.items;
    nested = value.map((item, index) => wrap(items[index] ?? z.unknown(), item, children?.[index], [...path, index], options));
  } else if (inspected.kind === "record" && isRecord(value)) {
    const children = node?.children as Readonly<Record<string, CompletionNode>> | undefined;
    nested = Object.fromEntries(Object.entries(value).map(([name, item]) => [name, wrap(inspected.value, item, children?.[name], [...path, name], options)]));
  }
  if (!options?.fields?.[policyPath(path)]?.withState) return nested;
  return { value: nested, state: node?.state ?? "pending" } satisfies StreamState<unknown>;
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
  const fieldPolicy = options?.fields?.[policyPath(path)];
  const revealComplete = fieldPolicy?.reveal === "complete" || fieldPolicy?.requiredForParent === true;
  const atomic = options?.atomic !== "none" && (discriminator || isAtomic(schema));
  const guarded = revealComplete || atomic;

  if (guarded && node?.state !== "complete") {
    return state.completed.has(key) ? state.completed.get(key) : HIDDEN;
  }

  const unwrapped = unwrapZod(schema);
  const inspected = inspectZod(unwrapped);
  let result: unknown = value;

  if (inspected.kind === "object" && isRecord(value)) {
    const output: Record<string, unknown> = {};
    const shape = inspected.shape;
    const children = node?.children as Readonly<Record<string, CompletionNode>> | undefined;
    for (const [name, childSchema] of Object.entries(shape)) {
      if (!(name in value)) continue;
      const child = project(childSchema, value[name], children?.[name], [...path, name], options, state, false);
      if (child !== HIDDEN) output[name] = child;
    }
    if (!parentGateSatisfied(shape, output, path, options)) return HIDDEN;
    result = output;
  } else if (inspected.kind === "array" && Array.isArray(value)) {
    const children = node?.children as readonly CompletionNode[] | undefined;
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index++) {
      const child = project(inspected.element, value[index], children?.[index], [...path, index], options, state, false);
      // Filtering avoids holes and misleading indexes for incomplete atomic elements.
      if (child !== HIDDEN) output.push(child);
    }
    result = output;
  } else if (inspected.kind === "tuple" && Array.isArray(value)) {
    const items = inspected.items;
    const children = node?.children as readonly CompletionNode[] | undefined;
    const output: unknown[] = [];
    for (let index = 0; index < Math.min(value.length, items.length); index++) {
      const child = project(items[index]!, value[index], children?.[index], [...path, index], options, state, false);
      if (child !== HIDDEN) output.push(child);
    }
    result = output;
  } else if (inspected.kind === "record" && isRecord(value)) {
    const children = node?.children as Readonly<Record<string, CompletionNode>> | undefined;
    const output: Record<string, unknown> = {};
    for (const [name, item] of Object.entries(value)) {
      const child = project(inspected.value, item, children?.[name], [...path, name], options, state, false);
      if (child !== HIDDEN) output[name] = child;
    }
    result = output;
  } else if (inspected.kind === "union" && inspected.discriminator) {
    const discriminatorKey = inspected.discriminator;
    const option = selectObjectOption(inspected.options, value, discriminatorKey);
    // A discriminated union is not semantically visible until one exact, complete
    // discriminator selects its variant. This prevents premature variant guesses.
    if (!option) return HIDDEN;
    result = projectObjectOption(option, value, node, path, options, state, discriminatorKey);
  } else if (inspected.kind === "union") {
    const option = inspected.options.find((candidate) => structurallyAccepts(candidate, value));
    if (option) result = project(option, value, node, path, options, state, false);
  }

  if (guarded && node?.state === "complete") state.completed.set(key, result);
  return result;
}

function projectObjectOption(schema: z.ZodTypeAny, value: unknown, node: CompletionNode | undefined, path: (string | number)[], options: ParserOptions | undefined, state: SemanticProjectionState, discriminatorKey: string): unknown | Hidden {
  const object = unwrap(schema);
  const inspected = inspectZod(object);
  if (inspected.kind !== "object" || !isRecord(value)) return value;
  const output: Record<string, unknown> = {};
  const children = node?.children as Readonly<Record<string, CompletionNode>> | undefined;
  for (const [name, childSchema] of Object.entries(inspected.shape)) {
    if (!(name in value)) continue;
    const child = project(childSchema, value[name], children?.[name], [...path, name], options, state, name === discriminatorKey);
    if (child !== HIDDEN) output[name] = child;
  }
  if (!parentGateSatisfied(inspected.shape, output, path, options)) return HIDDEN;
  return output;
}

function parentGateSatisfied(shape: Record<string, z.ZodTypeAny>, output: Record<string, unknown>, path: (string | number)[], options: ParserOptions | undefined): boolean {
  for (const [name, childSchema] of Object.entries(shape)) {
    if (!options?.fields?.[policyPath([...path, name])]?.requiredForParent) continue;
    if (!(name in output) || !semanticallyPresent(output[name]) || !structurallyAccepts(childSchema, output[name])) return false;
  }
  return true;
}

function semanticallyPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.some(semanticallyPresent);
  if (isRecord(value)) return Object.values(value).some(semanticallyPresent);
  return true;
}

function resolvePolicyPath(schema: z.ZodTypeAny, parts: string[]): Array<{ target: z.ZodTypeAny; parent: z.ZodTypeAny }> {
  const current = unwrapZod(schema);
  const inspected = inspectZod(current);
  if (inspected.kind === "union") {
    return inspected.options.flatMap((option) => resolvePolicyPath(option, parts));
  }
  const [head, ...tail] = parts;
  if (head === undefined) return [];
  let children: z.ZodTypeAny[] = [];
  if (inspected.kind === "object" && head !== "*") {
    const child = inspected.shape[head];
    if (child) children = [child];
  } else if (inspected.kind === "array" && head === "*") children = [inspected.element];
  else if (inspected.kind === "tuple" && head === "*") children = [...inspected.items];
  else if (inspected.kind === "record" && head === "*") children = [inspected.value];
  if (tail.length === 0) return children.map((target) => ({ target, parent: current }));
  return children.flatMap((child) => resolvePolicyPath(child, tail));
}

function selectObjectOption(options: z.ZodTypeAny[], value: unknown, discriminatorKey: string): z.ZodTypeAny | undefined {
  if (!isRecord(value) || !(discriminatorKey in value)) return undefined;
  return options.find((option) => {
    const object = unwrapZod(option);
    const inspected = inspectZod(object);
    if (inspected.kind !== "object") return false;
    const discriminator = inspected.shape[discriminatorKey];
    return discriminator ? structurallyAccepts(discriminator, value[discriminatorKey]) : false;
  });
}

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  return unwrapZod(schema);
}

function isAtomic(schema: z.ZodTypeAny): boolean {
  const inspected = inspectZod(unwrapZod(schema));
  if (inspected.kind === "union") return inspected.options.every(isAtomic);
  return ["number", "bigint", "boolean", "null", "literal", "enum", "date"].includes(inspected.kind);
}

function policyPath(path: (string | number)[]): string {
  return path.map((part) => typeof part === "number" ? "*" : part).join(".");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
