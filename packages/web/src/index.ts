// Hono app entry — Cloudflare Worker.
//
// Routes:
//   GET  /                                       → homepage with embedded EXAMPLE
//   GET  /lookup?q=...                           → 302 to the canonical permalink
//   GET  /r/:owner/:repo/c/:sha                  → permalink result page (GitHub)
//   GET  /p/:owner/:repo/:number                 → PR permalink (GitHub)
//   GET  /h/:host/r/:projectPath/c/:sha          → permalink result page (federated, any host)
//   GET  /h/:host/p/:projectPath/:number         → PR/MR permalink (federated)
//   GET  /<permalink>/badge.svg                  → auto-updating SVG status badge
//   POST /api/lookup                             → JSON single lookup (client-side fetch)
//   POST /api/lookup-bulk                        → JSON bulk lookup
//   GET  /internal/result/:owner/:repo/:sha      → Service Binding only; for web-og (GitHub)
//   GET  /internal/h/:host/r/:projectPath/:sha   → Service Binding only; for web-og (federated)
//   GET  /healthz                                → liveness probe
//   GET  /version                                → deployed version metadata (JSON)

import { parseInput } from '@released/core';
import { Hono } from 'hono';
import { eventForPath, refererHost, setTrack, takeTrack, track } from './analytics.js';
import { isLivenessProbe, isUnfurlBot } from './auth.js';
import { type Env, publicBaseUrl } from './env.js';
import { recognizeOwnUrl } from './own-url.js';
import { commitPermalinkPath, prPermalinkPath } from './paths.js';
import { badgeRoute } from './routes/badge.js';
import { eventRoute } from './routes/event.js';
import { homeRoute } from './routes/home.js';
import { howItWorksRoute } from './routes/how-it-works.js';
import { internalFederatedResultRoute, internalResultRoute } from './routes/internal.js';
import { lookupBulkRoute } from './routes/lookup-bulk.js';
import { lookupRoute } from './routes/lookup.js';
import { prRoute } from './routes/pr.js';
import { resultRoute } from './routes/result.js';
import { llmsTxtRoute, robotsRoute, sitemapRoute } from './routes/seo.js';

const app = new Hono<{ Bindings: Env }>();

// Usage tracking: one Analytics Engine data point per request. Routes enrich
// the event (host/repo/cache/outcome) via setTrack(); we merge that here, add
// request-derived fields, and write once. Analytics must never break a response,
// so the whole write is best-effort. Skips the liveness probe, the internal
// service-binding calls (web-og → web), and the /api/event beacon (which writes
// its OWN precise data point — logging it here too would double-count it).
app.use('*', async (c, next) => {
  const start = Date.now();
  try {
    await next();
  } finally {
    try {
      const path = c.req.path;
      if (
        path !== '/healthz' &&
        path !== '/version' &&
        path !== '/api/event' &&
        !path.startsWith('/internal/')
      ) {
        const req = c.req.raw;
        const enrich = takeTrack(req);
        const cf = (req as Request & { cf?: { country?: string } }).cf;
        track(c.env as Env | undefined, {
          event: eventForPath(path),
          host: enrich.host,
          repo: enrich.repo,
          outcome: enrich.outcome,
          cache: enrich.cache,
          kind: enrich.kind,
          errorType: enrich.errorType,
          upstreamStatus: enrich.upstreamStatus,
          audience: isUnfurlBot(req) ? 'bot' : 'human',
          probe: isLivenessProbe(req),
          country: typeof cf?.country === 'string' ? cf.country : undefined,
          referer: refererHost(req.headers.get('referer')),
          status: c.res.status,
          latencyMs: Date.now() - start,
        });
      }
    } catch {
      // Never let analytics failures surface to the client.
    }
  }
});

app.get('/', homeRoute);

// Form-submit endpoint (works without JS): redirect to canonical permalink.
app.get('/lookup', (c) => {
  const q = c.req.query('q');
  if (!q) return c.redirect('/', 302);
  // If the user pasted one of OUR permalink/badge URLs (or a fragment like
  // `gitlab.gnome.org/p/GNOME%2Fgtk/9951`), route straight back to its permalink
  // instead of handing `released.*` to parseInput, which would reject our own
  // host as "unsupported".
  const req = c.req.raw;
  const own = recognizeOwnUrl(q, [
    new URL(publicBaseUrl(c.env as Env, req)).host,
    new URL(req.url).host,
  ]);
  if (own) return c.redirect(own, 302);
  try {
    const p = parseInput(q);
    // Enrich the existing `redirect` event so a UI search is a measurable funnel:
    // which hosts/repos people search for (valid) vs how often parsing fails
    // (outcome=invalid, below). No extra request — the form already round-trips us.
    setTrack(req, { host: p.repo.host, repo: p.repo.projectPath, kind: p.kind });
    if (p.kind === 'pr') {
      return c.redirect(prPermalinkPath(p.repo, p.number), 302);
    }
    // Use the FULL SHA in the permalink (not a 7-char prefix) — short prefixes
    // collide in large repos like kubernetes/kubernetes, which makes getCommit
    // return 422 ambiguous. The UI displays the short form for cosmetics; the
    // URL is canonical and unambiguous.
    return c.redirect(commitPermalinkPath(p.repo, p.sha), 302);
  } catch (err) {
    // Bounce back to the form with the bad query AND the error reason preserved
    // so the homepage can surface a tailored message.
    const reason = (err as { kind?: string })?.kind ?? 'invalid';
    setTrack(req, { outcome: 'invalid', errorType: reason });
    return c.redirect(`/?bad=${encodeURIComponent(q)}&reason=${encodeURIComponent(reason)}`, 302);
  }
});

// GitHub permalinks (legacy/canonical — preserved for cached unfurls + bookmarks).
app.get('/r/:owner/:repo/c/:sha', resultRoute);
app.get('/p/:owner/:repo/:number', prRoute);

// Federated permalinks (any non-GitHub provider). projectPath URL-encoded.
app.get('/h/:host/r/:projectPath/c/:sha', resultRoute);
app.get('/h/:host/p/:projectPath/:number', prRoute);

// Auto-updating status badges (one extra `/badge.svg` segment per permalink).
app.get('/r/:owner/:repo/c/:sha/badge.svg', badgeRoute);
app.get('/p/:owner/:repo/:number/badge.svg', badgeRoute);
app.get('/h/:host/r/:projectPath/c/:sha/badge.svg', badgeRoute);
app.get('/h/:host/p/:projectPath/:number/badge.svg', badgeRoute);

app.post('/api/lookup', lookupRoute);
app.post('/api/lookup-bulk', lookupBulkRoute);

// Client-side interaction beacon (clipboard copies). Same-origin gated; writes
// its own Analytics Engine point and is skipped by the request logger above.
app.post('/api/event', eventRoute);

app.get('/internal/result/:owner/:repo/:sha', internalResultRoute);
app.get('/internal/h/:host/r/:projectPath/:sha', internalFederatedResultRoute);

// /how-it-works is a real, indexable content page (was a 301 to the README).
// It's an SEO usage-loop entry point: targets "which release contains a commit"
// and pre-answers "why not git describe?". See routes/how-it-works.tsx.
app.get('/how-it-works', howItWorksRoute);

// Crawl surface for the usage loop.
app.get('/robots.txt', robotsRoute);
app.get('/sitemap.xml', sitemapRoute);
// Agent/LLM discoverability (llmstxt.org convention).
app.get('/llms.txt', llmsTxtRoute);

app.get('/healthz', (c) => c.text('ok'));

// Deployed-version probe. Surfaces Cloudflare's version_metadata binding so the
// maintaining loop (and humans) can confirm which version is live — id changes
// on every deploy, timestamp says when. Read-only, no secrets. Degrades to nulls
// when the binding is absent (wrangler dev / tests). no-store so a fresh deploy
// is visible immediately.
app.get('/version', (c) => {
  const v = (c.env as Env)?.CF_VERSION_METADATA;
  return c.json({ id: v?.id ?? null, tag: v?.tag ?? null, timestamp: v?.timestamp ?? null }, 200, {
    'cache-control': 'no-store',
  });
});

app.notFound((c) => c.text('Not found — paste a commit at https://released.blabberate.com\n', 404));

export default app;

// Durable Object class backing the Anubis relay container. Must be exported
// from the Worker entry so wrangler's [[containers]] / migration can bind it.
export { GitlabRelay } from './relay.js';
