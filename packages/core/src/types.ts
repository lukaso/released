// Shared constants — referenced everywhere, no hard-coded numbers in callers.

/** Maximum number of inputs accepted in a single bulk lookup request. */
export const MAX_BULK = 10;

/** OG template version segment used in cache keys for the rendered permalink HTML
 *  and the OG image PNG. Bumping this invalidates both without disturbing the data cache. */
export const OG_TEMPLATE_VERSION = 'og.v1';

/** Cache key namespace prefix. Bumping to v2 invalidates everything cleanly. */
export const CACHE_NS = 'v1';

/** Default safety margin for date-based tag culling (ms). Tags whose commit-date
 *  is more than this far BEFORE the input commit's date are dropped as candidates.
 *  90 days catches every realistic clock-skew / time-zone / CI-clock case while
 *  still pruning ancient CVS/SVN-imported tags (decades old) instantly. Disable
 *  per-call with `strict: true` if you have a repo with manually-backdated commits. */
export const DEFAULT_DATE_CULL_MARGIN_MS = 90 * 24 * 60 * 60 * 1000;

/** A repository identifier on GitHub. */
export type RepoRef = {
  readonly owner: string;
  readonly repo: string;
};

/** Parsed user input — what to look up. */
export type LookupInput =
  | { readonly kind: 'commit'; readonly repo: RepoRef; readonly sha: string }
  | { readonly kind: 'pr'; readonly repo: RepoRef; readonly number: number };

/** A tag with its best-available release date (Release `published_at` > annotated
 *  tagger date > tagged commit's committer date). Date is for *ordering only*,
 *  never as a containment filter (see find-release.ts and D24). */
export type TagWithDate = {
  readonly name: string;
  readonly sha: string;
  readonly date: string; // ISO 8601
  /** True if the tag name matches a known prerelease pattern (-alpha, -beta,
   *  -rc, -pre, -snapshot, -nightly, -dev, -canary). Tag-name heuristic only —
   *  we don't fetch the Release object's `prerelease` field per-tag because
   *  that'd add N more API calls. */
  readonly isPrerelease?: boolean;
};

/** Tag-name heuristic: does this look like a prerelease tag? Conservative — only
 *  flags well-known suffixes; everything else is treated as a production tag.
 *  Detected substrings (case-insensitive): alpha, beta, rc, pre, snapshot,
 *  nightly, canary, dev (when preceded by `-` or `.`), preview. */
export function isPrereleaseTag(name: string): boolean {
  return /(?:^|[\-.])(?:alpha|beta|rc|pre|preview|snapshot|nightly|canary|dev)(?:[\-.]|\d|$)/i.test(name);
}

/** A release that contains the input commit. */
export type ReleaseHit = {
  readonly tag: string;
  readonly sha: string;
  readonly date: string;
  readonly url: string;
};

/** Rate-limit metadata surfaced from every GitHub API response. */
export type RateLimitInfo = {
  readonly remaining: number;
  readonly limit: number;
  /** Reset time as a unix epoch seconds value. */
  readonly resetAt: number;
};

/** Final shape returned by findRelease on success. */
export type LookupResult = {
  readonly input: LookupInput;
  readonly canonicalSha: string;
  readonly firstRelease: ReleaseHit | null;
  /** Subsequent releases (in date order) that also contain the commit. */
  readonly alsoIn: readonly ReleaseHit[];
  /** Sanitized HTML excerpt of release notes for the first release, or null. */
  readonly releaseNotesHtml: string | null;
  readonly rateLimit: RateLimitInfo | null;
  /** Set if the algorithm terminated early because of a soft deadline. */
  readonly partial?: {
    readonly reason: 'soft_deadline';
    readonly candidatesTried: number;
  };
};

/** Result of a bulk lookup. Preserves input order. Partial means at least one
 *  sub-lookup was cancelled (rate-limit / network / bulk-deadline). */
export type BulkResult = {
  readonly results: readonly (LookupResult | BulkSubError)[];
  readonly partial?: {
    readonly reason: 'rate_limit_exhausted' | 'bulk_deadline' | 'network_error';
    readonly pendingCount: number;
    readonly resetAt?: number;
  };
};

/** A failure for a single bulk sub-lookup. */
export type BulkSubError = {
  readonly kind: 'error';
  readonly errorName: string;
  readonly message: string;
};
