---
"git-released": minor
"@released/core": minor
---

First public release of the CLI (`git-released` on npm) and `@released/core` library.

- `git-released` — `npx git-released <commit-or-pr-url>` or `git released <sha>` to find the first release tag containing a commit. GitHub plus a curated list of GitLab instances. (Published under `git-released` because unscoped `released` on npm was taken by an unrelated 2014 package.)
- `@released/core` — pure-TypeScript algorithm + providers, Web Platform APIs only. Runs unchanged in Node 20+ and Cloudflare Workers.
