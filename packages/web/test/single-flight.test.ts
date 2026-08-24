// backgroundFlight coalesces stale-while-revalidate refreshes (resolve.ts) in a
// map foreground callers never join. Its hazard is the one singleFlight's own
// header describes: the map is module-level and outlives any single request, so
// an entry registered under request A's IoContext can be handed to request B.
// workerd tears A's IoContext down when A's response ends, so if the refresh had
// not settled by then its promise NEVER settles — and the `finally` that clears
// the entry never runs either. Every later refresh for that key in the isolate
// then joins a dead promise, and background revalidation for it is dead for the
// isolate's lifetime.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backgroundFlight } from '../src/single-flight.js';

/** A promise that never settles — what a torn-down IoContext leaves behind. */
function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('backgroundFlight collapses concurrent refreshes', () => {
  it('runs the loader once for two refreshes fired in the same tick', async () => {
    const loader = vi.fn(async () => 'v1');

    const [a, b] = await Promise.all([
      backgroundFlight('same-tick', loader),
      backgroundFlight('same-tick', loader),
    ]);

    expect(a).toBe('v1');
    expect(b).toBe('v1');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('lets the next refresh run once the previous one has settled', async () => {
    const loader = vi.fn(async () => 'v1');

    await backgroundFlight('settled', loader);
    await backgroundFlight('settled', loader);

    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe('backgroundFlight self-heals a refresh workerd killed mid-flight', () => {
  it('does not hand a later refresh a promise abandoned by a dead IoContext', async () => {
    const dead = vi.fn(neverSettles<string>);
    const live = vi.fn(async () => 'fresh');

    // Unfurl A registers the refresh, then its response ends and workerd cancels
    // the IoContext: the promise is abandoned, so the loader's `finally` — the
    // only thing that clears the entry — never runs.
    void backgroundFlight('abandoned', dead);

    // Unfurl B, well after the hard deadline any real refresh could still be
    // running under. Joining A's entry here would hang B's refresh too, and every
    // later one, for the lifetime of the isolate.
    vi.setSystemTime(Date.now() + 60_000);
    const b = backgroundFlight('abandoned', live);

    await expect(b).resolves.toBe('fresh');
    expect(live).toHaveBeenCalledTimes(1);
  });

  it('still joins a refresh that is merely SLOW, inside the deadline', async () => {
    // The complement, and what keeps the test above from passing vacuously: an
    // entry younger than the bound must still coalesce, or the map stops doing
    // the job it exists for and four crawlers run four full traversals.
    const slow = vi.fn(neverSettles<string>);
    const second = vi.fn(async () => 'second');

    void backgroundFlight('slow', slow);
    vi.setSystemTime(Date.now() + 1_000);
    void backgroundFlight('slow', second);

    await vi.advanceTimersByTimeAsync(0);
    expect(second).not.toHaveBeenCalled();
  });
});
