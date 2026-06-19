// GET /how-it-works — a real, indexable content page (was a 301 to the README).
//
// This is an SEO usage-loop entry point: it targets the query "which release
// contains a commit / what version includes this PR", and pre-answers the
// "why not git describe?" objection. Keep it content-first and link back to the
// functional tool — it is NOT the homepage and may carry marketing prose.

import type { Context } from 'hono';
import { type Env, ogBaseUrl, publicBaseUrl } from '../env.js';
import { makeNonce, securityHeaders } from '../security.js';
import { Layout } from '../ui/layout.js';

const REPO = 'https://github.com/lukaso/released';
const NPM = 'https://www.npmjs.com/package/git-released';

export function howItWorksRoute(c: Context): Response {
  const env = c.env as Env;
  const req = c.req.raw;
  const nonce = makeNonce();
  const pubBase = publicBaseUrl(env, req);
  const ogBase = ogBaseUrl(env, req);

  const html = (
    <Layout
      title="How released works — find the first release containing a commit"
      description="released finds the first release tag that contains a git commit or merged PR/MR, across GitHub and GitLab. How it compares to git describe --contains, and how it gets the first-release answer right."
      nonce={nonce}
      ogBaseUrl={ogBase}
      publicUrl={`${pubBase}/how-it-works`}
      ogResult={null}
      ogFallbackTitle="How released works"
    >
      <nav>
        <a class="wordmark" href="/">
          <span class="dot" />
          released
        </a>
        <div class="nav-links">
          <a href={NPM}>CLI</a>
          <a href={REPO}>GitHub</a>
        </div>
      </nav>
      <main>
        <h1 class="headline">How released works</h1>
        <p class="orient">
          "Is my commit shipped?" is a surprisingly annoying question, even if you've used git for
          years. Here's the answer, and how released gives it to you.
        </p>

        <h2>The question everyone eventually asks</h2>
        <p>
          A bug report says "fixed in commit <code>a1b2c3d</code>." A customer asks whether the fix
          is in a release yet, or if they have to wait. You're staring at a PR that merged last week
          and you need to know which tag actually shipped it.
        </p>

        <h2>
          The native answer — <code>git describe --contains</code>
        </h2>
        <p>
          Git can answer this with <code>git describe --contains &lt;sha&gt;</code> or{' '}
          <code>git tag --contains &lt;sha&gt;</code>, if you know about them. But they fight you:
          you need the repo cloned locally with all tags fetched; the output is cryptic offset
          notation like <code>v1.2.3~4^2</code> rather than a clean "first shipped in v1.2.3"; they
          can't take a PR or MR number; there's no shareable link or badge; and they error on
          shallow clones, lightweight tags, or a commit with no following tag.
        </p>

        <h2>What released does</h2>
        <p>
          Paste a commit URL, a bare SHA (<code>owner/repo abc1234</code>), or a merged PR/MR — for
          any public GitHub repo or a curated set of GitLab hosts (GNOME, KDE, Debian/salsa,
          freedesktop, Kitware) — and get the first release tag that contains it, the date it
          shipped, an "also in" list, a copy-pasteable permalink, and an auto-updating badge you can
          embed in a PR. No clone needed. There's also a CLI:
        </p>
        <pre>
          <code>npx git-released github.com/honojs/hono/commit/f82aba8</code>
        </pre>
        <p>
          → first released in <code>v4.12.11</code>.
        </p>

        <h2>The detail that's easy to get wrong</h2>
        <p>
          To find the <em>first</em> release you sort tags oldest-to-newest and walk them. The trap:
          git tag and commit dates are <strong>not</strong> reliably in topological order — clock
          skew, manually-set tag dates, and cherry-picks all break the assumption. If you{' '}
          <em>filter</em> tags by date you will silently drop the real answer. released uses date
          only to <em>order</em> the candidates; the actual containment test is a real ancestry
          check against each tag in turn. Date is the heuristic for order; ancestry is the truth.
        </p>

        <p style="margin-top: 28px;">
          <a href="/" style="color: var(--accent);">
            ← Try it: paste a commit or PR
          </a>
        </p>
      </main>
      <footer>
        <a href="/">home</a>
        <a href={NPM}>CLI</a>
        <a href={REPO}>GitHub</a>
      </footer>
    </Layout>
  );

  return new Response(`<!DOCTYPE html>${html.toString()}`, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=3600',
      ...securityHeaders(nonce, ogBase),
    },
  });
}
