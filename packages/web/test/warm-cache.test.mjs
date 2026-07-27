// Unit tests for the pure helpers exported from scripts/warm-cache.mjs.
//
// The script is a Node-run .mjs operator tool (not Worker code), so it can't be
// typechecked by tsc and isn't worth a full integration harness — but the parts
// with silent-failure risk ARE unit-tested here: the Analytics Engine SQL
// (wrong filter → warms the wrong repos), the /api/lookup payload shape (wrong
// key → every warm 400s), and the arg/owner parsing.
//
// Run alongside the rest: `pnpm --filter @released/web test`.

import { describe, expect, it } from 'vitest';
import {
  buildTopReposSql,
  buildWarmPayload,
  parseAeResponse,
  parsePositiveInt,
  parseReposArg,
  splitOwnerRepo,
  summarizeLookupResponse,
} from '../scripts/warm-cache.mjs';

describe('parseReposArg', () => {
  it('splits a comma list, trimming and dropping empties', () => {
    expect(parseReposArg('honojs/hono, facebook/react , , torvalds/linux')).toEqual([
      'honojs/hono',
      'facebook/react',
      'torvalds/linux',
    ]);
  });

  it('returns [] for undefined / empty / whitespace input', () => {
    expect(parseReposArg(undefined)).toEqual([]);
    expect(parseReposArg('')).toEqual([]);
    expect(parseReposArg('   ')).toEqual([]);
  });
});

describe('buildTopReposSql', () => {
  it('targets github.com, excludes the loop probe, and bounds the window + limit', () => {
    const sql = buildTopReposSql({ days: 30, limit: 100 });
    // GitHub repos only — the issue (#6) is about warming top GitHub repos.
    expect(sql).toContain("blob2 = 'github.com'");
    // The loop's synthetic liveness probe drives lookups too; if it isn't
    // excluded the "top repos" list is dominated by the example permalink.
    expect(sql).toContain("blob12 != '1'");
    expect(sql).toContain("INTERVAL '30' DAY");
    expect(sql).toContain('LIMIT 100');
    expect(sql).toContain('ORDER BY n DESC');
  });

  it('threads days + limit through', () => {
    const sql = buildTopReposSql({ days: 7, limit: 25 });
    expect(sql).toContain("INTERVAL '7' DAY");
    expect(sql).toContain('LIMIT 25');
  });

  it('counts via sum(_sample_interval), not count()', () => {
    // Analytics Engine samples at high write rates; count() under-reports.
    expect(buildTopReposSql({})).toContain('sum(_sample_interval)');
  });
});

describe('buildWarmPayload', () => {
  it('builds the {input, ref} body POST /api/lookup expects', () => {
    // Shape verified against src/example.ts: {input:"owner/repo", ref:"<sha>"}.
    expect(buildWarmPayload('honojs/hono', 'f82aba8e8ea45d56199e751cee6ea7c067bcd176')).toEqual({
      input: 'honojs/hono',
      ref: 'f82aba8e8ea45d56199e751cee6ea7c067bcd176',
    });
  });
});

describe('splitOwnerRepo', () => {
  it('splits owner/name on the first slash', () => {
    expect(splitOwnerRepo('honojs/hono')).toEqual({ owner: 'honojs', name: 'hono' });
    expect(splitOwnerRepo('lukaso/released')).toEqual({ owner: 'lukaso', name: 'released' });
  });

  it('throws on a value with no owner/name slash', () => {
    expect(() => splitOwnerRepo('nope')).toThrow();
  });
});

// These guard the parts with silent-failure risk in the I/O layer: a non-2xx
// Worker response that falls out of every summary bucket (#119 review), a NaN
// from a bad --concurrency that crashes the run, and an opaque SyntaxError from
// a non-JSON AE body. Each is extracted as a pure helper so it's unit-testable.
describe('summarizeLookupResponse', () => {
  it('on a 2xx with a release, returns the tag + cacheHit and NO error', () => {
    expect(
      summarizeLookupResponse({
        ok: true,
        status: 200,
        ms: 42,
        json: { result: { firstRelease: { tag: 'v1.2.3' } }, cacheHit: false },
      }),
    ).toEqual({ status: 200, ms: 42, tag: 'v1.2.3', cacheHit: false, error: null });
  });

  it('marks already-cached hits', () => {
    const s = summarizeLookupResponse({ ok: true, status: 200, ms: 5, json: { cacheHit: true } });
    expect(s.cacheHit).toBe(true);
    expect(s.tag).toBe(null);
    expect(s.error).toBe(null);
  });

  it('on a non-2xx Worker response (429/503), sets error so the run counts it as failed', () => {
    // Without this, an exhausted Worker GITHUB_TOKEN (every /api/lookup → 429)
    // renders "Done: 0 warmed, 0 cached, 0 failed" — the silent-drop bug.
    const s429 = summarizeLookupResponse({ ok: false, status: 429, ms: 10, json: null });
    expect(s429.error).toBe('http 429');
    expect(s429.tag).toBe(null);
    expect(s429.cacheHit).toBe(null);
    const s503 = summarizeLookupResponse({ ok: false, status: 503, ms: 10, json: null });
    expect(s503.error).toBe('http 503');
  });
});

describe('parsePositiveInt', () => {
  it('accepts a positive integer string', () => {
    expect(parsePositiveInt('4', 'concurrency')).toBe(4);
    expect(parsePositiveInt('100', 'limit')).toBe(100);
  });

  it('rejects non-numeric / non-integer / non-positive input with a message naming the flag', () => {
    // --concurrency foo → NaN → zero pMap workers → fmtRepoLine(undefined) crash.
    for (const bad of ['foo', '', '0', '-3', '3.5', '   ']) {
      expect(() => parsePositiveInt(bad, 'concurrency')).toThrow(/concurrency/);
    }
  });
});

describe('parseAeResponse', () => {
  it('parses valid JSON', () => {
    expect(parseAeResponse('{"data":[1,2]}')).toEqual({ data: [1, 2] });
  });

  it('raises a clear error on a non-JSON body (gateway page / truncation)', () => {
    // Bare JSON.parse would throw an opaque SyntaxError; stats.mjs guards this.
    expect(() => parseAeResponse('<html>gateway timeout</html>')).toThrow(/non-JSON/);
    expect(() => parseAeResponse('')).toThrow(/non-JSON/);
  });
});
