---
"git-released": minor
---

Resolve an issue to its fixing release. Paste a GitHub or GitLab issue URL
(including GitLab `/-/work_items/N`) and git-released finds the merged PR that
closed it, then reports the first release containing that fix — the same answer
you'd get from the fixing commit or PR. An issue that's still open exits 1, the
same as an unmerged PR or a not-yet-released commit.
