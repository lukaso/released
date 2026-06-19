// POST /api/event — client-side interaction beacon (copies). Verifies it writes
// exactly one Analytics Engine data point for a valid same-origin copy, rejects
// cross-origin callers, ignores garbage, and is NOT double-counted by the
// per-request middleware logger in index.ts.

import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env.js';

// Polyfill the Workers-only `caches.default` so importing the app works.
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

function spyEnv() {
  const points: { indexes?: string[]; blobs?: string[]; doubles?: number[] }[] = [];
  const env = {
    ANALYTICS: { writeDataPoint: (dp: (typeof points)[number]) => points.push(dp) },
  } as unknown as Env;
  return { env, points };
}

function beacon(body: unknown, origin = 'https://released.example') {
  return new Request('https://released.example/api/event', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/event — copy/search beacon', () => {
  it('records exactly one copy data point (and is not double-counted by the logger)', async () => {
    const { default: app } = await import('../src/index.js');
    const { env, points } = spyEnv();
    const res = await app.fetch(
      beacon({ type: 'copy', format: 'badge', host: 'github.com', repo: 'facebook/zstd' }),
      env,
    );
    expect(res.status).toBe(204);
    // Exactly one — the beacon endpoint writes its own event AND is excluded from
    // the per-request middleware, so we never see a second 'other'/'api' point.
    expect(points).toHaveLength(1);
    expect(points[0]?.blobs?.[0]).toBe('copy');
    expect(points[0]?.blobs?.[1]).toBe('github.com');
    expect(points[0]?.blobs?.[2]).toBe('facebook/zstd');
    expect(points[0]?.blobs?.[9]).toBe('badge'); // format → blob10
  });

  it('rejects a cross-origin beacon with 403 and records nothing', async () => {
    const { default: app } = await import('../src/index.js');
    const { env, points } = spyEnv();
    const res = await app.fetch(
      beacon({ type: 'copy', format: 'link' }, 'https://evil.example'),
      env,
    );
    expect(res.status).toBe(403);
    expect(points).toHaveLength(0);
  });

  it('ignores an unknown event type (204, no data point)', async () => {
    const { default: app } = await import('../src/index.js');
    const { env, points } = spyEnv();
    const res = await app.fetch(beacon({ type: 'mystery' }), env);
    expect(res.status).toBe(204);
    expect(points).toHaveLength(0);
  });

  it('ignores a copy with an out-of-allowlist format (204, no data point)', async () => {
    const { default: app } = await import('../src/index.js');
    const { env, points } = spyEnv();
    const res = await app.fetch(beacon({ type: 'copy', format: 'exe' }), env);
    expect(res.status).toBe(204);
    expect(points).toHaveLength(0);
  });

  it('tolerates an unparseable body without throwing (204, no data point)', async () => {
    const { default: app } = await import('../src/index.js');
    const { env, points } = spyEnv();
    const res = await app.fetch(
      new Request('https://released.example/api/event', {
        method: 'POST',
        headers: { origin: 'https://released.example', 'content-type': 'application/json' },
        body: 'not json{',
      }),
      env,
    );
    expect(res.status).toBe(204);
    expect(points).toHaveLength(0);
  });
});
