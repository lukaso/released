// GET /p/:owner/:repo/:number          — PR permalink (GitHub)
// GET /h/:host/p/:projectPath/:number  — PR/MR permalink (federated)
//
// Resolves the PR/MR to its merge commit, then renders the same result UI as /r/.
// Label and reference syntax come from provider.terms so GitLab shows "Merge
// request !1234" instead of "Pull request #1234".

import {
  type LookupResult,
  type NotYetReleasedError,
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
import { setTrack, upstreamStatusOf } from '../analytics.js';
import { extraGitlabHostsFromEnv, isUnfurlBot, resolveProviderToken } from '../auth.js';
import { makeWorkerCache } from '../cache.js';
import { type Env, ogBaseUrl, publicBaseUrl } from '../env.js';
import { prPermalinkPath } from '../paths.js';
import { resolveLookup } from '../resolve.js';
import { makeNonce, securityHeaders } from '../security.js';
import { Layout } from '../ui/layout.js';
import { CopyActions, ResultCard, StaleNotice, StrictHint } from '../ui/result-card.js';

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
  setTrack(req, { host: repo.host, repo: repo.projectPath, kind: 'pr' });
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
    setTrack(req, {
      outcome: 'error',
      errorType: (err as Error)?.name,
      upstreamStatus: upstreamStatusOf(err),
    });
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

  // Unfurl bots never trigger a compute: serve a cached answer (stale is fine)
  // or a short-lived deferred card so they re-fetch.
  let result: LookupResult;
  let stale = false;
  let staleAsOf: number | null = null;
  if (isBot) {
    const cached = await cache.get<LookupResult>(k);
    if (!cached) return renderDeferred({ pubBase, ogBase, nonce, repo, numberStr, provider });
    setTrack(req, { cache: 'hit' });
    result = cached;
  } else {
    const resolved = await resolveLookup({
      cache,
      key: k,
      load: () =>
        findRelease(
          { kind: 'pr', repo, number: prNumber },
          { client: provider, strict, includePrereleases },
        ),
    });
    if (resolved.status === 'not_yet') {
      setTrack(req, { cache: 'miss', outcome: 'not_yet' });
      return renderPrNotYetReleased(resolved.error, {
        pubBase,
        ogBase,
        nonce,
        repo,
        prNumber,
        strict,
        provider,
      });
    }
    if (resolved.status === 'transient') {
      // Upstream unreachable with nothing cached — offer a retry on this exact
      // MR rather than a dead-end error.
      setTrack(req, {
        cache: 'miss',
        outcome: 'error',
        errorType: resolved.kind,
        upstreamStatus: resolved.upstreamStatus,
      });
      // Anubis blocks workerd specifically; "Try again" never works. See
      // renderPrAnubis for why and what we show instead.
      if (resolved.anubis) {
        return renderPrAnubis({ pubBase, ogBase, nonce, repo, prNumber, provider });
      }
      return renderPrTransient({ pubBase, ogBase, nonce, repo, prNumber, provider });
    }
    if (resolved.status === 'error') {
      const err = resolved.error;
      setTrack(req, {
        cache: 'miss',
        outcome: 'error',
        errorType: (err as Error)?.name,
        upstreamStatus: upstreamStatusOf(err),
      });
      if (err instanceof PrNotMergedError) {
        return renderPrNotMerged(err, { pubBase, ogBase, nonce, repo, prNumber, provider });
      }
      return renderPrError(err, { pubBase, ogBase, nonce, repo, prNumber });
    }
    setTrack(req, { cache: resolved.cached ? 'hit' : 'miss' });
    result = resolved.result;
    stale = resolved.stale;
    staleAsOf = resolved.staleAsOf;
  }

  // Successful result. The merge commit's full SHA is in canonicalSha.
  setTrack(req, {
    outcome: result.partial ? 'partial' : result.firstRelease ? 'released' : 'not_yet',
  });
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
        {stale && <StaleNotice asOf={staleAsOf} host={repo.host} />}
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
  // Open PRs are the most valuable place to embed a badge: the user can paste
  // the markdown into the PR description now, and the badge auto-flips
  // "not yet" → version-tag as the PR merges and ships. Closed-without-merging
  // PRs never flip, so suppress the copy actions for them.
  const isOpen = err.prState === 'open';
  const synthetic: LookupResult | null = isOpen
    ? {
        input: { kind: 'pr', repo, number: prNumber },
        // No merge commit yet — empty string. Client JS guards on this.
        canonicalSha: '',
        subject: null,
        firstRelease: null,
        alsoIn: [],
        releaseNotesHtml: null,
        rateLimit: null,
        urls: { repo: provider.urls.repo(repo), commit: '', pullRequest: prUrl },
      }
    : null;
  const inlineData = synthetic ? JSON.stringify(synthetic).replace(/</g, '\\u003c') : null;
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
            {synthetic && (
              <CopyActions
                perma={permalink}
                hint="Paste the badge into your PR/MR description now — it flips from “not yet” to the version automatically once this merges and ships."
              />
            )}
          </div>
        </div>
      </main>
      {inlineData && (
        <script nonce={nonce}>{raw(`window.__RELEASED_RESULT__ = ${inlineData};`)}</script>
      )}
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
  const permalinkPath = prPermalinkPath(repo, prNumber);
  const permalink = `${pubBase}${permalinkPath}`;
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
            <div class="answer-actions" style="margin-top: 16px;">
              {/* Try again re-runs THIS lookup; Start over goes home. */}
              <a class="btn-fmt primary" href={permalinkPath} style="text-decoration: none;">
                Try again
              </a>
              <a class="btn-fmt" href="/" style="text-decoration: none;">
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

/** Anubis-blocked host on a PR/MR lookup. See renderAnubis in result.tsx for
 *  the rationale — same UX, federation-aware label ("Merge request !N"). */
function renderPrAnubis(args: {
  pubBase: string;
  ogBase: string;
  nonce: string;
  repo: RepoRef;
  prNumber: number;
  provider: Provider;
}): Response {
  const { pubBase, ogBase, nonce, repo, prNumber, provider } = args;
  const upstreamUrl = provider.urls.pullRequest(repo, prNumber);
  const label = provider.terms.mergeRequest;
  const prefix = provider.terms.mergeRequestPrefix;
  const cliCmd = `npx git-released ${upstreamUrl}`;
  const permalinkPath = prPermalinkPath(repo, prNumber);
  const page = (
    <Layout
      title={`${repo.host} needs the CLI — ${repo.projectPath}${prefix}${prNumber}`}
      nonce={nonce}
      ogBaseUrl={ogBase}
      publicUrl={`${pubBase}${permalinkPath}`}
      ogFallbackTitle={`released — ${repo.host} blocks server-to-server lookups (Anubis)`}
    >
      <Nav />
      <main>
        <div class="answer">
          <div class="answer-hero">
            <div class="answer-label">Use the CLI for this host</div>
            <div class="answer-version">
              <span class="v" style="font-size: 28px; color: var(--warn);">
                {repo.host} blocks the web app
              </span>
            </div>
            <div class="answer-date">
              <b>{repo.host}</b> sits behind <a href="https://anubis.techaro.lol/">Anubis</a>, a
              proof-of-work anti-bot system that fingerprints HTTP traffic from cloud providers. The
              web app can't get through. The CLI can — Node's fetch has a different TLS fingerprint
              that isn't challenged.
            </div>
            <div style="margin-top: 14px; padding: 12px 14px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; font-family: 'Geist Mono', monospace; font-size: 13px; color: var(--text); word-break: break-all;">
              {cliCmd}
            </div>
            <div class="answer-actions" style="margin-top: 16px;">
              <a class="btn-fmt primary" href={upstreamUrl} style="text-decoration: none;">
                Open {label.toLowerCase()} on {repo.host}
              </a>
              <a class="btn-fmt" href="/" style="text-decoration: none;">
                Start over
              </a>
            </div>
          </div>
        </div>
      </main>
    </Layout>
  );
  return new Response(`<!DOCTYPE html>${page.toString()}`, {
    status: 503,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=60',
      'retry-after': '60',
      ...securityHeaders(nonce, ogBase),
    },
  });
}

/** Upstream is unreachable and we have nothing cached. This is transient, so the
 *  page is honest about it and keeps the user's lookup: "Try again" reloads the
 *  same permalink (which re-checks once the host is back). Short cache + 503 so
 *  proxies and the browser don't pin this state. */
function renderPrTransient(args: {
  pubBase: string;
  ogBase: string;
  nonce: string;
  repo: RepoRef;
  prNumber: number;
  provider: Provider;
}): Response {
  const { pubBase, ogBase, nonce, repo, prNumber, provider } = args;
  const displayName = repo.projectPath;
  const prefix = provider.terms.mergeRequestPrefix;
  const permalinkPath = prPermalinkPath(repo, prNumber);
  const permalink = `${pubBase}${permalinkPath}`;
  const page = (
    <Layout
      title={`temporarily unavailable — ${displayName}${prefix}${prNumber}`}
      nonce={nonce}
      ogBaseUrl={ogBase}
      publicUrl={permalink}
      ogFallbackTitle={`released — ${repo.host} is temporarily unreachable`}
    >
      <Nav />
      <main>
        <div class="answer">
          <div class="answer-hero">
            <div class="answer-label">Status</div>
            <div class="answer-version">
              <span class="v" style="font-size: 32px; color: var(--warn);">
                Can’t reach {repo.host}
              </span>
            </div>
            <div class="answer-date">
              <b>{repo.host}</b> isn’t responding right now (it returned a temporary error). This is
              almost always a brief upstream blip — your lookup hasn’t gone anywhere.
            </div>
            <div class="answer-actions" style="margin-top: 16px;">
              <a class="btn-fmt primary" href={permalinkPath} style="text-decoration: none;">
                Try again
              </a>
              <a class="btn-fmt" href="/" style="text-decoration: none;">
                Start over
              </a>
            </div>
          </div>
        </div>
      </main>
    </Layout>
  );
  return new Response(`<!DOCTYPE html>${page.toString()}`, {
    status: 503,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=60',
      'retry-after': '60',
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
