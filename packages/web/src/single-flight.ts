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
// That separation bounds who can be hurt by an abandoned promise, but not how
// long. The map is module-level, so an entry registered under request A's
// IoContext is handed to request B; when workerd cancels A's context the promise
// never settles, so the loader's `finally` never runs and the entry never clears.
// Every later refresh for that key joins the dead promise, and background
// revalidation for it is dead for the isolate's lifetime — recovery only when the
// prior crosses MAX_STALE_PINNED and the foreground path blocks. So entries carry
// the time they were registered and expire: past MAX_BACKGROUND_AGE_MS the entry
// is treated as absent and the next refresh starts a fresh run, which also caps
// the map at the keys refreshed in the last window.
const background = new Map<string, { promise: Promise<unknown>; startedAt: number }>();

/** How long a background entry may be joined before it is presumed abandoned.
 *  findRelease's own HARD deadline is 28s, so a refresh still running past this
 *  is not slow — it is a promise whose IoContext went away. Erring long is the
 *  safe direction: the cost of expiring too early is one duplicated traversal,
 *  while the cost of never expiring is no revalidation at all for that key. */
const MAX_BACKGROUND_AGE_MS = 30_000;

/** Collapse concurrent BACKGROUND refreshes for `key` onto one run, in a map
 *  foreground callers never join. Registration is synchronous, so two refreshes
 *  fired in the same tick cannot both miss it. */
export function backgroundFlight<T>(key: string, loader: Loader<T>): Promise<T> {
  const existing = background.get(key);
  if (existing && Date.now() - existing.startedAt < MAX_BACKGROUND_AGE_MS) {
    return existing.promise as Promise<T>;
  }
  const entry: { promise: Promise<unknown>; startedAt: number } = {
    promise: undefined as unknown as Promise<unknown>,
    startedAt: Date.now(),
  };
  entry.promise = (async () => {
    try {
      return await loader();
    } finally {
      // Only clear OUR entry. An abandoned promise that settles late (or a run
      // superseded after expiry) must not evict the live entry that replaced it.
      if (background.get(key) === entry) background.delete(key);
    }
  })();
  background.set(key, entry);
  return entry.promise as Promise<T>;
}
