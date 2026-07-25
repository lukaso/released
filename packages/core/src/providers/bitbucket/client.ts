// BitbucketProvider — REST 2.0 implementation of the Provider interface for
// Bitbucket Cloud (bitbucket.org). REST chosen for parity with the GitLab
// provider; Bitbucket's GraphQL is fine but REST keeps the family uniform and
// the algorithm only needs 5 round-trip-shaped calls.
//
// REST host is api.bitbucket.org (a DIFFERENT host from the web host), so the
// default restBase is fixed regardless of the routing `host` — unlike GitLab,
// whose API lives at {host}/api/v4. The provider's `host` field stays
// 'bitbucket.org' for routing/identity.
//
// Auth: Bitbucket repository access tokens and OAuth2 tokens use the Bearer
// scheme, so we send `Authorization: Bearer <token>`. (App passwords, which
// need HTTP Basic with a username, are a different credential shape — not
// expressible via the single-string ProviderOpts.token; public repos work
// unauthenticated regardless.)
//
// Ancestry (the core risk — see find-release.ts): there is no GitHub/GitLab-style
// 4-way compare status. The commits endpoint's include/exclude params give us a
// one-directional set difference: commits?include=A&exclude=B = commits
// reachable from A but not B. We ask include=head&exclude=base; empty ⟹ head is
// an ancestor of base ⟹ the base tag CONTAINS the head commit → 'behind'.
// (Mirrors GitLab's from=base&to=head semantics exactly.)
//
// Rate-limit headers: Bitbucket Cloud does not emit the reliable
// x-ratelimit-{remaining,limit,reset} trio the way GitHub/GitLab do; we read
// them when present and return null otherwise — null rateLimit is safe everywhere.

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
import { makeBitbucketUrls } from './urls.js';

const BITBUCKET_HOST = 'bitbucket.org';
const DEFAULT_REST_BASE = 'https://api.bitbucket.org/2.0';

/** Pagination cap for parity with the GitLab provider (5 pages). Bitbucket's
 *  refs/tags endpoint is one round-trip per page; 5 × 100 = 500 newest tags
 *  covers years of history while bounding the deadline budget. */
const MAX_TAG_PAGES = 5;
const TAG_PAGE_SIZE = 100;

const BITBUCKET_TERMS = { mergeRequest: 'Pull request', mergeRequestPrefix: '#' } as const;

export function makeBitbucketProvider(opts: ProviderOpts = {}): Provider {
  const fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const token = opts.token;
  const ua = opts.userAgent ?? 'released/0.0.0 (+https://released.blabberate.com)';
  const restBase = opts.restBase ?? DEFAULT_REST_BASE;
  const retries = opts.retries ?? 2;
  const host = BITBUCKET_HOST;
  const urls = makeBitbucketUrls(host);

  function baseHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      accept: 'application/json',
      'user-agent': ua,
    };
    if (token) h.authorization = `Bearer ${token}`;
    return h;
  }

  function parseRateLimit(res: Response): RateLimitInfo | null {
    // Bitbucket emits x-ratelimit-* inconsistently; tolerate absence.
    const remaining = res.headers.get('x-ratelimit-remaining');
    const limit = res.headers.get('x-ratelimit-limit');
    const reset = res.headers.get('x-ratelimit-reset');
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

  /** Bitbucket repo identifier in the REST path: /2.0/repositories/{workspace}/{repo_slug}.
   *  projectPath is already exactly that shape (workspace/repo), so it goes in
   *  verbatim — the path segments are URL-safe (no slashes within a segment). */
  function repoPath(repo: RepoRef): string {
    return repo.projectPath
      .split('/')
      .map((seg) => enc(seg))
      .join('/');
  }

  async function getPullRequest(repo: RepoRef, n: number) {
    const url = `${restBase}/repositories/${repoPath(repo)}/pullrequests/${n}`;
    const res = await call(url, { headers: baseHeaders() });
    const rateLimit = parseRateLimit(res);
    if (res.status === 404) throw new PrNotFoundError(n, BITBUCKET_TERMS);
    if (!res.ok) throw new ProviderServerError(host, res.status, res.statusText);
    const body = await readJson<{
      state: string; // OPEN | MERGED | DECLINED | SUPERSEDED
      merge_commit?: { hash?: string | null } | null;
      title?: string | null;
    }>(res);
    if (body.state !== 'MERGED') {
      const detail = body.state === 'DECLINED' || body.state === 'SUPERSEDED' ? 'closed' : 'open';
      throw new PrNotMergedError(n, detail, BITBUCKET_TERMS);
    }
    const sha = body.merge_commit?.hash ?? null;
    if (sha == null) throw new PrMergeCommitUnavailableError(n, BITBUCKET_TERMS);
    return { merged: true as const, mergeCommitSha: sha, title: body.title ?? null, rateLimit };
  }

  async function getIssueClosingCommit(repo: RepoRef, n: number): Promise<IssueResolution> {
    // Bitbucket Cloud's issue tracker exposes no reliable "closing commit"
    // linkage via REST (it predates that convention; the `commits` relation on
    // an issue is best-effort and frequently empty). So we resolve the issue's
    // state honestly: open → open; otherwise closed_without_fix (common). The
    // interface explicitly allows closed_without_fix as a routine outcome.
    const url = `${restBase}/repositories/${repoPath(repo)}/issues/${n}`;
    const res = await call(url, { headers: baseHeaders() });
    const rateLimit = parseRateLimit(res);
    if (res.status === 404) throw new IssueNotFoundError(n);
    if (!res.ok) throw new ProviderServerError(host, res.status, res.statusText);
    const issue = await readJson<{ state: string; title?: string | null }>(res);
    const title = issue.title ?? null;
    // Bitbucket issue states: new | open | resolved | closed | duplicate |
    // wontfix | invalid. Only new/open are "open"; everything else is closed.
    if (issue.state === 'new' || issue.state === 'open') {
      return { state: 'open', title, rateLimit };
    }
    return { state: 'closed_without_fix', title, notPlanned: false, rateLimit };
  }

  async function getCommit(repo: RepoRef, sha: string) {
    const url = `${restBase}/repositories/${repoPath(repo)}/commits/${enc(sha)}`;
    const res = await call(url, { headers: baseHeaders() });
    const rateLimit = parseRateLimit(res);
    if (res.status === 404) throw new CommitNotFoundError(sha);
    if (!res.ok) throw new ProviderServerError(host, res.status, res.statusText);
    const body = await readJson<{ hash: string; date: string; message?: string | null }>(res);
    const message = body.message ?? '';
    const subject = message ? (message.split('\n')[0] ?? null) : null;
    return {
      fullSha: body.hash,
      committedDate: body.date,
      subject,
      rateLimit,
    };
  }

  async function listTagsWithDates(repo: RepoRef) {
    const tags: TagWithDate[] = [];
    let pageUrl: string | null =
      `${restBase}/repositories/${repoPath(repo)}/refs/tags?pagelen=${TAG_PAGE_SIZE}&sort=-target.date`;
    let rateLimit: RateLimitInfo | null = null;
    let pages = 0;
    while (pageUrl && pages < MAX_TAG_PAGES) {
      const res: Response = await call(pageUrl, { headers: baseHeaders() });
      rateLimit = parseRateLimit(res) ?? rateLimit;
      if (!res.ok) throw new ProviderServerError(host, res.status, res.statusText);
      const body = await readJson<BitbucketPage<BitbucketTag>>(res);
      for (const t of body.values ?? []) {
        const decoded = decodeTag(t);
        if (decoded) tags.push(decoded);
      }
      pageUrl = body.next ?? null;
      pages++;
    }
    return { tags, rateLimit };
  }

  async function compareCommits(repo: RepoRef, base: string, head: string) {
    // To test whether `base` (a tag SHA) CONTAINS `head` (the input commit),
    // ask for commits reachable from head but NOT from base:
    //   include=head&exclude=base  →  head_reachable − base_reachable
    //   empty → head is an ancestor of base → base CONTAINS head → 'behind'
    //   present → head is not an ancestor of base → not contained → 'ahead'
    // (Mirrors GitLab's from=base&to=head. find-release treats 'behind'|'identical'
    //  as contains=true.) pagelen=1 is enough to decide empty-vs-present.
    const url = `${restBase}/repositories/${repoPath(repo)}/commits?include=${enc(head)}&exclude=${enc(base)}&pagelen=1`;
    const res = await call(url, { headers: baseHeaders() });
    const rateLimit = parseRateLimit(res);
    if (res.status === 404) return { status: 'diverged' as const, rateLimit };
    if (!res.ok) throw new ProviderServerError(host, res.status, res.statusText);
    const body = await readJson<BitbucketPage<{ hash: string }>>(res);
    if ((body.values?.length ?? 0) === 0) {
      // head is an ancestor of (or equal to) base → base CONTAINS head.
      return { status: 'behind' as const, rateLimit };
    }
    // base...head has commits reachable from head not in base → not contained.
    return { status: 'ahead' as const, rateLimit };
  }

  async function getReleaseNotes() {
    // Bitbucket Cloud has no GitHub/GitLab-style Releases API with a notes body,
    // and no provider-authoritative prerelease flag. No network call needed —
    // return nulls and let the UI fall back to the tag-name heuristic.
    return { body: null, isPrerelease: null, rateLimit: null };
  }

  return {
    host,
    kind: 'bitbucket',
    terms: BITBUCKET_TERMS,
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

/** Bitbucket paginated envelope: { values, next, page, pagelen, size }. */
type BitbucketPage<T> = {
  values?: T[];
  next?: string | null;
  page?: number;
  pagelen?: number;
  size?: number;
};

/** A tag in /refs/tags. `target` is the commit the tag resolves to (Bitbucket
 *  dereferences annotated tag objects to the underlying commit in this listing). */
type BitbucketTag = {
  name: string;
  target?: { hash?: string; date?: string } | null;
};

function decodeTag(t: BitbucketTag): TagWithDate | null {
  if (!t.target?.hash) return null;
  return {
    name: t.name,
    sha: t.target.hash,
    date: t.target.date ?? '',
    isPrerelease: isPrereleaseTag(t.name),
  };
}
