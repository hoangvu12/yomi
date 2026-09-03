# Yomi (読み)

Yomi is a local, provider-neutral TypeScript library for turning messy LLM output into values that satisfy Zod schemas. It repairs JSON, performs schema-aligned coercion, explains interpretation decisions, and produces completion-aware semantic snapshots while text is streaming.

Yomi does not make model requests, manage credentials, retry providers, or send telemetry.

## Highlights

- Repairs malformed JSON and extracts JSON from Markdown or surrounding prose.
- Coerces values to Zod input shapes, then runs the original Zod schema exactly once.
- Scores all eligible union candidates and reports ambiguity instead of silently relying on declaration order.
- Produces completion-aware streaming snapshots from string or UTF-8 byte chunks.
- Supports atomic values, reveal-on-completion, parent gating, state wrappers, immutable revisions, and semantic deduplication.
- Renders the model-facing schema, single-line or multi-line, from the same Zod schema used for parsing.
- Supports descriptions plus model-facing field and enum aliases without changing application output types.
- Returns bounded structured diagnostics and enforces finite resource limits.
- Runs optional named advisory checks without discarding otherwise valid data.
- Adapts arbitrary provider event streams without adding provider dependencies.

## Requirements

- Zod 4
- Node.js or Bun with ESM support

## Installation

Install directly from GitHub; no npm registry access is required:

```bash
npm install github:hoangvu12/yomi zod
```

For reproducible applications, pin a release tag or commit instead of following `main`:

```bash
npm install github:hoangvu12/yomi#v1.0.1 zod
# or pin an exact commit
npm install github:hoangvu12/yomi#<commit-sha> zod
```

GitHub dependencies run Yomi's `prepare` script and build `dist` locally during installation. Consumers need Git and a supported Node.js/npm toolchain, but do not need Bun. Imports remain unchanged:

```ts
import { parse } from "@hoangvu12/yomi";
```

## Parse messy model output

```ts
import { z } from "zod";
import { parse } from "@hoangvu12/yomi";

const User = z.object({
  name: z.string(),
  age: z.number().int(),
  active: z.boolean(),
});

const result = parse(User, `Here is the result: {name: "Ada", age: "37", active: "yes",}`);

if (result.success) {
  result.data;        // { name: "Ada", age: 37, active: true }
  result.flags;       // repairs and coercions that occurred
  result.diagnostics; // bounded, path-aware interpretation records
  result.advisory;    // optional quality-check results
} else {
  console.error(result.error.type, result.error.message);
}
```

`parseOrThrow(schema, input, options)` returns the final value or throws. Use `coerce(schema, value, options)` and `coerceOrThrow(schema, value)` when the input is already a JavaScript value.

Every successful final result passes the complete original Zod pipeline. Refinements, formats, defaults, pipes, and transforms therefore remain the strict authority.

## Streaming semantic values

`createStreamParser` accepts arbitrary string and UTF-8 byte chunks. `push()` produces a partial semantic snapshot when useful data is available; `finish()` uses the same strict final pipeline as `parse()`.

```ts
import { createStreamParser } from "@hoangvu12/yomi";

const stream = createStreamParser(User);

for await (const chunk of modelTextChunks) {
  const update = stream.push(chunk);
  if (update.success) {
    console.log(update.snapshot.data);
    console.log(update.snapshot.completion.state); // pending | incomplete | complete
    console.log(update.snapshot.revision);
  }
}

const final = stream.finish();
```

Strings, objects, and collections grow incrementally by default. Numbers, booleans, nulls, literals, enums, dates, and discriminators remain hidden until lexically complete. Synthetic delimiters inserted by JSON repair never count as completion evidence.

### Streaming policies

Policies use dot paths and `*` for collection elements:

```ts
const stream = createStreamParser(ResultSchema, {
  fields: {
    "events.*.kind": { requiredForParent: true },
    "events.*.payload": { reveal: "complete" },
    "events.*.summary": { withState: true },
  },
});
```

- `reveal: "complete"` withholds the selected value until complete.
- `requiredForParent: true` withholds its containing object until the child is visible, non-null, and schema-valid.
- `withState: true` wraps projected data as `{ value, state }`, distinguishing pending from an emitted `null`.
- `atomic: "none"` disables the safe-default atomic policy.

Policy paths are validated when the parser is created. Snapshots are deeply frozen, revisions increase only when the semantic value or state changes, and `parseStream(schema, chunks, options)` suppresses duplicate emissions automatically.

`stream.metrics` exposes stable counters for input bytes, cumulative parsed bytes, completion scans, repair attempts, union candidates, snapshots, and retained bytes. See [streaming profile](docs/streaming-profile.md) for the benchmark harness and current optimization decision.

## Union selection

Yomi evaluates all eligible union variants. Exact matches cost less than repairs and coercions, while discriminated unions use exact discriminator evidence first. Materially different equal-cost results fail with `ambiguity_error` by default.

```ts
const result = parse(MyUnion, input, {
  unionTieBreaker: "first", // compatibility mode; ambiguity remains diagnostic
});
```

Chosen and rejected candidates, costs, and validation evidence are available in diagnostics.

## Render the schema into a prompt

Render the schema the model has to answer in, straight from the schema that will validate the answer, so prompts and runtime validation do not drift:

```ts
import { renderFormat, parserContractFingerprint } from "@hoangvu12/yomi";

const rendered = renderFormat(User);

const prompt = `Summarize this ticket.

Answer in JSON using this schema:
${rendered.format}`;

const contract = parserContractFingerprint(User, parserOptions);
```

`format` is the schema and nothing else—no instruction sentence, no code fence. The wording that surrounds it is yours to write and tune, and yomi never edits a prompt out from under you.

Rendering supports objects, collections, tuples, records, unions, literals, enums, optionality, nullability, descriptions, aliases, and recursive schemas through stable references. Unsupported constructs return compile diagnostics. Fingerprints cover the normalized schema, its field order, its layout, and observable parser policies.

### Field order

Object fields render alphabetically by default. Pass `fieldOrder: "declared"` to render them in the order they were declared instead, which lets the prompt ask for fields in the order the model should think in—reasoning before the numbers it justifies, for example:

```ts
const Estimate = z.object({ reasoning: z.string(), kcal: z.number() });

renderFormat(Estimate).format;
// { "kcal": number, "reasoning": string }

renderFormat(Estimate, { fieldOrder: "declared" }).format;
// { "reasoning": string, "kcal": number }
```

The option applies to nested objects too, and is accepted by `compileSchema`, `schemaFingerprint`, and `parserContractFingerprint`. Field order is part of the fingerprint, so two orders of the same fields never share a contract identity. Parsing is unaffected—key order in model output never matters to the parser.

`"sorted"` remains the default because the rendered text usually reaches a provider inside a cached request body; switching an existing schema to `"declared"` changes that text and invalidates those cached responses.

### Layout

The rendered contract is one line by default. Three independent options change how it reads without changing what it says, so each can be adopted—and measured—on its own.

Pass `multiline: true` to break objects one field per line. Descriptions and a single-line schema fight each other: the more guidance a schema carries, the harder that line is to scan, and a model looking for `basisKcal` has to count commas to find it.

```ts
const Estimate = z.object({
  reasoning: z.string().describe("Work through the portion before committing to numbers"),
  items: z.array(z.object({ name: z.string(), portionGrams: z.number() })),
});

renderFormat(Estimate, { fieldOrder: "declared", multiline: true }).format;
// {
//   "reasoning": string /* Work through the portion before committing to numbers */,
//   "items": {
//     "name": string,
//     "portionGrams": number
//   }[]
// }
```

Pass `hoistEnums` to lift enums out of the schema body into named blocks above it. `"described"` hoists only the enums carrying value descriptions—the ones whose inline comments otherwise bury the field they sit on—and `"always"` hoists every enum. An enum shared by several fields is defined once and referenced by name at each site. Blocks are separated from the schema by a blank line, so `format` stays one block of text you can drop into a prompt.

```ts
const Confidence = yomi(z.enum(["high", "low"]).describe("Evidence strength"))
  .valueDescription("high", "Directly measured")
  .valueDescription("low", "Largely guessed");

renderFormat(z.object({ confidence: Confidence }), { hoistEnums: "described" }).format;
// enum Confidence { "high" /* Directly measured */, "low" /* Largely guessed */ } /* Evidence strength */
//
// { "confidence": Confidence }
```

A hoisted enum is named by `yomi().named("EvidenceGrade")` when given, otherwise from the first field that reaches it (`confidence` becomes `Confidence`), with a numeric suffix if two enums would collide. Literals are never hoisted.

Pass `orSplitter: "or"` to separate union options, nullable types, and inline enum values with plain English instead of `|`, which some models read more reliably:

```ts
renderFormat(z.object({ note: z.string().nullable() }), { orSplitter: "or" }).format;
// { "note": string or null }
```

Layout is part of `renderFormat`'s fingerprint, so two layouts of the same schema never share a contract identity. Every default reproduces the original single-line text byte for byte, and the default fingerprint stays equal to `schemaFingerprint`—an existing prompt is unaffected until a layout is asked for. Layout does not reach `compileSchema`, `schemaFingerprint`, or `parserContractFingerprint`, which describe the schema and the parser rather than the presentation.

## Model-facing aliases and descriptions

Use normal Zod descriptions and `yomi()` metadata. Aliases are accepted from model output and mapped back to canonical application names.

```ts
import { z } from "zod";
import { yomi } from "@hoangvu12/yomi";

const Status = yomi(z.enum(["pending", "complete"]).describe("Job state"))
  .valueAlias("pending", "P")
  .valueAlias("complete", "C")
  .valueDescription("complete", "The job has finished");

const Job = z.object({
  identifier: yomi(z.string().describe("Stable job ID")).alias("id"),
  status: Status,
});
```

Canonical names win when canonical and aliased keys both appear. Alias collisions are compile diagnostics, and aliases are always literal keys—not executable property paths. `.named()` sets the model-facing type name an enum is given when [hoisted](#layout).

## Advisory checks

Advisory checks add named, non-fatal quality signals after strict validation succeeds:

```ts
const result = parse(Article, input, {
  advisoryChecks: [{
    name: "has-substantive-title",
    check: (article) => article.title.length >= 8 || {
      success: false,
      message: "Title is unusually short",
      path: ["title"],
    },
  }],
});
```

Failed or throwing checks preserve the parsed value and become bounded warning diagnostics. Check names participate in the parser contract fingerprint. Streaming evaluates advisory checks only at `finish()`, when a strict final value exists.

## Safety and diagnostics

Successful parses expose diagnostics with a stable code, phase, schema path, severity, cost, and optional bounded evidence. Failures distinguish JSON, coercion, Zod validation, ambiguity, and resource exhaustion.

Finite defaults protect input bytes, nesting depth, collection size, union candidate count, repair work, retained evidence bytes, and diagnostic count.

```ts
const result = parse(Schema, input, {
  limits: {
    maxInputBytes: 256_000,
    maxNestingDepth: 32,
    maxCollectionSize: 2_000,
  },
});
```

Limit failures use `resource_limit_error` and identify the exhausted budget. Object construction treats prototype-sensitive keys as ordinary data and avoids prototype pollution.

## Provider event adapters

`adaptProviderEvents` translates any SDK event stream into the text or byte chunks Yomi accepts:

```ts
import { adaptProviderEvents, parseStream } from "@hoangvu12/yomi";

const chunks = adaptProviderEvents(providerEvents, (event) =>
  event.type === "text_delta"
    ? { type: "text", value: event.text }
    : event.type === "ping"
      ? { type: "ignore" }
      : { type: "unknown", reason: event.type },
  { signal },
);

for await (const snapshot of parseStream(ResultSchema, chunks)) {
  render(snapshot);
}
```

Unknown events throw unless explicitly configured with `unknownEvent: "ignore"`. Cancellation closes the upstream iterator. Authentication, retries, fallbacks, timeouts, token accounting, and model selection remain the caller's responsibility.

## Common repairs and coercions

Yomi handles Markdown fences, surrounding prose, comments, unquoted keys, trailing commas, single quotes, string-to-number and string-to-boolean conversion, number/boolean-to-string conversion, single-item array conversion, case-insensitive enums, defaults, optionals, and ignored extra keys. Every applied interpretation is retained as a flag and structured diagnostic.

## Supported schema families

The normalized schema compiler and parser cover primitives, literals, enums, objects, records, arrays, tuples, unions, discriminated unions, intersections, nullable/optional/default/catch/readonly wrappers, pipes, dates, lazy recursive schemas, and passthrough unknown values. Unsupported compilation constructs are reported instead of silently rendered incorrectly.

## Development

```bash
bun test
bun run typecheck
bun run build
bun run profile:stream
```

The normal suite includes a durable corpus that replays messy responses across meaningful character prefixes and UTF-8 byte boundaries.

## License

MIT
