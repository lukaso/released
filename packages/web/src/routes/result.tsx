// GET /r/:owner/:repo/c/:sha           — permalink result page (GitHub)
// GET /h/:host/r/:projectPath/c/:sha   — permalink result page (federated)
//
// Same page in two states (D33): input stays at top, result card below.

import {
  type LookupInput,
  type LookupResult,
  NotYetReleasedError,
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
import { commitPermalinkPath } from '../paths.js';
import { makeNonce, securityHeaders } from '../security.js';
import { singleFlight } from '../single-flight.js';
import { Layout } from '../ui/layout.js';
import { PrereleaseHint, ResultCard, StrictHint } from '../ui/result-card.js';

/** Extract the RepoRef from either route family. Returns null if the params
 *  shape doesn't match either expected family. */
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

export async function resultRoute(c: Context): Promise<Response> {
  const env = c.env as Env;
  const req = c.req.raw;
  const repo = repoFromParams(c);
  const sha = c.req.param('sha');
  if (!repo || !sha) return new Response('not found', { status: 404 });
  const strict = c.req.query('strict') === '1' || c.req.query('strict') === 'true';
  const includePrereleases =
    c.req.query('prereleases') === '1' || c.req.query('prereleases') === 'true';

  const nonce = makeNonce();
  const pubBase = publicBaseUrl(env, req);
  const ogBase = ogBaseUrl(env, req);
  const isBot = isUnfurlBot(req);
  const displayName = repo.projectPath;

  // Build the canonical input. Validates SHA shape implicitly via parseInput's
  // SHA regex behavior (we replicate it here directly to avoid double-parsing).
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    const original = `${displayName}@${sha}`;
    return new Response(null, {
      status: 302,
      headers: {
        location: `/?bad=${encodeURIComponent(original)}&reason=invalid_input`,
      },
    });
  }
  const parsed: LookupInput = { kind: 'commit', repo, sha: sha.toLowerCase() };

  const k = await cacheKey(
    'res',
    `${repo.host}/${repo.projectPath}`,
    `sha:${parsed.sha}`,
    strict ? 'strict' : 'cull',
    includePrereleases ? 'pre' : 'nopre',
  );
  const cache = makeWorkerCache(req);
  let result: LookupResult | null = await cache.get<LookupResult>(k);

  // Slackbot/unfurl handling: if no cache + we'd need to compute, return a
  // deferred-render card with short TTL so Slack retries instead of caching an error.
  if (!result && isBot) {
    return renderDeferred({ pubBase, ogBase, nonce, repo, sha });
  }

  // Compute if not cached
  if (!result) {
    const extraGitlabHosts = extraGitlabHostsFromEnv(env);
    let client;
    try {
      const token = resolveProviderToken(env, req, repo.host);
      client = providerFor(repo.host, { token, extraGitlabHosts });
    } catch (err) {
      return renderError(err, { pubBase, ogBase, nonce });
    }
    try {
      result = await singleFlight(k, async () => {
        const re = await cache.get<LookupResult>(k);
        if (re) return re;
        const r = await findRelease(parsed, { client, strict, includePrereleases });
        // Don't cache partial results for the full 30min (see lookup.ts).
        await cache.put(k, r, r.partial ? 60 : 30 * 60);
        return r;
      });
    } catch (err) {
      if (isBot) return renderDeferred({ pubBase, ogBase, nonce, repo, sha });
      if (err instanceof NotYetReleasedError) {
        return renderNotYetReleased(err, {
          pubBase,
          ogBase,
          nonce,
          repo,
          sha,
          strict,
          includePrereleases,
        });
      }
      return renderError(err, { pubBase, ogBase, nonce });
    }
  }

  // Form pre-fill needs to round-trip through parseInput. GitHub's shorthand
  // forms (`owner/repo#N`, `owner/repo@sha`) are GitHub-only — using them on
  // a GitLab result would make the next submit fail or route to the wrong host.
  // For non-GitHub we pre-fill `result.urls.*`, which parseInput always handles.
  const inputVal =
    repo.host === 'github.com'
      ? result.input.kind === 'pr'
        ? `${displayName}#${result.input.number}`
        : `${displayName}@${result.canonicalSha.slice(0, 7)}`
      : result.input.kind === 'pr'
        ? (result.urls.pullRequest ?? result.urls.commit)
        : result.urls.commit;

  const inlineData = JSON.stringify(result).replace(/</g, '\\u003c');
  const shortSha = result.canonicalSha.slice(0, 7);
  const permalink = `${pubBase}${commitPermalinkPath(repo, shortSha)}`;

  const page = (
    <Layout
      title={`${result.firstRelease ? result.firstRelease.tag : 'not yet released'} — ${displayName}`}
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

function renderDeferred(args: {
  pubBase: string;
  ogBase: string;
  nonce: string;
  repo: RepoRef;
  sha: string;
}): Response {
  const { pubBase, ogBase, nonce, repo, sha } = args;
  const displayName = repo.projectPath;
  const permalink = `${pubBase}${commitPermalinkPath(repo, sha)}`;
  const page = (
    <Layout
      title={`looking up — ${displayName}`}
      nonce={nonce}
      ogBaseUrl={ogBase}
      publicUrl={permalink}
      ogFallbackTitle={`released — looking up ${displayName}@${sha}`}
    >
      <Nav />
      <main>
        <div class="answer example">
          <div class="answer-hero">
            <div class="answer-label">Looking up…</div>
            <div class="answer-version">
              <span class="v" style="font-size: 32px;">
                {displayName}@{sha}
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

function renderNotYetReleased(
  err: NotYetReleasedError,
  args: {
    pubBase: string;
    ogBase: string;
    nonce: string;
    repo: RepoRef;
    sha: string;
    strict: boolean;
    includePrereleases: boolean;
  },
): Response {
  const { pubBase, ogBase, nonce, repo, sha, strict, includePrereleases } = args;
  const displayName = repo.projectPath;
  const permalink = `${pubBase}${commitPermalinkPath(repo, sha)}`;
  const strictHref = `${permalink}?strict=1`;
  const prereleaseHref = `${permalink}?prereleases=1`;
  const showStrictHint = err.culledTagCount > 0 && !strict;
  const showPreHint = err.prereleasedSkippedCount > 0 && !includePrereleases;
  const provider = providerFor(repo.host, { extraGitlabHosts: [] }); // URLs only — token not needed
  const synthetic: LookupResult = {
    input: { kind: 'commit', repo, sha: err.sha },
    canonicalSha: err.sha,
    firstRelease: null,
    alsoIn: [],
    releaseNotesHtml: null,
    rateLimit: null,
    urls: {
      repo: provider.urls.repo(repo),
      commit: provider.urls.commit(repo, err.sha),
    },
  };
  const page = (
    <Layout
      title={`not yet released — ${displayName}`}
      nonce={nonce}
      ogBaseUrl={ogBase}
      publicUrl={permalink}
      ogFallbackTitle={`released — ${displayName}@${sha}: not yet released`}
    >
      <Nav />
      <main style="padding-top: 24px;">
        {showPreHint && (
          <PrereleaseHint skipped={err.prereleasedSkippedCount} retryHref={prereleaseHref} />
        )}
        {showStrictHint && <StrictHint culled={err.culledTagCount} retryHref={strictHref} />}
        <ResultCard result={synthetic} publicBaseUrl={pubBase} />
      </main>
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

function renderError(
  err: unknown,
  args: { pubBase: string; ogBase: string; nonce: string },
): Response {
  const { pubBase, ogBase, nonce } = args;
  const msg = err instanceof ReleasedError ? err.message : 'Something went wrong.';
  const status = err instanceof ReleasedError ? 404 : 500;
  const page = (
    <Layout
      title="released — error"
      nonce={nonce}
      ogBaseUrl={ogBase}
      publicUrl={pubBase}
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
