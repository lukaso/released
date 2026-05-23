// Light integration tests using Hono's app.fetch directly.
// No Cloudflare runtime needed — Hono apps are plain Request handlers.

import { describe, expect, it, vi } from 'vitest';

// Polyfill the Workers-only `caches.default` for these tests so cache.ts works.
const cacheStore = new Map<string, Response>();
(
  globalThis as unknown as {
    caches: { default: { match: typeof Cache.prototype.match; put: typeof Cache.prototype.put } };
  }
).caches = {
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

  it('GET /lookup?q=<gitlab.com URL> redirects to the federated permalink (post-federation)', async () => {
    const res = await app.fetch(
      new Request(
        'https://released.example/lookup?q=' +
          encodeURIComponent('https://gitlab.com/foo/bar/-/commit/abc1234'),
      ),
    );
    expect(res.status).toBe(302);
    // Federated path: /h/{host}/r/{projectPathEnc}/c/{sha}
    expect(res.headers.get('location')).toBe('/h/gitlab.com/r/foo%2Fbar/c/abc1234');
  });

  it('GET /lookup?q=<unknown gitlab host> bounces with reason=unsupported_host', async () => {
    const res = await app.fetch(
      new Request(
        'https://released.example/lookup?q=' +
          encodeURIComponent('https://gitlab.example.com/x/y/-/commit/abc1234'),
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('reason=unsupported_host');
  });

  it('GET /lookup?q=<bitbucket URL> bounces with reason=unsupported_host', async () => {
    const res = await app.fetch(
      new Request(
        'https://released.example/lookup?q=' +
          encodeURIComponent('https://bitbucket.org/atlassian/jira/commits/abc1234'),
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('reason=unsupported_host');
  });

  it('homepage placeholder mentions GitHub forms first, GitLab abbreviated last (GitHub-default constraint)', async () => {
    const res = await app.fetch(new Request('https://released.example/'));
    const body = await res.text();
    // GitHub forms are positions 1-3, GitLab is position 4. This locks in the
    // design-review decision so a future contributor doesn't "fairly" re-order.
    expect(body).toMatch(
      /placeholder="github\.com[^"]*owner\/repo[^"]*o\/r#PR[^"]*gitlab\.gnome\.org/,
    );
    // Field label generalizes to pull/merge.
    expect(body).toContain('Commit URL, SHA, or pull/merge request');
  });

  it('unsupported_host error copy lists supported hosts AND names EXTRA_GITLAB_HOSTS', async () => {
    const res = await app.fetch(
      new Request(
        'https://released.example/?bad=' +
          encodeURIComponent('https://gitlab.example.com/x/y') +
          '&reason=unsupported_host',
      ),
    );
    const body = await res.text();
    expect(body).toContain('gitlab.gnome.org');
    expect(body).toContain('EXTRA_GITLAB_HOSTS');
  });

  it('GET /h/:host/p/:projectPath/:number routes to the prRoute handler (federation)', async () => {
    // Mock the outbound GitLab call so the test doesn't hit the real network.
    // The MR exists but is not merged — exercises the "Merge request not merged"
    // rendering path, which is where the federation-aware label + URL matter most.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('gitlab.gnome.org')) {
        return new Response(
          JSON.stringify({
            state: 'opened',
            merge_commit_sha: null,
            squash_commit_sha: null,
            sha: null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    try {
      const res = await app.fetch(
        new Request('https://released.example/h/gitlab.gnome.org/p/GNOME%2Fgimp/2466'),
      );
      const body = await res.text();
      expect(res.status).toBe(200); // "Not merged yet" is a real answer, not an error
      // Federation-aware vocabulary in the rendered page:
      expect(body).toContain('Merge request'); // not "Pull request"
      expect(body).toContain('!2466'); // GitLab uses ! prefix, not #
      // Link routes back to the GitLab host (not github.com).
      expect(body).toContain('gitlab.gnome.org/GNOME/gimp/-/merge_requests/2466');
      // Security headers still fire.
      expect(res.headers.get('x-frame-options')).toBe('DENY');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('GitLab MR result form pre-fills the FULL URL (round-trips through parseInput, not the GitHub shorthand)', async () => {
    // Regression: the `owner/repo#N` shorthand is GitHub-only. If a GitLab
    // MR result rendered the input as `Infrastructure/gimp-macos-build#398`,
    // re-submitting that form would route to github.com/Infrastructure/...
    // and return "PR not found". Pre-fill must be a host-aware URL.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('gitlab.gnome.org/api/v4/projects')) {
        // Merged MR with FF sha so the algorithm advances past PR-resolution.
        if (url.includes('/merge_requests/398')) {
          return new Response(
            JSON.stringify({
              state: 'merged',
              merge_commit_sha: null,
              squash_commit_sha: null,
              sha: 'ffheadsha1234567890abcdef1234567890abcdef',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/refs?type=tag')) {
          // GitlabProvider.containingTags shortcut: tag contains the commit.
          // Must come BEFORE the /repository/commits/ branch — refs is a subpath.
          return new Response(JSON.stringify([{ type: 'tag', name: 'GIMP_3_2_0' }]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/repository/commits/ffheadsha')) {
          return new Response(
            JSON.stringify({
              id: 'ffheadsha1234567890abcdef1234567890abcdef',
              committed_date: '2024-01-01T00:00:00Z',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/repository/tags')) {
          // One tag so the algorithm has something to bisect (then returns
          // "not yet released" → renders the result page with the form).
          return new Response(
            JSON.stringify([
              {
                name: 'GIMP_3_2_0',
                commit: { id: 'tagsha', committed_date: '2024-06-01T00:00:00Z' },
              },
            ]),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/repository/compare')) {
          // Tag CONTAINS the commit (empty commits → "behind" → contains).
          // The success path is where the form-with-pre-fill renders.
          return new Response(JSON.stringify({ commits: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/releases/')) {
          // No Release object → null body.
          return new Response(JSON.stringify({}), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    try {
      const res = await app.fetch(
        new Request(
          'https://released.example/h/gitlab.gnome.org/p/Infrastructure%2Fgimp-macos-build/398',
        ),
      );
      const body = await res.text();
      // The input field must be pre-filled with a URL that parses back to the
      // SAME GitLab MR — not the `owner/repo#N` shorthand (GitHub-only).
      expect(body).toMatch(
        /<input[^>]*name="q"[^>]*value="https:\/\/gitlab\.gnome\.org\/Infrastructure\/gimp-macos-build\/-\/merge_requests\/398"/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
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
    const res = await app.fetch(new Request('https://released.example/r/o/r/c/not-a-sha-at-all'));
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
    const inputs = Array.from(
      { length: 11 },
      (_, i) => `facebook/react@abc12${i.toString().padStart(2, '0')}`,
    );
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

// Issue #1: nav + footer linked to /how-it-works but no route existed → every
// click 404'd. Cheapest fix: redirect to the README's Architecture anchor,
// where the content already lives.
describe('/how-it-works redirect (issue #1)', () => {
  it('redirects to the GitHub README Architecture anchor', async () => {
    const res = await app.fetch(new Request('https://released.example/how-it-works'));
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://github.com/lukaso/released#architecture');
  });
});

// Issue #3: homepage advertised "Look up several at once →" linking to /bulk,
// but the /bulk UI was never built (only the API). Link removed until the page
// exists; tracked in issue #3.
describe('homepage no longer links to /bulk (issue #3)', () => {
  it('does not link to /bulk or show the "Look up several at once" CTA', async () => {
    const res = await app.fetch(new Request('https://released.example/'));
    const body = await res.text();
    expect(body).not.toContain('href="/bulk"');
    expect(body).not.toContain('Look up several at once');
  });
});

describe('homepage popular-projects chips', () => {
  it('renders a chip section between the bulk link and the example', async () => {
    const res = await app.fetch(new Request('https://released.example/'));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('projects-section');
    expect(body).toContain('aria-labelledby="popular-projects-label"');
    // Label visible
    expect(body).toMatch(/<span[^>]*class="projects-label"[^>]*>Popular projects<\/span>/);
    // Hint line below the row prevents "only these N are supported" misread
    expect(body).toContain('any GitHub / GitLab URL above');
  });

  it('renders a <button type="button"> per known project, with data-alias and displayName', async () => {
    const res = await app.fetch(new Request('https://released.example/'));
    const body = await res.text();
    // Spot-check three representative aliases (GitLab, GitHub, dotted)
    expect(body).toMatch(
      /<button[^>]*type="button"[^>]*class="project-chip"[^>]*data-alias="gtk"[^>]*>GTK<\/button>/,
    );
    expect(body).toMatch(
      /<button[^>]*type="button"[^>]*class="project-chip"[^>]*data-alias="react"[^>]*>React<\/button>/,
    );
    expect(body).toMatch(
      /<button[^>]*type="button"[^>]*class="project-chip"[^>]*data-alias="next\.js"[^>]*>Next\.js<\/button>/,
    );
  });

  it('exposes the click handler that wires chip clicks to the search input', async () => {
    const res = await app.fetch(new Request('https://released.example/'));
    const body = await res.text();
    // The inline JS targets .project-chip and writes to the #q input.
    expect(body).toContain('.project-chip');
    expect(body).toMatch(/getElementById\(.q.\)/);
    // Mirror of computeChipClickInputValue is inlined (SHA-shape detection).
    expect(body).toMatch(/\[0-9a-f\]\{7,40\}/);
  });
});

describe('bare-SHA error banner — recovery chips', () => {
  it('shows the in-banner project chips when reason=bare_sha', async () => {
    const res = await app.fetch(
      new Request('https://released.example/?bad=8c0ef808ea&reason=bare_sha'),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    // Error banner is present with the bare-SHA copy
    expect(body).toContain('looks like a SHA, but I need a repo too');
    // In-banner chips block
    expect(body).toContain('class="error-chips"');
    expect(body).toContain('aria-labelledby="popular-projects-label-err"');
    // Chips themselves render inside the banner — at least one alias survives
    expect(body).toMatch(/data-alias="gtk"/);
  });

  it('does NOT show the in-banner chips for non-bare-SHA errors', async () => {
    const res = await app.fetch(
      new Request(
        'https://released.example/?bad=' +
          encodeURIComponent('https://bitbucket.org/atlassian/jira') +
          '&reason=unsupported_host',
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    // Top-of-page chip row is still there, but the in-banner one is not.
    expect(body).not.toContain('class="error-chips"');
    expect(body).not.toContain('aria-labelledby="popular-projects-label-err"');
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

// Copy UI: a paste-able link / auto-updating badge, available even before a
// release lands. The badge URL is the permalink with `/badge.svg` appended.
describe('permalink copy UI + badge embed', () => {
  it('exposes the "as Badge" copy button and the client builds a badge.svg snippet', async () => {
    const res = await app.fetch(new Request('https://released.example/'));
    const body = await res.text();
    // The button is present (in the shared CopyActions row)…
    expect(body).toContain('data-copy="badge"');
    // …and the client copy handler builds the `…/badge.svg` markdown…
    expect(body).toContain("'/badge.svg)](' + perma + ')'");
    // …and weaves the human headline (subject) into the non-link formats.
    expect(body).toContain('r.subject');
  });

  it('released MR page: readable .pr-banner links + a live badge preview', async () => {
    cacheStore.clear();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('gitlab.gnome.org/api/v4/projects')) {
        if (url.includes('/merge_requests/601')) {
          return new Response(
            JSON.stringify({
              state: 'merged',
              sha: 'ffheadsha1234567890abcdef1234567890abcdef',
              title: 'Port build to macOS arm64',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/refs?type=tag')) {
          return new Response(JSON.stringify([{ type: 'tag', name: 'GIMP_3_2_0' }]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/repository/commits/ffheadsha')) {
          return new Response(
            JSON.stringify({
              id: 'ffheadsha1234567890abcdef1234567890abcdef',
              committed_date: '2024-01-01T00:00:00Z',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/repository/tags')) {
          return new Response(
            JSON.stringify([
              {
                name: 'GIMP_3_2_0',
                commit: { id: 'tagsha', committed_date: '2024-06-01T00:00:00Z' },
              },
            ]),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/releases/')) {
          return new Response('{}', {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    try {
      const res = await app.fetch(
        new Request('https://released.example/h/gitlab.gnome.org/p/GNOME%2Fgimp/601'),
      );
      expect(res.status).toBe(200);
      const body = await res.text();
      // The "Resolved …" banner now uses a class with explicit link colors.
      expect(body).toContain('class="pr-banner"');
      expect(body).toContain('.pr-banner a {'); // the readable-link CSS shipped
      // Badge button + the live copy-preview panel (populated client-side).
      expect(body).toContain('data-copy="badge"');
      expect(body).toContain('data-copy-preview');
      expect(body).toContain('copy-preview-badge');
      // The MR title flows into the inline result payload (subject), so the
      // copy formats can be self-describing.
      expect(body).toContain('Port build to macOS arm64');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('not-yet-released MR page: copy actions + auto-update hint + inline result data', async () => {
    cacheStore.clear();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('gitlab.gnome.org/api/v4/projects')) {
        if (url.includes('/merge_requests/602')) {
          return new Response(
            JSON.stringify({
              state: 'merged',
              sha: 'ffheadsha1234567890abcdef1234567890abcdef',
              title: 'Add experimental cache layer',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/refs?type=tag')) {
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/repository/commits/ffheadsha')) {
          return new Response(
            JSON.stringify({
              id: 'ffheadsha1234567890abcdef1234567890abcdef',
              committed_date: '2024-06-01T00:00:00Z',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/repository/tags')) {
          return new Response(
            JSON.stringify([
              {
                name: 'GIMP_3_0_0',
                commit: { id: 'tagsha', committed_date: '2024-05-01T00:00:00Z' },
              },
            ]),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    try {
      const res = await app.fetch(
        new Request('https://released.example/h/gitlab.gnome.org/p/GNOME%2Fgimp/602'),
      );
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('Not yet released');
      // Copy affordances work even when unreleased.
      expect(body).toContain('data-copy="badge"');
      expect(body).toContain('flips to the version automatically');
      // The client copy handler needs the result payload injected…
      expect(body).toContain('window.__RELEASED_RESULT__ =');
      // …and the MR title rides along (via NotYetReleasedError.subject).
      expect(body).toContain('Add experimental cache layer');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// Hint placement: the "broaden the search" hint (strict / prereleases) is a
// next-step, so it renders BELOW the "Not yet released" answer, not above it.
describe('not-yet hint placement', () => {
  it('renders the StrictHint AFTER the "Not yet released" card', async () => {
    cacheStore.clear();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('gitlab.gnome.org/api/v4/projects')) {
        if (url.includes('/merge_requests/603')) {
          return new Response(
            JSON.stringify({ state: 'merged', sha: 'ffheadsha1234567890abcdef1234567890abcdef' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/refs?type=tag')) {
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/repository/commits/ffheadsha')) {
          return new Response(
            JSON.stringify({
              id: 'ffheadsha1234567890abcdef1234567890abcdef',
              committed_date: '2024-06-01T00:00:00Z',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/repository/tags')) {
          // A 2020 tag, >90 days before the 2024 commit → culled by the date
          // margin → NotYetReleasedError carries culledTagCount > 0 → StrictHint.
          return new Response(
            JSON.stringify([
              { name: 'OLD_1_0', commit: { id: 'oldsha', committed_date: '2020-01-01T00:00:00Z' } },
            ]),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    try {
      const res = await app.fetch(
        new Request('https://released.example/h/gitlab.gnome.org/p/GNOME%2Fgimp/603'),
      );
      expect(res.status).toBe(200);
      const body = await res.text();
      const answerAt = body.indexOf('Not yet released');
      const hintAt = body.indexOf('skipped by the 90-day date cull');
      expect(answerAt).toBeGreaterThan(-1);
      expect(hintAt).toBeGreaterThan(-1);
      // The answer must come before the hint in document order.
      expect(answerAt).toBeLessThan(hintAt);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// Status badges: an auto-updating SVG embeddable in MR/PR markdown. Shares the
// permalink's lookup + cache; released answers cache long, everything else short
// so the badge flips once a release lands.
describe('status badge — /…/badge.svg', () => {
  it('renders an SVG with the version tag + green color, long cache, when released', async () => {
    cacheStore.clear();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('gitlab.gnome.org/api/v4/projects')) {
        if (url.includes('/merge_requests/501')) {
          return new Response(
            JSON.stringify({
              state: 'merged',
              merge_commit_sha: null,
              squash_commit_sha: null,
              sha: 'ffheadsha1234567890abcdef1234567890abcdef',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/refs?type=tag')) {
          return new Response(JSON.stringify([{ type: 'tag', name: 'GIMP_3_2_0' }]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/repository/commits/ffheadsha')) {
          return new Response(
            JSON.stringify({
              id: 'ffheadsha1234567890abcdef1234567890abcdef',
              committed_date: '2024-01-01T00:00:00Z',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/repository/tags')) {
          return new Response(
            JSON.stringify([
              {
                name: 'GIMP_3_2_0',
                commit: { id: 'tagsha', committed_date: '2024-06-01T00:00:00Z' },
              },
            ]),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/releases/')) {
          return new Response(JSON.stringify({}), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    try {
      const res = await app.fetch(
        new Request('https://released.example/h/gitlab.gnome.org/p/GNOME%2Fgimp/501/badge.svg'),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('image/svg+xml');
      const body = await res.text();
      expect(body).toContain('<svg');
      expect(body).toContain('GIMP_3_2_0');
      expect(body).toContain('#3fb950'); // --ship green
      // Released is terminal → long cache.
      expect(res.headers.get('cache-control')).toMatch(/max-age=86400/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('renders a "not yet" gold badge with short cache when merged but unreleased', async () => {
    cacheStore.clear();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('gitlab.gnome.org/api/v4/projects')) {
        if (url.includes('/merge_requests/502')) {
          return new Response(
            JSON.stringify({
              state: 'merged',
              merge_commit_sha: null,
              squash_commit_sha: null,
              sha: 'ffheadsha1234567890abcdef1234567890abcdef',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/refs?type=tag')) {
          // No tag contains the merge commit → "not yet released".
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/repository/commits/ffheadsha')) {
          return new Response(
            JSON.stringify({
              id: 'ffheadsha1234567890abcdef1234567890abcdef',
              committed_date: '2024-06-01T00:00:00Z',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/repository/tags')) {
          return new Response(
            JSON.stringify([
              {
                name: 'GIMP_3_0_0',
                commit: { id: 'tagsha', committed_date: '2024-05-01T00:00:00Z' },
              },
            ]),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    try {
      const res = await app.fetch(
        new Request('https://released.example/h/gitlab.gnome.org/p/GNOME%2Fgimp/502/badge.svg'),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('image/svg+xml');
      const body = await res.text();
      expect(body).toContain('not yet');
      expect(body).toContain('#d29922'); // --warn gold
      // Non-terminal → short cache so the proxy re-fetches and the badge flips.
      expect(res.headers.get('cache-control')).toMatch(/max-age=300/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('renders an "unknown" badge (no network) for a malformed SHA', async () => {
    const res = await app.fetch(
      new Request('https://released.example/r/facebook/react/c/not-a-sha/badge.svg'),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/svg+xml');
    const body = await res.text();
    expect(body).toContain('unknown');
    expect(res.headers.get('cache-control')).toMatch(/max-age=300/);
  });
});

afterEachClear();
function afterEachClear() {
  // No-op helper since vitest's beforeEach/afterEach are picked up at top-level;
  // we explicitly clear cacheStore in tests that need it.
  vi.spyOn; // satisfy import
}
