import { describe, expect, it } from 'vitest';
import { BareShaError, InvalidInputError, UnsupportedHostError } from '../src/errors.js';
import { parseInput } from '../src/parse-input.js';

const GH = (projectPath: string) => ({ host: 'github.com', projectPath });
const GL = (host: string, projectPath: string) => ({ host, projectPath });

describe('parseInput — GitHub single-arg smart input (CP5)', () => {
  it('parses an https GitHub commit URL', () => {
    expect(parseInput('https://github.com/facebook/react/commit/abc1234')).toEqual({
      kind: 'commit',
      repo: GH('facebook/react'),
      sha: 'abc1234',
    });
  });

  it('parses a schemeless GitHub commit URL', () => {
    expect(parseInput('github.com/facebook/react/commit/abc1234567890abcdef')).toEqual({
      kind: 'commit',
      repo: GH('facebook/react'),
      sha: 'abc1234567890abcdef',
    });
  });

  it('parses a GitHub PR URL', () => {
    expect(parseInput('https://github.com/vercel/next.js/pull/56012')).toEqual({
      kind: 'pr',
      repo: GH('vercel/next.js'),
      number: 56012,
    });
  });

  it('parses owner/repo@sha shorthand', () => {
    expect(parseInput('facebook/react@abc1234')).toEqual({
      kind: 'commit',
      repo: GH('facebook/react'),
      sha: 'abc1234',
    });
  });

  it('parses owner/repo#PR shorthand', () => {
    expect(parseInput('vercel/next.js#56012')).toEqual({
      kind: 'pr',
      repo: GH('vercel/next.js'),
      number: 56012,
    });
  });

  it('strips trailing slashes and whitespace', () => {
    expect(parseInput('  https://github.com/facebook/react/commit/abc1234/  ')).toEqual({
      kind: 'commit',
      repo: GH('facebook/react'),
      sha: 'abc1234',
    });
  });

  it('strips a query string from a commit URL', () => {
    expect(parseInput('https://github.com/facebook/react/commit/abc1234?diff=split')).toEqual({
      kind: 'commit',
      repo: GH('facebook/react'),
      sha: 'abc1234',
    });
  });

  it('parses /commits/{sha}/{path} (file-history URL — the macports-ports failure mode)', () => {
    expect(
      parseInput(
        'https://github.com/macports/macports-ports/commits/0a69217f38a0c16f5087e2905f1b3248583d0ebe/gnome/gobject-introspection/Portfile',
      ),
    ).toEqual({
      kind: 'commit',
      repo: GH('macports/macports-ports'),
      sha: '0a69217f38a0c16f5087e2905f1b3248583d0ebe',
    });
  });

  it('parses /commits/{sha} with no file path', () => {
    expect(parseInput('https://github.com/o/r/commits/abc1234')).toEqual({
      kind: 'commit',
      repo: GH('o/r'),
      sha: 'abc1234',
    });
  });

  it('parses /blob/{sha}/{path} (file view at SHA)', () => {
    expect(
      parseInput('https://github.com/facebook/react/blob/a1b2c3d4/packages/react/index.js'),
    ).toEqual({
      kind: 'commit',
      repo: GH('facebook/react'),
      sha: 'a1b2c3d4',
    });
  });

  it('parses /tree/{sha}/{path} (tree browse at SHA)', () => {
    expect(parseInput('https://github.com/o/r/tree/abc1234/some/folder')).toEqual({
      kind: 'commit',
      repo: GH('o/r'),
      sha: 'abc1234',
    });
  });

  it('parses /blame/{sha}/{path}', () => {
    expect(parseInput('github.com/o/r/blame/abc1234/file.js')).toEqual({
      kind: 'commit',
      repo: GH('o/r'),
      sha: 'abc1234',
    });
  });

  it('parses /raw/{sha}/{path}', () => {
    expect(parseInput('github.com/o/r/raw/abc1234/file.js')).toEqual({
      kind: 'commit',
      repo: GH('o/r'),
      sha: 'abc1234',
    });
  });

  it('parses /commit/{sha}.patch (raw patch URL)', () => {
    expect(parseInput('https://github.com/o/r/commit/abc1234.patch')).toEqual({
      kind: 'commit',
      repo: GH('o/r'),
      sha: 'abc1234',
    });
  });

  it('parses a PR URL with extra trailing path', () => {
    expect(parseInput('https://github.com/vercel/next.js/pull/56012/files')).toEqual({
      kind: 'pr',
      repo: GH('vercel/next.js'),
      number: 56012,
    });
  });

  it('does NOT match /commits/{branch-name} (only SHAs are extracted)', () => {
    expect(() => parseInput('https://github.com/o/r/commits/main/file.js')).toThrow(/GitHub URL/);
  });

  it('parses space-separated "owner/repo SHA"', () => {
    expect(parseInput('kubernetes/kubernetes 85d3992ac1068e35329052506a1a01ec5bf703d9')).toEqual({
      kind: 'commit',
      repo: GH('kubernetes/kubernetes'),
      sha: '85d3992ac1068e35329052506a1a01ec5bf703d9',
    });
  });

  it('parses reversed "SHA owner/repo"', () => {
    expect(parseInput('85d3992ac1068e35329052506a1a01ec5bf703d9 kubernetes/kubernetes')).toEqual({
      kind: 'commit',
      repo: GH('kubernetes/kubernetes'),
      sha: '85d3992ac1068e35329052506a1a01ec5bf703d9',
    });
  });

  it('parses space-separated "owner/repo #PR"', () => {
    expect(parseInput('vercel/next.js 56012')).toEqual({
      kind: 'pr',
      repo: GH('vercel/next.js'),
      number: 56012,
    });
  });

  it('throws BareShaError (distinct kind) for a bare SHA — UI can prompt for repo', () => {
    expect(() => parseInput('85d3992ac1068e35329052506a1a01ec5bf703d9')).toThrow(BareShaError);
  });

  it('BareShaError carries the SHA so the UI can pre-fill it', () => {
    try {
      parseInput('ABC1234');
    } catch (err) {
      expect(err).toBeInstanceOf(BareShaError);
      expect((err as BareShaError).sha).toBe('abc1234');
      expect((err as BareShaError).message).toContain('owner/repo abc1234');
    }
  });
});

describe('parseInput — GitLab URL shapes (federation)', () => {
  it('parses gitlab.com commit URL', () => {
    expect(parseInput('https://gitlab.com/gitlab-org/gitlab/-/commit/abc1234')).toEqual({
      kind: 'commit',
      repo: GL('gitlab.com', 'gitlab-org/gitlab'),
      sha: 'abc1234',
    });
  });

  it('parses gitlab.gnome.org commit URL (the GIMP case that motivated federation)', () => {
    expect(parseInput('https://gitlab.gnome.org/GNOME/gimp/-/commit/deadbeef1234567')).toEqual({
      kind: 'commit',
      repo: GL('gitlab.gnome.org', 'GNOME/gimp'),
      sha: 'deadbeef1234567',
    });
  });

  it('parses a GitLab MR URL', () => {
    expect(parseInput('https://gitlab.gnome.org/GNOME/gimp/-/merge_requests/2466')).toEqual({
      kind: 'pr',
      repo: GL('gitlab.gnome.org', 'GNOME/gimp'),
      number: 2466,
    });
  });

  it('parses nested-subgroup GitLab URL (group/sub/project)', () => {
    expect(
      parseInput('https://gitlab.com/gitlab-org/security-products/foo/-/commit/abc1234'),
    ).toEqual({
      kind: 'commit',
      repo: GL('gitlab.com', 'gitlab-org/security-products/foo'),
      sha: 'abc1234',
    });
  });

  it('parses deeply-nested GitLab URL (4 segments)', () => {
    expect(parseInput('https://gitlab.com/a/b/c/proj/-/merge_requests/1')).toEqual({
      kind: 'pr',
      repo: GL('gitlab.com', 'a/b/c/proj'),
      number: 1,
    });
  });

  it('parses schemeless gitlab.gnome.org URL', () => {
    expect(parseInput('gitlab.gnome.org/GNOME/gimp/-/commit/abc1234')).toEqual({
      kind: 'commit',
      repo: GL('gitlab.gnome.org', 'GNOME/gimp'),
      sha: 'abc1234',
    });
  });

  it('parses GitLab /-/blob/<sha>/<path>', () => {
    expect(
      parseInput('https://gitlab.com/gitlab-org/gitlab/-/blob/abc1234/app/models/user.rb'),
    ).toEqual({
      kind: 'commit',
      repo: GL('gitlab.com', 'gitlab-org/gitlab'),
      sha: 'abc1234',
    });
  });

  it('parses GitLab /-/tree/<sha>/<path>', () => {
    expect(parseInput('https://gitlab.com/gitlab-org/gitlab/-/tree/abc1234/app')).toEqual({
      kind: 'commit',
      repo: GL('gitlab.com', 'gitlab-org/gitlab'),
      sha: 'abc1234',
    });
  });

  it('parses GitLab commit URL with .patch suffix', () => {
    expect(parseInput('https://gitlab.com/x/y/-/commit/abc1234.patch')).toEqual({
      kind: 'commit',
      repo: GL('gitlab.com', 'x/y'),
      sha: 'abc1234',
    });
  });

  it('parses GitLab MR URL with /diffs trailing segment', () => {
    expect(parseInput('https://gitlab.com/gitlab-org/gitlab/-/merge_requests/12345/diffs')).toEqual(
      {
        kind: 'pr',
        repo: GL('gitlab.com', 'gitlab-org/gitlab'),
        number: 12345,
      },
    );
  });

  it('parses salsa.debian.org URL', () => {
    expect(parseInput('https://salsa.debian.org/debian/foo/-/commit/abc1234')).toEqual({
      kind: 'commit',
      repo: GL('salsa.debian.org', 'debian/foo'),
      sha: 'abc1234',
    });
  });

  it('throws UnsupportedHostError for a GitLab-shaped URL on an UNKNOWN host', () => {
    // gitlab.example.com is NOT in the allowlist — we need to tell the user
    // their host isn't recognized AND list the supported ones.
    try {
      parseInput('https://gitlab.example.com/x/y/-/commit/abc1234');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedHostError);
      expect((err as UnsupportedHostError).host).toBe('gitlab.example.com');
      expect((err as UnsupportedHostError).supportedHosts).toContain('gitlab.gnome.org');
      expect((err as UnsupportedHostError).supportedHosts).toContain('github.com');
      expect((err as UnsupportedHostError).message).toContain('EXTRA_GITLAB_HOSTS');
    }
  });

  it('does NOT match /-/commits/{branch-name} for non-SHA refs', () => {
    expect(() => parseInput('https://gitlab.com/x/y/-/blob/main/file.rb')).toThrow(/recognize/);
  });
});

describe('parseInput — explicit two-arg form (repo, ref) — GitHub only', () => {
  it('accepts repoUrl + commit SHA separately', () => {
    expect(parseInput('facebook/react', 'abc1234')).toEqual({
      kind: 'commit',
      repo: GH('facebook/react'),
      sha: 'abc1234',
    });
  });

  it('accepts an https repo URL + SHA', () => {
    expect(parseInput('https://github.com/facebook/react', 'abc1234')).toEqual({
      kind: 'commit',
      repo: GH('facebook/react'),
      sha: 'abc1234',
    });
  });

  it('accepts the SSH git URL + SHA', () => {
    expect(parseInput('git@github.com:facebook/react.git', 'abc1234')).toEqual({
      kind: 'commit',
      repo: GH('facebook/react'),
      sha: 'abc1234',
    });
  });

  it('accepts a PR number (numeric) as the ref', () => {
    expect(parseInput('vercel/next.js', '56012')).toEqual({
      kind: 'pr',
      repo: GH('vercel/next.js'),
      number: 56012,
    });
  });

  it('accepts #PR as the ref', () => {
    expect(parseInput('vercel/next.js', '#56012')).toEqual({
      kind: 'pr',
      repo: GH('vercel/next.js'),
      number: 56012,
    });
  });

  it('rejects a non-github URL in the two-arg form with UnsupportedHostError', () => {
    // Two-arg form is GitHub-only — for GitLab, the user pastes the full URL.
    expect(() => parseInput('https://gitlab.com/x/y', 'abc1234')).toThrow(UnsupportedHostError);
  });
});

describe('parseInput — rejection', () => {
  it('rejects a Bitbucket URL with UnsupportedHostError', () => {
    expect(() => parseInput('https://bitbucket.org/atlassian/jira/commits/abc1234')).toThrow(
      UnsupportedHostError,
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

describe('parseInput — alias shorthand', () => {
  // Aliases resolve to repos via the curated KNOWN_PROJECTS catalog.
  // `gtk` → gitlab.gnome.org/GNOME/gtk; `react` → github.com/facebook/react.
  // Tests cover all four orderings + no-space variants + edge cases.

  describe('single-arg, alias + SHA', () => {
    it('parses "gtk 8c0ef808ea" (alias first, GitLab project)', () => {
      expect(parseInput('gtk 8c0ef808ea')).toEqual({
        kind: 'commit',
        repo: GL('gitlab.gnome.org', 'GNOME/gtk'),
        sha: '8c0ef808ea',
      });
    });

    it('parses "8c0ef808ea gtk" (SHA first, reverse order)', () => {
      expect(parseInput('8c0ef808ea gtk')).toEqual({
        kind: 'commit',
        repo: GL('gitlab.gnome.org', 'GNOME/gtk'),
        sha: '8c0ef808ea',
      });
    });

    it('parses "gtk@8c0ef808ea" (no-space, mirrors owner/repo@sha)', () => {
      expect(parseInput('gtk@8c0ef808ea')).toEqual({
        kind: 'commit',
        repo: GL('gitlab.gnome.org', 'GNOME/gtk'),
        sha: '8c0ef808ea',
      });
    });

    it('parses "react abc1234" (GitHub alias)', () => {
      expect(parseInput('react abc1234')).toEqual({
        kind: 'commit',
        repo: GH('facebook/react'),
        sha: 'abc1234',
      });
    });

    it('is case-insensitive on the alias ("GTK 8c0ef808ea")', () => {
      expect(parseInput('GTK 8c0ef808ea')).toEqual(parseInput('gtk 8c0ef808ea'));
    });

    it('handles dot in alias ("next.js abc1234")', () => {
      expect(parseInput('next.js abc1234')).toEqual({
        kind: 'commit',
        repo: GH('vercel/next.js'),
        sha: 'abc1234',
      });
    });

    it('tolerates extra whitespace between tokens', () => {
      expect(parseInput('gtk   8c0ef808ea')).toEqual({
        kind: 'commit',
        repo: GL('gitlab.gnome.org', 'GNOME/gtk'),
        sha: '8c0ef808ea',
      });
    });
  });

  describe('single-arg, alias + PR', () => {
    it('parses "gtk #2466" (alias first, hash PR)', () => {
      expect(parseInput('gtk #2466')).toEqual({
        kind: 'pr',
        repo: GL('gitlab.gnome.org', 'GNOME/gtk'),
        number: 2466,
      });
    });

    it('parses "#2466 gtk" (hash PR first, reverse order)', () => {
      expect(parseInput('#2466 gtk')).toEqual({
        kind: 'pr',
        repo: GL('gitlab.gnome.org', 'GNOME/gtk'),
        number: 2466,
      });
    });

    it('parses "gtk 2466" (bare number, alias disambiguates)', () => {
      expect(parseInput('gtk 2466')).toEqual({
        kind: 'pr',
        repo: GL('gitlab.gnome.org', 'GNOME/gtk'),
        number: 2466,
      });
    });

    it('parses "2466 gtk" (bare number first, alias disambiguates)', () => {
      expect(parseInput('2466 gtk')).toEqual({
        kind: 'pr',
        repo: GL('gitlab.gnome.org', 'GNOME/gtk'),
        number: 2466,
      });
    });

    it('parses "react#12345" (no-space, mirrors owner/repo#PR)', () => {
      expect(parseInput('react#12345')).toEqual({
        kind: 'pr',
        repo: GH('facebook/react'),
        number: 12345,
      });
    });
  });

  describe('two-arg form, alias side', () => {
    it('parses ("gtk", "8c0ef808ea") (alias first)', () => {
      expect(parseInput('gtk', '8c0ef808ea')).toEqual({
        kind: 'commit',
        repo: GL('gitlab.gnome.org', 'GNOME/gtk'),
        sha: '8c0ef808ea',
      });
    });

    it('parses ("8c0ef808ea", "gtk") (SHA first)', () => {
      expect(parseInput('8c0ef808ea', 'gtk')).toEqual({
        kind: 'commit',
        repo: GL('gitlab.gnome.org', 'GNOME/gtk'),
        sha: '8c0ef808ea',
      });
    });

    it('parses ("gtk", "#2466") (alias + PR)', () => {
      expect(parseInput('gtk', '#2466')).toEqual({
        kind: 'pr',
        repo: GL('gitlab.gnome.org', 'GNOME/gtk'),
        number: 2466,
      });
    });

    it('parses ("gtk", "2466") (alias + bare PR)', () => {
      expect(parseInput('gtk', '2466')).toEqual({
        kind: 'pr',
        repo: GL('gitlab.gnome.org', 'GNOME/gtk'),
        number: 2466,
      });
    });
  });

  describe('rejection', () => {
    it('unknown alias + SHA throws InvalidInputError (not BareShaError)', () => {
      expect(() => parseInput('totallyfake 8c0ef808')).toThrow(InvalidInputError);
    });

    it('alias alone throws InvalidInputError (no SHA/PR context)', () => {
      expect(() => parseInput('gtk')).toThrow(InvalidInputError);
    });

    it('alias + non-classifiable token throws InvalidInputError', () => {
      expect(() => parseInput('gtk hello')).toThrow(InvalidInputError);
    });

    it('bare SHA alone still throws BareShaError (existing behavior unchanged)', () => {
      expect(() => parseInput('8c0ef808ea')).toThrow(BareShaError);
    });

    it('bare PR number alone still throws InvalidInputError (no repo context)', () => {
      expect(() => parseInput('2466')).toThrow(InvalidInputError);
    });
  });

  describe('aliases via opts.aliases override', () => {
    it('accepts a custom alias catalog instead of KNOWN_PROJECTS', () => {
      const customAliases = [
        {
          alias: 'myproj',
          displayName: 'MyProj',
          host: 'github.com',
          projectPath: 'me/myproj',
        },
      ];
      expect(parseInput('myproj abc1234', undefined, { aliases: customAliases })).toEqual({
        kind: 'commit',
        repo: GH('me/myproj'),
        sha: 'abc1234',
      });
    });

    it('custom catalog supplants the default (gtk no longer resolves)', () => {
      // Empty catalog means alias resolution finds nothing — alias path falls through.
      expect(() => parseInput('gtk 8c0ef808ea', undefined, { aliases: [] })).toThrow(
        InvalidInputError,
      );
    });
  });
});
