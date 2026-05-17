// GitlabProvider — REST-only implementation of the Provider interface.
// REST chosen over GraphQL because gitlab.com's GraphQL schema is current but
// self-hosted GitLabs frequently lag. REST works everywhere.
//
// Auth header is PRIVATE-TOKEN (or Authorization: Bearer for OAuth). We use
// PRIVATE-TOKEN since users supply PATs via env vars.
//
// Rate-limit header names differ from GitHub:
//   GitHub: x-ratelimit-{remaining,limit,reset}
//   GitLab: RateLimit-{Remaining,Limit,Reset}   (note: PascalCase, not x-prefixed)
//   GitLab also: RateLimit-Reset = epoch seconds (same as GitHub) when set.

import {
  CommitNotFoundError,
  PrMergeCommitUnavailableError,
  PrNotFoundError,
  PrNotMergedError,
  ProviderServerError,
} from '../../errors.js';
import type { Provider, ProviderOpts } from '../../provider.js';
import {
  type RateLimitInfo,
  type RepoRef,
  type TagWithDate,
  isPrereleaseTag,
} from '../../types.js';
import { callWithRetry, enc, readJson } from '../http.js';
import { makeGitlabUrls } from './urls.js';

/** Pagination cap: GitLab REST is one HTTP round-trip per page (no GraphQL
 *  batching equivalent). 5 pages × 100 = 500 newest tags covers years of
 *  history in even the largest repos while keeping the deadline budget intact. */
const MAX_TAG_PAGES = 5;

export function makeGitlabProvider(host: string, opts: ProviderOpts = {}): Provider {
  // Bind fetch so calls inside Cloudflare Workers don't trip the
  // "Illegal invocation: function called with incorrect `this` reference" check.
  const fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const token = opts.token;
  const ua = opts.userAgent ?? 'released/0.0.0 (+https://released.blabberate.com)';
  const restBase = opts.restBase ?? `https://${host}/api/v4`;
  const retries = opts.retries ?? 2;
  const urls = makeGitlabUrls(host);

  function baseHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      accept: 'application/json',
      'user-agent': ua,
    };
    if (token) h['private-token'] = token;
    return h;
  }

  function parseRateLimit(res: Response): RateLimitInfo | null {
    // GitLab uses PascalCase headers. fetch normalizes header names to lowercase
    // on read, so all variations work — but be defensive about missing fields.
    const remaining = res.headers.get('ratelimit-remaining');
    const limit = res.headers.get('ratelimit-limit');
    const reset = res.headers.get('ratelimit-reset');
    if (remaining === null || limit === null || reset === null) return null;
    return {
      remaining: Number.parseInt(remaining, 10),
      limit: Number.parseInt(limit, 10),
      resetAt: Number.parseInt(reset, 10),
    };
  }

  const callOpts = {
    fetchImpl,
    retries,
    providerHost: host,
    parseRateLimit,
    makeServerError: (status: number, statusText: string) =>
      new ProviderServerError(host, status, statusText),
  };
  const call = (url: string, init: RequestInit) => callWithRetry(url, init, callOpts);

  /** GitLab requires URL-encoded full project path as the project ID. */
  function projectId(repo: RepoRef): string {
    return enc(repo.projectPath);
  }

  async function getPullRequest(repo: RepoRef, n: number) {
    const url = `${restBase}/projects/${projectId(repo)}/merge_requests/${n}`;
    const res = await call(url, { headers: baseHeaders() });
    const rateLimit = parseRateLimit(res);
    if (res.status === 404) throw new PrNotFoundError(n);
    if (!res.ok) throw new ProviderServerError(host, res.status, res.statusText);
    const body = await readJson<{
      state: string;
      merge_commit_sha: string | null;
      squash_commit_sha: string | null;
      /** Head of the source branch at merge time. Present for fast-forward merges
       *  (common on projects like GNOME/gimp that use FF merges) where no merge
       *  commit is created — `sha` IS the commit that ended up in the target branch. */
      sha: string | null;
    }>(res);
    if (body.state !== 'merged') throw new PrNotMergedError(n);
    const sha = body.merge_commit_sha ?? body.squash_commit_sha ?? body.sha;
    if (sha == null) throw new PrMergeCommitUnavailableError(n);
    return { merged: true as const, mergeCommitSha: sha, rateLimit };
  }

  async function getCommit(repo: RepoRef, sha: string) {
    const url = `${restBase}/projects/${projectId(repo)}/repository/commits/${enc(sha)}`;
    const res = await call(url, { headers: baseHeaders() });
    const rateLimit = parseRateLimit(res);
    if (res.status === 404) throw new CommitNotFoundError(sha);
    if (!res.ok) throw new ProviderServerError(host, res.status, res.statusText);
    const body = await readJson<{ id: string; committed_date: string }>(res);
    return { fullSha: body.id, committedDate: body.committed_date, rateLimit };
  }

  async function listTagsWithDates(repo: RepoRef) {
    const tags: TagWithDate[] = [];
    let pageUrl: string | null =
      `${restBase}/projects/${projectId(repo)}/repository/tags?per_page=100&order_by=updated&sort=desc`;
    let rateLimit: RateLimitInfo | null = null;
    let pages = 0;
    while (pageUrl && pages < MAX_TAG_PAGES) {
      const res: Response = await call(pageUrl, { headers: baseHeaders() });
      rateLimit = parseRateLimit(res) ?? rateLimit;
      if (!res.ok) throw new ProviderServerError(host, res.status, res.statusText);
      const body = await readJson<GitlabTag[]>(res);
      for (const t of body) {
        const decoded = decodeTag(t);
        if (decoded) tags.push(decoded);
      }
      pageUrl = nextPageFromLinkHeader(res.headers.get('link'));
      pages++;
    }
    return { tags, rateLimit };
  }

  async function compareCommits(repo: RepoRef, base: string, head: string) {
    // GitLab's /compare endpoint returns commits between `from` and `to`.
    // To check whether `base` (a tag SHA) CONTAINS `head` (the input commit),
    // we ask: from=base, to=head. If head is reachable from base, the response
    // includes commits; otherwise commits is empty AND compare_same_ref differs.
    //
    // GitLab REST doesn't return a GitHub-style 4-way status. We translate:
    //   commits.length > 0 AND first commit's id != head.id → head is AHEAD of base
    //                                                         (base does NOT contain head)
    //   commits.length === 0 AND compare_timeout = false   → base equals or contains head
    //                                                         (we treat as 'behind' = contains)
    //   Otherwise → diverged.
    //
    // Simpler equivalent: use /commits/:sha/refs?type=tag to ask "what tags contain
    // this commit?". That's a TODO optimization — for now we mirror GitHub's
    // compare-shaped API so the algorithm stays uniform.
    const url = `${restBase}/projects/${projectId(repo)}/repository/compare?from=${enc(base)}&to=${enc(head)}&straight=true`;
    const res = await call(url, { headers: baseHeaders() });
    const rateLimit = parseRateLimit(res);
    if (res.status === 404) return { status: 'diverged' as const, rateLimit };
    if (!res.ok) throw new ProviderServerError(host, res.status, res.statusText);
    const body = await readJson<{
      commits?: { id: string }[];
      diffs?: unknown[];
      compare_timeout?: boolean;
      compare_same_ref?: boolean;
    }>(res);
    if (body.compare_timeout) return { status: 'diverged' as const, rateLimit };
    const commits = body.commits ?? [];
    if (body.compare_same_ref || commits.length === 0) {
      // head is an ancestor of (or equal to) base → base CONTAINS head.
      return { status: 'behind' as const, rateLimit };
    }
    // base...head has commits → head is ahead of base (base does not contain head).
    return { status: 'ahead' as const, rateLimit };
  }

  async function containingTags(repo: RepoRef, sha: string) {
    const url = `${restBase}/projects/${projectId(repo)}/repository/commits/${enc(sha)}/refs?type=tag&per_page=100`;
    const res = await call(url, { headers: baseHeaders() });
    const rateLimit = parseRateLimit(res);
    if (!res.ok) throw new ProviderServerError(host, res.status, res.statusText);
    const body = await readJson<{ type: string; name: string }[]>(res);
    const tags = body.filter((r) => r.type === 'tag').map((r) => r.name);
    return { tags, rateLimit };
  }

  async function getReleaseNotes(repo: RepoRef, tag: string) {
    const url = `${restBase}/projects/${projectId(repo)}/releases/${enc(tag)}`;
    const res = await call(url, { headers: baseHeaders() });
    const rateLimit = parseRateLimit(res);
    // GitLab releases don't have a `prerelease` flag (only `upcoming_release`
    // for future-dated releases). Return null — UI falls back to the tag-name
    // heuristic for GitLab.
    if (res.status === 404) return { body: null, isPrerelease: null, rateLimit };
    if (!res.ok) throw new ProviderServerError(host, res.status, res.statusText);
    const body = await readJson<{ description?: string | null }>(res);
    return { body: body.description ?? null, isPrerelease: null, rateLimit };
  }

  return {
    host,
    kind: 'gitlab',
    terms: { mergeRequest: 'Merge request', mergeRequestPrefix: '!' },
    getPullRequest,
    getCommit,
    listTagsWithDates,
    compareCommits,
    containingTags,
    getReleaseNotes,
    urls,
  };
}

// --- helpers -----------------------------------------------------------------

type GitlabTag = {
  name: string;
  commit: { id: string; committed_date?: string; created_at?: string };
  release?: { description?: string | null } | null;
};

function decodeTag(t: GitlabTag): TagWithDate | null {
  if (!t.commit?.id) return null;
  const date = t.commit.committed_date ?? t.commit.created_at ?? '';
  return {
    name: t.name,
    sha: t.commit.id,
    date,
    isPrerelease: isPrereleaseTag(t.name),
  };
}

/** Parse the next-page URL out of GitLab's Link header.
 *  Format: <https://gitlab.com/api/v4/...?page=2>; rel="next", <...>; rel="last" */
function nextPageFromLinkHeader(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  // Each entry is "<URL>; rel=\"REL\"". Split on commas not inside <>.
  const entries = linkHeader.split(',');
  for (const entry of entries) {
    const m = entry.match(/<([^>]+)>;\s*rel="?next"?/i);
    if (m) return m[1] ?? null;
  }
  return null;
}
