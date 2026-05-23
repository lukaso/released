// Structural accessibility checks: render real pages via app.fetch, then run
// axe-core inside a jsdom realm. jsdom has no layout engine, so color-contrast
// is checked separately in the browser pass (scripts/a11y-contrast.mjs / CI) —
// here we catch the structural class: labels, roles, landmarks, alt text,
// heading order, duplicate ids, link/button names.

import axe from 'axe-core';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

// Workers `caches.default` polyfill so cache.ts works for pages that look up.
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

type Violation = { id: string; help: string; nodes: { target: unknown[] }[] };

async function axeViolations(html: string): Promise<Violation[]> {
  // Strip the page's own <script> tags so they don't execute under jsdom; we
  // only need the rendered markup. axe itself is loaded via an injected script
  // (runScripts: 'dangerously' executes appended scripts — no eval()).
  const stripped = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  const dom = new JSDOM(stripped, {
    url: 'https://released.example/',
    runScripts: 'dangerously',
  });
  const { window } = dom;
  // Expand the share disclosure so its collapsed tools are checked too.
  for (const d of window.document.querySelectorAll('details.share')) {
    (d as unknown as { open: boolean }).open = true;
  }
  const s = window.document.createElement('script');
  s.textContent = axe.source;
  window.document.head.appendChild(s);
  const results = await (
    window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<unknown> } }
  ).axe.run(window.document, {
    resultTypes: ['violations'],
    // No layout in jsdom → contrast is handled by the browser pass.
    rules: { 'color-contrast': { enabled: false } },
  });
  window.close();
  return (results as { violations: Violation[] }).violations;
}

const fmt = (vs: Violation[]) =>
  vs.map((v) => `  • ${v.id} (${v.nodes.length}): ${v.help}`).join('\n');

describe('a11y — structural (jsdom + axe)', () => {
  it('homepage has no structural violations', async () => {
    const res = await app.fetch(new Request('https://released.example/'));
    const html = await res.text();
    const vs = await axeViolations(html);
    expect(vs, `\n${fmt(vs)}`).toEqual([]);
  });

  it('not-yet-released MR page has no structural violations', async () => {
    cacheStore.clear();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('gitlab.gnome.org/api/v4/projects')) {
        if (url.includes('/merge_requests/701')) {
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
        new Request('https://released.example/h/gitlab.gnome.org/p/GNOME%2Fgimp/701'),
      );
      const html = await res.text();
      const vs = await axeViolations(html);
      expect(vs, `\n${fmt(vs)}`).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
