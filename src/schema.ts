import type { z } from "zod";
import type { Diagnostic } from "./diagnostics.js";
import { inspectZod, zodDescription } from "./zod-compat.js";
import { getYomiMetadata } from "./metadata.js";
import type { ParserOptions } from "./diagnostics.js";
import { parserContractPolicies } from "./diagnostics.js";

/**
 * Bumped whenever the rendered text changes shape for schemas that did not themselves change.
 *
 * It is hashed into every fingerprint, so a stored fingerprint from an earlier version compares
 * unequal rather than silently vouching for text the renderer no longer produces. `v2` dropped the
 * `Return only JSON matching ...` sentence that used to wrap `renderFormat`'s output.
 */
export const SCHEMA_CONTRACT_VERSION = "yomi-schema-v2";

export type CompiledNode =
  | { id: string; kind: "string" | "number" | "bigint" | "boolean" | "null" | "undefined" | "unknown" | "never" | "date"; description?: string }
  | { id: string; kind: "literal" | "enum"; values: unknown[]; aliases?: Readonly<Record<string, readonly string[]>>; valueDescriptions?: Readonly<Record<string, string>>; name?: string; description?: string }
  | { id: string; kind: "array"; element: string; description?: string }
  | { id: string; kind: "tuple"; items: string[]; rest?: string; description?: string }
  | { id: string; kind: "object"; fields: Record<string, { node: string; optional: boolean; aliases?: readonly string[] }>; description?: string }
  | { id: string; kind: "record"; value: string; description?: string }
  | { id: string; kind: "union"; options: string[]; discriminator?: string; description?: string }
  | { id: string; kind: "intersection"; left: string; right: string; description?: string }
  | { id: string; kind: "nullable"; inner: string; description?: string }
  | { id: string; kind: "ref"; target: string; description?: string };

/**
 * How object fields are ordered when a schema is compiled and rendered.
 *
 * `"sorted"` orders fields alphabetically. `"declared"` keeps the order the fields were declared
 * in, which is what the model reads and answers in.
 */
export type FieldOrder = "sorted" | "declared";

const DEFAULT_FIELD_ORDER: FieldOrder = "sorted";

export interface CompileSchemaOptions {
  /** Increment when application-owned schema metadata changes. */
  metadataRevision?: string | number;
  /** Parsing/streaming policies which affect the contract and fingerprint. */
  policies?: unknown;
  /** Object field order in the compiled graph and rendered instructions. Defaults to `"sorted"`. */
  fieldOrder?: FieldOrder;
}

export interface CompiledSchema {
  root: string;
  nodes: Readonly<Record<string, CompiledNode>>;
  diagnostics: readonly Diagnostic[];
  fingerprint: string;
  contractVersion: typeof SCHEMA_CONTRACT_VERSION;
}

const cache = new WeakMap<z.ZodTypeAny, Map<string, CompiledSchema>>();

function stable(value: unknown, seen = new WeakSet<object>()): string {
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return `${value}n`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (seen.has(value)) return '"[Circular]"';
  seen.add(value);
  if (Array.isArray(value)) return `[${value.map((v) => stable(v, seen)).join(",")}]`;
  return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key], seen)}`).join(",")}}`;
}

/**
 * `stable` sorts record keys, which would normalize object field order straight out of the
 * fingerprint. Fields are canonicalized as an ordered array so that two orders of the same fields —
 * which render differently — can never share one fingerprint. `CompiledNode` keeps the record shape.
 */
function hashable(nodes: Record<string, CompiledNode>): unknown {
  return Object.fromEntries(Object.entries(nodes).map(([id, node]) =>
    [id, node.kind === "object" ? { ...node, fields: Object.entries(node.fields) } : node]));
}

function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `fnv1a-${(h >>> 0).toString(16).padStart(8, "0")}`;
}

export function compileSchema(schema: z.ZodTypeAny, options: CompileSchemaOptions = {}): CompiledSchema {
  const fieldOrder = options.fieldOrder ?? DEFAULT_FIELD_ORDER;
  const key = stable({ revision: options.metadataRevision ?? 0, policies: options.policies ?? null, fieldOrder });
  const existing = cache.get(schema)?.get(key);
  if (existing) return existing;

  const nodes: Record<string, CompiledNode> = {};
  const ids = new WeakMap<z.ZodTypeAny, string>();
  const diagnostics: Diagnostic[] = [];
  let next = 1;
  const visit = (current: z.ZodTypeAny, path: (string | number)[]): string => {
    const prior = ids.get(current);
    if (prior) return prior;
    const id = `T${next++}`;
    ids.set(current, id);
    const description = zodDescription(current);
    const metadata = getYomiMetadata(current);
    const add = <T extends CompiledNode>(node: T): string => { nodes[id] = node; return id; };
    const inspected = inspectZod(current);
    if (inspected.kind === "optional" || inspected.kind === "readonly" || inspected.kind === "default" || inspected.kind === "catch" || inspected.kind === "pipe" || inspected.kind === "lazy") {
      const inner = inspected.kind === "lazy" ? inspected.get() : inspected.kind === "pipe" ? inspected.input : inspected.inner;
      nodes[id] = { id, kind: "ref", target: id, ...(description ? { description } : {}) };
      const target = visit(inner, path);
      nodes[id] = target === id ? { id, kind: "unknown", ...(description ? { description } : {}) } : { id, kind: "ref", target, ...(description ? { description } : {}) };
      return id;
    }
    const common = description ? { description } : {};
    switch (inspected.kind) {
      case "string": case "number": case "bigint": case "boolean": case "null": case "undefined": case "unknown": case "never": case "date": return add({ id, kind: inspected.kind, ...common });
      case "literal": case "enum": {
        const canonical = new Set(inspected.values.map(String)); const seen = new Map<string, string>();
        for (const [value, aliases] of Object.entries(metadata.enumAliases ?? {})) for (const alias of aliases) {
          const conflict = canonical.has(alias) || seen.has(alias);
          if (conflict) diagnostics.push({ code: "alias_collision", phase: "validation", path: [...path, value], severity: "error", cost: 0, evidence: `Enum alias ${JSON.stringify(alias)} collides with ${JSON.stringify(seen.get(alias) ?? alias)}` });
          else seen.set(alias, value);
        }
        return add({ id, kind: inspected.kind, values: inspected.values, ...(metadata.enumAliases ? { aliases: metadata.enumAliases } : {}), ...(metadata.enumValueDescriptions ? { valueDescriptions: metadata.enumValueDescriptions } : {}), ...(metadata.name ? { name: metadata.name } : {}), ...common });
      }
      case "array": return add({ id, kind: "array", element: visit(inspected.element, [...path, "*"]), ...common });
      case "tuple": return add({ id, kind: "tuple", items: inspected.items.map((item, i) => visit(item, [...path, i])), ...(inspected.rest ? { rest: visit(inspected.rest, [...path, "*"]) } : {}), ...common });
      case "record": return add({ id, kind: "record", value: visit(inspected.value, [...path, "*"]), ...common });
      case "nullable": return add({ id, kind: "nullable", inner: visit(inspected.inner, path), ...common });
      case "union": return add({ id, kind: "union", options: inspected.options.map((option, i) => visit(option, [...path, i])), ...(inspected.discriminator ? { discriminator: inspected.discriminator } : {}), ...common });
      case "intersection": return add({ id, kind: "intersection", left: visit(inspected.left, path), right: visit(inspected.right, path), ...common });
      case "object": {
        const fields: Record<string, { node: string; optional: boolean; aliases?: readonly string[] }> = {};
        const canonical = new Set(Object.keys(inspected.shape)); const seen = new Map<string, string>();
        const declared = Object.keys(inspected.shape);
        for (const name of fieldOrder === "sorted" ? [...declared].sort() : declared) {
          const child = inspected.shape[name]!;
          const aliases = getYomiMetadata(child).aliases;
          for (const alias of aliases ?? []) {
            const conflict = canonical.has(alias) || seen.has(alias);
            if (conflict) diagnostics.push({ code: "alias_collision", phase: "validation", path: [...path, name], severity: "error", cost: 0, evidence: `Field alias ${JSON.stringify(alias)} collides with ${JSON.stringify(seen.get(alias) ?? alias)}` });
            else seen.set(alias, name);
          }
          fields[name] = { node: visit(child, [...path, name]), optional: child.isOptional(), ...(aliases?.length ? { aliases } : {}) };
        }
        return add({ id, kind: "object", fields, ...common });
      }
      case "unsupported":
        diagnostics.push({ code: "unsupported_schema", phase: "validation", path, severity: "error", cost: 0, evidence: inspected.typeName });
        return add({ id, kind: "unknown", ...common });
    }
    throw new Error("Unreachable schema kind");
  };
  const root = visit(schema, []);
  const normalized = stable({ contractVersion: SCHEMA_CONTRACT_VERSION, root, nodes: hashable(nodes), policies: options.policies ?? null, metadataRevision: options.metadataRevision ?? 0, fieldOrder });
  const compiled: CompiledSchema = Object.freeze({ root, nodes: Object.freeze(nodes), diagnostics: Object.freeze(diagnostics), fingerprint: hash(normalized), contractVersion: SCHEMA_CONTRACT_VERSION });
  const entries = cache.get(schema) ?? new Map<string, CompiledSchema>(); entries.set(key, compiled); cache.set(schema, entries);
  return compiled;
}

export interface RenderFormatResult {
  /**
   * The rendered schema on its own—any hoisted enum blocks, a blank line, then the schema body.
   *
   * It carries no instruction sentence and no code fence. Prompt wording belongs to the caller, who
   * can tune it without the renderer overwriting that choice.
   */
  format: string;
  fingerprint: string;
  diagnostics: readonly Diagnostic[];
}

/** Token placed between union options. `"or"` reads as plain English, `"|"` reads as a type. */
export type OrSplitter = "|" | "or";

/**
 * Which enums are lifted out of the schema body into named blocks above it.
 *
 * `"described"` hoists only the enums carrying value descriptions, which are the ones whose inline
 * comments otherwise bury the field they sit on.
 */
export type EnumHoisting = "never" | "described" | "always";

/** `literal` and `enum` share one compiled node; only `enum` nodes are ever hoisted. */
type EnumNode = Extract<CompiledNode, { values: unknown[] }>;

/**
 * Presentation of the rendered contract. Every default reproduces the original single-line layout,
 * so an existing prompt keeps its exact text—and its fingerprint—until a layout is asked for.
 */
export interface RenderLayout {
  /** Break objects, and hoisted enums, one entry per line. Defaults to `false`. */
  multiline?: boolean;
  /** Lift enums into named blocks above the schema. Defaults to `"never"`. */
  hoistEnums?: EnumHoisting;
  /** Separator between union options, nullable types, and inline enum values. Defaults to `"|"`. */
  orSplitter?: OrSplitter;
}

export interface RenderFormatOptions extends CompileSchemaOptions, RenderLayout {}

const DEFAULT_LAYOUT: Required<RenderLayout> = { multiline: false, hoistEnums: "never", orSplitter: "|" };
const INDENT = "  ";

const comment = (text: string): string => ` /* ${text.replace(/\*\//g, "* /")} */`;

/** `basis_kcal` and `basisKcal` both name a hoisted enum `BasisKcal`. Empty when nothing survives. */
function pascalCase(hint: string): string {
  const name = hint.split(/[^A-Za-z0-9]+/).filter(Boolean).map((part) => part[0]!.toUpperCase() + part.slice(1)).join("");
  return /^[A-Za-z]/.test(name) ? name : "";
}

/**
 * Pick the enums to hoist and name them, before the body is rendered and needs those names.
 *
 * A name comes from `yomi().named()`, else from the first field that reaches the enum, so an enum
 * shared by several fields is defined once and referenced by name everywhere. Traversal follows the
 * compiled field order, which keeps both the names and the block order deterministic.
 */
function planHoistedEnums(compiled: CompiledSchema, policy: EnumHoisting): Map<string, string> {
  const names = new Map<string, string>();
  if (policy === "never") return names;
  const taken = new Set<string>();
  const visited = new Set<string>();
  const unique = (base: string): string => {
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}${n}`;
    taken.add(name);
    return name;
  };
  const walk = (id: string, hint: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const node = compiled.nodes[id];
    if (!node) return;
    switch (node.kind) {
      case "enum": {
        const described = Object.keys(node.valueDescriptions ?? {}).length > 0;
        if (policy === "always" || described) names.set(id, unique(node.name ?? (pascalCase(hint) || "Enum")));
        return;
      }
      case "ref": return walk(node.target, hint);
      case "array": return walk(node.element, hint);
      case "record": return walk(node.value, hint);
      case "nullable": return walk(node.inner, hint);
      case "intersection": { walk(node.left, hint); walk(node.right, hint); return; }
      case "tuple": { for (const item of [...node.items, ...(node.rest ? [node.rest] : [])]) walk(item, hint); return; }
      case "union": { for (const option of node.options) walk(option, hint); return; }
      case "object": { for (const [field, entry] of Object.entries(node.fields)) walk(entry.node, entry.aliases?.[0] ?? field); return; }
      default: return;
    }
  };
  walk(compiled.root, "");
  return names;
}

export function renderFormat(schema: z.ZodTypeAny, options?: RenderFormatOptions): RenderFormatResult {
  const compiled = compileSchema(schema, options);
  const layout: Required<RenderLayout> = {
    multiline: options?.multiline ?? DEFAULT_LAYOUT.multiline,
    hoistEnums: options?.hoistEnums ?? DEFAULT_LAYOUT.hoistEnums,
    orSplitter: options?.orSplitter ?? DEFAULT_LAYOUT.orSplitter,
  };
  const multiline = layout.multiline;
  const splitter = ` ${layout.orSplitter} `;
  const pad = (depth: number): string => INDENT.repeat(depth);
  const hoisted = planHoistedEnums(compiled, layout.hoistEnums);
  const braces = (entries: string[], depth: number): string => {
    if (!multiline) return `{ ${entries.join(", ")} }`;
    return entries.length ? `{\n${entries.map((entry) => `${pad(depth + 1)}${entry}`).join(",\n")}\n${pad(depth)}}` : "{}";
  };

  const enumValues = (node: EnumNode): string[] => node.values.map((value) => {
    const key = String(value);
    const shown = node.aliases?.[key]?.[0] ?? value;
    const detail = node.valueDescriptions?.[key];
    return `${stable(shown)}${detail ? comment(detail) : ""}`;
  });

  const render = (id: string, stack: Set<string>, depth: number): string => {
    if (stack.has(id)) return `@${id}`;
    const node = compiled.nodes[id];
    if (!node) return "unknown";
    if (node.kind === "ref") return stack.has(node.target) ? `@${node.target}` : render(node.target, new Set([...stack, id]), depth);
    const hoistedName = hoisted.get(id);
    if (hoistedName) return hoistedName;
    const next = new Set([...stack, id]);
    let body: string;
    switch (node.kind) {
      case "array": body = `${render(node.element, next, depth)}[]`; break;
      case "tuple": body = `[${node.items.map((item) => render(item, next, depth)).concat(node.rest ? [`...${render(node.rest, next, depth)}[]`] : []).join(", ")}]`; break;
      case "object": {
        const fields = Object.entries(node.fields).map(([name, field]) => `${JSON.stringify(field.aliases?.[0] ?? name)}${field.optional ? "?" : ""}: ${render(field.node, next, multiline ? depth + 1 : depth)}${field.aliases?.length ? comment(`canonical: ${name}${field.aliases.length > 1 ? `; aliases: ${field.aliases.join(", ")}` : ""}`) : ""}`);
        body = braces(fields, depth);
        break;
      }
      case "record": body = `{ [key: string]: ${render(node.value, next, depth)} }`; break;
      case "union": body = node.options.map((option) => render(option, next, depth)).join(splitter); break;
      case "intersection": body = `${render(node.left, next, depth)} & ${render(node.right, next, depth)}`; break;
      case "nullable": body = `${render(node.inner, next, depth)}${splitter}null`; break;
      case "literal": body = node.values.map((value) => stable(value)).join(splitter); break;
      case "enum": body = enumValues(node).join(splitter); break;
      default: body = node.kind;
    }
    return node.description ? `${body}${comment(node.description)}` : body;
  };

  const enumBlock = (id: string, name: string): string => {
    const node = compiled.nodes[id] as EnumNode;
    const body = braces(enumValues(node), 0);
    return `enum ${name} ${body}${node.description ? comment(node.description) : ""}`;
  };

  const blocks = [...hoisted].map(([id, name]) => `${enumBlock(id, name)}\n\n`).join("");
  const format = `${blocks}${render(compiled.root, new Set(), 0)}`;
  // Layout changes the text the model reads, so it has to change the identity of that text. Defaults
  // pass the compiled fingerprint straight through, which keeps existing contracts byte-identical.
  const fingerprint = stable(layout) === stable(DEFAULT_LAYOUT) ? compiled.fingerprint : hash(`${compiled.fingerprint}|${stable(layout)}`);
  return { format, fingerprint, diagnostics: compiled.diagnostics };
}
export function schemaFingerprint(schema: z.ZodTypeAny, options?: CompileSchemaOptions): string { return compileSchema(schema, options).fingerprint; }

/** Fingerprint the schema together with every parser policy that changes its contract. */
export function parserContractFingerprint(
  schema: z.ZodTypeAny,
  options?: ParserOptions<any>,
  contract?: Omit<CompileSchemaOptions, "policies">,
): string {
  return compileSchema(schema, { ...contract, policies: parserContractPolicies(options) }).fingerprint;
}
