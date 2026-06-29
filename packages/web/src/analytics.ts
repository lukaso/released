// Usage tracking via Cloudflare Workers Analytics Engine.
//
// One data point per request, written from the Hono middleware in index.ts.
// Routes enrich the in-flight event (host/repo/cache/outcome) via setTrack();
// the middleware merges that, adds request-derived fields, and writes once.
//
// Privacy: only public identifiers (repo/host) + coarse country are recorded —
// no IP, no full user agent, no query string. Keeps visitor data on the edge.
//
// Schema (query with the SQL API — see scripts/stats.mjs):
//   index1  host-qualified repo (e.g. github.com/facebook/react), or event name
//   blob1   event     home|redirect|result|pr|badge|api_lookup|api_bulk|other
//   blob2   host      github.com | gitlab.com | gitlab.acme.dev
//   blob3   repo      owner/repo or projectPath
//   blob4   outcome   released|not_yet|partial|error|invalid
//   blob5   cache     hit|miss
//   blob6   kind      commit|pr
//   blob7   audience  human|bot (unfurl)
//   blob8   errorType error class name, when outcome=error
//   blob9   country   request.cf.country
//   blob10  format    badge|slack|link — what was copied (copy events only)
//   blob11  referer   referring HOSTNAME only (e.g. news.ycombinator.com,
//                     gitlab.gnome.org, www.google.com), '' when absent. No
//                     path/query — keeps the privacy posture while making
//                     traffic attributable (organic vs self-seeded vs direct).
//   blob12  probe     '1' for the loop's synthetic liveness probe (matched by
//                     user-agent in index.ts), '' otherwise. Lets error queries
//                     exclude self-monitoring traffic so a probe's soft-deadline
//                     timeout isn't read back as a real SYSTEM error. The UA
//                     string itself is never stored — only this boolean.
//   double1 status         HTTP status the worker returned to the client
//   double2 latencyMs       end-to-end request time
//   double3 upstreamStatus  provider HTTP status when outcome=error (5xx/429/…),
//                           0 otherwise. The worker→client status (double1) hides
//                           this — a GNOME 503 surfaces to the user as a 404/503,
//                           so without this column you can't tell a rate-limit
//                           from a real outage from an anti-bot challenge.
//
// Use sum(_sample_interval) (not count()) in queries — Analytics Engine samples
// at high write rates and that column reconstructs true counts.

import type { AnalyticsEngineDataPoint, Env } from './env.js';

export type AnalyticsEvent = {
  event:
    | 'home'
    | 'redirect'
    | 'result'
    | 'pr'
    | 'badge'
    | 'api_lookup'
    | 'api_bulk'
    | 'copy'
    | 'other';
  host?: string;
  /** projectPath, e.g. facebook/react or GNOME/gimp. */
  repo?: string;
  outcome?: 'released' | 'not_yet' | 'partial' | 'error' | 'invalid';
  cache?: 'hit' | 'miss';
  kind?: 'commit' | 'pr';
  audience?: 'human' | 'bot';
  errorType?: string;
  country?: string;
  /** For copy events: which share format the visitor copied. Copying a badge is
   *  the seeding action behind the badge → README → click-through loop. */
  format?: 'badge' | 'slack' | 'link';
  /** Referring HOSTNAME only (no path/query). Lets us tell where usage comes
   *  from — a search engine / HN / Reddit (organic) vs a gitlab.gnome.org page
   *  (a link/badge someone placed) vs '' (direct, CLI, or proxy-stripped). */
  referer?: string;
  status: number;
  latencyMs?: number;
  /** Provider HTTP status that caused an error outcome (e.g. gitlab.gnome.org 503).
   *  Distinct from `status`, which is what the worker returned to the client. */
  upstreamStatus?: number;
  /** True for the loop's synthetic liveness probe (recognised by user-agent in
   *  the middleware). Recorded as blob12 so error queries can exclude
   *  self-monitoring traffic — its soft-deadline timeouts are not real failures. */
  probe?: boolean;
};

/** Pull the upstream provider's HTTP status out of a typed error so analytics can
 *  record WHY a host failed, not just that it did. ProviderServerError /
 *  GitHubServerError / ProviderJsonError all carry a numeric `.status`; a
 *  RateLimitError carries `resetAt` instead, so map it to 429. Everything else
 *  (network error, timeout, not-yet-released, parse errors) has no upstream
 *  status. Duck-typed on purpose — avoids `instanceof` fragility across bundles. */
export function upstreamStatusOf(err: unknown): number | undefined {
  const e = err as { status?: unknown; kind?: unknown } | null | undefined;
  if (e?.kind === 'rate_limit') return 429;
  return typeof e?.status === 'number' ? e.status : undefined;
}

const INDEX_MAX_BYTES = 96; // Analytics Engine hard limit on index length.

export function toDataPoint(e: AnalyticsEvent): AnalyticsEngineDataPoint {
  const index = e.repo ? `${e.host ?? 'unknown'}/${e.repo}` : e.event;
  return {
    indexes: [index.slice(0, INDEX_MAX_BYTES)],
    blobs: [
      e.event,
      e.host ?? '',
      e.repo ?? '',
      e.outcome ?? '',
      e.cache ?? '',
      e.kind ?? '',
      e.audience ?? '',
      e.errorType ?? '',
      e.country ?? '',
      e.format ?? '',
      e.referer ?? '',
      e.probe ? '1' : '',
    ],
    doubles: [e.status, e.latencyMs ?? 0, e.upstreamStatus ?? 0],
  };
}

/** Write one data point. No-op when the binding is absent (local dev, tests). */
export function track(env: Env | undefined, e: AnalyticsEvent): void {
  env?.ANALYTICS?.writeDataPoint(toDataPoint(e));
}

// Per-request enrichment set by route handlers and drained by the middleware.
// Keyed by the raw Request, which is a stable reference across the lifecycle.
const pending = new WeakMap<Request, Partial<AnalyticsEvent>>();

/** Merge route-known dimensions into the event for the current request. */
export function setTrack(req: Request, patch: Partial<AnalyticsEvent>): void {
  pending.set(req, { ...pending.get(req), ...patch });
}

/** Read and clear the enrichment recorded for this request. */
export function takeTrack(req: Request): Partial<AnalyticsEvent> {
  const v = pending.get(req);
  pending.delete(req);
  return v ?? {};
}

/** Reduce a `Referer` header to a privacy-safe hostname for attribution.
 *  Returns '' for missing/blank/unparseable values, and never includes the
 *  path or query — we only want to know WHICH site sent the visitor, not what
 *  they were reading there. */
export function refererHost(referer: string | null | undefined): string {
  if (!referer) return '';
  try {
    return new URL(referer).hostname;
  } catch {
    return '';
  }
}

/** Derive the event name from the request path (the routes are deterministic). */
export function eventForPath(path: string): AnalyticsEvent['event'] {
  if (path.endsWith('/badge.svg')) return 'badge';
  if (path === '/api/lookup') return 'api_lookup';
  if (path === '/api/lookup-bulk') return 'api_bulk';
  if (path === '/lookup') return 'redirect';
  if (path === '/') return 'home';
  if (/^\/p\//.test(path) || /^\/h\/[^/]+\/p\//.test(path)) return 'pr';
  if (/^\/r\//.test(path) || /^\/h\/[^/]+\/r\//.test(path)) return 'result';
  return 'other';
}
