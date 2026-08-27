/**
 * LLMs often return data that doesn't exactly match the expected schema.
 * Rather than failing, we coerce values to fit - but we track every
 * transformation so callers can audit what changed and detect potential issues.
 */
export enum Flag {
  // LLMs frequently return numbers as strings ("25" instead of 25)
  // because they're generating text, not typed data
  StringToNumber = "string_to_number",
  StringToBool = "string_to_bool",
  NumberToString = "number_to_string",
  BoolToString = "bool_to_string",

  // When schema expects int but LLM returns 3.7, we round rather than fail
  FloatToInt = "float_to_int",
  IntToFloat = "int_to_float",

  // JSON has null, TypeScript has undefined - we bridge the gap
  NullToUndefined = "null_to_undefined",

  // LLMs sometimes return a single item when an array is expected,
  // or vice versa - common when there's only one result
  SingleToArray = "single_to_array",
  ArrayToSingle = "array_to_single",

  // The JSON parser had to fix syntax issues (trailing commas, unquoted keys, etc.)
  JsonRepaired = "json_repaired",

  // JSON was wrapped in markdown code blocks or surrounded by explanation text
  ExtractedFromMarkdown = "extracted_from_markdown",
  ExtractedFromText = "extracted_from_text",

  // LLMs often add extra fields we didn't ask for (explanations, metadata)
  ExtraKeysIgnored = "extra_keys_ignored",
  MissingOptionalKey = "missing_optional_key",

  // Value was missing/null so we used the schema's default
  DefaultUsed = "default_used",

  // LLM returned "RED" but schema expects "red" - close enough
  EnumCaseInsensitive = "enum_case_insensitive",
  AliasUsed = "alias_used",
}

/**
 * Some flags benefit from additional context for debugging.
 * ExtraKeysIgnored tells you which keys, FloatToInt shows the precision lost.
 */
export type FlagWithContext = (
  | { flag: Flag.ExtraKeysIgnored; keys: string[] }
  | { flag: Flag.FloatToInt; original: number; rounded: number }
  | { flag: Flag.EnumCaseInsensitive; input: string; matched: string }
  | { flag: Flag.AliasUsed; input: string; matched: string }
  | { flag: Exclude<Flag, Flag.ExtraKeysIgnored | Flag.FloatToInt | Flag.EnumCaseInsensitive | Flag.AliasUsed> }) & { path?: (string | number)[] };

export function flag(f: Flag): FlagWithContext {
  return { flag: f } as FlagWithContext;
}

export function flagValues(flags: FlagWithContext[]): Flag[] {
  return flags.map((f) => f.flag);
}
