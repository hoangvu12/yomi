# BAML capability audit and Yomi product map

Research date: 2026-08-27. This report uses only BoundaryML's official documentation and the official `BoundaryML/baml` repository. Source-code observations are pinned to canary commit [`22d0f22`](https://github.com/BoundaryML/baml/tree/22d0f22de9bee969ac5816faa49290f9126742d2). “BAML guarantees” below means documented behavior; “source observation” means behavior visible in that revision and therefore more likely to change.

## Decision in one page

BAML's advantage is not simply tolerant JSON repair. It closes a loop:

1. one type graph drives generated application types;
2. the same graph renders compact model-facing instructions through `ctx.output_format`;
3. a permissive parser produces multiple syntactic candidates;
4. schema-directed coercion scores interpretations and chooses a candidate;
5. streaming carries lexical completion through the parsed tree, then semantic policies decide what is safe to reveal;
6. strict/advisory validation, typed failures, retries, tests, and raw-call observability surround the result.

The official overview describes a BAML function as a typed prompt callable through a generated client, and the generated client as responsible for the provider call, tolerant parsing, typed conversion, and errors ([repository overview](https://github.com/BoundaryML/baml/tree/22d0f22de9bee969ac5816faa49290f9126742d2#baml-basically-a-made-up-language), [generated client](https://docs.boundaryml.com/guide/introduction/baml_client)).

Yomi should copy the closed schema/parse loop and semantic streaming, but remain a provider-neutral Zod library. The recommended boundary is:

- **Core now:** completion-aware streaming, reveal policies equivalent to `done`/`not_null`/`with_state`, scored unions, structured diagnostics, aliases/descriptions, safety budgets, final Zod validation, and a compact Zod-to-prompt renderer.
- **Core later:** richer candidate extraction/scoring, advisory checks, replay/fuzz harness, incremental parse checkpoints, schema fingerprints, and stable diagnostic spans.
- **Optional package:** provider stream adapters, request collectors, tracing bridges, retry/fallback helpers, and evaluation runners.
- **Reject from Yomi:** a new DSL/compiler, generated clients, model registry/orchestration, hosted tracing, prompt optimizer, and deployment server.

## 1. Compiler, schema model, and generated clients

BAML source declares functions, clients, classes, enums, aliases, and attributes. The compiler resolves this into an intermediate type graph and generators emit host-language clients/types. Both synchronous and asynchronous clients are generated with the same public function surface ([client API](https://docs.boundaryml.com/ref/baml_client/client)). Generator configuration pins a runtime version, and `baml-cli generate` checks generator/CLI compatibility unless explicitly bypassed; production generation can strip embedded tests ([client generation](https://docs.boundaryml.com/guide/introduction/baml_client), [`baml-cli generate`](https://docs.boundaryml.com/ref/baml-cli/generate)).

The important design property is not code generation itself. It is that BAML's compiler owns a normalized schema graph used by prompt rendering, parsing, streaming-type projection, and generated output types. The repository makes this separation visible in its IR types, streaming conversion, prompt renderer, JSONish parser, runtime, and language generators ([streaming type converter](https://github.com/BoundaryML/baml/blob/22d0f22de9bee969ac5816faa49290f9126742d2/engine/baml-lib/baml-types/src/ir_type/converters/streaming.rs), [prompt renderer](https://github.com/BoundaryML/baml/tree/22d0f22de9bee969ac5816faa49290f9126742d2/engine/baml-runtime/src/internal/prompt_renderer), [JSONish](https://github.com/BoundaryML/baml/tree/22d0f22de9bee969ac5816faa49290f9126742d2/engine/baml-lib/jsonish/src)).

### Yomi decision

**Reject compiler/codegen; core now: normalized schema inspection.** Zod already supplies runtime schemas and inferred TypeScript types. Yomi needs a stable internal `SchemaNode`, not a language:

```ts
interface SchemaNode {
  kind: string;
  path: SchemaPath;
  optional: boolean;
  description?: string;
  aliases: readonly string[];
  children: readonly SchemaNode[];
  stream: StreamPolicy;
}
```

Build this once per parser and cache it in a `WeakMap<ZodType, CompiledSchema>`. Complexity **medium**; risk **medium-high** because Zod internals change. Mitigate by isolating version-sensitive inspection behind one module and testing supported Zod minors.

## 2. `ctx.output_format`: keeping prompt and parser aligned

`{{ ctx.output_format }}` renders the return schema into the prompt. BAML uses compact “type definitions”/JSONish rather than verbose JSON Schema, can hoist recursive classes, and exposes rendering options such as a custom class prefix ([output-format reference](https://docs.boundaryml.com/ref/prompt-syntax/ctx-output-format), [official source page](https://github.com/BoundaryML/baml/blob/22d0f22de9bee969ac5816faa49290f9126742d2/fern/03-reference/baml/prompt-syntax/output-format.mdx)). Prompt rendering is part of the normal function call, so runtime `TypeBuilder` changes appear in the output schema sent to the model ([dynamic types](https://docs.boundaryml.com/guide/baml-advanced/dynamic-types)).

Aliases rename model-facing fields or enum values while preserving application-facing names and also participate in parsing. Descriptions add semantic guidance to rendered fields/values; enum values may additionally be skipped from both prompt and parsing ([class fields](https://docs.boundaryml.com/ref/baml/class), [enums](https://docs.boundaryml.com/ref/baml/enum)).

### Yomi decision

**Core now.** Add a renderer that consumes the exact compiled schema used by parsing:

```ts
renderFormat(schema, {
  style: "compact",              // later: "json-schema"
  includeDescriptions: true,
  instruction: "Answer in JSON using this schema:",
}): { text: string; fingerprint: string }
```

Use Zod's public description/metadata facilities where possible. Define Yomi-owned metadata for aliases and stream policies:

```ts
const Result = z.object({
  displayName: yomi(z.string()).alias("name").describe("Full human name"),
});
```

Parser lookup must accept canonical name plus aliases, prefer an exact canonical key over an alias, and diagnose collisions. Complexity **medium**; risk **medium** (recursive types, transforms, unions, metadata compatibility). This is the highest-value non-streaming feature because it prevents prompt/schema drift.

## 3. JSONish/SAP: candidate generation, coercion, and scoring

BAML's documented Schema-Aligned Parsing accepts imperfect structured output and uses the desired schema to recover a typed result instead of relying exclusively on provider-native constrained decoding ([Why BAML](https://docs.boundaryml.com/guide/introduction/why-baml), [chain-of-thought example](https://docs.boundaryml.com/examples/prompt-engineering/chain-of-thought)).

The implementation is a two-stage search:

1. **Syntactic candidate generation.** It first tries strict JSON, then markdown extraction, multiple-object extraction, a fixing parser, and finally raw-string interpretation when enabled. Multiple code blocks/objects can yield each item, an array candidate, and surrounding text as alternative candidates. Recursion is capped at depth 100 in this parser path ([parser entry](https://github.com/BoundaryML/baml/blob/22d0f22de9bee969ac5816faa49290f9126742d2/engine/baml-lib/jsonish/src/jsonish/parser/entry.rs), [fixing parser](https://github.com/BoundaryML/baml/tree/22d0f22de9bee969ac5816faa49290f9126742d2/engine/baml-lib/jsonish/src/jsonish/parser/fixing_parser)).
2. **Schema-directed interpretation.** Each candidate is coerced against the target IR. Flags record operations such as defaults, extra keys, substring matching, implied keys, scalar conversion, single-to-array, markdown extraction, and incomplete/pending state. Lower scores are better; missing required defaults are heavily penalized, while ordinary scalar conversions and extra keys are cheap. Child list/class scores are multiplied, making nested repair costs significant ([score table](https://github.com/BoundaryML/baml/blob/22d0f22de9bee969ac5816faa49290f9126742d2/engine/baml-lib/jsonish/src/deserializer/score.rs), [deserializer flags](https://github.com/BoundaryML/baml/blob/22d0f22de9bee969ac5816faa49290f9126742d2/engine/baml-lib/jsonish/src/deserializer/deserialize_flags.rs)).

For unions, BAML tries variants, immediately accepts the first zero-cost match, otherwise chooses the lowest-scoring result. Arrays of unions may use the previous element's variant as a fast hint, but only short-circuit when that hint scores zero. Tie-breaking includes special cases that prefer real arrays over single-to-array conversions, parsed content over raw markdown strings, non-default objects, composite values over objects stringified into scalars, then score and declaration index ([union coercion](https://github.com/BoundaryML/baml/blob/22d0f22de9bee969ac5816faa49290f9126742d2/engine/baml-lib/jsonish/src/deserializer/coercer/coerce_union.rs), [`pick_best`](https://github.com/BoundaryML/baml/blob/22d0f22de9bee969ac5816faa49290f9126742d2/engine/baml-lib/jsonish/src/deserializer/coercer/array_helper.rs)). This is deterministic, but it is not a formal probabilistic confidence measure and equal zero-cost matches retain declaration-order sensitivity.

### Yomi decision

**Core now: scored unions and candidate diagnostics. Core later: full multi-candidate extraction.**

```ts
interface Candidate<T = unknown> {
  value?: T;
  source: { kind: "strict" | "fence" | "balanced" | "repair" | "raw"; span?: Span };
  cost: number;
  diagnostics: Diagnostic[];
  valid: boolean;
}

type UnionResolution =
  | { kind: "selected"; index: number; candidates: Candidate[] }
  | { kind: "ambiguous"; candidates: Candidate[] }
  | { kind: "none"; candidates: Candidate[] };
```

Initial costs should favor exact input types/discriminators, then aliases/case normalization, then scalar coercions, container reshaping/defaults, with final Zod failure ineligible. Unlike BAML's current early zero-score shortcut, Yomi should test all union variants when ambiguity reporting is enabled. Complexity **medium**; risk **high** because scoring changes are semantic and may break existing permissive cases. Ship behind `unionMode: "legacy" | "scored"` for one release, record chosen/rejected candidates, then make scored resolution default.

Full SAP parity is **core later, high complexity/high risk**: malformed quoting, comments, multiple competing objects, implied structures, fuzzy enum/string matching, and prose extraction interact combinatorially. Build from a corpus rather than attempting a rewrite all at once.

## 4. Streaming architecture and partial types

BAML streams parsed snapshots, not raw text only. Generated streaming types are distinct from final return types: ordinary fields become nullable/deep-partial, while `getFinalResponse()` returns the original final type. TypeScript exposes the stream as an async iterable and accepts cancellation signals ([streaming guide](https://docs.boundaryml.com/guide/baml-basics/streaming)).

The source parser attaches `Complete` or `Incomplete` to JSONish values. A standalone number remains incomplete during a live stream, while a number followed by a closing list delimiter becomes complete; incomplete nested arrays preserve completion independently at each node ([parser and completion tests](https://github.com/BoundaryML/baml/blob/22d0f22de9bee969ac5816faa49290f9126742d2/engine/baml-lib/jsonish/src/jsonish/parser/entry.rs)). Coercion converts parser evidence into `Incomplete`/`Pending` flags, and the semantic pass distributes the expected type across the value tree before applying reveal behavior ([semantic streaming implementation](https://github.com/BoundaryML/baml/blob/22d0f22de9bee969ac5816faa49290f9126742d2/engine/baml-lib/jsonish/src/deserializer/semantic_streaming.rs)).

This yields a critical lesson: JSON repair alone cannot implement safe semantic streaming. A repaired closing quote or bracket must not be confused with a delimiter actually emitted by the model.

### `@stream.done`

Documented behavior: withhold the annotated value until it is complete; strings otherwise grow incrementally; numbers are always atomic. On list element/union types it makes completed elements/variants appear atomically, and a union annotation propagates to variants ([semantic streaming](https://docs.boundaryml.com/guide/baml-basics/streaming#streamdone)).

Source observation: `required_done` is inherent for integers, floats, booleans, null, media, literals, and enums, but not strings, classes, lists, maps, tuples, recursive aliases, or unions as a category. Mixed unions inspect the currently inferred variant. An incomplete required-done node is rejected from the partial tree; a list filters rejected children, while a class replaces a rejected field with a pending/null placeholder ([semantic streaming implementation](https://github.com/BoundaryML/baml/blob/22d0f22de9bee969ac5816faa49290f9126742d2/engine/baml-lib/jsonish/src/deserializer/semantic_streaming.rs)). The generated streaming-type converter also propagates `done` into list/map elements and union variants ([streaming type converter](https://github.com/BoundaryML/baml/blob/22d0f22de9bee969ac5816faa49290f9126742d2/engine/baml-lib/baml-types/src/ir_type/converters/streaming.rs)).

### `@stream.not_null`

Documented behavior: the containing object is withheld until the annotated field has a value; it is intended for discriminators or required metadata. In type projection, `T @stream.not_null` becomes `Partial<T>` rather than `Partial<T>?` ([semantic streaming](https://docs.boundaryml.com/guide/baml-basics/streaming#streamnot_null)).

Source observation: semantic validation collects required field names for a class, recursively processes their values, treats a null required field (and an all-null required class) as absent, and rejects the entire class when any required field is missing. `not_null` only affects streaming; the non-streaming pass ignores it ([semantic streaming implementation](https://github.com/BoundaryML/baml/blob/22d0f22de9bee969ac5816faa49290f9126742d2/engine/baml-lib/jsonish/src/deserializer/semantic_streaming.rs)).

### `@stream.with_state`

Documented behavior: wrap the projected partial value in `StreamState`, with state `"incomplete" | "complete"`, for UI loading states. The final non-streaming return type is unchanged ([semantic streaming and type table](https://docs.boundaryml.com/guide/baml-basics/streaming#streamwith_state)).

Source observation: the semantic pass computes three internal states—`Pending`, `Incomplete`, and `Complete`—but exposes wrapper metadata only where requested. Missing fields receive pending null fillers; language serialization decides how partial/null values and state wrappers are represented ([completion types](https://github.com/BoundaryML/baml/blob/22d0f22de9bee969ac5816faa49290f9126742d2/engine/baml-lib/baml-types/src/baml_value.rs), [semantic streaming](https://github.com/BoundaryML/baml/blob/22d0f22de9bee969ac5816faa49290f9126742d2/engine/baml-lib/jsonish/src/deserializer/semantic_streaming.rs)).

### Yomi decision and API

**Core now, high priority.** Keep current `DeepPartial<T>` snapshots for compatibility, but add semantic snapshots and a completion tree:

```ts
type Completion = "pending" | "incomplete" | "complete";
type StreamState<T> = { value: T | undefined; state: Completion };

createStreamParser(schema, {
  fields: {
    score: { reveal: "complete" },        // done
    kind: { requiredForParent: true },     // not_null
    body: { withState: true },             // with_state
    "items.*": { reveal: "complete" },
  },
  atomic: "safe-defaults",
});
```

Semantics:

- numbers, booleans, null, literals, enums, dates, and discriminators are atomic by default;
- `reveal: "complete"` applies to the entire node and recursively prevents partial descendants from leaking;
- `requiredForParent` is evaluated after reveal filtering and withholds the nearest containing object if the field is absent or null;
- `withState` reports pending/incomplete/complete without changing `finish()`'s output type;
- completed list elements may be emitted while the final list remains incomplete;
- finalization reparses with `isFinal: true` and must pass the original Zod pipeline.

Implementation milestone S1 (**medium/high risk**) is a stateful lexer carrying quote/escape/fence/container state across chunks and annotating observed versus synthetic delimiters. S2 (**medium**) projects completion through Zod nodes. S3 (**medium**) applies reveal policies and wildcard paths. S4 (**medium**) adds immutable revisions, snapshot deduplication, and arbitrary-byte-boundary fuzz tests. S5 (**high**) integrates union confidence and prevents variant flicker.

Do not expose only BAML's public two-state wrapper. Yomi should retain `pending` because “not observed” is materially different from “growing,” even if a compatibility helper collapses pending to `undefined`.

## 5. Checks, assertions, and validation

BAML distinguishes strict `@assert` from advisory `@check`. A failed top-level assertion throws; invalid members may be removed from containers. Checks retain the value and expose named pass/fail status. Assertions/checks may live on fields, types, or classes and use expressions over `this`; chained assertions evaluate left-to-right ([checks and asserts](https://docs.boundaryml.com/guide/baml-advanced/checks-and-asserts)).

### Yomi decision

Zod validation/refinements remain **core now and authoritative**. Add advisory checks **core later**:

```ts
parse(schema, input, {
  checks: [check("citation_present", value => hasCitation(value))],
});
// success includes checks: Record<string, { status: "succeeded" | "failed"; message?: string }>
```

Never copy BAML's container-member deletion as a default; it can silently change cardinality and meaning. If offered, call it `invalidItem: "drop"` and make it explicit. Complexity **low-medium**; risk **medium**. Checks must not run on unstable stream values unless declared `runOn: "partial"`.

## 6. Dynamic types

Types marked `@@dynamic` can be extended at runtime through `TypeBuilder`; callers can add enum values, class properties, aliases/descriptions, or entirely new types, then pass the builder into a call. The modified graph is used when rendering the prompt and parsing the answer. Tests can define per-test dynamic extensions ([dynamic types guide](https://docs.boundaryml.com/guide/baml-advanced/dynamic-types), [TypeBuilder reference](https://docs.boundaryml.com/ref/baml_client/type-builder)).

### Yomi decision

**Reject a TypeBuilder clone.** Zod schemas are already runtime values. The transferable requirement is that `renderFormat`, `parse`, and `createStreamParser` receive the same schema object/config and expose a deterministic `schemaFingerprint`. Cache compilation by schema identity plus metadata revision. Complexity **low-medium**; risk **low**.

## 7. Runtime clients, resilience, timeouts, and cancellation

BAML's runtime abstracts provider clients and lets `ClientRegistry` add/override clients and select a call's primary client at runtime ([LLM clients](https://docs.boundaryml.com/ref/baml/client-llm), [Client Registry](https://docs.boundaryml.com/ref/baml_client/client-registry)). A retry policy handles network failures using constant delay or exponential backoff. Ordered fallbacks and round-robin strategies can be nested; retrying a round-robin rotates clients, while a retry policy attached to a fallback retries the composite after its full chain fails ([retries](https://docs.boundaryml.com/ref/llm-client-strategies/retry-policy), [fallback](https://docs.boundaryml.com/ref/llm-client-strategies/fallback), [round robin](https://docs.boundaryml.com/ref/llm-client-strategies/round-robin)).

BAML documents granular request timeouts, including connect/request/stream lifecycle controls and a composite-strategy timeout. User cancellation is separate and surfaces as `BamlAbortError`; TypeScript uses `AbortSignal` ([timeouts](https://docs.boundaryml.com/guide/baml-basics/timeouts), [abort signals](https://docs.boundaryml.com/guide/baml-basics/abort-signal)).

### Yomi decision

- **Core now:** accept arbitrary `AsyncIterable<string | Uint8Array>` and remain cancellation-neutral; generator cleanup must release references. Add parser-side `maxInputBytes`, `maxDepth`, `maxCandidates`, `maxCollectionItems`, and optional `signal` only for CPU-bound parsing.
- **Optional adapters later:** `@yomi/openai`, `@yomi/anthropic`, `@yomi/vercel-ai` convert provider events into text chunks and preserve provider cancellation.
- **Reject:** clients, retry/fallback/round-robin, HTTP timeouts, token accounting. Those belong to orchestration libraries.

Transport adapters are medium complexity/medium maintenance risk. A general client runtime is very high complexity and would erase Yomi's composability.

## 8. Errors and diagnostics

BAML exposes validation, disallowed finish-reason, client/HTTP, and abort errors. `BamlValidationError` includes prompt, raw output, and a detailed message that aggregates failed retry/fallback attempts; fallback error type follows the final failed attempt ([error hierarchy](https://docs.boundaryml.com/ref/baml_client/errors/overview), [validation error](https://docs.boundaryml.com/ref/baml_client/errors/baml-validation-error)). Internally, JSONish carries parsing flags/errors, but the public validation shape is primarily string-oriented rather than a stable machine-readable candidate tree.

### Yomi decision

**Core now.** Yomi can improve on BAML here:

```ts
interface Diagnostic {
  code: string;
  path: (string | number)[];
  phase: "extract" | "repair" | "coerce" | "stream" | "validate";
  severity: "info" | "warning" | "error";
  cost: number;
  message: string;
  span?: { start: number; end: number };
  candidate?: number;
  cause?: unknown;
}
```

Errors should preserve raw input subject to configurable redaction/truncation, all Zod issues, chosen/rejected candidates, repair budgets, schema fingerprint, and whether failure happened during partial or final parsing. Complexity **medium**; risk **medium** (API permanence and sensitive data).

## 9. Testing, evaluations, and prompt optimization

BAML tests are first-class declarations with function lists, arguments, assertions/checks, optional type builders, filters, configurable parallelism, and CI behavior for human evaluation ([test declaration](https://docs.boundaryml.com/ref/baml/test), [`baml test`](https://docs.boundaryml.com/ref/baml-cli/test)). BAML also has a beta prompt optimizer that evaluates generated prompt candidates against tests and can trade accuracy against input tokens ([prompt optimization](https://docs.boundaryml.com/guide/baml-advanced/prompt-optimization)).

### Yomi decision

- **Core now:** prefix replay for every fixture; split every string at every byte boundary; assert strict final equivalence, atomic invariants, withheld-parent rules, monotonic completion, and no duplicate semantic snapshots.
- **Core later:** corpus format containing raw model text, schema fixture, expected candidate/value/failure, expected diagnostics, and resource-budget outcome.
- **Optional package:** an evaluation runner that can replay provider recordings.
- **Reject:** LLM-driven prompt optimization. It is an application/evaluation concern, not parsing.

Testing complexity is **medium** and product risk reduction is **very high**. Fuzz malformed escapes, Unicode, fences, prose, deep nesting, repeated keys, large arrays, ambiguous unions, transforms/refinements, and adversarial repair inputs.

## 10. Collectors, tracing, and privacy

BAML's local `Collector` exposes raw HTTP requests/responses, SSE data, calls across retries/fallbacks, timings, selected call, token usage, and tags. Cumulative usage includes retry/fallback consumption ([Collector](https://docs.boundaryml.com/ref/baml_client/collector)). The repository states that BAML is open source/offline and makes no network requests beyond explicitly configured model calls ([official repository](https://github.com/BoundaryML/baml/tree/22d0f22de9bee969ac5816faa49290f9126742d2#fully-open-source-and-offline)). Optional cloud tracing is a separate capability.

### Yomi decision

**Core later:** local, synchronous hooks only:

```ts
interface ParseObserver {
  onCandidate?(event: CandidateEvent): void;
  onSnapshot?(event: SnapshotEvent): void;
  onDiagnostic?(diagnostic: Diagnostic): void;
  onFinish?(metrics: ParseMetrics): void;
}
```

No telemetry or network dependency in core. An **optional adapter** may emit OpenTelemetry spans, but raw prompts/outputs must be opt-in and redacted by default. Complexity **low-medium**; privacy risk **high** if defaults are careless.

## 11. Deployment, compatibility, and versioning

BAML can generate language clients or serve functions over HTTP. Its Docker guidance recommends regenerating clients during builds and keeping extension/CLI/runtime package versions aligned; committing generated clients is possible but version skew must be managed ([Docker deployment](https://docs.boundaryml.com/guide/development/deploying/docker), [`generate`](https://docs.boundaryml.com/ref/baml-cli/generate)). Streaming HTTP routes exist in `baml-cli serve`, but the official streaming page notes that partial streaming definitions are not currently represented in generated OpenAPI schemas ([streaming OpenAPI note](https://docs.boundaryml.com/guide/baml-basics/streaming)).

### Yomi decision

**Core later:** publish a compatibility table for supported Zod versions; include `schemaFingerprint`, parser version, and policy version in diagnostics/recordings. **Reject:** server/deployment framework. Yomi should remain ordinary ESM package code usable in Node, edge, browser, and worker environments. Avoid Node-only APIs in core.

## 12. Security and resource limits

The official material establishes privacy posture and one concrete parser recursion limit: BAML runs locally except for configured model calls, and JSONish's recursive parse path stops beyond depth 100 ([repository privacy statement](https://github.com/BoundaryML/baml/tree/22d0f22de9bee969ac5816faa49290f9126742d2#fully-open-source-and-offline), [parser depth check](https://github.com/BoundaryML/baml/blob/22d0f22de9bee969ac5816faa49290f9126742d2/engine/baml-lib/jsonish/src/jsonish/parser/entry.rs)). The reviewed official docs do not define a comprehensive public set of JSONish limits for bytes, candidate count, collection size, or CPU time. Therefore those limits must not be inferred as BAML guarantees.

### Yomi decision

**Core now, release-blocking for untrusted server input.**

```ts
interface ParseLimits {
  maxInputBytes: number;       // finite default
  maxDepth: number;
  maxCandidates: number;
  maxCollectionItems: number;
  maxDiagnostics: number;
  maxRepairAttempts: number;
  deadlineMs?: number;
}
```

Reject prototype-polluting keys or construct null-prototype records; never dynamically evaluate schema text or model output; bound diagnostic/raw-input retention; use `TextDecoder` streaming mode for split UTF-8; treat aliases as data, not property paths. Complexity **medium**; security risk without it **high**.

## Capability classification matrix

| Capability | Yomi placement | Priority | Complexity | Main risk | Concrete milestone |
|---|---|---:|---:|---|---|
| Final Zod validation/transforms | Core now | P0 | Low-medium | false typed success/double transforms | every success passes original schema exactly once |
| Stateful lexical completion | Core now | P0 | High | synthetic repair mistaken for emitted delimiter | completion tree across arbitrary byte chunks |
| Atomic scalar defaults | Core now | P0 | Medium | transient wrong UI values | numbers/literals/enums/discriminators never leak incomplete |
| `done` equivalent | Core now | P0 | Medium | descendant partial leakage | `reveal: "complete"` on fields/elements/unions |
| `not_null` equivalent | Core now | P0 | Medium | wrong parent/discriminator exposure | `requiredForParent` after reveal filtering |
| `with_state` equivalent | Core now | P0 | Medium | confusing absent vs incomplete | three-state `StreamState<T>` |
| Snapshot dedupe/revisions | Core now | P0 | Low | render churn/mutation | immutable revisioned semantic snapshots |
| Scored unions | Core now | P0 | Medium-high | compatibility/ambiguous coercion | selected/rejected candidates and ambiguity mode |
| Structured diagnostics | Core now | P0 | Medium | API/privacy | path/phase/cost/span and bounded raw evidence |
| Parser safety budgets | Core now | P0 | Medium | CPU/memory denial of service | finite defaults and typed limit errors |
| Compact schema renderer | Core now | P1 | Medium | Zod inspection drift | `renderFormat` plus fingerprint |
| Aliases/descriptions | Core now | P1 | Medium | collisions/metadata stability | canonical-first lookup and prompt rendering |
| Full multi-candidate SAP | Core later | P1 | High | combinatorial semantics | corpus-driven extraction stages |
| Advisory checks | Core later | P2 | Low-medium | implicit filtering | named non-fatal results, no default drops |
| Replay/fuzz corpus tooling | Core later | P1 | Medium | fixture maintenance | byte-prefix invariant runner |
| Incremental AST/checkpoints | Core later | P2 | High | correctness regressions | optimize only after metrics establish need |
| Local observer hooks | Core later | P2 | Low-medium | leaking raw content | redacted/no-network observers |
| Provider stream adapters | Optional packages | P2 | Medium | provider event churn | text-delta adapters only |
| OpenTelemetry bridge | Optional package | P3 | Medium | privacy/dependency weight | opt-in redacted spans |
| Eval/replay runner | Optional package | P3 | Medium | scope growth | recorded-response runner |
| Retry/fallback/round-robin | Reject from core | — | High | framework creep | rely on provider/orchestration SDKs |
| DSL/compiler/code generation | Reject | — | Very high | duplicates Zod/TS | none |
| Hosted tracing/deployment server | Reject | — | Very high | operations/privacy | integrations only |
| Prompt optimizer | Reject | — | High | unrelated model calls | application-level tooling |

## Recommended delivery plan

### Milestone A — trustworthy parser contract

1. Lock final validation and transform-once behavior.
2. Introduce diagnostics/costs without changing successful values.
3. Add scored union mode and discriminated-union fast evidence.
4. Enforce finite input/depth/candidate/collection limits.

Exit: final results are truthful, bounded, explainable, and union-order problems have replay tests.

### Milestone B — semantic streaming v1

1. Add a lexer that records actual completion evidence across UTF-8 chunks.
2. Produce a parallel completion tree (`pending`/`incomplete`/`complete`).
3. Implement atomic defaults and `reveal: "complete"`.
4. Implement `requiredForParent` and wildcard list paths.
5. Implement `withState`, immutable snapshots, and deduplication.

Exit: prefix replay proves no incomplete atomic value or unstable discriminator reaches consumers, and `finish()` still validates the original schema.

### Milestone C — closed schema loop

1. Compile Zod into a normalized schema graph.
2. Render compact output instructions with descriptions/aliases.
3. Parse aliases back to canonical keys and diagnose collisions.
4. Fingerprint schema plus policies for recordings and caches.

Exit: one schema/config produces prompt instructions, streaming projection, final parse, and diagnostics.

### Milestone D — SAP depth and ecosystem

1. Expand candidate extraction using corpus evidence.
2. Add advisory checks and observer hooks.
3. Publish provider adapters only where users need them.
4. Optimize with checkpoints/incremental AST only after profiling whole-buffer reparsing.

## Final recommendation

Implement all three requested semantic streaming features. They are not ornamental annotations: together they form a coherent safety model—`done` controls value stability, `not_null` controls structural/variant stability, and `with_state` exposes progress without pretending partial values are final.

The bigger opportunity is to pair them with BAML's other strongest ideas: schema-to-prompt rendering, schema-scored candidate selection, aliases/descriptions, strict versus advisory validation, raw evidence and diagnostics, and prefix replay tests. Yomi can improve on BAML by exposing a three-state completion model, machine-readable rejected candidates, explicit ambiguity, and first-class parser budgets, while staying dramatically smaller by excluding provider orchestration, code generation, deployment, and hosted observability.
