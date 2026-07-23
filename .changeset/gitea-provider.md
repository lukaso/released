---
"git-released": minor
---

Look up commits on Gitea and Forgejo. Paste a commit, pull, or issue URL from a
known Gitea/Forgejo host (`gitea.com`, `codeberg.org`) and git-released finds the
first release containing it, the same way it does for GitHub and GitLab. Forgejo
shares the Gitea API, so one provider covers both. Self-hosted instances can be
added via the `extraGiteaHosts` option on `providerFor`.
