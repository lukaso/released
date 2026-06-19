// SEO surface: robots.txt, sitemap.xml, and the /how-it-works content page.
// These are the durable usage-loop entry points — crawlable, indexable, and
// targeting the real query ("which release contains a commit").

import { describe, expect, it } from 'vitest';

// Same caches.default polyfill as integration.test.ts so cache.ts is happy.
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

describe('robots.txt', () => {
  it('serves a permissive robots.txt that points at the sitemap', async () => {
    const res = await app.fetch(new Request('https://released.example/robots.txt'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const body = await res.text();
    expect(body).toContain('User-agent: *');
    expect(body).toMatch(/Allow: \//);
    // Sitemap directive must be an ABSOLUTE URL derived from the request origin.
    expect(body).toContain('Sitemap: https://released.example/sitemap.xml');
  });
});

describe('sitemap.xml', () => {
  it('serves a valid urlset listing the homepage and /how-it-works', async () => {
    const res = await app.fetch(new Request('https://released.example/sitemap.xml'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('xml');
    const body = await res.text();
    expect(body).toContain('<urlset');
    expect(body).toContain('<loc>https://released.example/</loc>');
    expect(body).toContain('<loc>https://released.example/how-it-works</loc>');
  });
});

describe('/how-it-works content page (replaces the old 301)', () => {
  it('serves an indexable HTML page, not a redirect', async () => {
    const res = await app.fetch(new Request('https://released.example/how-it-works'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    // A real <meta name="description"> for search snippets.
    expect(body).toMatch(/<meta name="description" content="[^"]+"/);
    // Targets the query + names the native alternative it improves on.
    expect(body).toContain('first release');
    expect(body).toContain('git describe');
    // Links back to the tool and the source.
    expect(body).toContain('github.com/lukaso/released');
    // Security headers still fire on this rendered page.
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });
});
