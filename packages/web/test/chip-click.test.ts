import { describe, expect, it } from 'vitest';
import { computeChipClickInputValue } from '../src/ui/chip-click.js';

describe('computeChipClickInputValue', () => {
  it('returns "alias " when the input is empty', () => {
    expect(computeChipClickInputValue('', 'gtk')).toBe('gtk ');
  });

  it('returns "alias " when the input is whitespace only', () => {
    expect(computeChipClickInputValue('   ', 'gtk')).toBe('gtk ');
  });

  it('preserves a SHA-shape input by prepending the alias', () => {
    expect(computeChipClickInputValue('8c0ef808ea', 'gtk')).toBe('gtk 8c0ef808ea');
  });

  it('accepts the shortest valid SHA (7 chars)', () => {
    expect(computeChipClickInputValue('abc1234', 'react')).toBe('react abc1234');
  });

  it('accepts the longest valid SHA (40 chars)', () => {
    const fullSha = '8c0ef808ea1234567890abcdef1234567890abcd';
    expect(computeChipClickInputValue(fullSha, 'gtk')).toBe(`gtk ${fullSha}`);
  });

  it('is case-insensitive on the SHA detection', () => {
    expect(computeChipClickInputValue('ABCDEF1', 'react')).toBe('react ABCDEF1');
  });

  it('replaces non-SHA input with "alias "', () => {
    expect(computeChipClickInputValue('hello world', 'gtk')).toBe('gtk ');
  });

  it('replaces a too-short SHA-like input with "alias "', () => {
    expect(computeChipClickInputValue('abc12', 'gtk')).toBe('gtk ');
  });

  it('replaces a URL input with "alias "', () => {
    expect(computeChipClickInputValue('https://github.com/foo/bar', 'gtk')).toBe('gtk ');
  });

  it('trims whitespace around a SHA before prepending', () => {
    expect(computeChipClickInputValue('  8c0ef808ea  ', 'gtk')).toBe('gtk 8c0ef808ea');
  });
});
