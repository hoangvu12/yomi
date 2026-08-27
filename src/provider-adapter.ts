/** A provider event translated into the only inputs understood by Yomi core. */
export type ProviderEventMapping =
  | { type: "text"; value: string }
  | { type: "bytes"; value: Uint8Array }
  | { type: "ignore" }
  | { type: "unknown"; reason?: string };

export type UnknownProviderEventPolicy = "throw" | "ignore";

export interface ProviderAdapterOptions<E> {
  /** Cancels iteration. The provider should receive this same signal when its stream is created. */
  signal?: AbortSignal;
  /** Unknown events throw by default; ignoring them must be an explicit choice. */
  unknownEvent?: UnknownProviderEventPolicy;
  onUnknownEvent?: (event: E, reason?: string) => void;
}

export class UnknownProviderEventError extends Error {
  readonly event: unknown;

  constructor(event: unknown, reason?: string) {
    super(reason ? `Unknown provider event: ${reason}` : "Unknown provider event");
    this.name = "UnknownProviderEventError";
    this.event = event;
  }
}

/**
 * Convert an SDK-specific event stream to Yomi's provider-neutral text/byte stream.
 *
 * This deliberately owns no network policy. The caller constructs the provider
 * stream (passing it the same AbortSignal), and remains responsible for auth,
 * retries, fallbacks, timeouts, accounting, and model selection.
 */
export async function* adaptProviderEvents<E>(
  events: AsyncIterable<E>,
  mapEvent: (event: E) => ProviderEventMapping,
  options: ProviderAdapterOptions<E> = {},
): AsyncGenerator<string | Uint8Array, void, void> {
  const iterator = events[Symbol.asyncIterator]();
  const signal = options.signal;
  const abort = () => new DOMException("Provider stream was aborted", "AbortError");

  try {
    while (true) {
      if (signal?.aborted) throw abort();
      const nextPromise = iterator.next();
      const next = signal ? await nextOrAbort(nextPromise, signal, abort) : await nextPromise;
      if (next.done) return;

      const mapped = mapEvent(next.value);
      if (mapped.type === "text" || mapped.type === "bytes") {
        yield mapped.value;
      } else if (mapped.type === "unknown") {
        options.onUnknownEvent?.(next.value, mapped.reason);
        if ((options.unknownEvent ?? "throw") === "throw") {
          throw new UnknownProviderEventError(next.value, mapped.reason);
        }
      }
    }
  } finally {
    // Async-generator return is the provider-neutral cancellation mechanism.
    await iterator.return?.();
  }
}

function nextOrAbort<T>(
  next: Promise<IteratorResult<T>>,
  signal: AbortSignal,
  abort: () => DOMException,
): Promise<IteratorResult<T>> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abort());
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    if (signal.aborted) {
      reject(abort());
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    next.then(
      (result) => { cleanup(); resolve(result); },
      (error) => { cleanup(); reject(error); },
    );
  });
}
