// Light integration tests using Hono's app.fetch directly.
// No Cloudflare runtime needed — Hono apps are plain Request handlers.

import { describe, expect, it, vi } from 'vitest';

// Polyfill the Workers-only `caches.default` for these tests so cache.ts works.
const cacheStore = new Map<string, Response>();
(globalThis as unknown as { caches: { default: { match: typeof Cache.prototype.match; put: typeof Cache.prototype.put } } }).caches = {
  default: {
    async match(req: Request | string) {
      const url = typeof req === 'string' ? req : req.url;
      const stored = cacheStore.get(url);
      return stored ? stored.clone() : undefined;
    },
    async put(req: Request | string, res: Response) {
      const url = typeof req === 'string' ? req : req.url;
      cacheStore.set(url, res);
    },
  } as unknown as Cache,
};

const { default: app } = await import('../src/index.js');

describe('web Worker — basic routing', () => {
  it('serves the homepage with the EXAMPLE result (real, click-to-verify)', async () => {
    const res = await app.fetch(new Request('https://released.example/'));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Is your commit shipped?');
    expect(body).toContain('EXAMPLE');
    // Real example: honojs/hono @ f82aba8 → v4.12.11
    expect(body).toContain('v4.12.11');
    expect(body).toContain('honojs/hono');
    expect(body).toContain('f82aba8');
    // "Run it yourself" link must point at /lookup with the github URL.
    expect(body).toContain('Run it yourself');
    expect(body).toMatch(/\/lookup\?q=.*github\.com.*honojs.*hono.*f82aba8/);
  });

  it('healthz returns ok', async () => {
    const res = await app.fetch(new Request('https://released.example/healthz'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  // Loading-state contract: on form submit the user must get visible
  // feedback within ~16ms so they don't think the click was lost. The
  // homepage form is a full-page-nav (GET /lookup → 302 → /r/...) and the
  // /r/... compute can take 4-10s on cold cache. We hook submit with a
  // tiny inline script that:
  //   (1) marks the form opted-in via `data-loading-form`
  //   (2) the shared CLIENT_JS in Layout finds those forms and on submit
  //       adds a `.loading` class + swaps the button label to "Looking up…"
  // This test asserts the contract: the form is opted in AND the script
  // that handles it is on the page.
  it('homepage form is opted into the loading-state handler', async () => {
    const res = await app.fetch(new Request('https://released.example/'));
    expect(res.status).toBe(200);
    const body = await res.text();
    // (1) form has the opt-in attribute (attribute order is renderer-defined)
    expect(body).toMatch(/<form[^>]*data-loading-form[^>]*>/);
    expect(body).toMatch(/<form[^>]*action="\/lookup"[^>]*>/);
    // (2) inline script targets the opted-in attribute
    expect(body).toContain('data-loading-form');
    // (3) loading-state copy is present (the script swaps to this)
    expect(body).toContain('Looking up');
  });

  it('GET /lookup?q=... redirects to the canonical permalink', async () => {
    const res = await app.fetch(
      new Request('https://released.example/lookup?q=github.com/facebook/react/commit/abc1234'),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/r/facebook/react/c/abc1234');
  });

  it('GET /lookup?q=<malformed> bounces back to / with bad= AND reason= params', async () => {
    const res = await app.fetch(new Request('https://released.example/lookup?q=garbage-input'));
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') ?? '';
    expect(loc).toContain('bad=garbage-input');
    expect(loc).toContain('reason=invalid_input');
  });

  it('GET /lookup?q=<non-github-url> uses reason=non_github_url', async () => {
    const res = await app.fetch(
      new Request(
        'https://released.example/lookup?q=' +
          encodeURIComponent('https://gitlab.com/foo/bar/-/commit/abc1234'),
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('reason=non_github_url');
  });

  it('homepage with ?bad=... surfaces a visible error banner + pre-fills the input', async () => {
    const res = await app.fetch(
      new Request('https://released.example/?bad=garbage&reason=invalid_input'),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    // JSX escapes the apostrophe to &#39; — match either form.
    expect(body).toMatch(/Couldn(['&#39;]+|&apos;)t parse that/);
    expect(body).toContain('input: garbage');
    // The input field should be pre-filled with the bad value so user can edit.
    expect(body).toMatch(/<input[^>]*value="garbage"/);
    // Error pages must not be cacheable (or the next visit shows stale error UI).
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('homepage without ?bad shows no error banner', async () => {
    const res = await app.fetch(new Request('https://released.example/'));
    const body = await res.text();
    expect(body).not.toMatch(/Couldn(['&#39;]+|&apos;)t parse that/);
  });

  it('permalink with a non-parseable sha redirects through homepage error UI', async () => {
    const res = await app.fetch(
      new Request('https://released.example/r/o/r/c/not-a-sha-at-all'),
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') ?? '';
    expect(loc).toContain('/?bad=');
    expect(loc).toContain('reason=');
  });

  it('POST /api/lookup rejects cross-origin requests', async () => {
    const res = await app.fetch(
      new Request('https://released.example/api/lookup', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        body: JSON.stringify({ input: 'facebook/react@abc1234' }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('POST /api/lookup-bulk rejects > MAX_BULK with 400', async () => {
    const inputs = Array.from({ length: 11 }, (_, i) => `facebook/react@abc12${i.toString().padStart(2, '0')}`);
    const res = await app.fetch(
      new Request('https://released.example/api/lookup-bulk', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inputs }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('bulk_limit');
  });

  it('GET /internal/result/... rejects requests without the service-binding header', async () => {
    const res = await app.fetch(
      new Request('https://released.example/internal/result/facebook/react/abc1234'),
    );
    expect(res.status).toBe(404);
  });

  it('GET /r/:o/:r/c/:sha for an unfurl bot with no cache returns a deferred-render card with short TTL', async () => {
    cacheStore.clear();
    const res = await app.fetch(
      new Request('https://released.example/r/facebook/react/c/abc1234', {
        headers: { 'user-agent': 'Slackbot 1.0 (+https://api.slack.com/robots)' },
      }),
    );
    expect(res.status).toBe(200);
    // NOT a long cache — must be short so the bot retries.
    expect(res.headers.get('cache-control')).toMatch(/max-age=60/);
    const body = await res.text();
    expect(body).toContain('Looking up');
  });
});

describe('homepage CSP', () => {
  it('emits a strict CSP with a nonce', async () => {
    const res = await app.fetch(new Request('https://released.example/'));
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toMatch(/script-src 'self' 'nonce-[0-9a-f]{32}'/);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    // The "img-src" allows the og.{domain} worker.
    expect(csp).toMatch(/img-src .*data: https:\/\/og\./);
  });
});

afterEachClear();
function afterEachClear() {
  // No-op helper since vitest's beforeEach/afterEach are picked up at top-level;
  // we explicitly clear cacheStore in tests that need it.
  vi.spyOn; // satisfy import
}
