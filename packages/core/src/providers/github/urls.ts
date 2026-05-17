// GitHub URL builders. The algorithm and UI consume these via Provider.urls
// instead of templating strings, so adding a new provider doesn't require
// touching every URL site.

import { type RepoRef, githubOwnerRepo } from '../../types.js';

const HOST = 'https://github.com';

export const githubUrls = {
  repo(r: RepoRef): string {
    const { owner, repo } = githubOwnerRepo(r);
    return `${HOST}/${owner}/${repo}`;
  },
  commit(r: RepoRef, sha: string): string {
    const { owner, repo } = githubOwnerRepo(r);
    return `${HOST}/${owner}/${repo}/commit/${sha}`;
  },
  pullRequest(r: RepoRef, n: number): string {
    const { owner, repo } = githubOwnerRepo(r);
    return `${HOST}/${owner}/${repo}/pull/${n}`;
  },
  release(r: RepoRef, tag: string): string {
    const { owner, repo } = githubOwnerRepo(r);
    return `${HOST}/${owner}/${repo}/releases/tag/${encodeURIComponent(tag)}`;
  },
};
