// Unit tests for the SVG status-badge generator + result→state mapping.

import type { LookupResult } from '@released/core';
import { describe, expect, it } from 'vitest';
import { BADGE_COLORS, badgeStateForResult, estimateTextWidth, renderBadge } from '../src/badge.js';

const base = {
  input: { kind: 'commit', repo: { host: 'github.com', projectPath: 'a/b' }, sha: 'deadbee' },
  canonicalSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  alsoIn: [],
  releaseNotesHtml: null,
  rateLimit: null,
  urls: { repo: 'r', commit: 'c' },
} as unknown as LookupResult;

describe('renderBadge', () => {
  it('produces an SVG with the default label and the message + color', () => {
    const svg = renderBadge({ message: 'v1.2.3', color: '#3fb950' });
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
    expect(svg).toContain('released');
    expect(svg).toContain('v1.2.3');
    expect(svg).toContain('#3fb950');
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label="released: v1.2.3"');
    // overall width must be a positive integer
    expect(svg).toMatch(/width="\d+"/);
  });

  it('escapes XML special characters in the message', () => {
    const svg = renderBadge({ message: 'a<b&c>d"e', color: '#000000' });
    expect(svg).toContain('&lt;');
    expect(svg).toContain('&amp;');
    expect(svg).toContain('&gt;');
    expect(svg).toContain('&quot;');
    // The raw, unescaped sequence must NOT appear.
    expect(svg).not.toContain('a<b&c>d"e');
  });

  it('honors a custom label', () => {
    const svg = renderBadge({ label: 'shipped', message: 'yes', color: '#000000' });
    expect(svg).toContain('shipped');
    expect(svg).toContain('aria-label="shipped: yes"');
  });
});

describe('badgeStateForResult', () => {
  it('released → the tag, green', () => {
    const s = badgeStateForResult({
      ...base,
      firstRelease: { tag: 'v9.9.9', sha: 's', date: '2024-01-01T00:00:00Z', url: 'u' },
    } as LookupResult);
    expect(s.message).toBe('v9.9.9');
    expect(s.color).toBe(BADGE_COLORS.released);
  });

  it('not yet released (no firstRelease, not partial) → "not yet", gold', () => {
    const s = badgeStateForResult({ ...base, firstRelease: null } as LookupResult);
    expect(s.message).toBe('not yet');
    expect(s.color).toBe(BADGE_COLORS.notYet);
  });

  it('partial without a firstRelease → "checking…", neutral', () => {
    const s = badgeStateForResult({
      ...base,
      firstRelease: null,
      partial: { reason: 'soft_deadline', candidatesTried: 3 },
    } as LookupResult);
    expect(s.message).toContain('checking');
    expect(s.color).toBe(BADGE_COLORS.neutral);
  });
});

describe('estimateTextWidth', () => {
  it('is zero for empty and positive otherwise', () => {
    expect(estimateTextWidth('')).toBe(0);
    expect(estimateTextWidth('v1.0.0')).toBeGreaterThan(0);
  });

  it('grows with length', () => {
    expect(estimateTextWidth('vvvvvv')).toBeGreaterThan(estimateTextWidth('vvv'));
  });
});
