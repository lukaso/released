// Shared constants — referenced everywhere, no hard-coded numbers in callers.

/** Maximum number of inputs accepted in a single bulk lookup request. */
export const MAX_BULK = 10;

/** OG template version segment used in cache keys for the rendered permalink HTML
 *  and the OG image PNG. Bumping this invalidates both without disturbing the data cache. */
export const OG_TEMPLATE_VERSION = 'og.v1';

/** Cache key namespace prefix. Bumped to v2 when federation landed (RepoRef shape
 *  changed; keys now include host to keep github.com/foo/bar and gitlab.com/foo/bar
 *  in independent cache slots). Bumped to v3 when the GitLab containingTags
 *  shortcut landed — galloping was wrong for parallel-release-branch projects
 *  (it would say "not yet released" for commits backported to maintenance
 *  branches like GTK's gtk-3-24), so previously-cached "wrong" answers must
 *  not be served. */
export const CACHE_NS = 'v3';

/** Default safety margin for date-based tag culling (ms). Tags whose commit-date
 *  is more than this far BEFORE the input commit's date are dropped as candidates.
 *  90 days catches every realistic clock-skew / time-zone / CI-clock case while
 *  still pruning ancient CVS/SVN-imported tags (decades old) instantly. Disable
 *  per-call with `strict: true` if you have a repo with manually-backdated commits. */
export const DEFAULT_DATE_CULL_MARGIN_MS = 90 * 24 * 60 * 60 * 1000;

/** A repository identifier, host-aware so the same algorithm runs against
 *  github.com, gitlab.com, gitlab.gnome.org, salsa.debian.org, etc.
 *
 *  - `host` is the bare hostname ("github.com", "gitlab.gnome.org"), no scheme.
 *  - `projectPath` is the rest of the URL between host and resource:
 *      GitHub: "owner/repo" (always exactly two segments)
 *      GitLab: "group/repo" OR "group/subgroup/.../repo" (N segments)
 *    No leading or trailing slash. */
export type RepoRef = {
  readonly host: string;
  readonly projectPath: string;
};

/** Convenience: the (owner, repo) tuple some GitHub-shaped callers expect.
 *  Throws if the projectPath isn't exactly two segments — only call this on
 *  RepoRefs you know are GitHub. */
export function githubOwnerRepo(r: RepoRef): { owner: string; repo: string } {
  const parts = r.projectPath.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`githubOwnerRepo: expected "owner/repo", got "${r.projectPath}"`);
  }
  return { owner: parts[0], repo: parts[1] };
}

/** Display name for a repo: "facebook/react", "GNOME/gimp", "gitlab-org/security-products/foo". */
export function displayName(r: RepoRef): string {
  return r.projectPath;
}

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
 *  nightly, canary, dev, preview — when preceded by `-`, `.`, or `_` and
 *  followed by `-`, `.`, `_`, a digit, or end-of-string.
 *  Underscore-separated forms catch GIMP-style tags like GIMP_3_2_0_RC1. */
export function isPrereleaseTag(name: string): boolean {
  return /(?:^|[\-._])(?:alpha|beta|rc|pre|preview|snapshot|nightly|canary|dev)(?:[\-._]|\d|$)/i.test(
    name,
  );
}

/** A release that contains the input commit. */
export type ReleaseHit = {
  readonly tag: string;
  readonly sha: string;
  readonly date: string;
  readonly url: string;
};

/** Rate-limit metadata surfaced from every provider API response. */
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
  /** Human headline for the lookup: the PR/MR title for `pr` inputs, or the
   *  commit subject (first message line) for `commit` inputs. null when the
   *  provider didn't surface one. Used by the web copy formats to make pasted
   *  badges / snippets self-describing. */
  readonly subject?: string | null;
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
  /** True iff the provider explicitly flagged firstRelease as a prerelease
   *  (and our tag-name heuristic didn't catch it). The UI surfaces this as a
   *  "heads up" banner so the user knows the answer is what GitHub considers
   *  a prerelease even though the algorithm picked it as the first hit.
   *  null/undefined = no signal (provider doesn't expose a flag, or no Release
   *  object exists for the tag). */
  readonly firstReleaseIsPrerelease?: boolean;
  /** Pre-built URLs the algorithm populated via the provider. Web/CLI consume
   *  these instead of templating provider-specific URLs themselves. */
  readonly urls: {
    readonly repo: string;
    readonly commit: string;
    /** Present only when input.kind === 'pr' (PR on GitHub, MR on GitLab). */
    readonly pullRequest?: string;
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
