import { describe, expect, it } from 'vitest';
import { statusFor } from '../src/routes/lookup.js';

// The JSON API (`POST /api/lookup`) maps a ReleasedError `kind` to an HTTP
// status via `statusFor`. Issue-input outcomes are semantic client conditions —
// the same family as their PR-input siblings, which return 404 — so they must
// NOT fall through to the 500 default (which reads as "the server broke" to
// callers and pollutes 5xx monitoring). See #54 issue-input feature.
describe('statusFor', () => {
  it('maps issue-resolution outcomes to 404, matching PR-input siblings', () => {
    // issue still open, a fix can still land — mirrors not_yet_released (404)
    expect(statusFor('issue_not_closed')).toBe(404);
    // issue closed, no fixing commit/MR — mirrors pr_not_merged (404)
    expect(statusFor('issue_closed_without_fix')).toBe(404);
    // issue doesn't exist — mirrors pr_not_found / commit_not_found (404)
    expect(statusFor('issue_not_found')).toBe(404);
  });

  it('keeps the established mappings for non-issue kinds', () => {
    expect(statusFor('pr_not_merged')).toBe(404);
    expect(statusFor('not_yet_released')).toBe(404);
    expect(statusFor('invalid_input')).toBe(400);
    expect(statusFor('ambiguous_sha')).toBe(422);
    expect(statusFor('rate_limit')).toBe(429);
    expect(statusFor('lookup_timeout')).toBe(503);
    expect(statusFor('something_unexpected')).toBe(500);
  });

  it('maps a bare SHA (no repo) to 400 — a client input error, not a 5xx', () => {
    // A bare hex SHA with no repo is the input-error family, like invalid_input.
    // Without this case BareShaError fell through to the 500 default and read as
    // "the server broke" to JSON-API callers (verified live: prod
    // POST /api/lookup of a bare SHA returned 500).
    expect(statusFor('bare_sha')).toBe(400);
  });
});
