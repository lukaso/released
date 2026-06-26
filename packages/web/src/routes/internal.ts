// Service-Binding-only endpoints (D23) that feed the web-og PNG renderer.
//   GET /internal/result/:owner/:repo/:sha     — GitHub (legacy/canonical)
//   GET /internal/h/:host/r/:projectPath/:sha  — federated (any host, #12)
// web-og calls these via a Cloudflare Service Binding (env.WEB.fetch(...)) to get
// the result JSON for rendering the OG PNG. Direct public hits are rejected.

import { type LookupInput, type LookupResult, cacheKey, findRelease } from '@released/core';
import type { Context } from 'hono';
import { makeWorkerCache } from '../cache.js';
import type { Env } from '../env.js';
import { makeProvider } from '../provider.js';
import { singleFlight } from '../single-flight.js';

/** Marker header set by the web-og Service Binding to identify itself.
 *  Cloudflare Service Binding requests can also be checked via the routing
 *  metadata; we use a shared-secret-style marker as an extra guard for v1. */
const SVC_HEADER = 'x-released-internal';

/** True when the caller presented the Service-Binding marker secret. */
function isServiceBinding(c: Context): boolean {
  const env = (c.env ?? {}) as Env & { INTERNAL_SECRET?: string };
  const marker = c.req.raw.headers.get(SVC_HEADER);
  return !!marker && marker === (env.INTERNAL_SECRET ?? 'web-og');
}

/** Resolve the LookupResult JSON for a host/projectPath/sha. Cache-first, then
 *  compute via the (relay-aware) provider. Host-aware cache key so OG renders
 *  share slots with the public routes' `${host}/${projectPath}` prefix. */
async function resolveResult(
  c: Context,
  host: string,
  projectPath: string,
  sha: string,
): Promise<Response> {
  const env = c.env as Env;
  const req = c.req.raw;

  const k = await cacheKey('res', `${host}/${projectPath}`, `sha:${sha}`);
  const cache = makeWorkerCache(req);
  let result: LookupResult | null = await cache.get<LookupResult>(k);
  if (result) {
    return new Response(JSON.stringify(result), {
      headers: { 'content-type': 'application/json' },
    });
  }

  // Cache miss: compute. The web-og caller chose to wait for this on its side.
  // Build the input directly (host-aware), exactly as the public /h/ route does.
  try {
    const parsed: LookupInput = {
      kind: 'commit',
      repo: { host, projectPath },
      sha: sha.toLowerCase(),
    };
    // Anubis-protected hosts get a relay-backed fetch (see makeProvider/relay.ts).
    const client = makeProvider(env, req, host);
    result = await singleFlight(k, async () => {
      const re = await cache.get<LookupResult>(k);
      if (re) return re;
      const r = await findRelease(parsed, { client });
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

/** GET /internal/result/:owner/:repo/:sha — GitHub-only (legacy/canonical). */
export async function internalResultRoute(c: Context): Promise<Response> {
  if (!isServiceBinding(c)) return new Response('not found', { status: 404 });

  const owner = c.req.param('owner');
  const repo = c.req.param('repo');
  const sha = c.req.param('sha');
  if (!owner || !repo || !sha) return new Response('not found', { status: 404 });

  return resolveResult(c, 'github.com', `${owner}/${repo}`, sha);
}

/** GET /internal/h/:host/r/:projectPath/:sha — federated (any host, #12).
 *  projectPath is URL-encoded into a single segment, matching the /h/ permalink
 *  routes; decode it before building the lookup. */
export async function internalFederatedResultRoute(c: Context): Promise<Response> {
  if (!isServiceBinding(c)) return new Response('not found', { status: 404 });

  const host = c.req.param('host');
  const projectPathEnc = c.req.param('projectPath');
  const sha = c.req.param('sha');
  if (!host || !projectPathEnc || !sha) return new Response('not found', { status: 404 });

  return resolveResult(c, host, decodeURIComponent(projectPathEnc), sha);
}
