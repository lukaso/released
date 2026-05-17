import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AmbiguousShaError,
  CommitNotFoundError,
  GitHubServerError,
  NetworkError,
  PrMergeCommitUnavailableError,
  PrNotFoundError,
  PrNotMergedError,
  RateLimitError,
} from '../src/errors.js';
import { makeGithubClient } from '../src/github.js';

/** Build a Response with sensible default rate-limit headers. */
function jsonResp(
  body: unknown,
  init: { status?: number; remaining?: number; limit?: number; resetAt?: number } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'content-type': 'application/json',
      'x-ratelimit-remaining': String(init.remaining ?? 4999),
      'x-ratelimit-limit': String(init.limit ?? 5000),
      'x-ratelimit-reset': String(init.resetAt ?? Math.floor(Date.now() / 1000) + 3600),
    },
  });
}

function errResp(status: number, body: unknown = {}, remaining = 4999): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'x-ratelimit-remaining': String(remaining),
      'x-ratelimit-limit': '5000',
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
    },
  });
}

/** Make a fetch mock that returns queued responses in order. */
function queuedFetch(...responses: (Response | Error)[]): typeof fetch {
  const queue = [...responses];
  return vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error('queuedFetch: queue exhausted');
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
}

afterEach(() => vi.restoreAllMocks());

describe('getPullRequest', () => {
  it('returns merge commit sha for a merged PR', async () => {
    const fetch = queuedFetch(jsonResp({ merged: true, merge_commit_sha: 'abc123def456' }));
    const c = makeGithubClient({ fetch });
    const result = await c.getPullRequest(
      { host: 'github.com', projectPath: 'vercel/next.js' },
      56012,
    );
    expect(result.merged).toBe(true);
    expect(result.mergeCommitSha).toBe('abc123def456');
  });

  it('throws PrNotMergedError when not merged', async () => {
    const fetch = queuedFetch(jsonResp({ merged: false, merge_commit_sha: null }));
    const c = makeGithubClient({ fetch });
    await expect(
      c.getPullRequest({ host: 'github.com', projectPath: 'vercel/next.js' }, 56012),
    ).rejects.toBeInstanceOf(PrNotMergedError);
  });

  it('throws PrMergeCommitUnavailableError when merged=true but merge_commit_sha=null', async () => {
    const fetch = queuedFetch(jsonResp({ merged: true, merge_commit_sha: null }));
    const c = makeGithubClient({ fetch });
    await expect(
      c.getPullRequest({ host: 'github.com', projectPath: 'vercel/next.js' }, 56012),
    ).rejects.toBeInstanceOf(PrMergeCommitUnavailableError);
  });

  it('throws PrNotFoundError on 404', async () => {
    const fetch = queuedFetch(errResp(404));
    const c = makeGithubClient({ fetch });
    await expect(
      c.getPullRequest({ host: 'github.com', projectPath: 'vercel/next.js' }, 99999999),
    ).rejects.toBeInstanceOf(PrNotFoundError);
  });
});

describe('getCommit', () => {
  it('returns full SHA + committed date', async () => {
    const fetch = queuedFetch(
      jsonResp({
        sha: 'abc1234567890abcdefabcdefabcdefabcdef1234',
        commit: { committer: { date: '2024-03-01T12:00:00Z' } },
      }),
    );
    const c = makeGithubClient({ fetch });
    const result = await c.getCommit(
      { host: 'github.com', projectPath: 'facebook/react' },
      'abc1234',
    );
    expect(result.fullSha).toBe('abc1234567890abcdefabcdefabcdefabcdef1234');
    expect(result.committedDate).toBe('2024-03-01T12:00:00Z');
  });

  it('throws CommitNotFoundError on 404', async () => {
    const fetch = queuedFetch(errResp(404));
    const c = makeGithubClient({ fetch });
    await expect(
      c.getCommit({ host: 'github.com', projectPath: 'facebook/react' }, 'deadbee'),
    ).rejects.toBeInstanceOf(CommitNotFoundError);
  });

  it('throws AmbiguousShaError on 422', async () => {
    const fetch = queuedFetch(errResp(422, { message: 'ambiguous' }));
    const c = makeGithubClient({ fetch });
    await expect(
      c.getCommit({ host: 'github.com', projectPath: 'facebook/react' }, 'abc1234'),
    ).rejects.toBeInstanceOf(AmbiguousShaError);
  });
});

describe('listTagsWithDates (GraphQL paginated)', () => {
  it('returns tags from a single page (lightweight + annotated mix)', async () => {
    const fetch = queuedFetch(
      jsonResp({
        data: {
          repository: {
            refs: {
              nodes: [
                {
                  name: 'v18.2.0',
                  target: {
                    __typename: 'Commit',
                    oid: 'sha18_2_0',
                    committedDate: '2024-03-15T00:00:00Z',
                  },
                },
                {
                  name: 'v18.1.0',
                  target: {
                    __typename: 'Tag',
                    tagger: { date: '2024-02-01T00:00:00Z' },
                    target: {
                      __typename: 'Commit',
                      oid: 'sha18_1_0',
                      committedDate: '2024-01-31T23:00:00Z',
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      }),
    );
    const c = makeGithubClient({ fetch });
    const { tags } = await c.listTagsWithDates({
      host: 'github.com',
      projectPath: 'facebook/react',
    });
    expect(tags).toHaveLength(2);
    expect(tags[0]).toEqual({
      name: 'v18.2.0',
      sha: 'sha18_2_0',
      date: '2024-03-15T00:00:00Z',
      isPrerelease: false,
    });
    // Annotated tag prefers the tagger date over the underlying commit date.
    expect(tags[1]).toEqual({
      name: 'v18.1.0',
      sha: 'sha18_1_0',
      date: '2024-02-01T00:00:00Z',
      isPrerelease: false,
    });
  });

  it('paginates across 3 pages', async () => {
    const page = (cursor: string | null, names: string[]) =>
      jsonResp({
        data: {
          repository: {
            refs: {
              nodes: names.map((n) => ({
                name: n,
                target: {
                  __typename: 'Commit',
                  oid: `sha_${n}`,
                  committedDate: '2024-01-01T00:00:00Z',
                },
              })),
              pageInfo: { hasNextPage: cursor !== null, endCursor: cursor },
            },
          },
        },
      });
    const fetch = queuedFetch(
      page('cursor1', ['a', 'b']),
      page('cursor2', ['c', 'd']),
      page(null, ['e']),
    );
    const c = makeGithubClient({ fetch });
    const { tags } = await c.listTagsWithDates({ host: 'github.com', projectPath: 'o/r' });
    expect(tags.map((t) => t.name)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('returns empty list for repos with no tags', async () => {
    const fetch = queuedFetch(
      jsonResp({
        data: {
          repository: { refs: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        },
      }),
    );
    const c = makeGithubClient({ fetch });
    const { tags } = await c.listTagsWithDates({ host: 'github.com', projectPath: 'o/r' });
    expect(tags).toEqual([]);
  });
});

describe('compareCommits', () => {
  for (const status of ['behind', 'identical', 'ahead', 'diverged'] as const) {
    it(`returns "${status}" verbatim`, async () => {
      const fetch = queuedFetch(jsonResp({ status }));
      const c = makeGithubClient({ fetch });
      const result = await c.compareCommits(
        { host: 'github.com', projectPath: 'o/r' },
        'base',
        'head',
      );
      expect(result.status).toBe(status);
    });
  }

  it('treats 422 (diverged) as "diverged"', async () => {
    const fetch = queuedFetch(errResp(422, { message: 'unmergeable' }));
    const c = makeGithubClient({ fetch });
    const result = await c.compareCommits(
      { host: 'github.com', projectPath: 'o/r' },
      'base',
      'head',
    );
    expect(result.status).toBe('diverged');
  });

  it('treats 404 ("No common ancestor") as "diverged" — unrelated histories', async () => {
    // GitHub returns 404 + "No common ancestor" for SHAs from unrelated histories
    // (e.g. CVS/SVN-imported pre-history tags vs modern git commits in the same repo).
    // Must NOT crash — keep walking the candidate list. Regression test for the
    // macports/macports-ports bug.
    const fetch = queuedFetch(
      errResp(404, {
        message: 'No common ancestor between abc and def.',
        documentation_url: 'https://docs.github.com/rest/commits/commits#compare-two-commits',
      }),
    );
    const c = makeGithubClient({ fetch });
    const result = await c.compareCommits(
      { host: 'github.com', projectPath: 'macports/macports-ports' },
      'ancient',
      'modern',
    );
    expect(result.status).toBe('diverged');
  });
});

describe('getReleaseNotes', () => {
  it('returns the release body when one exists', async () => {
    const fetch = queuedFetch(jsonResp({ body: '## Changes\n\n* fix: hydration' }));
    const c = makeGithubClient({ fetch });
    const result = await c.getReleaseNotes(
      { host: 'github.com', projectPath: 'facebook/react' },
      'v18.2.0',
    );
    expect(result.body).toContain('hydration');
  });

  it('returns null when no Release object exists for the tag (404)', async () => {
    const fetch = queuedFetch(errResp(404));
    const c = makeGithubClient({ fetch });
    const result = await c.getReleaseNotes(
      { host: 'github.com', projectPath: 'facebook/react' },
      'v18.2.0',
    );
    expect(result.body).toBeNull();
    expect(result.isPrerelease).toBeNull(); // no Release object → no opinion
  });

  it('plumbs the prerelease boolean through from the GitHub API (Layer 2)', async () => {
    const fetch = queuedFetch(jsonResp({ body: '## what changed', prerelease: true }));
    const c = makeGithubClient({ fetch });
    const result = await c.getReleaseNotes(
      { host: 'github.com', projectPath: 'facebook/react' },
      'v18.2.0-experimental',
    );
    expect(result.body).toBe('## what changed');
    expect(result.isPrerelease).toBe(true);
  });

  it('plumbs prerelease=false from the GitHub API (stable release)', async () => {
    const fetch = queuedFetch(jsonResp({ body: 'notes', prerelease: false }));
    const c = makeGithubClient({ fetch });
    const result = await c.getReleaseNotes(
      { host: 'github.com', projectPath: 'facebook/react' },
      'v18.2.0',
    );
    expect(result.isPrerelease).toBe(false);
  });
});

describe('rate-limit + network failure modes', () => {
  it('throws RateLimitError on 403 with remaining=0', async () => {
    const reset = Math.floor(Date.now() / 1000) + 600;
    const fetch = queuedFetch(errResp(403, { message: 'rate limit exceeded' }, 0));
    // Manually set reset on the response we just built:
    const c = makeGithubClient({
      fetch: queuedFetch(
        new Response('{"message":"rate limit exceeded"}', {
          status: 403,
          headers: {
            'content-type': 'application/json',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-limit': '60',
            'x-ratelimit-reset': String(reset),
          },
        }),
      ),
    });
    await expect(
      c.getCommit({ host: 'github.com', projectPath: 'o/r' }, 'abc1234'),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it('retries on 5xx then throws GitHubServerError', async () => {
    const fetch = queuedFetch(errResp(503), errResp(503), errResp(503));
    const c = makeGithubClient({ fetch });
    await expect(
      c.getCommit({ host: 'github.com', projectPath: 'o/r' }, 'abc1234'),
    ).rejects.toBeInstanceOf(GitHubServerError);
  });

  it('throws NetworkError when fetch itself fails', async () => {
    const fetch = queuedFetch(new TypeError('fetch failed'));
    const c = makeGithubClient({ fetch });
    await expect(
      c.getCommit({ host: 'github.com', projectPath: 'o/r' }, 'abc1234'),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws ProviderJsonError with Anubis hint pointing at CLI when body is the Anubis challenge', async () => {
    // Reproduces gitlab.freedesktop.org behavior. Anubis (techaro.lol) is a
    // proof-of-work bot challenge that fingerprints HTTP/2 + TLS BENEATH the
    // UA layer. workerd's fingerprint trips it; Node's (CLI) doesn't.
    // PRIVATE-TOKEN does NOT bypass — Anubis runs before API auth. So the
    // error must NOT suggest a token (it won't help); it must point at the CLI.
    const fetch = queuedFetch(
      new Response(
        '<!doctype html><html lang="en"><head><title>Making sure you\'re not a bot!</title><link rel="stylesheet" href="/.within.website/x/xess/xess.min.css">',
        { status: 200, headers: { 'content-type': 'text/html' } },
      ),
    );
    const { ProviderJsonError } = await import('../src/errors.js');
    const c = makeGithubClient({ fetch });
    try {
      await c.getCommit({ host: 'github.com', projectPath: 'o/r' }, 'abc1234');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderJsonError);
      const msg = (err as Error).message;
      expect(msg).toMatch(/Anubis/i);
      expect(msg).toMatch(/CLI/i);
      expect(msg).not.toMatch(/setting.*token/i);
    }
  });

  it('throws ProviderJsonError with Cloudflare hint pointing at a token when body is the CF interstitial', async () => {
    // Cloudflare's "Just a moment..." interstitial DOES exempt authenticated
    // requests, so the token suggestion is correct here.
    const fetch = queuedFetch(
      new Response(
        '<!doctype html><html><head><title>Just a moment...</title></head><body>Checking your browser before accessing the site. Cloudflare Ray ID: 9d11...',
        { status: 200, headers: { 'content-type': 'text/html' } },
      ),
    );
    const { ProviderJsonError } = await import('../src/errors.js');
    const c = makeGithubClient({ fetch });
    try {
      await c.getCommit({ host: 'github.com', projectPath: 'o/r' }, 'abc1234');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderJsonError);
      const msg = (err as Error).message;
      expect(msg).toMatch(/Cloudflare|anti-bot/i);
      expect(msg).toMatch(/token/i);
      expect(msg).not.toMatch(/Anubis/i);
    }
  });

  it('ProviderJsonError without bot-challenge signature falls back to generic message + snippet', async () => {
    const fetch = queuedFetch(
      new Response('not json at all, just plain text', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );
    const { ProviderJsonError } = await import('../src/errors.js');
    const c = makeGithubClient({ fetch });
    try {
      await c.getCommit({ host: 'github.com', projectPath: 'o/r' }, 'abc1234');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderJsonError);
      expect((err as Error).message).toContain('not json at all');
    }
  });
});

describe('token + headers', () => {
  it('attaches Authorization when a token is provided', async () => {
    const calls: Request[] = [];
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      // Reconstruct what was requested for assertion.
      const req = new Request(input as Request | string, init);
      calls.push(req);
      return jsonResp({
        sha: 'a'.repeat(40),
        commit: { committer: { date: '2024-01-01T00:00:00Z' } },
      });
    }) as unknown as typeof globalThis.fetch;
    const c = makeGithubClient({ fetch: mockFetch, token: 'ghp_test123' });
    await c.getCommit({ host: 'github.com', projectPath: 'o/r' }, 'abcdef1234');
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer ghp_test123');
    expect(calls[0]!.headers.get('accept')).toMatch(/application\/vnd.github/);
  });

  it('does not attach Authorization when no token is given', async () => {
    const calls: Request[] = [];
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input as Request | string, init));
      return jsonResp({
        sha: 'a'.repeat(40),
        commit: { committer: { date: '2024-01-01T00:00:00Z' } },
      });
    }) as unknown as typeof globalThis.fetch;
    const c = makeGithubClient({ fetch: mockFetch });
    await c.getCommit({ host: 'github.com', projectPath: 'o/r' }, 'abcdef1234');
    expect(calls[0]!.headers.get('authorization')).toBeNull();
  });
});
