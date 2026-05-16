// GET /r/:owner/:repo/c/:sha — the permalink page (resolved state of the tool).
// Same page in two states (D33): input stays at top, result card below.

import type { Context } from 'hono';
import { raw } from 'hono/html';
import {
  cacheKey,
  findRelease,
  makeGithubClient,
  NotYetReleasedError,
  parseInput,
  ReleasedError,
  type LookupInput,
  type LookupResult,
} from '@released/core';
import { isUnfurlBot, resolveToken } from '../auth.js';
import { makeWorkerCache } from '../cache.js';
import { ogBaseUrl, publicBaseUrl, type Env } from '../env.js';
import { Layout } from '../ui/layout.js';
import { PrereleaseHint, ResultCard, StrictHint } from '../ui/result-card.js';
import { makeNonce, securityHeaders } from '../security.js';
import { singleFlight } from '../single-flight.js';

export async function resultRoute(c: Context): Promise<Response> {
  const env = c.env as Env;
  const req = c.req.raw;
  const owner = c.req.param('owner');
  const repo = c.req.param('repo');
  const sha = c.req.param('sha');
  if (!owner || !repo || !sha) return new Response('not found', { status: 404 });
  const strict = c.req.query('strict') === '1' || c.req.query('strict') === 'true';
  const includePrereleases =
    c.req.query('prereleases') === '1' || c.req.query('prereleases') === 'true';

  const nonce = makeNonce();
  const pubBase = publicBaseUrl(env, req);
  const ogBase = ogBaseUrl(env, req);
  const isBot = isUnfurlBot(req);

  // Parse + cache lookup
  let parsed: LookupInput;
  try {
    parsed = parseInput(`${owner}/${repo}`, sha);
  } catch (err) {
    // Bounce through the homepage's friendly error UI, with the bad input
    // preserved so the user can edit-and-retry.
    const original = `${owner}/${repo}@${sha}`;
    const reason = (err as { kind?: string })?.kind ?? 'invalid';
    return new Response(null, {
      status: 302,
      headers: {
        location: `/?bad=${encodeURIComponent(original)}&reason=${encodeURIComponent(reason)}`,
      },
    });
  }

  const k = await cacheKey(
    'res',
    `${owner}/${repo}`,
    `sha:${parsed.kind === 'commit' ? parsed.sha : sha}`,
    strict ? 'strict' : 'cull',
    includePrereleases ? 'pre' : 'nopre',
  );
  const cache = makeWorkerCache(req);
  let result: LookupResult | null = await cache.get<LookupResult>(k);

  // Slackbot/unfurl handling: if no cache + we'd need to compute, return a
  // deferred-render card with short TTL so Slack retries instead of caching an error.
  if (!result && isBot) {
    return renderDeferred({ pubBase, ogBase, nonce, owner, repo, sha });
  }

  // Compute if not cached
  if (!result) {
    const token = resolveToken(env, req);
    const client = makeGithubClient({ token });
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
      // For unfurl bots, NEVER return a long-cached error.
      if (isBot) return renderDeferred({ pubBase, ogBase, nonce, owner, repo, sha });
      // "Not yet released" is a valid answer, not an error. Render it like a
      // result with the optional strict-mode hint when tags were culled.
      if (err instanceof NotYetReleasedError) {
        return renderNotYetReleased(err, {
          pubBase,
          ogBase,
          nonce,
          owner,
          repo,
          sha,
          strict,
          includePrereleases,
        });
      }
      return renderError(err, { pubBase, ogBase, nonce });
    }
  }

  const repoQuery = `${owner}/${repo}`;
  const inputVal = result.input.kind === 'pr'
    ? `${repoQuery}#${result.input.number}`
    : `${repoQuery}@${result.canonicalSha.slice(0, 7)}`;

  const inlineData = JSON.stringify(result).replace(/</g, '\\u003c');

  const page = (
    <Layout
      title={`${result.firstRelease ? result.firstRelease.tag : 'not yet released'} — ${repoQuery}`}
      nonce={nonce}
      ogBaseUrl={ogBase}
      publicUrl={`${pubBase}/r/${owner}/${repo}/c/${result.canonicalSha.slice(0, 7)}`}
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
        <ResultCard result={result} publicBaseUrl={pubBase} />
      </main>
      <script
        nonce={nonce}
        // Expose the result to client.js for the copy buttons.
        // The string was escaped above so a </script> can't break out.
      >
        {raw(`window.__RELEASED_RESULT__ = ${inlineData};`)}
      </script>
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
  owner: string;
  repo: string;
  sha: string;
}): Response {
  const { pubBase, ogBase, nonce, owner, repo, sha } = args;
  const page = (
    <Layout
      title={`looking up — ${owner}/${repo}`}
      nonce={nonce}
      ogBaseUrl={ogBase}
      publicUrl={`${pubBase}/r/${owner}/${repo}/c/${sha}`}
      ogFallbackTitle={`released — looking up ${owner}/${repo}@${sha}`}
    >
      <Nav />
      <main>
        <div class="answer example">
          <div class="answer-hero">
            <div class="answer-label">Looking up…</div>
            <div class="answer-version">
              <span class="v" style="font-size: 32px;">
                {owner}/{repo}@{sha}
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
      // Short TTL: the bot should re-fetch quickly. NEVER long-cache an error.
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
    owner: string;
    repo: string;
    sha: string;
    strict: boolean;
    includePrereleases: boolean;
  },
): Response {
  const { pubBase, ogBase, nonce, owner, repo, sha, strict, includePrereleases } = args;
  const perma = `${pubBase}/r/${owner}/${repo}/c/${sha}`;
  const strictHref = `${perma}?strict=1`;
  const prereleaseHref = `${perma}?prereleases=1`;
  const showStrictHint = err.culledTagCount > 0 && !strict;
  const showPreHint = err.prereleasedSkippedCount > 0 && !includePrereleases;
  const synthetic: LookupResult = {
    input: { kind: 'commit', repo: { owner, repo }, sha: err.sha },
    canonicalSha: err.sha,
    firstRelease: null,
    alsoIn: [],
    releaseNotesHtml: null,
    rateLimit: null,
  };
  const page = (
    <Layout
      title={`not yet released — ${owner}/${repo}`}
      nonce={nonce}
      ogBaseUrl={ogBase}
      publicUrl={perma}
      ogFallbackTitle={`released — ${owner}/${repo}@${sha}: not yet released`}
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
    // 200 — "not yet released" is a real answer, not an error.
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300',
      ...securityHeaders(nonce, ogBase),
    },
  });
}

function renderError(err: unknown, args: { pubBase: string; ogBase: string; nonce: string }): Response {
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
