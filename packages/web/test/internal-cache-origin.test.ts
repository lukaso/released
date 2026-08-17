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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cacheKey, ProviderServerError } from '@released/core';
import { parse as parseToml } from 'smol-toml';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// findRelease is the upstream lookup. Mocking it lets a cache HIT be proven by
// "the provider was never consulted", and lets the cold path complete without network.
const findReleaseMock = vi.hoisted(() => vi.fn());
vi.mock('@released/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@released/core')>();
  return { ...actual, findRelease: findReleaseMock };
});

// Polyfill the Workers-only `caches.default` so cache.ts works under Node.
// `cacheFault` lets a test make the Cache API itself fail, which is the failure
// mode the real edge has for a key URL on an origin this Worker doesn't serve.
const cacheStore = new Map<string, Response>();
let cacheFault: 'none' | 'match' | 'put' = 'none';
(globalThis as unknown as { caches: { default: Cache } }).caches = {
  default: {
    async match(req: Request | string) {
      if (cacheFault === 'match') throw new Error('cache read refused');
      const url = typeof req === 'string' ? req : req.url;
      const stored = cacheStore.get(url);
      return stored ? stored.clone() : undefined;
    },
    async put(req: Request | string, res: Response) {
      if (cacheFault === 'put') throw new Error('cache write refused');
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

/** Seed a slot with an explicit age, the way cache.ts stamps `x-cached-at`. */
function seedAged(origin: string, key: string, value: unknown, ageSeconds: number): void {
  cacheStore.set(
    keyUrl(origin, key),
    new Response(JSON.stringify(value), {
      headers: {
        'content-type': 'application/json',
        'x-cached-at': String(Date.now() - ageSeconds * 1000),
      },
    }),
  );
}

/** A non-terminal result — looked up, not in a release yet. The shared policy
 *  (resolve.ts) revalidates these every 5 minutes; `subject` identifies which
 *  copy of the answer a response came from. */
function pendingFixture(subject: string): unknown {
  return { ...(fixture('unused') as Record<string, unknown>), firstRelease: null, subject };
}

/** A soft-deadline best-effort answer that ran out of budget before finding a
 *  containing release. The shared policy trusts these for 60 seconds — and the
 *  OG path is the deadline-pressured one, so it produces them most. */
function partialFixture(): unknown {
  return {
    ...(fixture('unused') as Record<string, unknown>),
    firstRelease: null,
    partial: { reason: 'soft_deadline', candidatesTried: 3 },
  };
}

async function subjectOf(res: Response): Promise<string | undefined> {
  const body = (await res.json()) as { subject?: string };
  return body.subject;
}

function cacheControlOf(origin: string, key: string): string | null {
  return cacheStore.get(keyUrl(origin, key))?.headers.get('cache-control') ?? null;
}

beforeEach(() => {
  cacheStore.clear();
  cacheFault = 'none';
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

// Sharing the slot with the public routes means sharing the POLICY that governs
// it (resolve.ts): 30-day terminal / 24h pending / 60s partial hard TTLs, a
// 5-minute freshness window, and a negative back-off. /internal used to invent a
// flat 30-minute TTL and a bare read, so a cold OG render could downgrade a
// terminal slot to 30 minutes and keep serving a 60-second partial for half an hour.
describe('/internal/* follows the cache policy that governs the shared slot', () => {
  it('writes a terminal answer with the public routes 30-day hard TTL', async () => {
    findReleaseMock.mockResolvedValue(fixture('v4.10.0'));

    const res = await app.fetch(svc(`https://web/internal/result/honojs/hono/${SHA}`), ENV);
    expect(res.status).toBe(200);

    const k = await publicKey('github.com/honojs/hono', `sha:${SHA}`);
    expect(cacheControlOf(PUBLIC_ORIGIN, k)).toBe(`public, max-age=${30 * 24 * 60 * 60}`);
  });

  it('writes a soft-deadline partial with the 60-second TTL, not a flat 30 minutes', async () => {
    findReleaseMock.mockResolvedValue(partialFixture());

    const res = await app.fetch(svc(`https://web/internal/result/honojs/hono/${SHA}`), ENV);
    expect(res.status).toBe(200);

    const k = await publicKey('github.com/honojs/hono', `sha:${SHA}`);
    expect(cacheControlOf(PUBLIC_ORIGIN, k)).toBe('public, max-age=60');
  });

  it('revalidates a pending answer past its 5-minute freshness window', async () => {
    const k = await publicKey('github.com/honojs/hono', `sha:${SHA}`);
    seedAged(PUBLIC_ORIGIN, k, pendingFixture('stale pending'), 10 * 60);
    findReleaseMock.mockResolvedValue(fixture('v4.12.0'));

    const res = await app.fetch(svc(`https://web/internal/result/honojs/hono/${SHA}`), ENV);

    expect(res.status).toBe(200);
    // The public page would already be showing v4.12.0; the OG card must not keep
    // rendering the pending answer for another 30 minutes.
    expect(await tagOf(res)).toBe('v4.12.0');
    expect(findReleaseMock).toHaveBeenCalledOnce();
  });

  it('serves the last-known-good answer when the upstream blips, and backs off', async () => {
    const k = await publicKey('github.com/honojs/hono', `sha:${SHA}`);
    seedAged(PUBLIC_ORIGIN, k, pendingFixture('last known good'), 10 * 60);
    findReleaseMock.mockRejectedValue(
      new ProviderServerError('github.com', 503, 'Service Unavailable'),
    );

    const res = await app.fetch(svc(`https://web/internal/result/honojs/hono/${SHA}`), ENV);

    expect(res.status).toBe(200);
    expect(await subjectOf(res)).toBe('last known good');
    // And the next unfurl inside the back-off window must not re-hit the down host.
    expect([...cacheStore.keys()]).toContain(keyUrl(PUBLIC_ORIGIN, `${k}:neg`));
  });
});

// The key URL is deliberately NOT this request's own origin (the Service Binding
// arrives on `https://web`), and the Cache API is entitled to refuse such a
// write. A refusal must degrade to "served, just not cached" — a 503 here is
// what web-og turns into the neutral placeholder, which IS the #143 symptom.
describe('/internal/* never turns a Cache API failure into a placeholder', () => {
  it('serves the computed answer when the cache WRITE is refused', async () => {
    findReleaseMock.mockResolvedValue(fixture('v4.13.0'));
    cacheFault = 'put';

    const res = await app.fetch(svc(`https://web/internal/result/honojs/hono/${SHA}`), ENV);

    expect(res.status).toBe(200);
    expect(await tagOf(res)).toBe('v4.13.0');
  });

  it('serves the computed answer when the cache READ throws', async () => {
    findReleaseMock.mockResolvedValue(fixture('v4.14.0'));
    cacheFault = 'match';

    const res = await app.fetch(svc(`https://web/internal/result/honojs/hono/${SHA}`), ENV);

    expect(res.status).toBe(200);
    expect(await tagOf(res)).toBe('v4.14.0');
    expect(findReleaseMock).toHaveBeenCalledOnce();
  });
});

// PROD_HOST is committed in BOTH [vars] and [env.preview.vars], so without an
// explicit override the preview Worker would key /internal on the production
// origin — a host it does not serve — while its own public routes key on the
// preview origin. That is the #143 misalignment, still live in the one
// environment OG changes get reviewed in.
describe('preview keys the result cache on an origin it actually serves', () => {
  const cfg = parseToml(
    readFileSync(fileURLToPath(new URL('../wrangler.toml', import.meta.url)), 'utf8'),
  ) as {
    vars: { PROD_HOST: string };
    env: { preview: { name: string; vars: { PUBLIC_BASE_URL?: string } } };
  };

  it('sets PUBLIC_BASE_URL in [env.preview.vars] to the preview Worker own origin', () => {
    const url = cfg.env.preview.vars.PUBLIC_BASE_URL;
    expect(url, 'preview must override the inherited prod cache origin').toBeTypeOf('string');
    const host = new URL(url as string).host;
    expect(host).not.toBe(cfg.vars.PROD_HOST);
    expect(host).toContain(cfg.env.preview.name);
  });
});
