import { describe, expect, it, vi } from 'vitest';
import {
  CommitNotFoundError,
  PrMergeCommitUnavailableError,
  PrNotFoundError,
  PrNotMergedError,
  ProviderServerError,
  RateLimitError,
} from '../src/errors.js';
import { makeGitlabProvider } from '../src/providers/gitlab/client.js';
import type { RepoRef } from '../src/types.js';

/** Build a Response with sensible default rate-limit headers (GitLab's PascalCase). */
function jsonResp(
  body: unknown,
  init: {
    status?: number;
    remaining?: number;
    limit?: number;
    resetAt?: number;
    link?: string;
  } = {},
): Response {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'ratelimit-remaining': String(init.remaining ?? 1999),
    'ratelimit-limit': String(init.limit ?? 2000),
    'ratelimit-reset': String(init.resetAt ?? Math.floor(Date.now() / 1000) + 600),
  };
  if (init.link) headers.link = init.link;
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

function errResp(status: number, body: unknown = {}, remaining = 1999): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'ratelimit-remaining': String(remaining),
      'ratelimit-limit': '2000',
      'ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600),
    },
  });
}

function queuedFetch(...responses: (Response | Error)[]): typeof fetch {
  const queue = [...responses];
  return vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error('queuedFetch: queue exhausted');
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
}

const GNOME_GIMP: RepoRef = { host: 'gitlab.gnome.org', projectPath: 'GNOME/gimp' };
const NESTED: RepoRef = {
  host: 'gitlab.com',
  projectPath: 'gitlab-org/security-products/foo',
};

describe('GitlabProvider.getPullRequest (MR)', () => {
  it('returns merge_commit_sha for a merged MR', async () => {
    const fetch = queuedFetch(
      jsonResp({ state: 'merged', merge_commit_sha: 'abc123', squash_commit_sha: null }),
    );
    const c = makeGitlabProvider('gitlab.gnome.org', { fetch });
    const result = await c.getPullRequest(GNOME_GIMP, 2466);
    expect(result.mergeCommitSha).toBe('abc123');
  });

  it('falls back to squash_commit_sha when merge_commit_sha is null', async () => {
    const fetch = queuedFetch(
      jsonResp({ state: 'merged', merge_commit_sha: null, squash_commit_sha: 'squashabc' }),
    );
    const c = makeGitlabProvider('gitlab.com', { fetch });
    const result = await c.getPullRequest(NESTED, 42);
    expect(result.mergeCommitSha).toBe('squashabc');
  });

  it('falls back to `sha` (source-branch head) for fast-forward merges (no merge commit)', async () => {
    // Real-world: GNOME/gimp uses FF merges. merge_commit_sha is null, squash_commit_sha is null,
    // and `sha` is the head of the source branch — which IS the commit that landed on master.
    const fetch = queuedFetch(
      jsonResp({
        state: 'merged',
        merge_commit_sha: null,
        squash_commit_sha: null,
        sha: 'ffheadsha',
      }),
    );
    const c = makeGitlabProvider('gitlab.gnome.org', { fetch });
    const result = await c.getPullRequest(GNOME_GIMP, 2822);
    expect(result.mergeCommitSha).toBe('ffheadsha');
  });

  it('throws PrNotMergedError when state is not "merged"', async () => {
    const fetch = queuedFetch(
      jsonResp({ state: 'opened', merge_commit_sha: null, squash_commit_sha: null }),
    );
    const c = makeGitlabProvider('gitlab.com', { fetch });
    await expect(c.getPullRequest(GNOME_GIMP, 2466)).rejects.toBeInstanceOf(PrNotMergedError);
  });

  it('throws PrMergeCommitUnavailableError when merged with no SHAs (rare — only when GitLab loses all metadata)', async () => {
    const fetch = queuedFetch(
      jsonResp({ state: 'merged', merge_commit_sha: null, squash_commit_sha: null, sha: null }),
    );
    const c = makeGitlabProvider('gitlab.com', { fetch });
    await expect(c.getPullRequest(GNOME_GIMP, 2466)).rejects.toBeInstanceOf(
      PrMergeCommitUnavailableError,
    );
  });

  it('throws PrNotFoundError on 404', async () => {
    const fetch = queuedFetch(errResp(404));
    const c = makeGitlabProvider('gitlab.com', { fetch });
    await expect(c.getPullRequest(GNOME_GIMP, 99999)).rejects.toBeInstanceOf(PrNotFoundError);
  });

  it('URL-encodes the nested project path', async () => {
    const calls: string[] = [];
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResp({ state: 'merged', merge_commit_sha: 'x', squash_commit_sha: null });
    }) as unknown as typeof fetch;
    const c = makeGitlabProvider('gitlab.com', { fetch: mockFetch });
    await c.getPullRequest(NESTED, 1);
    expect(calls[0]).toContain('gitlab-org%2Fsecurity-products%2Ffoo');
  });
});

describe('GitlabProvider.getCommit', () => {
  it('returns full SHA + committed_date', async () => {
    const fetch = queuedFetch(
      jsonResp({ id: 'abc1234567890abcdef', committed_date: '2024-03-01T12:00:00Z' }),
    );
    const c = makeGitlabProvider('gitlab.gnome.org', { fetch });
    const result = await c.getCommit(GNOME_GIMP, 'abc1234');
    expect(result.fullSha).toBe('abc1234567890abcdef');
    expect(result.committedDate).toBe('2024-03-01T12:00:00Z');
  });

  it('throws CommitNotFoundError on 404', async () => {
    const fetch = queuedFetch(errResp(404));
    const c = makeGitlabProvider('gitlab.gnome.org', { fetch });
    await expect(c.getCommit(GNOME_GIMP, 'deadbee')).rejects.toBeInstanceOf(CommitNotFoundError);
  });
});

describe('GitlabProvider.listTagsWithDates', () => {
  it('returns tags from a single page', async () => {
    const fetch = queuedFetch(
      jsonResp([
        { name: 'GIMP_2_99_20', commit: { id: 'sha1', committed_date: '2024-03-01T00:00:00Z' } },
        { name: 'GIMP_2_99_19', commit: { id: 'sha2', committed_date: '2024-02-01T00:00:00Z' } },
      ]),
    );
    const c = makeGitlabProvider('gitlab.gnome.org', { fetch });
    const { tags } = await c.listTagsWithDates(GNOME_GIMP);
    expect(tags).toHaveLength(2);
    expect(tags[0]?.name).toBe('GIMP_2_99_20');
    expect(tags[0]?.isPrerelease).toBe(false);
  });

  it('paginates via Link header rel="next"', async () => {
    const fetch = queuedFetch(
      jsonResp([{ name: 'v1', commit: { id: 's1', committed_date: '2024-01-01T00:00:00Z' } }], {
        link: '<https://gitlab.com/api/v4/projects/foo/repository/tags?page=2&per_page=100>; rel="next", <...>; rel="last"',
      }),
      jsonResp([{ name: 'v2', commit: { id: 's2', committed_date: '2024-02-01T00:00:00Z' } }]),
    );
    const c = makeGitlabProvider('gitlab.com', { fetch });
    const { tags } = await c.listTagsWithDates(GNOME_GIMP);
    expect(tags.map((t) => t.name)).toEqual(['v1', 'v2']);
  });

  it('caps pagination at MAX_TAG_PAGES (5) — never eats the deadline budget', async () => {
    // If we returned a "next" link on every page indefinitely, the loop would
    // hang. The cap saves us.
    const makePage = (n: number) =>
      jsonResp(
        [{ name: `v${n}`, commit: { id: `s${n}`, committed_date: '2024-01-01T00:00:00Z' } }],
        {
          link: `<https://gitlab.com/api/v4/projects/foo/repository/tags?page=${n + 1}&per_page=100>; rel="next"`,
        },
      );
    const fetch = queuedFetch(makePage(1), makePage(2), makePage(3), makePage(4), makePage(5));
    const c = makeGitlabProvider('gitlab.com', { fetch });
    const { tags } = await c.listTagsWithDates(GNOME_GIMP);
    // Exactly 5 pages × 1 tag each. NOT 6+ (would mean we kept walking).
    expect(tags).toHaveLength(5);
  });

  it('returns empty list for repos with no tags', async () => {
    const fetch = queuedFetch(jsonResp([]));
    const c = makeGitlabProvider('gitlab.com', { fetch });
    const { tags } = await c.listTagsWithDates(GNOME_GIMP);
    expect(tags).toEqual([]);
  });

  it('flags prerelease tag names', async () => {
    const fetch = queuedFetch(
      jsonResp([
        { name: 'v1.0.0-rc.1', commit: { id: 's1', committed_date: '2024-01-01T00:00:00Z' } },
        { name: 'v1.0.0', commit: { id: 's2', committed_date: '2024-02-01T00:00:00Z' } },
      ]),
    );
    const c = makeGitlabProvider('gitlab.com', { fetch });
    const { tags } = await c.listTagsWithDates(GNOME_GIMP);
    expect(tags[0]?.isPrerelease).toBe(true);
    expect(tags[1]?.isPrerelease).toBe(false);
  });
});

describe('GitlabProvider.compareCommits', () => {
  it('returns "behind" when base contains head (compare returns no commits)', async () => {
    const fetch = queuedFetch(jsonResp({ commits: [], compare_same_ref: false }));
    const c = makeGitlabProvider('gitlab.com', { fetch });
    const result = await c.compareCommits(GNOME_GIMP, 'tagSha', 'commitSha');
    expect(result.status).toBe('behind');
  });

  it('returns "behind" when compare_same_ref is true', async () => {
    const fetch = queuedFetch(jsonResp({ commits: [{ id: 'x' }], compare_same_ref: true }));
    const c = makeGitlabProvider('gitlab.com', { fetch });
    const result = await c.compareCommits(GNOME_GIMP, 'tagSha', 'commitSha');
    expect(result.status).toBe('behind');
  });

  it('returns "ahead" when base does NOT contain head (compare returns commits)', async () => {
    const fetch = queuedFetch(jsonResp({ commits: [{ id: 'newer' }, { id: 'newer2' }] }));
    const c = makeGitlabProvider('gitlab.com', { fetch });
    const result = await c.compareCommits(GNOME_GIMP, 'tagSha', 'commitSha');
    expect(result.status).toBe('ahead');
  });

  it('returns "diverged" on 404 (unrelated histories)', async () => {
    const fetch = queuedFetch(errResp(404));
    const c = makeGitlabProvider('gitlab.com', { fetch });
    const result = await c.compareCommits(GNOME_GIMP, 'ancient', 'modern');
    expect(result.status).toBe('diverged');
  });

  it('returns "diverged" on compare_timeout', async () => {
    const fetch = queuedFetch(jsonResp({ commits: [], compare_timeout: true }));
    const c = makeGitlabProvider('gitlab.com', { fetch });
    const result = await c.compareCommits(GNOME_GIMP, 't', 'c');
    expect(result.status).toBe('diverged');
  });
});

describe('GitlabProvider.containingTags', () => {
  // GitLab exposes `GET /projects/:id/repository/commits/:sha/refs?type=tag` which
  // returns every tag that contains the commit, in one round trip. This collapses
  // the find-release algorithm from O(log n) compare calls to ONE call — critical
  // for huge repos like GNOME/gtk where the per-tag compare can take 2-3s each.

  it('returns tag names from the refs response', async () => {
    const fetch = queuedFetch(
      jsonResp([
        { type: 'tag', name: 'v1.0' },
        { type: 'tag', name: 'v1.1' },
      ]),
    );
    const c = makeGitlabProvider('gitlab.gnome.org', { fetch });
    const result = await c.containingTags!(GNOME_GIMP, 'commitSha');
    expect(result.tags).toEqual(['v1.0', 'v1.1']);
  });

  it('returns an empty list when the commit is in no tags yet (not yet released)', async () => {
    const fetch = queuedFetch(jsonResp([]));
    const c = makeGitlabProvider('gitlab.gnome.org', { fetch });
    const result = await c.containingTags!(GNOME_GIMP, 'commitSha');
    expect(result.tags).toEqual([]);
  });

  it('filters out non-tag refs (branches) even though we ask type=tag (defensive)', async () => {
    const fetch = queuedFetch(
      jsonResp([
        { type: 'tag', name: 'v1.0' },
        { type: 'branch', name: 'main' },
      ]),
    );
    const c = makeGitlabProvider('gitlab.gnome.org', { fetch });
    const result = await c.containingTags!(GNOME_GIMP, 'commitSha');
    expect(result.tags).toEqual(['v1.0']);
  });

  it('asks the API with type=tag in the query string', async () => {
    const calls: string[] = [];
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResp([]);
    }) as unknown as typeof fetch;
    const c = makeGitlabProvider('gitlab.com', { fetch: mockFetch });
    await c.containingTags!(NESTED, 'commitSha');
    expect(calls[0]).toContain('/repository/commits/commitSha/refs');
    expect(calls[0]).toContain('type=tag');
  });

  it('throws ProviderServerError on 5xx (caller falls back to galloping)', async () => {
    const fetch = queuedFetch(errResp(500));
    const c = makeGitlabProvider('gitlab.gnome.org', { fetch, retries: 0 });
    await expect(c.containingTags!(GNOME_GIMP, 'commitSha')).rejects.toBeInstanceOf(
      ProviderServerError,
    );
  });
});

describe('GitlabProvider.getReleaseNotes', () => {
  it('returns the release description when one exists', async () => {
    const fetch = queuedFetch(jsonResp({ description: '## Changes\n\n* fix: thing' }));
    const c = makeGitlabProvider('gitlab.gnome.org', { fetch });
    const result = await c.getReleaseNotes(GNOME_GIMP, 'GIMP_2_99_20');
    expect(result.body).toContain('thing');
  });

  it('returns null when no Release object exists for the tag (404)', async () => {
    const fetch = queuedFetch(errResp(404));
    const c = makeGitlabProvider('gitlab.gnome.org', { fetch });
    const result = await c.getReleaseNotes(GNOME_GIMP, 'GIMP_2_99_20');
    expect(result.body).toBeNull();
  });
});

describe('GitlabProvider — auth + rate-limit + errors', () => {
  it('attaches PRIVATE-TOKEN header when a token is provided', async () => {
    const calls: Request[] = [];
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input as Request | string, init));
      return jsonResp({ id: 'a'.repeat(40), committed_date: '2024-01-01T00:00:00Z' });
    }) as unknown as typeof fetch;
    const c = makeGitlabProvider('gitlab.gnome.org', { fetch: mockFetch, token: 'glpat_test123' });
    await c.getCommit(GNOME_GIMP, 'abcdef1234');
    expect(calls[0]!.headers.get('private-token')).toBe('glpat_test123');
  });

  it('does NOT attach an Authorization-style header when no token is given', async () => {
    const calls: Request[] = [];
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input as Request | string, init));
      return jsonResp({ id: 'a'.repeat(40), committed_date: '2024-01-01T00:00:00Z' });
    }) as unknown as typeof fetch;
    const c = makeGitlabProvider('gitlab.gnome.org', { fetch: mockFetch });
    await c.getCommit(GNOME_GIMP, 'abcdef1234');
    expect(calls[0]!.headers.get('private-token')).toBeNull();
    expect(calls[0]!.headers.get('authorization')).toBeNull();
  });

  it('throws ProviderServerError (with host) on persistent 5xx', async () => {
    const fetch = queuedFetch(errResp(503), errResp(503), errResp(503));
    const c = makeGitlabProvider('gitlab.gnome.org', { fetch });
    try {
      await c.getCommit(GNOME_GIMP, 'abc1234');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderServerError);
      expect((err as ProviderServerError).providerHost).toBe('gitlab.gnome.org');
    }
  });

  it('throws RateLimitError on 429 with remaining=0 (carries providerHost)', async () => {
    const reset = Math.floor(Date.now() / 1000) + 600;
    const fetch = queuedFetch(
      new Response(JSON.stringify({ message: 'rate limited' }), {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'ratelimit-remaining': '0',
          'ratelimit-limit': '10',
          'ratelimit-reset': String(reset),
        },
      }),
    );
    const c = makeGitlabProvider('gitlab.gnome.org', { fetch });
    try {
      await c.getCommit(GNOME_GIMP, 'abc1234');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).providerHost).toBe('gitlab.gnome.org');
    }
  });
});
