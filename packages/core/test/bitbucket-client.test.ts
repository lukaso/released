import { describe, expect, it, vi } from 'vitest';
import {
  CommitNotFoundError,
  IssueNotFoundError,
  PrMergeCommitUnavailableError,
  PrNotFoundError,
  PrNotMergedError,
} from '../src/errors.js';
import { makeBitbucketProvider } from '../src/providers/bitbucket/client.js';
import type { RepoRef } from '../src/types.js';

/**
 * Bitbucket Cloud REST 2.0 provider tests. Mirror the GitLab client tests'
 * queuedFetch pattern. Bitbucket Cloud does not emit GitLab/GitHub-style
 * rate-limit headers reliably, so the provider must tolerate their absence
 * (rateLimit → null). When present, we read x-ratelimit-* (lowercase on read).
 */
function jsonResp(
  body: unknown,
  init: {
    status?: number;
    remaining?: number | null;
    limit?: number | null;
    resetAt?: number | null;
    link?: string;
    next?: string;
  } = {},
): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  // null (explicit) → omit the header entirely (Bitbucket often omits these).
  if (init.remaining !== null && init.remaining !== undefined) {
    headers['x-ratelimit-remaining'] = String(init.remaining);
    headers['x-ratelimit-limit'] = String(init.limit ?? 2000);
    headers['x-ratelimit-reset'] = String(init.resetAt ?? Math.floor(Date.now() / 1000) + 600);
  }
  // Bitbucket pagination is a `next` field in the JSON body, not a Link header.
  // Tests may set `next` directly in the body instead; `link` is unused but kept
  // for shape parity.
  if (init.link) headers.link = init.link;
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

function errResp(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function queuedFetch(...responses: (Response | Error)[]): typeof fetch {
  const queue = [...responses];
  return vi.fn(async (input: RequestInfo | URL) => {
    const next = queue.shift();
    if (!next) throw new Error('queuedFetch: queue exhausted');
    if (next instanceof Error) throw next;
    // Capture the URL on the mock for direction assertions (ancestry).
    lastUrl = typeof input === 'string' ? input : input.toString();
    return next;
  }) as unknown as typeof fetch;
}

let lastUrl = '';
const urlOf = (fetchImpl: unknown): string =>
  (fetchImpl as { _harnessUrl?: string })._harnessUrl ?? lastUrl;

const ATLAS: RepoRef = { host: 'bitbucket.org', projectPath: 'atlassian/confluence' };

describe('BitbucketProvider identity', () => {
  it('self-describes Bitbucket terms (Pull request, #) and kind', () => {
    const c = makeBitbucketProvider({ fetch: queuedFetch() });
    expect(c.host).toBe('bitbucket.org');
    expect(c.kind).toBe('bitbucket');
    expect(c.terms).toEqual({ mergeRequest: 'Pull request', mergeRequestPrefix: '#' });
  });
});

describe('BitbucketProvider.getPullRequest', () => {
  it('returns merge_commit.hash + title for a MERGED pull request', async () => {
    const fetch = queuedFetch(
      jsonResp({ state: 'MERGED', merge_commit: { hash: 'abc123' }, title: 'Ship feature' }),
    );
    const c = makeBitbucketProvider({ fetch });
    const result = await c.getPullRequest(ATLAS, 7);
    expect(result.mergeCommitSha).toBe('abc123');
    expect(result.title).toBe('Ship feature');
  });

  it('throws PrNotMergedError for an OPEN pull request', async () => {
    const fetch = queuedFetch(jsonResp({ state: 'OPEN', merge_commit: null }));
    const c = makeBitbucketProvider({ fetch });
    await expect(c.getPullRequest(ATLAS, 7)).rejects.toBeInstanceOf(PrNotMergedError);
  });

  it('throws PrNotMergedError for a DECLINED pull request (state = declined)', async () => {
    const fetch = queuedFetch(jsonResp({ state: 'DECLINED', merge_commit: null }));
    const c = makeBitbucketProvider({ fetch });
    await expect(c.getPullRequest(ATLAS, 7)).rejects.toBeInstanceOf(PrNotMergedError);
  });

  it('throws PrMergeCommitUnavailableError when merged but merge_commit.hash missing', async () => {
    const fetch = queuedFetch(jsonResp({ state: 'MERGED', merge_commit: null }));
    const c = makeBitbucketProvider({ fetch });
    await expect(c.getPullRequest(ATLAS, 7)).rejects.toBeInstanceOf(PrMergeCommitUnavailableError);
  });

  it('throws PrNotFoundError on 404', async () => {
    const fetch = queuedFetch(errResp(404, { error: { message: 'not found' } }));
    const c = makeBitbucketProvider({ fetch });
    await expect(c.getPullRequest(ATLAS, 7)).rejects.toBeInstanceOf(PrNotFoundError);
  });
});

describe('BitbucketProvider.getCommit', () => {
  it('returns full hash + committed date + first-line subject from message', async () => {
    const fetch = queuedFetch(
      jsonResp({
        hash: 'abcdef1234567890',
        date: '2024-03-15T10:00:00+00:00',
        message: 'Fix the thing\n\nLong body paragraph.',
      }),
    );
    const c = makeBitbucketProvider({ fetch });
    const result = await c.getCommit(ATLAS, 'abcdef12');
    expect(result.fullSha).toBe('abcdef1234567890');
    expect(result.committedDate).toBe('2024-03-15T10:00:00+00:00');
    expect(result.subject).toBe('Fix the thing');
  });

  it('subject is null when there is no message', async () => {
    const fetch = queuedFetch(jsonResp({ hash: 'deadbeef', date: '2024-01-01T00:00:00Z' }));
    const c = makeBitbucketProvider({ fetch });
    const result = await c.getCommit(ATLAS, 'deadbeef');
    expect(result.subject).toBeNull();
  });

  it('throws CommitNotFoundError on 404', async () => {
    const fetch = queuedFetch(errResp(404));
    const c = makeBitbucketProvider({ fetch });
    await expect(c.getCommit(ATLAS, 'missing123')).rejects.toBeInstanceOf(CommitNotFoundError);
  });
});

describe('BitbucketProvider.compareCommits — ANCESTRY DIRECTION (the core risk)', () => {
  // find-release calls compareCommits(repo, base=TAG_SHA, head=TARGET_COMMIT)
  // and treats status 'behind'|'identical' as "the tag CONTAINS the commit".
  // That is true exactly when the target commit is an ANCESTOR of the tag.
  //
  // Bitbucket's commits endpoint: commits?include=A&exclude=B returns commits
  // reachable from A but not from B. To test "head is ancestor of base" we ask
  // for commits reachable from head but not base (include=head, exclude=base):
  //   - empty  → head ⊆ base → head is ancestor of base → CONTAINS ('behind')
  //   - present → head ⊄ base → does NOT contain ('ahead')
  // This mirrors GitLab's from=base&to=head (commits in head-not-in-base).

  const TAG_SHA = 'ffffffff'; // base — a release tag's commit
  const TARGET = 'aaaaaaaa'; // head — the commit we're asking about

  it('returns "behind" (contains) when the commit is an ancestor of the tag', async () => {
    // No commits in target-not-in-tag → target ⊆ tag → contains.
    const fetch = queuedFetch(jsonResp({ pagelen: 1, size: 0, values: [] }));
    const c = makeBitbucketProvider({ fetch });
    const r = await c.compareCommits(ATLAS, TAG_SHA, TARGET);
    expect(r.status).toBe('behind');
    // Lock the URL direction: must be include={head}&exclude={base}.
    expect(lastUrl).toContain('include=aaaaaaaa');
    expect(lastUrl).toContain('exclude=ffffffff');
  });

  it('returns "ahead" (not contained) when the tag does not contain the commit', async () => {
    // Commits in target-not-in-tag present → target has work the tag lacks.
    const fetch = queuedFetch(jsonResp({ pagelen: 1, size: 3, values: [{ hash: 'cccccccc' }] }));
    const c = makeBitbucketProvider({ fetch });
    const r = await c.compareCommits(ATLAS, TAG_SHA, TARGET);
    expect(r.status).toBe('ahead');
  });

  it('returns "diverged" on 404 (no relationship / SHA not found)', async () => {
    const fetch = queuedFetch(errResp(404));
    const c = makeBitbucketProvider({ fetch });
    const r = await c.compareCommits(ATLAS, TAG_SHA, TARGET);
    expect(r.status).toBe('diverged');
  });
});

describe('BitbucketProvider.listTagsWithDates', () => {
  it('follows the body `next` link across pages and maps target.hash + target.date', async () => {
    const fetch = queuedFetch(
      jsonResp({
        pagelen: 2,
        page: 1,
        values: [
          { name: 'v2.0.0', target: { hash: 'h200', date: '2024-02-01T00:00:00Z' } },
          { name: 'v1.0.0', target: { hash: 'h100', date: '2024-01-01T00:00:00Z' } },
        ],
        next: 'https://api.bitbucket.org/2.0/repositories/atlassian/confluence/refs/tags?pagelen=2&sort=-target.date&page=2',
      }),
      jsonResp({
        pagelen: 2,
        page: 2,
        values: [{ name: 'v0.9.0-beta', target: { hash: 'h090', date: '2023-12-01T00:00:00Z' } }],
      }),
    );
    const c = makeBitbucketProvider({ fetch });
    const { tags } = await c.listTagsWithDates(ATLAS);
    expect(tags.map((t) => t.name)).toEqual(['v2.0.0', 'v1.0.0', 'v0.9.0-beta']);
    expect(tags[0]).toEqual({
      name: 'v2.0.0',
      sha: 'h200',
      date: '2024-02-01T00:00:00Z',
      isPrerelease: false,
    });
    expect(tags[2]?.isPrerelease).toBe(true); // -beta heuristic
  });

  it('skips tags whose target lacks a hash', async () => {
    const fetch = queuedFetch(
      jsonResp({
        values: [
          { name: 'good', target: { hash: 'hg', date: '2024-01-01T00:00:00Z' } },
          { name: 'bad', target: {} },
        ],
      }),
    );
    const c = makeBitbucketProvider({ fetch });
    const { tags } = await c.listTagsWithDates(ATLAS);
    expect(tags.map((t) => t.name)).toEqual(['good']);
  });
});

describe('BitbucketProvider.getReleaseNotes', () => {
  it('returns null body + null prerelease WITHOUT a network call (Bitbucket has no Releases API)', async () => {
    const fetch = queuedFetch();
    const c = makeBitbucketProvider({ fetch });
    const r = await c.getReleaseNotes(ATLAS, 'v1.0.0');
    expect(r.body).toBeNull();
    expect(r.isPrerelease).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('BitbucketProvider.getIssueClosingCommit', () => {
  it('returns "open" for an open issue', async () => {
    const fetch = queuedFetch(jsonResp({ state: 'open', title: 'Bug X' }));
    const c = makeBitbucketProvider({ fetch });
    const r = await c.getIssueClosingCommit(ATLAS, 12);
    expect(r.state).toBe('open');
    expect(r.title).toBe('Bug X');
  });

  it('returns "closed_without_fix" for a closed issue (Bitbucket issue→commit linkage is not exposed)', async () => {
    const fetch = queuedFetch(jsonResp({ state: 'resolved', title: 'Y' }));
    const c = makeBitbucketProvider({ fetch });
    const r = await c.getIssueClosingCommit(ATLAS, 12);
    expect(r.state).toBe('closed_without_fix');
  });

  it('throws IssueNotFoundError on 404 (issue tracker disabled)', async () => {
    const fetch = queuedFetch(errResp(404));
    const c = makeBitbucketProvider({ fetch });
    await expect(c.getIssueClosingCommit(ATLAS, 12)).rejects.toBeInstanceOf(IssueNotFoundError);
  });
});

describe('BitbucketProvider.urls', () => {
  it('builds Bitbucket Cloud canonical URLs', () => {
    const c = makeBitbucketProvider({ fetch: queuedFetch() });
    const r = ATLAS;
    expect(c.urls.repo(r)).toBe('https://bitbucket.org/atlassian/confluence');
    expect(c.urls.commit(r, 'abc123')).toBe(
      'https://bitbucket.org/atlassian/confluence/commits/abc123',
    );
    expect(c.urls.pullRequest(r, 7)).toBe(
      'https://bitbucket.org/atlassian/confluence/pull-requests/7',
    );
    expect(c.urls.issue(r, 12)).toBe('https://bitbucket.org/atlassian/confluence/issues/12');
    expect(c.urls.release(r, 'v1.0.0')).toBe(
      'https://bitbucket.org/atlassian/confluence/src/v1.0.0',
    );
  });
});

// Keep the harness-url helper referenced so TS doesn't strip it under unused checks.
void urlOf;
