import { describe, expect, it } from 'vitest';
import { BareShaError, InvalidInputError, NonGithubUrlError } from '../src/errors.js';
import { parseInput } from '../src/parse-input.js';

describe('parseInput — single smart-input string (CP5)', () => {
  it('parses an https GitHub commit URL', () => {
    expect(parseInput('https://github.com/facebook/react/commit/abc1234')).toEqual({
      kind: 'commit',
      repo: { owner: 'facebook', repo: 'react' },
      sha: 'abc1234',
    });
  });

  it('parses a schemeless GitHub commit URL', () => {
    expect(parseInput('github.com/facebook/react/commit/abc1234567890abcdef')).toEqual({
      kind: 'commit',
      repo: { owner: 'facebook', repo: 'react' },
      sha: 'abc1234567890abcdef',
    });
  });

  it('parses a GitHub PR URL', () => {
    expect(parseInput('https://github.com/vercel/next.js/pull/56012')).toEqual({
      kind: 'pr',
      repo: { owner: 'vercel', repo: 'next.js' },
      number: 56012,
    });
  });

  it('parses owner/repo@sha shorthand', () => {
    expect(parseInput('facebook/react@abc1234')).toEqual({
      kind: 'commit',
      repo: { owner: 'facebook', repo: 'react' },
      sha: 'abc1234',
    });
  });

  it('parses owner/repo#PR shorthand', () => {
    expect(parseInput('vercel/next.js#56012')).toEqual({
      kind: 'pr',
      repo: { owner: 'vercel', repo: 'next.js' },
      number: 56012,
    });
  });

  it('strips trailing slashes and whitespace', () => {
    expect(parseInput('  https://github.com/facebook/react/commit/abc1234/  ')).toEqual({
      kind: 'commit',
      repo: { owner: 'facebook', repo: 'react' },
      sha: 'abc1234',
    });
  });

  it('strips a query string from a commit URL', () => {
    expect(parseInput('https://github.com/facebook/react/commit/abc1234?diff=split')).toEqual({
      kind: 'commit',
      repo: { owner: 'facebook', repo: 'react' },
      sha: 'abc1234',
    });
  });

  // Other GitHub URL shapes that carry a SHA — pasted accidentally or on purpose.

  it('parses /commits/{sha}/{path} (file-history URL — the macports-ports failure mode)', () => {
    expect(
      parseInput(
        'https://github.com/macports/macports-ports/commits/0a69217f38a0c16f5087e2905f1b3248583d0ebe/gnome/gobject-introspection/Portfile',
      ),
    ).toEqual({
      kind: 'commit',
      repo: { owner: 'macports', repo: 'macports-ports' },
      sha: '0a69217f38a0c16f5087e2905f1b3248583d0ebe',
    });
  });

  it('parses /commits/{sha} with no file path', () => {
    expect(parseInput('https://github.com/o/r/commits/abc1234')).toEqual({
      kind: 'commit',
      repo: { owner: 'o', repo: 'r' },
      sha: 'abc1234',
    });
  });

  it('parses /blob/{sha}/{path} (file view at SHA)', () => {
    expect(
      parseInput('https://github.com/facebook/react/blob/a1b2c3d4/packages/react/index.js'),
    ).toEqual({
      kind: 'commit',
      repo: { owner: 'facebook', repo: 'react' },
      sha: 'a1b2c3d4',
    });
  });

  it('parses /tree/{sha}/{path} (tree browse at SHA)', () => {
    expect(parseInput('https://github.com/o/r/tree/abc1234/some/folder')).toEqual({
      kind: 'commit',
      repo: { owner: 'o', repo: 'r' },
      sha: 'abc1234',
    });
  });

  it('parses /blame/{sha}/{path}', () => {
    expect(parseInput('github.com/o/r/blame/abc1234/file.js')).toEqual({
      kind: 'commit',
      repo: { owner: 'o', repo: 'r' },
      sha: 'abc1234',
    });
  });

  it('parses /raw/{sha}/{path}', () => {
    expect(parseInput('github.com/o/r/raw/abc1234/file.js')).toEqual({
      kind: 'commit',
      repo: { owner: 'o', repo: 'r' },
      sha: 'abc1234',
    });
  });

  it('parses /commit/{sha}.patch (raw patch URL)', () => {
    expect(parseInput('https://github.com/o/r/commit/abc1234.patch')).toEqual({
      kind: 'commit',
      repo: { owner: 'o', repo: 'r' },
      sha: 'abc1234',
    });
  });

  it('parses a PR URL with extra trailing path', () => {
    expect(parseInput('https://github.com/vercel/next.js/pull/56012/files')).toEqual({
      kind: 'pr',
      repo: { owner: 'vercel', repo: 'next.js' },
      number: 56012,
    });
  });

  it('does NOT match /commits/{branch-name} (only SHAs are extracted)', () => {
    // Branch names like "main" don't match [0-9a-f]{7,40}, so this should
    // fall through to the "unrecognized GitHub URL" error path.
    expect(() => parseInput('https://github.com/o/r/commits/main/file.js')).toThrow(/GitHub URL/);
  });

  it('parses space-separated "owner/repo SHA"', () => {
    expect(parseInput('kubernetes/kubernetes 85d3992ac1068e35329052506a1a01ec5bf703d9')).toEqual({
      kind: 'commit',
      repo: { owner: 'kubernetes', repo: 'kubernetes' },
      sha: '85d3992ac1068e35329052506a1a01ec5bf703d9',
    });
  });

  it('parses reversed "SHA owner/repo"', () => {
    expect(parseInput('85d3992ac1068e35329052506a1a01ec5bf703d9 kubernetes/kubernetes')).toEqual({
      kind: 'commit',
      repo: { owner: 'kubernetes', repo: 'kubernetes' },
      sha: '85d3992ac1068e35329052506a1a01ec5bf703d9',
    });
  });

  it('parses space-separated "owner/repo #PR"', () => {
    expect(parseInput('vercel/next.js 56012')).toEqual({
      kind: 'pr',
      repo: { owner: 'vercel', repo: 'next.js' },
      number: 56012,
    });
  });

  it('throws BareShaError (distinct kind) for a bare SHA — UI can prompt for repo', () => {
    // A 40-char SHA on its own is a SHA — but we have no idea WHICH repo.
    // Distinct error class so the UI can show a tailored "need a repo" prompt
    // instead of the generic "couldn't parse" message.
    expect(() => parseInput('85d3992ac1068e35329052506a1a01ec5bf703d9')).toThrow(BareShaError);
  });

  it('BareShaError carries the SHA so the UI can pre-fill it', () => {
    try {
      parseInput('ABC1234');
    } catch (err) {
      expect(err).toBeInstanceOf(BareShaError);
      expect((err as BareShaError).sha).toBe('abc1234'); // lowercased
      expect((err as BareShaError).message).toContain('owner/repo abc1234');
    }
  });
});

describe('parseInput — explicit two-arg form (repo, ref)', () => {
  it('accepts repoUrl + commit SHA separately', () => {
    expect(parseInput('facebook/react', 'abc1234')).toEqual({
      kind: 'commit',
      repo: { owner: 'facebook', repo: 'react' },
      sha: 'abc1234',
    });
  });

  it('accepts an https repo URL + SHA', () => {
    expect(parseInput('https://github.com/facebook/react', 'abc1234')).toEqual({
      kind: 'commit',
      repo: { owner: 'facebook', repo: 'react' },
      sha: 'abc1234',
    });
  });

  it('accepts the SSH git URL + SHA', () => {
    expect(parseInput('git@github.com:facebook/react.git', 'abc1234')).toEqual({
      kind: 'commit',
      repo: { owner: 'facebook', repo: 'react' },
      sha: 'abc1234',
    });
  });

  it('accepts a PR number (numeric) as the ref', () => {
    expect(parseInput('vercel/next.js', '56012')).toEqual({
      kind: 'pr',
      repo: { owner: 'vercel', repo: 'next.js' },
      number: 56012,
    });
  });

  it('accepts #PR as the ref', () => {
    expect(parseInput('vercel/next.js', '#56012')).toEqual({
      kind: 'pr',
      repo: { owner: 'vercel', repo: 'next.js' },
      number: 56012,
    });
  });
});

describe('parseInput — rejection', () => {
  it('rejects a GitLab URL with NonGithubUrlError', () => {
    expect(() => parseInput('https://gitlab.com/gitlab-org/gitlab/-/commit/abc1234')).toThrow(
      NonGithubUrlError,
    );
  });

  it('rejects a Bitbucket URL with NonGithubUrlError', () => {
    expect(() => parseInput('https://bitbucket.org/atlassian/jira/commits/abc1234')).toThrow(
      NonGithubUrlError,
    );
  });

  it('rejects gibberish with InvalidInputError', () => {
    expect(() => parseInput('not-a-url-or-anything')).toThrow(InvalidInputError);
  });

  it('rejects an empty string', () => {
    expect(() => parseInput('')).toThrow(InvalidInputError);
  });

  it('rejects a too-short SHA (< 7 chars)', () => {
    expect(() => parseInput('facebook/react', 'abc12')).toThrow(InvalidInputError);
  });

  it('rejects a non-hex SHA', () => {
    expect(() => parseInput('facebook/react', 'not-a-sha-zzz')).toThrow(InvalidInputError);
  });
});
