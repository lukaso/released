// Service-Binding-only endpoints (D23) that feed the web-og PNG renderer.
//   GET /internal/result/:owner/:repo/:sha     — GitHub (legacy/canonical)
//   GET /internal/h/:host/r/:projectPath/:sha  — federated (any host, #12)
// web-og calls these via a Cloudflare Service Binding (env.WEB.fetch(...)) to get
// the result JSON for rendering the OG PNG. Direct public hits are rejected.

import { cacheKey, findRelease, type LookupInput } from '@released/core';
import type { Context } from 'hono';
import type { CacheEntry, WorkerCache } from '../cache.js';
import { makeWorkerCache } from '../cache.js';
import type { Env } from '../env.js';
import { makeProvider } from '../provider.js';
import { type Resolved, resolveLookup } from '../resolve.js';

/** Marker header set by the web-og Service Binding to identify itself.
 *  Cloudflare Service Binding requests can also be checked via the routing
 *  metadata; we use a shared-secret-style marker as an extra guard for v1. */
const SVC_HEADER = 'x-released-internal';

/** True when the caller presented the Service-Binding marker secret.
 *  Fails CLOSED when INTERNAL_SECRET is unset: a missing secret must DENY,
 *  never fall back to a guessable default (the legacy 'web-og' constant), or
 *  /internal/* would open to anyone who guesses it. Prod and `wrangler dev`
 *  (via .dev.vars) always set it; set with `wrangler secret put INTERNAL_SECRET`,
 *  matching web-og's. */
function isServiceBinding(c: Context): boolean {
  const env = (c.env ?? {}) as Env;
  const secret = env.INTERNAL_SECRET;
  if (!secret) return false;
  const marker = c.req.raw.headers.get(SVC_HEADER);
  return !!marker && marker === secret;
}

/** Origin for the result-cache key URL.
 *
 *  web-og hardcodes `https://web/internal/...` as the Service-Binding target, so
 *  keying the cache on the incoming request broke OG renders two ways (#143):
 *  `web` is not a routable hostname, which the Cache API silently declines to
 *  store (see cache.ts's header note), and it is a different namespace from the
 *  public permalink routes'. The OG path could therefore neither reuse a warm
 *  public entry nor persist its own, so every cold unfurl paid a full lookup,
 *  blew web-og's deadline, and got the placeholder cached by the crawler.
 *
 *  Resolve the origin this deployment's own public routes key on: an explicit
 *  PUBLIC_BASE_URL, else the committed PROD_HOST var, else the request's origin.
 *
 *  PUBLIC_BASE_URL is what makes that per-environment. PROD_HOST is committed in
 *  BOTH [vars] and [env.preview.vars] (it gates analytics, which must stay
 *  prod-only), so without an explicit override the preview Worker — and
 *  `wrangler dev`, which loads [vars] — would key on the production origin while
 *  their public routes key on the origin they actually serve. wrangler.toml sets
 *  PUBLIC_BASE_URL for preview; for `wrangler dev`, put
 *  `PUBLIC_BASE_URL=http://localhost:8787` in packages/web/.dev.vars. Only the
 *  unit tests reach the request-origin fallback. */
function cacheOrigin(env: Env, req: Request): string {
  if (env.PUBLIC_BASE_URL) return env.PUBLIC_BASE_URL.replace(/\/$/, '');
  if (env.PROD_HOST) return `https://${env.PROD_HOST}`;
  return new URL(req.url).origin;
}

/** Wrap a cache so no Cache API call can be fatal. The key URL is deliberately
 *  not this request's own origin (see cacheOrigin) and the Cache API is entitled
 *  to refuse such a read or write; that must degrade to "served, just not
 *  cached". A 503 here is what web-og renders as the neutral placeholder — the
 *  #143 symptom — so a cache fault must never throw away a computed answer. */
function neverFatal(cache: WorkerCache): WorkerCache {
  return {
    async get<T>(key: string): Promise<T | null> {
      try {
        return await cache.get<T>(key);
      } catch {
        return null;
      }
    },
    async getEntry<T>(key: string): Promise<CacheEntry<T> | null> {
      try {
        return await cache.getEntry<T>(key);
      } catch {
        return null;
      }
    },
    async put<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
      try {
        await cache.put(key, value, ttlSeconds);
      } catch {
        // Served, just not cached.
      }
    },
  };
}

/** Message for the 503 web-og reads as "no result" (it renders the neutral card
 *  for any non-OK response, so only the body text differs by cause). */
function failureMessage(resolved: Exclude<Resolved, { status: 'ok' }>): string {
  if (resolved.status === 'not_yet') return resolved.error.message;
  if (resolved.status === 'transient') return resolved.kind;
  return (resolved.error as Error)?.message ?? 'failed';
}

/** Resolve the LookupResult JSON for a lookup input. Cache-first, then compute
 *  via the (relay-aware) provider.
 *
 *  The cache key MUST match the public permalink routes' exactly (result.tsx,
 *  issue.tsx, pr.tsx) or the OG card renders into a namespace no public hit can
 *  ever warm — that was half of #143. That means all five parts, including the
 *  `cull`/`nopre` suffixes for the default (non-strict, no-prerelease) options an
 *  OG card always renders, and the public `issue#`/`pr#` id spelling rather than
 *  the `issue:`/`pr:` this endpoint used to invent. */
async function resolveResult(c: Context, input: LookupInput): Promise<Response> {
  const env = c.env as Env;
  const req = c.req.raw;
  const { host, projectPath } = input.repo;

  const idPart = input.kind === 'commit' ? `sha:${input.sha}` : `${input.kind}#${input.number}`;
  const k = await cacheKey('res', `${host}/${projectPath}`, idPart, 'cull', 'nopre');
  const cache = neverFatal(makeWorkerCache(new Request(cacheOrigin(env, req))));

  // Same resolver the public routes use, on the same slot — sharing a cache slot
  // means sharing the policy that governs it: per-state hard TTLs (30 days
  // terminal / 24h pending / 60s partial), a 5-minute freshness window, and the
  // negative back-off that keeps a down host from being pounded. A flat TTL here
  // would downgrade a terminal slot the permalink would have kept for 30 days,
  // and a bare read would keep serving a 60-second partial for far longer than
  // the public page does. Options are stated explicitly because they are what the
  // `cull`/`nopre` key parts promise. Anubis-protected hosts get a relay-backed
  // fetch (see makeProvider/relay.ts). The web-og caller chose to wait for this.
  const resolved = await resolveLookup({
    cache,
    key: k,
    load: () =>
      findRelease(input, {
        client: makeProvider(env, req, host),
        strict: false,
        includePrereleases: false,
      }),
  });
  if (resolved.status === 'ok') {
    return new Response(JSON.stringify(resolved.result), {
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ error: failureMessage(resolved) }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  });
}

/** Parse a permalink :number param into a positive int, or null if invalid. */
function parseNumber(raw: string | undefined): number | null {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** GET /internal/result/:owner/:repo/:sha — GitHub-only (legacy/canonical). */
export async function internalResultRoute(c: Context): Promise<Response> {
  if (!isServiceBinding(c)) return new Response('not found', { status: 404 });

  const owner = c.req.param('owner');
  const repo = c.req.param('repo');
  const sha = c.req.param('sha');
  if (!owner || !repo || !sha) return new Response('not found', { status: 404 });

  return resolveResult(c, {
    kind: 'commit',
    repo: { host: 'github.com', projectPath: `${owner}/${repo}` },
    sha: sha.toLowerCase(),
  });
}

/** GET /internal/h/:host/r/:projectPath/:sha — federated (any host, #12).
 *  projectPath is URL-encoded into a single segment, matching the /h/ permalink
 *  routes. Hono already percent-decodes c.req.param() (safe try/catch), so do
 *  NOT decodeURIComponent again — that's a redundant double-decode that throws
 *  URIError on a malformed escape (bad%25 → bad% → throws) → HTTP 500. */
export async function internalFederatedResultRoute(c: Context): Promise<Response> {
  if (!isServiceBinding(c)) return new Response('not found', { status: 404 });

  const host = c.req.param('host');
  const projectPath = c.req.param('projectPath');
  const sha = c.req.param('sha');
  if (!host || !projectPath || !sha) return new Response('not found', { status: 404 });

  return resolveResult(c, {
    kind: 'commit',
    repo: { host, projectPath },
    sha: sha.toLowerCase(),
  });
}

/** GET /internal/issue/:owner/:repo/:number — GitHub issue (#79). Resolves the
 *  issue (→ its closing commit(s) → release) so the returned result carries
 *  subject = the issue title, which web-og renders on the title-aware OG card. */
export async function internalIssueRoute(c: Context): Promise<Response> {
  if (!isServiceBinding(c)) return new Response('not found', { status: 404 });

  const owner = c.req.param('owner');
  const repo = c.req.param('repo');
  const number = parseNumber(c.req.param('number'));
  if (!owner || !repo || number === null) return new Response('not found', { status: 404 });

  return resolveResult(c, {
    kind: 'issue',
    repo: { host: 'github.com', projectPath: `${owner}/${repo}` },
    number,
  });
}

/** GET /internal/pr/:owner/:repo/:number — GitHub PR (#79). Resolves the PR to
 *  its merge commit so subject = the PR title. */
export async function internalPrRoute(c: Context): Promise<Response> {
  if (!isServiceBinding(c)) return new Response('not found', { status: 404 });

  const owner = c.req.param('owner');
  const repo = c.req.param('repo');
  const number = parseNumber(c.req.param('number'));
  if (!owner || !repo || number === null) return new Response('not found', { status: 404 });

  return resolveResult(c, {
    kind: 'pr',
    repo: { host: 'github.com', projectPath: `${owner}/${repo}` },
    number,
  });
}

/** GET /internal/h/:host/i/:projectPath/:number — federated issue (#79). */
export async function internalFederatedIssueRoute(c: Context): Promise<Response> {
  if (!isServiceBinding(c)) return new Response('not found', { status: 404 });

  const host = c.req.param('host');
  const projectPath = c.req.param('projectPath');
  const number = parseNumber(c.req.param('number'));
  if (!host || !projectPath || number === null) return new Response('not found', { status: 404 });

  return resolveResult(c, {
    kind: 'issue',
    repo: { host, projectPath },
    number,
  });
}

/** GET /internal/h/:host/p/:projectPath/:number — federated PR/MR (#79). */
export async function internalFederatedPrRoute(c: Context): Promise<Response> {
  if (!isServiceBinding(c)) return new Response('not found', { status: 404 });

  const host = c.req.param('host');
  const projectPath = c.req.param('projectPath');
  const number = parseNumber(c.req.param('number'));
  if (!host || !projectPath || number === null) return new Response('not found', { status: 404 });

  return resolveResult(c, {
    kind: 'pr',
    repo: { host, projectPath },
    number,
  });
}
