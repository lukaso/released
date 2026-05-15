// Cloudflare Cache API wrapper (CacheStore impl).
// Synthesizes a Request/Response pair keyed by a synthetic URL so the global
// Cache API stores it. Same cacheKey() generator as the CLI (from @released/core).

import type { CacheStore } from '@released/core';

const CACHE_HOST = 'https://cache.invalid';

export function makeWorkerCache(ttlSecondsDefault = 1800): CacheStore {
  return {
    async get<T>(key: string): Promise<T | null> {
      const req = new Request(`${CACHE_HOST}/${key}`);
      const res = await (caches as unknown as { default: Cache }).default.match(req);
      if (!res) return null;
      try {
        return (await res.json()) as T;
      } catch {
        return null;
      }
    },

    async put<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
      const ttl = ttlSeconds ?? ttlSecondsDefault;
      const req = new Request(`${CACHE_HOST}/${key}`);
      const res = new Response(JSON.stringify(value), {
        headers: {
          'content-type': 'application/json',
          'cache-control': `public, max-age=${ttl}`,
        },
      });
      await (caches as unknown as { default: Cache }).default.put(req, res);
    },
  };
}
