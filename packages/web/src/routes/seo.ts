// SEO surface: robots.txt + sitemap.xml.
//
// These are the crawl entry points for the durable usage loop — they let search
// engines find the homepage and the /how-it-works content page (which targets
// the real query "which release contains a commit"). Absolute URLs are derived
// from the public base URL so they're correct in dev and prod alike.

import type { Context } from 'hono';
import { type Env, publicBaseUrl } from '../env.js';

const DAY = 'public, max-age=86400, s-maxage=86400';

export function robotsRoute(c: Context): Response {
  const base = publicBaseUrl(c.env as Env, c.req.raw);
  const body = `User-agent: *
Allow: /

Sitemap: ${base}/sitemap.xml
`;
  return new Response(body, {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': DAY },
  });
}

// Static, hand-maintained URL set. The product's value lives in dynamic permalink
// pages (one per commit/PR), but those are effectively infinite and discovered
// via shared links, not the sitemap — so we list only the stable, indexable
// marketing/content surfaces here.
const PATHS = ['/', '/how-it-works'];

export function sitemapRoute(c: Context): Response {
  const base = publicBaseUrl(c.env as Env, c.req.raw);
  const urls = PATHS.map((p) => `  <url><loc>${base}${p}</loc></url>`).join('\n');
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
  return new Response(body, {
    headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': DAY },
  });
}
