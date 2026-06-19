// POST /api/event — client-side interaction beacon.
//
// Records ONE Analytics Engine data point for a user action that has no server
// round-trip of its own — today that's clipboard copies (badge / Slack / link).
// Copying a badge is the seeding action behind the badge → README → click-through
// loop, so it's the signal we most want and the one server-side request logging
// can't see.
//
// Privacy stays identical to the rest of analytics.ts: only an action type plus
// the already-public host/repo. No IP, no user agent, no query string. Same-origin
// gated as defense-in-depth, and it NEVER errors the caller — analytics must not
// break UX, and `navigator.sendBeacon` ignores the response anyway.
//
// Excluded from the per-request middleware logger in index.ts (see the skip-list
// there) so the beacon POST itself isn't double-counted as an 'other'/'api' event.
//
// IMPORTANT: only the web UI calls this. The CLI (packages/cli) and core
// (packages/core) talk directly to GitHub/GitLab and never to this Worker — they
// emit no telemetry whatsoever. Keep it that way: do not add a beacon to the CLI.

import type { Context } from 'hono';
import { track } from '../analytics.js';
import { checkSameOrigin, isUnfurlBot } from '../auth.js';
import type { Env } from '../env.js';

const COPY_FORMATS = new Set(['badge', 'slack', 'link']);

/** Trim and length-cap a client-supplied label so a hostile payload can't bloat a
 *  data point. host/repo are public identifiers, but never trust raw client input. */
function label(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, 200) : undefined;
}

export async function eventRoute(c: Context): Promise<Response> {
  const req = c.req.raw;

  // Same-origin only — keeps the dataset from being spammed cross-site. A real
  // browser beacon from our own pages always carries a matching Origin.
  if (!checkSameOrigin(req)) {
    return new Response(JSON.stringify({ error: 'cross_origin' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }

  let body: { type?: unknown; format?: unknown; host?: unknown; repo?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return noContent(); // unparseable beacon — drop quietly
  }

  if (body?.type === 'copy') {
    const format =
      typeof body.format === 'string' && COPY_FORMATS.has(body.format)
        ? (body.format as 'badge' | 'slack' | 'link')
        : undefined;
    if (format) {
      const cf = (req as Request & { cf?: { country?: string } }).cf;
      track(c.env as Env | undefined, {
        event: 'copy',
        format,
        host: label(body.host),
        repo: label(body.repo),
        // Bots don't run JS to click "copy", but stay consistent with the rest of
        // the schema so audience filtering works uniformly.
        audience: isUnfurlBot(req) ? 'bot' : 'human',
        country: typeof cf?.country === 'string' ? cf.country : undefined,
        status: 204,
      });
    }
  }
  // Unknown types (and copies with an unrecognized format) are accepted and
  // ignored — forward-compatible with future client versions, and a no-op here.
  return noContent();
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}
