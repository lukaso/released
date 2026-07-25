// Bitbucket Cloud URL builders. Bitbucket uses a flat `workspace/repo` path
// (no subgroups) and resource segments WITHOUT a `/-/` infix: the resource type
// is itself a distinct path segment (/commits, /pull-requests, /issues).
//
// Note the hyphenated `pull-requests` (not `pull`) — Bitbucket's convention.
// Bitbucket has no first-class "release" page like GitHub; the closest stable
// surface for a tag is its source view at /src/{tag}.

import type { RepoRef } from '../../types.js';

export function makeBitbucketUrls(host: string) {
  const base = `https://${host}`;
  return {
    repo(r: RepoRef): string {
      return `${base}/${r.projectPath}`;
    },
    commit(r: RepoRef, sha: string): string {
      return `${base}/${r.projectPath}/commits/${sha}`;
    },
    pullRequest(r: RepoRef, n: number): string {
      return `${base}/${r.projectPath}/pull-requests/${n}`;
    },
    issue(r: RepoRef, n: number): string {
      return `${base}/${r.projectPath}/issues/${n}`;
    },
    release(r: RepoRef, tag: string): string {
      return `${base}/${r.projectPath}/src/${encodeURIComponent(tag)}`;
    },
  };
}
