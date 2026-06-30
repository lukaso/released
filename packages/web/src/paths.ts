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

/** Issue permalink (#54). Issues get their OWN /i/ permalink — the route
 *  re-resolves the issue to its closing commit(s) on each visit, so the page
 *  keeps the issue number and title rather than collapsing to the commit URL. */
export function issuePermalinkPath(repo: RepoRef, n: number): string {
  if (repo.host === GITHUB_HOST) {
    const [owner, name] = repo.projectPath.split('/');
    return `/i/${owner}/${name}/${n}`;
  }
  return `/h/${repo.host}/i/${encodeURIComponent(repo.projectPath)}/${n}`;
}

/** The canonical permalink for a result, regardless of whether the lookup was a
 *  commit, a PR/MR, or an issue. PR/issue results keep their own permalink so
 *  the page tracks the merge request / issue; commits use the short-SHA /r/ form. */
export function permalinkPathForInput(input: LookupInput, canonicalSha: string): string {
  if (input.kind === 'pr') return prPermalinkPath(input.repo, input.number);
  if (input.kind === 'issue') return issuePermalinkPath(input.repo, input.number);
  return commitPermalinkPath(input.repo, canonicalSha.slice(0, 7));
}
