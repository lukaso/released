// Typed error classes. Every edge case in the plan's table has its own class so
// callers can rescue specific failure modes without `catch (e)` catch-alls.

export abstract class ReleasedError extends Error {
  abstract readonly kind: string;
}

// --- Input parsing -----------------------------------------------------------

/** Thrown when the input is a URL we can't route to any known provider. The error
 *  message includes the supported host list so users can self-serve (and pass the
 *  list to their admin if they want to extend it). */
export class UnsupportedHostError extends ReleasedError {
  readonly kind = 'unsupported_host' as const;
  constructor(
    public readonly host: string,
    public readonly supportedHosts: readonly string[],
  ) {
    super(
      `I don't recognize "${host}". Supported: ${supportedHosts.join(', ')}. ` +
        `If your instance is a GitLab self-hosted, your admin can add it via EXTRA_GITLAB_HOSTS.`,
    );
    this.name = 'UnsupportedHostError';
  }
}

/** Legacy alias kept so existing callers don't break on rename.
 *  @deprecated use {@link UnsupportedHostError} instead. */
export class NonGithubUrlError extends ReleasedError {
  readonly kind = 'non_github_url' as const;
  constructor(public readonly url: string) {
    super(`I don't recognize that URL; got: ${url}`);
    this.name = 'NonGithubUrlError';
  }
}

export class InvalidInputError extends ReleasedError {
  readonly kind = 'invalid_input' as const;
  constructor(input: string) {
    super(
      `Could not parse "${input}". Expected a commit URL, SHA, PR/MR number, or owner/repo@sha.`,
    );
    this.name = 'InvalidInputError';
  }
}

/** Thrown when the input IS a valid SHA (7-40 hex) but no repo context was
 *  provided. The CLI / web UI use this to prompt the user for a repo rather
 *  than showing a generic "couldn't parse" error. */
export class BareShaError extends ReleasedError {
  readonly kind = 'bare_sha' as const;
  constructor(public readonly sha: string) {
    super(
      `${sha} looks like a SHA, but I need a repo too. ` +
        `Try \`owner/repo ${sha}\` or \`owner/repo@${sha}\`.`,
    );
    this.name = 'BareShaError';
  }
}

// --- Commit / PR resolution --------------------------------------------------

export class CommitNotFoundError extends ReleasedError {
  readonly kind = 'commit_not_found' as const;
  constructor(public readonly sha: string) {
    super(`Commit ${sha} not found in this repo.`);
    this.name = 'CommitNotFoundError';
  }
}

export class AmbiguousShaError extends ReleasedError {
  readonly kind = 'ambiguous_sha' as const;
  constructor(public readonly sha: string) {
    super(`Short SHA ${sha} is ambiguous — paste the full SHA.`);
    this.name = 'AmbiguousShaError';
  }
}

/** Provider display vocabulary for PR/MR error messages. Mirrors
 *  {@link Provider.terms} so error copy reads "Merge request !2466" on GitLab
 *  and "Pull request #2466" on GitHub. Defaults to GitHub for back-compat with
 *  callers that don't pass terms. */
export type PrTerms = { mergeRequest: string; mergeRequestPrefix: string };
const DEFAULT_PR_TERMS: PrTerms = { mergeRequest: 'Pull request', mergeRequestPrefix: '#' };
const prRef = (n: number, terms: PrTerms) =>
  `${terms.mergeRequest} ${terms.mergeRequestPrefix}${n}`;

export class PrNotMergedError extends ReleasedError {
  readonly kind = 'pr_not_merged' as const;
  constructor(
    public readonly prNumber: number,
    /** 'open' — still open, may merge later. 'closed' — closed WITHOUT merging,
     *  so it will never produce a merge commit. Drives the message wording. */
    public readonly prState: 'open' | 'closed' = 'open',
    terms: PrTerms = DEFAULT_PR_TERMS,
  ) {
    const ref = prRef(prNumber, terms);
    super(
      prState === 'closed'
        ? `${ref} was closed without being merged.`
        : `${ref} has not been merged yet.`,
    );
    this.name = 'PrNotMergedError';
  }
}

export class PrNotFoundError extends ReleasedError {
  readonly kind = 'pr_not_found' as const;
  constructor(
    public readonly prNumber: number,
    terms: PrTerms = DEFAULT_PR_TERMS,
  ) {
    super(`${prRef(prNumber, terms)} not found.`);
    this.name = 'PrNotFoundError';
  }
}

export class PrMergeCommitUnavailableError extends ReleasedError {
  readonly kind = 'pr_merge_commit_unavailable' as const;
  constructor(
    public readonly prNumber: number,
    terms: PrTerms = DEFAULT_PR_TERMS,
  ) {
    super(`${prRef(prNumber, terms)} is marked merged but its merge commit is not available.`);
    this.name = 'PrMergeCommitUnavailableError';
  }
}

// --- Issue resolution --------------------------------------------------------
// Issues use the `#` sigil on BOTH GitHub and GitLab (only MRs use GitLab's `!`),
// so a literal `#${n}` is correct vocabulary for both providers.

export class IssueNotFoundError extends ReleasedError {
  readonly kind = 'issue_not_found' as const;
  constructor(public readonly issueNumber: number) {
    super(`Issue #${issueNumber} not found.`);
    this.name = 'IssueNotFoundError';
  }
}

/** Thrown when the issue is still OPEN — there is no fix to track to a release
 *  yet. Mirrors PrNotMergedError's "open" case. Short-cache like not-yet: a fix
 *  can still land. */
export class IssueNotClosedError extends ReleasedError {
  readonly kind = 'issue_not_closed' as const;
  constructor(
    public readonly issueNumber: number,
    /** Issue title, so the UI/copy can stay self-describing. */
    public readonly subject: string | null = null,
  ) {
    super(`Issue #${issueNumber} is still open — there's no fix to track to a release yet.`);
    this.name = 'IssueNotClosedError';
  }
}

/** Thrown when the issue is CLOSED but no fixing commit / merged PR/MR could be
 *  found (manual close, `not_planned`, or no auto-close link). COMMON in
 *  practice, not an edge case (#54 research) — the UI must render it as a calm,
 *  normal result matching the other cards' tone, NOT as an error or the
 *  not-released UI, and short-cache it (a fix can still land later). */
export class IssueClosedWithoutFixError extends ReleasedError {
  readonly kind = 'issue_closed_without_fix' as const;
  constructor(
    public readonly issueNumber: number,
    /** True when the issue was closed as *not planned* ("won't fix"), as opposed
     *  to closed-completed with no discoverable linked fix. Drives the wording. */
    public readonly notPlanned: boolean = false,
    public readonly subject: string | null = null,
  ) {
    super(
      notPlanned
        ? `Issue #${issueNumber} was closed as not planned.`
        : `Issue #${issueNumber} was closed, but no fixing commit or merged pull/merge request was found.`,
    );
    this.name = 'IssueClosedWithoutFixError';
  }
}

// --- Tag listing / algorithm -------------------------------------------------

export class NoReleasesError extends ReleasedError {
  readonly kind = 'no_releases' as const;
  constructor() {
    super('This repo has no releases yet.');
    this.name = 'NoReleasesError';
  }
}

export class NotYetReleasedError extends ReleasedError {
  readonly kind = 'not_yet_released' as const;
  constructor(
    public readonly sha: string,
    public readonly commitDate: string,
    /** How many tags were skipped by the date-based cull. When > 0 with a
     *  not-yet-released answer, callers can hint the user to retry with strict mode. */
    public readonly culledTagCount: number = 0,
    /** How many prerelease-pattern tags (alpha/beta/rc/...) were skipped.
     *  When > 0 with a not-yet-released answer, the UI hints "this might be in
     *  a prerelease — try Include prereleases." */
    public readonly prereleasedSkippedCount: number = 0,
    /** Human headline (PR/MR title or commit subject) so the not-yet UI and the
     *  copy formats can stay self-describing even before a release exists. */
    public readonly subject: string | null = null,
  ) {
    super(`Commit ${sha} has landed (committed ${commitDate}) but isn't in a release yet.`);
    this.name = 'NotYetReleasedError';
  }
}

export class LookupTimeoutError extends ReleasedError {
  readonly kind = 'lookup_timeout' as const;
  constructor(public readonly candidatesTried: number) {
    super(
      `Lookup exceeded the hard deadline after checking ${candidatesTried} tags. ` +
        'Try again or use the CLI for very large repos.',
    );
    this.name = 'LookupTimeoutError';
  }
}

// --- HTTP / network ----------------------------------------------------------

export class RateLimitError extends ReleasedError {
  readonly kind = 'rate_limit' as const;
  constructor(
    public readonly resetAt: number,
    /** Which provider's API limit was hit. Lets the UI tailor the message. */
    public readonly providerHost?: string,
  ) {
    const where = providerHost ? `${providerHost} API` : 'Provider API';
    super(`${where} rate limit exhausted. Resets at ${new Date(resetAt * 1000).toISOString()}.`);
    this.name = 'RateLimitError';
  }
}

export class GitHubServerError extends ReleasedError {
  readonly kind = 'github_server_error' as const;
  constructor(
    public readonly status: number,
    public readonly statusText: string,
  ) {
    super(`GitHub API returned ${status} ${statusText}.`);
    this.name = 'GitHubServerError';
  }
}

/** Generic provider-server error (5xx, non-rate-limit 4xx the client didn't translate).
 *  GitlabProvider raises this; GithubProvider keeps the legacy GitHubServerError name. */
export class ProviderServerError extends ReleasedError {
  readonly kind = 'provider_server_error' as const;
  constructor(
    public readonly providerHost: string,
    public readonly status: number,
    public readonly statusText: string,
  ) {
    super(`${providerHost} API returned ${status} ${statusText}.`);
    this.name = 'ProviderServerError';
  }
}

/** Thrown when a provider returned a 2xx with a body that isn't valid JSON.
 *  Almost always an upstream interstitial (CDN challenge, captive portal,
 *  proxy error page) leaking through with a 200. Treated as a transient
 *  upstream-server error from the user's perspective.
 *
 *  Detects two distinct anti-bot systems and tailors the hint:
 *  - **Anubis** (techaro.lol, used by gitlab.freedesktop.org and others):
 *    proof-of-work challenge that fingerprints HTTP/2 + TLS BELOW the UA layer.
 *    workerd's fingerprint gets challenged; Node's (CLI) does not. PRIVATE-TOKEN
 *    does not help — Anubis runs before API auth. Hint points at the CLI.
 *  - **Cloudflare** ("Just a moment..."): authenticated requests are usually
 *    exempt, so the hint points at a provider token. */
export class ProviderJsonError extends ReleasedError {
  readonly kind = 'provider_json_error' as const;
  /** True when the snippet matches Anubis (techaro.lol) — workerd's TLS
   *  fingerprint trips it; the CLI gets through. Exposed as a field so the
   *  web UI can render a CLI-pointing hint without re-regexing the message. */
  readonly looksLikeAnubis: boolean;
  constructor(
    public readonly status: number,
    public readonly snippet: string,
    cause: unknown,
  ) {
    const looksLikeAnubis = /Making sure you|within\.website|techaro\.lol/i.test(snippet);
    const looksLikeCloudflare = /just a moment|cloudflare|checking your browser/i.test(snippet);
    const base = `Upstream provider returned status ${status} but the body wasn't JSON`;
    let detail: string;
    if (looksLikeAnubis) {
      detail =
        " — this host uses Anubis, a proof-of-work anti-bot challenge that fingerprints the Worker's HTTP stack. A provider token does NOT bypass it (Anubis runs before API auth). The CLI works against these hosts because Node's fetch has a different fingerprint: `npx git-released <url>` or `pnpm dlx git-released <url>`.";
    } else if (looksLikeCloudflare) {
      detail =
        ' — it looks like a Cloudflare anti-bot challenge page. Authenticated requests usually skip these; setting a provider token (e.g. GITLAB_TOKEN for the Worker, or `git-released --token=...`) typically resolves it.';
    } else {
      detail = ` (usually a CDN challenge page or proxy error). First chars: ${snippet}`;
    }
    super(base + detail);
    this.name = 'ProviderJsonError';
    this.cause = cause;
    this.looksLikeAnubis = looksLikeAnubis;
  }
}

export class NetworkError extends ReleasedError {
  readonly kind = 'network_error' as const;
  constructor(cause: unknown) {
    super(`Network error reaching the provider: ${(cause as Error)?.message ?? String(cause)}`);
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

export class SanitizeError extends ReleasedError {
  readonly kind = 'sanitize_error' as const;
  constructor(cause: unknown) {
    super(
      `Failed to sanitize release notes markdown: ${(cause as Error)?.message ?? String(cause)}`,
    );
    this.name = 'SanitizeError';
    this.cause = cause;
  }
}

// --- Bulk --------------------------------------------------------------------

export class BulkLimitError extends ReleasedError {
  readonly kind = 'bulk_limit' as const;
  constructor(
    public readonly given: number,
    public readonly max: number,
  ) {
    super(`Bulk lookup accepts at most ${max} inputs; got ${given}. Split into multiple requests.`);
    this.name = 'BulkLimitError';
  }
}
