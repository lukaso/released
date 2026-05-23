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
import type { Provider } from '../src/provider.js';
import { makeGithubProvider } from '../src/providers/github/client.js';
import { makeGitlabProvider } from '../src/providers/gitlab/client.js';
import type { LookupInput, RateLimitInfo, RepoRef, TagWithDate } from '../src/types.js';

/** Build a deterministic fake Provider for tests. */
function fakeClient(spec: {
  tags?: TagWithDate[];
  /** Which tags CONTAIN the input commit (truth — by tag name). */
  contains?: Set<string>;
  /** Override commit resolution. */
  commits?: Record<string, { fullSha: string; committedDate: string; subject?: string | null }>;
  /** Override PR resolution. */
  prs?: Record<number, { merged: boolean; mergeCommitSha: string | null; title?: string | null }>;
  /** Release notes by tag. */
  releaseNotes?: Record<string, string | null>;
  /** Tags the PROVIDER (e.g. GitHub) flags as prerelease via its API, regardless
   *  of what our tag-name heuristic thinks. Drives the Layer 2 banner. */
  providerPrereleaseTags?: Set<string>;
  /** Inject a rate-limit failure when compare is called for this many invocations. */
  rateLimitAfterCompares?: number;
  /** Add an artificial delay (ms) before each compare to test deadlines. */
  compareDelayMs?: number;
  /** Override host/kind/terms — defaults to github.com. Allows tests to fake a GitLab provider. */
  base?: Pick<Provider, 'host' | 'kind' | 'terms' | 'urls'>;
  /** When set, exposes the `containingTags` shortcut (mimics GitlabProvider).
   *  The set passed is treated as the authoritative "which tags contain this commit?".
   *  Pass `undefined` (default) to NOT expose the method — algorithm falls back to gallop. */
  exposeContainingTags?: boolean;
}): Provider & { stats: { compareCalls: number; containingTagsCalls: number } } {
  const stats = { compareCalls: 0, containingTagsCalls: 0 };
  const rateLimit: RateLimitInfo = {
    remaining: 4999,
    limit: 5000,
    resetAt: Math.floor(Date.now() / 1000) + 3600,
  };
  const base = spec.base ?? makeGithubProvider();

  return {
    stats,
    host: base.host,
    kind: base.kind,
    terms: base.terms,
    urls: base.urls,
    async getCommit(_repo, sha) {
      const found = spec.commits?.[sha];
      if (found) return { ...found, rateLimit };
      throw new CommitNotFoundError(sha);
    },
    async getPullRequest(_repo, n) {
      const pr = spec.prs?.[n];
      if (!pr) throw new Error(`fake: no PR ${n}`);
      if (!pr.merged) throw new PrNotMergedError(n);
      if (pr.mergeCommitSha == null) throw new Error('not merged');
      return {
        merged: true,
        mergeCommitSha: pr.mergeCommitSha,
        title: pr.title ?? null,
        rateLimit,
      };
    },
    async listTagsWithDates() {
      return { tags: spec.tags ?? [], rateLimit };
    },
    async compareCommits(_repo, base, _head) {
      stats.compareCalls += 1;
      if (spec.rateLimitAfterCompares != null && stats.compareCalls > spec.rateLimitAfterCompares) {
        throw new RateLimitError(rateLimit.resetAt);
      }
      if (spec.compareDelayMs) {
        await new Promise((r) => setTimeout(r, spec.compareDelayMs));
      }
      // Find the tag whose sha matches `base` (the tag side of the compare).
      const tag = (spec.tags ?? []).find((t) => t.sha === base);
      const contains = tag ? (spec.contains?.has(tag.name) ?? false) : false;
      // status === 'behind' or 'identical' means tag CONTAINS the commit.
      return { status: contains ? 'behind' : 'ahead', rateLimit };
    },
    async getReleaseNotes(_repo, tag) {
      return {
        body: spec.releaseNotes?.[tag] ?? null,
        isPrerelease: spec.providerPrereleaseTags?.has(tag) ?? null,
        rateLimit,
      };
    },
    ...(spec.exposeContainingTags
      ? {
          async containingTags(_repo: RepoRef, _sha: string) {
            stats.containingTagsCalls += 1;
            const tagNames = (spec.tags ?? [])
              .filter((t) => spec.contains?.has(t.name))
              .map((t) => t.name);
            return { tags: tagNames, rateLimit };
          },
        }
      : {}),
  };
}

/** Convenience: build a fake provider that identifies as a GitLab instance. */
function fakeGitlabClient(host: string, spec: Parameters<typeof fakeClient>[0]) {
  return fakeClient({ ...spec, base: makeGitlabProvider(host) });
}

const REPO: RepoRef = { host: 'github.com', projectPath: 'facebook/react' };
const COMMIT: LookupInput = {
  kind: 'commit',
  repo: REPO,
  sha: 'a'.repeat(40),
};
const COMMIT_SHA = COMMIT.kind === 'commit' ? COMMIT.sha : '';

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
      commits: { [COMMIT_SHA]: { fullSha: COMMIT_SHA, committedDate: '2024-03-01T00:00:00Z' } },
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
      commits: { [COMMIT_SHA]: { fullSha: COMMIT_SHA, committedDate: '2024-02-01T00:00:00Z' } },
    });
    const result = await findRelease(COMMIT, { client });
    expect(result.firstRelease?.tag).toBe('middle');
  });

  it('populates result.urls with provider-built URLs', async () => {
    const tags: TagWithDate[] = [
      { name: 'v18.2.0', sha: 'sha18_2_0', date: '2024-03-15T00:00:00Z' },
    ];
    const client = fakeClient({
      tags,
      contains: new Set(['v18.2.0']),
      commits: { [COMMIT_SHA]: { fullSha: COMMIT_SHA, committedDate: '2024-03-01T00:00:00Z' } },
    });
    const result = await findRelease(COMMIT, { client });
    expect(result.urls.repo).toBe('https://github.com/facebook/react');
    expect(result.urls.commit).toBe(`https://github.com/facebook/react/commit/${COMMIT_SHA}`);
    expect(result.urls.pullRequest).toBeUndefined();
    expect(result.firstRelease?.url).toBe('https://github.com/facebook/react/releases/tag/v18.2.0');
  });

  it('GitLab fake provider produces gitlab-shaped URLs', async () => {
    const repo: RepoRef = { host: 'gitlab.gnome.org', projectPath: 'GNOME/gimp' };
    const input: LookupInput = { kind: 'pr', repo, number: 2466 };
    const sha = 'c'.repeat(40);
    const tags: TagWithDate[] = [
      { name: 'GIMP_2_99_20', sha: 'sgimp', date: '2024-04-01T00:00:00Z' },
    ];
    const client = fakeGitlabClient('gitlab.gnome.org', {
      tags,
      contains: new Set(['GIMP_2_99_20']),
      prs: { 2466: { merged: true, mergeCommitSha: sha } },
      commits: { [sha]: { fullSha: sha, committedDate: '2024-03-15T00:00:00Z' } },
    });
    const result = await findRelease(input, { client });
    expect(result.urls.repo).toBe('https://gitlab.gnome.org/GNOME/gimp');
    expect(result.urls.commit).toBe(`https://gitlab.gnome.org/GNOME/gimp/-/commit/${sha}`);
    expect(result.urls.pullRequest).toBe(
      'https://gitlab.gnome.org/GNOME/gimp/-/merge_requests/2466',
    );
    expect(result.firstRelease?.url).toBe(
      'https://gitlab.gnome.org/GNOME/gimp/-/releases/GIMP_2_99_20',
    );
  });
});

describe('findRelease — PR-as-input', () => {
  it('resolves the PR to its merge commit and proceeds', async () => {
    const PR: LookupInput = {
      kind: 'pr',
      repo: { host: 'github.com', projectPath: 'vercel/next.js' },
      number: 56012,
    };
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
    expect(result.urls.pullRequest).toBe('https://github.com/vercel/next.js/pull/56012');
  });
});

describe('findRelease — date culling with safety margin (revised D24)', () => {
  it('TOLERATES clock skew within the 90-day margin (tag appears 15 days older than commit, still found)', async () => {
    const tags: TagWithDate[] = [{ name: 'v1.5.0', sha: 's15', date: '2024-05-17T00:00:00Z' }];
    const client = fakeClient({
      tags,
      contains: new Set(['v1.5.0']),
      commits: { [COMMIT_SHA]: { fullSha: COMMIT_SHA, committedDate: '2024-06-01T00:00:00Z' } },
    });
    const result = await findRelease(COMMIT, { client });
    expect(result.firstRelease?.tag).toBe('v1.5.0');
  });

  it('CULLS a tag whose date is more than the margin before the commit (macports-style ancient tags)', async () => {
    const tags: TagWithDate[] = [
      { name: 'PRE_DESTROOT', sha: 'sAncient', date: '2002-08-15T00:00:00Z' },
      { name: 'darwinports-1', sha: 'sCvsEra', date: '2003-04-20T00:00:00Z' },
    ];
    let compareCalls = 0;
    const client = fakeClient({
      tags,
      contains: new Set(),
      commits: { [COMMIT_SHA]: { fullSha: COMMIT_SHA, committedDate: '2024-06-01T00:00:00Z' } },
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
      commits: { [COMMIT_SHA]: { fullSha: COMMIT_SHA, committedDate: '2024-06-01T00:00:00Z' } },
    });
    const origCompare = client.compareCommits;
    client.compareCommits = async (...args) => {
      compareCalls++;
      return origCompare(...args);
    };
    await expect(findRelease(COMMIT, { client, strict: true })).rejects.toBeInstanceOf(
      NotYetReleasedError,
    );
    expect(compareCalls).toBe(1);
  });

  it('strict mode FINDS a back-dated containing tag the default mode would miss', async () => {
    const tags: TagWithDate[] = [{ name: 'v-weird', sha: 'sWeird', date: '2018-01-01T00:00:00Z' }];
    const client = fakeClient({
      tags,
      contains: new Set(['v-weird']),
      commits: { [COMMIT_SHA]: { fullSha: COMMIT_SHA, committedDate: '2024-06-01T00:00:00Z' } },
    });
    await expect(findRelease(COMMIT, { client })).rejects.toBeInstanceOf(NotYetReleasedError);
    const result = await findRelease(COMMIT, { client, strict: true });
    expect(result.firstRelease?.tag).toBe('v-weird');
  });

  it('feature-branch non-monotonic case: 1.6 cut from old branch AFTER merge to main; 2.0 contains commit, 1.6 does not, 1.5 does not', async () => {
    const tags: TagWithDate[] = [
      { name: 'v1.5.0', sha: 's15', date: '2024-01-01T00:00:00Z' },
      { name: 'v2.0.0', sha: 's20', date: '2024-03-01T00:00:00Z' },
      { name: 'v1.6.0', sha: 's16', date: '2024-04-15T00:00:00Z' },
    ];
    const client = fakeClient({
      tags,
      contains: new Set(['v2.0.0']),
      commits: { [COMMIT_SHA]: { fullSha: COMMIT_SHA, committedDate: '2024-02-01T00:00:00Z' } },
    });
    const result = await findRelease(COMMIT, { client });
    expect(result.firstRelease?.tag).toBe('v2.0.0');
  });
});

describe('findRelease — edge cases', () => {
  it('NoReleasesError when the repo has no tags', async () => {
    const client = fakeClient({
      tags: [],
      commits: { [COMMIT_SHA]: { fullSha: COMMIT_SHA, committedDate: '2024-03-01T00:00:00Z' } },
    });
    await expect(findRelease(COMMIT, { client })).rejects.toBeInstanceOf(NoReleasesError);
  });

  it('NotYetReleasedError when no tag contains the commit', async () => {
    const tags: TagWithDate[] = [{ name: 'v1.0.0', sha: 's', date: '2024-01-01T00:00:00Z' }];
    const client = fakeClient({
      tags,
      contains: new Set([]),
      commits: { [COMMIT_SHA]: { fullSha: COMMIT_SHA, committedDate: '2024-06-01T00:00:00Z' } },
    });
    await expect(findRelease(COMMIT, { client })).rejects.toBeInstanceOf(NotYetReleasedError);
  });

  it('propagates AmbiguousShaError from commit resolution', async () => {
    const client = fakeClient({
      tags: [{ name: 'v1', sha: 's', date: '2024-01-01T00:00:00Z' }],
      commits: {},
    });
    client.getCommit = async (_repo, sha) => {
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
      contains: new Set(),
      commits: { [COMMIT_SHA]: { fullSha: COMMIT_SHA, committedDate: '2024-01-01T00:00:00Z' } },
      rateLimitAfterCompares: 2,
    });
    await expect(findRelease(COMMIT, { client })).rejects.toBeInstanceOf(RateLimitError);
  });

  it('returns partial state when the SOFT deadline has already passed', async () => {
    const tags: TagWithDate[] = Array.from({ length: 30 }, (_, i) => ({
      name: `v0.0.${i}`,
      sha: `s${i}`,
      date: `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    }));
    const client = fakeClient({
      tags,
      contains: new Set(),
      commits: { [COMMIT_SHA]: { fullSha: COMMIT_SHA, committedDate: '2024-01-01T00:00:00Z' } },
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
      commits: { [COMMIT_SHA]: { fullSha: COMMIT_SHA, committedDate: '2024-01-01T00:00:00Z' } },
      compareDelayMs: 30,
    });
    await expect(
      findRelease(COMMIT, {
        client,
        softDeadline: Date.now() - 10,
        hardDeadline: Date.now() - 5,
      }),
    ).rejects.toBeInstanceOf(LookupTimeoutError);
  });
});

describe('findRelease — prerelease filter (D37: default = production-only)', () => {
  it('skips prerelease-pattern tags by default; finds the first PRODUCTION release', async () => {
    const tags: TagWithDate[] = [
      { name: 'v1.31.0-alpha.1', sha: 'sa1', date: '2024-04-01T00:00:00Z', isPrerelease: true },
      { name: 'v1.31.0-beta.0', sha: 'sb0', date: '2024-05-01T00:00:00Z', isPrerelease: true },
      { name: 'v1.31.0-rc.1', sha: 'src1', date: '2024-06-01T00:00:00Z', isPrerelease: true },
      { name: 'v1.31.0', sha: 's131', date: '2024-07-01T00:00:00Z', isPrerelease: false },
      { name: 'v1.31.1', sha: 's131_1', date: '2024-08-01T00:00:00Z', isPrerelease: false },
    ];
    const client = fakeClient({
      tags,
      contains: new Set([
        'v1.31.0-alpha.1',
        'v1.31.0-beta.0',
        'v1.31.0-rc.1',
        'v1.31.0',
        'v1.31.1',
      ]),
      commits: { [COMMIT_SHA]: { fullSha: COMMIT_SHA, committedDate: '2024-03-15T00:00:00Z' } },
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
      commits: { [COMMIT_SHA]: { fullSha: COMMIT_SHA, committedDate: '2024-03-15T00:00:00Z' } },
    });
    const result = await findRelease(COMMIT, { client, includePrereleases: true });
    expect(result.firstRelease?.tag).toBe('v1.31.0-alpha.1');
  });

  it('Layer 2: flags firstReleaseIsPrerelease when the provider says prerelease but our heuristic missed it', async () => {
    // Scenario: tag name doesn't match our heuristic (e.g. `release-2025-01-15`)
    // so we ship it as the first release. But GitHub's Release object has
    // prerelease: true. We should surface that as firstReleaseIsPrerelease.
    const tags: TagWithDate[] = [
      // isPrerelease: false (heuristic didn't catch it)
      { name: 'release-2025-01-15', sha: 's1', date: '2025-01-15T00:00:00Z', isPrerelease: false },
    ];
    const client = fakeClient({
      tags,
      contains: new Set(['release-2025-01-15']),
      commits: { [COMMIT_SHA]: { fullSha: COMMIT_SHA, committedDate: '2025-01-10T00:00:00Z' } },
      // Provider (GitHub) flags it true.
      providerPrereleaseTags: new Set(['release-2025-01-15']),
    });
    const result = await findRelease(COMMIT, { client });
    expect(result.firstRelease?.tag).toBe('release-2025-01-15');
    expect(result.firstReleaseIsPrerelease).toBe(true);
  });

  it('Layer 2: does NOT flag firstReleaseIsPrerelease when user opted into prereleases', async () => {
    const tags: TagWithDate[] = [
      { name: 'v1.0.0-rc.1', sha: 's1', date: '2025-01-15T00:00:00Z', isPrerelease: true },
    ];
    const client = fakeClient({
      tags,
      contains: new Set(['v1.0.0-rc.1']),
      commits: { [COMMIT_SHA]: { fullSha: COMMIT_SHA, committedDate: '2025-01-10T00:00:00Z' } },
      providerPrereleaseTags: new Set(['v1.0.0-rc.1']),
    });
    const result = await findRelease(COMMIT, { client, includePrereleases: true });
    // User explicitly asked for prereleases — no banner.
    expect(result.firstReleaseIsPrerelease).toBeUndefined();
  });

  it('Layer 2: does NOT flag when heuristic already caught it (no disagreement)', async () => {
    // Heuristic correctly flagged the prerelease; we skipped it; picked next stable.
    // No banner needed — nothing went wrong.
    const tags: TagWithDate[] = [
      { name: 'v1.0.0-rc.1', sha: 's1', date: '2025-01-10T00:00:00Z', isPrerelease: true },
      { name: 'v1.0.0', sha: 's2', date: '2025-01-15T00:00:00Z', isPrerelease: false },
    ];
    const client = fakeClient({
      tags,
      contains: new Set(['v1.0.0-rc.1', 'v1.0.0']),
      commits: { [COMMIT_SHA]: { fullSha: COMMIT_SHA, committedDate: '2025-01-05T00:00:00Z' } },
      providerPrereleaseTags: new Set(['v1.0.0-rc.1']),
    });
    const result = await findRelease(COMMIT, { client });
    expect(result.firstRelease?.tag).toBe('v1.0.0');
    expect(result.firstReleaseIsPrerelease).toBeUndefined();
  });

  it('Layer 2: does NOT flag when provider has no opinion (null isPrerelease, e.g. GitLab or no Release object)', async () => {
    const tags: TagWithDate[] = [
      { name: 'release-2025-01-15', sha: 's1', date: '2025-01-15T00:00:00Z', isPrerelease: false },
    ];
    const client = fakeClient({
      tags,
      contains: new Set(['release-2025-01-15']),
      commits: { [COMMIT_SHA]: { fullSha: COMMIT_SHA, committedDate: '2025-01-10T00:00:00Z' } },
      // No providerPrereleaseTags set — getReleaseNotes returns isPrerelease: null.
    });
    const result = await findRelease(COMMIT, { client });
    expect(result.firstReleaseIsPrerelease).toBeUndefined();
  });

  it('NotYetReleasedError carries prereleasedSkippedCount when defaults skip a containing prerelease', async () => {
    const tags: TagWithDate[] = [
      { name: 'v1.31.0-alpha.1', sha: 'sa1', date: '2024-04-01T00:00:00Z', isPrerelease: true },
    ];
    const client = fakeClient({
      tags,
      contains: new Set(['v1.31.0-alpha.1']),
      commits: { [COMMIT_SHA]: { fullSha: COMMIT_SHA, committedDate: '2024-03-15T00:00:00Z' } },
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

  it('flags underscore-separated prerelease forms (GIMP-style)', async () => {
    const { isPrereleaseTag } = await import('../src/types.js');
    // The GIMP convention that caught us: GIMP_3_2_0_RC1.
    expect(isPrereleaseTag('GIMP_3_2_0_RC1')).toBe(true);
    expect(isPrereleaseTag('GIMP_3_2_0_RC2')).toBe(true);
    expect(isPrereleaseTag('MYPROJ_1_0_BETA')).toBe(true);
    expect(isPrereleaseTag('release_2_0_0_alpha')).toBe(true);
    expect(isPrereleaseTag('v_1_0_0_pre1')).toBe(true);
    // Case-insensitive — both RC and rc work.
    expect(isPrereleaseTag('GIMP_3_2_0_rc1')).toBe(true);
  });

  it('does NOT flag plain semver / production tags', async () => {
    const { isPrereleaseTag } = await import('../src/types.js');
    expect(isPrereleaseTag('v1.31.0')).toBe(false);
    expect(isPrereleaseTag('v1.31.1')).toBe(false);
    expect(isPrereleaseTag('1.0.0')).toBe(false);
    expect(isPrereleaseTag('v2.0.0')).toBe(false);
    expect(isPrereleaseTag('2024-01-15')).toBe(false);
    // 'alpha' at the start of a word, not preceded by a separator.
    expect(isPrereleaseTag('alphabet')).toBe(false);
    // GIMP stable releases (no RC/BETA/ALPHA suffix).
    expect(isPrereleaseTag('GIMP_3_2_0')).toBe(false);
    expect(isPrereleaseTag('GIMP_2_10_38')).toBe(false);
    // The GNOME "odd minor = development" convention (GIMP_2_99_x) is genuinely
    // GNOME-specific and intentionally NOT detected by this heuristic. Users
    // running into that case can use --include-prereleases.
    expect(isPrereleaseTag('GIMP_2_99_20')).toBe(false);
  });
});

describe('findRelease — galloping search (D36: O(log n) compares for the common case)', () => {
  it('kubernetes-scale repo: finds the answer in << n compares', async () => {
    const tags: TagWithDate[] = Array.from({ length: 1700 }, (_, i) => ({
      name: `v0.0.${i}`,
      sha: `s${i}`,
      date: new Date(2020, 0, 1 + i).toISOString(),
    }));
    const commitDate = new Date(2024, 5, 1).toISOString();
    const containingTag = 'v0.0.1699';
    const client = fakeClient({
      tags,
      contains: new Set([containingTag, 'v0.0.1698']),
      commits: { [COMMIT_SHA]: { fullSha: COMMIT_SHA, committedDate: commitDate } },
    });
    const result = await findRelease(COMMIT, { client });
    expect(result.firstRelease?.tag).toBe('v0.0.1698');
    expect(client.stats.compareCalls).toBeLessThan(100);
  });

  it('bisects correctly when the answer is in the middle of the candidates', async () => {
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
      commits: { [COMMIT_SHA]: { fullSha: COMMIT_SHA, committedDate: commitDate } },
    });
    const result = await findRelease(COMMIT, { client });
    expect(result.firstRelease?.tag).toBe('v100');
    expect(client.stats.compareCalls).toBeLessThan(50);
  });

  it('REGRESSION: probes datePos itself (not just Fibonacci offsets) — covers commit-IS-the-tag case', async () => {
    // The Fibonacci probe offsets [0,1,2,3,5,8,13,21,...] from
    // start = datePos - CLOCK_SKEW_SAFETY_BACK (20) leave a gap at offset 20,
    // which means a tag at exact datePos was never probed. This bit angular's
    // commit 2a19754c (= v22.0.0-next.12 HEAD) where the tag and the commit
    // share an exact date. Fix: always include datePos in the probe set.
    //
    // Repro: 46 candidates (matches angular's real cull result), the
    // containing tag at index 42 (matches angular's real next.12 position),
    // neighbor tags at 43-45 are from different release branches so they
    // DON'T contain (just like angular's v20.3.21 / v19.2.22 / v21.2.13).
    const commitDate = '2026-05-08T15:22:23Z';
    const tags: TagWithDate[] = Array.from({ length: 46 }, (_, i) => {
      // Spread the older 42 tags backward from datePos.
      // Tag at index 42 lands exactly on commitDate; tags 43-45 are later.
      const offsetDays = i - 42;
      const tagDate = new Date(
        Date.parse(commitDate) + offsetDays * 24 * 60 * 60 * 1000,
      ).toISOString();
      return { name: `v${i}`, sha: `s${i}`, date: tagDate };
    });
    const client = fakeClient({
      tags,
      // Only the tag at exact datePos contains the commit (and not the later ones,
      // simulating angular's "v20.3.21 is from a different branch" reality).
      contains: new Set(['v42']),
      commits: { [COMMIT_SHA]: { fullSha: COMMIT_SHA, committedDate: commitDate } },
    });
    const result = await findRelease(COMMIT, { client });
    expect(result.firstRelease?.tag).toBe('v42');
  });

  it('strict mode does linear scan (more compares but finds clock-skewed answer)', async () => {
    const tags: TagWithDate[] = Array.from({ length: 50 }, (_, i) => ({
      name: `v${i}`,
      sha: `s${i}`,
      date: new Date(2024, 0, 1 + i).toISOString(),
    }));
    const commitDate = new Date(2024, 0, 30).toISOString();
    const client = fakeClient({
      tags,
      contains: new Set(['v0']),
      commits: { [COMMIT_SHA]: { fullSha: COMMIT_SHA, committedDate: commitDate } },
    });
    await expect(findRelease(COMMIT, { client })).rejects.toBeInstanceOf(NotYetReleasedError);
    const result = await findRelease(COMMIT, { client, strict: true });
    expect(result.firstRelease?.tag).toBe('v0');
  });
});

describe('findRelease — also-in list', () => {
  it('includes subsequent containing tags', async () => {
    const tags: TagWithDate[] = [
      { name: 'v1.0.0', sha: 's1', date: '2024-01-01T00:00:00Z' },
      { name: 'v1.1.0', sha: 's2', date: '2024-02-01T00:00:00Z' },
      { name: 'v1.2.0', sha: 's3', date: '2024-03-01T00:00:00Z' },
      { name: 'v2.0.0', sha: 's4', date: '2024-04-01T00:00:00Z' },
    ];
    const client = fakeClient({
      tags,
      contains: new Set(['v1.1.0', 'v1.2.0', 'v2.0.0']),
      commits: { [COMMIT_SHA]: { fullSha: COMMIT_SHA, committedDate: '2023-12-01T00:00:00Z' } },
    });
    const result = await findRelease(COMMIT, { client });
    expect(result.firstRelease?.tag).toBe('v1.1.0');
    expect(result.alsoIn.map((r) => r.tag)).toEqual(['v1.2.0', 'v2.0.0']);
  });
});

describe('findRelease — containingTags shortcut (GitLab-only optimization)', () => {
  // GitLab's /repository/commits/:sha/refs?type=tag returns the full set of
  // containing tags in one call. When the provider exposes this method, the
  // algorithm bypasses gallop + bisect (saves 20s+ on huge repos like GTK).
  // GitHub does NOT expose this — its provider doesn't set the method, and
  // the algorithm falls back to the existing path.

  it('takes the shortcut and makes ZERO compareCommits calls when provider exposes containingTags', async () => {
    const tags: TagWithDate[] = [
      { name: 'v1.0', sha: 's1', date: '2024-01-01T00:00:00Z' },
      { name: 'v2.0', sha: 's2', date: '2024-02-01T00:00:00Z' },
      { name: 'v3.0', sha: 's3', date: '2024-03-01T00:00:00Z' },
    ];
    const client = fakeClient({
      tags,
      contains: new Set(['v2.0', 'v3.0']),
      commits: { [COMMIT_SHA]: { fullSha: COMMIT_SHA, committedDate: '2024-01-15T00:00:00Z' } },
      exposeContainingTags: true,
    });
    const result = await findRelease(COMMIT, { client });
    expect(result.firstRelease?.tag).toBe('v2.0');
    expect(result.alsoIn.map((r) => r.tag)).toEqual(['v3.0']);
    expect(client.stats.compareCalls).toBe(0);
    expect(client.stats.containingTagsCalls).toBe(1);
  });

  it('throws NotYetReleasedError without making any compare calls when shortcut returns empty', async () => {
    const tags: TagWithDate[] = [
      { name: 'v1.0', sha: 's1', date: '2024-01-01T00:00:00Z' },
      { name: 'v2.0', sha: 's2', date: '2024-02-01T00:00:00Z' },
    ];
    const client = fakeClient({
      tags,
      contains: new Set(), // commit is in NO tag
      commits: { [COMMIT_SHA]: { fullSha: COMMIT_SHA, committedDate: '2024-03-01T00:00:00Z' } },
      exposeContainingTags: true,
    });
    await expect(findRelease(COMMIT, { client })).rejects.toBeInstanceOf(NotYetReleasedError);
    expect(client.stats.compareCalls).toBe(0);
    expect(client.stats.containingTagsCalls).toBe(1);
  });

  it('respects the prerelease filter — does NOT pick a containing prerelease tag when user opts out', async () => {
    const tags: TagWithDate[] = [
      { name: 'v1.0-rc1', sha: 's1', date: '2024-01-01T00:00:00Z', isPrerelease: true },
      { name: 'v1.0', sha: 's2', date: '2024-02-01T00:00:00Z', isPrerelease: false },
    ];
    const client = fakeClient({
      tags,
      contains: new Set(['v1.0-rc1', 'v1.0']),
      commits: { [COMMIT_SHA]: { fullSha: COMMIT_SHA, committedDate: '2023-12-01T00:00:00Z' } },
      exposeContainingTags: true,
    });
    // Default includePrereleases = false: rc1 is excluded even though it contains.
    const result = await findRelease(COMMIT, { client });
    expect(result.firstRelease?.tag).toBe('v1.0');
  });

  it('respects the date cull — does NOT pick a containing tag from before the commit date', async () => {
    // A tag dated long before the commit cannot really contain it (dates have
    // 90 days of clock-skew slack; beyond that the cull discards). The shortcut
    // must honor the same cull as the gallop path.
    const tags: TagWithDate[] = [
      { name: 'ancient', sha: 's0', date: '2001-01-01T00:00:00Z' },
      { name: 'recent', sha: 's1', date: '2024-04-01T00:00:00Z' },
    ];
    const client = fakeClient({
      tags,
      // Provider's refs API claims both contain. The cull should drop 'ancient'.
      contains: new Set(['ancient', 'recent']),
      commits: { [COMMIT_SHA]: { fullSha: COMMIT_SHA, committedDate: '2024-03-15T00:00:00Z' } },
      exposeContainingTags: true,
    });
    const result = await findRelease(COMMIT, { client });
    expect(result.firstRelease?.tag).toBe('recent');
  });

  it('falls back to gallop when provider does NOT expose containingTags (GitHub path)', async () => {
    const tags: TagWithDate[] = [
      { name: 'v1.0', sha: 's1', date: '2024-01-01T00:00:00Z' },
      { name: 'v2.0', sha: 's2', date: '2024-02-01T00:00:00Z' },
    ];
    const client = fakeClient({
      tags,
      contains: new Set(['v1.0', 'v2.0']),
      commits: { [COMMIT_SHA]: { fullSha: COMMIT_SHA, committedDate: '2023-12-01T00:00:00Z' } },
      // exposeContainingTags omitted — provider has no shortcut
    });
    const result = await findRelease(COMMIT, { client });
    expect(result.firstRelease?.tag).toBe('v1.0');
    expect(client.stats.compareCalls).toBeGreaterThan(0);
    expect(client.stats.containingTagsCalls).toBe(0);
  });
});

describe('findRelease — subject (human headline)', () => {
  const tags: TagWithDate[] = [{ name: 'v1.0', sha: 's1', date: '2024-02-01T00:00:00Z' }];

  it('uses the commit subject for commit inputs', async () => {
    const client = fakeClient({
      tags,
      contains: new Set(['v1.0']),
      commits: {
        [COMMIT_SHA]: {
          fullSha: COMMIT_SHA,
          committedDate: '2024-01-01T00:00:00Z',
          subject: 'fix: handle null user in auth middleware',
        },
      },
    });
    const result = await findRelease(COMMIT, { client });
    expect(result.subject).toBe('fix: handle null user in auth middleware');
  });

  it('prefers the PR/MR title over the merge commit subject for pr inputs', async () => {
    const mergeSha = 'b'.repeat(40);
    const client = fakeClient({
      tags,
      contains: new Set(['v1.0']),
      prs: { 42: { merged: true, mergeCommitSha: mergeSha, title: 'Add dark mode toggle' } },
      commits: {
        [mergeSha]: {
          fullSha: mergeSha,
          committedDate: '2024-01-01T00:00:00Z',
          subject: 'Merge pull request #42 from foo/bar',
        },
      },
    });
    const result = await findRelease({ kind: 'pr', repo: REPO, number: 42 }, { client });
    expect(result.subject).toBe('Add dark mode toggle');
  });

  it('carries the subject on NotYetReleasedError so the not-yet UI stays descriptive', async () => {
    const client = fakeClient({
      tags,
      contains: new Set(), // no tag contains the commit
      commits: {
        [COMMIT_SHA]: {
          fullSha: COMMIT_SHA,
          committedDate: '2024-03-01T00:00:00Z',
          subject: 'perf: cache the thing',
        },
      },
    });
    await expect(findRelease(COMMIT, { client })).rejects.toMatchObject({
      name: 'NotYetReleasedError',
      subject: 'perf: cache the thing',
    });
  });
});
