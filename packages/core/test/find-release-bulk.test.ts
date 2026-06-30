import { describe, expect, it, vi } from 'vitest';
import { BulkLimitError, RateLimitError } from '../src/errors.js';
import { findReleasesBulk } from '../src/find-release.js';
import type { Provider } from '../src/provider.js';
import { makeGithubProvider } from '../src/providers/github/client.js';
import { makeGitlabProvider } from '../src/providers/gitlab/client.js';
import type { LookupInput, RepoRef, TagWithDate } from '../src/types.js';

function bulkFakeClient(
  tags: TagWithDate[],
  contains: Set<string>,
  base: Provider = makeGithubProvider(),
) {
  const rateLimit = { remaining: 4999, limit: 5000, resetAt: Math.floor(Date.now() / 1000) + 3600 };
  const listSpy = vi.fn(async (_repo: RepoRef) => ({ tags, rateLimit }));
  const client: Provider = {
    host: base.host,
    kind: base.kind,
    terms: base.terms,
    urls: base.urls,
    listTagsWithDates: listSpy,
    async getCommit(_repo, sha) {
      return { fullSha: sha.padEnd(40, '0'), committedDate: '2024-01-01T00:00:00Z', rateLimit };
    },
    async getPullRequest(_repo, n) {
      return { merged: true, mergeCommitSha: `pr${n}`.padEnd(40, '0'), rateLimit };
    },
    async getIssueClosingCommit(_repo, n) {
      return { state: 'fixed', closingCommits: [`is${n}`.padEnd(40, '0')], title: null, rateLimit };
    },
    async compareCommits(_repo, base, _head) {
      const tag = tags.find((t) => t.sha === base);
      return {
        status: tag && contains.has(tag.name) ? ('behind' as const) : ('ahead' as const),
        rateLimit,
      };
    },
    async getReleaseNotes() {
      return { body: null, isPrerelease: null, rateLimit };
    },
  };
  return { client, listSpy };
}

const REPO_OR: RepoRef = { host: 'github.com', projectPath: 'o/r' };

describe('findReleasesBulk', () => {
  it('rejects more than MAX_BULK inputs with BulkLimitError', async () => {
    const inputs: LookupInput[] = Array.from({ length: 11 }, (_, i) => ({
      kind: 'commit' as const,
      repo: REPO_OR,
      sha: i.toString(16).padStart(7, '0'),
    }));
    const { client } = bulkFakeClient([], new Set());
    await expect(findReleasesBulk(inputs, { client })).rejects.toBeInstanceOf(BulkLimitError);
  });

  it('shares one tag-list call across same-repo inputs', async () => {
    const tags: TagWithDate[] = [
      { name: 'v1', sha: 's1', date: '2024-01-01T00:00:00Z' },
      { name: 'v2', sha: 's2', date: '2024-02-01T00:00:00Z' },
    ];
    const inputs: LookupInput[] = [
      { kind: 'commit', repo: REPO_OR, sha: 'a'.repeat(40) },
      { kind: 'commit', repo: REPO_OR, sha: 'b'.repeat(40) },
      { kind: 'commit', repo: REPO_OR, sha: 'c'.repeat(40) },
    ];
    const { client, listSpy } = bulkFakeClient(tags, new Set(['v1', 'v2']));
    const result = await findReleasesBulk(inputs, { client });
    expect(listSpy).toHaveBeenCalledTimes(1); // memoized!
    expect(result.results).toHaveLength(3);
    expect(result.partial).toBeUndefined();
  });

  it('memoization key includes host — github.com/o/r and gitlab.com/o/r are independent slots', async () => {
    // Critical regression test: pre-federation, the memoizeTagsClient key was
    // ${owner}/${repo} which collided across providers with the same projectPath.
    // Post-federation the key is ${host}/${projectPath}.
    const githubTags: TagWithDate[] = [{ name: 'gh-v1', sha: 'gs1', date: '2024-01-01T00:00:00Z' }];
    const gitlabTags: TagWithDate[] = [{ name: 'gl-v1', sha: 'ls1', date: '2024-01-01T00:00:00Z' }];

    const githubRepo: RepoRef = { host: 'github.com', projectPath: 'o/r' };
    const gitlabRepo: RepoRef = { host: 'gitlab.com', projectPath: 'o/r' };

    // Single client that returns DIFFERENT tags based on the repo's host.
    // This proves the memoization layer correctly separates the two.
    const rateLimit = {
      remaining: 4999,
      limit: 5000,
      resetAt: Math.floor(Date.now() / 1000) + 3600,
    };
    const listSpy = vi.fn(async (repo: RepoRef) => ({
      tags: repo.host === 'github.com' ? githubTags : gitlabTags,
      rateLimit,
    }));
    const client: Provider = {
      ...makeGithubProvider(),
      listTagsWithDates: listSpy,
      async getCommit(_repo, sha) {
        return { fullSha: sha.padEnd(40, '0'), committedDate: '2024-01-15T00:00:00Z', rateLimit };
      },
      async getPullRequest(_repo, n) {
        return { merged: true, mergeCommitSha: `pr${n}`.padEnd(40, '0'), rateLimit };
      },
      async compareCommits(repo, base, _head) {
        const tags = repo.host === 'github.com' ? githubTags : gitlabTags;
        const containing = repo.host === 'github.com' ? new Set(['gh-v1']) : new Set(['gl-v1']);
        const tag = tags.find((t) => t.sha === base);
        return {
          status: tag && containing.has(tag.name) ? ('behind' as const) : ('ahead' as const),
          rateLimit,
        };
      },
      async getReleaseNotes() {
        return { body: null, isPrerelease: null, rateLimit };
      },
    };

    const inputs: LookupInput[] = [
      { kind: 'commit', repo: githubRepo, sha: 'a'.repeat(40) },
      { kind: 'commit', repo: gitlabRepo, sha: 'b'.repeat(40) },
    ];
    const result = await findReleasesBulk(inputs, { client });
    // Two distinct hosts → two distinct list calls (no collision).
    expect(listSpy).toHaveBeenCalledTimes(2);
    expect(result.results).toHaveLength(2);
    // And each result picked up the tag from its OWN provider's tag list.
    const [r1, r2] = result.results;
    expect('firstRelease' in r1! && r1.firstRelease?.tag).toBe('gh-v1');
    expect('firstRelease' in r2! && r2.firstRelease?.tag).toBe('gl-v1');
  });

  it('returns partial=rate_limit_exhausted when a sub-call hits RateLimitError', async () => {
    const tags: TagWithDate[] = [{ name: 'v1', sha: 's1', date: '2024-01-01T00:00:00Z' }];
    const inputs: LookupInput[] = Array.from({ length: 5 }, (_, i) => ({
      kind: 'commit' as const,
      repo: REPO_OR,
      sha: i.toString().padStart(7, '0'),
    }));
    let callCount = 0;
    const rateLimit = { remaining: 0, limit: 60, resetAt: Math.floor(Date.now() / 1000) + 600 };
    const baseClient = makeGithubProvider();
    const client: Provider = {
      ...baseClient,
      async listTagsWithDates() {
        return { tags, rateLimit };
      },
      async getCommit(_repo, sha) {
        return { fullSha: sha.padEnd(40, '0'), committedDate: '2024-01-01T00:00:00Z', rateLimit };
      },
      async getPullRequest() {
        throw new Error('not used');
      },
      async compareCommits() {
        callCount += 1;
        if (callCount > 2) throw new RateLimitError(rateLimit.resetAt);
        return { status: 'ahead' as const, rateLimit };
      },
      async getReleaseNotes() {
        return { body: null, isPrerelease: null, rateLimit };
      },
    };
    const result = await findReleasesBulk(inputs, { client, concurrency: 1 });
    expect(result.partial?.reason).toBe('rate_limit_exhausted');
    expect(result.partial?.pendingCount).toBeGreaterThan(0);
  });
});
