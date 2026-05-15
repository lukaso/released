import { describe, expect, it, vi } from 'vitest';
import { BulkLimitError, RateLimitError } from '../src/errors.js';
import { findReleasesBulk } from '../src/find-release.js';
import type { GithubClient } from '../src/github.js';
import type { LookupInput, TagWithDate } from '../src/types.js';

function bulkFakeClient(tags: TagWithDate[], contains: Set<string>) {
  const rateLimit = { remaining: 4999, limit: 5000, resetAt: Math.floor(Date.now() / 1000) + 3600 };
  const listSpy = vi.fn(async () => ({ tags, rateLimit }));
  const client: GithubClient = {
    listTagsWithDates: listSpy,
    async getCommit(_o, _r, sha) {
      return { fullSha: sha.padEnd(40, '0'), committedDate: '2024-01-01T00:00:00Z', rateLimit };
    },
    async getPullRequest(_o, _r, n) {
      return { merged: true, mergeCommitSha: `pr${n}`.padEnd(40, '0'), rateLimit };
    },
    async compareCommits(_o, _r, base, _head) {
      const tag = tags.find((t) => t.sha === base);
      return { status: tag && contains.has(tag.name) ? ('behind' as const) : ('ahead' as const), rateLimit };
    },
    async getReleaseNotes() {
      return { body: null, rateLimit };
    },
  };
  return { client, listSpy };
}

describe('findReleasesBulk', () => {
  it('rejects more than MAX_BULK inputs with BulkLimitError', async () => {
    const inputs: LookupInput[] = Array.from({ length: 11 }, (_, i) => ({
      kind: 'commit' as const,
      repo: { owner: 'o', repo: 'r' },
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
      { kind: 'commit', repo: { owner: 'o', repo: 'r' }, sha: 'a'.repeat(40) },
      { kind: 'commit', repo: { owner: 'o', repo: 'r' }, sha: 'b'.repeat(40) },
      { kind: 'commit', repo: { owner: 'o', repo: 'r' }, sha: 'c'.repeat(40) },
    ];
    const { client, listSpy } = bulkFakeClient(tags, new Set(['v1', 'v2']));
    const result = await findReleasesBulk(inputs, { client });
    expect(listSpy).toHaveBeenCalledTimes(1); // memoized!
    expect(result.results).toHaveLength(3);
    expect(result.partial).toBeUndefined();
  });

  it('returns partial=rate_limit_exhausted when a sub-call hits RateLimitError', async () => {
    const tags: TagWithDate[] = [{ name: 'v1', sha: 's1', date: '2024-01-01T00:00:00Z' }];
    const inputs: LookupInput[] = Array.from({ length: 5 }, (_, i) => ({
      kind: 'commit' as const,
      repo: { owner: 'o', repo: 'r' },
      sha: i.toString().padStart(7, '0'),
    }));
    let callCount = 0;
    const rateLimit = { remaining: 0, limit: 60, resetAt: Math.floor(Date.now() / 1000) + 600 };
    const client: GithubClient = {
      async listTagsWithDates() {
        return { tags, rateLimit };
      },
      async getCommit(_o, _r, sha) {
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
        return { body: null, rateLimit };
      },
    };
    const result = await findReleasesBulk(inputs, { client, concurrency: 1 });
    expect(result.partial?.reason).toBe('rate_limit_exhausted');
    expect(result.partial?.pendingCount).toBeGreaterThan(0);
  });
});
