// GET /r/:owner/:repo/c/:sha           — permalink result page (GitHub)
// GET /h/:host/r/:projectPath/c/:sha   — permalink result page (federated)
//
// Same page in two states (D33): input stays at top, result card below.

import {
  type LookupInput,
  type LookupResult,
  type NotYetReleasedError,
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
import { isUnfurlBot } from '../auth.js';
import { type WorkerCache, makeWorkerCache } from '../cache.js';
import { type Env, ogBaseUrl, publicBaseUrl } from '../env.js';
import { commitPermalinkPath } from '../paths.js';
import { makeProvider } from '../provider.js';
import { resolveLookup } from '../resolve.js';
import { makeNonce, securityHeaders } from '../security.js';
import { Layout } from '../ui/layout.js';
import { ogImageUrlForCommit } from '../ui/og-meta.js';
import { PrereleaseHint, ResultCard, StaleNotice, StrictHint } from '../ui/result-card.js';

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
  setTrack(req, { host: repo.host, repo: repo.projectPath, kind: 'commit' });
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

  // Provider construction can fail (unsupported host) — a permanent error.
  // Anubis-protected hosts get a relay-backed fetch (see makeProvider/relay.ts).
  let client: Provider;
  try {
    client = makeProvider(env, req, repo.host);
  } catch (err) {
    setTrack(req, {
      outcome: 'error',
      errorType: (err as Error)?.name,
      upstreamStatus: upstreamStatusOf(err),
    });
    return renderError(err, { pubBase, ogBase, nonce, repo, sha });
  }

  const ctx: RenderCtx = {
    req,
    cache,
    key: k,
    parsed,
    client,
    strict,
    includePrereleases,
    pubBase,
    ogBase,
    nonce,
    repo,
    sha,
    displayName,
  };

  // Slackbot/unfurl handling: bots never trigger a compute — serve a cached
  // answer (stale is fine) or a short-TTL deferred card so they retry.
  if (isBot) {
    const cached = await cache.get<LookupResult>(k);
    if (!cached) return renderDeferred({ pubBase, ogBase, nonce, repo, sha });
    setTrack(req, { cache: 'hit' });
    return renderSuccessResponse(cached, false, null, ctx);
  }

  // Fast path: a terminal (released) answer is cached → render synchronously.
  // Instant, correct HTTP status, full SSR — best for crawlers and repeat hits,
  // and the common case once a page is warm.
  const cachedTerminal = await cache.get<LookupResult>(k);
  if (cachedTerminal?.firstRelease) {
    setTrack(req, { cache: 'hit' });
    return renderSuccessResponse(cachedTerminal, false, null, ctx);
  }

  // Cold path: nothing terminal cached, so the compute can take several seconds
  // (cache-miss p95 ~9s). Stream an instant "Looking up…" shell now, then swap
  // in the real page when it's ready — no blank wait on shared links, the
  // example, badge click-throughs, or the homepage form (which routes here).
  return streamLookup(ctx);
}

// Everything resultRoute needs to resolve + render an answer, threaded through
// the sync and streaming paths so they render identically.
type RenderCtx = {
  req: Request;
  cache: WorkerCache;
  key: string;
  parsed: LookupInput;
  client: Provider;
  strict: boolean;
  includePrereleases: boolean;
  pubBase: string;
  ogBase: string;
  nonce: string;
  repo: RepoRef;
  sha: string;
  displayName: string;
};

/** Resolve the lookup (stale-if-error) and render the matching Response. Used by
 *  the streaming path; the sync fast path calls renderSuccessResponse directly. */
async function resolveAndRenderResponse(ctx: RenderCtx): Promise<Response> {
  const {
    req,
    cache,
    key,
    parsed,
    client,
    strict,
    includePrereleases,
    pubBase,
    ogBase,
    nonce,
    repo,
    sha,
  } = ctx;
  const resolved = await resolveLookup({
    cache,
    key,
    load: () => findRelease(parsed, { client, strict, includePrereleases }),
  });
  if (resolved.status === 'not_yet') {
    setTrack(req, { cache: 'miss', outcome: 'not_yet' });
    return renderNotYetReleased(resolved.error, {
      pubBase,
      ogBase,
      nonce,
      repo,
      sha,
      strict,
      includePrereleases,
    });
  }
  if (resolved.status === 'transient') {
    setTrack(req, {
      cache: 'miss',
      outcome: 'error',
      errorType: resolved.kind,
      upstreamStatus: resolved.upstreamStatus,
    });
    // Anubis blocks workerd specifically; "Try again" never works. Surface the
    // CLI command (Node has a different TLS fingerprint) instead.
    if (resolved.anubis) {
      return renderAnubis({ pubBase, ogBase, nonce, repo, sha, provider: client });
    }
    return renderTransient({ pubBase, ogBase, nonce, repo, sha });
  }
  if (resolved.status === 'error') {
    setTrack(req, {
      cache: 'miss',
      outcome: 'error',
      errorType: (resolved.error as Error)?.name,
      upstreamStatus: upstreamStatusOf(resolved.error),
    });
    return renderError(resolved.error, { pubBase, ogBase, nonce, repo, sha });
  }
  setTrack(req, { cache: resolved.cached ? 'hit' : 'miss' });
  return renderSuccessResponse(resolved.result, resolved.stale, resolved.staleAsOf, ctx);
}

/** Render the resolved-answer page (the input form + the result card). */
function renderSuccessResponse(
  result: LookupResult,
  stale: boolean,
  staleAsOf: number | null,
  ctx: RenderCtx,
): Response {
  const { req, pubBase, ogBase, nonce, repo, displayName } = ctx;
  setTrack(req, {
    outcome: result.partial ? 'partial' : result.firstRelease ? 'released' : 'not_yet',
  });

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
        {stale && <StaleNotice asOf={staleAsOf} host={repo.host} />}
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

/** The instant "Looking up…" shell streamed first on a cold lookup. */
// Marker Layout always emits; used to splice the shell open + the resolved
// page's inner into one continuous streamed document (see streamLookup).
const WRAP_OPEN = '<div class="wrap">';
const WRAP_CLOSE_SCRIPT = '</div><script';

/** The streamed-FIRST chunk: a normal, in-progress HTML document up to (but not
 *  closing) the "Looking up…" shell. Because the document is left OPEN, the
 *  browser renders it incrementally and the shell text paints immediately. (The
 *  earlier document.write approach sent a *complete* doc then trailing bytes,
 *  which breaks incremental paint — the card showed but its text didn't.) */
function shellOpenChunk(ctx: RenderCtx): string {
  const { pubBase, ogBase, nonce, repo, sha } = ctx;
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
      {/* Whole shell wrapped so one style can hide it when the answer arrives. */}
      <div data-lookup-shell>
        <Nav />
        <main>
          <div class="answer">
            <div class="answer-hero">
              <div class="answer-label">
                Looking up
                <span class="dots" />
              </div>
              <div class="answer-version">
                <span class="v" style="font-size: 28px;">
                  {displayName}@{sha.slice(0, 7)}
                </span>
              </div>
              <div class="answer-date">Checking every release for this commit…</div>
            </div>
          </div>
        </main>
      </div>
    </Layout>
  );
  // Everything up to the wrap's closing </div><script…> — i.e. leave the
  // document open right after the shell block.
  return `<!DOCTYPE html>${page.toString()}`.split(WRAP_CLOSE_SCRIPT)[0] ?? '';
}

/** Progressive HTML streaming: flush the shell immediately (open document), then
 *  once the lookup resolves append a style that hides the shell + the resolved
 *  page's inner markup + the document close. One continuous document the browser
 *  paints incrementally — no document.write, no reload, no flash. The appended
 *  result payload + shared client JS run as normal nonce'd inline scripts, so
 *  the strict CSP is satisfied. */
function streamLookup(ctx: RenderCtx): Response {
  const { nonce, ogBase, pubBase, repo, sha } = ctx;
  // Deployed Workers stream compressed responses fine; `wrangler dev` (miniflare)
  // compress-buffers them so the shell never paints locally (workers-sdk
  // #6577/#8004). Opt this one response out of compression ONLY in local dev, so
  // prod keeps full gzip + native streaming and we can still dogfood the shell.
  const isLocalDev = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(new URL(ctx.req.url).host);
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(enc.encode(shellOpenChunk(ctx)));
      let fullHtml: string;
      try {
        const resp = await resolveAndRenderResponse(ctx);
        fullHtml = await resp.text();
      } catch (err) {
        const resp = renderError(err, { pubBase, ogBase, nonce, repo, sha });
        fullHtml = await resp.text();
      }
      // The resolved page's inner = everything after Layout's wrap open. That
      // tail also carries the wrap close + the client-JS script + </body></html>,
      // so appending it completes the document we left open above.
      const inner = fullHtml.split(WRAP_OPEN)[1];
      const tail = inner
        ? `<style>[data-lookup-shell]{display:none}</style>${inner}`
        : // Defensive: marker missing → close the doc and reload to the answer.
          `<script nonce="${nonce}">location.reload()</script></div></body></html>`;
      controller.enqueue(enc.encode(tail));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Dynamic shell+answer page; the real answer is warmed into the Worker
      // cache, so the NEXT load is a fast synchronous hit.
      'cache-control': 'no-store',
      // Dev-only: disable compression so wrangler dev streams the shell instead
      // of buffering it (see isLocalDev above). Omitted in prod, where Cloudflare
      // compresses AND streams natively.
      ...(isLocalDev ? { 'content-encoding': 'identity' } : {}),
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
      // #53: the cache is cold (that's why we're deferring), but the repo + sha
      // are known. Point the unfurl at the dynamic per-commit card so a freshly
      // shared link still gets the real OG image — web-og resolves the commit
      // itself and degrades to its own placeholder if it can't.
      ogImageOverride={ogImageUrlForCommit(repo, sha, ogBase)}
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
      title={`not yet released — ${displayName}`}
      nonce={nonce}
      ogBaseUrl={ogBase}
      publicUrl={permalink}
      ogFallbackTitle={`released — ${displayName}@${sha}: not yet released`}
    >
      <Nav />
      <main style="padding-top: 24px;">
        <ResultCard result={synthetic} publicBaseUrl={pubBase} />
        {showPreHint && (
          <PrereleaseHint skipped={err.prereleasedSkippedCount} retryHref={prereleaseHref} />
        )}
        {showStrictHint && <StrictHint culled={err.culledTagCount} retryHref={strictHref} />}
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

function renderError(
  err: unknown,
  args: { pubBase: string; ogBase: string; nonce: string; repo: RepoRef; sha: string },
): Response {
  const { pubBase, ogBase, nonce, repo, sha } = args;
  const msg = err instanceof ReleasedError ? err.message : 'Something went wrong.';
  const status = err instanceof ReleasedError ? 404 : 500;
  const permalinkPath = commitPermalinkPath(repo, sha);
  const page = (
    <Layout
      title="released — error"
      nonce={nonce}
      ogBaseUrl={ogBase}
      publicUrl={`${pubBase}${permalinkPath}`}
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

/** Anubis-blocked host (gitlab.freedesktop.org and similar). Anubis fingerprints
 *  the HTTP/2 + TLS stack BELOW the API auth layer, so workerd is challenged
 *  and a provider token doesn't help. The CLI uses Node's fetch, which isn't
 *  challenged. Show the exact command to copy, plus a link to the upstream URL
 *  — but NOT a "Try again" button (retrying never beats Anubis from workerd). */
function renderAnubis(args: {
  pubBase: string;
  ogBase: string;
  nonce: string;
  repo: RepoRef;
  sha: string;
  provider: Provider;
}): Response {
  const { pubBase, ogBase, nonce, repo, sha, provider } = args;
  const permalinkPath = commitPermalinkPath(repo, sha);
  const upstreamUrl = provider.urls.commit(repo, sha);
  const cliCmd = `npx git-released ${upstreamUrl}`;
  const page = (
    <Layout
      title={`${repo.host} needs the CLI — ${repo.projectPath}`}
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
                Open commit on {repo.host}
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
    // 503 keeps proxies / browsers from pinning this state. Short cache so a
    // future workaround (proxy, header tweak) takes effect quickly.
    status: 503,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=60',
      'retry-after': '60',
      ...securityHeaders(nonce, ogBase),
    },
  });
}

/** Upstream unreachable with nothing cached — transient. Keep the user's lookup:
 *  "Try again" reloads the same permalink. Short cache + 503 so this state isn't
 *  pinned by proxies/browsers. */
function renderTransient(args: {
  pubBase: string;
  ogBase: string;
  nonce: string;
  repo: RepoRef;
  sha: string;
}): Response {
  const { pubBase, ogBase, nonce, repo, sha } = args;
  const permalinkPath = commitPermalinkPath(repo, sha);
  const page = (
    <Layout
      title={`temporarily unavailable — ${repo.projectPath}`}
      nonce={nonce}
      ogBaseUrl={ogBase}
      publicUrl={`${pubBase}${permalinkPath}`}
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
