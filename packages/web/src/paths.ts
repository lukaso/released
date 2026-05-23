// Permalink path builders. Two URL families:
//
//   GitHub (legacy/canonical):
//     /r/:owner/:repo/c/:sha         — commit permalink
//     /p/:owner/:repo/:number        — PR permalink
//
//   Federated (any non-GitHub provider):
//     /h/:host/r/:projectPathEnc/c/:sha   — commit permalink
//     /h/:host/p/:projectPathEnc/:number  — MR permalink
//
//   :projectPathEnc is the projectPath with slashes URL-encoded (%2F), so a
//   nested-subgroup project like "gitlab-org/security-products/foo" fits in one
//   path segment.
//
// GitHub URLs stay identical to the pre-federation scheme so cached unfurls,
// Slack messages, and bookmarks keep working.

import type { LookupInput, RepoRef } from '@released/core';

const GITHUB_HOST = 'github.com';

export function commitPermalinkPath(repo: RepoRef, sha: string): string {
  if (repo.host === GITHUB_HOST) {
    const [owner, name] = repo.projectPath.split('/');
    return `/r/${owner}/${name}/c/${sha}`;
  }
  return `/h/${repo.host}/r/${encodeURIComponent(repo.projectPath)}/c/${sha}`;
}

export function prPermalinkPath(repo: RepoRef, n: number): string {
  if (repo.host === GITHUB_HOST) {
    const [owner, name] = repo.projectPath.split('/');
    return `/p/${owner}/${name}/${n}`;
  }
  return `/h/${repo.host}/p/${encodeURIComponent(repo.projectPath)}/${n}`;
}

/** The canonical permalink for a result, regardless of whether the lookup was a
 *  commit or a PR/MR. PR results keep the /p/ permalink so the embedded badge
 *  tracks the merge request; commits use the short-SHA /r/ form. */
export function permalinkPathForInput(input: LookupInput, canonicalSha: string): string {
  if (input.kind === 'pr') return prPermalinkPath(input.repo, input.number);
  return commitPermalinkPath(input.repo, canonicalSha.slice(0, 7));
}
