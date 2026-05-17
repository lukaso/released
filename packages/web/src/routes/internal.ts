// GET /internal/result/:owner/:repo/:sha — Service-Binding-only endpoint (D23).
// web-og calls this via a Cloudflare Service Binding (env.WEB.fetch(...)) to get
// the result JSON for rendering the OG PNG. Direct public hits are rejected.
//
// Currently GitHub-only — the web-og worker only renders OG images for GitHub
// permalinks today. Federated OG rendering is a captured TODO; when that lands,
// add a parallel /internal/h/:host/r/:projectPath/:sha route.

import {
  type LookupResult,
  cacheKey,
  findRelease,
  parseInput,
  providerFor,
} from '@released/core';
import type { Context } from 'hono';
import { extraGitlabHostsFromEnv, resolveProviderToken } from '../auth.js';
import { makeWorkerCache } from '../cache.js';
import type { Env } from '../env.js';
import { singleFlight } from '../single-flight.js';

/** Marker header set by the web-og Service Binding to identify itself.
 *  Cloudflare Service Binding requests can also be checked via the routing
 *  metadata; we use a shared-secret-style marker as an extra guard for v1. */
const SVC_HEADER = 'x-released-internal';

export async function internalResultRoute(c: Context): Promise<Response> {
  const env = c.env as Env & { INTERNAL_SECRET?: string };
  const req = c.req.raw;

  // Reject direct public hits. Service-Binding callers set this header.
  const marker = req.headers.get(SVC_HEADER);
  if (!marker || marker !== (env.INTERNAL_SECRET ?? 'web-og')) {
    return new Response('not found', { status: 404 });
  }

  const owner = c.req.param('owner');
  const repo = c.req.param('repo');
  const sha = c.req.param('sha');
  if (!owner || !repo || !sha) return new Response('not found', { status: 404 });

  // This route is GitHub-only. Host-aware cache key so we share cache slots
  // with the public /r/ and /api/lookup routes (which all use the same
  // ${host}/${projectPath} prefix).
  const host = 'github.com';
  const projectPath = `${owner}/${repo}`;
  const k = await cacheKey('res', `${host}/${projectPath}`, `sha:${sha}`);
  const cache = makeWorkerCache(req);
  let result: LookupResult | null = await cache.get<LookupResult>(k);
  if (result) {
    return new Response(JSON.stringify(result), {
      headers: { 'content-type': 'application/json' },
    });
  }

  // Cache miss: compute. The web-og caller chose to wait for this on its side.
  try {
    const parsed = parseInput(`${owner}/${repo}`, sha);
    const token = resolveProviderToken(env, req, host);
    const client = providerFor(host, { token, extraGitlabHosts: extraGitlabHostsFromEnv(env) });
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
