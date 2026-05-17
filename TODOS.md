# TODOS

Captured during the federation PR (added GitLab support to the previously
GitHub-only `released` tool). These are intentionally deferred — see the
plan at `~/.claude/plans/federated-finding-dragon.md` for full context.

## Deferred from federation

1. **GitLab `/refs?type=tag` algorithm shortcut.** GitLab's REST API has a
   direct "which tags contain this commit?" endpoint
   (`GET /projects/:id/repository/commits/:sha/refs?type=tag`) that GitHub
   doesn't expose. For GitLab providers, this collapses the algorithm to ONE
   call instead of `log(n)` compareCommits round trips. Estimated win for
   `GNOME/gimp` lookups: ~3-4s of TTI per query. Needs a new optional
   `Provider.containingTags(repo, sha) → string[] | null` method; the
   algorithm in `find-release.ts` opts in when present.

2. **Auto-discovery of unknown GitLab hosts via `/api/v4/version` probe.**
   Today the allowlist is the only way to recognize a GitLab instance
   (extensible at runtime via `EXTRA_GITLAB_HOSTS` env / `extraGitlabHosts`
   option). A `/api/v4/version` probe (cached 24h per host) would let any
   GitLab Just Work. Tradeoff: adds probe latency on first hit of an
   unknown host, plus failure modes (probe timeout, false-positives from
   non-GitLab software returning JSON). Worth doing once there's signal
   that users want it.

3. **Bitbucket / Gitea / Forgejo / Sourcehut providers.** The `Provider`
   interface in `packages/core/src/provider.ts` was designed to fit these
   — five methods + url builders + display terms. Adding a new provider
   is ~150 LOC. Order by demand.

4. **Per-host PAT in the web UI.** Today web users supply a token via
   `X-User-Github-Token` / `X-User-Gitlab-Token` headers. A UI for entering
   and storing tokens per host (localStorage or cookies) would let users
   hit private projects on self-hosted instances.

5. **Cache-warming script for top GitHub repos after `CACHE_NS` bump.**
   The federation PR bumped `CACHE_NS` from v1 to v2, invalidating the
   existing cache. A pre-deploy worker script could warm the top ~100 repos
   so users don't see a brief P50 latency regression on day 1. Optional polish.

6. **Federated OG image rendering.** `packages/web-og/` currently serves
   `/r/:owner/:repo/c/:sha.png` (GitHub-only path scheme). For GitLab
   results, `og-meta.tsx` falls back to a placeholder image. Adding
   `/h/:host/r/:projectPath/c/:sha.png` to the OG worker + provider routing
   would give GitLab unfurls a rich preview too.

7. **PrNotMerged copy uses GitHub vocabulary.** `errors.ts` `PrNotMergedError`
   messages always say "PR #N" — for GitLab MRs that reads slightly off
   ("PR #2466 has not been merged yet" when the user pasted a GitLab MR URL).
   Either plumb provider.terms into error construction or have the UI
   re-translate the message. Cosmetic.

8. **DESIGN.md / `/design-consultation`.** Pre-existing gap: no DESIGN.md
   exists. Federation didn't fix it. Worth running `/design-consultation`
   to formalize the design system that the UI already implements implicitly.

9. **Bulk `partial` aggregation across hosts.** `/api/lookup-bulk` now runs
   one `findReleasesBulk` per host group (so each gets the right provider).
   Pre-refactor it returned a single `partial` if any sub-call timed out;
   post-refactor a partial from one host group isn't merged with another.
   Multi-host bulk + timeout is a narrow case but the response shape should
   still report it. Fix: collect each subBulk.partial and surface the most
   severe ("rate_limit_exhausted" > "bulk_deadline" > "network_error").

10. **CLI `--strict` flag swallowed by `tsx` argv handling.** `pnpm --filter
   released dev 'https://gitlab.gnome.org/.../-/merge_requests/7' --strict`
   ate the `--strict` flag (treated as a pnpm option). Workaround:
   `pnpm --filter released exec tsx src/cli.ts URL --strict`. Not a
   federation regression — pre-existing — but the README example should
   document the workaround or the bin should be invoked differently.

11. **`internal.ts` is still GitHub-only.** Service Binding endpoint for
   web-og. When federated OG image rendering (TODO #6) lands, add the
   parallel `/internal/h/:host/r/:projectPath/:sha` route. Today only
   GitHub OG images exist, so this is fine.
