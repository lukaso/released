import type { LookupInput, RepoRef } from '@released/core';
import { describe, expect, it } from 'vitest';
import { issuePermalinkPath, permalinkPathForInput } from '../src/paths.js';

const GH = (projectPath: string): RepoRef => ({ host: 'github.com', projectPath });
const GL = (host: string, projectPath: string): RepoRef => ({ host, projectPath });

describe('issuePermalinkPath', () => {
  it('builds the GitHub /i/ permalink', () => {
    expect(issuePermalinkPath(GH('honojs/hono'), 1234)).toBe('/i/honojs/hono/1234');
  });

  it('builds the federated /h/.../i/ permalink with the project path URL-encoded', () => {
    expect(issuePermalinkPath(GL('gitlab.gnome.org', 'GNOME/gimp'), 9876)).toBe(
      '/h/gitlab.gnome.org/i/GNOME%2Fgimp/9876',
    );
  });
});

describe('permalinkPathForInput — issue', () => {
  it('routes an issue input to its own /i/ permalink (not the commit permalink)', () => {
    const input: LookupInput = { kind: 'issue', repo: GH('cli/cli'), number: 42 };
    expect(permalinkPathForInput(input, 'deadbeefcafe1234')).toBe('/i/cli/cli/42');
  });
});
