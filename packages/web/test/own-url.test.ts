// recognizeOwnUrl: when a user pastes one of OUR permalink/badge URLs back into
// the search box, map it to the canonical permalink path so we redirect to it,
// instead of feeding "released.blabberate.com/…" to parseInput (which rightly
// rejects our own host as "not a git host").

import { describe, expect, it } from 'vitest';
import { recognizeOwnUrl } from '../src/own-url.js';

const SELF = ['released.blabberate.com', 'released.example'];

describe('recognizeOwnUrl', () => {
  it('recognizes the federated MR permalink with the host/prefix stripped (the reported case)', () => {
    expect(recognizeOwnUrl('gitlab.gnome.org/p/GNOME%2Fgtk/9951', SELF)).toBe(
      '/h/gitlab.gnome.org/p/GNOME%2Fgtk/9951',
    );
  });

  it('recognizes the full federated MR permalink URL', () => {
    expect(
      recognizeOwnUrl(
        'https://released.blabberate.com/h/gitlab.gnome.org/p/GNOME%2Fgtk/9951',
        SELF,
      ),
    ).toBe('/h/gitlab.gnome.org/p/GNOME%2Fgtk/9951');
  });

  it('recognizes a permalink copied with its /badge.svg suffix', () => {
    expect(
      recognizeOwnUrl(
        'https://released.blabberate.com/h/gitlab.gnome.org/p/GNOME%2Fgtk/9951/badge.svg',
        SELF,
      ),
    ).toBe('/h/gitlab.gnome.org/p/GNOME%2Fgtk/9951');
  });

  it('recognizes the federated commit permalink', () => {
    expect(
      recognizeOwnUrl('https://released.example/h/gitlab.gnome.org/r/GNOME%2Fgtk/c/abc1234', SELF),
    ).toBe('/h/gitlab.gnome.org/r/GNOME%2Fgtk/c/abc1234');
  });

  it('recognizes the GitHub PR permalink (path only)', () => {
    expect(recognizeOwnUrl('p/facebook/react/123', SELF)).toBe('/p/facebook/react/123');
  });

  it('recognizes the GitHub commit permalink (path only)', () => {
    expect(recognizeOwnUrl('r/facebook/react/c/abcdef1', SELF)).toBe('/r/facebook/react/c/abcdef1');
  });

  it('returns null for a real git-host URL (parseInput should handle it)', () => {
    expect(recognizeOwnUrl('https://github.com/facebook/react/commit/abc1234', SELF)).toBeNull();
    expect(
      recognizeOwnUrl('https://gitlab.gnome.org/GNOME/gtk/-/merge_requests/9951', SELF),
    ).toBeNull();
  });

  it('returns null for plain owner/repo, alias, or empty input', () => {
    expect(recognizeOwnUrl('facebook/react', SELF)).toBeNull();
    expect(recognizeOwnUrl('gtk', SELF)).toBeNull();
    expect(recognizeOwnUrl('', SELF)).toBeNull();
  });

  it('returns null when the projectPath is not %2F-encoded (ambiguous extra slash)', () => {
    // We do not guess where the project ends; let parseInput try.
    expect(
      recognizeOwnUrl('https://released.example/h/gitlab.gnome.org/p/GNOME/gtk/9951', SELF),
    ).toBeNull();
  });
});
