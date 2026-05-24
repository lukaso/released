import type { LookupResult } from '@released/core';
import { describe, expect, it } from 'vitest';
import { formatResult } from '../src/format.js';

const RESULT: LookupResult = {
  input: {
    kind: 'commit',
    repo: { host: 'github.com', projectPath: 'facebook/react' },
    sha: 'a1b2c3d4e5f67890abcdef1234567890abcdef12',
  },
  urls: {
    repo: 'https://github.com/facebook/react',
    commit: 'https://github.com/facebook/react/commit/a1b2c3d4e5f67890abcdef1234567890abcdef12',
  },
  canonicalSha: 'a1b2c3d4e5f67890abcdef1234567890abcdef12',
  firstRelease: {
    tag: 'v18.2.0',
    sha: 'shav1820',
    date: '2024-03-15T00:00:00Z',
    url: 'https://github.com/facebook/react/releases/tag/v18.2.0',
  },
  alsoIn: [
    {
      tag: 'v18.3.0',
      sha: 'shav1830',
      date: '2024-04-01T00:00:00Z',
      url: 'https://github.com/facebook/react/releases/tag/v18.3.0',
    },
  ],
  releaseNotesHtml: null,
  rateLimit: { remaining: 4998, limit: 5000, resetAt: 1715000000 },
};

describe('formatResult — human (default)', () => {
  it('includes the version, date, commit, also-in', () => {
    const out = formatResult(RESULT, 'human');
    expect(out).toContain('v18.2.0');
    expect(out).toContain('2024-03-15');
    expect(out).toContain('a1b2c3d');
    expect(out).toContain('v18.3.0');
  });

  it('shows the permalink', () => {
    const out = formatResult(RESULT, 'human');
    expect(out).toContain('https://released.blabberate.com/r/facebook/react/c/a1b2c3d');
  });
});

describe('formatResult — slack', () => {
  it('uses Slack mrkdwn syntax', () => {
    const out = formatResult(RESULT, 'slack');
    expect(out).toContain('*v18.2.0*'); // bold via *…*
    expect(out).toContain(
      '<https://released.blabberate.com/r/facebook/react/c/a1b2c3d|see details>',
    );
    expect(out).toContain('`a1b2c3d`'); // inline code via backticks
  });
});

describe('formatResult — markdown (for PR comments)', () => {
  it('uses GitHub-flavored markdown', () => {
    const out = formatResult(RESULT, 'markdown');
    expect(out).toContain('[**v18.2.0**](https://github.com/facebook/react/releases/tag/v18.2.0)');
    expect(out).toContain('`a1b2c3d`');
  });
});

describe('formatResult — json', () => {
  it('outputs pretty JSON', () => {
    const out = formatResult(RESULT, 'json');
    expect(() => JSON.parse(out)).not.toThrow();
    expect(JSON.parse(out)).toEqual(RESULT);
  });
});

describe('formatResult — not-yet-released', () => {
  it('says "Not yet released" when firstRelease is null', () => {
    const r: LookupResult = { ...RESULT, firstRelease: null, alsoIn: [] };
    expect(formatResult(r, 'human')).toMatch(/not yet released/i);
    expect(formatResult(r, 'slack')).toMatch(/not yet released/i);
    expect(formatResult(r, 'markdown')).toMatch(/not yet released/i);
  });

  it('does not claim the commit is on the default branch (we never verify that)', () => {
    const r: LookupResult = { ...RESULT, firstRelease: null, alsoIn: [] };
    for (const fmt of ['human', 'slack', 'markdown'] as const) {
      expect(formatResult(r, fmt)).not.toMatch(/default branch/i);
    }
  });
});
