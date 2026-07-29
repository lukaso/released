// Public API for @released/core.

export { type CacheKind, type CacheStore, cacheKey } from './cache.js';
export {
  AmbiguousShaError,
  BareAliasError,
  BareShaError,
  BulkLimitError,
  CommitNotFoundError,
  GitHubServerError,
  InvalidInputError,
  IssueClosedWithoutFixError,
  IssueNotClosedError,
  IssueNotFoundError,
  LookupTimeoutError,
  NetworkError,
  NonGithubUrlError,
  NoReleasesError,
  NotYetReleasedError,
  PrMergeCommitUnavailableError,
  PrNotFoundError,
  PrNotMergedError,
  ProviderJsonError,
  ProviderServerError,
  RateLimitError,
  ReleasedError,
  SanitizeError,
  UnsupportedHostError,
} from './errors.js';
export {
  type FindReleaseOpts,
  type FindReleasesBulkOpts,
  findRelease,
  findReleasesBulk,
} from './find-release.js';
// Legacy aliases — keep working until consumers migrate to providerFor.
export { type GithubClient, type GithubClientOpts, makeGithubClient } from './github.js';
export { findProjectByAlias, KNOWN_PROJECTS, type KnownProject } from './known-projects.js';
export { type ParseOpts, parseInput } from './parse-input.js';
export type { Provider, ProviderOpts } from './provider.js';
// New provider surface.
export { makeGithubProvider } from './providers/github/client.js';
export { makeGitlabProvider } from './providers/gitlab/client.js';
export {
  isKnownHost,
  KNOWN_GITLAB_HOSTS,
  type ProviderForOpts,
  providerFor,
} from './providers/index.js';
export { renderReleaseNotes } from './release-notes.js';
export {
  type BulkResult,
  type BulkSubError,
  CACHE_NS,
  displayName,
  githubOwnerRepo,
  type LookupInput,
  type LookupResult,
  MAX_BULK,
  OG_TEMPLATE_VERSION,
  type RateLimitInfo,
  type ReleaseHit,
  type RepoRef,
  type TagWithDate,
} from './types.js';
