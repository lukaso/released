// Unit tests for aggregateBulkPartials — the per-host-group partial merge used
// by the bulk route. Multi-host bulk runs one findReleasesBulk per host, so a
// partial can arrive from any group; the response must still report exactly ONE
// partial, with the most severe reason. Issue #10.
import { describe, expect, it } from 'vitest';
import { aggregateBulkPartials } from '../src/routes/lookup-bulk.js';

describe('aggregateBulkPartials', () => {
  it('returns undefined when no group was partial', () => {
    expect(aggregateBulkPartials([])).toBeUndefined();
  });

  it('passes a single partial through unchanged (reason + pendingCount + resetAt)', () => {
    const out = aggregateBulkPartials([
      { reason: 'rate_limit_exhausted', pendingCount: 2, resetAt: 1700000000 },
    ]);
    expect(out).toEqual({ reason: 'rate_limit_exhausted', pendingCount: 2, resetAt: 1700000000 });
  });

  it('surfaces the MOST SEVERE reason (rate_limit > bulk_deadline > network_error)', () => {
    const out = aggregateBulkPartials([
      { reason: 'network_error', pendingCount: 1 },
      { reason: 'bulk_deadline', pendingCount: 1 },
      { reason: 'rate_limit_exhausted', pendingCount: 1, resetAt: 42 },
    ]);
    expect(out?.reason).toBe('rate_limit_exhausted');
    // resetAt is carried from the rate-limit group that won severity.
    expect(out?.resetAt).toBe(42);
  });

  it('picks bulk_deadline over network_error when no rate-limit is present', () => {
    const out = aggregateBulkPartials([
      { reason: 'network_error', pendingCount: 3 },
      { reason: 'bulk_deadline', pendingCount: 1 },
    ]);
    expect(out?.reason).toBe('bulk_deadline');
    // No rate-limit group → no resetAt.
    expect(out?.resetAt).toBeUndefined();
  });

  it('sums pendingCount across all partial groups', () => {
    const out = aggregateBulkPartials([
      { reason: 'bulk_deadline', pendingCount: 2 },
      { reason: 'bulk_deadline', pendingCount: 5 },
    ]);
    expect(out?.pendingCount).toBe(7);
  });
});
