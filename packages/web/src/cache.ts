// Cloudflare Cache API wrapper (CacheStore impl).
// Synthesizes a Request/Response pair keyed by a synthetic URL so the global
// Cache API stores it. Same cacheKey() generator as the CLI (from @released/core).
//
// IMPORTANT: the synthetic URL MUST be on the worker's own hostname.
// Cloudflare's Cache API silently no-ops (or evicts aggressively) for puts
// whose URL is on a non-routable hostname like cache.invalid — which was
// causing live "second hit was still cold" symptoms. Pass the incoming
// request into makeWorkerCache so we can derive `${origin}/__cache__/${key}`.

import type { CacheStore } from '@released/core';

export function makeWorkerCache(req: Request, ttlSecondsDefault = 1800): CacheStore {
  const origin = new URL(req.url).origin;
  const keyUrl = (key: string) => `${origin}/__cache__/${encodeURIComponent(key)}`;

  return {
    async get<T>(key: string): Promise<T | null> {
      const cacheReq = new Request(keyUrl(key));
      const res = await (caches as unknown as { default: Cache }).default.match(cacheReq);
      if (!res) return null;
      try {
        return (await res.json()) as T;
      } catch {
        return null;
      }
    },

    async put<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
      const ttl = ttlSeconds ?? ttlSecondsDefault;
      const cacheReq = new Request(keyUrl(key));
      const res = new Response(JSON.stringify(value), {
        headers: {
          'content-type': 'application/json',
          'cache-control': `public, max-age=${ttl}`,
        },
      });
      await (caches as unknown as { default: Cache }).default.put(cacheReq, res);
    },
  };
}
