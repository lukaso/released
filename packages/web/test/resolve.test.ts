// resolveLookup: the stale-if-error core. Verifies that a transient upstream
// failure never erases a known-good answer, that terminal "released" answers are
// served forever without touching upstream, and that a down upstream is not
// hammered (short negative cache / revalidation throttle).

import {
  type LookupInput,
  type LookupResult,
  NotYetReleasedError,
  PrNotFoundError,
  ProviderJsonError,
  ProviderServerError,
  type RepoRef,
} from '@released/core';
import { describe, expect, it, vi } from 'vitest';
import type { CacheEntry, WorkerCache } from '../src/cache.js';
import { isTransientError, resolveLookup } from '../src/resolve.js';

const REPO: RepoRef = { host: 'gitlab.gnome.org', projectPath: 'GNOME/gtk' };
const INPUT: LookupInput = { kind: 'pr', repo: REPO, number: 9951 };

function mkResult(opts: { released: boolean; partial?: boolean }): LookupResult {
  return {
    input: INPUT,
    canonicalSha: 'ffffffffffffffffffffffffffffffffffffffff',
    subject: 'macos: Fix #8213',
    firstRelease: opts.released
      ? { tag: '4.18.0', date: '2024-06-01T00:00:00Z', url: 'https://example/rel' }
      : null,
    alsoIn: [],
    releaseNotesHtml: null,
    rateLimit: null,
    ...(opts.partial ? { partial: { reason: 'soft_deadline', candidatesTried: 3 } } : {}),
    urls: { repo: 'https://example/repo', commit: 'https://example/commit' },
  } as LookupResult;
}

/** In-memory WorkerCache whose entry ages are set explicitly by the test. */
function makeFakeCache() {
  const store = new Map<string, { value: unknown; ageSeconds: number }>();
  const cache: WorkerCache = {
    async get<T>(key: string) {
      return (store.get(key)?.value as T) ?? null;
    },
    async getEntry<T>(key: string): Promise<CacheEntry<T> | null> {
      const e = store.get(key);
      return e ? { value: e.value as T, ageSeconds: e.ageSeconds } : null;
    },
    async put<T>(key: string, value: T) {
      store.set(key, { value, ageSeconds: 0 });
    },
  };
  return {
    cache,
    seed(key: string, value: unknown, ageSeconds: number) {
      store.set(key, { value, ageSeconds });
    },
    has: (key: string) => store.has(key),
    get: (key: string) => store.get(key),
  };
}

const KEY = 'res:gtk:pr#9951';
const negKey = `${KEY}:neg`;

describe('isTransientError', () => {
  it('treats 5xx / network / timeout / rate-limit as transient', () => {
    expect(isTransientError(new ProviderServerError('gitlab.gnome.org', 503, 'x'))).toBe(true);
  });
  it('treats not-found as permanent (a real answer)', () => {
    expect(isTransientError(new PrNotFoundError(9951))).toBe(false);
  });
  it('treats NotYetReleasedError as not transient (handled separately)', () => {
    expect(isTransientError(new NotYetReleasedError('abc1234', '2024-01-01'))).toBe(false);
  });
});

describe('resolveLookup — happy paths', () => {
  it('serves a fresh cached answer without calling upstream', async () => {
    const f = makeFakeCache();
    f.seed(KEY, mkResult({ released: true }), 10);
    const load = vi.fn();
    const r = await resolveLookup({ cache: f.cache, key: KEY, load });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.stale).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it('a released answer is terminal — fresh forever, even when very old', async () => {
    const f = makeFakeCache();
    f.seed(KEY, mkResult({ released: true }), 60 * 60 * 24 * 20); // 20 days
    const load = vi.fn();
    const r = await resolveLookup({ cache: f.cache, key: KEY, load });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.stale).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it('cold miss computes, caches, and returns the fresh answer', async () => {
    const f = makeFakeCache();
    const result = mkResult({ released: true });
    const load = vi.fn(async () => result);
    const r = await resolveLookup({ cache: f.cache, key: KEY, load });
    expect(load).toHaveBeenCalledOnce();
    expect(r).toMatchObject({ status: 'ok', stale: false });
    expect(f.has(KEY)).toBe(true);
  });
});

describe('resolveLookup — stale-if-error (the bug)', () => {
  it('serves the last-known-good answer (stale) when a stale entry fails to revalidate', async () => {
    const f = makeFakeCache();
    const known = mkResult({ released: true });
    f.seed(KEY, known, 7 * 60); // older than the 5-min freshness window for pending…
    // …but released answers are terminal, so they'd be fresh. Use a not-yet
    // partial prior to force a revalidation attempt instead:
    const pending = mkResult({ released: false, partial: true });
    f.seed(KEY, pending, 10); // partial fresh window is 60s
    // bump age past partial window so it revalidates
    f.seed(KEY, pending, 120);
    const load = vi.fn(async () => {
      throw new ProviderServerError('gitlab.gnome.org', 503, 'Service Unavailable');
    });
    const r = await resolveLookup({ cache: f.cache, key: KEY, load });
    expect(load).toHaveBeenCalledOnce();
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.stale).toBe(true);
      expect(r.result).toEqual(pending);
      expect(r.staleAsOf).toBeTypeOf('number');
    }
    // …and it records a throttle marker so the next request won't re-hammer.
    expect(f.has(negKey)).toBe(true);
  });

  it('does not hammer upstream while serving stale: a fresh neg marker skips the load', async () => {
    const f = makeFakeCache();
    const pending = mkResult({ released: false, partial: true });
    f.seed(KEY, pending, 120); // stale (past 60s partial window)
    f.seed(negKey, { transient: true, kind: 'provider_server_error' }, 5); // tried 5s ago
    const load = vi.fn();
    const r = await resolveLookup({ cache: f.cache, key: KEY, load });
    expect(load).not.toHaveBeenCalled();
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.stale).toBe(true);
  });
});

describe('resolveLookup — cold + upstream down', () => {
  it('returns a transient status (not an error) and records a negative cache', async () => {
    const f = makeFakeCache();
    const load = vi.fn(async () => {
      throw new ProviderServerError('gitlab.gnome.org', 503, 'Service Unavailable');
    });
    const r = await resolveLookup({ cache: f.cache, key: KEY, load });
    expect(r.status).toBe('transient');
    if (r.status === 'transient') {
      expect(r.kind).toBe('provider_server_error');
      // Carry the upstream HTTP status through to the route so analytics can
      // record WHY the host failed (5xx vs 429 vs challenge), not just that it did.
      expect(r.upstreamStatus).toBe(503);
    }
    expect(f.has(negKey)).toBe(true);
  });

  it('a fresh negative cache short-circuits to transient WITHOUT calling upstream', async () => {
    const f = makeFakeCache();
    f.seed(negKey, { transient: true, kind: 'provider_server_error' }, 10);
    const load = vi.fn();
    const r = await resolveLookup({ cache: f.cache, key: KEY, load });
    expect(load).not.toHaveBeenCalled();
    expect(r.status).toBe('transient');
  });

  it('an EXPIRED negative cache retries upstream', async () => {
    const f = makeFakeCache();
    f.seed(negKey, { transient: true, kind: 'provider_server_error' }, 120); // > 60s NEG_TTL
    const result = mkResult({ released: true });
    const load = vi.fn(async () => result);
    const r = await resolveLookup({ cache: f.cache, key: KEY, load });
    expect(load).toHaveBeenCalledOnce();
    expect(r.status).toBe('ok');
  });
});

describe('resolveLookup — Anubis surfacing', () => {
  // gitlab.freedesktop.org sits behind Anubis: it returns 200 with an HTML
  // interstitial. We classify this as transient (since the cause is upstream),
  // but the UI needs to know it's Anubis so it can point users at the CLI
  // instead of a futile "Try again" button — retrying never beats Anubis from
  // a Cloudflare Worker (workerd's TLS fingerprint is the trigger).
  it('threads anubis=true on the transient status when load throws an Anubis ProviderJsonError', async () => {
    const f = makeFakeCache();
    const load = vi.fn(async () => {
      throw new ProviderJsonError(
        200,
        '<title>Making sure you are not a bot!</title>',
        new Error('parse'),
      );
    });
    const r = await resolveLookup({ cache: f.cache, key: KEY, load });
    expect(r.status).toBe('transient');
    if (r.status === 'transient') {
      expect(r.kind).toBe('provider_json_error');
      expect(r.anubis).toBe(true);
    }
  });

  it('threads anubis=false on transient when the JSON error is NOT Anubis (e.g. Cloudflare CF)', async () => {
    const f = makeFakeCache();
    const load = vi.fn(async () => {
      throw new ProviderJsonError(200, '<title>Just a moment...</title>', new Error('parse'));
    });
    const r = await resolveLookup({ cache: f.cache, key: KEY, load });
    expect(r.status).toBe('transient');
    if (r.status === 'transient') {
      expect(r.anubis).toBeFalsy();
    }
  });

  it('preserves the anubis flag through a backed-off negative cache hit', async () => {
    // After the first Anubis failure the resolver writes a neg marker. The
    // next request must STILL surface anubis=true so the UI keeps pointing at
    // the CLI; otherwise the UX flips back to a misleading "Try again" during
    // the throttle window.
    const f = makeFakeCache();
    f.seed(negKey, { transient: true, kind: 'provider_json_error', anubis: true }, 10);
    const load = vi.fn();
    const r = await resolveLookup({ cache: f.cache, key: KEY, load });
    expect(load).not.toHaveBeenCalled();
    expect(r.status).toBe('transient');
    if (r.status === 'transient') expect(r.anubis).toBe(true);
  });
});

describe('resolveLookup — real answers pass through', () => {
  it('NotYetReleasedError becomes a not_yet status (never a negative cache)', async () => {
    const f = makeFakeCache();
    const load = vi.fn(async () => {
      throw new NotYetReleasedError('fffffff', '2024-01-01', 0, 0, 'macos: Fix #8213');
    });
    const r = await resolveLookup({ cache: f.cache, key: KEY, load });
    expect(r.status).toBe('not_yet');
    expect(f.has(negKey)).toBe(false);
  });

  it('a permanent error (PR not found) becomes an error status (never a negative cache)', async () => {
    const f = makeFakeCache();
    const load = vi.fn(async () => {
      throw new PrNotFoundError(9951);
    });
    const r = await resolveLookup({ cache: f.cache, key: KEY, load });
    expect(r.status).toBe('error');
    expect(f.has(negKey)).toBe(false);
  });
});

// Round-4 review of #144. The stale-while-revalidate path added in 4cdb212 is
// what lets the OG render return without blocking on a refresh. Both guards
// below pin a defect in THAT path, not in the cache-key alignment #144 is about.
describe('resolveLookup — stale-while-revalidate is bounded', () => {
  it('serves a recently-stale prior immediately and refreshes behind it', async () => {
    const f = makeFakeCache();
    // Past the 5-minute pending freshness window, well inside the SWR bound.
    f.seed(KEY, mkResult({ released: false }), 10 * 60);
    const load = vi.fn().mockResolvedValue(mkResult({ released: true }));
    const tasks: Promise<unknown>[] = [];

    const r = await resolveLookup({
      cache: f.cache,
      key: KEY,
      load,
      revalidate: (t) => {
        tasks.push(t);
      },
    });

    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.stale).toBe(true);
    expect(tasks).toHaveLength(1);
    await Promise.all(tasks);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('blocks rather than hand back an answer stale past the bound', async () => {
    const f = makeFakeCache();
    // 23h old: still inside HARD_TTL_PENDING (24h), so getEntry returns it.
    // web-og long-caches ANY non-null result for 24h, so serving this unblocked
    // pins a day-old "not yet released" card in the crawler's cache for another
    // day, and the background refresh cannot invalidate the PNG already made.
    f.seed(KEY, mkResult({ released: false }), 23 * 60 * 60);
    const load = vi.fn().mockResolvedValue(mkResult({ released: true }));
    const tasks: Promise<unknown>[] = [];

    const r = await resolveLookup({
      cache: f.cache,
      key: KEY,
      load,
      revalidate: (t) => {
        tasks.push(t);
      },
    });

    expect(tasks).toHaveLength(0);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.stale).toBe(false);
      expect(r.result.firstRelease?.tag).toBe('4.18.0');
    }
    expect(load).toHaveBeenCalledTimes(1);
  });

  // Round-5 review of #144. `coalesce: false` (round 4) kept the background
  // refresh from OWNING the singleFlight entry, but it also dropped it out of
  // coalescing entirely — and the SWR branch fires on EVERY request in the stale
  // window. One link unfurled by Slack, X, Discord and LinkedIn in the same
  // second in one colo then ran four full findRelease traversals against the same
  // repo on the shared GITHUB_TOKEN, none seeing the others.
  it('collapses concurrent background refreshes for one key onto a single lookup', async () => {
    const f = makeFakeCache();
    f.seed(KEY, mkResult({ released: false }), 10 * 60);

    // Slow enough that all four refreshes are genuinely in flight together.
    const load = vi.fn().mockImplementation(
      () =>
        new Promise<LookupResult>((res) => {
          setTimeout(() => res(mkResult({ released: true })), 10);
        }),
    );
    const tasks: Promise<unknown>[] = [];
    const revalidate = (t: Promise<unknown>) => {
      tasks.push(t);
    };

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        resolveLookup({ cache: f.cache, key: KEY, load, revalidate }),
      ),
    );

    // Every caller still gets its stale answer immediately — collapsing the
    // refresh must not make anyone wait.
    for (const r of results) {
      expect(r.status).toBe('ok');
      if (r.status === 'ok') expect(r.stale).toBe(true);
    }
    expect(tasks).toHaveLength(4);

    await Promise.all(tasks);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not let a torn-down background refresh poison the key for the isolate', async () => {
    const f = makeFakeCache();
    f.seed(KEY, mkResult({ released: false }), 10 * 60);

    // The background refresh never settles — exactly what a waitUntil task looks
    // like when workerd tears the IoContext down mid-subrequest. singleFlight
    // only clears its entry in the loader's `finally`, so if the background call
    // owns the flight, that entry is never cleared.
    const hung = vi.fn().mockReturnValue(new Promise<LookupResult>(() => {}));
    const first = await resolveLookup({
      cache: f.cache,
      key: KEY,
      load: hung,
      revalidate: () => {},
    });
    expect(first.status).toBe('ok');
    // Let the background call reach its load() and register whatever flight it
    // is going to register, before a second request asks for the same key.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hung).toHaveBeenCalledTimes(1);

    // A later request in the SAME isolate on the SAME key — a human on the
    // permalink, or badge.ts, which share this slot — must still get an answer.
    const good = vi.fn().mockResolvedValue(mkResult({ released: true }));
    const settled = await Promise.race([
      resolveLookup({ cache: f.cache, key: KEY, load: good }),
      new Promise((resolve) => setTimeout(() => resolve('JOINED-A-DEAD-FLIGHT'), 100)),
    ]);

    expect(settled).not.toBe('JOINED-A-DEAD-FLIGHT');
    expect(good).toHaveBeenCalledTimes(1);
  });
});

// Round-6 review of #144. Rounds 4/5 bounded only the stale-while-revalidate
// return, so both stale-if-error exits — the back-off short-circuit and the
// transient catch — could still hand the OG crawler a prior of any age. Sharing
// the public routes' 24h slot is what made that reachable: before #143 this
// route had a flat 30-minute TTL, so a 23h-old prior could not exist on it.
// A pinned consumer renders whatever it gets into a PNG cached for a day.
describe('resolveLookup — a pinned consumer is never handed a prior past the bound', () => {
  const aged = () => mkResult({ released: false });

  it('back-off exit: attempts a fresh lookup instead of serving a 23h-old prior', async () => {
    const f = makeFakeCache();
    f.seed(KEY, aged(), 23 * 60 * 60); // inside HARD_TTL_PENDING (24h), way past the bound
    f.seed(negKey, { transient: true, kind: 'github_server_error' }, 10); // a page view just failed
    const fresh = mkResult({ released: true });
    const load = vi.fn().mockResolvedValue(fresh);

    const r = await resolveLookup({
      cache: f.cache,
      key: KEY,
      load,
      bypassBackOffWhenUnservable: true,
      consumerPinsResult: true,
    });

    expect(load).toHaveBeenCalledTimes(1);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.stale).toBe(false);
      expect(r.result.firstRelease?.tag).toBe('4.18.0');
    }
  });

  it('transient-catch exit: returns transient rather than the 23h-old prior', async () => {
    const f = makeFakeCache();
    f.seed(KEY, aged(), 23 * 60 * 60);
    const load = vi.fn(async () => {
      throw new ProviderServerError('github.com', 503, 'Service Unavailable');
    });

    const r = await resolveLookup({
      cache: f.cache,
      key: KEY,
      load,
      bypassBackOffWhenUnservable: true,
      consumerPinsResult: true,
    });

    expect(load).toHaveBeenCalledTimes(1);
    expect(r.status).toBe('transient');
  });

  it('a prior INSIDE the bound is still stale-served to a pinned consumer', async () => {
    const f = makeFakeCache();
    // Deliberately NOT a `partial`: round 7 made those unpinnable at every exit
    // regardless of age, so a partial would no longer isolate the age bound.
    const pending = mkResult({ released: false });
    f.seed(KEY, pending, 10 * 60); // stale (past the 5-min freshness window), inside the 30-min bound
    f.seed(negKey, { transient: true, kind: 'github_server_error' }, 10);
    const load = vi.fn();

    const r = await resolveLookup({
      cache: f.cache,
      key: KEY,
      load,
      bypassBackOffWhenUnservable: true,
      consumerPinsResult: true,
    });

    expect(load).not.toHaveBeenCalled();
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.stale).toBe(true);
      expect(r.result).toEqual(pending);
    }
  });

  it('public routes keep UNBOUNDED stale-if-error — the bound is opt-in only', async () => {
    const f = makeFakeCache();
    const old = aged();
    f.seed(KEY, old, 23 * 60 * 60);
    const load = vi.fn(async () => {
      throw new ProviderServerError('github.com', 503, 'Service Unavailable');
    });

    // Same 23h prior, same failure — but no consumerPinsResult: a human page is
    // not pinned anywhere and shows an explicit "stale as of" caveat, so serving
    // through a long outage stays the right degrade.
    const r = await resolveLookup({ cache: f.cache, key: KEY, load });

    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.stale).toBe(true);
      expect(r.result).toEqual(old);
    }
  });
});

// Round-7 review of #144. The round-6 bound was consulted only on the three
// STALE exits. The fresh-hit return above them never asked — and `isFresh()`
// calls a `partial` fresh for its whole 60s life. Aligning this route onto the
// public five-part key (this PR) is what made that reachable: `badge.ts` loads
// the identical key with an 8s soft deadline, so on a large repo it writes a
// `partial` (firstRelease `null`) that `/internal` then served as a plain 200.
// web-og renders `firstRelease?.tag ?? 'not yet released'` and long-caches any
// non-null result, so a RELEASED commit gets a "not yet released" card pinned
// for a day — the CLAUDE.md guardrail ("Partial state != not yet released")
// and the exact outcome `consumerPinsResult` exists to prevent.
describe('resolveLookup — a pinned consumer is never handed a cached PARTIAL', () => {
  it('fresh exit: recomputes rather than serve a 10s-old partial written by badge.ts', async () => {
    const f = makeFakeCache();
    const truncated = mkResult({ released: false, partial: true });
    f.seed(KEY, truncated, 10); // well inside the 60s partial freshness window
    const fresh = mkResult({ released: true });
    const load = vi.fn().mockResolvedValue(fresh);

    const r = await resolveLookup({
      cache: f.cache,
      key: KEY,
      load,
      consumerPinsResult: true,
    });

    expect(load).toHaveBeenCalledTimes(1);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.result.firstRelease?.tag).toBe('4.18.0');
  });

  it('SWR exit: a fresh partial is not handed back while a refresh runs behind it', async () => {
    const f = makeFakeCache();
    const truncated = mkResult({ released: false, partial: true });
    f.seed(KEY, truncated, 10);
    const fresh = mkResult({ released: true });
    const load = vi.fn().mockResolvedValue(fresh);
    const tasks: Promise<unknown>[] = [];

    const r = await resolveLookup({
      cache: f.cache,
      key: KEY,
      load,
      revalidate: (t) => {
        tasks.push(t);
      },
      consumerPinsResult: true,
    });

    expect(tasks).toHaveLength(0); // blocked instead of stale-serving the partial
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.stale).toBe(false);
      expect(r.result.firstRelease?.tag).toBe('4.18.0');
    }
  });

  it('stale exit: a partial inside the 30-min bound is still not pinnable', async () => {
    const f = makeFakeCache();
    const truncated = mkResult({ released: false, partial: true });
    f.seed(KEY, truncated, 120); // past the 60s partial window, inside the 30-min bound
    f.seed(negKey, { transient: true, kind: 'github_server_error' }, 10);
    const fresh = mkResult({ released: true });
    const load = vi.fn().mockResolvedValue(fresh);

    const r = await resolveLookup({
      cache: f.cache,
      key: KEY,
      load,
      bypassBackOffWhenUnservable: true,
      consumerPinsResult: true,
    });

    expect(load).toHaveBeenCalledTimes(1);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.result.firstRelease?.tag).toBe('4.18.0');
  });

  it('public routes still get the fresh partial — the guard is opt-in only', async () => {
    const f = makeFakeCache();
    const truncated = mkResult({ released: false, partial: true });
    f.seed(KEY, truncated, 10);
    const load = vi.fn();

    // No consumerPinsResult: the result card renders `partial` as an explicit
    // best-effort caveat (CLAUDE.md), so a fresh partial is the right answer.
    const r = await resolveLookup({ cache: f.cache, key: KEY, load });

    expect(load).not.toHaveBeenCalled();
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.result).toEqual(truncated);
  });
});

// A RELEASED answer is terminal: which release first contains a commit cannot
// change, which is why `isFresh()` treats it as fresh forever and `hardTtlFor()`
// gives it a 30-day TTL. `MAX_STALE_PINNED` exists for the opposite case — a
// "not yet released" prior that has since shipped — so applying its 30-minute
// age bound to a terminal answer discards exactly the warm entries `/internal/*`
// joined the public key to reuse (#143), and pays a full findRelease on the
// crawler's critical path for every unfurl more than 30 minutes after the last
// write.
describe('resolveLookup — a terminal RELEASED prior stays pinnable at any age', () => {
  it('fresh exit: serves a 2h-old released prior instead of recomputing', async () => {
    const f = makeFakeCache();
    const released = mkResult({ released: true });
    f.seed(KEY, released, 2 * 60 * 60); // the normal state of a 30-day slot
    const load = vi.fn();

    const r = await resolveLookup({
      cache: f.cache,
      key: KEY,
      load,
      consumerPinsResult: true,
    });

    expect(load).not.toHaveBeenCalled();
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.cached).toBe(true);
      expect(r.result.firstRelease?.tag).toBe('4.18.0');
    }
  });

  it('back-off exit: an upstream outage still serves the 2h-old released prior', async () => {
    const f = makeFakeCache();
    const released = mkResult({ released: true });
    f.seed(KEY, released, 2 * 60 * 60);
    f.seed(negKey, { transient: true, kind: 'github_server_error' }, 10);
    const load = vi.fn();

    const r = await resolveLookup({
      cache: f.cache,
      key: KEY,
      load,
      bypassBackOffWhenUnservable: true,
      consumerPinsResult: true,
    });

    // Without the terminal exemption this returns `transient`, which web-og
    // renders as the neutral placeholder at max-age=60 — and each unfurl during
    // the outage runs its own lookup out to the soft deadline against the down
    // host.
    expect(load).not.toHaveBeenCalled();
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.result.firstRelease?.tag).toBe('4.18.0');
  });

  it('a 2h-old NOT-YET-released prior is still unpinnable — the bound it exists for', async () => {
    const f = makeFakeCache();
    const notYet = mkResult({ released: false });
    f.seed(KEY, notYet, 2 * 60 * 60);
    const fresh = mkResult({ released: true });
    const load = vi.fn().mockResolvedValue(fresh);

    const r = await resolveLookup({
      cache: f.cache,
      key: KEY,
      load,
      consumerPinsResult: true,
    });

    expect(load).toHaveBeenCalledTimes(1);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.result.firstRelease?.tag).toBe('4.18.0');
  });
});
