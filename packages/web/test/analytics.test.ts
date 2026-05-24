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

import { type AnalyticsEvent, eventForPath, toDataPoint, track } from '../src/analytics.js';

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
    ]);
    expect(dp.doubles).toEqual([200, 12]);
  });

  it('falls back to the event name for the index when there is no repo', () => {
    const dp = toDataPoint({ event: 'home', status: 200 });
    expect(dp.indexes).toEqual(['home']);
    expect(dp.blobs?.[2]).toBe(''); // repo empty
    expect(dp.doubles).toEqual([200, 0]); // latency defaults to 0
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
});
