import type { z } from "zod";
import type { Diagnostic } from "./diagnostics.js";
import { inspectZod, zodDescription } from "./zod-compat.js";

export const SCHEMA_CONTRACT_VERSION = "yomi-schema-v1";

export type CompiledNode =
  | { id: string; kind: "string" | "number" | "bigint" | "boolean" | "null" | "undefined" | "unknown" | "never" | "date"; description?: string }
  | { id: string; kind: "literal" | "enum"; values: unknown[]; description?: string }
  | { id: string; kind: "array"; element: string; description?: string }
  | { id: string; kind: "tuple"; items: string[]; rest?: string; description?: string }
  | { id: string; kind: "object"; fields: Record<string, { node: string; optional: boolean }>; description?: string }
  | { id: string; kind: "record"; value: string; description?: string }
  | { id: string; kind: "union"; options: string[]; discriminator?: string; description?: string }
  | { id: string; kind: "intersection"; left: string; right: string; description?: string }
  | { id: string; kind: "nullable"; inner: string; description?: string }
  | { id: string; kind: "ref"; target: string; description?: string };

export interface CompileSchemaOptions {
  /** Increment when application-owned schema metadata changes. */
  metadataRevision?: string | number;
  /** Parsing/streaming policies which affect the contract and fingerprint. */
  policies?: unknown;
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

function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `fnv1a-${(h >>> 0).toString(16).padStart(8, "0")}`;
}

export function compileSchema(schema: z.ZodTypeAny, options: CompileSchemaOptions = {}): CompiledSchema {
  const key = stable({ revision: options.metadataRevision ?? 0, policies: options.policies ?? null });
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
      case "literal": case "enum": return add({ id, kind: inspected.kind, values: inspected.values, ...common });
      case "array": return add({ id, kind: "array", element: visit(inspected.element, [...path, "*"]), ...common });
      case "tuple": return add({ id, kind: "tuple", items: inspected.items.map((item, i) => visit(item, [...path, i])), ...(inspected.rest ? { rest: visit(inspected.rest, [...path, "*"]) } : {}), ...common });
      case "record": return add({ id, kind: "record", value: visit(inspected.value, [...path, "*"]), ...common });
      case "nullable": return add({ id, kind: "nullable", inner: visit(inspected.inner, path), ...common });
      case "union": return add({ id, kind: "union", options: inspected.options.map((option, i) => visit(option, [...path, i])), ...(inspected.discriminator ? { discriminator: inspected.discriminator } : {}), ...common });
      case "intersection": return add({ id, kind: "intersection", left: visit(inspected.left, path), right: visit(inspected.right, path), ...common });
      case "object": {
        const fields: Record<string, { node: string; optional: boolean }> = {};
        for (const name of Object.keys(inspected.shape).sort()) {
          const child = inspected.shape[name]!;
          fields[name] = { node: visit(child, [...path, name]), optional: child.isOptional() };
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
  const normalized = stable({ contractVersion: SCHEMA_CONTRACT_VERSION, root, nodes, policies: options.policies ?? null, metadataRevision: options.metadataRevision ?? 0 });
  const compiled: CompiledSchema = Object.freeze({ root, nodes: Object.freeze(nodes), diagnostics: Object.freeze(diagnostics), fingerprint: hash(normalized), contractVersion: SCHEMA_CONTRACT_VERSION });
  const entries = cache.get(schema) ?? new Map<string, CompiledSchema>(); entries.set(key, compiled); cache.set(schema, entries);
  return compiled;
}

export interface RenderFormatResult { format: string; fingerprint: string; diagnostics: readonly Diagnostic[] }

export function renderFormat(schema: z.ZodTypeAny, options?: CompileSchemaOptions): RenderFormatResult {
  const compiled = compileSchema(schema, options);
  const render = (id: string, stack: Set<string>): string => {
    if (stack.has(id)) return `@${id}`;
    const node = compiled.nodes[id];
    if (!node) return "unknown";
    if (node.kind === "ref") return stack.has(node.target) ? `@${node.target}` : render(node.target, new Set([...stack, id]));
    const next = new Set([...stack, id]);
    let body: string;
    switch (node.kind) {
      case "array": body = `${render(node.element, next)}[]`; break;
      case "tuple": body = `[${node.items.map((item) => render(item, next)).concat(node.rest ? [`...${render(node.rest, next)}[]`] : []).join(", ")}]`; break;
      case "object": body = `{ ${Object.entries(node.fields).map(([name, field]) => `${JSON.stringify(name)}${field.optional ? "?" : ""}: ${render(field.node, next)}`).join(", ")} }`; break;
      case "record": body = `{ [key: string]: ${render(node.value, next)} }`; break;
      case "union": body = node.options.map((option) => render(option, next)).join(" | "); break;
      case "intersection": body = `${render(node.left, next)} & ${render(node.right, next)}`; break;
      case "nullable": body = `${render(node.inner, next)} | null`; break;
      case "literal": body = node.values.map((value) => stable(value)).join(" | "); break;
      case "enum": body = node.values.map((value) => stable(value)).join(" | "); break;
      default: body = node.kind;
    }
    return node.description ? `${body} /* ${node.description.replace(/\*\//g, "* /")} */` : body;
  };
  return { format: `Return only JSON matching ${render(compiled.root, new Set())}.`, fingerprint: compiled.fingerprint, diagnostics: compiled.diagnostics };
}

export function schemaFingerprint(schema: z.ZodTypeAny, options?: CompileSchemaOptions): string { return compileSchema(schema, options).fingerprint; }
