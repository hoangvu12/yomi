import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createStreamParser } from "../src/index.js";

describe("stream work metrics", () => {
  it("reports deterministic cumulative work without wall-clock assertions", () => {
    const parser = createStreamParser(z.object({ value: z.union([z.string(), z.number()]) }));
    parser.push('{"value":"a');
    parser.push('b"}');

    expect(parser.metrics).toMatchObject({
      inputBytes: 14,
      parseAttempts: 2,
      cumulativeParsedBytes: 25,
      completionScannedCharacters: 25,
      repairAttempts: 1,
      candidateAttempts: 4,
      snapshotCount: 2,
      retainedBytes: 14,
    });
    expect(Object.isFrozen(parser.metrics)).toBe(true);

    const final = parser.finish();
    expect(final.success).toBe(true);
    expect(parser.metrics).toMatchObject({ parseAttempts: 3, cumulativeParsedBytes: 39, retainedBytes: 14 });
  });

  it("keeps resource failures deterministic while retaining their work evidence", () => {
    const parser = createStreamParser(z.string(), { limits: { maxInputBytes: 2 } });
    parser.push('"a');
    const failed = parser.push('b"');
    expect(failed).toMatchObject({ success: false, pending: false, error: { budget: "maxInputBytes" } });
    expect(parser.metrics).toMatchObject({ inputBytes: 2, parseAttempts: 1, retainedBytes: 2 });
  });
});
