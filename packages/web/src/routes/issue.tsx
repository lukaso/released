// GET /i/:owner/:repo/:number          — issue permalink (GitHub)
// GET /h/:host/i/:projectPath/:number  — issue permalink (federated)
//
// Resolves an issue to the commit(s) that closed it, then runs the same
// commit→release pipeline as /r/ and /p/ and renders the same result UI.
// Issues add two calm, non-error states the PR path doesn't have:
//   - still OPEN          → there's no fix to track to a release yet.
//   - CLOSED without fix  → closed manually / not-planned, no discoverable
//                           commit or merged PR/MR. COMMON in practice (#54).
// Both render like the not-yet card (calm), NOT the not-released/error UI, and
// short-cache so a later fix can still flip the answer.
//
// Issue results omit the badge/share actions for now: a badge needs its own
// `/i/.../badge.svg` route (the PR badge route keys off the `:number` param and
// would mis-resolve an issue as a PR), so badges land in a follow-up (#54 PR2b).

import {
  IssueClosedWithoutFixError,
  IssueNotClosedError,
  type LookupResult,
  type NotYetReleasedError,
  type Provider,
  ReleasedError,
  type RepoRef,
  cacheKey,
  findRelease,
} from '@released/core';
import type { Context } from 'hono';
import { raw } from 'hono/html';
import type { Child } from 'hono/jsx';
import { setTrack, upstreamStatusOf } from '../analytics.js';
import { isUnfurlBot } from '../auth.js';
import { makeWorkerCache } from '../cache.js';
import { type Env, ogBaseUrl, publicBaseUrl } from '../env.js';
import { issuePermalinkPath } from '../paths.js';
import { makeProvider } from '../provider.js';
import { resolveLookup } from '../resolve.js';
import { makeNonce, securityHeaders } from '../security.js';
import { Layout } from '../ui/layout.js';
import { ResultCard, StaleNotice } from '../ui/result-card.js';

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

export async function issueRoute(c: Context): Promise<Response> {
  const env = c.env as Env;
  const req = c.req.raw;
  const repo = repoFromParams(c);
  const numberStr = c.req.param('number');
  if (!repo || !numberStr) return new Response('not found', { status: 404 });
  setTrack(req, { host: repo.host, repo: repo.projectPath, kind: 'issue' });
  const issueNumber = Number.parseInt(numberStr, 10);
  if (!Number.isFinite(issueNumber) || issueNumber <= 0) {
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

  let provider: Provider;
  try {
    provider = makeProvider(env, req, repo.host);
  } catch (err) {
    setTrack(req, {
      outcome: 'error',
      errorType: (err as Error)?.name,
      upstreamStatus: upstreamStatusOf(err),
    });
    return renderIssueError(err, { pubBase, ogBase, nonce, repo, issueNumber });
  }

  const k = await cacheKey(
    'res',
    `${repo.host}/${repo.projectPath}`,
    `issue#${issueNumber}`,
    strict ? 'strict' : 'cull',
    includePrereleases ? 'pre' : 'nopre',
  );
  const cache = makeWorkerCache(req);

  let result: LookupResult;
  let stale = false;
  let staleAsOf: number | null = null;
  if (isBot) {
    const cached = await cache.get<LookupResult>(k);
    if (!cached) return renderDeferred({ pubBase, ogBase, nonce, repo, numberStr });
    setTrack(req, { cache: 'hit' });
    result = cached;
  } else {
    const resolved = await resolveLookup({
      cache,
      key: k,
      load: () =>
        findRelease(
          { kind: 'issue', repo, number: issueNumber },
          { client: provider, strict, includePrereleases },
        ),
    });
    if (resolved.status === 'not_yet') {
      setTrack(req, { cache: 'miss', outcome: 'not_yet' });
      return renderIssueNotYetReleased(resolved.error, {
        pubBase,
        ogBase,
        nonce,
        repo,
        issueNumber,
        provider,
      });
    }
    if (resolved.status === 'transient') {
      setTrack(req, {
        cache: 'miss',
        outcome: 'error',
        errorType: resolved.kind,
        upstreamStatus: resolved.upstreamStatus,
      });
      return renderIssueTransient({
        pubBase,
        ogBase,
        nonce,
        repo,
        issueNumber,
        anubis: resolved.anubis,
      });
    }
    if (resolved.status === 'error') {
      const err = resolved.error;
      const calm = err instanceof IssueNotClosedError || err instanceof IssueClosedWithoutFixError;
      setTrack(req, {
        cache: 'miss',
        // The two issue calm-states are normal answers, not failures (mirrors
        // how a not-yet PR is outcome=not_yet, not outcome=error).
        outcome: calm ? 'not_yet' : 'error',
        errorType: (err as Error)?.name,
        upstreamStatus: upstreamStatusOf(err),
      });
      if (err instanceof IssueNotClosedError) {
        return renderIssueOpen({ pubBase, ogBase, nonce, repo, issueNumber, provider });
      }
      if (err instanceof IssueClosedWithoutFixError) {
        return renderIssueClosedWithoutFix(err, {
          pubBase,
          ogBase,
          nonce,
          repo,
          issueNumber,
          provider,
        });
      }
      return renderIssueError(err, { pubBase, ogBase, nonce, repo, issueNumber });
    }
    setTrack(req, { cache: resolved.cached ? 'hit' : 'miss' });
    result = resolved.result;
    stale = resolved.stale;
    staleAsOf = resolved.staleAsOf;
  }

  setTrack(req, {
    outcome: result.partial ? 'partial' : result.firstRelease ? 'released' : 'not_yet',
  });
  const inlineData = JSON.stringify(result).replace(/</g, '\\u003c');
  const permalink = `${pubBase}${issuePermalinkPath(repo, issueNumber)}`;
  const displayName = repo.projectPath;
  // Pre-fill the full issue URL: it round-trips through parseInput on resubmit
  // for both GitHub and GitLab (the bare `#N` shorthand would resolve to a PR).
  const inputVal = provider.urls.issue(repo, issueNumber);

  const page = (
    <Layout
      title={`${result.firstRelease ? result.firstRelease.tag : 'not yet released'} — ${displayName}#${issueNumber}`}
      nonce={nonce}
      ogBaseUrl={ogBase}
      publicUrl={permalink}
      ogFallbackTitle={`released — ${displayName}#${issueNumber}${
        result.firstRelease ? `: fixed in ${result.firstRelease.tag}` : ''
      }`}
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
        <IssueBanner
          provider={provider}
          repo={repo}
          issueNumber={issueNumber}
          fixSha={result.canonicalSha}
        />
        <ResultCard result={result} publicBaseUrl={pubBase} hideShare />
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
      // Even a released issue answer keeps the short cache: the closing-commit
      // resolution can change (a reopened issue, a new closer), so we don't pin
      // it as long as a commit permalink.
      'cache-control': 'public, max-age=300',
      ...securityHeaders(nonce, ogBase),
    },
  });
}

// --- banner + state renderers -----------------------------------------------

function IssueBanner({
  provider,
  repo,
  issueNumber,
  fixSha,
}: {
  provider: Provider;
  repo: RepoRef;
  issueNumber: number;
  fixSha: string;
}) {
  const issueUrl = provider.urls.issue(repo, issueNumber);
  const commitUrl = provider.urls.commit(repo, fixSha);
  return (
    <div class="pr-banner">
      Resolved <a href={issueUrl}>Issue #{issueNumber}</a> → fixed in{' '}
      <a href={commitUrl} class="sha">
        {fixSha.slice(0, 7)}
      </a>
    </div>
  );
}

/** Shared chrome for the calm issue states (open / closed-without-fix). Renders
 *  a single answer card with a headline, body copy, and a link to the issue. */
function IssueStateCard(args: {
  pubBase: string;
  ogBase: string;
  nonce: string;
  repo: RepoRef;
  issueNumber: number;
  provider: Provider;
  status: number;
  headline: string;
  body: Child;
  titleSuffix: string;
}): Response {
  const {
    pubBase,
    ogBase,
    nonce,
    repo,
    issueNumber,
    provider,
    status,
    headline,
    body,
    titleSuffix,
  } = args;
  const displayName = repo.projectPath;
  const issueUrl = provider.urls.issue(repo, issueNumber);
  const permalink = `${pubBase}${issuePermalinkPath(repo, issueNumber)}`;
  const page = (
    <Layout
      title={`${displayName}#${issueNumber} — ${titleSuffix}`}
      nonce={nonce}
      ogBaseUrl={ogBase}
      publicUrl={permalink}
      ogFallbackTitle={`released — ${displayName}#${issueNumber}: ${titleSuffix}`}
    >
      <Nav />
      <main style="padding-top: 24px;">
        <div class="answer">
          <div class="answer-hero">
            <div class="answer-label">Status</div>
            <div class="answer-version">
              <span class="v" style="font-size: 32px; color: var(--warn);">
                {headline}
              </span>
            </div>
            <div class="answer-date">{body}</div>
            <div class="answer-actions" style="margin-top: 16px;">
              <a class="btn-fmt primary" href={issueUrl} style="text-decoration: none;">
                Open issue on {repo.host}
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
      // Short cache: a fix can still land, so don't pin these states.
      'cache-control': 'public, max-age=300',
      ...securityHeaders(nonce, ogBase),
    },
  });
}

function renderIssueOpen(args: {
  pubBase: string;
  ogBase: string;
  nonce: string;
  repo: RepoRef;
  issueNumber: number;
  provider: Provider;
}): Response {
  const issueUrl = args.provider.urls.issue(args.repo, args.issueNumber);
  return IssueStateCard({
    ...args,
    status: 200,
    headline: 'Still open',
    titleSuffix: 'still open',
    body: (
      <>
        <b>
          <a href={issueUrl}>Issue #{args.issueNumber}</a>
        </b>{' '}
        is still open — there's no fix to track to a release yet. Re-check after it's closed.
      </>
    ),
  });
}

function renderIssueClosedWithoutFix(
  err: IssueClosedWithoutFixError,
  args: {
    pubBase: string;
    ogBase: string;
    nonce: string;
    repo: RepoRef;
    issueNumber: number;
    provider: Provider;
  },
): Response {
  const issueUrl = args.provider.urls.issue(args.repo, args.issueNumber);
  const headline = err.notPlanned ? 'Closed (not planned)' : 'Closed without a fix';
  const body = err.notPlanned ? (
    <>
      <b>
        <a href={issueUrl}>Issue #{args.issueNumber}</a>
      </b>{' '}
      was closed as not planned, so there's no fix to track to a release.
    </>
  ) : (
    <>
      <b>
        <a href={issueUrl}>Issue #{args.issueNumber}</a>
      </b>{' '}
      was closed, but no fixing commit or merged pull/merge request was linked to it. If a fix lands
      later, re-check and this will update.
    </>
  );
  return IssueStateCard({
    ...args,
    status: 200,
    headline,
    titleSuffix: err.notPlanned ? 'closed (not planned)' : 'closed without a fix',
    body,
  });
}

function renderDeferred(args: {
  pubBase: string;
  ogBase: string;
  nonce: string;
  repo: RepoRef;
  numberStr: string;
}): Response {
  const { pubBase, ogBase, nonce, repo, numberStr } = args;
  const displayName = repo.projectPath;
  const permalink = `${pubBase}${issuePermalinkPath(repo, Number.parseInt(numberStr, 10))}`;
  const page = (
    <Layout
      title={`looking up — ${displayName}#${numberStr}`}
      nonce={nonce}
      ogBaseUrl={ogBase}
      publicUrl={permalink}
      ogFallbackTitle={`released — looking up ${displayName}#${numberStr}`}
    >
      <Nav />
      <main>
        <div class="answer example">
          <div class="answer-hero">
            <div class="answer-label">Looking up…</div>
            <div class="answer-version">
              <span class="v" style="font-size: 32px;">
                {displayName}#{numberStr}
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

function renderIssueNotYetReleased(
  err: NotYetReleasedError,
  args: {
    pubBase: string;
    ogBase: string;
    nonce: string;
    repo: RepoRef;
    issueNumber: number;
    provider: Provider;
  },
): Response {
  const { pubBase, ogBase, nonce, repo, issueNumber, provider } = args;
  const displayName = repo.projectPath;
  const permalink = `${pubBase}${issuePermalinkPath(repo, issueNumber)}`;
  const synthetic: LookupResult = {
    input: { kind: 'issue', repo, number: issueNumber },
    canonicalSha: err.sha,
    subject: err.subject,
    firstRelease: null,
    alsoIn: [],
    releaseNotesHtml: null,
    rateLimit: null,
    urls: {
      repo: provider.urls.repo(repo),
      commit: provider.urls.commit(repo, err.sha),
    },
  };
  const inlineData = JSON.stringify(synthetic).replace(/</g, '\\u003c');
  const page = (
    <Layout
      title={`not yet released — ${displayName}#${issueNumber}`}
      nonce={nonce}
      ogBaseUrl={ogBase}
      publicUrl={permalink}
      ogFallbackTitle={`released — ${displayName}#${issueNumber}: fixed, not released yet`}
    >
      <Nav />
      <main style="padding-top: 24px;">
        <IssueBanner provider={provider} repo={repo} issueNumber={issueNumber} fixSha={err.sha} />
        <ResultCard result={synthetic} publicBaseUrl={pubBase} hideShare />
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

function renderIssueTransient(args: {
  pubBase: string;
  ogBase: string;
  nonce: string;
  repo: RepoRef;
  issueNumber: number;
  anubis?: boolean;
}): Response {
  const { pubBase, ogBase, nonce, repo, issueNumber, anubis } = args;
  const displayName = repo.projectPath;
  const permalinkPath = issuePermalinkPath(repo, issueNumber);
  const permalink = `${pubBase}${permalinkPath}`;
  const cliCmd = `npx git-released https://${repo.host}/${repo.projectPath}/${repo.host === 'github.com' ? 'issues' : '-/issues'}/${issueNumber}`;
  const page = (
    <Layout
      title={`temporarily unavailable — ${displayName}#${issueNumber}`}
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
              {anubis ? (
                <>
                  <b>{repo.host}</b> blocks server-to-server lookups (Anubis). The CLI can read it —
                  Node’s fetch has a different TLS fingerprint that isn’t challenged.
                </>
              ) : (
                <>
                  <b>{repo.host}</b> isn’t responding right now. This is almost always a brief
                  upstream blip — your lookup hasn’t gone anywhere.
                </>
              )}
            </div>
            {anubis && (
              <div style="margin-top: 14px; padding: 12px 14px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; font-family: 'Geist Mono', monospace; font-size: 13px; color: var(--text); word-break: break-all;">
                {cliCmd}
              </div>
            )}
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

function renderIssueError(
  err: unknown,
  args: {
    pubBase: string;
    ogBase: string;
    nonce: string;
    repo: RepoRef;
    issueNumber: number;
  },
): Response {
  const { pubBase, ogBase, nonce, repo, issueNumber } = args;
  const msg = err instanceof ReleasedError ? err.message : 'Something went wrong.';
  const status = err instanceof ReleasedError ? 404 : 500;
  const permalinkPath = issuePermalinkPath(repo, issueNumber);
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
