// Analytics Engine usage tracking — schema mapping + middleware wiring.

import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env.js';

// Polyfill the Workers-only `caches.default` so importing the app (which pulls in
// cache.ts) works, and badge/permalink routes can run.
const cacheStore = new Map<string, Response>();
(
  globalThis as unknown as {
    caches: { default: { match: typeof Cache.prototype.match; put: typeof Cache.prototype.put } };
  }
).caches = {
  default: {
    async match(req: Request | string) {
      const url = typeof req === 'string' ? req : req.url;
      const stored = cacheStore.get(url);
      return stored ? stored.clone() : undefined;
    },
    async put(req: Request | string, res: Response) {
      const url = typeof req === 'string' ? req : req.url;
      cacheStore.set(url, res);
    },
  } as unknown as Cache,
};

import {
  GitHubServerError,
  NotYetReleasedError,
  ProviderJsonError,
  ProviderServerError,
  RateLimitError,
} from '@released/core';
import {
  type AnalyticsEvent,
  eventForPath,
  refererHost,
  toDataPoint,
  track,
  upstreamStatusOf,
} from '../src/analytics.js';

// Spy Env whose ANALYTICS binding records every data point written.
function spyEnv() {
  const points: { indexes?: string[]; blobs?: string[]; doubles?: number[] }[] = [];
  const env = {
    ANALYTICS: { writeDataPoint: (dp: (typeof points)[number]) => points.push(dp) },
  } as unknown as Env;
  return { env, points };
}

describe('toDataPoint — schema mapping', () => {
  const full: AnalyticsEvent = {
    event: 'result',
    host: 'github.com',
    repo: 'facebook/react',
    outcome: 'released',
    cache: 'miss',
    kind: 'commit',
    audience: 'human',
    country: 'US',
    status: 200,
    latencyMs: 12,
  };

  it('maps a fully-populated event to index/blobs/doubles in the documented order', () => {
    const dp = toDataPoint(full);
    // Index = host-qualified repo so per-repo + badge-per-repo queries stay
    // sampling-fair under load.
    expect(dp.indexes).toEqual(['github.com/facebook/react']);
    expect(dp.blobs).toEqual([
      'result', // 1 event
      'github.com', // 2 host
      'facebook/react', // 3 repo
      'released', // 4 outcome
      'miss', // 5 cache
      'commit', // 6 kind
      'human', // 7 audience
      '', // 8 errorType (unset → empty)
      'US', // 9 country
      '', // 10 format (unset → empty; only copy events set it)
      '', // 11 referer (unset → empty)
      '', // 12 probe (unset → empty; only the synthetic liveness probe sets it)
    ]);
    expect(dp.doubles).toEqual([200, 12, 0]); // upstreamStatus unset → 0
  });

  it('marks synthetic liveness-probe traffic with blob12=1 (so error stats can exclude it)', () => {
    const dp = toDataPoint({
      event: 'result',
      host: 'github.com',
      repo: 'honojs/hono',
      outcome: 'error',
      errorType: 'lookup_timeout',
      probe: true,
      status: 200,
    });
    expect(dp.blobs?.[11]).toBe('1'); // probe → blob12
  });

  it('maps the referring host to blob11 (organic-vs-self attribution)', () => {
    const dp = toDataPoint({
      event: 'result',
      host: 'github.com',
      repo: 'facebook/react',
      referer: 'news.ycombinator.com',
      status: 200,
    });
    expect(dp.blobs?.[10]).toBe('news.ycombinator.com'); // referer → blob11
  });

  it('maps a copy event with its format to blob10 (the seeding signal)', () => {
    const dp = toDataPoint({
      event: 'copy',
      host: 'github.com',
      repo: 'facebook/zstd',
      format: 'badge',
      audience: 'human',
      country: 'US',
      status: 204,
    });
    expect(dp.blobs?.[0]).toBe('copy'); // event
    expect(dp.blobs?.[9]).toBe('badge'); // format → blob10
    // Indexed per-repo so "which repo's badge got copied" stays sampling-fair.
    expect(dp.indexes).toEqual(['github.com/facebook/zstd']);
  });

  it('records the upstream provider status as double3 (for error diagnosis)', () => {
    const dp = toDataPoint({
      event: 'pr',
      host: 'gitlab.gnome.org',
      repo: 'GNOME/gtk',
      outcome: 'error',
      errorType: 'ProviderServerError',
      status: 404, // what the worker returned to the client
      latencyMs: 2500,
      upstreamStatus: 503, // what gitlab.gnome.org returned to us
    });
    expect(dp.doubles).toEqual([404, 2500, 503]);
  });

  it('falls back to the event name for the index when there is no repo', () => {
    const dp = toDataPoint({ event: 'home', status: 200 });
    expect(dp.indexes).toEqual(['home']);
    expect(dp.blobs?.[2]).toBe(''); // repo empty
    expect(dp.doubles).toEqual([200, 0, 0]); // latency + upstreamStatus default to 0
  });

  it('caps the index at 96 bytes (Analytics Engine limit)', () => {
    const dp = toDataPoint({
      event: 'result',
      host: 'gitlab.com',
      repo: 'a'.repeat(200),
      status: 200,
    });
    expect((dp.indexes?.[0] ?? '').length).toBeLessThanOrEqual(96);
  });
});

describe('refererHost — reduce a Referer header to a privacy-safe hostname', () => {
  it('extracts only the hostname (no path, no query)', () => {
    expect(refererHost('https://gitlab.gnome.org/GNOME/gtk/-/merge_requests/1?tab=x')).toBe(
      'gitlab.gnome.org',
    );
    expect(refererHost('https://www.google.com/search?q=foo')).toBe('www.google.com');
  });

  it('returns empty for missing / blank / unparseable referers', () => {
    expect(refererHost(null)).toBe('');
    expect(refererHost(undefined)).toBe('');
    expect(refererHost('')).toBe('');
    expect(refererHost('not a url')).toBe('');
  });
});

describe('upstreamStatusOf — extract the provider HTTP status from a typed error', () => {
  it('reads .status off provider server errors (5xx and unhandled 4xx)', () => {
    expect(upstreamStatusOf(new ProviderServerError('gitlab.gnome.org', 503, 'x'))).toBe(503);
    expect(upstreamStatusOf(new GitHubServerError(500, 'x'))).toBe(500);
  });

  it('reads .status off a JSON/anti-bot challenge error', () => {
    expect(upstreamStatusOf(new ProviderJsonError(200, 'Just a moment…', new Error('bad')))).toBe(
      200,
    );
  });

  it('maps a rate-limit error to 429 (it carries resetAt, not a status)', () => {
    expect(upstreamStatusOf(new RateLimitError(1779721200, 'gitlab.gnome.org'))).toBe(429);
  });

  it('returns undefined for errors that are not upstream HTTP failures', () => {
    expect(upstreamStatusOf(new NotYetReleasedError('abc1234', '2026-01-01'))).toBeUndefined();
    expect(upstreamStatusOf(new Error('boom'))).toBeUndefined();
    expect(upstreamStatusOf(undefined)).toBeUndefined();
    expect(upstreamStatusOf(null)).toBeUndefined();
  });
});

describe('track — no-op when the binding is absent', () => {
  it('does not throw when env is undefined', () => {
    expect(() => track(undefined, { event: 'home', status: 200 })).not.toThrow();
  });

  it('does not throw when ANALYTICS is unbound (local dev)', () => {
    expect(() => track({} as Env, { event: 'home', status: 200 })).not.toThrow();
  });

  it('writes exactly one data point when the binding exists', () => {
    const { env, points } = spyEnv();
    track(env, { event: 'home', status: 200 });
    expect(points).toHaveLength(1);
    expect(points[0]?.blobs?.[0]).toBe('home');
  });
});

describe('eventForPath — route → event derivation', () => {
  it.each([
    ['/', 'home'],
    ['/lookup', 'redirect'],
    ['/r/facebook/react/c/abc1234', 'result'],
    ['/h/gitlab.com/r/foo%2Fbar/c/abc1234', 'result'],
    ['/p/facebook/react/123', 'pr'],
    ['/h/gitlab.com/p/foo%2Fbar/123', 'pr'],
    ['/r/facebook/react/c/abc1234/badge.svg', 'badge'],
    ['/h/gitlab.com/p/foo%2Fbar/123/badge.svg', 'badge'],
    ['/api/lookup', 'api_lookup'],
    ['/api/lookup-bulk', 'api_bulk'],
    ['/how-it-works', 'other'],
  ] as const)('%s → %s', (path, expected) => {
    expect(eventForPath(path)).toBe(expected);
  });
});

describe('middleware wiring (app.fetch with a spy ANALYTICS binding)', () => {
  it('records a home event for the homepage', async () => {
    const { default: app } = await import('../src/index.js');
    const { env, points } = spyEnv();
    const res = await app.fetch(new Request('https://released.example/'), env);
    expect(res.status).toBe(200);
    expect(points).toHaveLength(1);
    expect(points[0]?.blobs?.[0]).toBe('home');
    expect(points[0]?.doubles?.[0]).toBe(200); // status
  });

  it('records a badge event with host + repo for a (malformed-sha) badge fetch', async () => {
    const { default: app } = await import('../src/index.js');
    const { env, points } = spyEnv();
    const res = await app.fetch(
      new Request('https://released.example/r/facebook/react/c/not-a-sha/badge.svg'),
      env,
    );
    expect(res.status).toBe(200);
    expect(points).toHaveLength(1);
    expect(points[0]?.blobs?.[0]).toBe('badge');
    expect(points[0]?.blobs?.[1]).toBe('github.com');
    expect(points[0]?.blobs?.[2]).toBe('facebook/react');
  });

  it('does NOT record an event for the /healthz liveness probe', async () => {
    const { default: app } = await import('../src/index.js');
    const { env, points } = spyEnv();
    await app.fetch(new Request('https://released.example/healthz'), env);
    expect(points).toHaveLength(0);
  });

  it('marks the synthetic liveness probe (by its user-agent) with blob12=1', async () => {
    const { default: app } = await import('../src/index.js');
    const { env, points } = spyEnv();
    await app.fetch(
      new Request('https://released.example/', {
        headers: { 'user-agent': 'liveapp-liveness-probe/1' },
      }),
      env,
    );
    expect(points).toHaveLength(1);
    expect(points[0]?.blobs?.[11]).toBe('1'); // probe → blob12
  });

  it('leaves blob12 empty for ordinary (non-probe) traffic', async () => {
    const { default: app } = await import('../src/index.js');
    const { env, points } = spyEnv();
    await app.fetch(
      new Request('https://released.example/', { headers: { 'user-agent': 'Mozilla/5.0' } }),
      env,
    );
    expect(points).toHaveLength(1);
    expect(points[0]?.blobs?.[11]).toBe(''); // not a probe → empty
  });

  it('enriches a UI search (/lookup) with host+repo+kind on a valid query', async () => {
    const { default: app } = await import('../src/index.js');
    const { env, points } = spyEnv();
    const res = await app.fetch(
      new Request(
        `https://released.example/lookup?q=${encodeURIComponent('facebook/react@abc1234')}`,
      ),
      env,
    );
    expect(res.status).toBe(302); // redirect to the canonical permalink
    expect(points).toHaveLength(1);
    expect(points[0]?.blobs?.[0]).toBe('redirect'); // event
    expect(points[0]?.blobs?.[1]).toBe('github.com'); // host
    expect(points[0]?.blobs?.[2]).toBe('facebook/react'); // repo
    expect(points[0]?.blobs?.[5]).toBe('commit'); // kind
  });

  it('marks an invalid UI search as outcome=invalid (failed-search funnel)', async () => {
    const { default: app } = await import('../src/index.js');
    const { env, points } = spyEnv();
    const res = await app.fetch(
      new Request(`https://released.example/lookup?q=${encodeURIComponent('not a real ref')}`),
      env,
    );
    expect(res.status).toBe(302); // bounces back to /?bad=…
    expect(points).toHaveLength(1);
    expect(points[0]?.blobs?.[0]).toBe('redirect'); // event
    expect(points[0]?.blobs?.[3]).toBe('invalid'); // outcome
  });
});
