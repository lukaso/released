---
"git-released": patch
---

Scope the generic `GITLAB_TOKEN` to gitlab.com only. A gitlab.com PAT is no
longer sent to other GitLab instances (e.g. `gitlab.gnome.org`), which
previously caused 401s and transmitted the token to third-party hosts. Hosts
without a matching `GITLAB_TOKEN_<HOST>` var now fall back to `glab`/anonymous.
