---
"git-released": minor
---

Resolve an issue to its fixing release. Paste a GitHub issue URL (`/issues/N`)
or GitLab issue URL (`/-/issues/N`) and git-released finds the merged PR that
closed it, then reports the first release containing that fix. It's the same
answer you'd get from the fixing commit or PR. An issue with no merged fix yet
(still open, or closed without one) exits non-zero, like a commit that isn't in
a release.
