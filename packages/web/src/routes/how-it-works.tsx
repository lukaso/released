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
      title="How released works: find which release contains a commit"
      description="Find which release first contains a git commit or merged PR/MR, with a shareable permalink and an auto-updating badge. No clone; works on GitHub and GitLab."
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
          You need to know whether a commit or PR has made it into a released version, so you can
          depend on it, tell someone to upgrade, or say that it shipped. Paste it into released and
          you get the answer.
        </p>

        <h2>Know if you can depend on it</h2>
        <p>
          Before you pin a dependency, build on a fix, or tell users to upgrade, confirm it's
          actually in a published release. released gives you the first release that contains the
          commit or PR and the date it shipped, or tells you it hasn't shipped yet.
        </p>

        <h2>Tell anyone whether it shipped</h2>
        <p>
          A contributor asks if their merged PR has gone out. A customer asks if the fix is
          available. A teammate wants to confirm it before they announce it. Paste the PR or commit
          and you have the version to give them. It resolves a PR or MR to its merge commit for you,
          even when the PR was squashed or rebased.
        </p>

        <h2>No clone, any repo</h2>
        <p>
          It works from a URL on any public repo, including dependencies you've never checked out.
          GitHub and GitLab don't answer this in their web UI. The alternative is cloning the repo
          and running <code>git describe --contains</code>, which needs every tag fetched and prints{' '}
          <code>v1.2.3~4^2</code> instead of a version number.
        </p>

        <h2>Share it, or let the badge update itself</h2>
        <p>
          Every lookup is a permalink. Paste it in a release note, an issue, or a Slack thread, and
          whoever opens it sees the same answer. Or add <code>/badge.svg</code> and embed a badge in
          a PR: it reads "not yet released" until the commit ships, then flips to the version on its
          own, so the PR always shows current status. From a terminal,{' '}
          <code>npx git-released &lt;commit-or-pr&gt;</code>.
        </p>

        <h2>Where it works</h2>
        <p>
          GitHub, plus GitLab: gitlab.com, GNOME, KDE, Debian (salsa), freedesktop, and Kitware.
          Self-hosted GitLab can be added.
        </p>

        <h2>Private repos</h2>
        <p>
          The web app reads public repos. For a private repo, use the command-line version with a
          token that can read it, like{' '}
          <code>GITHUB_TOKEN=… npx git-released &lt;commit-or-pr&gt;</code> (or a GitLab token per
          host). The token scopes and environment variables are in the{' '}
          <a href={`${REPO}#private-repos`} style="color: var(--accent);">
            private-repos docs
          </a>
          .
        </p>

        <p style="margin-top: 28px;">
          <a href="/" style="color: var(--accent);">
            Try it on a commit or PR
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
