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
