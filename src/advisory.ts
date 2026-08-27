import type { Diagnostic, ParserLimits } from "./diagnostics.js";

export type AdvisoryCheckOutcome = boolean | { success: boolean; message?: string; path?: (string | number)[] };

export interface AdvisoryCheck<T> {
  /** Stable policy identity. Names must be unique within a parser invocation. */
  name: string;
  check(value: T): AdvisoryCheckOutcome;
}

export interface AdvisoryStatus {
  name: string;
  passed: boolean;
  diagnostic?: Diagnostic;
}

export interface AdvisoryReport {
  /** True only when every configured advisory check passed. */
  passed: boolean;
  checks: AdvisoryStatus[];
  /** Stable identity for the observable advisory policy (not its function source). */
  fingerprint: string;
}

const encoder = new TextEncoder();

function boundedText(value: unknown, byteLimit: number): string | undefined {
  if (byteLimit === 0) return undefined;
  const text = typeof value === "string" ? value : String(value);
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= byteLimit) return text;
  return new TextDecoder().decode(bytes.slice(0, byteLimit));
}

/** Deterministic policy fingerprint. Check names are the public, stable identities. */
export function advisoryPolicyFingerprint(checks: readonly AdvisoryCheck<unknown>[] = []): string {
  const policy = JSON.stringify(checks.map(({ name }) => name));
  let hash = 0x811c9dc5;
  for (const byte of encoder.encode(`yomi-advisory-v1:${policy}`)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `advisory-v1-${hash.toString(16).padStart(8, "0")}`;
}

export function runAdvisoryChecks<T>(
  value: T,
  checks: readonly AdvisoryCheck<T>[] | undefined,
  limits: ParserLimits,
): AdvisoryReport {
  const configured = checks ?? [];
  const names = new Set<string>();
  for (const { name } of configured) {
    if (!name.trim()) throw new TypeError("Advisory check names must not be empty");
    if (names.has(name)) throw new TypeError(`Duplicate advisory check name: ${name}`);
    names.add(name);
  }

  let retainedEvidence = 0;
  let failedDiagnostics = 0;
  const statuses = configured.map(({ name, check }): AdvisoryStatus => {
    let outcome: AdvisoryCheckOutcome;
    let thrown: unknown;
    try { outcome = check(value); }
    catch (error) { outcome = false; thrown = error; }
    const passed = typeof outcome === "boolean" ? outcome : outcome.success;
    if (passed) return { name, passed: true };

    if (failedDiagnostics >= limits.maxDiagnostics) return { name, passed: false };
    failedDiagnostics++;
    const detail = thrown instanceof Error ? thrown.message : thrown !== undefined ? thrown : typeof outcome === "object" ? outcome.message : undefined;
    const remaining = Math.max(0, limits.maxRetainedEvidenceBytes - retainedEvidence);
    const evidence = boundedText(detail ?? `Advisory check '${name}' failed`, remaining);
    if (evidence) retainedEvidence += encoder.encode(evidence).byteLength;
    const path = typeof outcome === "object" ? outcome.path ?? [] : [];
    const diagnostic: Diagnostic = {
      code: thrown === undefined ? "advisory_check_failed" : "advisory_check_threw",
      phase: "validation",
      path,
      severity: "warning",
      cost: 0,
      ...(evidence ? { evidence } : {}),
    };
    return { name, passed: false, diagnostic };
  });

  return {
    passed: statuses.every(({ passed }) => passed),
    checks: statuses,
    fingerprint: advisoryPolicyFingerprint(configured as readonly AdvisoryCheck<unknown>[]),
  };
}
