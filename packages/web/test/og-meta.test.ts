// Unit tests for the OG image URL builder (issue #8: federated OG rendering).
// The GitHub-only scheme `/r/o/r/c/sha.png` and the federated scheme
// `/h/:host/r/:projectPath/c/:sha.png` must mirror the permalink route shapes
// in web/src/index.ts (federated projectPath is URL-encoded, host included).

import { type LookupResult, OG_TEMPLATE_VERSION } from '@released/core';
import { describe, expect, it } from 'vitest';
import { ogImageUrl } from '../src/ui/og-meta.js';

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
