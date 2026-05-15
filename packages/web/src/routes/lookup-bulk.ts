// POST /api/lookup-bulk — bulk lookup (CP3, cap MAX_BULK=10).
// Shared deadline across all sub-lookups; returns partial response shape.

import type { Context } from 'hono';
import {
  findReleasesBulk,
  MAX_BULK,
  makeGithubClient,
  parseInput,
  ReleasedError,
  type LookupInput,
} from '@released/core';
import { checkSameOrigin, resolveToken } from '../auth.js';
import type { Env } from '../env.js';

export async function lookupBulkRoute(c: Context): Promise<Response> {
  const env = c.env as Env;
  const req = c.req.raw;
  if (!checkSameOrigin(req)) {
    return new Response(JSON.stringify({ error: 'cross_origin' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }

  let body: { inputs?: string[] };
  try {
    body = (await req.json()) as { inputs?: string[] };
  } catch {
    return jsonErr('invalid_body', 400);
  }
  if (!Array.isArray(body.inputs)) return jsonErr('missing_inputs', 400);
  if (body.inputs.length > MAX_BULK) {
    return new Response(
      JSON.stringify({ error: 'bulk_limit', message: `max ${MAX_BULK}`, max: MAX_BULK }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }

  // Parse all inputs up front; bad ones become errors in the response.
  const parsed: ({ ok: true; v: LookupInput } | { ok: false; err: ReleasedError })[] = body.inputs.map(
    (s) => {
      try {
        return { ok: true as const, v: parseInput(s) };
      } catch (err) {
        return { ok: false as const, err: err as ReleasedError };
      }
    },
  );
  const okInputs = parsed.filter((p) => p.ok).map((p) => (p as { ok: true; v: LookupInput }).v);

  const client = makeGithubClient({ token: resolveToken(env, req) });
  const bulk = await findReleasesBulk(okInputs, { client });

  // Re-thread parse failures back into the result array by index.
  let okIdx = 0;
  const results = parsed.map((p) => {
    if (!p.ok) return { kind: 'error', errorName: p.err.name, message: p.err.message };
    return bulk.results[okIdx++];
  });

  const respBody = bulk.partial
    ? { results, partial: bulk.partial }
    : { results };
  return new Response(JSON.stringify(respBody), {
    headers: { 'content-type': 'application/json' },
  });
}

function jsonErr(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
