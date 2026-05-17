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
  UnsupportedHostError,
} from './errors.js';
import { KNOWN_GITLAB_HOSTS } from './providers/index.js';
import type { LookupInput, RepoRef } from './types.js';

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
export function parseInput(input: string, ref?: string): LookupInput {
  const trimmed = (input ?? '').trim();
  if (!trimmed) throw new InvalidInputError(input ?? '');

  if (ref !== undefined) {
    const repo = parseGithubRepoRef(trimmed);
    return resolveRef(repo, ref.trim());
  }

  // Single-arg smart parser. Normalize by stripping query and trailing slashes
  // (but NOT '#', which is a separator in the PR shorthand).
  const stripped = trimmed.replace(/\?.*$/, '').replace(/\/+$/, '');

  // GitHub URL shapes — try first because owner/repo@sha and owner/repo#PR
  // shorthands have no host and would falsely look like GitLab.
  const shaUrl = stripped.match(GITHUB_SHA_URL_RE);
  if (shaUrl) {
    return {
      kind: 'commit',
      repo: githubRef(shaUrl[1]!, shaUrl[2]!),
      sha: shaUrl[3]!.toLowerCase(),
    };
  }

  // PR-with-specific-commit URL form (/pull/N/commits|changes|files/SHA).
  // The SHA is more specific than the PR; treat as a commit lookup.
  const prCommitUrl = stripped.match(PR_COMMIT_URL_RE);
  if (prCommitUrl) {
    return {
      kind: 'commit',
      repo: githubRef(prCommitUrl[1]!, prCommitUrl[2]!),
      sha: prCommitUrl[3]!.toLowerCase(),
    };
  }

  const prUrl = stripped.match(PR_URL_RE);
  if (prUrl) {
    return {
      kind: 'pr',
      repo: githubRef(prUrl[1]!, prUrl[2]!),
      number: Number.parseInt(prUrl[3]!, 10),
    };
  }

  // GitLab URL shapes — checked after GitHub, before bareword shorthands.
  const gitlabSha = stripped.match(GITLAB_SHA_URL_RE);
  if (gitlabSha) {
    const host = gitlabSha[1]!.toLowerCase();
    if (!isKnownGitlabHost(host)) throw unsupportedHost(host);
    return {
      kind: 'commit',
      repo: { host, projectPath: gitlabSha[2]! },
      sha: gitlabSha[3]!.toLowerCase(),
    };
  }
  const gitlabMr = stripped.match(GITLAB_MR_URL_RE);
  if (gitlabMr) {
    const host = gitlabMr[1]!.toLowerCase();
    if (!isKnownGitlabHost(host)) throw unsupportedHost(host);
    return {
      kind: 'pr',
      repo: { host, projectPath: gitlabMr[2]! },
      number: Number.parseInt(gitlabMr[3]!, 10),
    };
  }

  const atSha = stripped.match(OWNER_REPO_AT_SHA_RE);
  if (atSha) {
    return {
      kind: 'commit',
      repo: githubRef(atSha[1]!, atSha[2]!),
      sha: atSha[3]!.toLowerCase(),
    };
  }

  const hashPr = trimmed.match(OWNER_REPO_HASH_PR_RE);
  if (hashPr) {
    return {
      kind: 'pr',
      repo: githubRef(hashPr[1]!, hashPr[2]!),
      number: Number.parseInt(hashPr[3]!, 10),
    };
  }

  // Space/tab-separated forms: "owner/repo <sha>", "owner/repo #N",
  // or "<sha> owner/repo". Convenient when the user pastes from a chat or doc.
  const parts = stripped.split(/\s+/);
  if (parts.length === 2 && parts[0] && parts[1]) {
    const [a, b] = parts as [string, string];
    // Try (repo, ref) order first
    if (BARE_OWNER_REPO_RE.test(a) && (SHA_RE.test(b) || PR_REF_RE.test(b))) {
      const [owner, name] = a.split('/');
      return resolveRef(githubRef(owner!, name!), b);
    }
    // Try (ref, repo) order
    if (BARE_OWNER_REPO_RE.test(b) && (SHA_RE.test(a) || PR_REF_RE.test(a))) {
      const [owner, name] = b.split('/');
      return resolveRef(githubRef(owner!, name!), a);
    }
  }

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
    const host = gitlabShape[1]!.toLowerCase();
    if (!isKnownGitlabHost(host)) throw unsupportedHost(host);
    throw new InvalidInputError(
      `${input} — that's a ${host} URL but not a shape I recognize. ` +
        `I can read /-/commit/{sha}, /-/blob|tree|blame|raw/{sha}/..., and /-/merge_requests/{N}.`,
    );
  }
  if (looksLikeUrl(trimmed)) {
    // Capture the host so the error message names it.
    const host = extractHost(trimmed);
    if (host) throw unsupportedHost(host);
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
  if (ssh) return githubRef(ssh[1]!, ssh[2]!);

  const url = stripped.match(REPO_URL_RE);
  if (url) return githubRef(url[1]!, url[2]!);

  const bare = stripped.match(BARE_OWNER_REPO_RE);
  if (bare) return githubRef(bare[1]!, bare[2]!);

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

function extractHost(s: string): string | null {
  const m = s.match(/^(?:https?:\/\/)?([\w.-]+)\//);
  return m?.[1]?.toLowerCase() ?? null;
}

/** Heuristic: looks URL-shaped (has scheme or a dotted host with a path). */
function looksLikeUrl(s: string): boolean {
  return /^https?:\/\//i.test(s) || /^[a-z][\w-]*\.[a-z][\w.-]*\//i.test(s);
}
