---
"git-released": patch
---

Resolve releases whose first containing tag falls outside the fetched tag-list
window (very old commits / maintenance-branch fixes were mis-reported as "not yet
released" or with a too-late first release). Harden the tag-date backfill with
bounded concurrency so one failing tag never sinks the whole lookup. "Not yet
released" output no longer claims the commit is "on the default branch" (never
verified, and wrong for maintenance-branch commits). Parser now reports a
supported host with an unreadable URL shape as invalid input rather than a
self-contradictory "unrecognized host".
