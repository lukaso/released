// Service-Binding-only endpoints (D23) that feed the web-og PNG renderer.
//   GET /internal/result/:owner/:repo/:sha     — GitHub (legacy/canonical)
//   GET /internal/h/:host/r/:projectPath/:sha  — federated (any host, #12)
// web-og calls these via a Cloudflare Service Binding (env.WEB.fetch(...)) to get
// the result JSON for rendering the OG PNG. Direct public hits are rejected.

import { cacheKey, findRelease, type LookupInput, type LookupResult } from '@released/core';
import type { Context } from 'hono';
import { makeWorkerCache, type WorkerCache } from '../cache.js';
import type { Env } from '../env.js';
import { makeProvider } from '../provider.js';
import { singleFlight } from '../single-flight.js';

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
 *  Resolve the canonical public origin instead: an explicit PUBLIC_BASE_URL, else
 *  the committed PROD_HOST var, else the request's own origin (`wrangler dev`
 *  and tests, where neither var is set). */
function cacheOrigin(env: Env, req: Request): string {
  if (env.PUBLIC_BASE_URL) return env.PUBLIC_BASE_URL.replace(/\/$/, '');
  if (env.PROD_HOST) return `https://${env.PROD_HOST}`;
  return new URL(req.url).origin;
}

/** cache.get that is never fatal. The key URL is deliberately not this request's
 *  origin (see cacheOrigin), so a Cache API refusal must degrade to a recompute
 *  rather than a 500 that web-og would render as a placeholder. */
async function cachedResult(cache: WorkerCache, k: string): Promise<LookupResult | null> {
  try {
    return await cache.get<LookupResult>(k);
  } catch {
    return null;
  }
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
  const cache = makeWorkerCache(new Request(cacheOrigin(env, req)));
  let result: LookupResult | null = await cachedResult(cache, k);
  if (result) {
    return new Response(JSON.stringify(result), {
      headers: { 'content-type': 'application/json' },
    });
  }

  // Cache miss: compute. The web-og caller chose to wait for this on its side.
  // Anubis-protected hosts get a relay-backed fetch (see makeProvider/relay.ts).
  try {
    const client = makeProvider(env, req, host);
    result = await singleFlight(k, async () => {
      const re = await cache.get<LookupResult>(k);
      if (re) return re;
      // Options stated explicitly: they are what the `cull`/`nopre` key parts
      // above promise, so the slot this writes is the one a default public
      // permalink hit reads back.
      const r = await findRelease(input, { client, strict: false, includePrereleases: false });
      await cache.put(k, r, 30 * 60);
      return r;
    });
    return new Response(JSON.stringify(result), {
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error)?.message ?? 'failed' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }
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
