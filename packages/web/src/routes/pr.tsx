// GET /p/:owner/:repo/:number — PR permalink. Resolves the PR to its merge
// commit, then renders the same result UI as /r/. The URL preserves the PR
// shape so users sharing PR-URL inputs see a PR-themed final URL.

import type { Context } from 'hono';
import { raw } from 'hono/html';
import {
  cacheKey,
  findRelease,
  makeGithubClient,
  NotYetReleasedError,
  PrMergeCommitUnavailableError,
  PrNotFoundError,
  PrNotMergedError,
  ReleasedError,
  type LookupResult,
} from '@released/core';
import { isUnfurlBot, resolveToken } from '../auth.js';
import { makeWorkerCache } from '../cache.js';
import { ogBaseUrl, publicBaseUrl, type Env } from '../env.js';
import { Layout } from '../ui/layout.js';
import { ResultCard, StrictHint } from '../ui/result-card.js';
import { makeNonce, securityHeaders } from '../security.js';
import { singleFlight } from '../single-flight.js';

export async function prRoute(c: Context): Promise<Response> {
  const env = c.env as Env;
  const req = c.req.raw;
  const owner = c.req.param('owner');
  const repo = c.req.param('repo');
  const numberStr = c.req.param('number');
  if (!owner || !repo || !numberStr) return new Response('not found', { status: 404 });
  const prNumber = Number.parseInt(numberStr, 10);
  if (!Number.isFinite(prNumber) || prNumber <= 0) {
    return new Response(null, {
      status: 302,
      headers: { location: `/?bad=${encodeURIComponent(`${owner}/${repo}#${numberStr}`)}&reason=invalid_input` },
    });
  }
  const strict = c.req.query('strict') === '1' || c.req.query('strict') === 'true';
  const includePrereleases =
    c.req.query('prereleases') === '1' || c.req.query('prereleases') === 'true';

  const nonce = makeNonce();
  const pubBase = publicBaseUrl(env, req);
  const ogBase = ogBaseUrl(env, req);
  const isBot = isUnfurlBot(req);

  // Cache by PR number — different lookups for default vs strict.
  const k = await cacheKey(
    'res',
    `${owner}/${repo}`,
    `pr#${prNumber}`,
    strict ? 'strict' : 'cull',
    includePrereleases ? 'pre' : 'nopre',
  );
  const cache = makeWorkerCache(req);
  let result: LookupResult | null = await cache.get<LookupResult>(k);

  if (!result && isBot) {
    return renderDeferred({ pubBase, ogBase, nonce, owner, repo, numberStr });
  }

  if (!result) {
    const token = resolveToken(env, req);
    const client = makeGithubClient({ token });
    try {
      result = await singleFlight(k, async () => {
        const re = await cache.get<LookupResult>(k);
        if (re) return re;
        const r = await findRelease(
          { kind: 'pr', repo: { owner, repo }, number: prNumber },
          { client, strict, includePrereleases },
        );
        await cache.put(k, r, r.partial ? 60 : 30 * 60);
        return r;
      });
    } catch (err) {
      if (isBot) return renderDeferred({ pubBase, ogBase, nonce, owner, repo, numberStr });
      if (err instanceof PrNotMergedError) {
        return renderPrNotMerged(err, { pubBase, ogBase, nonce, owner, repo, prNumber });
      }
      if (err instanceof PrNotFoundError || err instanceof PrMergeCommitUnavailableError) {
        return renderPrError(err, { pubBase, ogBase, nonce, owner, repo, prNumber });
      }
      if (err instanceof NotYetReleasedError) {
        return renderPrNotYetReleased(err, {
          pubBase,
          ogBase,
          nonce,
          owner,
          repo,
          prNumber,
          strict,
        });
      }
      return renderPrError(err, { pubBase, ogBase, nonce, owner, repo, prNumber });
    }
  }

  // Successful result. The merge commit's full SHA is in canonicalSha.
  const inlineData = JSON.stringify(result).replace(/</g, '\\u003c');
  const perma = `${pubBase}/p/${owner}/${repo}/${prNumber}`;
  const inputVal = `${owner}/${repo}#${prNumber}`;

  const page = (
    <Layout
      title={`${result.firstRelease ? result.firstRelease.tag : 'not yet released'} — ${owner}/${repo}#${prNumber}`}
      nonce={nonce}
      ogBaseUrl={ogBase}
      publicUrl={perma}
      ogResult={result}
    >
      <Nav />
      <div style="padding-top: 22px;">
        <form method="get" action="/lookup" data-loading-form>
          <div class="searchbox">
            <input name="q" type="text" value={inputVal} spellcheck={false} />
            <button type="submit">
              <span class="btn-label">Is it released? →</span>
              <span class="btn-loading" aria-hidden="true">
                Looking up<span class="dots" />
              </span>
            </button>
          </div>
        </form>
      </div>
      <main style="padding-top: 24px;">
        <PrBanner owner={owner} repo={repo} prNumber={prNumber} mergeSha={result.canonicalSha} />
        <ResultCard result={result} publicBaseUrl={pubBase} />
      </main>
      <script nonce={nonce}>{raw(`window.__RELEASED_RESULT__ = ${inlineData};`)}</script>
      <footer>
        <a href="/how-it-works">how it works</a>
        <a href="https://www.npmjs.com/package/released">CLI</a>
        <a href="https://github.com/lukaso/released">GitHub</a>
      </footer>
    </Layout>
  );

  return new Response(`<!DOCTYPE html>${page.toString()}`, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300',
      ...securityHeaders(nonce, ogBase),
    },
  });
}

// --- partial / error renderers ----------------------------------------------

function PrBanner({
  owner,
  repo,
  prNumber,
  mergeSha,
}: {
  owner: string;
  repo: string;
  prNumber: number;
  mergeSha: string;
}) {
  const prUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}`;
  const commitUrl = `https://github.com/${owner}/${repo}/commit/${mergeSha}`;
  return (
    <div
      style="margin-bottom: 16px; padding: 12px 16px; background: var(--bg-raised); border: 1px solid var(--border); border-radius: 8px; font-size: 13.5px; color: var(--text-2);"
    >
      Resolved <a href={prUrl}>PR #{prNumber}</a> → merge commit{' '}
      <a href={commitUrl} style="font-family: 'Geist Mono', monospace;">
        {mergeSha.slice(0, 7)}
      </a>
    </div>
  );
}

function renderDeferred(args: {
  pubBase: string;
  ogBase: string;
  nonce: string;
  owner: string;
  repo: string;
  numberStr: string;
}): Response {
  const { pubBase, ogBase, nonce, owner, repo, numberStr } = args;
  const page = (
    <Layout
      title={`looking up — ${owner}/${repo}#${numberStr}`}
      nonce={nonce}
      ogBaseUrl={ogBase}
      publicUrl={`${pubBase}/p/${owner}/${repo}/${numberStr}`}
      ogFallbackTitle={`released — looking up ${owner}/${repo}#${numberStr}`}
    >
      <Nav />
      <main>
        <div class="answer example">
          <div class="answer-hero">
            <div class="answer-label">Looking up…</div>
            <div class="answer-version">
              <span class="v" style="font-size: 32px;">
                {owner}/{repo}#{numberStr}
              </span>
            </div>
            <div class="answer-date">Refresh in a moment for the answer.</div>
          </div>
        </div>
      </main>
    </Layout>
  );
  return new Response(`<!DOCTYPE html>${page.toString()}`, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=60',
      ...securityHeaders(nonce, ogBase),
    },
  });
}

function renderPrNotMerged(
  err: PrNotMergedError,
  args: {
    pubBase: string;
    ogBase: string;
    nonce: string;
    owner: string;
    repo: string;
    prNumber: number;
  },
): Response {
  const { pubBase, ogBase, nonce, owner, repo, prNumber } = args;
  const prUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}`;
  const page = (
    <Layout
      title={`PR not merged — ${owner}/${repo}#${prNumber}`}
      nonce={nonce}
      ogBaseUrl={ogBase}
      publicUrl={`${pubBase}/p/${owner}/${repo}/${prNumber}`}
      ogFallbackTitle={`released — ${owner}/${repo}#${prNumber}: not merged yet`}
    >
      <Nav />
      <main style="padding-top: 24px;">
        <div class="answer">
          <div class="answer-hero">
            <div class="answer-label">Status</div>
            <div class="answer-version">
              <span class="v" style="font-size: 32px; color: var(--warn);">
                Not merged yet
              </span>
            </div>
            <div class="answer-date">
              <b>
                <a href={prUrl}>
                  {owner}/{repo}#{prNumber}
                </a>
              </b>{' '}
              hasn't been merged. Re-check after it lands.
            </div>
            <div class="answer-actions" style="margin-top: 16px;">
              <a class="btn-fmt primary" href={prUrl} style="text-decoration: none;">
                Open PR on GitHub
              </a>
            </div>
          </div>
        </div>
      </main>
    </Layout>
  );
  return new Response(`<!DOCTYPE html>${page.toString()}`, {
    // 200 — "not merged yet" is a real answer, not a server error.
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Short cache: PR could merge at any moment, don't lock in "not merged".
      'cache-control': 'public, max-age=60',
      ...securityHeaders(nonce, ogBase),
    },
  });
}

function renderPrNotYetReleased(
  err: NotYetReleasedError,
  args: {
    pubBase: string;
    ogBase: string;
    nonce: string;
    owner: string;
    repo: string;
    prNumber: number;
    strict: boolean;
  },
): Response {
  const { pubBase, ogBase, nonce, owner, repo, prNumber, strict } = args;
  const perma = `${pubBase}/p/${owner}/${repo}/${prNumber}`;
  const strictHref = `${perma}?strict=1`;
  const showHint = err.culledTagCount > 0 && !strict;
  const synthetic: LookupResult = {
    input: { kind: 'pr', repo: { owner, repo }, number: prNumber },
    canonicalSha: err.sha,
    firstRelease: null,
    alsoIn: [],
    releaseNotesHtml: null,
    rateLimit: null,
  };
  const prUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}`;
  const mergeUrl = `https://github.com/${owner}/${repo}/commit/${err.sha}`;
  const page = (
    <Layout
      title={`not yet released — ${owner}/${repo}#${prNumber}`}
      nonce={nonce}
      ogBaseUrl={ogBase}
      publicUrl={perma}
      ogFallbackTitle={`released — ${owner}/${repo}#${prNumber}: merged, not released yet`}
    >
      <Nav />
      <main style="padding-top: 24px;">
        <div
          style="margin-bottom: 16px; padding: 12px 16px; background: var(--bg-raised); border: 1px solid var(--border); border-radius: 8px; font-size: 13.5px; color: var(--text-2);"
        >
          Resolved <a href={prUrl}>PR #{prNumber}</a> → merge commit{' '}
          <a href={mergeUrl} style="font-family: 'Geist Mono', monospace;">
            {err.sha.slice(0, 7)}
          </a>
        </div>
        {showHint && <StrictHint culled={err.culledTagCount} retryHref={strictHref} />}
        <ResultCard result={synthetic} publicBaseUrl={pubBase} />
      </main>
    </Layout>
  );
  return new Response(`<!DOCTYPE html>${page.toString()}`, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300',
      ...securityHeaders(nonce, ogBase),
    },
  });
}

function renderPrError(
  err: unknown,
  args: {
    pubBase: string;
    ogBase: string;
    nonce: string;
    owner: string;
    repo: string;
    prNumber: number;
  },
): Response {
  const { pubBase, ogBase, nonce, owner, repo, prNumber } = args;
  const msg = err instanceof ReleasedError ? err.message : 'Something went wrong.';
  const status = err instanceof ReleasedError ? 404 : 500;
  const page = (
    <Layout
      title="released — error"
      nonce={nonce}
      ogBaseUrl={ogBase}
      publicUrl={`${pubBase}/p/${owner}/${repo}/${prNumber}`}
      ogFallbackTitle="released"
    >
      <Nav />
      <main>
        <div class="answer">
          <div class="answer-hero">
            <div class="answer-label">Error</div>
            <div class="answer-date">{msg}</div>
            <div class="answer-actions">
              <a class="btn-fmt primary" href="/" style="text-decoration: none;">
                Start over
              </a>
            </div>
          </div>
        </div>
      </main>
    </Layout>
  );
  return new Response(`<!DOCTYPE html>${page.toString()}`, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      ...securityHeaders(nonce, ogBase),
    },
  });
}

function Nav() {
  return (
    <nav>
      <a href="/" class="wordmark" style="text-decoration: none; color: inherit;">
        <span class="dot" />
        released
      </a>
      <div class="nav-links">
        <a href="/how-it-works">Docs</a>
        <a href="https://www.npmjs.com/package/released">CLI</a>
        <a href="https://github.com/lukaso/released">GitHub</a>
      </div>
    </nav>
  );
}
