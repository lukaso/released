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
import { singleFlight } from './single-flight.js';

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
// It bounds EVERY exit that hands back a prior. Sharing the 24h slot is exactly
// what made a 23h-old prior possible on the /internal path (`consumerPinsResult`,
// set by the OG route): before it, that route had a flat 30-minute TTL of its own
// and an entry that old could not exist. Public HTML
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
  /** Opt-in for callers whose consumer only ever asks ONCE, so a soft failure
   *  becomes permanent for them (the OG crawler). When set, the shared negative
   *  back-off marker is honoured only if there is a prior we can actually SERVE
   *  — with nothing servable, an attempt beats handing back a placeholder that
   *  gets cached forever. The marker is still WRITTEN on failure, and callers
   *  that can retry (the public HTML routes) omit this and keep backing off.
   *
   *  Be honest about the reachable behaviour. The only caller that sets this also
   *  sets `consumerPinsResult`, and `findRelease` emits just two entry shapes:
   *  TERMINAL (fresh forever, so it returns at the fresh exit above) and PARTIAL
   *  (fresh for its 60s, unpinnable after). Neither can reach the stale-serve on
   *  the back-off line below, so on that path the bypass is UNCONDITIONAL, not
   *  cold-only. That is accepted, not overlooked: a crawler asks once, so the
   *  alternative is a placeholder pinned long after the host recovers, and the
   *  cost is the unthrottled load documented at the fall-through. The
   *  `prior && !unpinnable(prior)` stale-serve is live for the public routes,
   *  which do not set either flag. */
  bypassBackOffWhenUnservable?: boolean;
  /** Opt-in for callers whose consumer CACHES whatever we hand back, for longer
   *  than we can correct (the OG crawler pins a rendered PNG for 24h). When set,
   *  no exit returns a prior older than `MAX_STALE_PINNED`: we would rather pay a
   *  fresh lookup, or hand back a transient the caller renders as a short-cached
   *  placeholder, than pin a day-old answer that has since changed. */
  consumerPinsResult?: boolean;
  /** Override the in-isolate single-flight key, which otherwise IS `key`.
   *
   *  `singleFlight` hands every joiner the FIRST registrant's promise and runs
   *  only that owner's `load`, so two callers sharing a key also share a loader —
   *  including its deadlines. Callers on this same cache slot do not agree on
   *  those: badge.ts runs an 8s/9s findRelease so a slow repo returns a
   *  short-cached "checking…", while the permalink and /internal callers run the
   *  24s/28s defaults. Sharing a slot is deliberate (that is the whole point of a
   *  common key); sharing a TRUNCATION is not, so a caller whose consumer cannot
   *  caveat a partial passes its own flight key and always runs its own lookup.
   *  Concurrent calls from that same caller still collapse into one. */
  flightKey?: string;
}): Promise<Resolved> {
  const { cache, key, load, bypassBackOffWhenUnservable, consumerPinsResult } = args;
  const flightKey = args.flightKey ?? key;
  const now = args.now ?? Date.now;

  /** True when a cached entry must NOT be handed to a consumer that pins the
   *  answer. Always false for callers that did not opt in, so the public HTML
   *  routes are unchanged. Three shapes, three rules:
   *
   *  TERMINAL (`firstRelease`, no `partial`) — always servable. Which release
   *  first contains a commit cannot change, which is why `isFresh()` treats it as
   *  fresh forever and `hardTtlFor()` keeps it 30 days. `MAX_STALE_PINNED` exists
   *  for the opposite case, a "not yet released" prior that has since shipped;
   *  applying it here would discard exactly the warm entries this route joined the
   *  public key to reuse, paying a full findRelease per unfurl.
   *
   *  PARTIAL (either shape) — never servable to a pinning consumer, but only
   *  worth recomputing once its own 60-second TTL is up. A partial is a truncated
   *  traversal: with `firstRelease: null` it means "we stopped looking", which
   *  web-og renders as a definite "not yet released"; WITH a `firstRelease` it
   *  carries the gallop hit, and the bisect that would confirm no EARLIER release
   *  contains the commit is what the deadline cut short (find-release.ts:288-292).
   *  The result card renders that caveat, web-og cannot — it long-caches the bare
   *  tag for 24h. So neither shape may be pinned. Inside `HARD_TTL_PARTIAL` the
   *  entry is still handed BACK (the caller 503s it into a short-cached neutral
   *  placeholder): that is what throttles a repo which reliably blows the soft
   *  deadline, where recomputing per unfurl would run a full traversal on the
   *  shared token for every crawler, forever. Past 60s we recompute instead.
   *
   *  PENDING (no `firstRelease`, no `partial`) — bounded by `MAX_STALE_PINNED`:
   *  an answer older than that may have shipped since, and a PNG already rendered
   *  from it cannot be invalidated. */
  const isRecentPartial = (entry: CacheEntry<LookupResult>): boolean =>
    Boolean(entry.value.partial) && entry.ageSeconds < HARD_TTL_PARTIAL;

  const unpinnable = (entry: CacheEntry<LookupResult>): boolean => {
    if (!consumerPinsResult) return false;
    if (entry.value.firstRelease && !entry.value.partial) return false;
    if (isRecentPartial(entry)) return false;
    return entry.ageSeconds >= MAX_STALE_PINNED || Boolean(entry.value.partial);
  };

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
    //
    // What that argument does NOT cover, and what #157 tracks: every bypassed load
    // RE-STAMPS the marker, so under a steady crawler cadence the marker is almost
    // never older than NEG_TTL. Human page views on this key do not bypass, so they
    // hit a warm marker on nearly every request and sit on the "checking..." card
    // for the whole outage instead of getting a retry window each minute. The
    // crawler's unthrottled probing starves the humans' back-off of its recovery
    // window; fixing that means changing the marker's semantics (a `bypassed` flag,
    // or not re-stamping on a bypassed load), not the bypass condition.
  }

  try {
    const run = async () => {
      const re = await cache.getEntry<LookupResult>(key);
      if (re && isFresh(re) && !unpinnable(re)) return re.value;
      const r = await load();
      // A consumer that PINS what we hand back is also the most deadline-pressured
      // producer of partials, and `hardTtlFor()` tests `firstRelease` before
      // `partial` — so a gallop-only partial (find-release.ts ~295: the gallop hit
      // WITH `partial: soft_deadline`) would take the TERMINAL 30-day branch and
      // `isFresh()` would report it fresh forever. On the shared slot that pins the
      // public permalink and badge to a tag the bisect never confirmed, for a month,
      // with no upstream call able to correct it. `unpinnable` trusts a partial for
      // HARD_TTL_PARTIAL and no longer, so the long TTL buys this caller nothing.
      // (The same misclassification on the PUBLIC routes' own writes predates this
      // PR and is tracked in #155; their semantics are deliberately untouched here.)
      const pinnedPartial = Boolean(consumerPinsResult && r.partial);
      await cache.put(key, r, pinnedPartial ? HARD_TTL_PARTIAL : hardTtlFor(r));
      return r;
    };
    const result = await singleFlight(flightKey, run);
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
