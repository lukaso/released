import { describe, expect, it, vi } from 'vitest';

// Force the `glab`/`gh` shellout to fail fast and deterministically so these
// tests only exercise env-var resolution, not the developer's local glab state.
vi.mock('node:child_process', () => ({
  spawn: () => {
    throw new Error('no shellout in tests');
  },
}));

import { resolveToken } from '../src/auth.js';

describe('resolveToken — GitLab token scoping', () => {
  it('uses the generic GITLAB_TOKEN for gitlab.com', async () => {
    const env = { GITLAB_TOKEN: 'glpat-dotcom' } as NodeJS.ProcessEnv;
    expect(await resolveToken({ host: 'gitlab.com', env })).toBe('glpat-dotcom');
  });

  it('never sends the generic GITLAB_TOKEN to a self-hosted GitLab instance', async () => {
    const env = { GITLAB_TOKEN: 'glpat-dotcom' } as NodeJS.ProcessEnv;
    // A gitlab.com PAT is invalid elsewhere and leaks the secret to a third-party
    // server. Unknown hosts fall through to glab/anonymous, not the generic token.
    expect(await resolveToken({ host: 'gitlab.gnome.org', env })).toBeUndefined();
  });

  it('uses the per-host env var for the matching host', async () => {
    const env = {
      GITLAB_TOKEN: 'glpat-dotcom',
      GITLAB_TOKEN_GITLAB_GNOME_ORG: 'glpat-gnome',
    } as NodeJS.ProcessEnv;
    expect(await resolveToken({ host: 'gitlab.gnome.org', env })).toBe('glpat-gnome');
  });

  it('the --token flag still wins for any host', async () => {
    const env = { GITLAB_TOKEN: 'glpat-dotcom' } as NodeJS.ProcessEnv;
    expect(await resolveToken({ host: 'gitlab.gnome.org', env, tokenFlag: 'glpat-flag' })).toBe(
      'glpat-flag',
    );
  });
});
