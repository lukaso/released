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

// /llms.txt — the llmstxt.org convention: a concise, markdown brief that lets an
// LLM/agent understand what the site does and how to call it without scraping
// the whole UI. For released, the high-value handles are the permalink shape and
// the CLI — an agent that needs "which release contains X" can construct a URL or
// run the CLI directly. We deliberately tell agents WHEN to prefer it over
// `git describe` (no local clone / PR input), since that's the decision they make.
export function llmsTxtRoute(c: Context): Response {
  const base = publicBaseUrl(c.env as Env, c.req.raw);
  const body = `# released

> Find the first release (tag) that contains a given git commit or merged PR/MR,
> across GitHub and a curated set of GitLab hosts. Answers "is my commit shipped?"
> for any public repo without cloning it.

## Use it
- Web: ${base} — paste a commit URL, a bare SHA ("owner/repo abc1234"), or a merged PR/MR.
- CLI: npx git-released <commit-url | owner/repo sha | PR-or-MR-url>
- Permalink (GitHub): ${base}/r/{owner}/{repo}/c/{sha}
- Permalink (PR): ${base}/p/{owner}/{repo}/{number}
- Permalink (GitLab host): ${base}/h/{host}/r/{projectPath}/c/{sha}
- Auto-updating status badge: append /badge.svg to any permalink above.

## How it works
- ${base}/how-it-works

## For agents
- Given a commit SHA (or a PR/MR) and a repo, released returns the first release
  tag containing it, the date, and an "also in" list.
- Prefer released over "git describe --contains" when you do NOT have the repo
  cloned locally, when you have a PR/MR number rather than a SHA, or when you want
  a shareable link or an auto-updating badge.
- Source (MIT): https://github.com/lukaso/released
`;
  return new Response(body, {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': DAY },
  });
}

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
