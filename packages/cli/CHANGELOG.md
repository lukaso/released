# git-released

## 0.1.4

### Patch Changes

- c904325: Scope the generic `GITLAB_TOKEN` to gitlab.com only. A gitlab.com PAT is no
  longer sent to other GitLab instances (e.g. `gitlab.gnome.org`), which
  previously caused 401s and transmitted the token to third-party hosts. Hosts
  without a matching `GITLAB_TOKEN_<HOST>` var now fall back to `glab`/anonymous.

## 0.1.3

### Patch Changes

- d8d0b3f: Clearer CLI errors for unmerged pull/merge requests. The message now uses the host's own vocabulary — `Merge request !2466` on GitLab, `Pull request #123` on GitHub — instead of always saying "PR #". It also distinguishes a request that was **closed without merging** ("was closed without being merged") from one that's still **open** ("has not been merged yet"), so a closed GitLab MR no longer reads as if it might merge later. (#11)

## 0.1.2

### Patch Changes

- 4f6c274: Smoke-test release to validate the OIDC Trusted Publishing path end-to-end (CI publish via short-lived npm token + provenance attestation), now that npmjs.com → git-released has a Trusted Publisher rule for `lukaso/released` → `release.yml`.

  CLI functionality identical to 0.1.1.

## 0.1.1

First working public release of the `git-released` CLI on npm.

`npx git-released <commit-or-pr-url>` or `git released <sha>` to find the first release tag containing a commit. Supports GitHub plus a curated list of GitLab instances (gitlab.com, gitlab.gnome.org, gitlab.freedesktop.org, salsa.debian.org, invent.kde.org, gitlab.kitware.com).

The algorithm + provider code from `@released/core` is bundled into the CLI tarball — there is no separately-installable `@released/core` on npm. (Published under `git-released` because the unscoped `released` name on npm was taken by an unrelated 2014 package; the `@released` npm scope is squatted, so bundling was the cleanest path.)

## 0.1.0

Deprecated. Published with an unresolvable `@released/core` runtime dependency that prevented end-user installation. Replaced by 0.1.1.
