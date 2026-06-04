// One-shot broad audit: runs axe with the FULL WCAG 2.1 AA ruleset against
// every distinct page state we render. Gated on A11Y_AUDIT=1 because it's a
// review tool, not part of the CI gate — the dedicated jsdom/contrast suites
// are the gates. Run with:
//   A11Y_AUDIT=1 pnpm --filter @released/web test test/a11y-full-audit.test.ts

import AxeBuilder from '@axe-core/playwright';
import { type Browser, type BrowserContext, chromium } from 'playwright';
import { afterAll, beforeAll, describe, it, vi } from 'vitest';

const RUN = process.env.A11Y_AUDIT === '1';

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

describe.runIf(RUN)('a11y — full audit (all WCAG 2.1 AA rules)', () => {
  let browser: Browser;
  let context: BrowserContext;
  beforeAll(async () => {
    browser = await chromium.launch();
    context = await browser.newContext();
  });
  afterAll(async () => {
    await context?.close();
    await browser?.close();
  });

  async function audit(name: string, html: string): Promise<void> {
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => {
      for (const d of document.querySelectorAll('details.share')) {
        (d as HTMLDetailsElement).open = true;
      }
    });
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    await page.close();
    if (results.violations.length === 0) {
      console.log(`✓ ${name}: 0 violations`);
      return;
    }
    console.log(`✗ ${name}: ${results.violations.length} violation(s)`);
    for (const v of results.violations) {
      console.log(`    • [${v.impact}] ${v.id} — ${v.help}`);
      for (const n of v.nodes) {
        console.log(`        ${n.target.join(' ')}`);
        if (n.failureSummary) {
          for (const line of n.failureSummary.split('\n')) console.log(`        ${line}`);
        }
      }
    }
  }

  function mockGithubPr(opts: {
    owner: string;
    repo: string;
    n: number;
    merged: boolean;
    state: 'open' | 'closed';
    title?: string | null;
    mergeSha?: string | null;
  }) {
    return vi.fn(async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes(`api.github.com/repos/${opts.owner}/${opts.repo}/pulls/${opts.n}`)) {
        return new Response(
          JSON.stringify({
            merged: opts.merged,
            state: opts.state,
            merge_commit_sha: opts.mergeSha ?? null,
            title: opts.title ?? null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
  }

  it('audits every distinct page state', async () => {
    // 1) Homepage
    const home = await app.fetch(new Request('https://released.example/'));
    await audit('homepage', await home.text());

    // 2) Homepage error banner (bare-SHA recovery flow)
    const homeErr = await app.fetch(
      new Request('https://released.example/?bad=abc1234&reason=bare_sha'),
    );
    await audit('homepage (error banner)', await homeErr.text());

    // 3) Unmerged open PR
    const orig = globalThis.fetch;
    try {
      globalThis.fetch = mockGithubPr({
        owner: 'foo',
        repo: 'bar',
        n: 1,
        merged: false,
        state: 'open',
        title: 'add cache layer',
      });
      cacheStore.clear();
      const openPr = await app.fetch(new Request('https://released.example/p/foo/bar/1'));
      await audit('unmerged open PR', await openPr.text());

      globalThis.fetch = mockGithubPr({
        owner: 'foo',
        repo: 'bar',
        n: 2,
        merged: false,
        state: 'closed',
      });
      cacheStore.clear();
      const closedPr = await app.fetch(new Request('https://released.example/p/foo/bar/2'));
      await audit('closed (never merged) PR', await closedPr.text());
    } finally {
      globalThis.fetch = orig;
    }
  });
});
