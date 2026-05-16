// makeWorkerCache: verifies the synthetic cache-key URL uses the worker's own
// hostname (taken from the incoming request), NOT a non-routable `.invalid`
// hostname. Cloudflare's Cache API only reliably persists puts whose key URL
// is on a real, routable hostname — `cache.invalid` puts silently no-op or get
// evicted aggressively, which is what was causing the live "second hit was
// still cold" bug.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { makeWorkerCache } from '../src/cache.js';

type FakeCache = {
  put: ReturnType<typeof vi.fn>;
  match: ReturnType<typeof vi.fn>;
};

function installFakeCache(): FakeCache {
  const cache: FakeCache = {
    put: vi.fn(async () => undefined),
    match: vi.fn(async () => undefined),
  };
  (globalThis as unknown as { caches: { default: FakeCache } }).caches = { default: cache };
  return cache;
}

describe('makeWorkerCache', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('keys puts on the request hostname, never on cache.invalid', async () => {
    const fake = installFakeCache();
    const req = new Request('https://released-web.lukaso.workers.dev/r/o/r/c/abc');
    const cache = makeWorkerCache(req);
    await cache.put('mykey', { hello: 'world' }, 1800);

    expect(fake.put).toHaveBeenCalledOnce();
    const [putReq] = fake.put.mock.calls[0] as [Request, Response];
    const url = new URL(putReq.url);
    expect(url.hostname).toBe('released-web.lukaso.workers.dev');
    expect(url.hostname).not.toContain('invalid');
    expect(url.pathname).toContain('mykey');
  });

  it('keys gets on the same URL shape as puts (round-trip)', async () => {
    const fake = installFakeCache();
    const req = new Request('https://released-web.lukaso.workers.dev/r/o/r/c/abc');
    const cache = makeWorkerCache(req);

    await cache.put('roundtrip-key', { answer: 42 }, 1800);
    await cache.get('roundtrip-key');

    const [putReq] = fake.put.mock.calls[0] as [Request, Response];
    const [matchReq] = fake.match.mock.calls[0] as [Request];
    expect(matchReq.url).toBe(putReq.url);
  });

  it('uses the request hostname even when called with different request URLs (same key → same cache URL)', async () => {
    const fake = installFakeCache();
    const reqA = new Request('https://released-web.lukaso.workers.dev/lookup?q=x');
    const reqB = new Request('https://released-web.lukaso.workers.dev/r/o/r/c/abc');

    const cacheA = makeWorkerCache(reqA);
    const cacheB = makeWorkerCache(reqB);

    await cacheA.put('shared-key', { v: 1 }, 1800);
    await cacheB.get('shared-key');

    const [putReq] = fake.put.mock.calls[0] as [Request, Response];
    const [matchReq] = fake.match.mock.calls[0] as [Request];
    expect(matchReq.url).toBe(putReq.url);
  });

  it('attaches public Cache-Control with the requested TTL', async () => {
    const fake = installFakeCache();
    const req = new Request('https://released-web.lukaso.workers.dev/');
    const cache = makeWorkerCache(req);

    await cache.put('k1', { x: 1 }, 60);
    const [, putRes] = fake.put.mock.calls[0] as [Request, Response];
    expect(putRes.headers.get('cache-control')).toBe('public, max-age=60');
  });
});
