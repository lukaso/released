---
"git-released": patch
---

Clearer CLI errors for unmerged pull/merge requests. The message now uses the host's own vocabulary — `Merge request !2466` on GitLab, `Pull request #123` on GitHub — instead of always saying "PR #". It also distinguishes a request that was **closed without merging** ("was closed without being merged") from one that's still **open** ("has not been merged yet"), so a closed GitLab MR no longer reads as if it might merge later. (#11)
