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

/** Fail early for policy paths that cannot address the supplied schema. */
export function validateStreamPolicies(schema: z.ZodTypeAny, options?: ParserOptions): void {
  for (const [path, policy] of Object.entries(options?.fields ?? {})) {
    if (!path || path.split(".").some((part) => part.length === 0)) throw new TypeError(`Invalid stream policy path "${path}"`);
    const parts = path.split(".");
    const targets = resolvePolicyPath(schema, parts);
    if (targets.length === 0) throw new TypeError(`Stream policy path "${path}" does not exist in the schema`);
    if (policy.requiredForParent && targets.some((target) => !(unwrap(target.parent) instanceof z.ZodObject))) {
      throw new TypeError(`Stream policy "${path}" with requiredForParent must target an object child`);
    }
  }
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
    if (!parentGateSatisfied(shape, output, path, options)) return HIDDEN;
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
    // A discriminated union is not semantically visible until one exact, complete
    // discriminator selects its variant. This prevents premature variant guesses.
    if (!option) return HIDDEN;
    result = projectObjectOption(option, value, node, path, options, state, discriminatorKey);
  } else if (unwrapped instanceof z.ZodUnion) {
    const option = (unwrapped.options as z.ZodTypeAny[]).find((candidate) => candidate.safeParse(value).success);
    if (option) result = project(option, value, node, path, options, state, false);
  }

  if (guarded && node?.state === "complete") state.completed.set(key, result);
  return result;
}

function projectObjectOption(schema: z.ZodTypeAny, value: unknown, node: CompletionNode | undefined, path: (string | number)[], options: ParserOptions | undefined, state: SemanticProjectionState, discriminatorKey: string): unknown | Hidden {
  const object = unwrap(schema);
  if (!(object instanceof z.ZodObject) || !isRecord(value)) return value;
  const output: Record<string, unknown> = {};
  const children = node?.children as Readonly<Record<string, CompletionNode>> | undefined;
  for (const [name, childSchema] of Object.entries(object.shape as Record<string, z.ZodTypeAny>)) {
    if (!(name in value)) continue;
    const child = project(childSchema, value[name], children?.[name], [...path, name], options, state, name === discriminatorKey);
    if (child !== HIDDEN) output[name] = child;
  }
  if (!parentGateSatisfied(object.shape as Record<string, z.ZodTypeAny>, output, path, options)) return HIDDEN;
  return output;
}

function parentGateSatisfied(shape: Record<string, z.ZodTypeAny>, output: Record<string, unknown>, path: (string | number)[], options: ParserOptions | undefined): boolean {
  for (const [name, childSchema] of Object.entries(shape)) {
    if (!options?.fields?.[policyPath([...path, name])]?.requiredForParent) continue;
    if (!(name in output) || !semanticallyPresent(output[name]) || !childSchema.safeParse(output[name]).success) return false;
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
  const current = unwrap(schema);
  if (current instanceof z.ZodUnion) {
    return (current.options as z.ZodTypeAny[]).flatMap((option) => resolvePolicyPath(option, parts));
  }
  const [head, ...tail] = parts;
  if (head === undefined) return [];
  let children: z.ZodTypeAny[] = [];
  if (current instanceof z.ZodObject && head !== "*") {
    const child = (current.shape as Record<string, z.ZodTypeAny>)[head];
    if (child) children = [child];
  } else if (current instanceof z.ZodArray && head === "*") children = [current.element as z.ZodTypeAny];
  else if (current instanceof z.ZodTuple && head === "*") children = [...(current.def.items as z.ZodTypeAny[])];
  else if (current instanceof z.ZodRecord && head === "*") children = [current.valueType as z.ZodTypeAny];
  if (tail.length === 0) return children.map((target) => ({ target, parent: current }));
  return children.flatMap((child) => resolvePolicyPath(child, tail));
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
