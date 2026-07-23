// Gitea/Forgejo URL builders. Gitea uses GitHub-style paths (NO `/-/` infix):
// the resource segment follows the project path directly. Forgejo (codeberg.org)
// is a Gitea fork and shares these URL conventions.

import type { RepoRef } from '../../types.js';

export function makeGiteaUrls(host: string) {
  const base = `https://${host}`;
  return {
    repo(r: RepoRef): string {
      return `${base}/${r.projectPath}`;
    },
    commit(r: RepoRef, sha: string): string {
      return `${base}/${r.projectPath}/commit/${sha}`;
    },
    pullRequest(r: RepoRef, n: number): string {
      // Gitea serves PRs at /pulls/{n} (plural). Forgejo accepts both /pulls and
      // /pull; we emit the canonical plural.
      return `${base}/${r.projectPath}/pulls/${n}`;
    },
    issue(r: RepoRef, n: number): string {
      return `${base}/${r.projectPath}/issues/${n}`;
    },
    release(r: RepoRef, tag: string): string {
      return `${base}/${r.projectPath}/releases/tag/${encodeURIComponent(tag)}`;
    },
  };
}
