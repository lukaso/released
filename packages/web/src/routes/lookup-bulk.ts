// POST /api/lookup-bulk — bulk lookup (CP3, cap MAX_BULK=10).
// Shared deadline across all sub-lookups; returns partial response shape.
//
// Mixed-provider inputs (GitHub + GitLab + ...) are supported: we group inputs
// by host, run findReleasesBulk separately per host (each with its own provider
// instance), then re-thread results into the original input order. This avoids
// the trap of trying to use ONE client for ALL hosts.

import {
  type BulkResult,
  type LookupInput,
  type LookupResult,
  MAX_BULK,
  type Provider,
  type ReleasedError,
  findReleasesBulk,
  parseInput,
} from '@released/core';
import type { Context } from 'hono';
import { checkSameOrigin } from '../auth.js';
import type { Env } from '../env.js';
import { makeProvider } from '../provider.js';

type BulkSubError = { kind: 'error'; errorName: string; message: string };
type BulkPartial = NonNullable<BulkResult['partial']>;

// Severity ordering for merging partials across host groups (issue #10).
const PARTIAL_SEVERITY: Record<BulkPartial['reason'], number> = {
  rate_limit_exhausted: 3,
  bulk_deadline: 2,
  network_error: 1,
};

/** Merge the per-host-group partials into one. A multi-host bulk runs an
 *  independent `findReleasesBulk` per host, so a partial can come from any
 *  group; the response must still report exactly ONE partial. Surface the most
 *  severe reason (rate_limit_exhausted > bulk_deadline > network_error), sum
 *  pendingCount across groups, and carry `resetAt` from the group that won. */
export function aggregateBulkPartials(partials: readonly BulkPartial[]): BulkPartial | undefined {
  if (partials.length === 0) return undefined;
  const worst = partials.reduce((a, b) =>
    PARTIAL_SEVERITY[b.reason] > PARTIAL_SEVERITY[a.reason] ? b : a,
  );
  const pendingCount = partials.reduce((n, p) => n + p.pendingCount, 0);
  return {
    reason: worst.reason,
    pendingCount,
    ...(worst.resetAt !== undefined ? { resetAt: worst.resetAt } : {}),
  };
}

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

  // Parse all inputs up front; parse failures become errors at their original index.
  const parsed: ({ ok: true; v: LookupInput } | { ok: false; err: ReleasedError })[] =
    body.inputs.map((s) => {
      try {
        return { ok: true as const, v: parseInput(s) };
      } catch (err) {
        return { ok: false as const, err: err as ReleasedError };
      }
    });

  // Group successful inputs by host so each host's sub-bulk uses the right provider.
  const byHost = new Map<string, { input: LookupInput; originalIdx: number }[]>();
  parsed.forEach((p, idx) => {
    if (!p.ok) return;
    const host = p.v.repo.host;
    let group = byHost.get(host);
    if (!group) {
      group = [];
      byHost.set(host, group);
    }
    group.push({ input: p.v, originalIdx: idx });
  });

  const okResultsByIdx = new Map<number, LookupResult | BulkSubError>();

  // Run each host's bulk in parallel — different hosts have independent rate limits
  // and there's no cross-host shared state. Each group may return its own
  // `partial` (rate-limit / deadline); collect them all and merge below so a
  // partial from one host isn't silently dropped (issue #10).
  const groupPartials = await Promise.all(
    [...byHost.entries()].map(async ([host, group]): Promise<BulkPartial | undefined> => {
      let client: Provider;
      try {
        client = makeProvider(env, req, host);
      } catch (err) {
        // Host not supported — every input in this group fails the same way.
        const errAsReleased = err as ReleasedError;
        for (const g of group) {
          okResultsByIdx.set(g.originalIdx, {
            kind: 'error',
            errorName: errAsReleased.name,
            message: errAsReleased.message,
          });
        }
        return undefined;
      }
      const subBulk = await findReleasesBulk(
        group.map((g) => g.input),
        { client },
      );
      // subBulk.results is 1:1 with group (built from group.map above), so the
      // index always resolves; the guard is just to satisfy the type checker.
      subBulk.results.forEach((r, i) => {
        const g = group[i];
        if (g) okResultsByIdx.set(g.originalIdx, r);
      });
      return subBulk.partial;
    }),
  );

  const partial = aggregateBulkPartials(
    groupPartials.filter((p): p is BulkPartial => p !== undefined),
  );

  // Re-thread results into the original input order, mixing parse failures.
  const results = parsed.map((p, idx) => {
    if (!p.ok) return { kind: 'error', errorName: p.err.name, message: p.err.message };
    // Every ok input was grouped and processed above, so a result always
    // exists; fall back to an explicit error rather than emitting `undefined`.
    return (
      okResultsByIdx.get(idx) ?? {
        kind: 'error',
        errorName: 'InternalError',
        message: 'no result produced for this input',
      }
    );
  });

  return new Response(JSON.stringify({ results, ...(partial ? { partial } : {}) }), {
    headers: { 'content-type': 'application/json' },
  });
}

function jsonErr(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
