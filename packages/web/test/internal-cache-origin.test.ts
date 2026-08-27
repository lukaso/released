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
// The real in-isolate flight registry the routes use — a test can register a
// flight the way a concurrent badge request would, and see who runs the loader.
const { singleFlight } = await import('../src/single-flight.js');

const INTERNAL_SECRET = 'test-shared-secret';
const PROD_HOST = 'released.blabberate.com';
const PUBLIC_ORIGIN = `https://${PROD_HOST}`;
const ENV = { INTERNAL_SECRET, PROD_HOST };
const SHA = 'a'.repeat(40);
// What web-og ACTUALLY puts in the internal URL for a commit: ogImageUrlForCommit
// -> shortSha(sha) -> 7 characters (ui/og-meta.tsx). The rest of this file uses the
// 40-char form; these two must both work, and #147 tracks the fact that they are
// two different slots.
const SHORT_SHA = SHA.slice(0, 7);

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
 *  copy of the answer a response came from.
 *
 *  Honest scope (round 9, #144): `findRelease` does not currently EMIT this shape.
 *  Its three LookupResult return sites are a terminal answer, a gallop-hit
 *  `partial`, and a soft-deadline `partial` with `firstRelease: null`; a genuine
 *  "not yet released" is a thrown NotYetReleasedError, never a cached result. So
 *  the tests below that seed it exercise resolve.ts's GENERIC pending branch
 *  (HARD_TTL_PENDING / FRESH_WINDOW_PENDING, both pre-dating this PR) through this
 *  route — they are not evidence about a state production can reach today. Any
 *  claim about the OG path's reachable behaviour must be pinned on one of the two
 *  shapes above instead. */
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

/** Let a background (waitUntil) refresh run to completion. Must flush MACROtasks,
 *  not just microtasks: the refresh chain awaits several real promises, and
 *  singleFlight keeps a module-level in-flight entry per key that only clears when
 *  the load settles — leaving one pending would make the NEXT test join it. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
}

/** The tag currently stored in a cache slot — how a BACKGROUND refresh is proven
 *  to have landed, since it by definition isn't in the response body. */
async function tagOfSlot(origin: string, key: string): Promise<string | undefined> {
  const stored = cacheStore.get(keyUrl(origin, key));
  if (!stored) return undefined;
  const body = (await stored.clone().json()) as { firstRelease?: { tag?: string } };
  return body.firstRelease?.tag;
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

// The commit URL web-og really sends is the 7-char one, so the origin fix has to
// hold for that shape too — the rest of this file exercises the 40-char form.
//
// NOTE the half this PR deliberately does NOT fix: the public permalink route keys
// on the sha as it appears in the page URL, and /lookup redirects to the FULL 40
// chars (index.ts, "short prefixes collide in large repos"). So `sha:<7>` and
// `sha:<40>` are different digests and the first unfurl of a full-sha permalink is
// still cold. That is #147 — its fix lives in ui/og-meta.tsx / result.tsx, files
// this PR does not touch, and changes the PUBLIC routes' key namespace.
describe('/internal/* keys a commit on the sha web-og really sends (7 chars, #147)', () => {
  it('serves a cached result on the short-sha public key shape', async () => {
    const k = await publicKey('github.com/honojs/hono', `sha:${SHORT_SHA}`);
    seed(PUBLIC_ORIGIN, k, fixture('v4.9.9'));

    const res = await app.fetch(svc(`https://web/internal/result/honojs/hono/${SHORT_SHA}`), ENV);
    expect(res.status).toBe(200);
    expect(await tagOf(res)).toBe('v4.9.9');
    // A cache HIT is proven by never consulting the provider.
    expect(findReleaseMock).not.toHaveBeenCalled();
  });

  it('writes a cold short-sha lookup back to the public origin, not `https://web`', async () => {
    findReleaseMock.mockResolvedValue(fixture('v4.10.0'));

    const res = await app.fetch(svc(`https://web/internal/result/honojs/hono/${SHORT_SHA}`), ENV);
    expect(res.status).toBe(200);
    expect(findReleaseMock).toHaveBeenCalledOnce();

    const k = await publicKey('github.com/honojs/hono', `sha:${SHORT_SHA}`);
    expect([...cacheStore.keys()]).toContain(keyUrl(PUBLIC_ORIGIN, k));
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
    // The RESPONSE is a 503 (a computed partial is never pinned — see the
    // guardrail suite below); the point here is that the write-back still
    // happens, and lands on the shared 60-second partial TTL rather than
    // /internal's old flat 30 minutes, so a public page view can reuse it.
    expect(res.status).toBe(503);

    const k = await publicKey('github.com/honojs/hono', `sha:${SHA}`);
    expect(cacheControlOf(PUBLIC_ORIGIN, k)).toBe('public, max-age=60');
  });

  // Round 9 (#144). The partial above has `firstRelease: null`, which `hardTtlFor()`
  // already routes to its 60-second branch. The OTHER partial shape does not:
  // find-release.ts (~295) returns the gallop hit WITH `partial`, and `hardTtlFor()`
  // tests `firstRelease` BEFORE `partial`, so it takes the terminal 30-day branch —
  // and `isFresh()` reports it fresh forever for the same reason. On `main` that
  // could not reach the public routes: /internal wrote a flat 30 minutes onto a key
  // nothing else read. Sharing the slot (this PR) makes the most deadline-pressured
  // producer of partials a WRITER into it, so one OG-triggered truncated traversal
  // would pin the permalink and the badge to a tag the bisect never confirmed for a
  // month, with no upstream call able to correct it. `unpinnable` trusts a partial
  // for 60 seconds and no longer, so the long TTL buys this route nothing.
  // (#155 tracks the same misclassification on the public routes' OWN writes.)
  it('writes a gallop-only partial with the 60-second TTL, not the terminal 30 days', async () => {
    const sha = '9'.repeat(40);
    findReleaseMock.mockResolvedValue({
      ...(fixture('v4.19.0') as Record<string, unknown>),
      partial: { reason: 'soft_deadline', candidatesTried: 3 },
    });

    const res = await app.fetch(svc(`https://web/internal/result/honojs/hono/${sha}`), ENV);
    expect(res.status).toBe(503); // never pinned to the crawler — the round-8 guard

    const k = await publicKey('github.com/honojs/hono', `sha:${sha}`);
    expect(cacheControlOf(PUBLIC_ORIGIN, k)).toBe('public, max-age=60');
  });

  // The complement: narrowing the TTL for a pinning consumer must not touch the
  // answer the route actually exists to reuse. A terminal result still gets 30 days.
  it('a terminal answer keeps the 30-day TTL when the SAME caller writes it', async () => {
    const sha = 'a'.repeat(40);
    findReleaseMock.mockResolvedValue(fixture('v4.18.0'));

    const res = await app.fetch(svc(`https://web/internal/result/honojs/hono/${sha}`), ENV);
    expect(res.status).toBe(200);

    const k = await publicKey('github.com/honojs/hono', `sha:${sha}`);
    expect(cacheControlOf(PUBLIC_ORIGIN, k)).toBe(`public, max-age=${30 * 24 * 60 * 60}`);
  });

  it('revalidates a pending answer past its 5-minute freshness window', async () => {
    const k = await publicKey('github.com/honojs/hono', `sha:${SHA}`);
    seedAged(PUBLIC_ORIGIN, k, pendingFixture('stale pending'), 10 * 60);
    findReleaseMock.mockResolvedValue(fixture('v4.12.0'));

    const res = await app.fetch(svc(`https://web/internal/result/honojs/hono/${SHA}`), ENV);
    await settle();

    expect(res.status).toBe(200);
    // The revalidation happens on the render path (this route blocks; #152) and
    // the slot ends up refreshed, so the OG card can't keep rendering the stale
    // answer for another 30 minutes.
    expect(findReleaseMock).toHaveBeenCalledOnce();
    expect(await tagOfSlot(PUBLIC_ORIGIN, k)).toBe('v4.12.0');
  });

  it('serves the last-known-good answer when the upstream blips, and backs off', async () => {
    const k = await publicKey('github.com/honojs/hono', `sha:${SHA}`);
    seedAged(PUBLIC_ORIGIN, k, pendingFixture('last known good'), 10 * 60);
    findReleaseMock.mockRejectedValue(
      new ProviderServerError('github.com', 503, 'Service Unavailable'),
    );

    const res = await app.fetch(svc(`https://web/internal/result/honojs/hono/${SHA}`), ENV);
    await settle();

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

// The other half of the same failure, and the one that has no fix at runtime:
// `cacheOrigin` falls back to the REQUEST origin, which for a real Service
// Binding is web-og's hardcoded `https://web` — a non-routable single-label host
// the Cache API declines, i.e. #143 exactly, swallowed by neverFatal. The config
// is the only place that can be guarded, so guard it there.
//
// Guard the invariant that actually broke, not a weaker one that survives it.
// `[env.preview]` DID declare a var — it copied the production `PROD_HOST`, which
// every env pins because it gates analytics — and keyed /internal on the prod
// origin while serving `released-web-preview.*.workers.dev`. So "PROD_HOST or
// PUBLIC_BASE_URL is set and routable" goes GREEN on the exact config this PR is
// fixing. What a named env must have is a cache origin OF ITS OWN.
type WranglerCfg = {
  vars?: Record<string, string>;
  env?: Record<string, { name?: string; vars?: Record<string, string> }>;
};

/** The invariant as a pure function, so it can be run against configs that are
 *  KNOWN BAD as well as the committed one. A checker that has only ever seen the
 *  good config demonstrates nothing about what it rejects. Returns one string per
 *  violation; `[]` means the config cannot reintroduce #143's namespace split. */
function cacheOriginProblems(cfg: WranglerCfg): string[] {
  const problems: string[] = [];
  const hostOf = (value: string): string | null => {
    try {
      return new URL(value.includes('//') ? value : `https://${value}`).host;
    } catch {
      return null;
    }
  };
  // `host` keeps the port, which is what makes a single-label dev origin real.
  const routable = (host: string): boolean => host.includes('.') || host.startsWith('localhost');

  const topConfigured = cfg.vars?.PUBLIC_BASE_URL ?? cfg.vars?.PROD_HOST;
  const prodHost = topConfigured ? hostOf(topConfigured) : null;
  if (!topConfigured) {
    problems.push('[vars] sets neither PROD_HOST nor PUBLIC_BASE_URL');
  } else if (!prodHost || !routable(prodHost)) {
    problems.push(`[vars] cache origin \`${topConfigured}\` is not routable`);
  }

  for (const [name, e] of Object.entries(cfg.env ?? {})) {
    const url = e.vars?.PUBLIC_BASE_URL;
    if (!url) {
      problems.push(
        `[env.${name}.vars] does not set its own PUBLIC_BASE_URL — /internal falls back to PROD_HOST and keys the result cache on an origin this Worker does not serve`,
      );
      continue;
    }
    const host = hostOf(url);
    if (!host || !routable(host)) {
      problems.push(`[env.${name}.vars] PUBLIC_BASE_URL \`${url}\` is not routable`);
      continue;
    }
    if (host === prodHost) {
      problems.push(`[env.${name}.vars] PUBLIC_BASE_URL keys on the PRODUCTION origin \`${host}\``);
    }
  }
  return problems;
}

describe('every deployed environment configures a routable cache origin of its OWN', () => {
  const cfg = parseToml(
    readFileSync(fileURLToPath(new URL('../wrangler.toml', import.meta.url)), 'utf8'),
  ) as WranglerCfg;

  it('holds for the committed wrangler.toml', () => {
    expect(cacheOriginProblems(cfg)).toEqual([]);
  });

  it('runs against the real named environments, so it cannot pass vacuously', () => {
    expect(Object.keys(cfg.env ?? {})).toContain('preview');
  });

  it('rejects the pre-fix [env.preview] — the config that actually shipped #143', () => {
    const preFix: WranglerCfg = {
      vars: { PROD_HOST },
      // Exactly what was committed before this PR: the prod PROD_HOST copied in
      // (it gates analytics, so every env pins it) and no origin of its own.
      env: { preview: { name: 'released-web-preview', vars: { ANUBIS_HOSTS: '', PROD_HOST } } },
    };
    expect(cacheOriginProblems(preFix)).toEqual([
      expect.stringContaining('[env.preview.vars] does not set its own PUBLIC_BASE_URL'),
    ]);
  });

  it('rejects a NEW env that copies PROD_HOST the way [env.preview] once did', () => {
    const withStaging: WranglerCfg = {
      ...cfg,
      env: {
        ...cfg.env,
        staging: { name: 'released-web-staging', vars: { ANUBIS_HOSTS: '', PROD_HOST } },
      },
    };
    expect(cacheOriginProblems(withStaging)).toEqual([
      expect.stringContaining('[env.staging.vars] does not set its own PUBLIC_BASE_URL'),
    ]);
  });

  it('rejects an env whose PUBLIC_BASE_URL IS the production origin', () => {
    const aliased: WranglerCfg = {
      ...cfg,
      env: {
        ...cfg.env,
        staging: {
          name: 'released-web-staging',
          vars: { PUBLIC_BASE_URL: PUBLIC_ORIGIN },
        },
      },
    };
    expect(cacheOriginProblems(aliased)).toEqual([
      expect.stringContaining('keys on the PRODUCTION origin'),
    ]);
  });

  it('rejects an env whose PUBLIC_BASE_URL is a non-routable single-label host', () => {
    const bound: WranglerCfg = {
      ...cfg,
      env: {
        ...cfg.env,
        staging: { name: 'released-web-staging', vars: { PUBLIC_BASE_URL: 'https://web' } },
      },
    };
    expect(cacheOriginProblems(bound)).toEqual([expect.stringContaining('is not routable')]);
  });
});

// Belt to that suspenders: a value that IS set but is not routable must not be
// used either. `https://web` parses fine and yields a plausible-looking origin,
// so without this it would sail through and reinstate #143 while looking configured.
describe('/internal/* refuses a configured cache origin that is not routable', () => {
  it('ignores a single-label PROD_HOST rather than keying on a host it cannot cache', async () => {
    const k = await publicKey('github.com/honojs/hono', `sha:${SHA}`);
    seed('https://released.example', k, fixture('v4.5.0'));

    const res = await app.fetch(
      svc(`https://released.example/internal/result/honojs/hono/${SHA}`),
      { INTERNAL_SECRET, PROD_HOST: 'web' },
    );

    // Fell through to the request origin, where the warm entry actually is.
    expect(res.status).toBe(200);
    expect(await tagOf(res)).toBe('v4.5.0');
    expect(findReleaseMock).not.toHaveBeenCalled();
  });

  it('still accepts localhost, which `wrangler dev` really serves on', async () => {
    const k = await publicKey('github.com/honojs/hono', `sha:${SHA}`);
    seed('http://localhost:8787', k, fixture('v4.4.0'));

    const res = await app.fetch(svc(`https://web/internal/result/honojs/hono/${SHA}`), {
      INTERNAL_SECRET,
      PUBLIC_BASE_URL: 'http://localhost:8787',
    });

    expect(res.status).toBe(200);
    expect(await tagOf(res)).toBe('v4.4.0');
    expect(findReleaseMock).not.toHaveBeenCalled();
  });

  it('accepts a single-label host WITH a port, which Docker/Codespaces dev serves on', async () => {
    // `URL.hostname` never carries the port (that is `URL.port`), so a check for a
    // colon in the hostname matches only a bracketed IPv6 literal — it never sees
    // `app:8787`. Rejecting this origin is not harmless over-strictness: a rejected
    // PUBLIC_BASE_URL is indistinguishable from an unset one, so the ?? chain lands
    // on PROD_HOST and /internal keys on the production origin while the public
    // routes key on the dev one. That is #143's split, reached with the var set.
    const k = await publicKey('github.com/honojs/hono', `sha:${SHA}`);
    seed('http://app:8787', k, fixture('v4.2.0'));
    // Only reachable if the origin was rejected and the chain fell to PROD_HOST.
    findReleaseMock.mockResolvedValue(fixture('v9.9.9'));

    const res = await app.fetch(svc(`https://web/internal/result/honojs/hono/${SHA}`), {
      INTERNAL_SECRET,
      PROD_HOST,
      PUBLIC_BASE_URL: 'http://app:8787',
    });

    expect(res.status).toBe(200);
    expect(await tagOf(res)).toBe('v4.2.0');
    expect(findReleaseMock).not.toHaveBeenCalled();
    expect(cacheStore.has(keyUrl(PUBLIC_ORIGIN, k))).toBe(false);
  });

  it('documents the unguardable case: unset vars key on the Service Binding origin', async () => {
    // Nothing at runtime can recover the public origin here, so this pins what
    // actually happens rather than implying it is safe: the entry is written under
    // `https://web`, which the real Cache API drops. The wrangler.toml suite above
    // is what keeps this shape from ever shipping.
    const sha = '7'.repeat(40);
    const k = await publicKey('github.com/honojs/hono', `sha:${sha}`);
    findReleaseMock.mockResolvedValue(fixture('v4.3.0'));

    const res = await app.fetch(svc(`https://web/internal/result/honojs/hono/${sha}`), {
      INTERNAL_SECRET,
    });

    expect(res.status).toBe(200);
    expect(cacheStore.has(keyUrl(PUBLIC_ORIGIN, k))).toBe(false);
    expect(cacheStore.has(keyUrl('https://web', k))).toBe(true);
  });
});

// web-og renders `firstRelease?.tag ?? 'not yet released'` and long-caches any
// non-null result for 24h, and nothing here can invalidate a PNG already made. A
// `partial` is a truncated traversal, so neither of its shapes may be pinned: with
// `firstRelease: null` a RELEASED commit becomes a definite "not yet released", and
// WITH one the tag is the gallop hit the bisect never confirmed is the earliest.
// Both fall through to a 503, which web-og renders as the neutral placeholder at
// max-age=60 — it claims nothing and self-heals. The refusal is then throttled by
// the partial the lookup just recorded, so a repo that reliably blows the soft
// deadline costs one traversal per 60s per key, not one per unfurl.
describe('/internal/* refuses to pin a partial, and throttles the refusal', () => {
  // Round 7 (#144). This used to assert the opposite — that a cached `partial`
  // was stale-served to web-og while a refresh ran behind it. That is the bug:
  // web-og renders `firstRelease?.tag ?? 'not yet released'` and long-caches any
  // non-null result, so a truncated traversal of a RELEASED commit got pinned as
  // "not yet released" for 24h. `badge.ts` writes those onto this very key (8s
  // soft deadline), which only this PR's key alignment made visible here.
  it('does NOT hand back a cached PARTIAL — it blocks and recomputes', async () => {
    const sha = 'c'.repeat(40);
    const k = await publicKey('github.com/honojs/hono', `sha:${sha}`);
    seedAged(PUBLIC_ORIGIN, k, partialFixture(), 5 * 60);
    findReleaseMock.mockResolvedValue(fixture('v4.12.0'));

    const res = await app.fetch(svc(`https://web/internal/result/honojs/hono/${sha}`), ENV);

    expect(res.status).toBe(200);
    expect(await tagOf(res)).toBe('v4.12.0'); // the real answer, not the partial
    expect(findReleaseMock).toHaveBeenCalledTimes(1);
    expect(await tagOfSlot(PUBLIC_ORIGIN, k)).toBe('v4.12.0'); // and the slot is corrected
  });

  it('still blocks (and write-backs) when the slot is genuinely cold', async () => {
    const sha = 'd'.repeat(40);
    findReleaseMock.mockResolvedValue(fixture('v4.15.0'));

    const res = await app.fetch(svc(`https://web/internal/result/honojs/hono/${sha}`), ENV);

    expect(res.status).toBe(200);
    expect(await tagOf(res)).toBe('v4.15.0');
  });

  // Round 7 (#144), the other half of the same guardrail. Refusing to SERVE a
  // cached partial is only half the job: on a repo that reliably blows the soft
  // deadline the forced recompute returns a partial too, and returning that as a
  // 200 pins the same wrong "not yet released" card for 24h that the refusal
  // exists to prevent (web-og: `firstRelease?.tag ?? 'not yet released'`,
  // long-cached for any non-null result). A 503 instead renders the neutral
  // placeholder at max-age=60, which self-heals on the next unfurl.
  it('503s rather than pin a COMPUTED partial as "not yet released"', async () => {
    const sha = '1'.repeat(40);
    findReleaseMock.mockResolvedValue(partialFixture());

    const res = await app.fetch(svc(`https://web/internal/result/honojs/hono/${sha}`), ENV);

    expect(res.status).toBe(503);
    expect(findReleaseMock).toHaveBeenCalledTimes(1);
  });

  // Round 8 (#144). Earlier rounds bounded this on `partial && !firstRelease`,
  // reasoning that a truncated traversal which DID find a containing release
  // carries a tag web-og renders correctly. find-release.ts says otherwise: the
  // tag in that shape is the GALLOP hit, and the bisect that would confirm no
  // EARLIER release contains the commit is exactly what the deadline cut short
  // ("the gallop-found tag is almost always the right answer; bisect just
  // verifies could there be an earlier one", find-release.ts:288-292). "Almost
  // always" is a caveat the result card renders and an OG card cannot: web-og
  // pins the bare tag for 24h. Answering "which release FIRST contains this
  // commit" with a possibly-later release is the failure this product exists to
  // avoid, so for a consumer that pins, no partial is servable — the neutral
  // placeholder claims nothing, and the permalink it links to shows the
  // best-effort answer WITH its caveat.
  it('503s rather than pin a partial whose tag the bisect never confirmed', async () => {
    const sha = '2'.repeat(40);
    findReleaseMock.mockResolvedValue({
      ...(fixture('v4.19.0') as Record<string, unknown>),
      partial: { reason: 'soft_deadline', candidatesTried: 3 },
    });

    const res = await app.fetch(svc(`https://web/internal/result/honojs/hono/${sha}`), ENV);

    expect(res.status).toBe(503);
  });

  // ...and the same shape read back from the SHARED slot. `hardTtlFor()` and
  // `isFresh()` both test `firstRelease` before `partial`, so a gallop-only
  // answer is stored for 30 days and reported fresh forever. Joining the public
  // key is what first exposed the OG path to an entry that old (its own cache was
  // a flat 30 minutes), so the pin bound has to reject it on the way OUT.
  // The underlying terminal-classification bug is on `main` and affects the
  // public routes too — tracked separately, not widened into this PR.
  it('does not serve a 20-day-old partial the cache classified as terminal', async () => {
    const sha = '5'.repeat(40);
    const k = await publicKey('github.com/honojs/hono', `sha:${sha}`);
    seedAged(
      PUBLIC_ORIGIN,
      k,
      { ...(fixture('v4.9.0') as Record<string, unknown>), partial: { reason: 'soft_deadline' } },
      20 * 24 * 60 * 60,
    );
    findReleaseMock.mockResolvedValue(fixture('v4.8.0')); // the real earliest

    const res = await app.fetch(svc(`https://web/internal/result/honojs/hono/${sha}`), ENV);

    expect(res.status).toBe(200);
    expect(await tagOf(res)).toBe('v4.8.0');
    expect(findReleaseMock).toHaveBeenCalledTimes(1);
  });

  // Refusing to serve a partial must not turn into refusing to CACHE the refusal.
  // resolveLookup writes the computed partial to the slot at HARD_TTL_PARTIAL, but
  // every read path rejects it — the fresh exit and the back-off exit alike — so `run()`
  // falls through to `load()` again. On a repo that reliably blows the 24s soft
  // deadline that is a full traversal per unfurl on the shared token, forever,
  // where the flat 30-minute TTL this route replaced made zero upstream calls.
  it('does not re-run the lookup for every unfurl of a deadline-blowing repo', async () => {
    const sha = '3'.repeat(40);
    findReleaseMock.mockResolvedValue(partialFixture());

    const first = await app.fetch(svc(`https://web/internal/result/honojs/hono/${sha}`), ENV);
    const second = await app.fetch(svc(`https://web/internal/result/honojs/hono/${sha}`), ENV);

    expect(first.status).toBe(503);
    expect(second.status).toBe(503);
    expect(findReleaseMock).toHaveBeenCalledTimes(1);
  });

  // The complement, and what stops the throttle above from becoming a permanent
  // placeholder: the recorded partial is only honoured inside its own 60-second
  // TTL, the same window the shared policy already trusts a partial for.
  it('recomputes once the recorded partial ages out of its 60-second window', async () => {
    const sha = '4'.repeat(40);
    const k = await publicKey('github.com/honojs/hono', `sha:${sha}`);
    seedAged(PUBLIC_ORIGIN, k, partialFixture(), 61);
    findReleaseMock.mockResolvedValue(fixture('v4.20.0'));

    const res = await app.fetch(svc(`https://web/internal/result/honojs/hono/${sha}`), ENV);

    expect(res.status).toBe(200);
    expect(await tagOf(res)).toBe('v4.20.0');
    expect(findReleaseMock).toHaveBeenCalledTimes(1);
  });

  // ...and the throttle must never outrank a REAL answer. A public page view has
  // no soft-deadline pressure from web-og and can land a terminal result in the
  // shared slot inside that 60-second window; the next unfurl must serve it.
  it('serves a real answer that landed in the slot inside the partial window', async () => {
    const sha = '6'.repeat(40);
    const k = await publicKey('github.com/honojs/hono', `sha:${sha}`);
    seedAged(PUBLIC_ORIGIN, k, fixture('v4.21.0'), 30);

    const res = await app.fetch(svc(`https://web/internal/result/honojs/hono/${sha}`), ENV);

    expect(res.status).toBe(200);
    expect(await tagOf(res)).toBe('v4.21.0');
    expect(findReleaseMock).not.toHaveBeenCalled();
  });
});

// PROD_HOST is shared with isProdRequest() (analytics.ts), which documents itself
// as tolerant of a value written WITH a scheme ("copied from PUBLIC_BASE_URL").
// `https://` + that value parses without throwing — to origin `https://https` —
// so an un-normalised read here would key every /internal entry on a non-routable
// host the Cache API drops: #143 again, silent, with neverFatal swallowing it.
describe('/internal/* normalises a configured cache origin', () => {
  it('keys on the real origin when PROD_HOST is written WITH a scheme', async () => {
    const sha = 'e'.repeat(40);
    const k = await publicKey('github.com/honojs/hono', `sha:${sha}`);
    seed(PUBLIC_ORIGIN, k, fixture('v4.16.0'));
    // Distinguishable from the seeded slot: if the key lands on `https://https`
    // the seeded entry is invisible and this recomputed answer is what comes back.
    findReleaseMock.mockResolvedValue(fixture('MISSED-THE-PUBLIC-SLOT'));

    const res = await app.fetch(svc(`https://web/internal/result/honojs/hono/${sha}`), {
      INTERNAL_SECRET,
      PROD_HOST: `https://${PROD_HOST}`,
    });

    expect(res.status).toBe(200);
    expect(await tagOf(res)).toBe('v4.16.0'); // the PUBLIC slot was hit
    expect(findReleaseMock).not.toHaveBeenCalled();
  });

  it('keys on the real origin when PUBLIC_BASE_URL is written WITHOUT one', async () => {
    const sha = 'f'.repeat(40);
    findReleaseMock.mockResolvedValue(fixture('v4.17.0'));

    const res = await app.fetch(svc(`https://web/internal/result/honojs/hono/${sha}`), {
      INTERNAL_SECRET,
      PUBLIC_BASE_URL: PROD_HOST,
    });

    // Pre-fix this threw out of `new Request(...)` — outside neverFatal — so the
    // computed answer became a 503, which web-og renders as the placeholder.
    expect(res.status).toBe(200);
    expect(await tagOf(res)).toBe('v4.17.0');
    const k = await publicKey('github.com/honojs/hono', `sha:${sha}`);
    expect(await tagOfSlot(PUBLIC_ORIGIN, k)).toBe('v4.17.0');
  });

  it('ignores a configured value whose origin is OPAQUE, rather than 500ing', async () => {
    const sha = '9'.repeat(40);
    const k = await publicKey('github.com/honojs/hono', `sha:${sha}`);
    seed(PUBLIC_ORIGIN, k, fixture('v4.18.0'));
    // Distinguishable from the seeded slot, as above.
    findReleaseMock.mockResolvedValue(fixture('MISSED-THE-PUBLIC-SLOT'));

    // `URL.origin` is the literal string "null" for any opaque (non-special
    // scheme) origin. `file:///srv/web` contains '//', so it skips the
    // scheme-prefix branch, parses fine, and yields "null" — a non-null,
    // non-URL string. Unguarded that satisfies `??` and reaches
    // `new Request(...)`, which throws OUTSIDE neverFatal: app.onError turns a
    // computable OG lookup into a 500 and web-og renders the neutral
    // placeholder. Same failure class as the scheme-less PUBLIC_BASE_URL above.
    const res = await app.fetch(svc(`https://web/internal/result/honojs/hono/${sha}`), {
      INTERNAL_SECRET,
      PUBLIC_BASE_URL: 'file:///srv/web',
      PROD_HOST,
    });

    expect(res.status).toBe(200);
    expect(await tagOf(res)).toBe('v4.18.0'); // fell through to PROD_HOST's public slot
    expect(findReleaseMock).not.toHaveBeenCalled();
  });
});

// Aligning the /internal key with the public one (the fix above) also aligned the
// NEGATIVE back-off marker `<key>:neg`, which public page views write. That marker
// is a good idea for a page a human can reload, and a bad one for a crawler: a
// crawler unfurls ONCE and keeps what it got. So a 60-second marker left by an
// unrelated human page view could hand the crawler a permanent placeholder — the
// exact #143 symptom this PR exists to remove, re-introduced through the shared key.
// The back-off is therefore honoured only when there is a prior to stale-serve.
describe('/internal/* does not let a shared back-off marker cause a permanent placeholder', () => {
  it('computes on a COLD slot even when a public page view left a warm `:neg` marker', async () => {
    const k = await publicKey('github.com/honojs/hono', `sha:${SHA}`);
    // A human loaded the permalink seconds ago, GitHub 502'd, the public route
    // wrote the shared back-off marker. No result was ever cached.
    seedAged(PUBLIC_ORIGIN, `${k}:neg`, { transient: true, kind: 'github_server_error' }, 10);
    // Upstream has since recovered.
    findReleaseMock.mockResolvedValue(fixture('v4.12.11'));

    const res = await app.fetch(svc(`https://web/internal/result/honojs/hono/${SHA}`), ENV);
    await settle();

    expect(res.status).toBe(200);
    expect(await tagOf(res)).toBe('v4.12.11');
    expect(findReleaseMock).toHaveBeenCalledTimes(1);
    // ...and the answer is warm for the next unfurl.
    expect(await tagOfSlot(PUBLIC_ORIGIN, k)).toBe('v4.12.11');
  });

  // Round 9 (#144). This used to claim the opposite — "the marker still holds when
  // there IS a prior" — on a seeded `firstRelease: null, no partial` entry, a shape
  // findRelease never emits (see pendingFixture). On the two shapes it DOES emit the
  // bypass is unconditional, and that is worth pinning honestly rather than papering
  // over: a TERMINAL prior returns at the fresh exit before the marker is ever read,
  // and a PARTIAL prior past its 60s is unpinnable, so the marker is skipped and the
  // lookup runs. The cost (an outage is re-probed by every unfurl) is accepted in
  // resolveLookup's fall-through comment; the alternative for a consumer that asks
  // once is a placeholder pinned long after the host recovers.
  it('skips a warm marker even WITH a stale partial prior — the bypass is not cold-only', async () => {
    const k = await publicKey('github.com/honojs/hono', `sha:${SHA}`);
    seedAged(PUBLIC_ORIGIN, k, partialFixture(), 10 * 60); // past its 60s: unpinnable
    seedAged(PUBLIC_ORIGIN, `${k}:neg`, { transient: true, kind: 'github_server_error' }, 10);
    findReleaseMock.mockResolvedValue(fixture('v4.12.11'));

    const res = await app.fetch(svc(`https://web/internal/result/honojs/hono/${SHA}`), ENV);
    await settle();

    expect(res.status).toBe(200);
    expect(await tagOf(res)).toBe('v4.12.11');
    expect(findReleaseMock).toHaveBeenCalledTimes(1);
  });

  // ...and the complement, so the guard above cannot pass by simply never reading
  // the marker: a TERMINAL prior is served from the fresh exit, upstream untouched.
  it('a terminal prior is still served from cache while the marker is warm', async () => {
    const sha = '8'.repeat(40);
    const k = await publicKey('github.com/honojs/hono', `sha:${sha}`);
    seedAged(PUBLIC_ORIGIN, k, fixture('v4.11.0'), 10 * 60);
    seedAged(PUBLIC_ORIGIN, `${k}:neg`, { transient: true, kind: 'github_server_error' }, 10);

    const res = await app.fetch(svc(`https://web/internal/result/honojs/hono/${sha}`), ENV);

    expect(res.status).toBe(200);
    expect(await tagOf(res)).toBe('v4.11.0');
    expect(findReleaseMock).not.toHaveBeenCalled();
  });
});

// Aligning the cache key also aligned the in-isolate SINGLE-FLIGHT key, which is a
// sharing this route did not have on main (it keyed on a three-part key of its
// own). `singleFlight` hands every joiner the FIRST registrant's promise and runs
// only that owner's loader, and badge.ts builds a byte-identical key for
// `issue#N`/`pr#N` (badge.ts:110) with a deliberately tighter 8s/9s deadline. So a
// badge request landing ~1s earlier in the same isolate would hand this route a
// truncated `partial`, which it 503s into a pinned neutral placeholder — #143's
// symptom, on a link where this route's own 24s deadline finds the real answer.
describe('/internal/* runs its own lookup instead of joining the badge flight', () => {
  it('does not inherit an 8-second-deadline partial registered by badge.ts', async () => {
    // The key badge.ts registers its flight under for `/badge/.../issue/11.svg`.
    const k = await publicKey('github.com/honojs/hono', 'issue#11');
    let finishBadge: (value: unknown) => void = () => {};
    const badgeFlight = singleFlight(k, () => new Promise((r) => (finishBadge = r)));

    findReleaseMock.mockResolvedValue(fixture('v4.13.0'));
    const pending = app.fetch(svc('https://web/internal/issue/honojs/hono/11'), ENV);
    await settle();
    // Badge's tighter deadline ran out: a truncated traversal, all it can offer.
    finishBadge(partialFixture());
    await badgeFlight;

    const res = await pending;
    expect(res.status).toBe(200);
    expect(await tagOf(res)).toBe('v4.13.0');
    expect(findReleaseMock).toHaveBeenCalledOnce();
  });
});
