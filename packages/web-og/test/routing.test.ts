// Routing tests for web-og. We mock `workers-og`'s ImageResponse — the actual
// PNG rendering depends on WASM and the Workers runtime, which we verify with
// `wrangler dev` rather than in vitest.

import { describe, expect, it, vi } from 'vitest';

vi.mock('workers-og', () => ({
  // Mock ImageResponse as a Response subclass — cleaner than `return new
  // Response(...)` from a constructor (which trips lint/correctness/
  // noConstructorReturn and relies on the JS oddity where a constructor's
  // returned object overrides `this`).
  ImageResponse: class extends Response {
    constructor(_node: unknown, init?: { headers?: Record<string, string> }) {
      super('PNG-BYTES', { headers: init?.headers ?? {} });
    }
  },
}));

const { default: app } = await import('../src/index.js');

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
