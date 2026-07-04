import {
  IssueClosedWithoutFixError,
  IssueNotClosedError,
  IssueNotFoundError,
  type LookupResult,
  NoReleasesError,
  NotYetReleasedError,
  PrNotMergedError,
  RateLimitError,
} from '@released/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pkg from '../package.json' with { type: 'json' };

// run() touches the network and the filesystem through three seams: the core
// algorithm (`findRelease`/`providerFor`), token resolution (`resolveToken`),
// and the on-disk cache (`makeFileCache`). Mock exactly those so the test
// exercises run()'s own plumbing — flag threading, exit codes, error→message
// mapping, cache hit/miss — against the real parseInput, real cacheKey, real
// formatResult, and the real error classes (needed for the instanceof ladder).
// Hoisted so the (also-hoisted) vi.mock factories below can close over them.
const { findRelease, providerFor, resolveToken, cacheGet, cachePut, makeFileCache } = vi.hoisted(
  () => {
    const cacheGet = vi.fn(async (_key: string) => null as LookupResult | null);
    const cachePut = vi.fn(async () => {});
    return {
      findRelease: vi.fn(),
      providerFor: vi.fn(() => ({}) as never),
      resolveToken: vi.fn(async () => undefined as string | undefined),
      cacheGet,
      cachePut,
      makeFileCache: vi.fn(() => ({ get: cacheGet, put: cachePut })),
    };
  },
);

vi.mock('@released/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@released/core')>();
  return { ...actual, findRelease, providerFor };
});
vi.mock('../src/auth.js', () => ({ resolveToken }));
vi.mock('../src/cache.js', () => ({ makeFileCache }));

// Imported after the mocks are registered.
const { VERSION, run } = await import('../src/app.js');

// A canonical GitHub commit URL so the real parseInput yields a `commit` input
// for github.com/facebook/react — the lookup itself is mocked per test.
const COMMIT_URL = 'github.com/facebook/react/commit/a1b2c3d4e5f67890abcdef1234567890abcdef12';
const SHA = 'a1b2c3d4e5f67890abcdef1234567890abcdef12';

// A GitHub issue URL so the real parseInput yields an `issue` input (kind:'issue',
// number:456) — the third way to name a commit (#54). The lookup is mocked per test;
// these exercise run()'s issue plumbing: refKey → cache key, exit codes, error mapping.
const ISSUE_URL = 'github.com/facebook/react/issues/456';

function releasedResult(): LookupResult {
  return {
    input: {
      kind: 'commit',
      repo: { host: 'github.com', projectPath: 'facebook/react' },
      sha: SHA,
    },
    urls: {
      repo: 'https://github.com/facebook/react',
      commit: `https://github.com/facebook/react/commit/${SHA}`,
    },
    canonicalSha: SHA,
    firstRelease: {
      tag: 'v18.2.0',
      sha: 'shav1820',
      date: '2024-03-15T00:00:00Z',
      url: 'https://github.com/facebook/react/releases/tag/v18.2.0',
    },
    alsoIn: [],
    releaseNotesHtml: null,
    rateLimit: null,
  };
}

function notYetResult(): LookupResult {
  return { ...releasedResult(), firstRelease: null };
}

// A released-issue result: the fix landed and shipped in v18.2.0. `input.kind`
// is 'issue' (number, no sha), the shape findRelease returns for an issue lookup.
function issueResult(): LookupResult {
  return {
    ...releasedResult(),
    input: {
      kind: 'issue',
      repo: { host: 'github.com', projectPath: 'facebook/react' },
      number: 456,
    },
  };
}

// Collect into arrays via mockImplementation rather than reading a typed spy:
// process.stdout.write is an overloaded signature that doesn't unify with the
// generic MockInstance type, so storing the spy in a typed variable trips tsc.
let stdoutChunks: string[] = [];
let stderrChunks: string[] = [];

beforeEach(() => {
  stdoutChunks = [];
  stderrChunks = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdoutChunks.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderrChunks.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  findRelease.mockReset();
  providerFor.mockClear();
  resolveToken.mockReset();
  resolveToken.mockResolvedValue(undefined);
  cacheGet.mockReset();
  cacheGet.mockResolvedValue(null);
  cachePut.mockReset();
  makeFileCache.mockClear();
});

function out(): string {
  return stdoutChunks.join('');
}
function err(): string {
  return stderrChunks.join('');
}

describe('VERSION', () => {
  it('matches the published package.json version', () => {
    // Regression guard: the CLI used to hardcode "0.0.0", so `--version` and
    // npm metadata disagreed on a published package.
    expect(VERSION).toBe(pkg.version);
  });

  it('is a real semver, never the 0.0.0 placeholder', () => {
    expect(VERSION).not.toBe('0.0.0');
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('run() — input handling', () => {
  it('returns exit code 2 and writes an error when input is missing', async () => {
    const code = await run(undefined, undefined, {});
    expect(code).toBe(2);
    expect(err()).toContain('missing input');
    expect(findRelease).not.toHaveBeenCalled();
  });

  it('maps a parse failure (unsupported host) to its error exit code', async () => {
    // parseInput is the REAL one here — an unsupported host throws before any
    // network seam, exercising the catch/reportError path end-to-end.
    const code = await run('https://example.com/foo/bar/commit/deadbeef', undefined, {});
    expect(code).toBe(2); // generic ReleasedError
    expect(err()).toMatch(/error:/);
    expect(findRelease).not.toHaveBeenCalled();
  });
});

describe('run() — success paths', () => {
  it('released commit → exit 0, formatted result on stdout', async () => {
    findRelease.mockResolvedValue(releasedResult());
    const code = await run(COMMIT_URL, undefined, {});
    expect(code).toBe(0);
    expect(out()).toContain('v18.2.0');
  });

  it('result with no firstRelease → exit 1 (not-yet, not an error)', async () => {
    findRelease.mockResolvedValue(notYetResult());
    const code = await run(COMMIT_URL, undefined, {});
    expect(code).toBe(1);
  });

  it('--json renders the JSON format, not the human format', async () => {
    findRelease.mockResolvedValue(releasedResult());
    const code = await run(COMMIT_URL, undefined, { json: true });
    expect(code).toBe(0);
    expect(() => JSON.parse(out())).not.toThrow();
  });
});

describe('run() — flag threading', () => {
  it('passes the --token flag and parsed host into resolveToken', async () => {
    findRelease.mockResolvedValue(releasedResult());
    await run(COMMIT_URL, undefined, { token: 'ghp-abc' });
    expect(resolveToken).toHaveBeenCalledWith(
      expect.objectContaining({ tokenFlag: 'ghp-abc', host: 'github.com' }),
    );
  });

  it('threads --strict and --include-prereleases into findRelease', async () => {
    findRelease.mockResolvedValue(releasedResult());
    await run(COMMIT_URL, undefined, { strict: true, includePrereleases: true });
    expect(findRelease).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ strict: true, includePrereleases: true }),
    );
  });
});

describe('run() — cache behaviour', () => {
  it('cache hit short-circuits: findRelease is never called', async () => {
    cacheGet.mockResolvedValue(releasedResult());
    const code = await run(COMMIT_URL, undefined, {});
    expect(code).toBe(0);
    expect(findRelease).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled();
  });

  it('cache miss: findRelease runs and the result is written back', async () => {
    cacheGet.mockResolvedValue(null);
    findRelease.mockResolvedValue(releasedResult());
    const code = await run(COMMIT_URL, undefined, {});
    expect(code).toBe(0);
    expect(findRelease).toHaveBeenCalledOnce();
    expect(cachePut).toHaveBeenCalledOnce();
  });

  it('--no-cache bypasses the cache entirely (no get, no put, no construction)', async () => {
    findRelease.mockResolvedValue(releasedResult());
    const code = await run(COMMIT_URL, undefined, { noCache: true });
    expect(code).toBe(0);
    expect(makeFileCache).not.toHaveBeenCalled();
    expect(cacheGet).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled();
  });
});

describe('run() — error class → exit code mapping', () => {
  it('NoReleasesError → exit 4', async () => {
    findRelease.mockRejectedValue(new NoReleasesError());
    expect(await run(COMMIT_URL, undefined, {})).toBe(4);
    expect(err()).toMatch(/error:/);
  });

  it('NotYetReleasedError → exit 1', async () => {
    findRelease.mockRejectedValue(new NotYetReleasedError(SHA, '2024-01-01T00:00:00Z'));
    expect(await run(COMMIT_URL, undefined, {})).toBe(1);
  });

  it('PrNotMergedError → exit 3', async () => {
    findRelease.mockRejectedValue(new PrNotMergedError(123, 'open'));
    expect(await run(COMMIT_URL, undefined, {})).toBe(3);
  });

  it('RateLimitError → exit 5', async () => {
    findRelease.mockRejectedValue(new RateLimitError(1715000000, 'github.com'));
    expect(await run(COMMIT_URL, undefined, {})).toBe(5);
  });

  it('a non-ReleasedError (unexpected) → exit 70', async () => {
    findRelease.mockRejectedValue(new Error('socket hang up'));
    expect(await run(COMMIT_URL, undefined, {})).toBe(70);
    expect(err()).toContain('socket hang up');
  });
});

describe('run() — not-yet-released hints (human mode)', () => {
  it('culled tags hint at --strict, prereleases hint at --include-prereleases', async () => {
    findRelease.mockRejectedValue(new NotYetReleasedError(SHA, '2024-01-01T00:00:00Z', 3, 2));
    const code = await run(COMMIT_URL, undefined, {});
    expect(code).toBe(1);
    expect(err()).toContain('--strict');
    expect(err()).toContain('--include-prereleases');
  });

  it('emits no hint when no tags were skipped', async () => {
    findRelease.mockRejectedValue(new NotYetReleasedError(SHA, '2024-01-01T00:00:00Z', 0, 0));
    await run(COMMIT_URL, undefined, {});
    expect(err()).not.toContain('--strict');
    expect(err()).not.toContain('--include-prereleases');
  });

  it('suppresses the hint for a flag already in effect', async () => {
    findRelease.mockRejectedValue(new NotYetReleasedError(SHA, '2024-01-01T00:00:00Z', 3, 2));
    await run(COMMIT_URL, undefined, { strict: true, includePrereleases: true });
    // Both culls are explained by flags already set → no nagging hints.
    expect(err()).not.toContain('Re-run with --strict');
    expect(err()).not.toContain('Re-run with --include-prereleases');
  });
});

describe('run() — JSON error envelope', () => {
  it('emits {error, message} on stdout (not stderr) for a ReleasedError', async () => {
    findRelease.mockRejectedValue(new NoReleasesError());
    const code = await run(COMMIT_URL, undefined, { json: true });
    expect(code).toBe(4);
    const env = JSON.parse(out());
    expect(env).toMatchObject({ error: 'no_releases' });
    expect(typeof env.message).toBe('string');
    expect(err()).toBe(''); // JSON mode keeps stderr clean for piping
  });

  it('carries culledTagCount + prerelease hints into the JSON envelope', async () => {
    findRelease.mockRejectedValue(new NotYetReleasedError(SHA, '2024-01-01T00:00:00Z', 3, 2));
    const code = await run(COMMIT_URL, undefined, { json: true });
    expect(code).toBe(1);
    const env = JSON.parse(out());
    expect(env.error).toBe('not_yet_released');
    expect(env.culledTagCount).toBe(3);
    expect(env.prereleasedSkippedCount).toBe(2);
    expect(Array.isArray(env.hint)).toBe(true);
    expect(env.hint.join(' ')).toMatch(/--strict/);
    expect(env.hint.join(' ')).toMatch(/--include-prereleases/);
  });

  it('falls back to a stderr message for a non-ReleasedError even in JSON mode', async () => {
    findRelease.mockRejectedValue(new Error('socket hang up'));
    const code = await run(COMMIT_URL, undefined, { json: true });
    expect(code).toBe(70);
    expect(err()).toContain('socket hang up');
    expect(out()).toBe('');
  });
});

// Issue input (#54) is the third way to name a commit: paste an issue URL, get
// the release that shipped its fix. The web surface got 5 integration tests; the
// CLI shares the same core (parseInput → findRelease → reportError) but had ZERO
// coverage of the issue path, so a regression here was invisible. These lock the
// contract: an issue URL routes through the same plumbing as a commit, keyed by
// `issue#N`, and the issue-specific error classes map to calm, correct output.
describe('run() — issue input', () => {
  it('parses an issue URL and threads the issue input into findRelease', async () => {
    findRelease.mockResolvedValue(issueResult());
    await run(ISSUE_URL, undefined, {});
    expect(findRelease).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'issue', number: 456 }),
      expect.anything(),
    );
  });

  it('released issue (fix shipped) → exit 0, formatted result on stdout', async () => {
    findRelease.mockResolvedValue(issueResult());
    const code = await run(ISSUE_URL, undefined, {});
    expect(code).toBe(0);
    expect(out()).toContain('v18.2.0');
  });

  it('keys the issue lookup distinctly from a commit lookup on the same repo (no collision)', async () => {
    // The cache key is a hash, so the `issue#N` refKey isn't literally visible —
    // but an issue and a commit on facebook/react must never share a key, or a
    // warmed badge/permalink would serve one the other's answer.
    findRelease.mockResolvedValue(issueResult());
    await run(ISSUE_URL, undefined, {});
    expect(cacheGet).toHaveBeenCalledOnce();
    const issueKey = cacheGet.mock.calls[0]?.[0];

    cacheGet.mockClear();
    findRelease.mockResolvedValue(releasedResult());
    await run(COMMIT_URL, undefined, {});
    const commitKey = cacheGet.mock.calls[0]?.[0];

    expect(issueKey).toBeTruthy();
    expect(issueKey).not.toBe(commitKey);
  });

  it('IssueNotClosedError (still open) → calm stderr message, "not yet" exit 1 (PR/NotYetReleased parity)', async () => {
    // A still-open issue whose fix can still land is the issue-input twin of
    // NotYetReleasedError: the web renders both as the calm gold "not yet" card.
    // So the CLI mirrors that with exit 1, not the generic ReleasedError exit 2 —
    // a script asking "did this issue's fix ship?" can tell "not yet" from a hard
    // failure. Free to choose: issue input never shipped in a published release.
    findRelease.mockRejectedValue(new IssueNotClosedError(456));
    const code = await run(ISSUE_URL, undefined, {});
    expect(code).toBe(1);
    // Reads as a calm statement of fact, not a stack trace or the wrong "not released".
    expect(err()).toContain('still open');
    expect(err()).not.toMatch(/undefined|\[object/);
  });

  it('IssueClosedWithoutFixError → calm stderr message, exit 2', async () => {
    findRelease.mockRejectedValue(new IssueClosedWithoutFixError(456));
    const code = await run(ISSUE_URL, undefined, {});
    expect(code).toBe(2);
    expect(err()).toContain('no fixing commit');
  });

  it('IssueNotFoundError → exit 2 with the issue number in the message', async () => {
    findRelease.mockRejectedValue(new IssueNotFoundError(456));
    const code = await run(ISSUE_URL, undefined, {});
    expect(code).toBe(2);
    expect(err()).toContain('#456');
  });

  it('--json emits the issue error kind in the envelope, stderr stays clean', async () => {
    findRelease.mockRejectedValue(new IssueClosedWithoutFixError(456, true));
    const code = await run(ISSUE_URL, undefined, { json: true });
    expect(code).toBe(2);
    const env = JSON.parse(out());
    expect(env).toMatchObject({ error: 'issue_closed_without_fix' });
    expect(typeof env.message).toBe('string');
    expect(err()).toBe(''); // JSON mode keeps stderr clean for piping
  });
});
