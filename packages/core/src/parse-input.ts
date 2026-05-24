// Smart-input parser (CP5).
// Accepts the single-arg "paste anything reasonable" form and the explicit
// two-arg form (repoUrl, ref).
//
// After federation: returns the host-aware RepoRef shape. GitHub URL shapes
// live here; GitLab URL shapes live in parsers/gitlab.ts (Lane D). The
// dispatcher (parsers/index.ts) routes URLs to the right table by host.

import {
  BareShaError,
  InvalidInputError,
  NonGithubUrlError,
  type ReleasedError,
  UnsupportedHostError,
} from './errors.js';
import { type KnownProject, findProjectByAlias } from './known-projects.js';
import { KNOWN_GITLAB_HOSTS } from './providers/index.js';
import type { LookupInput, RepoRef } from './types.js';

/**
 * Extension hook for {@link parseInput}. Mirrors the `extraGitlabHosts`
 * shape from `providers/index.ts` — callers (CLI flag, web env var) can
 * override the curated `KNOWN_PROJECTS` catalog without touching core.
 */
export type ParseOpts = {
  readonly aliases?: readonly KnownProject[];
};

/** Pull the first `n` capture groups from a successful regex match, asserting
 *  each is present. Every regex in this file has fixed, known capture arity, so
 *  a missing group means the pattern and its call site have drifted — a
 *  programmer error worth throwing on, not silently coercing to undefined.
 *
 *  Overloaded to return a fixed-length tuple so destructured groups are typed
 *  `string` (not `string | undefined`) — array destructuring is still subject
 *  to noUncheckedIndexedAccess, but tuple element access is not. */
function captures(m: RegExpMatchArray, n: 1): [string];
function captures(m: RegExpMatchArray, n: 2): [string, string];
function captures(m: RegExpMatchArray, n: 3): [string, string, string];
function captures(m: RegExpMatchArray, n: number): string[] {
  const out: string[] = [];
  for (let i = 1; i <= n; i++) {
    const g = m[i];
    if (g === undefined) throw new Error(`parse-input: match missing capture group ${i}/${n}`);
    out.push(g);
  }
  return out;
}

/** Split an "owner/repo" string (already validated against BARE_OWNER_REPO_RE)
 *  into its two parts, asserting both are present. The regex guarantees exactly
 *  one slash, so a failure here means validation and this split have drifted. */
function splitOwnerRepo(s: string): [string, string] {
  const [owner, name] = s.split('/');
  if (owner === undefined || name === undefined) {
    throw new Error(`parse-input: "${s}" is not owner/repo shaped`);
  }
  return [owner, name];
}

const SHA_RE = /^[0-9a-f]{7,40}$/i;
const PR_REF_RE = /^#?\d+$/;
// Any github URL form that carries an unambiguous (repo, sha) tuple. Trailing
// path / .patch / .diff suffixes are allowed and ignored — we only need the SHA.
//
//   /commit/{sha}                                      — commit detail page
//   /commit/{sha}.patch  /commit/{sha}.diff            — raw patch URLs
//   /commits/{sha}[/path]                              — file history AT SHA (the surface that bit us)
//   /blob/{sha}/{path}                                 — file view at SHA
//   /tree/{sha}[/path]                                 — tree browse at SHA
//   /blame/{sha}/{path}                                — blame at SHA
//   /raw/{sha}/{path}                                  — raw bytes at SHA
const GITHUB_SHA_URL_RE =
  /^(?:https?:\/\/)?github\.com\/([\w.-]+)\/([\w.-]+)\/(?:commit|commits|blob|tree|blame|raw)\/([0-9a-f]{7,40})(?:\.(?:patch|diff))?(?:\/.*)?$/i;
// /pull/{N}/commits/{sha}  /pull/{N}/changes/{sha}  /pull/{N}/files/{sha}
// — these URL forms reference a SPECIFIC commit inside a PR's history. We
// treat them as commit lookups (more specific than the whole PR).
const PR_COMMIT_URL_RE =
  /^(?:https?:\/\/)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/\d+\/(?:commits|changes|files)\/([0-9a-f]{7,40})(?:\/.*)?$/i;
const PR_URL_RE = /^(?:https?:\/\/)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:\/.*)?$/i;
const OWNER_REPO_AT_SHA_RE = /^([\w.-]+)\/([\w.-]+)@([0-9a-f]{7,40})$/i;
const OWNER_REPO_HASH_PR_RE = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;
const REPO_SSH_RE = /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i;
const REPO_URL_RE = /^(?:https?:\/\/)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i;
const BARE_OWNER_REPO_RE = /^([\w.-]+)\/([\w.-]+)$/;
// Catch-all: a github.com URL we DID see is github, just couldn't parse its
// shape. Used to surface a more honest error than "non-GitHub URL".
const ANY_GITHUB_URL_RE = /^(?:https?:\/\/)?github\.com\//i;

// GitLab URL shapes (note the /-/ infix that disambiguates nested subgroups
// from resource segments). Project path captured greedily as `(.+?)`.
//   /<group>(/<sub>)*/<project>/-/commit/{sha}[/path][.patch|.diff]
//   /<group>(/<sub>)*/<project>/-/commits/{sha}[/path]
//   /<group>(/<sub>)*/<project>/-/blob|tree|blame|raw/{sha}/{path}
//   /<group>(/<sub>)*/<project>/-/merge_requests/{iid}[/diffs|commits|...]
//
// Host portion captured so dispatcher knows which GitLab instance.
const GITLAB_SHA_URL_RE =
  /^(?:https?:\/\/)?([\w.-]+)\/(.+?)\/-\/(?:commit|commits|blob|tree|blame|raw)\/([0-9a-f]{7,40})(?:\.(?:patch|diff))?(?:\/.*)?$/i;
const GITLAB_MR_URL_RE = /^(?:https?:\/\/)?([\w.-]+)\/(.+?)\/-\/merge_requests\/(\d+)(?:\/.*)?$/i;
const ANY_GITLAB_URL_RE = /^(?:https?:\/\/)?([\w.-]+)\/(?:.+?)\/-\//i;

const GITHUB_HOST = 'github.com';

/**
 * Parse user input into a canonical {@link LookupInput}.
 *
 * Single-arg form (`input` only): accepts a GitHub or supported-GitLab commit URL,
 * PR/MR URL, `owner/repo@sha` shorthand (GitHub), or `owner/repo#pr` shorthand (GitHub).
 *
 * Two-arg form (`input` + `ref`): `input` is a GitHub repo identifier (URL or
 * owner/repo), `ref` is either a SHA (7-40 hex) or a PR number (optionally
 * prefixed with `#`). The two-arg form is GitHub-only; for GitLab paste the full URL.
 *
 * Throws:
 *  - {@link UnsupportedHostError} for URLs whose host we don't recognize.
 *  - {@link InvalidInputError} for inputs we can't parse at all.
 *  - {@link BareShaError} for a SHA pasted without a repo.
 *  - {@link NonGithubUrlError} (legacy alias) for cases the catch-all needs.
 */
export function parseInput(input: string, ref?: string, opts?: ParseOpts): LookupInput {
  const trimmed = (input ?? '').trim();
  if (!trimmed) throw new InvalidInputError(input ?? '');

  if (ref !== undefined) {
    // Two-arg form: try alias resolution on either token before falling back
    // to the GitHub repo path. Lets users say `released gtk <sha>` from the CLI.
    const trimmedRef = ref.trim();
    const lhsAlias = resolveAliasToken(trimmed, opts);
    if (lhsAlias) return resolveRef(lhsAlias, trimmedRef);
    const rhsAlias = resolveAliasToken(trimmedRef, opts);
    if (rhsAlias) return resolveRef(rhsAlias, trimmed);
    const repo = parseGithubRepoRef(trimmed);
    return resolveRef(repo, trimmedRef);
  }

  // Single-arg smart parser. Normalize by stripping query and trailing slashes
  // (but NOT '#', which is a separator in the PR shorthand).
  const stripped = trimmed.replace(/\?.*$/, '').replace(/\/+$/, '');

  // GitHub URL shapes — try first because owner/repo@sha and owner/repo#PR
  // shorthands have no host and would falsely look like GitLab.
  const shaUrl = stripped.match(GITHUB_SHA_URL_RE);
  if (shaUrl) {
    const [owner, repo, sha] = captures(shaUrl, 3);
    return { kind: 'commit', repo: githubRef(owner, repo), sha: sha.toLowerCase() };
  }

  // PR-with-specific-commit URL form (/pull/N/commits|changes|files/SHA).
  // The SHA is more specific than the PR; treat as a commit lookup.
  const prCommitUrl = stripped.match(PR_COMMIT_URL_RE);
  if (prCommitUrl) {
    const [owner, repo, sha] = captures(prCommitUrl, 3);
    return { kind: 'commit', repo: githubRef(owner, repo), sha: sha.toLowerCase() };
  }

  const prUrl = stripped.match(PR_URL_RE);
  if (prUrl) {
    const [owner, repo, num] = captures(prUrl, 3);
    return { kind: 'pr', repo: githubRef(owner, repo), number: Number.parseInt(num, 10) };
  }

  // GitLab URL shapes — checked after GitHub, before bareword shorthands.
  const gitlabSha = stripped.match(GITLAB_SHA_URL_RE);
  if (gitlabSha) {
    const [hostRaw, projectPath, sha] = captures(gitlabSha, 3);
    const host = hostRaw.toLowerCase();
    if (!isKnownGitlabHost(host)) throw unsupportedHost(host);
    return { kind: 'commit', repo: { host, projectPath }, sha: sha.toLowerCase() };
  }
  const gitlabMr = stripped.match(GITLAB_MR_URL_RE);
  if (gitlabMr) {
    const [hostRaw, projectPath, num] = captures(gitlabMr, 3);
    const host = hostRaw.toLowerCase();
    if (!isKnownGitlabHost(host)) throw unsupportedHost(host);
    return { kind: 'pr', repo: { host, projectPath }, number: Number.parseInt(num, 10) };
  }

  const atSha = stripped.match(OWNER_REPO_AT_SHA_RE);
  if (atSha) {
    const [owner, repo, sha] = captures(atSha, 3);
    return { kind: 'commit', repo: githubRef(owner, repo), sha: sha.toLowerCase() };
  }

  const hashPr = trimmed.match(OWNER_REPO_HASH_PR_RE);
  if (hashPr) {
    const [owner, repo, num] = captures(hashPr, 3);
    return { kind: 'pr', repo: githubRef(owner, repo), number: Number.parseInt(num, 10) };
  }

  // Space/tab-separated forms: "owner/repo <sha>", "owner/repo #N",
  // or "<sha> owner/repo". Convenient when the user pastes from a chat or doc.
  const parts = stripped.split(/\s+/);
  if (parts.length === 2 && parts[0] && parts[1]) {
    const [a, b] = parts as [string, string];
    // Try (repo, ref) order first
    if (BARE_OWNER_REPO_RE.test(a) && (SHA_RE.test(b) || PR_REF_RE.test(b))) {
      const [owner, name] = splitOwnerRepo(a);
      return resolveRef(githubRef(owner, name), b);
    }
    // Try (ref, repo) order
    if (BARE_OWNER_REPO_RE.test(b) && (SHA_RE.test(a) || PR_REF_RE.test(a))) {
      const [owner, name] = splitOwnerRepo(b);
      return resolveRef(githubRef(owner, name), a);
    }
  }

  // Alias shorthand — `<alias> <sha>`, `<sha> <alias>`, `<alias>@<sha>`,
  // `<alias>#<pr>`, `<alias> #<pr>`, `<alias> <pr>`, plus reverse orders.
  // Resolves the alias via opts.aliases (default KNOWN_PROJECTS) to a host+repo.
  const aliasHit = tryAliasParse(stripped, opts);
  if (aliasHit) return aliasHit;

  // Bare SHA with no repo context — distinct error kind so the UI can prompt
  // for a repo instead of saying "couldn't parse".
  if (SHA_RE.test(trimmed)) {
    throw new BareShaError(trimmed.toLowerCase());
  }

  if (ANY_GITHUB_URL_RE.test(trimmed)) {
    throw new InvalidInputError(
      `${input} — that's a GitHub URL but not one I recognize. ` +
        `I can read /commit/{sha}, /commits/{sha}, /blob|tree|blame|raw/{sha}/..., and /pull/{N}.`,
    );
  }
  const gitlabShape = trimmed.match(ANY_GITLAB_URL_RE);
  if (gitlabShape) {
    const [hostRaw] = captures(gitlabShape, 1);
    const host = hostRaw.toLowerCase();
    if (!isKnownGitlabHost(host)) throw unsupportedHost(host);
    throw new InvalidInputError(
      `${input} — that's a ${host} URL but not a shape I recognize. ` +
        `I can read /-/commit/{sha}, /-/blob|tree|blame|raw/{sha}/..., and /-/merge_requests/{N}.`,
    );
  }
  if (looksLikeUrl(trimmed)) {
    // Capture the host so the error message names it.
    const host = extractHost(trimmed);
    if (host) throw unknownShapeOrUnsupportedHost(host, input);
    throw new NonGithubUrlError(trimmed);
  }
  throw new InvalidInputError(input);
}

function githubRef(owner: string, repo: string): RepoRef {
  return { host: GITHUB_HOST, projectPath: `${owner}/${repo}` };
}

function parseGithubRepoRef(s: string): RepoRef {
  const stripped = s.replace(/\?.*$/, '').replace(/\/+$/, '');

  const ssh = stripped.match(REPO_SSH_RE);
  if (ssh) {
    const [owner, repo] = captures(ssh, 2);
    return githubRef(owner, repo);
  }

  const url = stripped.match(REPO_URL_RE);
  if (url) {
    const [owner, repo] = captures(url, 2);
    return githubRef(owner, repo);
  }

  const bare = stripped.match(BARE_OWNER_REPO_RE);
  if (bare) {
    const [owner, repo] = captures(bare, 2);
    return githubRef(owner, repo);
  }

  if (looksLikeUrl(stripped)) {
    const host = extractHost(stripped);
    if (host && host !== GITHUB_HOST) throw unsupportedHost(host);
    throw new NonGithubUrlError(stripped);
  }
  throw new InvalidInputError(s);
}

function resolveRef(repo: RepoRef, ref: string): LookupInput {
  if (!ref) throw new InvalidInputError(ref);

  if (PR_REF_RE.test(ref)) {
    return { kind: 'pr', repo, number: Number.parseInt(ref.replace(/^#/, ''), 10) };
  }
  if (SHA_RE.test(ref)) {
    return { kind: 'commit', repo, sha: ref.toLowerCase() };
  }
  throw new InvalidInputError(ref);
}

function isKnownGitlabHost(host: string): boolean {
  return KNOWN_GITLAB_HOSTS.has(host);
}

function unsupportedHost(host: string): UnsupportedHostError {
  const supported = ['github.com', ...KNOWN_GITLAB_HOSTS];
  return new UnsupportedHostError(host, supported);
}

/** Pick the honest error for a URL whose host we extracted but whose path shape
 *  we couldn't parse. If the host IS one we support, "I don't recognize that
 *  host" would be a lie (and self-contradictory — the message lists the host as
 *  supported). Surface a shape problem instead. Otherwise it's a genuinely
 *  unsupported host. */
function unknownShapeOrUnsupportedHost(host: string, input: string): ReleasedError {
  if (host === GITHUB_HOST || isKnownGitlabHost(host)) {
    return new InvalidInputError(
      `${input} — that's a ${host} URL but not a shape I recognize. ` +
        `Paste the commit/MR URL itself, or a SHA / PR-MR number.`,
    );
  }
  return unsupportedHost(host);
}

function extractHost(s: string): string | null {
  const m = s.match(/^(?:https?:\/\/)?([\w.-]+)\//);
  return m?.[1]?.toLowerCase() ?? null;
}

/** Heuristic: looks URL-shaped (has scheme or a dotted host with a path). */
function looksLikeUrl(s: string): boolean {
  return /^https?:\/\//i.test(s) || /^[a-z][\w-]*\.[a-z][\w.-]*\//i.test(s);
}

/**
 * Resolve a single token to a RepoRef via the known-projects catalog.
 * Returns null if the token isn't a known alias. Defensive: tokens with a
 * slash are not aliases (avoids any collision with owner/repo shorthand).
 */
function resolveAliasToken(token: string, opts?: ParseOpts): RepoRef | null {
  if (!token || token.includes('/')) return null;
  const project = findProjectByAlias(token, opts?.aliases);
  if (!project) return null;
  return { host: project.host, projectPath: project.projectPath };
}

/**
 * Try every alias-shorthand shape on a stripped single-arg input:
 *   alias@sha, alias#pr, "alias sha", "sha alias",
 *   "alias #pr", "#pr alias", "alias pr", "pr alias".
 * Returns the LookupInput or null if no alias form matches.
 */
function tryAliasParse(s: string, opts?: ParseOpts): LookupInput | null {
  // No-space: alias@sha (must have no '/' — owner/repo@sha was already tried)
  if (!s.includes('/')) {
    const atIdx = s.indexOf('@');
    if (atIdx > 0) {
      const left = s.slice(0, atIdx);
      const right = s.slice(atIdx + 1);
      if (SHA_RE.test(right)) {
        const repo = resolveAliasToken(left, opts);
        if (repo) return { kind: 'commit', repo, sha: right.toLowerCase() };
      }
    }
    // No-space: alias#pr
    const hashIdx = s.indexOf('#');
    if (hashIdx > 0) {
      const left = s.slice(0, hashIdx);
      const right = s.slice(hashIdx + 1);
      if (/^\d+$/.test(right)) {
        const repo = resolveAliasToken(left, opts);
        if (repo) return { kind: 'pr', repo, number: Number.parseInt(right, 10) };
      }
    }
  }

  // Whitespace-separated, either ordering
  const parts = s.split(/\s+/);
  if (parts.length === 2 && parts[0] && parts[1]) {
    const [a, b] = parts as [string, string];
    return tryAliasPair(a, b, opts) ?? tryAliasPair(b, a, opts);
  }

  return null;
}

/** Helper for tryAliasParse: treat `alias` as alias side, `ref` as SHA/PR side. */
function tryAliasPair(alias: string, ref: string, opts?: ParseOpts): LookupInput | null {
  const repo = resolveAliasToken(alias, opts);
  if (!repo) return null;
  if (SHA_RE.test(ref)) {
    return { kind: 'commit', repo, sha: ref.toLowerCase() };
  }
  if (PR_REF_RE.test(ref)) {
    return { kind: 'pr', repo, number: Number.parseInt(ref.replace(/^#/, ''), 10) };
  }
  return null;
}
