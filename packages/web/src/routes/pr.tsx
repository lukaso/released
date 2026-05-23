// GET /p/:owner/:repo/:number          — PR permalink (GitHub)
// GET /h/:host/p/:projectPath/:number  — PR/MR permalink (federated)
//
// Resolves the PR/MR to its merge commit, then renders the same result UI as /r/.
// Label and reference syntax come from provider.terms so GitLab shows "Merge
// request !1234" instead of "Pull request #1234".

import {
  type LookupResult,
  NotYetReleasedError,
  PrMergeCommitUnavailableError,
  PrNotFoundError,
  PrNotMergedError,
  type Provider,
  ReleasedError,
  type RepoRef,
  cacheKey,
  findRelease,
  providerFor,
} from '@released/core';
import type { Context } from 'hono';
import { raw } from 'hono/html';
import { extraGitlabHostsFromEnv, isUnfurlBot, resolveProviderToken } from '../auth.js';
import { makeWorkerCache } from '../cache.js';
import { type Env, ogBaseUrl, publicBaseUrl } from '../env.js';
import { prPermalinkPath } from '../paths.js';
import { makeNonce, securityHeaders } from '../security.js';
import { singleFlight } from '../single-flight.js';
import { Layout } from '../ui/layout.js';
import { ResultCard, StrictHint } from '../ui/result-card.js';

function repoFromParams(c: Context): RepoRef | null {
  const host = c.req.param('host');
  if (host) {
    const projectPathEnc = c.req.param('projectPath');
    if (!projectPathEnc) return null;
    return { host, projectPath: decodeURIComponent(projectPathEnc) };
  }
  const owner = c.req.param('owner');
  const repo = c.req.param('repo');
  if (!owner || !repo) return null;
  return { host: 'github.com', projectPath: `${owner}/${repo}` };
}

export async function prRoute(c: Context): Promise<Response> {
  const env = c.env as Env;
  const req = c.req.raw;
  const repo = repoFromParams(c);
  const numberStr = c.req.param('number');
  if (!repo || !numberStr) return new Response('not found', { status: 404 });
  const prNumber = Number.parseInt(numberStr, 10);
  if (!Number.isFinite(prNumber) || prNumber <= 0) {
    return new Response(null, {
      status: 302,
      headers: {
        location: `/?bad=${encodeURIComponent(`${repo.projectPath}#${numberStr}`)}&reason=invalid_input`,
      },
    });
  }
  const strict = c.req.query('strict') === '1' || c.req.query('strict') === 'true';
  const includePrereleases =
    c.req.query('prereleases') === '1' || c.req.query('prereleases') === 'true';

  const nonce = makeNonce();
  const pubBase = publicBaseUrl(env, req);
  const ogBase = ogBaseUrl(env, req);
  const isBot = isUnfurlBot(req);
  const extraGitlabHosts = extraGitlabHostsFromEnv(env);

  let provider: Provider;
  try {
    const token = resolveProviderToken(env, req, repo.host);
    provider = providerFor(repo.host, { token, extraGitlabHosts });
  } catch (err) {
    return renderPrError(err, { pubBase, ogBase, nonce, repo, prNumber });
  }

  // Cache by PR number — different lookups for default vs strict.
  const k = await cacheKey(
    'res',
    `${repo.host}/${repo.projectPath}`,
    `pr#${prNumber}`,
    strict ? 'strict' : 'cull',
    includePrereleases ? 'pre' : 'nopre',
  );
  const cache = makeWorkerCache(req);
  let result: LookupResult | null = await cache.get<LookupResult>(k);

  if (!result && isBot) {
    return renderDeferred({ pubBase, ogBase, nonce, repo, numberStr, provider });
  }

  if (!result) {
    try {
      result = await singleFlight(k, async () => {
        const re = await cache.get<LookupResult>(k);
        if (re) return re;
        const r = await findRelease(
          { kind: 'pr', repo, number: prNumber },
          { client: provider, strict, includePrereleases },
        );
        await cache.put(k, r, r.partial ? 60 : 30 * 60);
        return r;
      });
    } catch (err) {
      if (isBot) return renderDeferred({ pubBase, ogBase, nonce, repo, numberStr, provider });
      if (err instanceof PrNotMergedError) {
        return renderPrNotMerged(err, { pubBase, ogBase, nonce, repo, prNumber, provider });
      }
      if (err instanceof PrNotFoundError || err instanceof PrMergeCommitUnavailableError) {
        return renderPrError(err, { pubBase, ogBase, nonce, repo, prNumber });
      }
      if (err instanceof NotYetReleasedError) {
        return renderPrNotYetReleased(err, {
          pubBase,
          ogBase,
          nonce,
          repo,
          prNumber,
          strict,
          provider,
        });
      }
      return renderPrError(err, { pubBase, ogBase, nonce, repo, prNumber });
    }
  }

  // Successful result. The merge commit's full SHA is in canonicalSha.
  const inlineData = JSON.stringify(result).replace(/</g, '\\u003c');
  const permalink = `${pubBase}${prPermalinkPath(repo, prNumber)}`;
  // Form pre-fill needs to round-trip through parseInput. GitHub's
  // `owner/repo#PR` shorthand is GitHub-only — using it on a GitLab MR would
  // make the next submit hit github.com/o/r/pull/N (PR not found). For non-
  // GitHub providers we pre-fill the full provider URL, which parseInput
  // always re-routes correctly.
  const inputVal =
    repo.host === 'github.com'
      ? `${repo.projectPath}#${prNumber}`
      : provider.urls.pullRequest(repo, prNumber);
  const displayName = repo.projectPath;
  const prefix = provider.terms.mergeRequestPrefix;

  const page = (
    <Layout
      title={`${result.firstRelease ? result.firstRelease.tag : 'not yet released'} — ${displayName}${prefix}${prNumber}`}
      nonce={nonce}
      ogBaseUrl={ogBase}
      publicUrl={permalink}
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
                Looking up
                <span class="dots" />
              </span>
            </button>
          </div>
        </form>
      </div>
      <main style="padding-top: 24px;">
        <PrBanner
          provider={provider}
          repo={repo}
          prNumber={prNumber}
          mergeSha={result.canonicalSha}
        />
        <ResultCard result={result} publicBaseUrl={pubBase} />
      </main>
      <script nonce={nonce}>{raw(`window.__RELEASED_RESULT__ = ${inlineData};`)}</script>
      <footer>
        <a href="/how-it-works">how it works</a>
        <a href="https://www.npmjs.com/package/git-released">CLI</a>
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
  provider,
  repo,
  prNumber,
  mergeSha,
}: {
  provider: Provider;
  repo: RepoRef;
  prNumber: number;
  mergeSha: string;
}) {
  const prUrl = provider.urls.pullRequest(repo, prNumber);
  const commitUrl = provider.urls.commit(repo, mergeSha);
  const label = provider.terms.mergeRequest;
  const prefix = provider.terms.mergeRequestPrefix;
  return (
    <div class="pr-banner">
      Resolved{' '}
      <a href={prUrl}>
        {label} {prefix}
        {prNumber}
      </a>{' '}
      → merge commit{' '}
      <a href={commitUrl} class="sha">
        {mergeSha.slice(0, 7)}
      </a>
    </div>
  );
}

function renderDeferred(args: {
  pubBase: string;
  ogBase: string;
  nonce: string;
  repo: RepoRef;
  numberStr: string;
  provider: Provider;
}): Response {
  const { pubBase, ogBase, nonce, repo, numberStr, provider } = args;
  const displayName = repo.projectPath;
  const prefix = provider.terms.mergeRequestPrefix;
  const permalink = `${pubBase}${prPermalinkPath(repo, Number.parseInt(numberStr, 10))}`;
  const page = (
    <Layout
      title={`looking up — ${displayName}${prefix}${numberStr}`}
      nonce={nonce}
      ogBaseUrl={ogBase}
      publicUrl={permalink}
      ogFallbackTitle={`released — looking up ${displayName}${prefix}${numberStr}`}
    >
      <Nav />
      <main>
        <div class="answer example">
          <div class="answer-hero">
            <div class="answer-label">Looking up…</div>
            <div class="answer-version">
              <span class="v" style="font-size: 32px;">
                {displayName}
                {prefix}
                {numberStr}
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
    repo: RepoRef;
    prNumber: number;
    provider: Provider;
  },
): Response {
  const { pubBase, ogBase, nonce, repo, prNumber, provider } = args;
  const displayName = repo.projectPath;
  const prUrl = provider.urls.pullRequest(repo, prNumber);
  const label = provider.terms.mergeRequest;
  const prefix = provider.terms.mergeRequestPrefix;
  const permalink = `${pubBase}${prPermalinkPath(repo, prNumber)}`;
  const linkLabel =
    repo.host === 'github.com'
      ? 'Open PR on GitHub'
      : `Open ${label.toLowerCase()} on ${repo.host}`;
  const page = (
    <Layout
      title={`${label} not merged — ${displayName}${prefix}${prNumber}`}
      nonce={nonce}
      ogBaseUrl={ogBase}
      publicUrl={permalink}
      ogFallbackTitle={`released — ${displayName}${prefix}${prNumber}: not merged yet`}
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
                  {displayName}
                  {prefix}
                  {prNumber}
                </a>
              </b>{' '}
              hasn't been merged. Re-check after it lands.
            </div>
            <div class="answer-actions" style="margin-top: 16px;">
              <a class="btn-fmt primary" href={prUrl} style="text-decoration: none;">
                {linkLabel}
              </a>
            </div>
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

function renderPrNotYetReleased(
  err: NotYetReleasedError,
  args: {
    pubBase: string;
    ogBase: string;
    nonce: string;
    repo: RepoRef;
    prNumber: number;
    strict: boolean;
    provider: Provider;
  },
): Response {
  const { pubBase, ogBase, nonce, repo, prNumber, strict, provider } = args;
  const displayName = repo.projectPath;
  const prefix = provider.terms.mergeRequestPrefix;
  const permalink = `${pubBase}${prPermalinkPath(repo, prNumber)}`;
  const strictHref = `${permalink}?strict=1`;
  const showHint = err.culledTagCount > 0 && !strict;
  const synthetic: LookupResult = {
    input: { kind: 'pr', repo, number: prNumber },
    canonicalSha: err.sha,
    subject: err.subject,
    firstRelease: null,
    alsoIn: [],
    releaseNotesHtml: null,
    rateLimit: null,
    urls: {
      repo: provider.urls.repo(repo),
      commit: provider.urls.commit(repo, err.sha),
      pullRequest: provider.urls.pullRequest(repo, prNumber),
    },
  };
  const inlineData = JSON.stringify(synthetic).replace(/</g, '\\u003c');
  const page = (
    <Layout
      title={`not yet released — ${displayName}${prefix}${prNumber}`}
      nonce={nonce}
      ogBaseUrl={ogBase}
      publicUrl={permalink}
      ogFallbackTitle={`released — ${displayName}${prefix}${prNumber}: merged, not released yet`}
    >
      <Nav />
      <main style="padding-top: 24px;">
        <PrBanner provider={provider} repo={repo} prNumber={prNumber} mergeSha={err.sha} />
        <ResultCard result={synthetic} publicBaseUrl={pubBase} />
        {showHint && <StrictHint culled={err.culledTagCount} retryHref={strictHref} />}
      </main>
      <script nonce={nonce}>{raw(`window.__RELEASED_RESULT__ = ${inlineData};`)}</script>
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
    repo: RepoRef;
    prNumber: number;
  },
): Response {
  const { pubBase, ogBase, nonce, repo, prNumber } = args;
  const msg = err instanceof ReleasedError ? err.message : 'Something went wrong.';
  const status = err instanceof ReleasedError ? 404 : 500;
  const permalink = `${pubBase}${prPermalinkPath(repo, prNumber)}`;
  const page = (
    <Layout
      title="released — error"
      nonce={nonce}
      ogBaseUrl={ogBase}
      publicUrl={permalink}
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
        <a href="https://www.npmjs.com/package/git-released">CLI</a>
        <a href="https://github.com/lukaso/released">GitHub</a>
      </div>
    </nav>
  );
}
