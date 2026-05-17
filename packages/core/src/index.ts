// Public API for @released/core.

export { parseInput } from './parse-input.js';
// Legacy aliases — keep working until consumers migrate to providerFor.
export { makeGithubClient, type GithubClient, type GithubClientOpts } from './github.js';
// New provider surface.
export { makeGithubProvider } from './providers/github/client.js';
export { makeGitlabProvider } from './providers/gitlab/client.js';
export {
  providerFor,
  isKnownHost,
  KNOWN_GITLAB_HOSTS,
  type ProviderForOpts,
} from './providers/index.js';
export type { Provider, ProviderOpts } from './provider.js';
export {
  findRelease,
  findReleasesBulk,
  type FindReleaseOpts,
  type FindReleasesBulkOpts,
} from './find-release.js';
export { renderReleaseNotes } from './release-notes.js';
export { cacheKey, type CacheKind, type CacheStore } from './cache.js';

export {
  CACHE_NS,
  MAX_BULK,
  OG_TEMPLATE_VERSION,
  displayName,
  githubOwnerRepo,
  type BulkResult,
  type BulkSubError,
  type LookupInput,
  type LookupResult,
  type RateLimitInfo,
  type ReleaseHit,
  type RepoRef,
  type TagWithDate,
} from './types.js';

export {
  AmbiguousShaError,
  BareShaError,
  BulkLimitError,
  CommitNotFoundError,
  GitHubServerError,
  InvalidInputError,
  LookupTimeoutError,
  NetworkError,
  NoReleasesError,
  NonGithubUrlError,
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
