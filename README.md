# Yomi (読み)

**Yomi** (pronounced "yoh-mee", 読み) means "reading" or "interpretation" in Japanese. This library interprets messy LLM output and coerces it to match your Zod schemas.

## Version Compatibility

| Yomi Version | Zod Version | Notes |
|--------------|-------------|-------|
| 1.x | ^4.0.0 | Zod v4 support with new instanceof-based type checking |
| 0.x | ^3.20.0 | Zod v3 support (legacy) |

## The Problem

LLMs don't return perfect JSON. They return:

```json
{name: "John", age: "25",}  // unquoted keys, trailing comma
```

```
Here's the user data: {"name": "John", "age": 25}  // wrapped in text
```

```json
{"name": "John", "age": "25", "active": "yes"}  // wrong types everywhere
```

`JSON.parse()` fails. Even if it succeeds, your types are wrong.

## The Solution

Yomi uses a two-phase approach inspired by [BAML](https://docs.boundaryml.com/)'s schema-aligned parsing:

1. **Flexible JSON parsing** - Fix malformed JSON, extract from markdown/text
2. **Schema-aligned coercion** - Walk your Zod schema and coerce values to match

```ts
import { z } from "zod";
import { parse } from "@hoangvu12/yomi";

const User = z.object({
  name: z.string(),
  age: z.number(),
  active: z.boolean(),
});

const result = parse(User, `{name: "John", age: "25", active: "yes"}`);

// result.success === true
// result.data.value === { name: "John", age: 25, active: true }
// result.data.flags === ["json_repaired", "string_to_number", "string_to_bool"]
```

## Installation

```bash
npm install @hoangvu12/yomi zod
# or
bun add @hoangvu12/yomi zod
```

## API

### `parse(schema, input)`

Parse and coerce input to match schema. Returns a result object.

```ts
const result = parse(UserSchema, rawInput);

if (result.success) {
  console.log(result.data.value); // typed as z.infer<typeof UserSchema>
  console.log(result.data.flags); // what transformations happened
} else {
  console.log(result.error); // what went wrong
}
```

### `parseOrThrow(schema, input)`

Same as `parse`, but throws on failure. Returns the coerced value directly.

```ts
const user = parseOrThrow(UserSchema, rawInput);
// user is typed as z.infer<typeof UserSchema>
```

### `coerce(schema, value)` / `coerceOrThrow(schema, value)`

Skip JSON parsing, just do schema coercion on an already-parsed value.

```ts
const result = coerce(UserSchema, { name: "John", age: "25" });
```

## What It Fixes

### JSON Parsing

| Input | Fixed |
|-------|-------|
| `{name: "John"}` | Unquoted keys |
| `{"name": "John",}` | Trailing commas |
| `// comment` | Comments |
| `'single quotes'` | Single quotes |
| `` ```json {...}``` `` | Markdown code blocks |
| `Here's the data: {...}` | Surrounding text |

### Type Coercion

| From | To | Example |
|------|----|---------|
| `"123"` | `number` | `"25"` → `25` |
| `"12.5"` | `int` | `"12.5"` → `13` (rounded) |
| `123` | `string` | `123` → `"123"` |
| `"true"`, `"yes"`, `"1"` | `boolean` | → `true` |
| `"false"`, `"no"`, `"0"` | `boolean` | → `false` |
| `value` | `array` | `"x"` → `["x"]` |
| `[value]` | `single` | `["x"]` → `"x"` |
| `"PENDING"` | `enum` | Case-insensitive match |
| `null` | `undefined` | For optional fields |
| `{extra: ...}` | `object` | Extra keys ignored |

## Flags

Every transformation is tracked. Use flags to:
- Log when coercion happens in production
- Detect if defaults were used vs explicit values
- Debug why parsing succeeded unexpectedly

```ts
const result = parse(Schema, input);
if (result.success) {
  for (const flag of result.data.flags) {
    console.log(flag);
    // { flag: "string_to_number" }
    // { flag: "extra_keys_ignored", keys: ["confidence"] }
    // { flag: "float_to_int", original: 12.5, rounded: 13 }
  }
}
```

### Available Flags

| Flag | Meaning |
|------|---------|
| `json_repaired` | jsonrepair fixed the JSON |
| `extracted_from_markdown` | Extracted from `` ```json ``` `` block |
| `extracted_from_text` | Extracted JSON from surrounding text |
| `string_to_number` | `"123"` → `123` |
| `string_to_bool` | `"true"` → `true` |
| `number_to_string` | `123` → `"123"` |
| `bool_to_string` | `true` → `"true"` |
| `float_to_int` | `12.5` → `13` |
| `single_to_array` | `x` → `[x]` |
| `array_to_single` | `[x]` → `x` |
| `null_to_undefined` | `null` → `undefined` |
| `extra_keys_ignored` | Object had extra properties |
| `missing_optional_key` | Optional field was missing |
| `default_used` | Used schema's default value |
| `enum_case_insensitive` | `"PENDING"` matched `"pending"` |

## Supported Zod Types

- Primitives: `string`, `number`, `boolean`, `null`, `undefined`, `literal`
- Objects: `object`, `record`
- Arrays: `array`, `tuple`
- Unions: `union`, `discriminatedUnion`, `optional`, `nullable`
- Enums: `enum`, `nativeEnum`
- Modifiers: `default`, `catch`
- Passthrough: `any`, `unknown`

## How It Works

```
LLM Output (string)
       │
       ▼
┌─────────────────┐
│  Flexible JSON  │  ← jsonrepair + markdown extraction
│     Parser      │
└────────┬────────┘
         │ unknown
         ▼
┌─────────────────┐
│  Schema-Aligned │  ← walks Zod schema tree
│    Coercer      │
└────────┬────────┘
         │ { value: T, flags: Flag[] }
         ▼
     Result<T>
```

The coercer recursively walks your Zod schema using `instanceof` checks (Zod v4) to identify schema types, dispatching to type-specific coercion functions. Each coercer tries to interpret the input value as the expected type, recording flags when transformations occur.

## License

MIT
