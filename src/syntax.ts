export type CompletionState = "pending" | "incomplete" | "complete";

/** Completion evidence for a syntax value. Children use decoded object keys or array indexes. */
export interface CompletionNode {
  state: CompletionState;
  children?: Readonly<Record<string, CompletionNode>> | readonly CompletionNode[];
}

const pending = (): CompletionNode => ({ state: "pending" });

/**
 * Interpret completion from delimiters actually present in an LLM response.
 * This deliberately does not consume jsonrepair output: recovery must never
 * turn a synthetic quote/bracket into completion evidence.
 */
export function inspectCompletion(input: string): CompletionNode {
  const start = findRoot(input);
  if (start < 0) return pending();
  return new SyntaxReader(input, start).value().node;
}

function findRoot(input: string): number {
  const match = /```(?:json)?\s*/i.exec(input);
  const from = match ? match.index + match[0].length : 0;
  const first = input.slice(from).search(/\S/);
  if (first < 0) return -1;
  const firstAt = from + first;
  if (/[\[{"\-0-9tfn]/.test(input[firstAt] ?? "")) return firstAt;
  const structural = input.slice(from).search(/[\[{]/);
  if (structural >= 0) return from + structural;
  // Root strings and scalars are uncommon in prose, but are unambiguous when
  // the response (or fenced body) begins with one.
  return -1;
}

interface ReadResult { node: CompletionNode; end: number }

class SyntaxReader {
  constructor(private readonly source: string, private cursor: number) {}

  value(): ReadResult {
    this.space();
    const char = this.source[this.cursor];
    if (char === undefined) return { node: pending(), end: this.cursor };
    if (char === '"') return this.stringValue();
    if (char === "{") return this.objectValue();
    if (char === "[") return this.arrayValue();
    return this.scalarValue();
  }

  private stringValue(): ReadResult {
    this.cursor++;
    let escaped = false;
    while (this.cursor < this.source.length) {
      const char = this.source[this.cursor++];
      if (escaped) { escaped = false; continue; }
      if (char === "\\") { escaped = true; continue; }
      if (char === '"') return { node: { state: "complete" }, end: this.cursor };
    }
    return { node: { state: "incomplete" }, end: this.cursor };
  }

  private scalarValue(): ReadResult {
    const start = this.cursor;
    while (this.cursor < this.source.length && !/[\s,}\]]/.test(this.source[this.cursor]!)) this.cursor++;
    if (this.cursor === start) return { node: pending(), end: this.cursor };
    return { node: { state: this.cursor < this.source.length ? "complete" : "incomplete" }, end: this.cursor };
  }

  private objectValue(): ReadResult {
    this.cursor++;
    const children: Record<string, CompletionNode> = Object.create(null) as Record<string, CompletionNode>;
    while (this.cursor < this.source.length) {
      this.space();
      if (this.source[this.cursor] === "}") {
        this.cursor++;
        return { node: { state: "complete", children }, end: this.cursor };
      }
      if (this.source[this.cursor] === ",") { this.cursor++; continue; }
      const key = this.key();
      if (!key) break;
      this.space();
      if (this.source[this.cursor] !== ":") { children[key.value] = pending(); break; }
      this.cursor++;
      this.space();
      if (this.cursor >= this.source.length) { children[key.value] = pending(); break; }
      const child = this.value();
      children[key.value] = child.node;
      this.cursor = child.end;
      this.space();
      if (this.source[this.cursor] === ",") { this.cursor++; continue; }
      if (this.source[this.cursor] === "}") continue;
      break;
    }
    return { node: { state: "incomplete", children }, end: this.cursor };
  }

  private arrayValue(): ReadResult {
    this.cursor++;
    const children: CompletionNode[] = [];
    while (this.cursor < this.source.length) {
      this.space();
      if (this.source[this.cursor] === "]") {
        this.cursor++;
        return { node: { state: "complete", children }, end: this.cursor };
      }
      if (this.source[this.cursor] === ",") { this.cursor++; continue; }
      const child = this.value();
      if (child.node.state === "pending") break;
      children.push(child.node);
      this.cursor = child.end;
      this.space();
      if (this.source[this.cursor] === ",") { this.cursor++; continue; }
      if (this.source[this.cursor] === "]") continue;
      break;
    }
    return { node: { state: "incomplete", children }, end: this.cursor };
  }

  private key(): { value: string } | undefined {
    if (this.source[this.cursor] === '"') {
      const start = ++this.cursor;
      let escaped = false;
      while (this.cursor < this.source.length) {
        const char = this.source[this.cursor++];
        if (escaped) { escaped = false; continue; }
        if (char === "\\") { escaped = true; continue; }
        if (char === '"') {
          const raw = this.source.slice(start - 1, this.cursor);
          try { return { value: JSON.parse(raw) as string }; } catch { return undefined; }
        }
      }
      return undefined;
    }
    const match = /^[^\s:,}\]]+/.exec(this.source.slice(this.cursor));
    if (!match) return undefined;
    this.cursor += match[0].length;
    return { value: match[0] };
  }

  private space(): void {
    while (/\s/.test(this.source[this.cursor] ?? "")) this.cursor++;
  }
}
