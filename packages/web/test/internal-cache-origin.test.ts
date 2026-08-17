// Guard for #143: every cold-cache OG unfurl served the neutral placeholder,
// because the /internal/* result endpoint web-og calls could not see — or write —
// the result cache the public permalink routes use.
//
// Two independent misalignments caused it, and this file pins BOTH:
//
//  1. ORIGIN. web-og calls `env.WEB.fetch('https://web/internal/...')`, so
//     makeWorkerCache derived the key URL `https://web/__cache__/...`. That is a
//     different namespace from the public routes' `https://<public-host>/__cache__/...`,
//     and `web` is a non-routable hostname, which the Cache API silently declines to
//     store — the same class of bug cache.ts's header note records for `cache.invalid`.
//     So the OG path neither read nor wrote the cache, and never self-healed.
//  2. KEY PARTS. The public routes key on the 5-part
//     ('res', host/path, 'sha:<sha>' | 'issue#<n>' | 'pr#<n>', 'cull', 'nopre');
//     /internal keyed on a 3-part ('res', host/path, 'sha:<sha>' | 'issue:<n>').
//     Even with the origin fixed, that can never hit a public-route entry.
//
// Every test here calls the route with the REAL production URL shape
// (`https://web/internal/...`). The pre-existing /internal tests in
// integration.test.ts all use a public-looking `https://released.example/...`, which
// is exactly why this regression shipped green.

import { cacheKey } from '@released/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// findRelease is the upstream lookup. Mocking it lets a cache HIT be proven by
// "the provider was never consulted", and lets the cold path complete without network.
const findReleaseMock = vi.hoisted(() => vi.fn());
vi.mock('@released/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@released/core')>();
  return { ...actual, findRelease: findReleaseMock };
});

// Polyfill the Workers-only `caches.default` so cache.ts works under Node.
const cacheStore = new Map<string, Response>();
(globalThis as unknown as { caches: { default: Cache } }).caches = {
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

const { default: app } = await import('../src/index.js');

const INTERNAL_SECRET = 'test-shared-secret';
const PROD_HOST = 'released.blabberate.com';
const PUBLIC_ORIGIN = `https://${PROD_HOST}`;
const ENV = { INTERNAL_SECRET, PROD_HOST };
const SHA = 'a'.repeat(40);

/** The cache key the PUBLIC permalink routes write (result.tsx / issue.tsx / pr.tsx):
 *  5 parts, ending in the default `cull` + `nopre` option suffixes. */
function publicKey(repo: string, idPart: string): Promise<string> {
  return cacheKey('res', repo, idPart, 'cull', 'nopre');
}

function keyUrl(origin: string, key: string): string {
  return `${origin}/__cache__/${encodeURIComponent(key)}`;
}

function seed(origin: string, key: string, value: unknown): void {
  cacheStore.set(
    keyUrl(origin, key),
    new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }),
  );
}

/** Partial LookupResult — only the fields the route serializes back. */
function fixture(tag: string): unknown {
  return {
    input: { kind: 'commit', repo: { host: 'github.com', projectPath: 'honojs/hono' }, sha: SHA },
    canonicalSha: SHA,
    firstRelease: { tag, sha: 'tagsha', date: '2024-02-01T00:00:00Z', url: '' },
    alsoIn: [],
    releaseNotesHtml: null,
    rateLimit: null,
  };
}

/** A request in the shape web-og actually sends over the Service Binding. */
function svc(url: string): Request {
  return new Request(url, { headers: { 'x-released-internal': INTERNAL_SECRET } });
}

async function tagOf(res: Response): Promise<string | undefined> {
  const body = (await res.json()) as { firstRelease?: { tag?: string } };
  return body.firstRelease?.tag;
}

beforeEach(() => {
  cacheStore.clear();
  findReleaseMock.mockReset();
});

describe('/internal/* reads the cache the PUBLIC routes populate (#143)', () => {
  it('serves a commit result the public permalink route already cached', async () => {
    const k = await publicKey('github.com/honojs/hono', `sha:${SHA}`);
    seed(PUBLIC_ORIGIN, k, fixture('v4.8.12'));

    const res = await app.fetch(svc(`https://web/internal/result/honojs/hono/${SHA}`), ENV);

    expect(res.status).toBe(200);
    expect(await tagOf(res)).toBe('v4.8.12');
    // The whole point: a warm public route means the OG render costs no lookup.
    expect(findReleaseMock).not.toHaveBeenCalled();
  });

  it('serves an issue result on the public `issue#<n>` key, not the legacy `issue:<n>`', async () => {
    const k = await publicKey('github.com/honojs/hono', 'issue#11');
    seed(PUBLIC_ORIGIN, k, fixture('v0.0.11'));

    const res = await app.fetch(svc('https://web/internal/issue/honojs/hono/11'), ENV);

    expect(res.status).toBe(200);
    expect(await tagOf(res)).toBe('v0.0.11');
    expect(findReleaseMock).not.toHaveBeenCalled();
  });

  it('serves a PR result on the public `pr#<n>` key, not the legacy `pr:<n>`', async () => {
    const k = await publicKey('github.com/honojs/hono', 'pr#4800');
    seed(PUBLIC_ORIGIN, k, fixture('v4.9.0'));

    const res = await app.fetch(svc('https://web/internal/pr/honojs/hono/4800'), ENV);

    expect(res.status).toBe(200);
    expect(await tagOf(res)).toBe('v4.9.0');
    expect(findReleaseMock).not.toHaveBeenCalled();
  });

  it('serves a federated (non-GitHub) commit result from the host-keyed public slot', async () => {
    const k = await publicKey('gitlab.gnome.org/GNOME/gimp', `sha:${SHA}`);
    seed(PUBLIC_ORIGIN, k, fixture('GIMP_2_10_36'));

    const res = await app.fetch(
      svc(`https://web/internal/h/gitlab.gnome.org/r/GNOME%2Fgimp/${SHA}`),
      ENV,
    );

    expect(res.status).toBe(200);
    expect(await tagOf(res)).toBe('GIMP_2_10_36');
    expect(findReleaseMock).not.toHaveBeenCalled();
  });
});

describe('/internal/* WRITES back to the slot the public routes read (#143)', () => {
  it('warms the public cache key on a cold lookup, and writes nothing under `https://web`', async () => {
    findReleaseMock.mockResolvedValue(fixture('v4.10.0'));

    const res = await app.fetch(svc(`https://web/internal/result/honojs/hono/${SHA}`), ENV);
    expect(res.status).toBe(200);
    expect(await tagOf(res)).toBe('v4.10.0');
    expect(findReleaseMock).toHaveBeenCalledOnce();

    // The cold OG render must leave the answer where the public route will find it,
    // otherwise every unfurl pays a full lookup forever (the #143 "does not self-heal").
    const k = await publicKey('github.com/honojs/hono', `sha:${SHA}`);
    expect([...cacheStore.keys()]).toContain(keyUrl(PUBLIC_ORIGIN, k));

    // And nothing may land in the non-routable Service-Binding namespace, which the
    // real Cache API silently drops.
    expect([...cacheStore.keys()].filter((u) => u.startsWith('https://web/'))).toEqual([]);
  });
});

describe('/internal/* cache origin falls back to the request origin', () => {
  it('uses the request origin when no PROD_HOST/PUBLIC_BASE_URL is configured', async () => {
    // `wrangler dev` and the unit tests have neither var set; the route must still
    // key on something routable rather than hardcoding the production hostname.
    const k = await publicKey('github.com/honojs/hono', `sha:${SHA}`);
    seed('https://released.example', k, fixture('v4.7.0'));

    const res = await app.fetch(
      svc(`https://released.example/internal/result/honojs/hono/${SHA}`),
      { INTERNAL_SECRET },
    );

    expect(res.status).toBe(200);
    expect(await tagOf(res)).toBe('v4.7.0');
    expect(findReleaseMock).not.toHaveBeenCalled();
  });

  it('prefers an explicit PUBLIC_BASE_URL over PROD_HOST', async () => {
    const k = await publicKey('github.com/honojs/hono', `sha:${SHA}`);
    seed('https://staging.example', k, fixture('v4.6.0'));

    const res = await app.fetch(svc(`https://web/internal/result/honojs/hono/${SHA}`), {
      INTERNAL_SECRET,
      PROD_HOST,
      PUBLIC_BASE_URL: 'https://staging.example/',
    });

    expect(res.status).toBe(200);
    expect(await tagOf(res)).toBe('v4.6.0');
    expect(findReleaseMock).not.toHaveBeenCalled();
  });
});
