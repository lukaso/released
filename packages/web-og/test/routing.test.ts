// Routing tests for web-og. We mock `workers-og`'s ImageResponse — the actual
// PNG rendering depends on WASM and the Workers runtime, which we verify with
// `wrangler dev` rather than in vitest.

import { describe, expect, it, vi } from 'vitest';

// The last satori node tree handed to ImageResponse. The real PNG render is
// WASM-bound and verified via `wrangler dev`, not here — but the node tree the
// card builds from a LookupResult is pure logic, so we capture and assert on it.
let lastRenderedNode: unknown;

vi.mock('workers-og', () => ({
  // Mock ImageResponse as a Response subclass — cleaner than `return new
  // Response(...)` from a constructor (which trips lint/correctness/
  // noConstructorReturn and relies on the JS oddity where a constructor's
  // returned object overrides `this`).
  ImageResponse: class extends Response {
    constructor(node: unknown, init?: { headers?: Record<string, string> }) {
      lastRenderedNode = node;
      super('PNG-BYTES', { headers: init?.headers ?? {} });
    }
  },
}));

const { default: app } = await import('../src/index.js');

// Walk a hono/jsx node tree ({ tag, props: { children }, ... }) and collect
// every string/number leaf. Lets us assert what TEXT a card renders without a
// real WASM render. Prefer props.children (the canonical path) over the
// mirrored top-level `children` so leaves aren't double-counted.
function collectText(node: unknown): string[] {
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (n == null || typeof n === 'boolean') return;
    if (typeof n === 'string') {
      if (n.length > 0) out.push(n);
      return;
    }
    if (typeof n === 'number') {
      out.push(String(n));
      return;
    }
    if (Array.isArray(n)) {
      for (const c of n) walk(c);
      return;
    }
    if (typeof n === 'object') {
      const o = n as { props?: { children?: unknown }; children?: unknown };
      if (o.props && 'children' in o.props) walk(o.props.children);
      else if ('children' in o) walk(o.children);
    }
  };
  walk(node);
  return out;
}

// Satori (the renderer inside workers-og) throws — and the streamed PNG comes
// back as a 0-byte body AFTER a 200 + image/png header is already flushed — if
// any element has more than one child node without `display: flex` (or `none`).
// That exact footgun shipped the entire dynamic OG card as a blank image in
// production: `<div>commit {sha}</div>` is two children (the literal "commit "
// and the {sha} expression). It's invisible to a status/content-type check, and
// the real WASM render isn't exercised in vitest — so we encode satori's rule as
// a structural assertion over the captured node tree, which IS pure logic. Walk
// every element; one with >1 non-empty child must declare a flex/none display.
// Returns the offending element tags (empty = valid).
function satoriDisplayViolations(node: unknown): string[] {
  const bad: string[] = [];
  const childCount = (children: unknown): number => {
    const arr = Array.isArray(children) ? children : [children];
    let n = 0;
    for (const c of arr) {
      if (c == null || typeof c === 'boolean') continue;
      if (typeof c === 'string') {
        if (c.length > 0) n++;
      } else n++; // number or element
    }
    return n;
  };
  const walk = (n: unknown): void => {
    if (n == null || typeof n === 'boolean' || typeof n === 'string' || typeof n === 'number')
      return;
    if (Array.isArray(n)) {
      for (const c of n) walk(c);
      return;
    }
    if (typeof n === 'object') {
      const o = n as {
        tag?: unknown;
        props?: { style?: Record<string, unknown>; children?: unknown };
        children?: unknown;
      };
      const children = o.props && 'children' in o.props ? o.props.children : o.children;
      if (typeof o.tag === 'string') {
        const display = o.props?.style?.display;
        if (childCount(children) > 1 && display !== 'flex' && display !== 'none') {
          bad.push(`<${o.tag}> (display=${JSON.stringify(display ?? null)})`);
        }
      }
      walk(children);
    }
  };
  walk(node);
  return bad;
}

function makeEnv(svcRes?: Response): { WEB: { fetch: typeof fetch } } {
  return {
    WEB: {
      fetch: vi.fn(async () => svcRes ?? new Response('not in cache', { status: 404 })),
    } as unknown as { fetch: typeof fetch },
  };
}

describe('web-og routing', () => {
  it('healthz works', async () => {
    const res = await app.fetch(new Request('https://og.example/healthz'), makeEnv());
    expect(res.status).toBe(200);
  });

  it('rejects a non-.png URL with 404', async () => {
    const res = await app.fetch(new Request('https://og.example/r/o/r/c/abc1234.svg'), makeEnv());
    expect(res.status).toBe(404);
  });

  it('calls the WEB service binding with the internal secret header', async () => {
    const env = makeEnv(
      new Response(
        JSON.stringify({
          input: {
            kind: 'commit',
            repo: { owner: 'facebook', repo: 'react' },
            sha: 'a'.repeat(40),
          },
          canonicalSha: 'a'.repeat(40),
          firstRelease: { tag: 'v1.0.0', sha: 's', date: '2024-01-01T00:00:00Z', url: '' },
          alsoIn: [],
          releaseNotesHtml: null,
          rateLimit: null,
        }),
      ),
    );
    const res = await app.fetch(
      new Request('https://og.example/r/facebook/react/c/a1b2c3d.png'),
      env,
    );
    expect(res.status).toBe(200);
    // The service binding was called.
    expect(env.WEB.fetch).toHaveBeenCalled();
    // The cache-control should be the LONG one because we got a real result.
    expect(res.headers.get('cache-control')).toMatch(/max-age=86400/);
  });

  it('returns a placeholder PNG with SHORT cache when the service binding misses', async () => {
    const env = makeEnv(new Response('not found', { status: 404 }));
    const res = await app.fetch(
      new Request('https://og.example/r/facebook/react/c/a1b2c3d.png'),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toMatch(/max-age=60/);
  });

  // Federated OG (issue #8): the /h/:host/r/:projectPath path renders unfurls for
  // GitLab results, mirroring the federated permalink scheme in web/src/index.ts.
  it('federated: calls the host-aware internal endpoint with the encoded projectPath', async () => {
    const sha40 = 'a'.repeat(40);
    const env = makeEnv(
      new Response(
        JSON.stringify({
          input: {
            kind: 'commit',
            repo: { host: 'gitlab.gnome.org', projectPath: 'GNOME/gimp' },
            sha: sha40,
          },
          canonicalSha: sha40,
          firstRelease: { tag: 'GIMP_2_10_36', sha: 's', date: '2024-02-01T00:00:00Z', url: '' },
          alsoIn: [],
          releaseNotesHtml: null,
          rateLimit: null,
        }),
      ),
    );
    const res = await app.fetch(
      new Request('https://og.example/h/gitlab.gnome.org/r/GNOME%2Fgimp/c/a1b2c3d.png'),
      env,
    );
    expect(res.status).toBe(200);
    const calls = (env.WEB.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const calledUrl = String(calls[0]?.[0]);
    expect(calledUrl).toBe('https://web/internal/h/gitlab.gnome.org/r/GNOME%2Fgimp/a1b2c3d');
    // Real result → long cache.
    expect(res.headers.get('cache-control')).toMatch(/max-age=86400/);
  });

  it('federated: rejects a non-.png URL with 404', async () => {
    const res = await app.fetch(
      new Request('https://og.example/h/gitlab.com/r/g%2Fp/c/abc1234.svg'),
      makeEnv(),
    );
    expect(res.status).toBe(404);
  });

  it('federated: placeholder with SHORT cache when the binding misses', async () => {
    const env = makeEnv(new Response('not found', { status: 404 }));
    const res = await app.fetch(
      new Request('https://og.example/h/gitlab.com/r/g%2Fp/c/abc1234.png'),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toMatch(/max-age=60/);
  });

  // Deploy-order safety: an unmatched .png (a stale crawler URL, or a permalink
  // OG URL hit during the web→web-og deploy window before web-og ships the
  // matching route) renders a placeholder PNG, not a 404 text body — so a social
  // unfurl fetcher always gets a valid image.
  it('notFound: an unmatched .png renders a short-cached placeholder PNG, not 404', async () => {
    const res = await app.fetch(new Request('https://og.example/totally/unknown.png'), makeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toMatch(/max-age=60/);
    const text = collectText(lastRenderedNode);
    expect(text).toContain('Looking up…');
  });

  it('notFound: a non-.png path still 404s', async () => {
    const res = await app.fetch(new Request('https://og.example/totally/unknown'), makeEnv());
    expect(res.status).toBe(404);
  });
});

// The card the OG worker builds from a LookupResult branches on whether the
// commit is released. Both states ship as the social unfurl for a permalink, so
// the TEXT each one renders is user-facing and was previously unasserted (the
// routing tests only checked status + cache headers). We capture the satori node
// tree and assert its text leaves.
describe('web-og card content', () => {
  function resultEnv(result: Record<string, unknown>): { WEB: { fetch: typeof fetch } } {
    return makeEnv(new Response(JSON.stringify(result)));
  }
  const baseInput = {
    kind: 'commit',
    repo: { owner: 'facebook', repo: 'react', projectPath: 'facebook/react' },
    sha: 'a'.repeat(40),
  };

  it('released commit: shows the tag, the SHIPPED badge, the date and repo', async () => {
    const env = resultEnv({
      input: baseInput,
      canonicalSha: 'abc1234def5678',
      firstRelease: { tag: 'v18.2.0', sha: 's', date: '2024-03-15T09:00:00Z', url: '' },
      alsoIn: [],
      releaseNotesHtml: null,
      rateLimit: null,
    });
    const res = await app.fetch(
      new Request('https://og.example/r/facebook/react/c/abc1234.png'),
      env,
    );
    expect(res.status).toBe(200);
    const text = collectText(lastRenderedNode);
    expect(text).toContain('First released in');
    expect(text).toContain('v18.2.0');
    expect(text).toContain('SHIPPED');
    expect(text).toContain('2024-03-15'); // date sliced to YYYY-MM-DD
    expect(text).toContain('facebook/react');
    expect(text.join(' ')).toContain('abc1234'); // 7-char short sha
    // Not the not-yet-released copy.
    expect(text).not.toContain('not yet released');
  });

  it('unreleased commit (firstRelease null): says "not yet released", NO SHIPPED, NO date', async () => {
    const env = resultEnv({
      input: baseInput,
      canonicalSha: 'abc1234def5678',
      firstRelease: null,
      alsoIn: [],
      releaseNotesHtml: null,
      rateLimit: null,
    });
    const res = await app.fetch(
      new Request('https://og.example/r/facebook/react/c/abc1234.png'),
      env,
    );
    expect(res.status).toBe(200);
    const text = collectText(lastRenderedNode);
    expect(text).toContain('not yet released');
    // The SHIPPED badge and the date are gated on `firstRelease` — both gone.
    expect(text).not.toContain('SHIPPED');
    expect(text.some((t) => /^\d{4}-\d{2}-\d{2}$/.test(t))).toBe(false);
    // A long-cache header still applies — we DID get a result, it's just unreleased.
    expect(res.headers.get('cache-control')).toMatch(/max-age=86400/);
  });

  it('placeholder card (binding miss): shows "Looking up…" and the owner/repo label', async () => {
    const env = makeEnv(new Response('not found', { status: 404 }));
    const res = await app.fetch(
      new Request('https://og.example/r/facebook/react/c/abc1234.png'),
      env,
    );
    expect(res.status).toBe(200);
    const text = collectText(lastRenderedNode);
    expect(text).toContain('released');
    expect(text).toContain('Looking up…');
    expect(text.join(' ')).toContain('facebook/react @ abc1234');
  });

  // Regression for the 0-byte dynamic OG render: every card that ships as a real
  // unfurl must satisfy satori's "explicit display for multi-child elements"
  // rule, or it renders a 200 + empty PNG (blank social preview). Asserted for
  // BOTH card branches (released + not-yet) since both reach the dynamic path.
  it('released card: node tree has no satori multi-child display violations', async () => {
    const env = resultEnv({
      input: baseInput,
      canonicalSha: 'abc1234def5678',
      firstRelease: { tag: 'v18.2.0', sha: 's', date: '2024-03-15T09:00:00Z', url: '' },
      alsoIn: [],
      releaseNotesHtml: null,
      rateLimit: null,
    });
    await app.fetch(new Request('https://og.example/r/facebook/react/c/abc1234.png'), env);
    expect(satoriDisplayViolations(lastRenderedNode)).toEqual([]);
  });

  it('not-yet-released card: node tree has no satori multi-child display violations', async () => {
    const env = resultEnv({
      input: baseInput,
      canonicalSha: 'abc1234def5678',
      firstRelease: null,
      alsoIn: [],
      releaseNotesHtml: null,
      rateLimit: null,
    });
    await app.fetch(new Request('https://og.example/r/facebook/react/c/abc1234.png'), env);
    expect(satoriDisplayViolations(lastRenderedNode)).toEqual([]);
  });

  it('placeholder card: node tree has no satori multi-child display violations', async () => {
    const env = makeEnv(new Response('not found', { status: 404 }));
    await app.fetch(new Request('https://og.example/r/facebook/react/c/abc1234.png'), env);
    expect(satoriDisplayViolations(lastRenderedNode)).toEqual([]);
  });
});

// #79: issue/PR permalinks get a title-aware OG card. web-og adds /i/ and /p/
// image routes (mirroring the permalink scheme) that fetch the result resolved
// AS an issue/PR (so result.subject = the issue/PR title, not the commit
// subject) and render an "Issue #N" / "PR #N" headline above the release tag.
describe('web-og issue/PR cards (#79)', () => {
  function resultEnv(result: Record<string, unknown>): { WEB: { fetch: typeof fetch } } {
    return makeEnv(new Response(JSON.stringify(result)));
  }

  it('issue route: calls /internal/issue/:owner/:repo/:number and renders the title + tag', async () => {
    const env = resultEnv({
      input: {
        kind: 'issue',
        repo: { host: 'github.com', projectPath: 'honojs/hono' },
        number: 11,
      },
      canonicalSha: 'a'.repeat(40),
      subject: 'Logger builtin middleware',
      firstRelease: { tag: 'v0.0.11', sha: 's', date: '2024-04-01T00:00:00Z', url: '' },
      alsoIn: [],
      releaseNotesHtml: null,
      rateLimit: null,
    });
    const res = await app.fetch(new Request('https://og.example/i/honojs/hono/11.png'), env);
    expect(res.status).toBe(200);
    const calls = (env.WEB.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(String(calls[0]?.[0])).toBe('https://web/internal/issue/honojs/hono/11');
    const text = collectText(lastRenderedNode);
    expect(text).toContain('Issue #11');
    expect(text).toContain('Logger builtin middleware'); // the title (subject)
    expect(text).toContain('v0.0.11');
    expect(text).toContain('honojs/hono');
    // Real result → long cache.
    expect(res.headers.get('cache-control')).toMatch(/max-age=86400/);
  });

  it('pr route: calls /internal/pr/:owner/:repo/:number and renders "PR #N" + title', async () => {
    const env = resultEnv({
      input: { kind: 'pr', repo: { host: 'github.com', projectPath: 'honojs/hono' }, number: 17 },
      canonicalSha: 'a'.repeat(40),
      subject: 'Add logger builtin',
      firstRelease: { tag: 'v0.0.11', sha: 's', date: '2024-04-01T00:00:00Z', url: '' },
      alsoIn: [],
      releaseNotesHtml: null,
      rateLimit: null,
    });
    const res = await app.fetch(new Request('https://og.example/p/honojs/hono/17.png'), env);
    expect(res.status).toBe(200);
    const calls = (env.WEB.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(String(calls[0]?.[0])).toBe('https://web/internal/pr/honojs/hono/17');
    const text = collectText(lastRenderedNode);
    expect(text).toContain('PR #17');
    expect(text).toContain('Add logger builtin');
    expect(text).toContain('v0.0.11');
  });

  it('federated issue route: calls /internal/h/:host/i/:projectPath/:number', async () => {
    const env = resultEnv({
      input: {
        kind: 'issue',
        repo: { host: 'gitlab.gnome.org', projectPath: 'GNOME/glib' },
        number: 1234,
      },
      canonicalSha: 'a'.repeat(40),
      subject: 'Fix a GLib crash',
      firstRelease: { tag: '2.88.2', sha: 's', date: '2024-02-01T00:00:00Z', url: '' },
      alsoIn: [],
      releaseNotesHtml: null,
      rateLimit: null,
    });
    const res = await app.fetch(
      new Request('https://og.example/h/gitlab.gnome.org/i/GNOME%2Fglib/1234.png'),
      env,
    );
    expect(res.status).toBe(200);
    const calls = (env.WEB.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(String(calls[0]?.[0])).toBe(
      'https://web/internal/h/gitlab.gnome.org/i/GNOME%2Fglib/1234',
    );
    const text = collectText(lastRenderedNode);
    expect(text).toContain('Issue #1234');
    expect(text).toContain('Fix a GLib crash');
  });

  it('issue route: placeholder with SHORT cache on binding miss shows owner/repo #N', async () => {
    const env = makeEnv(new Response('not found', { status: 404 }));
    const res = await app.fetch(new Request('https://og.example/i/honojs/hono/11.png'), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toMatch(/max-age=60/);
    const text = collectText(lastRenderedNode);
    expect(text).toContain('Looking up…');
    expect(text.join(' ')).toContain('honojs/hono #11');
  });

  it('issue card: no satori multi-child display violations', async () => {
    const env = resultEnv({
      input: {
        kind: 'issue',
        repo: { host: 'github.com', projectPath: 'honojs/hono' },
        number: 11,
      },
      canonicalSha: 'a'.repeat(40),
      subject: 'Logger builtin middleware',
      firstRelease: { tag: 'v0.0.11', sha: 's', date: '2024-04-01T00:00:00Z', url: '' },
      alsoIn: [],
      releaseNotesHtml: null,
      rateLimit: null,
    });
    await app.fetch(new Request('https://og.example/i/honojs/hono/11.png'), env);
    expect(satoriDisplayViolations(lastRenderedNode)).toEqual([]);
  });

  it('pr card: no satori multi-child display violations', async () => {
    const env = resultEnv({
      input: { kind: 'pr', repo: { host: 'github.com', projectPath: 'honojs/hono' }, number: 17 },
      canonicalSha: 'a'.repeat(40),
      subject: 'Add logger builtin',
      firstRelease: { tag: 'v0.0.11', sha: 's', date: '2024-04-01T00:00:00Z', url: '' },
      alsoIn: [],
      releaseNotesHtml: null,
      rateLimit: null,
    });
    await app.fetch(new Request('https://og.example/p/honojs/hono/17.png'), env);
    expect(satoriDisplayViolations(lastRenderedNode)).toEqual([]);
  });

  it('issue route: rejects a non-.png URL with 404', async () => {
    const res = await app.fetch(new Request('https://og.example/i/honojs/hono/11.svg'), makeEnv());
    expect(res.status).toBe(404);
  });

  // A federated MR shares the permalink page's "Merge request !N" noun/sigil
  // (the page pulls them from provider.terms; web-og has no provider terms, so
  // the PR branch must branch on host). Covers the federated PR route end-to-end
  // too — previously a copy of the issue route with nothing asserting it.
  it('federated MR route: calls /internal/h/:host/p/:projectPath/:number and renders "Merge request !N"', async () => {
    const env = resultEnv({
      input: {
        kind: 'pr',
        repo: { host: 'gitlab.gnome.org', projectPath: 'GNOME/glib' },
        number: 5678,
      },
      canonicalSha: 'a'.repeat(40),
      subject: 'Merge the GLib fix',
      firstRelease: { tag: '2.88.2', sha: 's', date: '2024-02-01T00:00:00Z', url: '' },
      alsoIn: [],
      releaseNotesHtml: null,
      rateLimit: null,
    });
    const res = await app.fetch(
      new Request('https://og.example/h/gitlab.gnome.org/p/GNOME%2Fglib/5678.png'),
      env,
    );
    expect(res.status).toBe(200);
    const calls = (env.WEB.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(String(calls[0]?.[0])).toBe(
      'https://web/internal/h/gitlab.gnome.org/p/GNOME%2Fglib/5678',
    );
    const text = collectText(lastRenderedNode);
    expect(text).toContain('Merge request !5678');
    expect(text).toContain('Merge the GLib fix');
    expect(text).toContain('2.88.2');
    expect(text).not.toContain('PR #5678');
  });

  // Regression: a malformed %-escape in the federated projectPath (e.g. `foo%2`)
  // must render the placeholder, not throw. Hono's c.req.param() already decodes
  // safely (try/catch), so an explicit decodeURIComponent is a redundant
  // double-decode that throws URIError on malformed input → HTTP 500 before the
  // placeholder can render. A crawler's og:image fetch must get a PNG, not a 500.
  it('federated issue route: a malformed %-escape renders a placeholder, not a 500', async () => {
    const env = makeEnv(new Response('not found', { status: 404 }));
    const res = await app.fetch(
      new Request('https://og.example/h/gitlab.gnome.org/i/foo%2/9.png'),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toMatch(/max-age=60/);
    const text = collectText(lastRenderedNode);
    expect(text).toContain('Looking up…');
  });

  // The %-escape need not be malformed — a lone `%` arrives via the valid
  // encoding `%25`, which Hono decodes to `%`. The OLD code then
  // decodeURIComponent'd that `%` again and threw URIError → 500. Pinned so the
  // fix (no redundant double-decode) stays intact for this exact repro.
  it('federated issue route: a `%25` (lone percent) path renders a placeholder, not a 500', async () => {
    const env = makeEnv(new Response('not found', { status: 404 }));
    const res = await app.fetch(
      new Request('https://og.example/h/gitlab.gnome.org/i/bad%25/1.png'),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toMatch(/max-age=60/);
  });

  // A verbose issue/PR title (GitHub allows 256 chars) must not overflow the
  // 630px card. The title renders at fontSize 40 above a flex:1 spacer; ~4+
  // lines collapse the spacer and satori clips the bottom (SHA + domain) and
  // crowds the tag/date. Cap it with an ellipsis so it can't overflow.
  it('issue card: a long title is truncated with an ellipsis, never overflowing', async () => {
    const env = resultEnv({
      input: {
        kind: 'issue',
        repo: { host: 'github.com', projectPath: 'honojs/hono' },
        number: 11,
      },
      canonicalSha: 'a'.repeat(40),
      subject: 'X'.repeat(200),
      firstRelease: { tag: 'v0.0.11', sha: 's', date: '2024-04-01T00:00:00Z', url: '' },
      alsoIn: [],
      releaseNotesHtml: null,
      rateLimit: null,
    });
    await app.fetch(new Request('https://og.example/i/honojs/hono/11.png'), env);
    // The card still satisfies satori's layout rules.
    expect(satoriDisplayViolations(lastRenderedNode)).toEqual([]);
    const joined = collectText(lastRenderedNode).join('');
    expect(joined).toContain('…'); // truncated
    expect(joined).not.toContain('X'.repeat(80)); // capped short of 80 chars
    expect(joined).toContain('X'.repeat(70)); // but kept most of the title
  });

  // Truncation must cut on a Unicode code-point boundary, not a UTF-16 code-unit
  // boundary: slicing at index 79 can split an emoji surrogate pair (🎉 is two
  // code units), leaving a lone high surrogate that satori/resvg renders as □.
  it('issue card: truncating an emoji at the boundary leaves no lone surrogate', async () => {
    // 78 plain chars + a 2-code-unit emoji at positions 78–79 + a trailing char
    // → title.length === 81 (> 80, so it truncates), and index 79 falls inside
    // the surrogate pair. `title.slice(0, 79)` would keep the high surrogate.
    const title = 'X'.repeat(78) + '🎉' + 'Y';
    const env = resultEnv({
      input: {
        kind: 'issue',
        repo: { host: 'github.com', projectPath: 'honojs/hono' },
        number: 11,
      },
      canonicalSha: 'a'.repeat(40),
      subject: title,
      firstRelease: { tag: 'v0.0.11', sha: 's', date: '2024-04-01T00:00:00Z', url: '' },
      alsoIn: [],
      releaseNotesHtml: null,
      rateLimit: null,
    });
    await app.fetch(new Request('https://og.example/i/honojs/hono/11.png'), env);
    const joined = collectText(lastRenderedNode).join('');
    expect(joined).toContain('…');
    // No lone surrogate (U+D800–U+DFFF) leaks into the rendered text.
    expect(/[\u{D800}-\u{DFFF}]/u.test(joined)).toBe(false);
  });
});
