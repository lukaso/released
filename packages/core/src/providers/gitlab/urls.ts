// GitLab URL builders. GitLab uses a `/-/` infix between the project path and
// the resource type — that's a GitLab convention to disambiguate nested
// subgroups from resource segments (group/sub/project/-/commit/... vs.
// group/sub/project-named-commit).

import type { RepoRef } from '../../types.js';

export function makeGitlabUrls(host: string) {
  const base = `https://${host}`;
  return {
    repo(r: RepoRef): string {
      return `${base}/${r.projectPath}`;
    },
    commit(r: RepoRef, sha: string): string {
      return `${base}/${r.projectPath}/-/commit/${sha}`;
    },
    pullRequest(r: RepoRef, n: number): string {
      return `${base}/${r.projectPath}/-/merge_requests/${n}`;
    },
    issue(r: RepoRef, n: number): string {
      return `${base}/${r.projectPath}/-/issues/${n}`;
    },
    release(r: RepoRef, tag: string): string {
      return `${base}/${r.projectPath}/-/releases/${encodeURIComponent(tag)}`;
    },
  };
}
