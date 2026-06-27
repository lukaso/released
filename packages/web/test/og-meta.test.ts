// Unit tests for the OG image URL builder (issue #8: federated OG rendering).
// The GitHub-only scheme `/r/o/r/c/sha.png` and the federated scheme
// `/h/:host/r/:projectPath/c/:sha.png` must mirror the permalink route shapes
// in web/src/index.ts (federated projectPath is URL-encoded, host included).

import { type LookupResult, OG_TEMPLATE_VERSION } from '@released/core';
import { describe, expect, it } from 'vitest';
import { ogImageUrl, ogImageUrlForCommit } from '../src/ui/og-meta.js';

const BASE = 'https://og.example';

function resultFor(host: string, projectPath: string): LookupResult {
  return {
    input: { kind: 'commit', repo: { host, projectPath }, sha: 'a'.repeat(40) },
    canonicalSha: 'a'.repeat(40),
    firstRelease: { tag: 'v1.0.0', sha: 's', date: '2024-01-01T00:00:00Z', url: '' },
    alsoIn: [],
    releaseNotesHtml: null,
    rateLimit: null,
  } as unknown as LookupResult;
}

describe('ogImageUrl', () => {
  it('uses the legacy GitHub /r/:owner/:repo scheme for github.com', () => {
    const url = ogImageUrl(resultFor('github.com', 'facebook/react'), BASE);
    expect(url).toBe(`${BASE}/r/facebook/react/c/aaaaaaa.png?v=${OG_TEMPLATE_VERSION}`);
  });

  it('uses the federated /h/:host/r/:projectPath scheme for a GitLab host', () => {
    const url = ogImageUrl(resultFor('gitlab.gnome.org', 'GNOME/gimp'), BASE);
    // host + nested projectPath are URL-encoded into single segments,
    // matching the /h/ permalink routes.
    expect(url).toBe(
      `${BASE}/h/gitlab.gnome.org/r/GNOME%2Fgimp/c/aaaaaaa.png?v=${OG_TEMPLATE_VERSION}`,
    );
  });

  it('encodes deeply-nested GitLab subgroups in the projectPath segment', () => {
    const url = ogImageUrl(resultFor('gitlab.com', 'group/sub/proj'), BASE);
    expect(url).toBe(
      `${BASE}/h/gitlab.com/r/group%2Fsub%2Fproj/c/aaaaaaa.png?v=${OG_TEMPLATE_VERSION}`,
    );
  });

  it('falls back to the placeholder when there is no result', () => {
    const url = ogImageUrl(null, BASE);
    expect(url).toBe(`${BASE}/placeholder.png?v=${OG_TEMPLATE_VERSION}`);
  });
});

// #53: the bot-deferred path has no resolved result yet, but it DOES know the
// repo + sha from the route params. ogImageUrlForCommit builds the same dynamic
// per-commit image URL from those raw params (no LookupResult), so a cold-cache
// unfurl advertises the real card — web-og resolves the commit itself and falls
// back to its own placeholder if the lookup doesn't resolve.
describe('ogImageUrlForCommit', () => {
  it('mirrors the resolved GitHub scheme, shortening the sha to 7 chars', () => {
    const url = ogImageUrlForCommit(
      { host: 'github.com', projectPath: 'facebook/react' },
      'a'.repeat(40),
      BASE,
    );
    expect(url).toBe(`${BASE}/r/facebook/react/c/aaaaaaa.png?v=${OG_TEMPLATE_VERSION}`);
  });

  it('mirrors the federated scheme for a GitLab host', () => {
    const url = ogImageUrlForCommit(
      { host: 'gitlab.gnome.org', projectPath: 'GNOME/gimp' },
      'b'.repeat(40),
      BASE,
    );
    expect(url).toBe(
      `${BASE}/h/gitlab.gnome.org/r/GNOME%2Fgimp/c/bbbbbbb.png?v=${OG_TEMPLATE_VERSION}`,
    );
  });

  it('produces the SAME url a resolved result of the same commit would', () => {
    const ref = { host: 'github.com', projectPath: 'facebook/react' };
    const sha = 'a'.repeat(40);
    expect(ogImageUrlForCommit(ref, sha, BASE)).toBe(
      ogImageUrl(resultFor(ref.host, ref.projectPath), BASE),
    );
  });
});
