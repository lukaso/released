// The algorithm — find the first release containing a commit.
//
// Date is ORDERING ONLY, never a filter (D24). Sort tags by best-available
// release date ascending; check ancestry oldest-first in parallel batches;
// stop at the first hit. The first hit in date order IS the earliest-dated
// containing tag because no tag is ever dropped.
//
// Deadlines (D17 + #6): callers pass absolute epoch-ms deadlines. The bulk
// orchestrator (findReleasesBulk) passes ONE shared deadline to all sub-calls
// so per-lookup budgets don't compose past the Worker wall-clock.

import {
  BulkLimitError,
  LookupTimeoutError,
  NoReleasesError,
  NotYetReleasedError,
  RateLimitError,
  ReleasedError,
} from './errors.js';
import type { Provider } from './provider.js';
import { renderReleaseNotes } from './release-notes.js';
import {
  type BulkResult,
  type BulkSubError,
  DEFAULT_DATE_CULL_MARGIN_MS,
  type LookupInput,
  type LookupResult,
  MAX_BULK,
  type RateLimitInfo,
  type ReleaseHit,
  type RepoRef,
  type TagWithDate,
} from './types.js';

export type FindReleaseOpts = {
  client: Provider;
  signal?: AbortSignal | undefined;
  /** Absolute epoch-ms. Defaults: now+20s. */
  softDeadline?: number | undefined;
  /** Absolute epoch-ms. Defaults: now+25s. */
  hardDeadline?: number | undefined;
  /** Parallel batch size for ancestry checks. Default 5. */
  batchSize?: number | undefined;
  /** How many newer tags to check for the "also in" list. Default 5. */
  alsoInLimit?: number | undefined;
  /** Skip date-based culling. Default false. Set true for repos with
   *  manually-backdated commit metadata (pathological — see DEFAULT_DATE_CULL_MARGIN_MS). */
  strict?: boolean | undefined;
  /** Override the date-cull safety margin (ms). Default 90 days. */
  dateMarginMs?: number | undefined;
  /** Include prerelease-pattern tags (alpha/beta/rc/...). Default false:
   *  "did my fix ship?" usually means "in a release real users run." */
  includePrereleases?: boolean | undefined;
};

export async function findRelease(
  input: LookupInput,
  opts: FindReleaseOpts,
): Promise<LookupResult> {
  const { client } = opts;
  const softDeadline = opts.softDeadline ?? Date.now() + 24_000;
  const hardDeadline = opts.hardDeadline ?? Date.now() + 28_000;
  const batchSize = opts.batchSize ?? 5;
  const alsoInLimit = opts.alsoInLimit ?? 5;
  const strict = opts.strict ?? false;
  const dateMarginMs = opts.dateMarginMs ?? DEFAULT_DATE_CULL_MARGIN_MS;
  const includePrereleases = opts.includePrereleases ?? false;
  const repo: RepoRef = input.repo;

  // Step 1: resolve to a canonical commit SHA
  let canonicalSha: string;
  if (input.kind === 'pr') {
    const pr = await client.getPullRequest(repo, input.number);
    canonicalSha = pr.mergeCommitSha;
  } else {
    canonicalSha = input.sha;
  }
  // Validate + get the full SHA + committer date
  const commit = await client.getCommit(repo, canonicalSha);
  canonicalSha = commit.fullSha;
  const committedDate = commit.committedDate;

  // Step 2: list tags
  const tagList = await client.listTagsWithDates(repo);
  let rateLimit: RateLimitInfo | null = tagList.rateLimit;
  if (tagList.tags.length === 0) throw new NoReleasesError();

  // Step 3: sort by date ascending, then apply a wide-margin date cull (unless
  // strict mode). Tags whose underlying-commit-date is more than `dateMarginMs`
  // BEFORE the input commit's date are dropped as candidates — a 2002-era tag
  // genuinely cannot contain a 2024 commit, no matter what dates claim.
  //
  // This reverses D24 in spirit but not in correctness: the original D24
  // forbade ANY date filter because dates can lie by seconds-to-days (clock
  // skew). A 90-day margin handles all realistic skew while still pruning
  // CVS/SVN-imported pre-history tags instantly. Pathological backdated commits
  // (rare) get the wrong "not yet released" answer — `strict: true` is the
  // escape hatch.
  const sorted: readonly TagWithDate[] = [...tagList.tags].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  let candidates: readonly TagWithDate[] = sorted;
  let culledTagCount = 0;
  if (!strict) {
    const commitMs = Date.parse(committedDate);
    if (!Number.isNaN(commitMs)) {
      const cutoff = commitMs - dateMarginMs;
      candidates = sorted.filter((t) => {
        const tagMs = Date.parse(t.date);
        // Keep tags with unparseable dates as a safety belt — we'd rather check
        // a few extra than wrongly cull a real candidate.
        if (Number.isNaN(tagMs)) return true;
        const keep = tagMs >= cutoff;
        if (!keep) culledTagCount++;
        return keep;
      });
    }
  }

  // Prerelease filter (D37). Default: exclude alpha/beta/rc/etc — most users
  // asking "did my fix ship?" mean to a production release. Toggle on via the
  // `includePrereleases` flag.
  let prereleasedCount = 0;
  if (!includePrereleases) {
    candidates = candidates.filter((t) => {
      if (t.isPrerelease) {
        prereleasedCount++;
        return false;
      }
      return true;
    });
  }

  // Step 4: locate the earliest containing tag.
  //
  // Default mode (D35 → D36): galloping probe + parallel bisect, biased to start
  // near the input commit's date. O(log n) compares in the common case — turns
  // kubernetes-scale repos (~1700 tags) from 25s+ timeouts into ~10s lookups.
  //
  // Strict mode: linear scan from the oldest candidate, batched. Slower but
  // checks every tag (catches clock-skewed / backdated cases the galloping
  // skips when it date-positions past them).
  const locateResult = await locateFirstHit({
    candidates,
    commitDate: committedDate,
    compare: async (idx) => {
      const t = candidates[idx]!;
      const r = await client.compareCommits(repo, t.sha, canonicalSha);
      return {
        contains: r.status === 'behind' || r.status === 'identical',
        rateLimit: r.rateLimit,
      };
    },
    strict,
    softDeadline,
    hardDeadline,
    batchSize,
  });
  const candidatesTried = locateResult.candidatesTried;
  if (locateResult.rateLimit) rateLimit = locateResult.rateLimit;

  if (locateResult.timedOut !== null) {
    // Hit a deadline (soft or hard). If the galloping phase found a
    // known-containing tag, return it as a best-effort partial answer rather
    // than throwing — the gallop-found tag is almost always the right answer;
    // bisect just verifies "could there be an earlier one." Better UX: show
    // *an* answer, flag partial, than throw "took too long."
    if (locateResult.hitIdx !== null) {
      const hit = candidates[locateResult.hitIdx]!;
      return {
        input,
        canonicalSha,
        firstRelease: toHit(client, repo, hit),
        alsoIn: [],
        releaseNotesHtml: null,
        rateLimit,
        partial: { reason: 'soft_deadline', candidatesTried },
        urls: buildResultUrls(client, repo, canonicalSha, input),
      };
    }
    // No hit at all and hard deadline → genuinely a server-side timeout.
    if (locateResult.timedOut === 'hard') {
      throw new LookupTimeoutError(candidatesTried);
    }
    // Soft deadline, no hit — return partial with null firstRelease.
    return {
      input,
      canonicalSha,
      firstRelease: null,
      alsoIn: [],
      releaseNotesHtml: null,
      rateLimit,
      partial: { reason: 'soft_deadline', candidatesTried },
      urls: buildResultUrls(client, repo, canonicalSha, input),
    };
  }

  if (locateResult.hitIdx === null) {
    throw new NotYetReleasedError(canonicalSha, committedDate, culledTagCount, prereleasedCount);
  }

  const firstHit = candidates[locateResult.hitIdx]!;
  const firstHitIdx = locateResult.hitIdx;

  // Step 5: also-in list (next ~N newer tags). Use `candidates` (post-cull) —
  // culled tags are by definition too old to be "also in" anyway.
  const alsoCandidates = candidates.slice(firstHitIdx + 1, firstHitIdx + 1 + alsoInLimit);
  const alsoResults =
    alsoCandidates.length === 0
      ? []
      : await Promise.all(
          alsoCandidates.map((t) => client.compareCommits(repo, t.sha, canonicalSha)),
        );
  const alsoLast = alsoResults[alsoResults.length - 1];
  if (alsoLast?.rateLimit) rateLimit = alsoLast.rateLimit;
  const alsoIn: ReleaseHit[] = [];
  alsoCandidates.forEach((t, j) => {
    const r = alsoResults[j];
    if (r && (r.status === 'behind' || r.status === 'identical')) {
      alsoIn.push(toHit(client, repo, t));
    }
  });

  // Step 6: release notes (CP6)
  let releaseNotesHtml: string | null = null;
  try {
    const notes = await client.getReleaseNotes(repo, firstHit.name);
    if (notes.rateLimit) rateLimit = notes.rateLimit;
    releaseNotesHtml = notes.body ? await renderReleaseNotes(notes.body) : null;
  } catch (err) {
    // Release notes are non-essential — if a sanitizer error or network blip
    // occurs, surface the result without notes rather than failing the lookup.
    if (err instanceof RateLimitError) throw err;
    releaseNotesHtml = null;
  }

  return {
    input,
    canonicalSha,
    firstRelease: toHit(client, repo, firstHit),
    alsoIn,
    releaseNotesHtml,
    rateLimit,
    urls: buildResultUrls(client, repo, canonicalSha, input),
  };
}

// --- Bulk path (CP3 + #6 fix) ------------------------------------------------

export type FindReleasesBulkOpts = Omit<FindReleaseOpts, 'softDeadline' | 'hardDeadline'> & {
  /** Shared absolute epoch-ms deadline across all sub-lookups. Defaults: now+25s. */
  deadline?: number;
  /** Concurrency limit. Default 8. */
  concurrency?: number;
};

export async function findReleasesBulk(
  inputs: readonly LookupInput[],
  opts: FindReleasesBulkOpts,
): Promise<BulkResult> {
  if (inputs.length > MAX_BULK) {
    throw new BulkLimitError(inputs.length, MAX_BULK);
  }
  const sharedDeadline = opts.deadline ?? Date.now() + 25_000;
  const concurrency = opts.concurrency ?? 8;

  // Memoize listTagsWithDates per (owner, repo) so same-repo inputs share one
  // GraphQL call. The wrapped client otherwise forwards every method as-is.
  const sharedClient = memoizeTagsClient(opts.client);

  // Use a dense array (Array.from gives [undefined, undefined, ...]) — sparse
  // arrays' .filter() skips holes, which would silently break pendingCount.
  const results: (LookupResult | BulkSubError | undefined)[] = Array.from({
    length: inputs.length,
  });
  const ctrl = new AbortController();
  let partialReason: BulkResult['partial'] | undefined;

  // Process inputs in order, capped concurrency.
  const queue = inputs.map((input, idx) => ({ input, idx }));

  async function worker(): Promise<void> {
    while (queue.length > 0 && !ctrl.signal.aborted) {
      const next = queue.shift();
      if (!next) return;
      try {
        const r = await findRelease(next.input, {
          ...opts,
          client: sharedClient,
          // Per-sub-call soft deadline = shared bulk deadline minus a small margin.
          softDeadline: sharedDeadline - 1500,
          hardDeadline: sharedDeadline,
          signal: ctrl.signal,
        });
        results[next.idx] = r;
      } catch (err) {
        if (err instanceof RateLimitError) {
          partialReason = {
            reason: 'rate_limit_exhausted',
            pendingCount: 0, // recomputed at the end
            resetAt: err.resetAt,
          };
          ctrl.abort();
          return;
        }
        if (err instanceof LookupTimeoutError) {
          partialReason = { reason: 'bulk_deadline', pendingCount: 0 };
          ctrl.abort();
          return;
        }
        results[next.idx] = toBulkError(err);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const pendingCount = results.filter((r) => r === undefined).length;
  return {
    results: results.map((r) =>
      r === undefined ? toBulkError(new Error('not run (cancelled)')) : r,
    ),
    ...(partialReason ? { partial: { ...partialReason, pendingCount } } : {}),
  };
}

// --- locateFirstHit ----------------------------------------------------------
//
// The candidate-search heart of the algorithm. In default (non-strict) mode it
// does a date-positioned galloping probe followed by parallel-K bisection, so
// the kubernetes-scale case (1700 tags × 3-4s/compare) fits in the deadline.
// In strict mode it does a plain linear scan from the oldest candidate.

type LocateOpts = {
  candidates: readonly TagWithDate[];
  commitDate: string;
  compare: (idx: number) => Promise<{ contains: boolean; rateLimit: RateLimitInfo | null }>;
  strict: boolean;
  softDeadline: number;
  hardDeadline: number;
  batchSize: number;
};

type LocateOutcome = {
  hitIdx: number | null;
  candidatesTried: number;
  rateLimit: RateLimitInfo | null;
  timedOut: 'soft' | 'hard' | null;
};

/** How many candidates BEFORE datePos to also probe, as a clock-skew safety net.
 *  20 covers ~weeks of recent tags in fast-moving repos — enough for any
 *  realistic clock skew. Tags older than this in the cull-pass window get
 *  skipped in default mode; strict mode catches them. */
const CLOCK_SKEW_SAFETY_BACK = 20;

/** Parallel-bisect width: each bisect round probes this many points at once.
 *  Narrows the search range by ~K each round. log10(1024) ≈ 3 rounds vs
 *  log2(1024) = 10 sequential — turns the kubernetes-scale bisect from ~40s
 *  to ~12s. Cloudflare Workers default is 6 concurrent outbound connections,
 *  so we tune K below that; the rest queue and only add a small latency tax. */
const PARALLEL_BISECT_K = 9;

async function locateFirstHit(opts: LocateOpts): Promise<LocateOutcome> {
  const { candidates, compare, strict, softDeadline, hardDeadline, batchSize } = opts;
  let candidatesTried = 0;
  let lastRateLimit: LocateOutcome['rateLimit'] = null;

  if (candidates.length === 0) {
    return { hitIdx: null, candidatesTried: 0, rateLimit: null, timedOut: null };
  }

  /** Returns 'hard' / 'soft' / null at the current instant. */
  const deadlineState = (): 'soft' | 'hard' | null => {
    const now = Date.now();
    if (now >= hardDeadline) return 'hard';
    if (now >= softDeadline) return 'soft';
    return null;
  };

  /** Run N compares in parallel. */
  const compareAll = async (idxs: readonly number[]): Promise<boolean[]> => {
    const results = await Promise.all(idxs.map(compare));
    candidatesTried += idxs.length;
    const last = results[results.length - 1];
    if (last?.rateLimit) lastRateLimit = last.rateLimit;
    return results.map((r) => r.contains);
  };

  // --- strict mode: plain linear scan from oldest ---------------------------
  if (strict) {
    for (let i = 0; i < candidates.length; i += batchSize) {
      const d = deadlineState();
      if (d) return { hitIdx: null, candidatesTried, rateLimit: lastRateLimit, timedOut: d };
      const batchEnd = Math.min(i + batchSize, candidates.length);
      const idxs = Array.from({ length: batchEnd - i }, (_, k) => i + k);
      const results = await compareAll(idxs);
      const localHit = results.indexOf(true);
      if (localHit >= 0) {
        return { hitIdx: i + localHit, candidatesTried, rateLimit: lastRateLimit, timedOut: null };
      }
    }
    return { hitIdx: null, candidatesTried, rateLimit: lastRateLimit, timedOut: null };
  }

  // --- default mode: date-positioned galloping + parallel bisect ------------

  // Step 1: find datePos — the first index whose date is >= commitDate.
  // Tags BEFORE this index were cut before the commit existed (or before-ish,
  // within the cull window). Tags AT OR AFTER this index might contain.
  const commitMs = Date.parse(opts.commitDate);
  let datePos = candidates.length;
  if (Number.isFinite(commitMs)) {
    for (let i = 0; i < candidates.length; i++) {
      const tMs = Date.parse(candidates[i]!.date);
      if (Number.isFinite(tMs) && tMs >= commitMs) {
        datePos = i;
        break;
      }
    }
  } else {
    datePos = 0;
  }

  // Step 2: start the probe at datePos minus a clock-skew safety net.
  const start = Math.max(0, datePos - CLOCK_SKEW_SAFETY_BACK);
  if (start >= candidates.length) {
    return { hitIdx: null, candidatesTried, rateLimit: lastRateLimit, timedOut: null };
  }

  // Step 3: galloping probes. Dense near `start` (where the answer usually is —
  // "next release after the commit") then exponentially wider. For
  // kubernetes-scale repos with the answer ~10-50 candidates past datePos, the
  // dense head catches it in ONE parallel batch.
  const probeOffsets = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610];
  const probeSet = new Set<number>();
  for (const off of probeOffsets) {
    if (start + off < candidates.length) probeSet.add(start + off);
  }
  // Always probe the final candidate so we never miss a hit at the very end.
  probeSet.add(candidates.length - 1);
  const probes = [...probeSet].sort((a, b) => a - b);

  {
    const d = deadlineState();
    if (d) return { hitIdx: null, candidatesTried, rateLimit: lastRateLimit, timedOut: d };
  }

  const probeResults = await compareAll(probes);

  // Find the smallest probe index that contains.
  let firstHitProbe = -1;
  for (let i = 0; i < probes.length; i++) {
    if (probeResults[i]) {
      firstHitProbe = i;
      break;
    }
  }
  if (firstHitProbe < 0) {
    return { hitIdx: null, candidatesTried, rateLimit: lastRateLimit, timedOut: null };
  }

  // Step 4: parallel-K bisect within [low, high] where high is the first hit.
  let high = probes[firstHitProbe]!;
  let low = firstHitProbe === 0 ? start : probes[firstHitProbe - 1]! + 1;
  let answer = high;

  while (low < high) {
    const d = deadlineState();
    if (d) {
      // Soft-deadline: return the known-containing `answer` (could be `high`),
      // but mark partial so caller knows it's not necessarily the earliest.
      // For now, surface as timedOut; caller decides what to do.
      return { hitIdx: answer, candidatesTried, rateLimit: lastRateLimit, timedOut: d };
    }
    const range = high - low + 1;
    if (range <= PARALLEL_BISECT_K + 1) {
      // Small enough — just probe everything left.
      const idxs = Array.from({ length: range }, (_, i) => low + i);
      const results = await compareAll(idxs);
      const localHit = results.indexOf(true);
      if (localHit >= 0) answer = low + localHit;
      break;
    }
    // K equally-spaced probes within (low, high). high is known to contain.
    const idxs: number[] = [];
    for (let k = 1; k <= PARALLEL_BISECT_K; k++) {
      idxs.push(low + Math.floor((range * k) / (PARALLEL_BISECT_K + 1)));
    }
    const results = await compareAll(idxs);
    const localHit = results.indexOf(true);
    if (localHit >= 0) {
      high = idxs[localHit]!;
      answer = high;
      low = localHit === 0 ? low : idxs[localHit - 1]! + 1;
    } else {
      // None of the bisect probes hit — the earliest containing is in (last
      // probe, high]. Set low to last-probe + 1.
      low = idxs[idxs.length - 1]! + 1;
    }
  }

  return { hitIdx: answer, candidatesTried, rateLimit: lastRateLimit, timedOut: null };
}

// --- helpers -----------------------------------------------------------------

function toHit(client: Provider, repo: RepoRef, t: TagWithDate): ReleaseHit {
  return {
    tag: t.name,
    sha: t.sha,
    date: t.date,
    url: client.urls.release(repo, t.name),
  };
}

function buildResultUrls(
  client: Provider,
  repo: RepoRef,
  canonicalSha: string,
  input: LookupInput,
): LookupResult['urls'] {
  const urls: { repo: string; commit: string; pullRequest?: string } = {
    repo: client.urls.repo(repo),
    commit: client.urls.commit(repo, canonicalSha),
  };
  if (input.kind === 'pr') {
    urls.pullRequest = client.urls.pullRequest(repo, input.number);
  }
  return urls;
}

function toBulkError(err: unknown): BulkSubError {
  if (err instanceof ReleasedError) {
    return { kind: 'error', errorName: err.name, message: err.message };
  }
  const e = err as Error;
  return { kind: 'error', errorName: e?.name ?? 'Error', message: e?.message ?? String(err) };
}

/** Wrap a Provider so that listTagsWithDates is memoized per (host, projectPath)
 *  for the lifetime of this wrapper. Used by findReleasesBulk so inputs against
 *  the same repo share one tag-listing call.
 *
 *  Key includes `host` so a bulk lookup mixing github.com/foo/bar and
 *  gitlab.com/foo/bar hits TWO independent memoization slots — not one, which
 *  would silently return GitHub tags for the GitLab repo. */
function memoizeTagsClient(client: Provider): Provider {
  const cache = new Map<string, ReturnType<Provider['listTagsWithDates']>>();
  return {
    ...client,
    listTagsWithDates(repo) {
      const key = `${repo.host}/${repo.projectPath}`;
      let p = cache.get(key);
      if (!p) {
        p = client.listTagsWithDates(repo);
        cache.set(key, p);
      }
      return p;
    },
  };
}
