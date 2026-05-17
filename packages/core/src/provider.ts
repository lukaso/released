// Provider interface — every git host (GitHub, GitLab, Bitbucket, Gitea, ...) implements
// these 5 methods + url builders + display terms. The algorithm in find-release.ts
// is provider-agnostic and consumes this interface unchanged across all providers.

import type { RateLimitInfo, RepoRef, TagWithDate } from './types.js';

/** Common options that any provider factory accepts. */
export type ProviderOpts = {
  /** Injectable fetch (defaults to global `fetch`). */
  fetch?: typeof fetch;
  /** API token: PAT for GitHub, PAT for GitLab. When unset, calls go anonymous. */
  token?: string | undefined;
  /** Custom User-Agent header value. */
  userAgent?: string;
  /** Override the REST API base (test/staging). */
  restBase?: string;
  /** Override the GraphQL endpoint (test/staging) — GitHub only; GitLab ignores. */
  graphqlEndpoint?: string;
  /** Max retries on 5xx (default 2 → 3 total attempts). */
  retries?: number;
};

export interface Provider {
  /** The hostname this provider talks to: 'github.com' | 'gitlab.gnome.org' | … */
  readonly host: string;
  /** Family tag — UI rarely needs this; prefer reading `terms` for vocabulary. */
  readonly kind: 'github' | 'gitlab';
  /** Display vocabulary — UI reads these instead of switching on `kind`. Future
   *  providers (Bitbucket, Gitea, Sourcehut) self-describe their terms. */
  readonly terms: {
    /** "Pull request" (GitHub/Bitbucket/Gitea) | "Merge request" (GitLab) | "Patch" (Sourcehut) */
    readonly mergeRequest: string;
    /** "#" (GitHub) | "!" (GitLab) — GitLab's MR convention uses ! to distinguish from # issues. */
    readonly mergeRequestPrefix: string;
  };
  /** Resolve a PR/MR number to its merge commit SHA. Throws PrNotMergedError if
   *  the PR is not yet merged, PrMergeCommitUnavailableError if merged but the
   *  merge SHA isn't recorded, PrNotFoundError on 404. */
  getPullRequest(
    repo: RepoRef,
    n: number,
  ): Promise<{ merged: true; mergeCommitSha: string; rateLimit: RateLimitInfo | null }>;
  /** Resolve a commit (possibly a short SHA) to its full SHA + committed date. */
  getCommit(
    repo: RepoRef,
    sha: string,
  ): Promise<{ fullSha: string; committedDate: string; rateLimit: RateLimitInfo | null }>;
  /** List repository tags newest-first, with their best-available release date. */
  listTagsWithDates(
    repo: RepoRef,
  ): Promise<{ tags: TagWithDate[]; rateLimit: RateLimitInfo | null }>;
  /** Three-way ancestry status between two commits. "behind" or "identical" means
   *  `base` is an ancestor of (or equal to) `head` — i.e. base CONTAINS head's
   *  commit if `base` is a release tag's SHA. */
  compareCommits(
    repo: RepoRef,
    base: string,
    head: string,
  ): Promise<{
    status: 'behind' | 'identical' | 'ahead' | 'diverged';
    rateLimit: RateLimitInfo | null;
  }>;
  /** Get the release notes body for a tag, or null if no Release object exists.
   *  `isPrerelease` is the provider's authoritative prerelease flag (GitHub
   *  returns it on the Release object). null = provider has no opinion (no
   *  Release object exists, or this provider doesn't expose a flag — GitLab). */
  getReleaseNotes(
    repo: RepoRef,
    tag: string,
  ): Promise<{
    body: string | null;
    isPrerelease: boolean | null;
    rateLimit: RateLimitInfo | null;
  }>;
  /** URL builders. Algorithm and UI consume these instead of templating strings.
   *  The PR/MR URL uses the provider's own conventions (/pull/N on GitHub,
   *  /-/merge_requests/N on GitLab). */
  readonly urls: {
    repo(r: RepoRef): string;
    commit(r: RepoRef, sha: string): string;
    pullRequest(r: RepoRef, n: number): string;
    release(r: RepoRef, tag: string): string;
  };
}
