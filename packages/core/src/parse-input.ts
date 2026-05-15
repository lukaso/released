// Smart-input parser (CP5).
// Accepts the single-arg "paste anything reasonable" form and the explicit
// two-arg form (repoUrl, ref).

import { BareShaError, InvalidInputError, NonGithubUrlError } from './errors.js';
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

/**
 * Parse user input into a canonical {@link LookupInput}.
 *
 * Single-arg form (`input` only): accepts a GitHub commit URL, PR URL,
 * `owner/repo@sha` shorthand, or `owner/repo#pr` shorthand.
 *
 * Two-arg form (`input` + `ref`): `input` is a repo identifier (URL or
 * owner/repo), `ref` is either a SHA (7-40 hex) or a PR number (optionally
 * prefixed with `#`).
 *
 * Non-GitHub URLs throw {@link NonGithubUrlError}. Unrecognized inputs throw
 * {@link InvalidInputError}.
 */
export function parseInput(input: string, ref?: string): LookupInput {
  const trimmed = (input ?? '').trim();
  if (!trimmed) throw new InvalidInputError(input ?? '');

  if (ref !== undefined) {
    const repo = parseRepoRef(trimmed);
    return resolveRef(repo, ref.trim());
  }

  // Single-arg smart parser. Normalize by stripping query and trailing slashes
  // (but NOT '#', which is a separator in the PR shorthand).
  const stripped = trimmed.replace(/\?.*$/, '').replace(/\/+$/, '');

  const shaUrl = stripped.match(GITHUB_SHA_URL_RE);
  if (shaUrl) {
    return {
      kind: 'commit',
      repo: { owner: shaUrl[1]!, repo: shaUrl[2]! },
      sha: shaUrl[3]!.toLowerCase(),
    };
  }

  // PR-with-specific-commit URL form (/pull/N/commits|changes|files/SHA).
  // The SHA is more specific than the PR; treat as a commit lookup.
  const prCommitUrl = stripped.match(PR_COMMIT_URL_RE);
  if (prCommitUrl) {
    return {
      kind: 'commit',
      repo: { owner: prCommitUrl[1]!, repo: prCommitUrl[2]! },
      sha: prCommitUrl[3]!.toLowerCase(),
    };
  }

  const prUrl = stripped.match(PR_URL_RE);
  if (prUrl) {
    return {
      kind: 'pr',
      repo: { owner: prUrl[1]!, repo: prUrl[2]! },
      number: Number.parseInt(prUrl[3]!, 10),
    };
  }

  const atSha = stripped.match(OWNER_REPO_AT_SHA_RE);
  if (atSha) {
    return {
      kind: 'commit',
      repo: { owner: atSha[1]!, repo: atSha[2]! },
      sha: atSha[3]!.toLowerCase(),
    };
  }

  const hashPr = trimmed.match(OWNER_REPO_HASH_PR_RE);
  if (hashPr) {
    return {
      kind: 'pr',
      repo: { owner: hashPr[1]!, repo: hashPr[2]! },
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
      return resolveRef({ owner: a.split('/')[0]!, repo: a.split('/')[1]! }, b);
    }
    // Try (ref, repo) order
    if (BARE_OWNER_REPO_RE.test(b) && (SHA_RE.test(a) || PR_REF_RE.test(a))) {
      return resolveRef({ owner: b.split('/')[0]!, repo: b.split('/')[1]! }, a);
    }
  }

  // Bare SHA with no repo context — distinct error kind so the UI can prompt
  // for a repo instead of saying "couldn't parse".
  if (SHA_RE.test(trimmed)) {
    throw new BareShaError(trimmed.toLowerCase());
  }

  if (ANY_GITHUB_URL_RE.test(trimmed)) {
    // It IS a GitHub URL — just not a path we recognize. Be specific.
    throw new InvalidInputError(
      `${input} — that's a GitHub URL but not one I recognize. ` +
        `I can read /commit/{sha}, /commits/{sha}, /blob|tree|blame|raw/{sha}/..., and /pull/{N}.`,
    );
  }
  if (looksLikeUrl(trimmed)) {
    throw new NonGithubUrlError(trimmed);
  }
  throw new InvalidInputError(input);
}

function parseRepoRef(s: string): RepoRef {
  const stripped = s.replace(/\?.*$/, '').replace(/\/+$/, '');

  const ssh = stripped.match(REPO_SSH_RE);
  if (ssh) return { owner: ssh[1]!, repo: ssh[2]! };

  const url = stripped.match(REPO_URL_RE);
  if (url) return { owner: url[1]!, repo: url[2]! };

  const bare = stripped.match(BARE_OWNER_REPO_RE);
  if (bare) return { owner: bare[1]!, repo: bare[2]! };

  if (looksLikeUrl(stripped)) throw new NonGithubUrlError(stripped);
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

/** Heuristic: looks URL-shaped (has scheme or a dotted host with a path). */
function looksLikeUrl(s: string): boolean {
  return /^https?:\/\//i.test(s) || /^[a-z][\w-]*\.[a-z][\w.-]*\//i.test(s);
}
