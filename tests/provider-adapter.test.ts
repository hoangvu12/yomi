import { describe, expect, it } from "vitest";
import { z } from "zod";
import { adaptProviderEvents, parseStream, UnknownProviderEventError } from "../src/index.js";

type Event =
  | { kind: "delta"; text: string }
  | { kind: "usage"; tokens: number }
  | { kind: "mystery" };

const mapEvent = (event: Event) => {
  if (event.kind === "delta") return { type: "text" as const, value: event.text };
  if (event.kind === "usage") return { type: "ignore" as const };
  return { type: "unknown" as const, reason: event.kind };
};

async function* recorded(events: Event[]) {
  yield* events;
}

describe("adaptProviderEvents", () => {
  it("feeds synthetic provider deltas through semantic streaming end to end", async () => {
    const events: Event[] = [
      { kind: "delta", text: '{"message":"hel' },
      { kind: "usage", tokens: 3 },
      { kind: "delta", text: 'lo","count":2}' },
    ];
    const snapshots = [];
    for await (const snapshot of parseStream(
      z.object({ message: z.string(), count: z.number() }),
      adaptProviderEvents(recorded(events), mapEvent),
    )) snapshots.push(snapshot);

    expect(snapshots[0]?.data).toEqual({ message: "hel" });
    expect(snapshots.at(-1)?.data).toEqual({ message: "hello", count: 2 });
  });

  it("requires unknown events to be handled explicitly", async () => {
    const consume = async () => {
      for await (const _ of adaptProviderEvents(recorded([{ kind: "mystery" }]), mapEvent)) { /* consume */ }
    };
    await expect(consume()).rejects.toBeInstanceOf(UnknownProviderEventError);

    const seen: Event[] = [];
    for await (const _ of adaptProviderEvents(recorded([{ kind: "mystery" }]), mapEvent, {
      unknownEvent: "ignore",
      onUnknownEvent: (event) => seen.push(event),
    })) { /* consume */ }
    expect(seen).toEqual([{ kind: "mystery" }]);
  });

  it("closes the provider iterator when cancellation is propagated", async () => {
    let closed = false;
    const controller = new AbortController();
    async function* provider(): AsyncGenerator<Event> {
      try {
        yield { kind: "delta", text: "first" };
        await new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
        yield { kind: "delta", text: "never delivered" };
      } finally {
        closed = true;
      }
    }
    const iterator = adaptProviderEvents(provider(), mapEvent, { signal: controller.signal })[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: "first" });
    const pending = iterator.next();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(closed).toBe(true);
  });
});
