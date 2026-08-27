// In-isolate single-flight guard (D21).
// Concurrent requests for the same key within one Worker isolate await a single
// computation, instead of each running the algorithm and draining the shared
// server token. Honest scope: this does NOT coalesce across isolates / colos.

type Loader<T> = () => Promise<T>;

const inflight = new Map<string, Promise<unknown>>();

/** Wrap `loader` so concurrent calls with the same `key` share one Promise. */
export async function singleFlight<T>(key: string, loader: Loader<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = (async () => {
    try {
      return await loader();
    } finally {
      // Whether success or failure, drop the entry so the next request retries.
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}
