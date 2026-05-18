# CLAUDE.md

Project-specific instructions for Claude Code. See `README.md` for the
human-facing overview.

## Project

`released` answers "which release first contains this commit?" for GitHub
and a curated set of GitLab hosts. It's a pnpm monorepo:

- `packages/core` — pure-TS algorithm + providers. Web Platform APIs only;
  runs in Node 20+ and Cloudflare Workers unchanged.
- `packages/cli` — Node CLI, published to npm as `git-released`.
- `packages/web` — Cloudflare Worker: homepage, permalink pages, JSON API.
- `packages/web-og` — Cloudflare Worker: OG-image PNG renderer. Service
  Binding to `web`.

Deploy order matters: `web` first, then `web-og` (the binding has to exist).

## Design system

Read `DESIGN.md` before making any visual or UI change. The source of truth
for tokens is `packages/web/src/ui/styles.ts` — `DESIGN.md` documents what
ships there. If you change a token in one, change it in both.

Specifics that come up often:
- Dark mode only. No light theme, no toggle.
- Geist + Geist Mono, self-hosted under `/fonts/`. Do not add Google Fonts
  preconnects — visitor IPs must stay on the edge.
- The `--accent` blue, `--ship` green, and `--warn` gold are semantic. Don't
  use them decoratively.
- Primary CTA = `--white` background. One per surface.

## Tests

```bash
pnpm -r test          # 180+ tests across packages
pnpm -r typecheck
pnpm -r build
```

Follow TDD: write a failing test before changing implementation behavior.
Pure refactors covered by existing tests are the exception — run them first
to confirm coverage.

## Algorithm guardrails

`packages/core/src/find-release.ts` is the heart of the product. Two rules
that have already cost us bugs:

- **Sort tags by date ascending; never *filter* by date.** Git dates aren't
  reliably monotonic with topology (clock skew, manual tag dates,
  cherry-picks). Date is ordering only; ancestry (`/compare`) is the sole
  containment test.
- **Partial state ≠ "not yet released."** A `partial` result from a soft
  deadline must surface a best-effort answer with a caveat, not the
  not-released UI. See `result-card.tsx`.

## Secrets / deploy

Per-Worker secrets are set via `wrangler secret put`; see README "One-time
setup". `web-og` and `web` share an `INTERNAL_SECRET` for the Service
Binding handshake — they must match.
