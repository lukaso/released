// web-og Worker: renders OG PNGs for permalink URLs.
//
// GET /r/:owner/:repo/c/:sha.png             — GitHub (legacy/canonical)
// GET /h/:host/r/:projectPath/c/:sha.png     — federated (any host, #8)
//   → Fetch the result data from `web` via Service Binding (D23).
//   → Render PNG via @cloudflare/workers-og (Satori + resvg-wasm).
//   → Cache 24h. On data miss, render a neutral placeholder with short TTL
//     (never a long-cached error).

import { type LookupResult, OG_TEMPLATE_VERSION } from '@released/core';
import { Hono } from 'hono';
import { ImageResponse } from 'workers-og';

type Env = {
  WEB: Fetcher;
  INTERNAL_SECRET?: string;
};

const app = new Hono<{ Bindings: Env }>();

/** Fetch the result JSON from the `web` Worker via Service Binding. Returns null
 *  on any miss/error so the caller renders a short-cached placeholder. */
async function fetchResult(env: Env, internalUrl: string): Promise<LookupResult | null> {
  try {
    const res = await env.WEB.fetch(internalUrl, {
      headers: { 'x-released-internal': env.INTERNAL_SECRET ?? 'web-og' },
    });
    if (res.ok) return (await res.json()) as LookupResult;
  } catch {
    // Fall through to placeholder.
  }
  return null;
}

// GitHub permalinks (legacy/canonical).
app.get('/r/:owner/:repo/c/:shaPng', async (c) => {
  const { owner, repo, shaPng } = c.req.param();
  if (!shaPng.endsWith('.png')) return c.text('not found', 404);
  const sha = shaPng.slice(0, -4);

  const internalUrl = `https://web/internal/result/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(sha)}`;
  const result = await fetchResult(c.env, internalUrl);
  return renderImage(result, { owner, repo, sha });
});

// Federated permalinks (any non-GitHub provider, #8). projectPath is URL-encoded
// into a single segment, matching the /h/ scheme in web/src/index.ts.
app.get('/h/:host/r/:projectPath/c/:shaPng', async (c) => {
  const { host, projectPath, shaPng } = c.req.param();
  if (!shaPng.endsWith('.png')) return c.text('not found', 404);
  const sha = shaPng.slice(0, -4);

  // projectPath is already percent-decoded by Hono's router (via a safe
  // try/catch), so re-encoding here yields one clean segment regardless of how
  // the caller encoded it. Do NOT decodeURIComponent again — that's a redundant
  // double-decode that throws URIError on a malformed escape (foo%2 → 500).
  const internalUrl = `https://web/internal/h/${encodeURIComponent(host)}/r/${encodeURIComponent(projectPath)}/${encodeURIComponent(sha)}`;
  const result = await fetchResult(c.env, internalUrl);

  // Placeholder context: split the project path on the first slash so
  // PlaceholderCard's `owner/repo` label renders the full path.
  const slash = projectPath.indexOf('/');
  const owner = slash === -1 ? projectPath : projectPath.slice(0, slash);
  const repo = slash === -1 ? '' : projectPath.slice(slash + 1);
  return renderImage(result, { owner, repo, sha });
});

// GitHub issue/PR permalinks (#79): title-aware OG card. Fetches the result
// resolved AS an issue/PR (not the bare closing commit) so result.subject
// carries the issue/PR title and the card can render "Issue #N" / "PR #N".
app.get('/i/:owner/:repo/:numberPng', async (c) => {
  const { owner, repo, numberPng } = c.req.param();
  if (!numberPng.endsWith('.png')) return c.text('not found', 404);
  const number = numberPng.slice(0, -4);
  const internalUrl = `https://web/internal/issue/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(number)}`;
  const result = await fetchResult(c.env, internalUrl);
  return renderImage(result, { owner, repo, number });
});

app.get('/p/:owner/:repo/:numberPng', async (c) => {
  const { owner, repo, numberPng } = c.req.param();
  if (!numberPng.endsWith('.png')) return c.text('not found', 404);
  const number = numberPng.slice(0, -4);
  const internalUrl = `https://web/internal/pr/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(number)}`;
  const result = await fetchResult(c.env, internalUrl);
  return renderImage(result, { owner, repo, number });
});

// Federated issue/PR permalinks (#79). projectPath URL-encoded into one segment,
// matching the /h/ scheme in web/src/index.ts.
app.get('/h/:host/i/:projectPath/:numberPng', async (c) => {
  const { host, projectPath, numberPng } = c.req.param();
  if (!numberPng.endsWith('.png')) return c.text('not found', 404);
  const number = numberPng.slice(0, -4);
  const internalUrl = `https://web/internal/h/${encodeURIComponent(host)}/i/${encodeURIComponent(projectPath)}/${encodeURIComponent(number)}`;
  const result = await fetchResult(c.env, internalUrl);
  const slash = projectPath.indexOf('/');
  const owner = slash === -1 ? projectPath : projectPath.slice(0, slash);
  const repo = slash === -1 ? '' : projectPath.slice(slash + 1);
  return renderImage(result, { owner, repo, number });
});

app.get('/h/:host/p/:projectPath/:numberPng', async (c) => {
  const { host, projectPath, numberPng } = c.req.param();
  if (!numberPng.endsWith('.png')) return c.text('not found', 404);
  const number = numberPng.slice(0, -4);
  const internalUrl = `https://web/internal/h/${encodeURIComponent(host)}/p/${encodeURIComponent(projectPath)}/${encodeURIComponent(number)}`;
  const result = await fetchResult(c.env, internalUrl);
  const slash = projectPath.indexOf('/');
  const owner = slash === -1 ? projectPath : projectPath.slice(0, slash);
  const repo = slash === -1 ? '' : projectPath.slice(slash + 1);
  return renderImage(result, { owner, repo, number });
});

app.get('/placeholder.png', () => renderImage(null, { owner: '', repo: '' }));

app.get('/healthz', (c) => c.text('ok'));

// An unmatched .png request (a stale crawler URL, or a permalink OG URL hit
// during the brief web→web-og deploy window before web-og has the matching
// route) renders a short-cached placeholder PNG instead of a 404 text body — a
// social unfurl fetcher gets a valid image, not an error. Non-.png paths still
// 404. (Deploy-order safety: web deploys before web-og in CI, so og:image URLs
// can briefly point at routes web-og hasn't shipped yet.)
app.notFound((c) => {
  if (c.req.path.endsWith('.png')) return renderImage(null, { owner: '', repo: '' });
  return c.text('not found', 404);
});

export default app;

// --- rendering ---------------------------------------------------------------

function renderImage(
  result: LookupResult | null,
  ctx: { owner: string; repo: string; sha?: string; number?: string },
): Response {
  const SIZE = { width: 1200, height: 630 };
  const longCache = `public, max-age=${24 * 60 * 60}, s-maxage=${24 * 60 * 60}`;
  const shortCache = 'public, max-age=60';
  const cacheControl = result ? longCache : shortCache;

  const node = result ? ResultCard(result) : PlaceholderCard(ctx);

  return new ImageResponse(node, {
    ...SIZE,
    headers: {
      'cache-control': cacheControl,
      'x-og-template': OG_TEMPLATE_VERSION,
    },
  });
}

function ResultCard(r: LookupResult) {
  const tag = r.firstRelease?.tag ?? 'not yet released';
  const date = r.firstRelease ? r.firstRelease.date.slice(0, 10) : '';
  const repo = r.input.repo.projectPath;
  const sha = r.canonicalSha.slice(0, 7);

  // #79: issue/PR results get a title-aware headline ("Issue #N" / "PR #N" +
  // the title from result.subject). findReleaseForIssue / the pr path set
  // subject to the issue/PR title; commit results leave it as the commit
  // subject, which the commit card does NOT surface (unchanged behavior).
  // web-og has no provider terms, so the noun/sigil branches on host: a
  // GitLab MR unfurls as "Merge request !N" (matching its permalink page, which
  // pulls the wording from provider.terms), not GitHub's "PR #N". Issues use "#"
  // on every host, so they need no branch.
  const input = r.input;
  const kindLabel =
    input.kind === 'issue'
      ? `Issue #${input.number}`
      : input.kind === 'pr'
        ? input.repo.host === 'github.com'
          ? `PR #${input.number}`
          : `Merge request !${input.number}`
        : null;
  const title = kindLabel !== null ? (r.subject ?? null) : null;
  // Shrink the release tag when a headline is present so both fit the card.
  const tagFontSize = kindLabel !== null ? 96 : 140;

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: '#0a0a0a',
        color: '#ededed',
        display: 'flex',
        flexDirection: 'column',
        padding: '64px 80px',
        fontFamily: 'Geist, sans-serif',
        position: 'relative',
      }}
    >
      {/* top: wordmark + meta */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 28, fontWeight: 600 }}
        >
          <div style={{ width: 14, height: 14, borderRadius: 7, background: '#52a8ff' }} />
          <span>released</span>
        </div>
        <div style={{ fontFamily: 'Geist Mono, monospace', color: '#a1a1a1', fontSize: 24 }}>
          {repo}
        </div>
      </div>

      {/* issue/PR headline (#79) — kind label + title, above the release tag */}
      {kindLabel !== null && (
        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 36 }}>
          <div style={{ color: '#52a8ff', fontSize: 26, fontWeight: 600, letterSpacing: 1 }}>
            {kindLabel}
          </div>
          {title !== null && (
            <div style={{ fontSize: 40, fontWeight: 600, marginTop: 12, lineHeight: 1.2 }}>
              {/* Cap at ~2 lines (80 chars): GitHub allows 256-char titles, which
                  would wrap 4+ lines, collapse the spacer, and clip the card's
                  bottom meta + tag under satori's fixed 630px canvas. Truncate on
                  a code-point boundary (Array.from) so an emoji straddling index
                  79 isn't split into a lone surrogate (renders as □). */}
              {title.length > 80 ? `${Array.from(title).slice(0, 79).join('')}…` : title}
            </div>
          )}
        </div>
      )}

      {/* spacer */}
      <div style={{ flex: 1 }} />

      {/* hero */}
      <div
        style={{
          color: '#a1a1a1',
          fontSize: 22,
          textTransform: 'uppercase',
          letterSpacing: 2,
          marginBottom: 18,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <div style={{ width: 10, height: 10, borderRadius: 5, background: '#3fb950' }} />
        <span>First released in</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 24 }}>
        <div
          style={{
            fontFamily: 'Geist Mono, monospace',
            fontWeight: 700,
            fontSize: tagFontSize,
            lineHeight: 1,
          }}
        >
          {tag}
        </div>
        {r.firstRelease && (
          <div
            style={{
              fontFamily: 'Geist Mono, monospace',
              fontSize: 20,
              color: '#3fb950',
              background: '#1a3a22',
              padding: '8px 16px',
              borderRadius: 8,
              fontWeight: 600,
              letterSpacing: 1,
            }}
          >
            SHIPPED
          </div>
        )}
      </div>
      {date && (
        <div style={{ fontSize: 30, color: '#ededed', marginTop: 16, fontWeight: 500 }}>{date}</div>
      )}

      {/* spacer */}
      <div style={{ flex: 1 }} />

      {/* bottom meta */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        {/* One text node, not `commit {sha}` (two children): satori throws on a
            multi-child element with no `display: flex`, yielding a 0-byte PNG. */}
        <div style={{ fontFamily: 'Geist Mono, monospace', color: '#6e6e6e', fontSize: 22 }}>
          {`commit ${sha}`}
        </div>
        <div style={{ fontFamily: 'Geist Mono, monospace', color: '#6e6e6e', fontSize: 18 }}>
          released.blabberate.com
        </div>
      </div>
    </div>
  );
}

function PlaceholderCard(ctx: { owner: string; repo: string; sha?: string; number?: string }) {
  // Commit lookups identify by sha (`@ abc1234`); issue/PR by number (`#11`).
  const ident =
    ctx.number !== undefined ? ` #${ctx.number}` : ctx.sha ? ` @ ${ctx.sha.slice(0, 7)}` : '';
  const label = ctx.owner && ctx.repo ? `${ctx.owner}/${ctx.repo}${ident}` : 'released';
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: '#0a0a0a',
        color: '#ededed',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        padding: '64px',
        fontFamily: 'Geist, sans-serif',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          fontSize: 40,
          fontWeight: 600,
          marginBottom: 40,
        }}
      >
        <div style={{ width: 18, height: 18, borderRadius: 9, background: '#52a8ff' }} />
        <span>released</span>
      </div>
      <div style={{ fontSize: 28, color: '#a1a1a1', marginBottom: 12 }}>Looking up…</div>
      <div style={{ fontFamily: 'Geist Mono, monospace', fontSize: 24, color: '#6e6e6e' }}>
        {label}
      </div>
    </div>
  );
}
