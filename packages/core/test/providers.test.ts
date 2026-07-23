import { describe, expect, it } from 'vitest';
import { UnsupportedHostError } from '../src/errors.js';
import {
  isKnownHost,
  KNOWN_GITEA_HOSTS,
  KNOWN_GITLAB_HOSTS,
  providerFor,
} from '../src/providers/index.js';

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

describe('providerFor — Gitea/Forgejo dispatch', () => {
  it('returns a GiteaProvider for codeberg.org (Forgejo shares the Gitea API)', () => {
    const p = providerFor('codeberg.org');
    expect(p.host).toBe('codeberg.org');
    expect(p.kind).toBe('gitea');
    expect(p.terms.mergeRequest).toBe('Pull request');
    expect(p.terms.mergeRequestPrefix).toBe('#');
  });

  it('returns a GiteaProvider for gitea.com', () => {
    const p = providerFor('gitea.com');
    expect(p.host).toBe('gitea.com');
    expect(p.kind).toBe('gitea');
  });

  it('returns a GiteaProvider for every known Gitea host', () => {
    for (const host of KNOWN_GITEA_HOSTS) {
      expect(providerFor(host).kind).toBe('gitea');
    }
  });

  it('extraGiteaHosts extends the allowlist without code changes', () => {
    expect(() => providerFor('gitea.example.com')).toThrow(UnsupportedHostError);
    const p = providerFor('gitea.example.com', { extraGiteaHosts: ['gitea.example.com'] });
    expect(p.kind).toBe('gitea');
    expect(p.host).toBe('gitea.example.com');
  });

  it('URL builders use GitHub-style paths (no /-/ infix) on the resolved host', () => {
    const gt = providerFor('codeberg.org');
    const repo = { host: 'codeberg.org', projectPath: 'forgejo/forgejo' };
    expect(gt.urls.commit(repo, 'abc')).toBe('https://codeberg.org/forgejo/forgejo/commit/abc');
    expect(gt.urls.pullRequest(repo, 42)).toBe('https://codeberg.org/forgejo/forgejo/pulls/42');
    expect(gt.urls.issue(repo, 7)).toBe('https://codeberg.org/forgejo/forgejo/issues/7');
    expect(gt.urls.release(repo, 'v1.0.0')).toBe(
      'https://codeberg.org/forgejo/forgejo/releases/tag/v1.0.0',
    );
  });

  it('UnsupportedHostError.supportedHosts includes the Gitea hosts', () => {
    try {
      providerFor('bitbucket.org');
      throw new Error('expected throw');
    } catch (err) {
      expect((err as UnsupportedHostError).supportedHosts).toContain('codeberg.org');
      expect((err as UnsupportedHostError).supportedHosts).toContain('gitea.com');
    }
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

  it('returns true for known Gitea hosts and accepts extraGiteaHosts', () => {
    expect(isKnownHost('codeberg.org')).toBe(true);
    expect(isKnownHost('gitea.com')).toBe(true);
    expect(isKnownHost('gitea.example.com')).toBe(false);
    // extraGitlabHosts and extraGiteaHosts are independent options on isKnownHost.
    expect(isKnownHost('gitea.example.com', [], ['gitea.example.com'])).toBe(true);
  });
});
