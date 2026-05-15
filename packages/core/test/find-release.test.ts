import { describe, expect, it } from 'vitest';
import {
  AmbiguousShaError,
  CommitNotFoundError,
  LookupTimeoutError,
  NoReleasesError,
  NotYetReleasedError,
  PrNotMergedError,
  RateLimitError,
} from '../src/errors.js';
import { findRelease } from '../src/find-release.js';
import type { GithubClient } from '../src/github.js';
import type { LookupInput, RateLimitInfo, TagWithDate } from '../src/types.js';

/** Build a deterministic fake GithubClient for tests. */
function fakeClient(spec: {
  tags?: TagWithDate[];
  /** Which tags CONTAIN the input commit (truth — by tag name). */
  contains?: Set<string>;
  /** Override commit resolution. */
  commits?: Record<string, { fullSha: string; committedDate: string }>;
  /** Override PR resolution. */
  prs?: Record<number, { merged: boolean; mergeCommitSha: string | null }>;
  /** Release notes by tag. */
  releaseNotes?: Record<string, string | null>;
  /** Inject a rate-limit failure when compare is called for this many invocations. */
  rateLimitAfterCompares?: number;
  /** Add an artificial delay (ms) before each compare to test deadlines. */
  compareDelayMs?: number;
}): GithubClient & { stats: { compareCalls: number } } {
  const stats = { compareCalls: 0 };
  const rateLimit: RateLimitInfo = {
    remaining: 4999,
    limit: 5000,
    resetAt: Math.floor(Date.now() / 1000) + 3600,
  };

  return {
    stats,
    async getCommit(_o, _r, sha) {
      const found = spec.commits?.[sha];
      if (found) return { ...found, rateLimit };
      throw new CommitNotFoundError(sha);
    },
    async getPullRequest(_o, _r, n) {
      const pr = spec.prs?.[n];
      if (!pr) throw new Error(`fake: no PR ${n}`);
      if (!pr.merged) throw new PrNotMergedError(n);
      if (pr.mergeCommitSha == null) throw new Error('not merged');
      return { merged: true, mergeCommitSha: pr.mergeCommitSha, rateLimit };
    },
    async listTagsWithDates() {
      return { tags: spec.tags ?? [], rateLimit };
    },
    async compareCommits(_o, _r, base, _head) {
      stats.compareCalls += 1;
      if (spec.rateLimitAfterCompares != null && stats.compareCalls > spec.rateLimitAfterCompares) {
        throw new RateLimitError(rateLimit.resetAt);
      }
      if (spec.compareDelayMs) {
        await new Promise((r) => setTimeout(r, spec.compareDelayMs));
      }
      // Find the tag whose sha matches `base` (the tag side of the compare).
      const tag = (spec.tags ?? []).find((t) => t.sha === base);
      const contains = tag ? spec.contains?.has(tag.name) ?? false : false;
      // status === 'behind' or 'identical' means tag CONTAINS the commit.
      return { status: contains ? 'behind' : 'ahead', rateLimit };
    },
    async getReleaseNotes(_o, _r, tag) {
      return { body: spec.releaseNotes?.[tag] ?? null, rateLimit };
    },
  };
}

const COMMIT: LookupInput = {
  kind: 'commit',
  repo: { owner: 'facebook', repo: 'react' },
  sha: 'a'.repeat(40),
};

describe('findRelease — happy path', () => {
  it('returns the first containing release', async () => {
    const tags: TagWithDate[] = [
      { name: 'v18.2.0', sha: 'sha18_2_0', date: '2024-03-15T00:00:00Z' },
      { name: 'v18.1.0', sha: 'sha18_1_0', date: '2024-02-01T00:00:00Z' },
      { name: 'v18.0.0', sha: 'sha18_0_0', date: '2024-01-01T00:00:00Z' },
    ];
    const client = fakeClient({
      tags,
      contains: new Set(['v18.2.0']),
      commits: { [COMMIT.kind === 'commit' ? COMMIT.sha : '']: { fullSha: COMMIT.kind === 'commit' ? COMMIT.sha : '', committedDate: '2024-03-01T00:00:00Z' } },
      releaseNotes: { 'v18.2.0': '## fix: hydration' },
    });
    const result = await findRelease(COMMIT, { client });
    expect(result.firstRelease?.tag).toBe('v18.2.0');
    expect(result.releaseNotesHtml).not.toBeNull();
  });

  it('processes tags in ascending date order (oldest first)', async () => {
    const tags: TagWithDate[] = [
      { name: 'newer', sha: 'snew', date: '2024-06-01T00:00:00Z' },
      { name: 'older', sha: 'sold', date: '2024-01-01T00:00:00Z' },
      { name: 'middle', sha: 'smid', date: '2024-03-01T00:00:00Z' },
    ];
    // Both "middle" and "newer" contain the commit; "middle" is the correct first.
    const client = fakeClient({
      tags,
      contains: new Set(['middle', 'newer']),
      commits: { [COMMIT.kind === 'commit' ? COMMIT.sha : '']: { fullSha: COMMIT.kind === 'commit' ? COMMIT.sha : '', committedDate: '2024-02-01T00:00:00Z' } },
    });
    const result = await findRelease(COMMIT, { client });
    expect(result.firstRelease?.tag).toBe('middle');
  });
});

describe('findRelease — PR-as-input', () => {
  it('resolves the PR to its merge commit and proceeds', async () => {
    const PR: LookupInput = { kind: 'pr', repo: { owner: 'vercel', repo: 'next.js' }, number: 56012 };
    const mergeSha = 'b'.repeat(40);
    const tags: TagWithDate[] = [{ name: 'v14.2.0', sha: 'sha14', date: '2024-04-01T00:00:00Z' }];
    const client = fakeClient({
      tags,
      contains: new Set(['v14.2.0']),
      prs: { 56012: { merged: true, mergeCommitSha: mergeSha } },
      commits: { [mergeSha]: { fullSha: mergeSha, committedDate: '2024-03-01T00:00:00Z' } },
    });
    const result = await findRelease(PR, { client });
    expect(result.canonicalSha).toBe(mergeSha);
    expect(result.firstRelease?.tag).toBe('v14.2.0');
  });
});

describe('findRelease — date culling with safety margin (revised D24)', () => {
  it('TOLERATES clock skew within the 90-day margin (tag appears 15 days older than commit, still found)', async () => {
    // commit committedDate: 2024-06-01. containing tag's commit-date: 2024-05-17.
    // 15-day skew is well within the 90-day margin — tag is NOT culled.
    const tags: TagWithDate[] = [
      { name: 'v1.5.0', sha: 's15', date: '2024-05-17T00:00:00Z' },
    ];
    const client = fakeClient({
      tags,
      contains: new Set(['v1.5.0']),
      commits: { [COMMIT.kind === 'commit' ? COMMIT.sha : '']: { fullSha: COMMIT.kind === 'commit' ? COMMIT.sha : '', committedDate: '2024-06-01T00:00:00Z' } },
    });
    const result = await findRelease(COMMIT, { client });
    expect(result.firstRelease?.tag).toBe('v1.5.0');
  });

  it('CULLS a tag whose date is more than the margin before the commit (macports-style ancient tags)', async () => {
    // ancient tag from 2002 vs modern commit from 2024. Cull saves ~20s on
    // repos with CVS/SVN-imported pre-history.
    const tags: TagWithDate[] = [
      { name: 'PRE_DESTROOT', sha: 'sAncient', date: '2002-08-15T00:00:00Z' },
      { name: 'darwinports-1', sha: 'sCvsEra', date: '2003-04-20T00:00:00Z' },
    ];
    let compareCalls = 0;
    const client = fakeClient({
      tags,
      contains: new Set(), // none contain (they're ancient)
      commits: { [COMMIT.kind === 'commit' ? COMMIT.sha : '']: { fullSha: COMMIT.kind === 'commit' ? COMMIT.sha : '', committedDate: '2024-06-01T00:00:00Z' } },
    });
    const origCompare = client.compareCommits;
    client.compareCommits = async (...args) => {
      compareCalls++;
      return origCompare(...args);
    };
    try {
      await findRelease(COMMIT, { client });
      throw new Error('expected NotYetReleasedError');
    } catch (err) {
      expect(err).toBeInstanceOf(NotYetReleasedError);
      expect((err as NotYetReleasedError).culledTagCount).toBe(2);
    }
    // The whole point of culling: ZERO compareCommits calls for tags that are
    // obviously too old to contain a modern commit.
    expect(compareCalls).toBe(0);
  });

  it('strict mode disables the cull (every ancient tag is checked)', async () => {
    const tags: TagWithDate[] = [
      { name: 'PRE_DESTROOT', sha: 'sAncient', date: '2002-08-15T00:00:00Z' },
    ];
    let compareCalls = 0;
    const client = fakeClient({
      tags,
      contains: new Set(),
      commits: { [COMMIT.kind === 'commit' ? COMMIT.sha : '']: { fullSha: COMMIT.kind === 'commit' ? COMMIT.sha : '', committedDate: '2024-06-01T00:00:00Z' } },
    });
    const origCompare = client.compareCommits;
    client.compareCommits = async (...args) => {
      compareCalls++;
      return origCompare(...args);
    };
    await expect(findRelease(COMMIT, { client, strict: true })).rejects.toBeInstanceOf(
      NotYetReleasedError,
    );
    // strict mode: the cull is OFF, so the ancient tag was checked.
    expect(compareCalls).toBe(1);
  });

  it('strict mode FINDS a back-dated containing tag the default mode would miss', async () => {
    // Pathological: someone tagged with `GIT_COMMITTER_DATE=2018-01-01` even
    // though the underlying commit actually contains a 2024 commit. Default
    // mode culls this tag (date too old). Strict mode finds it.
    const tags: TagWithDate[] = [
      { name: 'v-weird', sha: 'sWeird', date: '2018-01-01T00:00:00Z' },
    ];
    const client = fakeClient({
      tags,
      contains: new Set(['v-weird']),
      commits: { [COMMIT.kind === 'commit' ? COMMIT.sha : '']: { fullSha: COMMIT.kind === 'commit' ? COMMIT.sha : '', committedDate: '2024-06-01T00:00:00Z' } },
    });
    // Default mode: cull skips the back-dated tag → NotYetReleasedError.
    await expect(findRelease(COMMIT, { client })).rejects.toBeInstanceOf(NotYetReleasedError);
    // Strict mode: cull off → finds it.
    const result = await findRelease(COMMIT, { client, strict: true });
    expect(result.firstRelease?.tag).toBe('v-weird');
  });

  it('feature-branch non-monotonic case: 1.6 cut from old branch AFTER merge to main; 2.0 contains commit, 1.6 does not, 1.5 does not', async () => {
    // commit lands in main → released in 2.0
    // hotfix 1.6 cut from the 1.x branch AFTER the merge to main; does NOT contain the commit
    // 1.5 cut from 1.x branch BEFORE the commit existed; does not contain
    // Date-wise: 1.5 (older) < commit < 2.0 < 1.6 (newest by date, but cut from an OLDER branch)
    const tags: TagWithDate[] = [
      { name: 'v1.5.0', sha: 's15', date: '2024-01-01T00:00:00Z' },
      { name: 'v2.0.0', sha: 's20', date: '2024-03-01T00:00:00Z' },
      { name: 'v1.6.0', sha: 's16', date: '2024-04-15T00:00:00Z' },
    ];
    const client = fakeClient({
      tags,
      contains: new Set(['v2.0.0']), // ONLY 2.0 contains the commit
      commits: { [COMMIT.kind === 'commit' ? COMMIT.sha : '']: { fullSha: COMMIT.kind === 'commit' ? COMMIT.sha : '', committedDate: '2024-02-01T00:00:00Z' } },
    });
    const result = await findRelease(COMMIT, { client });
    // First release containing the commit is v2.0.0 — NOT v1.6.0 even though
    // v1.6.0 has a later date. (Note: v1.5.0's date is 31 days before commit,
    // still within the 90-day margin → it IS checked and correctly returns 'ahead'.)
    expect(result.firstRelease?.tag).toBe('v2.0.0');
  });
});

describe('findRelease — edge cases', () => {
  it('NoReleasesError when the repo has no tags', async () => {
    const client = fakeClient({
      tags: [],
      commits: { [COMMIT.kind === 'commit' ? COMMIT.sha : '']: { fullSha: COMMIT.kind === 'commit' ? COMMIT.sha : '', committedDate: '2024-03-01T00:00:00Z' } },
    });
    await expect(findRelease(COMMIT, { client })).rejects.toBeInstanceOf(NoReleasesError);
  });

  it('NotYetReleasedError when no tag contains the commit', async () => {
    const tags: TagWithDate[] = [{ name: 'v1.0.0', sha: 's', date: '2024-01-01T00:00:00Z' }];
    const client = fakeClient({
      tags,
      contains: new Set([]),
      commits: { [COMMIT.kind === 'commit' ? COMMIT.sha : '']: { fullSha: COMMIT.kind === 'commit' ? COMMIT.sha : '', committedDate: '2024-06-01T00:00:00Z' } },
    });
    await expect(findRelease(COMMIT, { client })).rejects.toBeInstanceOf(NotYetReleasedError);
  });

  it('propagates AmbiguousShaError from commit resolution', async () => {
    const client = fakeClient({
      tags: [{ name: 'v1', sha: 's', date: '2024-01-01T00:00:00Z' }],
      commits: {}, // commit lookup will throw CommitNotFoundError instead — let's force ambiguous
    });
    // Override getCommit to throw AmbiguousShaError directly
    client.getCommit = async (_o, _r, sha) => {
      throw new AmbiguousShaError(sha);
    };
    await expect(findRelease(COMMIT, { client })).rejects.toBeInstanceOf(AmbiguousShaError);
  });
});

describe('findRelease — rate-limit + deadlines', () => {
  it('surfaces RateLimitError when compareCommits exhausts the budget mid-algorithm', async () => {
    const tags: TagWithDate[] = Array.from({ length: 20 }, (_, i) => ({
      name: `v0.0.${i}`,
      sha: `s${i}`,
      date: `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    }));
    const client = fakeClient({
      tags,
      contains: new Set(), // none contain
      commits: { [COMMIT.kind === 'commit' ? COMMIT.sha : '']: { fullSha: COMMIT.kind === 'commit' ? COMMIT.sha : '', committedDate: '2024-01-01T00:00:00Z' } },
      rateLimitAfterCompares: 2, // 3rd compare call throws RateLimitError
    });
    await expect(findRelease(COMMIT, { client })).rejects.toBeInstanceOf(RateLimitError);
  });

  it('returns partial state when the SOFT deadline has already passed', async () => {
    // After D36 (galloping), the algorithm is fast enough that "small fixture
    // + slow compares" can't reliably outrace a future deadline. Use an
    // already-expired soft deadline to deterministically trigger the partial
    // path — and a hard deadline still in the future so we don't get
    // LookupTimeoutError instead.
    const tags: TagWithDate[] = Array.from({ length: 30 }, (_, i) => ({
      name: `v0.0.${i}`,
      sha: `s${i}`,
      date: `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    }));
    const client = fakeClient({
      tags,
      contains: new Set(),
      commits: { [COMMIT.kind === 'commit' ? COMMIT.sha : '']: { fullSha: COMMIT.kind === 'commit' ? COMMIT.sha : '', committedDate: '2024-01-01T00:00:00Z' } },
    });
    const result = await findRelease(COMMIT, {
      client,
      softDeadline: Date.now() - 10,
      hardDeadline: Date.now() + 5_000,
    });
    expect(result.partial?.reason).toBe('soft_deadline');
    expect(result.firstRelease).toBeNull();
  });

  it('throws LookupTimeoutError when the HARD deadline is exceeded', async () => {
    const tags: TagWithDate[] = Array.from({ length: 30 }, (_, i) => ({
      name: `v0.0.${i}`,
      sha: `s${i}`,
      date: `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    }));
    const client = fakeClient({
      tags,
      contains: new Set(),
      commits: { [COMMIT.kind === 'commit' ? COMMIT.sha : '']: { fullSha: COMMIT.kind === 'commit' ? COMMIT.sha : '', committedDate: '2024-01-01T00:00:00Z' } },
      compareDelayMs: 30,
    });
    // Force the hard deadline to fire before any compare round.
    await expect(
      findRelease(COMMIT, {
        client,
        softDeadline: Date.now() - 10, // already past
        hardDeadline: Date.now() - 5, // already past too
      }),
    ).rejects.toBeInstanceOf(LookupTimeoutError);
  });
});

describe('findRelease — prerelease filter (D37: default = production-only)', () => {
  it('skips prerelease-pattern tags by default; finds the first PRODUCTION release', async () => {
    // commit lands; first containing tag is v1.31.0-alpha.1 (prerelease),
    // followed by v1.31.0-beta.0 (prerelease), then v1.31.0 (production).
    // Default mode: should report v1.31.0, NOT v1.31.0-alpha.1.
    const tags: TagWithDate[] = [
      { name: 'v1.31.0-alpha.1', sha: 'sa1', date: '2024-04-01T00:00:00Z', isPrerelease: true },
      { name: 'v1.31.0-beta.0', sha: 'sb0', date: '2024-05-01T00:00:00Z', isPrerelease: true },
      { name: 'v1.31.0-rc.1', sha: 'src1', date: '2024-06-01T00:00:00Z', isPrerelease: true },
      { name: 'v1.31.0', sha: 's131', date: '2024-07-01T00:00:00Z', isPrerelease: false },
      { name: 'v1.31.1', sha: 's131_1', date: '2024-08-01T00:00:00Z', isPrerelease: false },
    ];
    const client = fakeClient({
      tags,
      contains: new Set(['v1.31.0-alpha.1', 'v1.31.0-beta.0', 'v1.31.0-rc.1', 'v1.31.0', 'v1.31.1']),
      commits: {
        [COMMIT.kind === 'commit' ? COMMIT.sha : '']: {
          fullSha: COMMIT.kind === 'commit' ? COMMIT.sha : '',
          committedDate: '2024-03-15T00:00:00Z',
        },
      },
    });
    const result = await findRelease(COMMIT, { client });
    expect(result.firstRelease?.tag).toBe('v1.31.0');
  });

  it('includePrereleases=true reports the alpha/beta as the first hit', async () => {
    const tags: TagWithDate[] = [
      { name: 'v1.31.0-alpha.1', sha: 'sa1', date: '2024-04-01T00:00:00Z', isPrerelease: true },
      { name: 'v1.31.0', sha: 's131', date: '2024-07-01T00:00:00Z', isPrerelease: false },
    ];
    const client = fakeClient({
      tags,
      contains: new Set(['v1.31.0-alpha.1', 'v1.31.0']),
      commits: {
        [COMMIT.kind === 'commit' ? COMMIT.sha : '']: {
          fullSha: COMMIT.kind === 'commit' ? COMMIT.sha : '',
          committedDate: '2024-03-15T00:00:00Z',
        },
      },
    });
    const result = await findRelease(COMMIT, { client, includePrereleases: true });
    expect(result.firstRelease?.tag).toBe('v1.31.0-alpha.1');
  });

  it('NotYetReleasedError carries prereleasedSkippedCount when defaults skip a containing prerelease', async () => {
    // Only a prerelease contains. Default mode skips it → not released.
    // Error should carry the count so the UI can hint.
    const tags: TagWithDate[] = [
      { name: 'v1.31.0-alpha.1', sha: 'sa1', date: '2024-04-01T00:00:00Z', isPrerelease: true },
    ];
    const client = fakeClient({
      tags,
      contains: new Set(['v1.31.0-alpha.1']),
      commits: {
        [COMMIT.kind === 'commit' ? COMMIT.sha : '']: {
          fullSha: COMMIT.kind === 'commit' ? COMMIT.sha : '',
          committedDate: '2024-03-15T00:00:00Z',
        },
      },
    });
    try {
      await findRelease(COMMIT, { client });
      throw new Error('expected NotYetReleasedError');
    } catch (err) {
      expect(err).toBeInstanceOf(NotYetReleasedError);
      expect((err as NotYetReleasedError).prereleasedSkippedCount).toBe(1);
    }
  });
});

describe('isPrereleaseTag — heuristic', () => {
  it('flags common prerelease patterns', async () => {
    const { isPrereleaseTag } = await import('../src/types.js');
    expect(isPrereleaseTag('v1.31.0-alpha.1')).toBe(true);
    expect(isPrereleaseTag('v1.31.0-beta.0')).toBe(true);
    expect(isPrereleaseTag('v1.31.0-rc.1')).toBe(true);
    expect(isPrereleaseTag('v1.31.0-pre.5')).toBe(true);
    expect(isPrereleaseTag('v1.31.0-snapshot.20240501')).toBe(true);
    expect(isPrereleaseTag('v1.31.0-nightly')).toBe(true);
    expect(isPrereleaseTag('v1.0.0-canary.1')).toBe(true);
    expect(isPrereleaseTag('v1.0.0-dev.5')).toBe(true);
    expect(isPrereleaseTag('1.0.0-preview.2')).toBe(true);
  });

  it('does NOT flag plain semver / production tags', async () => {
    const { isPrereleaseTag } = await import('../src/types.js');
    expect(isPrereleaseTag('v1.31.0')).toBe(false);
    expect(isPrereleaseTag('v1.31.1')).toBe(false);
    expect(isPrereleaseTag('1.0.0')).toBe(false);
    expect(isPrereleaseTag('v2.0.0')).toBe(false);
    // Date-style tags: not prereleases per our heuristic.
    expect(isPrereleaseTag('2024-01-15')).toBe(false);
    // Tag with "alphabet" — alpha at start of a word, not a release identifier.
    // Our heuristic requires alpha to be preceded by `-` or `.`, so this is fine.
    expect(isPrereleaseTag('alphabet')).toBe(false);
  });
});

describe('findRelease — galloping search (D36: O(log n) compares for the common case)', () => {
  it('kubernetes-scale repo: finds the answer in << n compares', async () => {
    // Simulate 1700 tags (kubernetes-sized). Only the LAST tag (newest by date)
    // contains the commit. Old linear scan = 1700 calls. New galloping = ~log(1700).
    const tags: TagWithDate[] = Array.from({ length: 1700 }, (_, i) => ({
      name: `v0.0.${i}`,
      sha: `s${i}`,
      // Spread over 4 years
      date: new Date(2020, 0, 1 + i).toISOString(),
    }));
    const commitDate = new Date(2024, 5, 1).toISOString(); // mid-2024
    const containingTag = 'v0.0.1699'; // newest, just after commit
    const client = fakeClient({
      tags,
      contains: new Set([containingTag, 'v0.0.1698']),
      commits: { [COMMIT.kind === 'commit' ? COMMIT.sha : '']: { fullSha: COMMIT.kind === 'commit' ? COMMIT.sha : '', committedDate: commitDate } },
    });
    const result = await findRelease(COMMIT, { client });
    expect(result.firstRelease?.tag).toBe('v0.0.1698');
    // Galloping + bisect: should be way under 100 compares (vs 1700 linear).
    expect(client.stats.compareCalls).toBeLessThan(100);
  });

  it('bisects correctly when the answer is in the middle of the candidates', async () => {
    // 200 tags, answer at index 100. Galloping probes 0, 1, 2, 4, ..., 128, 199.
    // First hit at probe with index 128. Bisect [64+1, 128] = [65, 128] for the
    // earliest hit (100). Done in O(log) sequential calls.
    const tags: TagWithDate[] = Array.from({ length: 200 }, (_, i) => ({
      name: `v${i}`,
      sha: `s${i}`,
      date: new Date(2024, 0, 1 + i).toISOString(),
    }));
    const commitDate = new Date(2024, 0, 1).toISOString();
    const containingTags = new Set(Array.from({ length: 100 }, (_, i) => `v${100 + i}`));
    const client = fakeClient({
      tags,
      contains: containingTags,
      commits: { [COMMIT.kind === 'commit' ? COMMIT.sha : '']: { fullSha: COMMIT.kind === 'commit' ? COMMIT.sha : '', committedDate: commitDate } },
    });
    const result = await findRelease(COMMIT, { client });
    expect(result.firstRelease?.tag).toBe('v100');
    // Galloping should crush a 200-tag repo to well under linear cost.
    expect(client.stats.compareCalls).toBeLessThan(50);
  });

  it('strict mode does linear scan (more compares but finds clock-skewed answer)', async () => {
    // Pathological: containing tag has a date 200 days BEFORE the commit.
    // Default-mode datePos jumps past it (within the cull margin still — but
    // the safety-back window of 20 doesn't reach it in a 50-tag fixture).
    // Strict mode scans from index 0 → finds it.
    const tags: TagWithDate[] = Array.from({ length: 50 }, (_, i) => ({
      name: `v${i}`,
      sha: `s${i}`,
      // All tags dated 2024-01-01 to 2024-02-19, with one we'll mark as containing
      date: new Date(2024, 0, 1 + i).toISOString(),
    }));
    const commitDate = new Date(2024, 0, 30).toISOString(); // Jan 30
    // v0 has date Jan 1 (29 days before commit) — within 90-day cull but
    // before datePos (Jan 30). Default safety-back of 20 reaches indices
    // 9-29 of v9-v29. v0 is at index 0, BEYOND the safety-back.
    const client = fakeClient({
      tags,
      contains: new Set(['v0']), // ONLY the very-old-dated tag contains
      commits: { [COMMIT.kind === 'commit' ? COMMIT.sha : '']: { fullSha: COMMIT.kind === 'commit' ? COMMIT.sha : '', committedDate: commitDate } },
    });
    // Default: misses it (galloping skipped index 0 outside the safety-back).
    await expect(findRelease(COMMIT, { client })).rejects.toBeInstanceOf(NotYetReleasedError);
    // Strict: scans every tag, finds v0.
    const result = await findRelease(COMMIT, { client, strict: true });
    expect(result.firstRelease?.tag).toBe('v0');
  });
});

describe('findRelease — also-in list', () => {
  it('includes subsequent containing tags', async () => {
    const tags: TagWithDate[] = [
      { name: 'v1.0.0', sha: 's1', date: '2024-01-01T00:00:00Z' },
      { name: 'v1.1.0', sha: 's2', date: '2024-02-01T00:00:00Z' }, // first hit
      { name: 'v1.2.0', sha: 's3', date: '2024-03-01T00:00:00Z' }, // also in
      { name: 'v2.0.0', sha: 's4', date: '2024-04-01T00:00:00Z' }, // also in
    ];
    const client = fakeClient({
      tags,
      contains: new Set(['v1.1.0', 'v1.2.0', 'v2.0.0']),
      commits: { [COMMIT.kind === 'commit' ? COMMIT.sha : '']: { fullSha: COMMIT.kind === 'commit' ? COMMIT.sha : '', committedDate: '2023-12-01T00:00:00Z' } },
    });
    const result = await findRelease(COMMIT, { client });
    expect(result.firstRelease?.tag).toBe('v1.1.0');
    expect(result.alsoIn.map((r) => r.tag)).toEqual(['v1.2.0', 'v2.0.0']);
  });
});
