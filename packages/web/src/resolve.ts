// Stale-if-error resolver — the cache policy that keeps a badge/permalink from
// flipping to "unknown" the moment an upstream host has a blip.
//
// Three ideas, all keyed off the same cached LookupResult the routes already use:
//
//   1. Terminal answers never expire. A "released" result (the first release
//      containing a commit) can never change, so once cached we serve it forever
//      and never touch upstream again — an outage can't erase it.
//   2. Stale-if-error. For non-terminal answers we keep a long HARD ttl but a
//      short freshness window. Past the window we try to revalidate; if upstream
//      is down we serve the last-known-good answer (marked stale) instead of an
//      error.
//   3. Don't hammer a down host. A transient failure writes a short-lived
//      "negative" marker; while it's warm we skip the upstream call entirely
//      (serving stale if we have it, otherwise a soft "checking…" transient).
//      A caller whose consumer asks only ONCE can opt out of the cold half of
//      that (`bypassBackOffWhenUnservable`) — backing off is cheap for a page a human
//      can reload and permanent for a crawler that unfurls once.
//
// "not yet released" is a thrown NotYetReleasedError (not a cacheable result),
// so it surfaces as its own status and, during an outage with no prior, degrades
// to a transient ("checking…") rather than a hard error.

import {
  type LookupResult,
  NotYetReleasedError,
  ProviderJsonError,
  ReleasedError,
} from '@released/core';
import { upstreamStatusOf } from './analytics.js';
import type { CacheEntry, WorkerCache } from './cache.js';
import { backgroundFlight, singleFlight } from './single-flight.js';

// Freshness windows + hard TTLs (seconds).
const FRESH_WINDOW_PENDING = 5 * 60; // re-check non-released answers every 5 min
const HARD_TTL_RELEASED = 30 * 24 * 60 * 60; // terminal — keep ~30 days
const HARD_TTL_PENDING = 24 * 60 * 60; // long enough to stale-serve through an outage
const HARD_TTL_PARTIAL = 60; // partial is itself a soft state; don't trust it long
const NEG_TTL = 60; // back off this long when upstream is down
// Upper bound on the age of a prior we will hand to a consumer that PINS what we
// give it. web-og long-caches any non-null result for 24h (renderImage:
// `result ? longCache : shortCache`), so an answer served to it is stuck in the
// crawler's cache for a day and no later refresh can invalidate a PNG already
// rendered from it — a "not yet released" prior that has since shipped would
// show the wrong card until tomorrow. 30 minutes is what /internal used as its
// flat TTL before it shared this 24h slot, so bounding is never worse than the
// code it replaced.
//
// It bounds EVERY exit that hands back a prior, not just the SWR one. Rounds 4/5
// bounded only the stale-while-revalidate return, which left both stale-if-error
// exits (back-off below, and the transient catch) free to serve an answer of any
// age — and sharing the 24h slot is exactly what made a 23h-old prior possible on
// the /internal path (`consumerPinsResult`, set by the OG route). Public HTML
// routes leave the flag unset and keep stale-if-error UNBOUNDED: a human sees an
// explicit "stale as of" caveat and can reload, and their answer is not pinned
// anywhere, so serving through a long outage is the right degrade for them.
const MAX_STALE_PINNED = 30 * 60;

// Error kinds a later retry might succeed on → eligible for stale-serve (when we
// have a prior) or a short negative cache (when we don't). Everything else is a
// real answer (not found / not merged / unsupported / …) and is surfaced as-is.
const TRANSIENT_KINDS: ReadonlySet<string> = new Set([
  'provider_server_error',
  'github_server_error',
  'provider_json_error',
  'network_error',
  'lookup_timeout',
  'rate_limit',
]);

export function isTransientError(err: unknown): err is ReleasedError {
  return err instanceof ReleasedError && TRANSIENT_KINDS.has(err.kind);
}

function hardTtlFor(r: LookupResult): number {
  if (r.firstRelease) return HARD_TTL_RELEASED;
  if (r.partial) return HARD_TTL_PARTIAL;
  return HARD_TTL_PENDING;
}

function isFresh(entry: CacheEntry<LookupResult>): boolean {
  // A "released" answer is terminal — never stale, never needs upstream again.
  if (entry.value.firstRelease) return true;
  if (entry.value.partial) return entry.ageSeconds < HARD_TTL_PARTIAL;
  return entry.ageSeconds < FRESH_WINDOW_PENDING;
}

type NegMarker = { transient: true; kind: string; status?: number; anubis?: boolean };
function negKey(key: string): string {
  return `${key}:neg`;
}

export type Resolved =
  | {
      status: 'ok';
      result: LookupResult;
      stale: boolean;
      staleAsOf: number | null;
      cached: boolean;
    }
  | { status: 'not_yet'; error: NotYetReleasedError }
  | { status: 'transient'; kind: string; upstreamStatus?: number; anubis?: boolean }
  | { status: 'error'; error: unknown };

/**
 * Resolve a lookup through the cache with stale-if-error semantics.
 * `load` performs the actual (uncached) computation — typically a findRelease().
 */
export async function resolveLookup(args: {
  cache: WorkerCache;
  key: string;
  load: () => Promise<LookupResult>;
  now?: () => number;
  /** Opt-in stale-while-revalidate, for callers on a latency-critical path.
   *  When given, a cached-but-stale answer is returned IMMEDIATELY and the
   *  revalidation is handed to this callback to run off the response path
   *  (`executionCtx.waitUntil`). Callers that can afford to wait — the public
   *  HTML routes — omit it and keep the blocking behaviour. */
  revalidate?: (task: Promise<unknown>) => void;
  /** Opt-in for callers whose consumer only ever asks ONCE, so a soft failure
   *  becomes permanent for them (the OG crawler). When set, the shared negative
   *  back-off marker is honoured only if there is a prior we can actually SERVE
   *  — with nothing servable, an attempt beats handing back a placeholder that
   *  gets cached forever. "Nothing servable" is broader than an empty slot: with
   *  `consumerPinsResult`, a prior past `MAX_STALE_PINNED` or a truncated
   *  `partial` is unservable too, so a warm-but-unpinnable key reaches this path
   *  as well. That is deliberate (the alternative is a permanent placeholder),
   *  but it is NOT throttled — see the fall-through comment below for the cost.
   *  The marker is still WRITTEN on failure, and callers that can retry (the
   *  public HTML routes) omit this and keep backing off. */
  bypassBackOffWhenUnservable?: boolean;
  /** Internal. Set false for the background refresh on the SWR path: that task
   *  runs under `executionCtx.waitUntil`, whose IoContext workerd can tear down
   *  before the subrequest settles. singleFlight only clears its module-level
   *  entry in the loader's `finally`, so a background owner that never settles
   *  leaves a dead promise under this key, and every later request in the same
   *  isolate — a human on the permalink, badge.ts on the same cull/nopre key —
   *  joins it: a hang, or "Cannot perform I/O on behalf of a different request",
   *  which resolveLookup classifies as a non-transient error and the page renders
   *  as a hard failure. A foreground caller is always a live, awaiting request; a
   *  background one is not. A duplicated refresh is far cheaper than poisoning
   *  the key for the lifetime of the isolate. */
  coalesce?: boolean;
  /** Opt-in for callers whose consumer CACHES whatever we hand back, for longer
   *  than we can correct (the OG crawler pins a rendered PNG for 24h). When set,
   *  no exit returns a prior older than `MAX_STALE_PINNED`: we would rather pay a
   *  fresh lookup, or hand back a transient the caller renders as a short-cached
   *  placeholder, than pin a day-old answer that has since changed. */
  consumerPinsResult?: boolean;
}): Promise<Resolved> {
  const {
    cache,
    key,
    load,
    revalidate,
    bypassBackOffWhenUnservable,
    coalesce,
    consumerPinsResult,
  } = args;
  const now = args.now ?? Date.now;

  /** True when a cached entry must NOT be handed to a consumer that pins the
   *  answer — either because it is too old to still be true, or because it is a
   *  `partial`: a truncated traversal whose `firstRelease: null` means "we
   *  stopped looking", not "not released". The result card renders that caveat;
   *  web-og cannot (`firstRelease?.tag ?? 'not yet released'`, long-cached for
   *  any non-null result), so a partial pins a wrong answer for a day. `badge.ts`
   *  loads THIS key with an 8s soft deadline, so on a large repo it writes the
   *  partial that would otherwise be served here — reachable only since this
   *  route joined the public five-part key. Always false for callers that did
   *  not opt in, so the public HTML routes are unchanged.
   *
   *  The age bound does NOT apply to a terminal `firstRelease` answer: which
   *  release first contains a commit cannot change, which is why `isFresh()`
   *  treats it as fresh forever and `hardTtlFor()` gives it `HARD_TTL_RELEASED`
   *  (30 days). `MAX_STALE_PINNED` exists for the opposite case — a "not yet
   *  released" prior that has since shipped. Applying it to a terminal answer
   *  would discard exactly the warm entries this route joined the public key to
   *  reuse, paying a full findRelease on the crawler's critical path for every
   *  unfurl more than 30 minutes after the last write. */
  const unpinnable = (entry: CacheEntry<LookupResult>): boolean =>
    Boolean(consumerPinsResult) &&
    !entry.value.firstRelease &&
    (entry.ageSeconds >= MAX_STALE_PINNED || Boolean(entry.value.partial));

  const prior = await cache.getEntry<LookupResult>(key);
  if (prior && isFresh(prior) && !unpinnable(prior)) {
    return { status: 'ok', result: prior.value, stale: false, staleAsOf: null, cached: true };
  }

  const staleHit = (): Resolved => ({
    status: 'ok',
    result: (prior as CacheEntry<LookupResult>).value,
    stale: true,
    staleAsOf: now() - (prior as CacheEntry<LookupResult>).ageSeconds * 1000,
    cached: true,
  });

  // Stale-while-revalidate: serve what we have, refresh behind it — but only up to
  // MAX_STALE_PINNED, past which we block rather than hand back an answer a crawler
  // would pin for a day. The refresh is a plain recursive call WITHOUT `revalidate`,
  // so it takes the blocking path and cannot recurse again, and with
  // `coalesce: false` so a task the runtime may kill never owns the foreground
  // flight for this key. `backgroundFlight` then restores the collapsing that
  // dropping out of `singleFlight` cost: this branch fires on EVERY request in the
  // stale window, so four crawlers unfurling one link in the same second would
  // otherwise run four full lookups against the same repo on the shared token.
  // Errors are absorbed here — a background failure must not surface as an
  // unhandled rejection on a response that already succeeded.
  if (prior && revalidate && prior.ageSeconds < MAX_STALE_PINNED && !unpinnable(prior)) {
    revalidate(
      backgroundFlight(key, () => resolveLookup({ cache, key, load, now, coalesce: false })).catch(
        () => undefined,
      ),
    );
    return staleHit();
  }

  // Did we try (and fail transiently) very recently? If so, don't pound the
  // upstream again yet — serve the last-known-good if we have one, else a soft
  // transient.
  const neg = await cache.getEntry<NegMarker>(negKey(key));
  const backedOff =
    Boolean(neg?.value?.transient) && (neg?.ageSeconds ?? Number.POSITIVE_INFINITY) < NEG_TTL;
  if (backedOff) {
    if (prior && !unpinnable(prior)) return staleHit();
    if (!bypassBackOffWhenUnservable) {
      return {
        status: 'transient',
        kind: neg?.value.kind ?? 'provider_server_error',
        upstreamStatus: neg?.value.status,
        anubis: neg?.value.anubis,
      };
    }
    // Cold + opted out: fall through and attempt the load. This is NOT throttled.
    // singleFlight collapses only CONCURRENT calls, and only inside ONE isolate
    // (see its header), so during a host outage every cold unfurl — a different
    // colo, a different social platform, or simply a later one — runs its own
    // findRelease out to the hard deadline against the down host and re-stamps
    // the marker. NEG_TTL throttles the human page views on this key, not this
    // path. That cost is accepted deliberately: the crawler asks ONCE, so the
    // alternative is a placeholder pinned in its cache long after the host
    // recovers. Gating the bypass on a fraction of NEG_TTL would only move which
    // unfurls get the permanent placeholder, not stop them.
  }

  try {
    const run = async () => {
      const re = await cache.getEntry<LookupResult>(key);
      if (re && isFresh(re) && !unpinnable(re)) return re.value;
      const r = await load();
      await cache.put(key, r, hardTtlFor(r));
      return r;
    };
    const result = coalesce === false ? await run() : await singleFlight(key, run);
    return { status: 'ok', result, stale: false, staleAsOf: null, cached: false };
  } catch (err) {
    if (err instanceof NotYetReleasedError) return { status: 'not_yet', error: err };
    if (isTransientError(err)) {
      // Throttle the next retry, then serve last-known-good if we have it.
      const upstreamStatus = upstreamStatusOf(err);
      const anubis = err instanceof ProviderJsonError && err.looksLikeAnubis;
      await cache.put(
        negKey(key),
        { transient: true, kind: err.kind, status: upstreamStatus, anubis },
        NEG_TTL,
      );
      if (prior && !unpinnable(prior)) return staleHit();
      return { status: 'transient', kind: err.kind, upstreamStatus, anubis };
    }
    return { status: 'error', error: err };
  }
}
