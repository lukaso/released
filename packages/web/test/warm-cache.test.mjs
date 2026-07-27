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
  parseReposArg,
  splitOwnerRepo,
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
