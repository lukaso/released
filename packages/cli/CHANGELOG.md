# git-released

## 0.1.1

First working public release of the `git-released` CLI on npm.

`npx git-released <commit-or-pr-url>` or `git released <sha>` to find the first release tag containing a commit. Supports GitHub plus a curated list of GitLab instances (gitlab.com, gitlab.gnome.org, gitlab.freedesktop.org, salsa.debian.org, invent.kde.org, gitlab.kitware.com).

The algorithm + provider code from `@released/core` is bundled into the CLI tarball — there is no separately-installable `@released/core` on npm. (Published under `git-released` because the unscoped `released` name on npm was taken by an unrelated 2014 package; the `@released` npm scope is squatted, so bundling was the cleanest path.)

## 0.1.0

Deprecated. Published with an unresolvable `@released/core` runtime dependency that prevented end-user installation. Replaced by 0.1.1.
