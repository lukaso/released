// Hono app entry — Cloudflare Worker.
//
// Routes:
//   GET  /                                  → homepage with embedded EXAMPLE
//   GET  /lookup?q=...                      → 302 to /r/:o/:r/c/:sha (form submit fallback)
//   GET  /r/:owner/:repo/c/:sha             → permalink result page
//   POST /api/lookup                        → JSON single lookup (client-side fetch)
//   POST /api/lookup-bulk                   → JSON bulk lookup
//   GET  /internal/result/:owner/:repo/:sha → Service Binding only; for web-og
//   GET  /healthz                           → liveness probe

import { Hono } from 'hono';
import { parseInput } from '@released/core';
import type { Env } from './env.js';
import { homeRoute } from './routes/home.js';
import { internalResultRoute } from './routes/internal.js';
import { lookupBulkRoute } from './routes/lookup-bulk.js';
import { lookupRoute } from './routes/lookup.js';
import { prRoute } from './routes/pr.js';
import { resultRoute } from './routes/result.js';

const app = new Hono<{ Bindings: Env }>();

app.get('/', homeRoute);

// Form-submit endpoint (works without JS): redirect to canonical permalink.
app.get('/lookup', (c) => {
  const q = c.req.query('q');
  if (!q) return c.redirect('/', 302);
  try {
    const p = parseInput(q);
    if (p.kind === 'pr') {
      return c.redirect(`/p/${p.repo.owner}/${p.repo.repo}/${p.number}`, 302);
    }
    // Use the FULL SHA in the permalink (not a 7-char prefix) — short prefixes
    // collide in large repos like kubernetes/kubernetes, which makes getCommit
    // return 422 ambiguous. The UI displays the short form for cosmetics; the
    // URL is canonical and unambiguous.
    return c.redirect(`/r/${p.repo.owner}/${p.repo.repo}/c/${p.sha}`, 302);
  } catch (err) {
    // Bounce back to the form with the bad query AND the error reason preserved
    // so the homepage can surface a tailored message.
    const reason = (err as { kind?: string })?.kind ?? 'invalid';
    return c.redirect(`/?bad=${encodeURIComponent(q)}&reason=${encodeURIComponent(reason)}`, 302);
  }
});

app.get('/r/:owner/:repo/c/:sha', resultRoute);
app.get('/p/:owner/:repo/:number', prRoute);

app.post('/api/lookup', lookupRoute);
app.post('/api/lookup-bulk', lookupBulkRoute);

app.get('/internal/result/:owner/:repo/:sha', internalResultRoute);

app.get('/healthz', (c) => c.text('ok'));

app.notFound((c) =>
  c.text('Not found — paste a commit at https://released.blabberate.com\n', 404),
);

export default app;
