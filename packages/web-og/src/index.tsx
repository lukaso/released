// web-og Worker: renders OG PNGs for permalink URLs.
//
// GET /r/:owner/:repo/c/:sha.png
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

app.get('/r/:owner/:repo/c/:shaPng', async (c) => {
  const { owner, repo, shaPng } = c.req.param();
  if (!shaPng.endsWith('.png')) return c.text('not found', 404);
  const sha = shaPng.slice(0, -4);

  // Fetch the result data from the main web Worker via Service Binding.
  let result: LookupResult | null = null;
  try {
    const internalUrl = `https://web/internal/result/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(sha)}`;
    const res = await c.env.WEB.fetch(internalUrl, {
      headers: { 'x-released-internal': c.env.INTERNAL_SECRET ?? 'web-og' },
    });
    if (res.ok) {
      result = (await res.json()) as LookupResult;
    }
  } catch {
    // Fall through to placeholder.
  }

  return renderImage(result, { owner, repo, sha });
});

app.get('/placeholder.png', () => renderImage(null, { owner: '', repo: '', sha: '' }));

app.get('/healthz', (c) => c.text('ok'));

app.notFound((c) => c.text('not found', 404));

export default app;

// --- rendering ---------------------------------------------------------------

function renderImage(
  result: LookupResult | null,
  ctx: { owner: string; repo: string; sha: string },
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
            fontSize: 140,
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
        <div style={{ fontFamily: 'Geist Mono, monospace', color: '#6e6e6e', fontSize: 22 }}>
          commit {sha}
        </div>
        <div style={{ fontFamily: 'Geist Mono, monospace', color: '#6e6e6e', fontSize: 18 }}>
          released.blabberate.com
        </div>
      </div>
    </div>
  );
}

function PlaceholderCard(ctx: { owner: string; repo: string; sha: string }) {
  const label =
    ctx.owner && ctx.repo ? `${ctx.owner}/${ctx.repo} @ ${ctx.sha.slice(0, 7)}` : 'released';
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
