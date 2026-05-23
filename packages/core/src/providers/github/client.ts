// GithubProvider — REST + GraphQL implementation of the Provider interface.
// Hand-rolled rather than @octokit/* to keep the Worker bundle small.

import {
  AmbiguousShaError,
  CommitNotFoundError,
  GitHubServerError,
  PrMergeCommitUnavailableError,
  PrNotFoundError,
  PrNotMergedError,
} from '../../errors.js';
import type { Provider, ProviderOpts } from '../../provider.js';
import {
  type RateLimitInfo,
  type RepoRef,
  type TagWithDate,
  githubOwnerRepo,
  isPrereleaseTag,
} from '../../types.js';
import { callWithRetry, enc, readJson } from '../http.js';
import { githubUrls } from './urls.js';

const DEFAULT_REST_BASE = 'https://api.github.com';
const DEFAULT_GQL_ENDPOINT = 'https://api.github.com/graphql';

const GITHUB_TERMS = { mergeRequest: 'Pull request', mergeRequestPrefix: '#' } as const;

/** First non-empty line of a commit message (the "subject"), trimmed. */
function firstLine(message: string | undefined | null): string | null {
  if (!message) return null;
  const line = message.split('\n', 1)[0]?.trim();
  return line ? line : null;
}

const TAGS_QUERY = `
  query($owner:String!,$name:String!,$cursor:String){
    repository(owner:$owner,name:$name){
      refs(refPrefix:"refs/tags/",first:100,after:$cursor,orderBy:{field:TAG_COMMIT_DATE,direction:DESC}){
        nodes{
          name
          target{
            __typename
            ... on Commit { oid committedDate }
            ... on Tag { tagger { date } target { ... on Commit { oid committedDate } } }
          }
        }
        pageInfo{ hasNextPage endCursor }
      }
    }
  }
`;

export function makeGithubProvider(opts: ProviderOpts = {}): Provider {
  // Bind fetch so calls inside Cloudflare Workers don't trip the
  // "Illegal invocation: function called with incorrect `this` reference" check
  // — destructuring globalThis.fetch into a variable loses its `this`.
  const fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const token = opts.token;
  const ua = opts.userAgent ?? 'released/0.0.0 (+https://released.blabberate.com)';
  const restBase = opts.restBase ?? DEFAULT_REST_BASE;
  const gqlEndpoint = opts.graphqlEndpoint ?? DEFAULT_GQL_ENDPOINT;
  const retries = opts.retries ?? 2;
  const HOST = 'github.com';

  function baseHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': ua,
    };
    if (token) h.authorization = `Bearer ${token}`;
    return h;
  }

  function parseRateLimit(res: Response): RateLimitInfo | null {
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
    providerHost: HOST,
    parseRateLimit,
    makeServerError: (status: number, statusText: string) =>
      new GitHubServerError(status, statusText),
  };
  const call = (url: string, init: RequestInit) => callWithRetry(url, init, callOpts);

  async function getPullRequest(repo: RepoRef, n: number) {
    const { owner, repo: name } = githubOwnerRepo(repo);
    const url = `${restBase}/repos/${enc(owner)}/${enc(name)}/pulls/${n}`;
    const res = await call(url, { headers: baseHeaders() });
    const rateLimit = parseRateLimit(res);
    if (res.status === 404) throw new PrNotFoundError(n, GITHUB_TERMS);
    if (!res.ok) throw new GitHubServerError(res.status, res.statusText);
    const body = await readJson<{
      merged: boolean;
      state: string;
      merge_commit_sha: string | null;
      title: string | null;
    }>(res);
    if (!body.merged) {
      throw new PrNotMergedError(n, body.state === 'closed' ? 'closed' : 'open', GITHUB_TERMS);
    }
    if (body.merge_commit_sha == null) throw new PrMergeCommitUnavailableError(n, GITHUB_TERMS);
    return {
      merged: true as const,
      mergeCommitSha: body.merge_commit_sha,
      title: body.title ?? null,
      rateLimit,
    };
  }

  async function getCommit(repo: RepoRef, sha: string) {
    const { owner, repo: name } = githubOwnerRepo(repo);
    const url = `${restBase}/repos/${enc(owner)}/${enc(name)}/commits/${enc(sha)}`;
    const res = await call(url, { headers: baseHeaders() });
    const rateLimit = parseRateLimit(res);
    if (res.status === 404) throw new CommitNotFoundError(sha);
    if (res.status === 422) throw new AmbiguousShaError(sha);
    if (!res.ok) throw new GitHubServerError(res.status, res.statusText);
    const body = await readJson<{
      sha: string;
      commit: { committer: { date: string }; message?: string };
    }>(res);
    return {
      fullSha: body.sha,
      committedDate: body.commit.committer.date,
      subject: firstLine(body.commit.message),
      rateLimit,
    };
  }

  async function listTagsWithDates(repo: RepoRef) {
    const { owner, repo: name } = githubOwnerRepo(repo);
    const tags: TagWithDate[] = [];
    let cursor: string | null = null;
    let rateLimit: RateLimitInfo | null = null;
    // Pagination cap (D38): GraphQL returns 100 tags/page sorted DESC by
    // commit-date. 5 pages = 500 newest tags, which covers ~years of recent
    // history in even kubernetes-scale repos. Beyond that the latency tax
    // (5+ sequential round-trips) eats the deadline. Strict mode disables
    // this cap so very-old commits in huge repos can still be looked up.
    const MAX_PAGES = 5;
    let pages = 0;
    for (;;) {
      const res = await call(gqlEndpoint, {
        method: 'POST',
        headers: { ...baseHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ query: TAGS_QUERY, variables: { owner, name, cursor } }),
      });
      rateLimit = parseRateLimit(res) ?? rateLimit;
      if (!res.ok) throw new GitHubServerError(res.status, res.statusText);
      const body = await readJson<GraphqlTagsResponse>(res);
      const refs = body.data?.repository?.refs;
      if (!refs) break;
      for (const node of refs.nodes ?? []) {
        const decoded = decodeTagNode(node);
        if (decoded) tags.push(decoded);
      }
      pages++;
      if (!refs.pageInfo?.hasNextPage || !refs.pageInfo.endCursor) break;
      if (pages >= MAX_PAGES) break;
      cursor = refs.pageInfo.endCursor;
    }
    return { tags, rateLimit };
  }

  async function compareCommits(repo: RepoRef, base: string, head: string) {
    const { owner, repo: name } = githubOwnerRepo(repo);
    const url = `${restBase}/repos/${enc(owner)}/${enc(name)}/compare/${enc(base)}...${enc(head)}`;
    const res = await call(url, { headers: baseHeaders() });
    const rateLimit = parseRateLimit(res);
    // GitHub returns 404 ("No common ancestor between ...") for unrelated
    // histories (common in repos with CVS/SVN-imported pre-history tags), and
    // 422 for "diverged" comparisons that can't be expressed as a single diff.
    // Both mean the same thing for our purposes: this tag does NOT contain the
    // input commit. Keep walking the candidate list rather than failing the lookup.
    if (res.status === 422 || res.status === 404) {
      return { status: 'diverged' as const, rateLimit };
    }
    if (!res.ok) throw new GitHubServerError(res.status, res.statusText);
    const body = await readJson<{ status: 'behind' | 'identical' | 'ahead' | 'diverged' }>(res);
    return { status: body.status, rateLimit };
  }

  async function getReleaseNotes(repo: RepoRef, tag: string) {
    const { owner, repo: name } = githubOwnerRepo(repo);
    const url = `${restBase}/repos/${enc(owner)}/${enc(name)}/releases/tags/${enc(tag)}`;
    const res = await call(url, { headers: baseHeaders() });
    const rateLimit = parseRateLimit(res);
    // 404 = no Release object exists for this tag. We don't know if it's a
    // prerelease per GitHub since GitHub has no opinion to give.
    if (res.status === 404) return { body: null, isPrerelease: null, rateLimit };
    if (!res.ok) throw new GitHubServerError(res.status, res.statusText);
    const body = await readJson<{ body?: string | null; prerelease?: boolean }>(res);
    return {
      body: body.body ?? null,
      isPrerelease: body.prerelease ?? null,
      rateLimit,
    };
  }

  return {
    host: HOST,
    kind: 'github',
    terms: GITHUB_TERMS,
    getPullRequest,
    getCommit,
    listTagsWithDates,
    compareCommits,
    getReleaseNotes,
    urls: githubUrls,
  };
}

// --- GraphQL response shape --------------------------------------------------

type GraphqlTagsResponse = {
  data?: {
    repository?: {
      refs?: {
        nodes?: GraphqlTagNode[];
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      };
    };
  };
};

type GraphqlTagNode = {
  name: string;
  target?:
    | { __typename: 'Commit'; oid: string; committedDate: string }
    | {
        __typename: 'Tag';
        tagger?: { date?: string };
        target?: { __typename: 'Commit'; oid: string; committedDate: string };
      };
};

function decodeTagNode(node: GraphqlTagNode): TagWithDate | null {
  const t = node.target;
  if (!t) return null;
  const isPrerelease = isPrereleaseTag(node.name);
  if (t.__typename === 'Commit') {
    return { name: node.name, sha: t.oid, date: t.committedDate, isPrerelease };
  }
  // Annotated tag: prefer tagger date over the underlying commit date.
  const inner = t.target;
  if (!inner) return null;
  return {
    name: node.name,
    sha: inner.oid,
    date: t.tagger?.date ?? inner.committedDate,
    isPrerelease,
  };
}
