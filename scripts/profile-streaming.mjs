import { performance } from "node:perf_hooks";
import { z } from "zod";
import { createStreamParser } from "../dist/index.js";

const item = z.object({ id: z.number(), label: z.string(), tags: z.array(z.string()) });
const scenarios = [
  ["small", z.object({ answer: z.string() }), JSON.stringify({ answer: "yes" }), 2],
  ["medium", z.array(item), JSON.stringify(Array.from({ length: 40 }, (_, id) => ({ id, label: `item-${id}`, tags: ["a", "b"] }))), 16],
  ["large", z.array(item), JSON.stringify(Array.from({ length: 400 }, (_, id) => ({ id, label: `item-${id}`, tags: ["a", "b", "c"] }))), 64],
  ["deeply-nested", z.unknown(), `${"[".repeat(48)}0${"]".repeat(48)}`, 1],
  ["adversarial", z.object({ text: z.string() }), `preface ${JSON.stringify({ text: "\\\"{}[]".repeat(1000) })} trailing prose`, 8],
];

const rows = [];
for (const [scenario, schema, input, chunkSize] of scenarios) {
  global.gc?.();
  const beforeHeap = process.memoryUsage().heapUsed;
  const parser = createStreamParser(schema);
  const started = performance.now();
  for (let offset = 0; offset < input.length; offset += chunkSize) parser.push(input.slice(offset, offset + chunkSize));
  const result = parser.finish();
  const elapsedMs = performance.now() - started;
  const allocatedBytes = Math.max(0, process.memoryUsage().heapUsed - beforeHeap);
  if (!result.success) throw new Error(`${scenario} did not finish successfully: ${result.error.message}`);
  rows.push({ scenario, inputBytes: Buffer.byteLength(input), chunkSize, elapsedMs: +elapsedMs.toFixed(2), allocatedBytes, ...parser.metrics });
}

console.table(rows);
