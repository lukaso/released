import { describe, expect, it } from 'vitest';
import { resolveProviderToken } from '../src/auth.js';
import type { Env } from '../src/env.js';

const req = (headers: Record<string, string> = {}) =>
  new Request('https://released.example/api/x', { headers });

describe('resolveProviderToken — GitLab token scoping', () => {
  it('uses the generic GITLAB_TOKEN for gitlab.com', () => {
    const env = { GITLAB_TOKEN: 'glpat-dotcom' } as Env;
    expect(resolveProviderToken(env, req(), 'gitlab.com')).toBe('glpat-dotcom');
  });

  it('never sends the generic GITLAB_TOKEN to a self-hosted GitLab instance', () => {
    const env = { GITLAB_TOKEN: 'glpat-dotcom' } as Env;
    // A gitlab.com PAT is invalid on other instances and exposes the secret to
    // a third-party server. Unknown hosts must resolve to anonymous instead.
    expect(resolveProviderToken(env, req(), 'gitlab.gnome.org')).toBeUndefined();
  });

  it('uses the per-host secret for the matching host', () => {
    const env = {
      GITLAB_TOKEN: 'glpat-dotcom',
      GITLAB_TOKEN_GITLAB_GNOME_ORG: 'glpat-gnome',
    } as Env;
    expect(resolveProviderToken(env, req(), 'gitlab.gnome.org')).toBe('glpat-gnome');
  });

  it('a user-supplied header still wins for any host', () => {
    const env = { GITLAB_TOKEN: 'glpat-dotcom' } as Env;
    expect(
      resolveProviderToken(env, req({ 'x-user-gitlab-token': 'glpat-user' }), 'gitlab.gnome.org'),
    ).toBe('glpat-user');
  });
});
