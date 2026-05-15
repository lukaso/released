// Public API for @released/core.

export { parseInput } from './parse-input.js';
export { makeGithubClient, type GithubClient, type GithubClientOpts } from './github.js';
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
  RateLimitError,
  ReleasedError,
  SanitizeError,
} from './errors.js';
