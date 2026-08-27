# BAML's current design and what Yomi should borrow

Research date: 2026-08-27. Sources are limited to BoundaryML's official documentation and official open-source repository. This note distinguishes documented behavior from recommendations inferred for Yomi.

## Executive summary

BAML's structured-output reliability is a pipeline, not a single JSON repair trick:

1. A typed function declaration is the source of truth.
2. The compiler renders that type into the prompt through `ctx.output_format`, including aliases and descriptions.
3. The runtime sends the request through a provider-independent client layer.
4. Schema-Aligned Parsing (SAP) searches/coerces permissive model text into the declared type.
5. Streaming repeatedly produces a separately generated **partial type**, then performs strict final parsing into the original return type.
6. Semantic streaming annotations control when unstable values become visible.
7. Checks/assertions, retries/fallbacks, typed errors, collectors, and first-class tests surround the parse path.

For Yomi, the highest-value lesson is to keep its narrower role as a Zod-aligned parser while adopting the parser-level pieces. The recommended sequence is:

1. Make final validation truthful and improve candidate selection/errors.
2. Add a stateful incremental parser with an explicit partial-result contract.
3. Add field stability policies analogous to BAML's `done`, `not_null`, and `with_state`.
4. Add schema-to-prompt rendering, confidence/diagnostics, and replayable corpus tests.

Retries, provider fallbacks, request timeouts, and hosted tracing belong in an orchestration package or adapters, not Yomi's parser core.

## How BAML currently works

### One schema drives prompt, parser, and generated application types

A BAML function declares typed inputs, a return type, a client, and a Jinja-style prompt. At generation time BAML creates language-native clients and types; at runtime a call renders the prompt, calls the provider, parses the response, and returns the generated type. The official prompting guide explicitly describes these four runtime steps and exposes both rendered prompt and raw cURL in its editor tooling ([Prompting in BAML](https://docs.boundaryml.com/guide/baml-basics/prompting-with-baml)).

`{{ ctx.output_format }}` renders a compact description of the function's return schema into the prompt rather than requiring users to maintain a second JSON Schema by hand ([`ctx.output_format`](https://docs.boundaryml.com/ref/prompt-syntax/ctx-output-format)). `@description` adds semantic guidance to fields/enums in that rendered schema ([description attribute](https://docs.boundaryml.com/ref/attributes/description)); `@alias` changes the model-facing name while preserving the application-facing name and is also used when parsing the answer back ([alias attribute](https://docs.boundaryml.com/ref/attributes/alias)). This closes an important loop: prompt guidance and response interpretation cannot silently drift apart.

The compiler/runtime are implemented primarily in Rust and emit clients for several host languages; the official repository describes generated clients as the way application code invokes BAML functions and describes the system as fully open source/offline except for requested model calls ([BoundaryML/baml](https://github.com/BoundaryML/baml)). The tolerant parser lives in the repository's `engine/baml-lib/jsonish` subsystem ([jsonish source](https://github.com/BoundaryML/baml/tree/canary/engine/baml-lib/jsonish/src)).

### Schema-Aligned Parsing is schema-directed, not merely repaired `JSON.parse`

BAML calls its tolerant conversion algorithm Schema-Aligned Parsing (SAP). Official docs characterize it as accepting imperfect output and transforming it toward the requested schema using custom edit-distance/candidate-selection logic ([Why BAML](https://docs.boundaryml.com/guide/introduction/why-baml)). The approach is deliberately compatible with free-form text and reasoning around the object rather than depending on provider-native constrained decoding; the official chain-of-thought examples rely on SAP to parse a structured object after or around prose ([chain-of-thought prompting](https://docs.boundaryml.com/examples/prompt-engineering/chain-of-thought)).

The practical distinction for Yomi is important. A syntax repairer answers “can this prefix become JSON?” SAP also answers “which interpretation best satisfies this particular schema?” Candidate scoring is particularly relevant for unions, aliases, extra/missing fields, markdown/prose extraction, and near-matching enums.

### Streaming has a separate partial type contract

Every streamed prefix is incomplete JSON. BAML turns prefixes into semantically usable values and generates a separate `partial_types` model: by default class fields become nullable/partial, while the stream's final accessor returns the original, fully validated type ([Streaming](https://docs.boundaryml.com/guide/baml-basics/streaming)). In TypeScript the stream is an async iterable and also exposes `getFinalResponse()`; streams support cancellation with `AbortController` ([Streaming, cancellation examples](https://docs.boundaryml.com/guide/baml-basics/streaming)).

BAML then adds semantic policies rather than exposing every syntactically repairable guess:

- `@stream.done`: hide a value until it is complete. Numbers are atomic by default; strings otherwise grow token by token. Applying it to a union/list element makes completed items appear atomically.
- `@stream.not_null`: withhold a containing object until a key field exists, useful for union discriminators.
- `@stream.with_state`: wrap a value with completion metadata for UI loading states.

The generated streaming transformations are documented as `T -> Partial<T>?`, `T @stream.done -> T?`, `T @stream.not_null -> Partial<T>`, and `T @stream.with_state -> StreamState<Partial<T>?>`; these annotations do not change the non-streaming return type ([semantic streaming type table](https://docs.boundaryml.com/guide/baml-basics/streaming#type-transformation-summary)).

This design prevents three common UI failures: displaying half of a numeric value (`1` before `1.50`), switching union variants after a weak early guess, and treating “not emitted yet” as a genuine null.

### Validation is strict or advisory

BAML supports `@assert` and `@check`. A failed assertion rejects a top-level result (or removes an invalid nested/container member), while a failed check preserves the data and exposes check status to the caller. Assertions can be placed on fields/types/classes, chained, and expressed over nested data ([Checks and Asserts](https://docs.boundaryml.com/guide/baml-advanced/checks-and-asserts)). Parse and assertion failures surface as `BamlValidationError`, including the prompt, raw model output, a human-readable message, and detailed history across retry/fallback attempts ([BamlValidationError](https://docs.boundaryml.com/ref/baml_client/errors/baml-validation-error)).

That strict/advisory split is more useful than silently coercing everything: applications can require invariants for correctness while retaining soft quality signals.

### Resilience is client composition around the parser

A `retry_policy` attaches constant-delay or exponential-backoff network retries to a client ([retry policies](https://docs.boundaryml.com/ref/llm-client-strategies/retry-policy)). A fallback client tries an ordered list of clients and can itself have a retry policy; fallback strategies can be nested ([fallback client](https://docs.boundaryml.com/ref/llm-client-strategies/fallback)). Round-robin clients provide load distribution and rotate on retries ([round robin](https://docs.boundaryml.com/ref/llm-client-strategies/round-robin)). Runtime `ClientRegistry` overrides can replace the function's configured client without regenerating code ([Client Registry](https://docs.boundaryml.com/ref/baml_client/client-registry)).

Timeouts distinguish connect, time-to-first-token, inter-chunk idle, and total request time, while application cancellation remains separate ([timeouts](https://docs.boundaryml.com/guide/baml-basics/timeouts)). These are valuable BAML capabilities, but they are transport/runtime concerns rather than parsing features.

### Runtime schemas can change without abandoning the pipeline

`TypeBuilder` can extend types marked `@@dynamic`, add runtime classes/enums, attach descriptions, and pass the resulting registry into a call; the changed type is used when building the prompt's output schema ([Dynamic Types / TypeBuilder](https://docs.boundaryml.com/guide/baml-advanced/dynamic-types)). This keeps dynamic classification/tool lists aligned with parsing. For Yomi, Zod already provides runtime schemas, so the analogous missing feature is not a new type builder—it is using the same Zod tree to render model-facing format instructions.

### Observability and tests retain raw evidence

The local `Collector` exposes function logs, raw HTTP requests/responses, SSE data, timings, token usage, retries, and fallbacks; cumulative usage includes retry/fallback tokens ([Collector](https://docs.boundaryml.com/ref/baml_client/collector)). Terminal log levels can expose prompts, raw responses, parsed responses, requests, and detailed parse errors ([terminal logs](https://docs.boundaryml.com/guide/development/terminal-logs)). Optional Boundary Studio tracing adds typed inputs/outputs and custom traced application functions ([Boundary Studio](https://docs.boundaryml.com/guide/boundary-cloud/observability/tracking-usage)).

Tests are declarations beside BAML functions, with arguments, assertions, optional dynamic type builders, filtering, parallel execution, and CI modes ([BAML tests](https://docs.boundaryml.com/ref/baml/test), [`baml test` CLI](https://docs.boundaryml.com/ref/baml-cli/test)). The transferable idea is a durable corpus containing raw output, expected value/failure, and expected diagnostics—not only isolated coercer unit tests.

## Yomi today: relevant strengths and gaps

Yomi is intentionally much smaller. It currently:

- extracts markdown or a balanced object/array from surrounding text;
- tries strict `JSON.parse`, then `jsonrepair`;
- recursively dispatches over Zod v4 types;
- performs permissive primitive/container/enum coercions;
- records transformation flags and path-local failures.

That is a useful parser core and a better fit for embedding in existing TypeScript/provider stacks than adopting BAML's compiler and runtime wholesale. However, repository inspection shows these gaps.

### 1. Successful coercion is not equivalent to successful Zod validation

The public result is typed as `z.infer<T>`, but `parse`/`coerce` returns the custom coercer's result without a final `schema.safeParse`. Consequently Zod refinements/checks, min/max constraints, regex/email/URL constraints, transforms, brands, and some pipe semantics can be skipped or incorrectly simulated. For example, `ZodPipe` is handled by coercing through its input and output schema rather than executing Zod's transform/refinement pipeline.

This should be fixed before streaming, because the final stream value must have a stronger contract than partial values.

### 2. Union selection is first-success, not best-match

`coerceUnion` tries variants in declaration order and returns the first success. Because coercion is broad, ordering can change meaning: a number can become a string before the numeric branch is considered. Discriminated unions are routed through the same generic path instead of selecting by discriminator first. BAML's schema-aligned candidate-selection idea suggests scoring candidates by exactness, coercion cost, discriminator evidence, required-field coverage, ignored keys, and validation outcome.

### 3. Diagnostics are an unstructured success flag list or one terminal failure

Flags explain transformations but have no path on most entries, no severity/cost, no rejected-candidate diagnostics, and no distinction between “repaired because stream is incomplete” and “repaired malformed final output.” Only the first terminal coercion error survives. This limits observability and makes safe streaming decisions difficult.

### 4. There is no partial-data vocabulary

A normal `parse` failure only says that required data is missing. Streaming needs at least three states: absent/not observed, present but incomplete/unstable, and complete. JavaScript `undefined` alone cannot communicate why a value is absent, and `Partial<z.infer<S>>` is shallow and loses element/union semantics.

### 5. Extraction is batch-oriented

`parseJson` reparses an entire string and the extraction helpers are private/stateless. A streaming API needs an accumulator, correct escaped-string/fence state across chunks, optional emission deduplication, cancellation-neutral cleanup, and finalization that changes incomplete-prefix tolerance into strict final behavior.

## Recommended Yomi design

### Phase 0 — make the non-streaming contract trustworthy

Add a mandatory final `schema.safeParse` after coercion. Preserve Zod issues with paths and codes in a structured error tree. Decide explicitly how transforms are handled: preferably coerce into the input shape, then let Zod execute validation/transforms exactly once.

Replace first-success unions with scored candidates. A reasonable initial deterministic cost model is:

- exact type / exact literal / exact discriminator: 0;
- harmless syntax repair or case-insensitive alias: low cost;
- scalar conversion: medium cost;
- container wrapping/unwrapping, default insertion, or ignored keys: higher cost;
- failed Zod validation: ineligible for a final result.

Return ambiguity when equal-cost candidates yield materially different values, or expose the chosen and rejected candidates in diagnostics.

### Phase 1 — streaming parser core

Add a stateful API over arbitrary text chunks, independent of any LLM SDK:

```ts
const stream = createParseStream(schema, options)
stream.push(textChunk)       // returns zero or one new snapshots
stream.snapshot()           // current partial snapshot
stream.finish()             // strict ParseResult<z.output<S>>
```

Also provide a convenience adapter:

```ts
for await (const update of parseStream(schema, asyncTextIterable, options)) {
  // update.kind === "partial" | "final"
}
```

Keep provider adapters out of core. OpenAI/Anthropic/Vercel streams can map their text deltas to `AsyncIterable<string>` in separate entry points.

On each push, maintain lexical state and attempt recovery only when new structural evidence arrives (object key/value boundary, comma, close delimiter, or configurable character/time threshold), not necessarily on every token. Initially, whole-buffer reparsing is acceptable for correctness; preserve the API so the implementation can later add checkpoints/incremental AST reuse.

### Phase 2 — explicit deep partial semantics

Do not claim each snapshot satisfies the original Zod schema. Define a runtime partial node and a matching TypeScript projection:

```ts
type FieldState = "absent" | "incomplete" | "complete"

interface StreamField<T> {
  state: FieldState
  value?: T
  diagnostics: Diagnostic[]
}
```

Snapshots should be immutable and revisioned. Emit only when the semantic value or field state changes. The final result must be a separate strict result, matching BAML's separation between `partial_types` and the original output type.

Useful default stability rules:

- objects/lists may grow incrementally;
- strings may grow incrementally;
- numbers, booleans, nulls, literals, enum values, dates, and discriminators are atomic until lexically complete;
- a union object is withheld until a unique variant is selected with sufficient evidence;
- previously complete atomic fields never mutate within an attempt; if evidence contradicts them, downgrade/replace only under an explicit `mutable` policy and emit a diagnostic.

### Phase 3 — Zod-native semantic streaming policies

BAML can add DSL annotations; Yomi should avoid reaching into fragile Zod internals for custom metadata. Offer an options tree keyed by schema path, plus optional helper metadata if Zod's public metadata API is stable:

```ts
createParseStream(schema, {
  fields: {
    "title": { reveal: "complete", requiredForParent: true },
    "content": { state: true },
    "items.*": { reveal: "complete" },
  },
})
```

These correspond to BAML's `@stream.done`, `@stream.not_null`, and `@stream.with_state`, without copying its language syntax. Support a discriminator-first shortcut for `z.discriminatedUnion`.

### Phase 4 — capabilities beyond streaming

1. **Zod-to-prompt renderer.** Generate a compact model-facing schema from the same Zod tree. Include object keys, optionality, literals/enums, descriptions, and aliases. Keep formatting pluggable (compact BAML-like text, JSON Schema, provider-native schema). This is the most valuable non-streaming BAML idea because it prevents prompt/parser drift.
2. **Alias and description mapping.** Allow model-facing aliases to parse back to canonical object keys and enum values; record the mapping in diagnostics.
3. **Strict vs advisory checks.** Zod validation remains strict; add optional advisory checks that return data with named warnings. Never silently discard failed checks.
4. **Structured diagnostics.** Every repair/coercion should include code, path, original value/span when available, chosen value, severity, cost, and streaming state. Preserve all union candidate failures.
5. **Budgets and safety limits.** Add maximum input bytes, nesting depth, collection size, repair attempts, candidates, and elapsed parsing time to protect servers from pathological streams.
6. **Corpus/replay tests.** Store messy real outputs and every prefix boundary; assert final correctness, snapshot invariants, monotonicity, ambiguity behavior, and diagnostic stability. Fuzz arbitrary chunk boundaries, truncated strings, escapes, markdown fences, mixed prose, nested unions, and huge inputs.
7. **Optional observability hooks.** Expose `onDiagnostic`, `onSnapshot`, timing, bytes buffered, repair count, and candidate count. Do not send data anywhere from the core library.

## What not to copy into Yomi core

- Provider clients, retry/backoff, fallbacks, round robin, HTTP/SSE collection, token accounting, and hosted traces. They broaden Yomi from a composable parser into an LLM framework.
- Code generation. TypeScript plus runtime Zod schemas already give Yomi the source of truth it needs. A deep-partial type utility and runtime node model are sufficient.
- A new DSL. Zod is Yomi's adoption advantage.
- Silent “best effort” final success. Tolerance should produce a candidate; Zod must decide whether the final value is valid.

## Proposed acceptance criteria for streaming v1

- Accept arbitrary chunk boundaries, including inside escapes, Unicode sequences, property names, numbers, and markdown fences.
- Produce immutable, typed partial snapshots without claiming they satisfy the final schema.
- Never expose an incomplete number, enum, literal, boolean, null, date, or discriminator as complete.
- Withhold discriminated-union objects until a unique variant is known.
- Support atomic list elements and per-field completion state.
- Deduplicate semantically identical snapshots.
- `finish()` either returns a value that passes the original Zod schema—including refinements/transforms—or a structured error with raw input and all relevant diagnostics.
- Enforce configurable resource limits.
- Pass a prefix-replay suite for every existing parse/coercion fixture and fuzzed chunk boundaries.

## Bottom line

BAML's strongest transferable design is the closed schema loop and the distinction between **recoverable partial interpretation** and **strict final validity**. If Yomi first repairs its final Zod-validation contract, then adds stateful parsing plus semantic reveal policies, it can provide BAML-like structured streaming while remaining a small provider-neutral library. The next best improvements are scored union resolution, prompt-schema rendering, aliases/descriptions, structured diagnostics, and corpus replay testing.
