import { describe, expect, it } from 'vitest';
import { UnsupportedHostError } from '../src/errors.js';
import { KNOWN_GITLAB_HOSTS, isKnownHost, providerFor } from '../src/providers/index.js';

describe('providerFor — host dispatch', () => {
  it('returns a GithubProvider for github.com', () => {
    const p = providerFor('github.com');
    expect(p.host).toBe('github.com');
    expect(p.kind).toBe('github');
    expect(p.terms.mergeRequest).toBe('Pull request');
    expect(p.terms.mergeRequestPrefix).toBe('#');
  });

  it('returns a GitlabProvider for gitlab.com', () => {
    const p = providerFor('gitlab.com');
    expect(p.host).toBe('gitlab.com');
    expect(p.kind).toBe('gitlab');
    expect(p.terms.mergeRequest).toBe('Merge request');
    expect(p.terms.mergeRequestPrefix).toBe('!');
  });

  it('returns a GitlabProvider for gitlab.gnome.org', () => {
    const p = providerFor('gitlab.gnome.org');
    expect(p.host).toBe('gitlab.gnome.org');
    expect(p.kind).toBe('gitlab');
  });

  it('returns a GitlabProvider for every known self-hosted GitLab', () => {
    // Defensive: if someone removes a host from the allowlist, this catches it.
    for (const host of KNOWN_GITLAB_HOSTS) {
      expect(providerFor(host).kind).toBe('gitlab');
    }
  });

  it('throws UnsupportedHostError for unknown hosts with the supported list in the message', () => {
    try {
      providerFor('bitbucket.org');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedHostError);
      expect((err as UnsupportedHostError).host).toBe('bitbucket.org');
      expect((err as UnsupportedHostError).supportedHosts).toContain('github.com');
      expect((err as UnsupportedHostError).supportedHosts).toContain('gitlab.gnome.org');
    }
  });

  it('extraGitlabHosts extends the allowlist without code changes', () => {
    // Worker reads EXTRA_GITLAB_HOSTS from env; CLI reads from config. Verify
    // an unknown host becomes accepted once it's listed.
    expect(() => providerFor('gitlab.example.com')).toThrow(UnsupportedHostError);
    const p = providerFor('gitlab.example.com', { extraGitlabHosts: ['gitlab.example.com'] });
    expect(p.kind).toBe('gitlab');
    expect(p.host).toBe('gitlab.example.com');
  });

  it('URL builders use the resolved host (the / -/ infix matters for GitLab)', () => {
    const gh = providerFor('github.com');
    const gl = providerFor('gitlab.gnome.org');
    const repoGh = { host: 'github.com', projectPath: 'facebook/react' };
    const repoGl = { host: 'gitlab.gnome.org', projectPath: 'GNOME/gimp' };
    expect(gh.urls.commit(repoGh, 'abc')).toBe('https://github.com/facebook/react/commit/abc');
    expect(gl.urls.commit(repoGl, 'abc')).toBe('https://gitlab.gnome.org/GNOME/gimp/-/commit/abc');
    expect(gh.urls.pullRequest(repoGh, 42)).toBe('https://github.com/facebook/react/pull/42');
    expect(gl.urls.pullRequest(repoGl, 42)).toBe(
      'https://gitlab.gnome.org/GNOME/gimp/-/merge_requests/42',
    );
  });
});

describe('isKnownHost — predicate', () => {
  it('returns true for github.com and every known GitLab', () => {
    expect(isKnownHost('github.com')).toBe(true);
    expect(isKnownHost('gitlab.com')).toBe(true);
    expect(isKnownHost('gitlab.gnome.org')).toBe(true);
  });

  it('returns false for unknown hosts unless extraGitlabHosts opts them in', () => {
    expect(isKnownHost('gitlab.example.com')).toBe(false);
    expect(isKnownHost('gitlab.example.com', ['gitlab.example.com'])).toBe(true);
  });
});
