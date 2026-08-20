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

// Background refreshes get their OWN map, which no foreground caller ever reads.
// The stale-while-revalidate path in resolve.ts fires a refresh on every request
// inside the stale window, so without coalescing four crawlers unfurling one link
// in the same second run four full findRelease traversals against the same repo
// on the shared token. It cannot simply use `singleFlight`: that task runs under
// `executionCtx.waitUntil`, whose IoContext workerd may tear down before the
// subrequest settles, and the entry is only cleared in the loader's `finally` —
// a foreground request joining that dead promise hangs (see resolve.ts
// `coalesce`). Keeping the two maps separate gives both properties: background
// tasks collapse onto each other, and no foreground request can ever join one.
//
// Honest failure mode: if a background promise never settles, its entry leaks and
// later background refreshes for that key join a dead promise. Nobody awaits a
// background task's result, so the visible consequence is bounded — this isolate
// stops refreshing that key behind a stale hit, and the foreground blocking path
// past SWR_MAX_STALE still recovers it.
const background = new Map<string, Promise<unknown>>();

/** Collapse concurrent BACKGROUND refreshes for `key` onto one run, in a map
 *  foreground callers never join. Registration is synchronous, so two refreshes
 *  fired in the same tick cannot both miss it. */
export function backgroundFlight<T>(key: string, loader: Loader<T>): Promise<T> {
  const existing = background.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = (async () => {
    try {
      return await loader();
    } finally {
      background.delete(key);
    }
  })();
  background.set(key, p);
  return p;
}
