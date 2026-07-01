// Status-badge endpoints — an auto-updating SVG you can embed in MR/PR markdown.
//
//   GET /r/:owner/:repo/c/:sha/badge.svg            — commit (GitHub)
//   GET /p/:owner/:repo/:number/badge.svg           — PR (GitHub)
//   GET /i/:owner/:repo/:number/badge.svg           — issue (GitHub)
//   GET /h/:host/r/:projectPath/c/:sha/badge.svg    — commit (federated)
//   GET /h/:host/p/:projectPath/:number/badge.svg   — MR (federated)
//   GET /h/:host/i/:projectPath/:number/badge.svg   — issue (federated)
//
// Shares the exact cache key the permalink page uses, so once a page (or a
// prior badge fetch) warms the cache the badge is instant. Released answers are
// terminal → cached long; "not yet"/"checking" → cached short so the proxy
// (GitHub camo / GitLab) re-fetches and the badge flips after a release.

import {
  IssueNotClosedError,
  type LookupInput,
  type LookupResult,
  PrNotMergedError,
  type RepoRef,
  cacheKey,
  findRelease,
  providerFor,
} from '@released/core';
import type { Context } from 'hono';
import { setTrack, upstreamStatusOf } from '../analytics.js';
import { extraGitlabHostsFromEnv, resolveProviderToken } from '../auth.js';
import { BADGE_COLORS, type BadgeState, badgeStateForResult, renderBadge } from '../badge.js';
import { makeWorkerCache } from '../cache.js';
import type { Env } from '../env.js';
import { resolveLookup } from '../resolve.js';

const SHORT_CACHE = 'public, max-age=300, s-maxage=300'; // not-yet / checking / error
const LONG_CACHE = 'public, max-age=86400, s-maxage=86400'; // released (terminal)

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

/** Issue badge routes carry a `:number` like PR routes, so the param alone
 *  can't tell them apart — disambiguate on the path. projectPath is encoded into
 *  a single segment (`%2F`), so no stray slash can fake the `/i/` marker. */
function isIssueBadgePath(pathname: string): boolean {
  return /^\/i\//.test(pathname) || /^\/h\/[^/]+\/i\//.test(pathname);
}

function svg(body: string, cacheControl: string): Response {
  return new Response(body, {
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': cacheControl,
      // Camo strips most headers, but be explicit that this isn't sniffable.
      'x-content-type-options': 'nosniff',
    },
  });
}

function badge(state: BadgeState, cacheControl: string): Response {
  return svg(renderBadge(state), cacheControl);
}

export async function badgeRoute(c: Context): Promise<Response> {
  const env = c.env as Env;
  const req = c.req.raw;
  const repo = repoFromParams(c);
  if (!repo) return badge({ message: 'unknown', color: BADGE_COLORS.neutral }, SHORT_CACHE);
  setTrack(req, { host: repo.host, repo: repo.projectPath });

  // Decide commit vs PR vs issue from the params + path on the matched route.
  // PR and issue routes both carry `:number`; the path tells them apart.
  const numberStr = c.req.param('number');
  const sha = c.req.param('sha');
  const isIssue = isIssueBadgePath(new URL(req.url).pathname);
  let input: LookupInput;
  let keyPart: string;
  if (numberStr !== undefined) {
    setTrack(req, { kind: isIssue ? 'issue' : 'pr' });
    const n = Number.parseInt(numberStr, 10);
    if (!Number.isFinite(n) || n <= 0) {
      setTrack(req, { outcome: 'invalid' });
      return badge({ message: 'unknown', color: BADGE_COLORS.neutral }, SHORT_CACHE);
    }
    // Same cache key the issue/pr permalink pages use, so a page (or prior badge)
    // visit warms it (issue#N for issues, pr#N for PR/MRs).
    input = isIssue ? { kind: 'issue', repo, number: n } : { kind: 'pr', repo, number: n };
    keyPart = isIssue ? `issue#${n}` : `pr#${n}`;
  } else {
    setTrack(req, { kind: 'commit' });
    if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) {
      setTrack(req, { outcome: 'invalid' });
      return badge({ message: 'unknown', color: BADGE_COLORS.neutral }, SHORT_CACHE);
    }
    input = { kind: 'commit', repo, sha: sha.toLowerCase() };
    keyPart = `sha:${sha.toLowerCase()}`;
  }

  // Same key family as result/pr/api routes (default cull + no-prerelease mode).
  const k = await cacheKey('res', `${repo.host}/${repo.projectPath}`, keyPart, 'cull', 'nopre');
  const cache = makeWorkerCache(req);

  // Stale-if-error: a terminal "released" answer is served from cache forever; a
  // transient upstream outage serves the last-known-good answer rather than
  // erasing it. Cold + upstream-down degrades to "checking…", never "unknown".
  const resolved = await resolveLookup({
    cache,
    key: k,
    load: () => {
      const token = resolveProviderToken(env, req, repo.host);
      const client = providerFor(repo.host, {
        token,
        extraGitlabHosts: extraGitlabHostsFromEnv(env),
      });
      // Tight deadline so a slow repo returns a short-cached "checking…" instead
      // of hanging past the proxy's fetch timeout.
      return findRelease(input, {
        client,
        softDeadline: Date.now() + 8_000,
        hardDeadline: Date.now() + 9_000,
      });
    },
  });

  if (resolved.status === 'ok') {
    setTrack(req, {
      cache: resolved.cached ? 'hit' : 'miss',
      outcome: outcomeFor(resolved.result),
    });
    const state = badgeStateForResult(resolved.result);
    return badge(state, resolved.result.firstRelease ? LONG_CACHE : SHORT_CACHE);
  }
  if (resolved.status === 'not_yet') {
    setTrack(req, { cache: 'miss', outcome: 'not_yet' });
    return badge({ message: 'not yet', color: BADGE_COLORS.notYet }, SHORT_CACHE);
  }
  if (resolved.status === 'transient') {
    // Upstream unreachable with no prior answer: "checking…" is self-correcting
    // (the proxy re-fetches on the short cache and it recovers), whereas
    // "unknown" reads like a permanent failure.
    setTrack(req, {
      cache: 'miss',
      outcome: 'error',
      errorType: resolved.kind,
      upstreamStatus: resolved.upstreamStatus,
    });
    return badge({ message: 'checking…', color: BADGE_COLORS.neutral }, SHORT_CACHE);
  }
  // Permanent: PR not merged, not found, unsupported host, etc.
  setTrack(req, {
    cache: 'miss',
    outcome: 'error',
    errorType: (resolved.error as Error)?.name,
    upstreamStatus: upstreamStatusOf(resolved.error),
  });
  // Open-but-unmerged PRs are the most valuable place to embed a badge: a user
  // can paste it in the PR description, and once the PR merges and ships the
  // badge flips to the version tag. Return "not yet" (gold) with SHORT_CACHE
  // so the proxy re-fetches and the badge updates within minutes of merge.
  // Closed-without-merging stays "unknown" — it will never flip.
  if (resolved.error instanceof PrNotMergedError && resolved.error.prState === 'open') {
    return badge({ message: 'not yet', color: BADGE_COLORS.notYet }, SHORT_CACHE);
  }
  // A still-open issue is the issue analog of an open PR: a fix can still land
  // and ship, so "not yet" (gold) + SHORT_CACHE keeps the badge re-fetching so
  // it flips once the issue is closed and released. A closed-without-fix issue
  // (IssueClosedWithoutFixError) will never flip on its own → stays "unknown".
  if (resolved.error instanceof IssueNotClosedError) {
    return badge({ message: 'not yet', color: BADGE_COLORS.notYet }, SHORT_CACHE);
  }
  return badge({ message: 'unknown', color: BADGE_COLORS.neutral }, SHORT_CACHE);
}

/** Map a resolved lookup to a tracking outcome. */
function outcomeFor(r: LookupResult): 'released' | 'partial' | 'not_yet' {
  if (r.firstRelease) return 'released';
  return r.partial ? 'partial' : 'not_yet';
}
