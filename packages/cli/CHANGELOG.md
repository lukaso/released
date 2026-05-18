# git-released

## 0.1.0

### Minor Changes

- c937bed: First public release of the `git-released` CLI on npm.

  `npx git-released <commit-or-pr-url>` or `git released <sha>` to find the first release tag containing a commit. Supports GitHub and a curated list of GitLab instances.

  (Published under `git-released` because unscoped `released` on npm was taken by an unrelated 2014 package. The algorithm + provider code from `@released/core` is bundled into the CLI tarball — there is no separately-installable `@released/core` on npm.)
