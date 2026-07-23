import { describe, expect, it, vi } from 'vitest';
import {
  CommitNotFoundError,
  IssueNotFoundError,
  PrMergeCommitUnavailableError,
  PrNotFoundError,
  PrNotMergedError,
  ProviderServerError,
  RateLimitError,
} from '../src/errors.js';
import { makeGiteaProvider } from '../src/providers/gitea/client.js';
import type { RepoRef } from '../src/types.js';

/**
 * Gitea/Forgejo emit the RFC 9211 `ratelimit` header, NOT the GitHub/GitLab
 * per-field headers. Real shape (codeberg.org, verified live):
 *   ratelimit:        "baseline";r=1992;t=600      (r=remaining, t=window sec)
 *   ratelimit-policy: "baseline";q=2000;w=600       (q=limit,    w=window sec)
 * Mirror that exactly so the rate-limit parse + RateLimitError path are tested
 * against the bytes the provider actually sees.
 */
function jsonResp(
  body: unknown,
  init: {
    status?: number;
    remaining?: number;
    limit?: number;
  } = {},
): Response {
  const remaining = init.remaining ?? 1992;
  const limit = init.limit ?? 2000;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ratelimit: `"baseline";r=${remaining};t=600`,
    'ratelimit-policy': `"baseline";q=${limit};w=600`,
  };
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

function errResp(status: number, body: unknown = {}, remaining = 1992): Response {
  return jsonResp(body, { status, remaining });
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

const FORGEJO: RepoRef = { host: 'codeberg.org', projectPath: 'forgejo/forgejo' };
const NESTED: RepoRef = { host: 'gitea.com', projectPath: 'org/team/repo' };

describe('GiteaProvider.getPullRequest', () => {
  it('returns merge_commit_sha + PR title for a merged pull', async () => {
    const fetch = queuedFetch(
      jsonResp({
        number: 13580,
        state: 'closed',
        merged: true,
        merge_commit_sha: '9b6de2d5ae82f98eefe65c306ddbde682db08e5d',
        title: 'Update google.golang.org/grpc (indirect)',
      }),
    );
    const c = makeGiteaProvider('codeberg.org', { fetch });
    const result = await c.getPullRequest(FORGEJO, 13580);
    expect(result.mergeCommitSha).toBe('9b6de2d5ae82f98eefe65c306ddbde682db08e5d');
    expect(result.title).toBe('Update google.golang.org/grpc (indirect)');
  });

  it('throws PrNotMergedError (PR vocabulary) for an OPEN pull', async () => {
    // Two assertions → queue two responses (queuedFetch is one-shot per call).
    const open = () => jsonResp({ number: 1, state: 'open', merged: false });
    const fetch = queuedFetch(open(), open());
    const c = makeGiteaProvider('codeberg.org', { fetch });
    await expect(c.getPullRequest(FORGEJO, 1)).rejects.toThrow(
      /Pull request #1 has not been merged yet/,
    );
    await expect(c.getPullRequest(FORGEJO, 1)).rejects.toBeInstanceOf(PrNotMergedError);
  });

  it('throws PrNotMergedError "closed without being merged" for a CLOSED-but-unmerged pull', async () => {
    const fetch = queuedFetch(jsonResp({ number: 2, state: 'closed', merged: false }));
    const c = makeGiteaProvider('codeberg.org', { fetch });
    await expect(c.getPullRequest(FORGEJO, 2)).rejects.toThrow(
      /Pull request #2 was closed without being merged/,
    );
  });

  it('throws PrMergeCommitUnavailableError when merged but no merge_commit_sha', async () => {
    const fetch = queuedFetch(
      jsonResp({ number: 3, state: 'closed', merged: true, merge_commit_sha: null }),
    );
    const c = makeGiteaProvider('codeberg.org', { fetch });
    await expect(c.getPullRequest(FORGEJO, 3)).rejects.toBeInstanceOf(
      PrMergeCommitUnavailableError,
    );
  });

  it('throws PrNotFoundError on 404', async () => {
    const fetch = queuedFetch(errResp(404));
    const c = makeGiteaProvider('codeberg.org', { fetch });
    await expect(c.getPullRequest(FORGEJO, 99999)).rejects.toBeInstanceOf(PrNotFoundError);
  });
});

describe('GiteaProvider.getCommit', () => {
  it('returns full SHA + committer date + message subject', async () => {
    // Real git/commits response shape (verified live on codeberg.org).
    const fetch = queuedFetch(
      jsonResp({
        sha: 'b3d7e4ac3cbccc220703097a51fa4c16bf302579',
        created: '2026-07-20T18:00:33+02:00',
        commit: {
          message: 'fix: Initialize oauth2 only if enabled (#13483)\n\nMore detail here.',
          committer: { name: 'bot', email: 'b@x', date: '2026-07-20T18:00:33+02:00' },
        },
      }),
    );
    const c = makeGiteaProvider('codeberg.org', { fetch });
    const result = await c.getCommit(FORGEJO, 'b3d7e4ac');
    expect(result.fullSha).toBe('b3d7e4ac3cbccc220703097a51fa4c16bf302579');
    expect(result.committedDate).toBe('2026-07-20T18:00:33+02:00');
    expect(result.subject).toBe('fix: Initialize oauth2 only if enabled (#13483)');
  });

  it('throws CommitNotFoundError on 404', async () => {
    const fetch = queuedFetch(errResp(404));
    const c = makeGiteaProvider('codeberg.org', { fetch });
    await expect(c.getCommit(FORGEJO, 'deadbee')).rejects.toBeInstanceOf(CommitNotFoundError);
  });
});

describe('GiteaProvider.listTagsWithDates', () => {
  it('returns tags from a single page (commit.sha + commit.created)', async () => {
    // Real tag shape (verified live): { name, id, commit:{ sha, created } }.
    const fetch = queuedFetch(
      jsonResp([
        {
          name: 'v16.0.1',
          id: 'b3d7e4ac',
          commit: { sha: 'b3d7e4ac', created: '2026-07-20T18:00:33+02:00' },
        },
        {
          name: 'v16.0.0',
          id: 'aaaa1111',
          commit: { sha: 'aaaa1111', created: '2026-06-01T10:00:00Z' },
        },
      ]),
    );
    const c = makeGiteaProvider('codeberg.org', { fetch });
    const { tags } = await c.listTagsWithDates(FORGEJO);
    expect(tags).toHaveLength(2);
    expect(tags[0]?.name).toBe('v16.0.1');
    expect(tags[0]?.sha).toBe('b3d7e4ac');
    expect(tags[0]?.date).toBe('2026-07-20T18:00:33+02:00');
    expect(tags[0]?.isPrerelease).toBe(false);
  });

  it('paginates by incrementing page= until a short page arrives', async () => {
    // Gitea paginates with ?limit=&page= (no Link header needed). A full page
    // (== limit) means another page may exist; a short page ends the walk.
    const page = (n: number, count: number) => {
      const tags = Array.from({ length: count }, (_, i) => ({
        name: `v${n}.${i}`,
        commit: { sha: `s${n}${i}`, created: '2026-01-01T00:00:00Z' },
      }));
      return jsonResp(tags);
    };
    // limit=100: page 1 returns 100 (full) → fetch page 2; page 2 returns 2 (short) → stop.
    const fetch = queuedFetch(page(1, 100), page(2, 2));
    const c = makeGiteaProvider('codeberg.org', { fetch });
    const { tags } = await c.listTagsWithDates(FORGEJO);
    expect(tags).toHaveLength(102);
  });

  it('caps pagination at MAX_TAG_PAGES (5) — never eats the deadline budget', async () => {
    // Every page full (100) → would walk forever without the cap.
    const fullPage = (n: number) =>
      jsonResp(
        Array.from({ length: 100 }, (_, i) => ({
          name: `v${n}.${i}`,
          commit: { sha: `s${n}${i}`, created: '2026-01-01T00:00:00Z' },
        })),
      );
    const fetch = queuedFetch(fullPage(1), fullPage(2), fullPage(3), fullPage(4), fullPage(5));
    const c = makeGiteaProvider('codeberg.org', { fetch });
    const { tags } = await c.listTagsWithDates(FORGEJO);
    expect(tags).toHaveLength(500); // 5 × 100, NOT more
  });

  it('returns empty list for repos with no tags', async () => {
    const fetch = queuedFetch(jsonResp([]));
    const c = makeGiteaProvider('codeberg.org', { fetch });
    const { tags } = await c.listTagsWithDates(FORGEJO);
    expect(tags).toEqual([]);
  });

  it('flags prerelease tag names', async () => {
    const fetch = queuedFetch(
      jsonResp([
        { name: 'v1.0.0-rc.1', commit: { sha: 's1', created: '2026-01-01T00:00:00Z' } },
        { name: 'v1.0.0', commit: { sha: 's2', created: '2026-02-01T00:00:00Z' } },
      ]),
    );
    const c = makeGiteaProvider('codeberg.org', { fetch });
    const { tags } = await c.listTagsWithDates(FORGEJO);
    expect(tags[0]?.isPrerelease).toBe(true);
    expect(tags[1]?.isPrerelease).toBe(false);
  });

  it('URL-encodes each segment of a nested project path (not the slashes)', async () => {
    const calls: string[] = [];
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResp([]);
    }) as unknown as typeof fetch;
    const c = makeGiteaProvider('gitea.com', { fetch: mockFetch });
    await c.listTagsWithDates(NESTED);
    // Gitea wants literal / between segments (unlike GitLab's single %2F token);
    // special chars within a segment are still encoded.
    expect(calls[0]).toContain('/repos/org/team/repo/tags');
  });
});

describe('GiteaProvider.compareCommits', () => {
  // Gitea /compare/{base}...{head} returns { total_commits, commits, files } —
  // NO GitHub-style 4-way status. total_commits = commits in HEAD not in BASE.
  // The find-release algorithm calls compareCommits(repo, base=tag.sha, head=commit)
  // and treats 'behind'|'identical' as "the tag CONTAINS the commit".

  it('returns "behind" when base contains head (total_commits === 0)', async () => {
    const fetch = queuedFetch(jsonResp({ total_commits: 0, commits: [] }));
    const c = makeGiteaProvider('codeberg.org', { fetch });
    const result = await c.compareCommits(FORGEJO, 'tagSha', 'commitSha');
    expect(result.status).toBe('behind');
  });

  it('returns "identical" when base === head', async () => {
    // Same ref: Gitea returns total_commits 0; we must distinguish identical
    // from behind via the ref equality (no compare_same_ref flag exists).
    const fetch = queuedFetch(jsonResp({ total_commits: 0, commits: [] }));
    const c = makeGiteaProvider('codeberg.org', { fetch });
    const result = await c.compareCommits(FORGEJO, 'sameSha', 'sameSha');
    expect(result.status).toBe('identical');
  });

  it('returns "ahead" when base does NOT contain head (total_commits > 0)', async () => {
    const fetch = queuedFetch(jsonResp({ total_commits: 574, commits: [{ sha: 'a' }] }));
    const c = makeGiteaProvider('codeberg.org', { fetch });
    const result = await c.compareCommits(FORGEJO, 'tagSha', 'commitSha');
    expect(result.status).toBe('ahead');
  });

  it('returns "diverged" on 404 (unrelated histories)', async () => {
    const fetch = queuedFetch(errResp(404));
    const c = makeGiteaProvider('codeberg.org', { fetch });
    const result = await c.compareCommits(FORGEJO, 'ancient', 'modern');
    expect(result.status).toBe('diverged');
  });

  it('requests the base...head three-dot compare path', async () => {
    const calls: string[] = [];
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResp({ total_commits: 0, commits: [] });
    }) as unknown as typeof fetch;
    const c = makeGiteaProvider('codeberg.org', { fetch: mockFetch });
    await c.compareCommits(FORGEJO, 'baseSHA', 'headSHA');
    expect(calls[0]).toContain('/compare/baseSHA...headSHA');
  });
});

describe('GiteaProvider.getReleaseNotes', () => {
  it('returns the release body + prerelease flag (Gitea exposes one, unlike GitLab)', async () => {
    const fetch = queuedFetch(
      jsonResp({
        tag_name: 'v16.0.1',
        body: '## What changed\n\n* fix a thing',
        prerelease: false,
      }),
    );
    const c = makeGiteaProvider('codeberg.org', { fetch });
    const result = await c.getReleaseNotes(FORGEJO, 'v16.0.1');
    expect(result.body).toContain('fix a thing');
    expect(result.isPrerelease).toBe(false);
  });

  it('surfaces prerelease=true when the release is flagged', async () => {
    const fetch = queuedFetch(jsonResp({ tag_name: 'v2.0.0-rc1', body: 'rc', prerelease: true }));
    const c = makeGiteaProvider('codeberg.org', { fetch });
    const result = await c.getReleaseNotes(FORGEJO, 'v2.0.0-rc1');
    expect(result.isPrerelease).toBe(true);
  });

  it('returns null body when no Release object exists for the tag (404)', async () => {
    const fetch = queuedFetch(errResp(404));
    const c = makeGiteaProvider('codeberg.org', { fetch });
    const result = await c.getReleaseNotes(FORGEJO, 'v16.0.1');
    expect(result.body).toBeNull();
    expect(result.isPrerelease).toBeNull();
  });

  it('requests /releases/tags/{tag} (per-tag lookup, not the list)', async () => {
    const calls: string[] = [];
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResp({ tag_name: 'v1', body: '', prerelease: false });
    }) as unknown as typeof fetch;
    const c = makeGiteaProvider('codeberg.org', { fetch: mockFetch });
    await c.getReleaseNotes(FORGEJO, 'v16.0.1');
    expect(calls[0]).toContain('/releases/tags/v16.0.1');
  });
});

describe('GiteaProvider.getIssueClosingCommit', () => {
  // Gitea's basic issue API has no reliable "closing PR" link (no closed_by).
  // The graceful closed_without_fix fallback renders a proper card — issue-input
  // is a secondary CUJ; this matches the documented limitation.

  it('returns open for an open issue', async () => {
    const fetch = queuedFetch(jsonResp({ state: 'open', title: 'Bug report' }));
    const c = makeGiteaProvider('codeberg.org', { fetch });
    const res = await c.getIssueClosingCommit(FORGEJO, 42);
    expect(res).toMatchObject({ state: 'open', title: 'Bug report' });
  });

  it('closed issue with no discoverable closing PR → closed_without_fix (graceful)', async () => {
    const fetch = queuedFetch(jsonResp({ state: 'closed', title: 'Done' }));
    const c = makeGiteaProvider('codeberg.org', { fetch });
    const res = await c.getIssueClosingCommit(FORGEJO, 42);
    expect(res).toMatchObject({ state: 'closed_without_fix', notPlanned: false });
  });

  it('throws IssueNotFoundError on a 404 for the issue itself', async () => {
    const fetch = queuedFetch(errResp(404));
    const c = makeGiteaProvider('codeberg.org', { fetch });
    await expect(c.getIssueClosingCommit(FORGEJO, 999)).rejects.toBeInstanceOf(IssueNotFoundError);
  });
});

describe('GiteaProvider — auth + rate-limit + errors', () => {
  it('attaches Authorization: token <PAT> when a token is provided', async () => {
    const calls: Request[] = [];
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input as Request | string, init));
      return jsonResp({
        sha: 'a'.repeat(40),
        commit: { committer: { date: '2026-01-01T00:00:00Z' }, message: 'x' },
      });
    }) as unknown as typeof fetch;
    const c = makeGiteaProvider('codeberg.org', { fetch: mockFetch, token: 'gpa_xyz123' });
    await c.getCommit(FORGEJO, 'abcdef1234');
    expect(calls[0]!.headers.get('authorization')).toBe('token gpa_xyz123');
  });

  it('parses the RFC 9211 ratelimit header for remaining/limit', async () => {
    const fetch = queuedFetch(
      jsonResp(
        { sha: 's', commit: { committer: { date: '2026-01-01T00:00:00Z' }, message: 'x' } },
        { remaining: 432, limit: 2000 },
      ),
    );
    const c = makeGiteaProvider('codeberg.org', { fetch });
    const result = await c.getCommit(FORGEJO, 'abc');
    expect(result.rateLimit?.remaining).toBe(432);
    expect(result.rateLimit?.limit).toBe(2000);
  });

  it('throws RateLimitError on 429 with remaining=0 (parses r=0 from the RFC header)', async () => {
    const fetch = queuedFetch(
      new Response(JSON.stringify({ message: 'rate limited' }), {
        status: 429,
        headers: {
          'content-type': 'application/json',
          ratelimit: '"baseline";r=0;t=600',
          'ratelimit-policy': '"baseline";q=2000;w=600',
        },
      }),
    );
    const c = makeGiteaProvider('codeberg.org', { fetch });
    try {
      await c.getCommit(FORGEJO, 'abc1234');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).providerHost).toBe('codeberg.org');
    }
  });

  it('throws ProviderServerError (with host) on persistent 5xx', async () => {
    const fetch = queuedFetch(errResp(503), errResp(503), errResp(503));
    const c = makeGiteaProvider('codeberg.org', { fetch });
    try {
      await c.getCommit(FORGEJO, 'abc1234');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderServerError);
      expect((err as ProviderServerError).providerHost).toBe('codeberg.org');
    }
  });
});
