// GiteaProvider — REST-only implementation of the Provider interface for Gitea
// and Forgejo (a Gitea fork; codeberg.org runs Forgejo and shares this API).
//
// Gitea is self-hosted (no canonical host like github.com), so — like the GitLab
// provider — `host` is a factory parameter and `restBase` is built from it. One
// implementation serves gitea.com, codeberg.org, and any self-hosted instance.
//
// URL paths are GitHub-style (no GitLab `/-/` infix): /repos/{owner}/{repo}/...
// Auth header is `Authorization: token <PAT>` (Gitea's documented scheme).
//
// Rate-limit: Gitea/Forgejo emit the RFC 9211 `ratelimit` header
// (`"policy";r=<remaining>;t=<window>`), NOT GitHub's x-ratelimit-* nor GitLab's
// RateLimit-*. We parse `r=`/`q=` (with an x-ratelimit-* fallback for instances
// behind a proxy).

import {
  CommitNotFoundError,
  IssueNotFoundError,
  PrMergeCommitUnavailableError,
  PrNotFoundError,
  PrNotMergedError,
  ProviderServerError,
} from '../../errors.js';
import type { Provider, ProviderOpts } from '../../provider.js';
import {
  type IssueResolution,
  isPrereleaseTag,
  type RateLimitInfo,
  type RepoRef,
  type TagWithDate,
} from '../../types.js';
import { callWithRetry, enc, readJson } from '../http.js';
import { makeGiteaUrls } from './urls.js';

/** Pagination cap: 5 pages × 100 = 500 newest tags covers years of history in
 *  even the largest repos while keeping the deadline budget intact. Matches
 *  the GitLab provider's bound. */
const MAX_TAG_PAGES = 5;
const PAGE_SIZE = 100;

const GITEA_TERMS = { mergeRequest: 'Pull request', mergeRequestPrefix: '#' } as const;

export function makeGiteaProvider(host: string, opts: ProviderOpts = {}): Provider {
  const fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const token = opts.token;
  const ua = opts.userAgent ?? 'released/0.0.0 (+https://released.blabberate.com)';
  const restBase = opts.restBase ?? `https://${host}/api/v1`;
  const retries = opts.retries ?? 2;
  const urls = makeGiteaUrls(host);

  function baseHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      accept: 'application/json',
      'user-agent': ua,
    };
    if (token) h.authorization = `token ${token}`;
    return h;
  }

  function parseRateLimit(res: Response): RateLimitInfo | null {
    // Instances behind a proxy sometimes emit GitHub-style x-ratelimit-*; prefer
    // those when present so remaining=0 is caught for the RateLimitError path.
    const xRem = res.headers.get('x-ratelimit-remaining');
    const xLim = res.headers.get('x-ratelimit-limit');
    const xReset = res.headers.get('x-ratelimit-reset');
    if (xRem !== null && xLim !== null) {
      return {
        remaining: Number.parseInt(xRem, 10),
        limit: Number.parseInt(xLim, 10),
        resetAt: xReset !== null ? Number.parseInt(xReset, 10) : 0,
      };
    }
    // RFC 9211: ratelimit = "policy";r=<remaining>;t=<window-sec>,
    // ratelimit-policy = "policy";q=<limit>;w=<window-sec>.
    const rlHeader = res.headers.get('ratelimit');
    if (rlHeader === null) return null;
    const remaining = paramInt(rlHeader, 'r');
    if (remaining === null) return null;
    const policy = res.headers.get('ratelimit-policy') ?? '';
    const limit = paramInt(policy, 'q');
    const windowSec = paramInt(rlHeader, 't') ?? paramInt(policy, 'w') ?? 0;
    // Gitea exposes no absolute reset epoch; approximate as now + window.
    const resetAt = Math.floor(Date.now() / 1000) + windowSec;
    return { remaining, limit: limit ?? 0, resetAt };
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

  /** Gitea takes the literal owner/repo path with segments separated by `/`
   *  (unlike GitLab, which encodes the whole path into one %2F token). Encode
   *  special chars within each segment but keep the slashes literal. */
  function repoPath(repo: RepoRef): string {
    return repo.projectPath.split('/').map(enc).join('/');
  }

  async function getPullRequest(repo: RepoRef, n: number) {
    const url = `${restBase}/repos/${repoPath(repo)}/pulls/${n}`;
    const res = await call(url, { headers: baseHeaders() });
    const rateLimit = parseRateLimit(res);
    if (res.status === 404) throw new PrNotFoundError(n, GITEA_TERMS);
    if (!res.ok) throw new ProviderServerError(host, res.status, res.statusText);
    const body = await readJson<{
      state: string;
      merged: boolean;
      merge_commit_sha: string | null;
      title: string | null;
    }>(res);
    if (!body.merged) {
      throw new PrNotMergedError(n, body.state === 'closed' ? 'closed' : 'open', GITEA_TERMS);
    }
    const sha = body.merge_commit_sha;
    if (sha == null) throw new PrMergeCommitUnavailableError(n, GITEA_TERMS);
    return { merged: true as const, mergeCommitSha: sha, title: body.title ?? null, rateLimit };
  }

  async function getIssueClosingCommit(repo: RepoRef, n: number): Promise<IssueResolution> {
    const url = `${restBase}/repos/${repoPath(repo)}/issues/${n}`;
    const res = await call(url, { headers: baseHeaders() });
    const rateLimit = parseRateLimit(res);
    if (res.status === 404) throw new IssueNotFoundError(n);
    if (!res.ok) throw new ProviderServerError(host, res.status, res.statusText);
    const issue = await readJson<{ state: string; title?: string | null }>(res);
    const title = issue.title ?? null;
    // Gitea's basic issue API has no reliable "closing PR" link (no closed_by).
    // A closed issue with no discoverable fix renders the closed_without_fix
    // card (graceful — issue-input is a secondary CUJ). Closing-PR resolution
    // via the timeline API is a follow-up, not a correctness gap.
    if (issue.state !== 'closed') {
      return { state: 'open', title, rateLimit };
    }
    return { state: 'closed_without_fix', title, notPlanned: false, rateLimit };
  }

  async function getCommit(repo: RepoRef, sha: string) {
    const url = `${restBase}/repos/${repoPath(repo)}/git/commits/${enc(sha)}`;
    const res = await call(url, { headers: baseHeaders() });
    const rateLimit = parseRateLimit(res);
    if (res.status === 404) throw new CommitNotFoundError(sha);
    if (!res.ok) throw new ProviderServerError(host, res.status, res.statusText);
    const body = await readJson<{
      sha: string;
      created?: string;
      commit?: {
        message?: string;
        committer?: { date?: string };
        author?: { date?: string };
      };
    }>(res);
    const message = body.commit?.message ?? '';
    return {
      fullSha: body.sha,
      committedDate:
        body.commit?.committer?.date ?? body.created ?? body.commit?.author?.date ?? '',
      subject: message.split('\n')[0] || null,
      rateLimit,
    };
  }

  async function listTagsWithDates(repo: RepoRef) {
    const tags: TagWithDate[] = [];
    let rateLimit: RateLimitInfo | null = null;
    for (let page = 1; page <= MAX_TAG_PAGES; page++) {
      const url = `${restBase}/repos/${repoPath(repo)}/tags?limit=${PAGE_SIZE}&page=${page}`;
      const res: Response = await call(url, { headers: baseHeaders() });
      rateLimit = parseRateLimit(res) ?? rateLimit;
      if (!res.ok) throw new ProviderServerError(host, res.status, res.statusText);
      const body = await readJson<GiteaTag[]>(res);
      for (const t of body) {
        const decoded = decodeTag(t);
        if (decoded) tags.push(decoded);
      }
      // A short page is the last one. (Gitea also returns x-total-count, but the
      // short-page heuristic is robust and matches the GitHub provider's approach.)
      if (body.length < PAGE_SIZE) break;
    }
    return { tags, rateLimit };
  }

  async function compareCommits(repo: RepoRef, base: string, head: string) {
    // Gitea's /compare/{base}...{head} returns { total_commits, commits, files } —
    // NO GitHub-style 4-way status. total_commits = commits in HEAD not in BASE.
    // find-release calls compareCommits(repo, base=tag.sha, head=commit) and treats
    // 'behind'|'identical' as "the tag CONTAINS the commit":
    //   base === head                        → identical
    //   total_commits === 0 (head ⊆ base)    → behind   (base contains head)
    //   total_commits > 0                    → ahead    (not contained; diverged
    //                                                   collapses safely into ahead,
    //                                                   matching the GitLab provider)
    const url = `${restBase}/repos/${repoPath(repo)}/compare/${base}...${head}`;
    const res = await call(url, { headers: baseHeaders() });
    const rateLimit = parseRateLimit(res);
    if (res.status === 404) return { status: 'diverged' as const, rateLimit };
    if (!res.ok) throw new ProviderServerError(host, res.status, res.statusText);
    const body = await readJson<{ total_commits?: number; commits?: unknown[] }>(res);
    if (base === head) return { status: 'identical' as const, rateLimit };
    if ((body.total_commits ?? body.commits?.length ?? 0) === 0) {
      return { status: 'behind' as const, rateLimit };
    }
    return { status: 'ahead' as const, rateLimit };
  }

  async function getReleaseNotes(repo: RepoRef, tag: string) {
    const url = `${restBase}/repos/${repoPath(repo)}/releases/tags/${enc(tag)}`;
    const res = await call(url, { headers: baseHeaders() });
    const rateLimit = parseRateLimit(res);
    if (res.status === 404) return { body: null, isPrerelease: null, rateLimit };
    if (!res.ok) throw new ProviderServerError(host, res.status, res.statusText);
    const body = await readJson<{ body?: string | null; prerelease?: boolean }>(res);
    return { body: body.body ?? null, isPrerelease: body.prerelease ?? null, rateLimit };
  }

  return {
    host,
    kind: 'gitea',
    terms: GITEA_TERMS,
    getPullRequest,
    getIssueClosingCommit,
    getCommit,
    listTagsWithDates,
    compareCommits,
    getReleaseNotes,
    urls,
  };
}

// --- helpers -----------------------------------------------------------------

type GiteaTag = {
  name: string;
  commit?: { sha?: string; created?: string };
};

function decodeTag(t: GiteaTag): TagWithDate | null {
  const sha = t.commit?.sha;
  if (!sha) return null;
  return {
    name: t.name,
    sha,
    date: t.commit?.created ?? '',
    isPrerelease: isPrereleaseTag(t.name),
  };
}

/** Extract `<key>=<int>` from an RFC 9211 header value like `"p";r=1992;t=600`. */
function paramInt(header: string, key: string): number | null {
  const m = header.match(new RegExp(`${key}=(\\d+)`));
  return m?.[1] ? Number.parseInt(m[1], 10) : null;
}
