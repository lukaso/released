// Contrast accessibility checks — the one class jsdom can't do (no layout).
// Renders real pages in headless chromium and runs axe-core's color-contrast
// rule as a full WCAG AA gate. This is the guard that would have caught the
// unreadable dark-blue "Resolved …" links (#0000EE on the dark surface), and
// the sub-AA --text-3 metadata token (since lightened to meet AA).
//
// Gated behind A11Y_BROWSER=1 so the normal `pnpm test` inner loop stays fast
// and browser-free; the dedicated CI "a11y" job sets it and installs chromium.
// Run locally:  A11Y_BROWSER=1 pnpm --filter @released/web test test/a11y-contrast.test.ts

import AxeBuilder from '@axe-core/playwright';
import { type Browser, type BrowserContext, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const RUN = process.env.A11Y_BROWSER === '1';

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

type CheckResult = {
  id: string;
  data?: { fgColor?: string; bgColor?: string; contrastRatio?: number };
};
type Node = {
  failureSummary?: string;
  any?: CheckResult[];
  all?: CheckResult[];
  none?: CheckResult[];
};
type Fail = { fg: string; bg?: string; ratio?: number; summary?: string };

describe.runIf(RUN)('a11y — contrast (chromium + axe)', () => {
  let browser: Browser;
  let context: BrowserContext;
  beforeAll(async () => {
    browser = await chromium.launch();
    // @axe-core/playwright requires a page from an explicit context.
    context = await browser.newContext();
  });
  afterAll(async () => {
    await context?.close();
    await browser?.close();
  });

  /** Run the color-contrast rule and return every failing node (full WCAG AA). */
  async function contrastFailures(html: string): Promise<Fail[]> {
    const page = await context.newPage();
    // Inlined CSS in <head> applies; fonts are relative and simply fall back —
    // contrast is independent of font face. setContent gives real layout.
    await page.setContent(html, { waitUntil: 'load' });
    // Expand the share disclosure so the copy tools are contrast-checked too.
    await page.evaluate(() => {
      for (const d of document.querySelectorAll('details.share')) {
        (d as HTMLDetailsElement).open = true;
      }
    });
    const results = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
    await page.close();
    const fails: Fail[] = [];
    for (const v of results.violations) {
      for (const n of v.nodes as unknown as Node[]) {
        const checks = [...(n.any ?? []), ...(n.all ?? []), ...(n.none ?? [])];
        const c = checks.find((x) => x.id === 'color-contrast');
        fails.push({
          fg: (c?.data?.fgColor ?? '').toLowerCase(),
          bg: c?.data?.bgColor,
          ratio: c?.data?.contrastRatio,
          summary: n.failureSummary,
        });
      }
    }
    return fails;
  }

  const fmt = (fs: Fail[]) =>
    fs.map((f) => `  • fg ${f.fg} on bg ${f.bg} = ${f.ratio} — ${f.summary ?? ''}`).join('\n');

  it('positive control: a default-blue link on dark bg IS caught', async () => {
    // Proves the gate isn't vacuous — this is the dark-blue-links bug shape.
    const html =
      '<!DOCTYPE html><html lang="en"><head><title>t</title></head>' +
      '<body style="background:#111111"><a href="#" style="color:#0000EE">link</a></body></html>';
    const fails = await contrastFailures(html);
    expect(fails.length).toBeGreaterThan(0);
    expect(fails[0]?.fg).toBe('#0000ee');
  });

  it('homepage passes WCAG AA color-contrast', async () => {
    const res = await app.fetch(new Request('https://released.example/'));
    const fails = await contrastFailures(await res.text());
    expect(fails, `\n${fmt(fails)}`).toEqual([]);
  });

  // Regression: bare <a> tags inside .answer-date fell back to browser-default
  // #0000EE on the dark surface (the "BerriAI/litellm#29205" link in the
  // unmerged-PR copy). Add explicit color in styles, gate it here.
  it('unmerged (open) PR page passes WCAG AA color-contrast', async () => {
    cacheStore.clear();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('api.github.com/repos/foo/bar/pulls/42')) {
        return new Response(
          JSON.stringify({
            merged: false,
            state: 'open',
            merge_commit_sha: null,
            title: 'add cache layer',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
    try {
      const res = await app.fetch(new Request('https://released.example/p/foo/bar/42'));
      const fails = await contrastFailures(await res.text());
      expect(fails, `\n${fmt(fails)}`).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('not-yet-released MR page passes WCAG AA color-contrast (covers the Resolved banner)', async () => {
    cacheStore.clear();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('gitlab.gnome.org/api/v4/projects')) {
        if (url.includes('/merge_requests/702')) {
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
        new Request('https://released.example/h/gitlab.gnome.org/p/GNOME%2Fgimp/702'),
      );
      const fails = await contrastFailures(await res.text());
      expect(fails, `\n${fmt(fails)}`).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
