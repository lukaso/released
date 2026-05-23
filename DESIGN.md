# Design System — released

This is a documentation pass over a design system that is already locked in
code. The source of truth is `packages/web/src/ui/styles.ts` (the inline
CSS that ships in every HTML response). If this file disagrees with that one,
trust `styles.ts` and update this file.

The system was iterated through D27→D34 during the homepage and result-card
build-out and has shipped in production at <https://released.blabberate.com>.
Do not change tokens here without a corresponding change in `styles.ts`.

## Product Context

- **What this is:** *released* answers a single question — "which release first
  contains this commit?" — for a SHA, merged PR/MR, or commit URL, on GitHub
  and a curated set of GitLab hosts.
- **Who it's for:** Engineers, release managers, support staff, and anyone
  triaging "is this fix out yet?" The audience is comfortable with monospace
  SHAs, terminal vocabulary, and dark interfaces.
- **Space / industry:** Developer tooling. Adjacent to Linear, Vercel, Resend,
  Railway, GitHub itself — the modern dev-tool aesthetic.
- **Project type:** Hybrid — a tiny single-purpose web app (one input, one
  result card) plus a CLI. The web app is the visual surface this doc covers.

## Aesthetic Direction

- **Direction:** Dark dev-tool. Near-black canvas, 1px borders, restrained
  blue accent, monospace where data is data.
- **Decoration level:** Minimal. Typography and a 5-token color palette do all
  the work. No gradients, no shadows, no illustrations, no patterns.
- **Mood:** Quiet, precise, terminal-adjacent. The product should feel like a
  good `git` subcommand with a web frontend, not a SaaS marketing page.
- **Memorable thing:** The hero result — a 52px Geist Mono version tag next to
  a small green `SHIPPED` chip — is the only visual flourish on the page.
  Everything else gets out of its way.

## Typography

Both faces are self-hosted under `/fonts/` via Workers Assets — no
googleapis.com / gstatic.com preconnects, so visitor IPs stay on the edge.
Each face is a single variable woff2 covering weights 100–900, declared once
and used at the weights below. `font-display: swap` renders the system
fallback during load.

- **Body / UI:** `Geist`, sans-serif. 15px / 1.55 line-height. Weights used in
  the wild: 400 (body), 500 (labels, secondary buttons), 600 (wordmark,
  primary button, headings).
- **Display:** Same `Geist`. Headline is 30px / 600 / `-.02em` tracking, line
  1.18.
- **Mono (data):** `Geist Mono`. Used wherever the content is literal data:
  search input, hero version tag, permalink, also-in chips, command examples,
  release-notes `<code>`.
- **Hero version tag:** `Geist Mono` 52px / 600 / `-.02em` / line 1. The
  single largest piece of type on the page.
- **Label style:** 12px / 500 / `var(--text-3)` / `text-transform: uppercase`
  / `letter-spacing: .05em`. Used for "First released in", "Copy", "Release
  notes", chip section headers.

### Scale (observed in `styles.ts`)

| Role                       | Size       | Weight | Tracking | Notes                          |
|----------------------------|------------|--------|----------|--------------------------------|
| Hero version (`.v`)        | 52px       | 600    | -.02em   | Geist Mono, line 1             |
| Headline                   | 30px       | 600    | -.02em   | Geist Sans, line 1.18          |
| Wordmark                   | 16px       | 600    | -.01em   |                                |
| Body                       | 15px       | 400    | —        | line 1.55                      |
| Orient / answer-date       | 15px       | 400    | —        | `--text-2`                     |
| Searchbox input            | 14px       | 400    | —        | Geist Mono                     |
| Searchbox button           | 14px       | 600    | —        |                                |
| Section labels             | 11.5–12px  | 500    | .05em    | uppercase, `--text-3`          |
| Notes body                 | 14px       | 400    | —        | inside `.notes-html`           |
| Mono chips / meta          | 11.5–13px  | 400–600| —        | `.v-chip`, `.perma`, `.repo`   |
| Nav links                  | 13.5px     | 400    | —        | `--text-2`                     |
| Footer links               | 13px       | 400    | —        | `--text-3`                     |
| Mobile hero version        | 36px       | 600    | -.02em   | `@media (max-width: 600px)`    |

## Color

- **Approach:** Restrained. Five tokens carry meaning; everything else is
  neutral. Color is used semantically — never decoratively.
- **Mode:** Dark-only. There is no light theme and no toggle. The product is
  a tool engineers use alongside their terminal and code editor; dark is the
  expected environment.

### Tokens (`:root` in `styles.ts`)

| Token              | Hex       | Role                                              |
|--------------------|-----------|---------------------------------------------------|
| `--bg`             | `#0a0a0a` | Page background. Near-black, not pure black.      |
| `--bg-raised`      | `#111111` | Cards, inputs, raised surfaces.                   |
| `--bg-hover`       | `#1a1a1a` | Chip hover, button hover.                         |
| `--text`           | `#ededed` | Primary body text.                                |
| `--text-2`         | `#a1a1a1` | Secondary text, captions, link rest.              |
| `--text-3`         | `#8a8a8a` | Tertiary / muted — labels, metadata, footer. Meets WCAG AA on `--bg`. |
| `--border`         | `#262626` | Default 1px borders.                              |
| `--border-bright`  | `#383838` | Border on hover / focus / inputs.                 |
| `--white`          | `#fafafa` | Primary CTA background. Reads as pure white.      |
| `--accent`         | `#52a8ff` | Blue accent. Wordmark dot, focus ring, links.     |
| `--ship`           | `#3fb950` | Semantic green — "SHIPPED", ship-dot indicator.   |
| `--ship-dim`       | `#1a3a22` | Background for the `SHIPPED` chip.                |
| `--warn`           | `#d29922` | Semantic gold — `EXAMPLE` tag, hints, warnings.   |
| `--warn-dim`       | `#3a2f15` | Border for warning banners.                       |
| `--example-tint`   | `#16151a` | Background for the dashed-border EXAMPLE card.    |

### Semantic usage rules

- **Blue (`--accent`)** is for interactivity: focus rings, the wordmark dot,
  inline link colors inside release-notes content, and the hover underline on
  the hero version link. Never for status.
- **Green (`--ship`)** is for "this thing shipped." Only used on the
  `SHIPPED` chip and the small `.ship-dot` next to the "First released in"
  label. Never as a generic success color.
- **Gold (`--warn`)** is for "you should pay attention" — the `EXAMPLE` tag
  on the homepage, partial-result and prerelease banners, the "Not yet
  released" status. Never as a brand color.
- **White (`--white`)** is the primary CTA background and is reserved for
  exactly one button per surface (the search submit, the primary copy
  button). Black text on white. Demands attention.

## Spacing & Layout

- **Wrap:** `.wrap { max-width: 660px; margin: 0 auto; padding: 0 24px; }`.
  The whole site is a 660px column. No multi-column layouts anywhere.
- **Spacing scale (observed, not normalized):** The code uses a free 2 / 4 /
  6 / 7 / 8 / 10 / 12 / 14 / 16 / 18 / 20 / 22 / 24 / 28 / 32 / 40 / 48 step
  range. Most spacing lands on multiples of 4 with occasional half-steps for
  optical alignment. There is no `--space-*` token system; values live
  inline in `styles.ts`. Match neighbors when adding new components.
- **Border radius scale:** `3px` (small tags) · `4px` (chips, code) · `5px`
  (ship chip) · `6px` (buttons, chips, command box) · `8px` (searchbox,
  banners) · `10px` (answer card). No bubble/pill radii.
- **Borders:** Always 1px. `var(--border)` at rest, `var(--border-bright)` on
  hover/focus. Dashed for the homepage EXAMPLE card; otherwise solid.

## Components (concrete patterns in code)

- **Searchbox** (`.searchbox`) — raised surface with bright border, focus
  ring is 3px `rgba(82,168,255,.15)` plus border swap to `--accent`. White
  primary button inline-right on desktop, stacks below on mobile.
- **Answer card** (`.answer`) — raised surface, 10px radius, 1px border.
  Hero section + meta footer + optional release-notes + optional "also in"
  chip row, each separated by a 1px top border.
- **EXAMPLE variant** (`.answer.example`) — same card, dashed bright border,
  `--example-tint` background, gold `EXAMPLE` tag above. Distinguishes the
  homepage demo from a real result.
- **Chip row** (`.projects-row`, `.alsoin .versions`) — raised chips, 6px
  radius, hover lifts to `--bg-hover` and bright border. Used for popular
  projects on the homepage and "also contained in" tags on the result.
- **Buttons** — three classes: `.searchbox button` (primary white CTA),
  `.btn-fmt.primary` (white CTA inside the card), `.btn-fmt` (ghost with
  bright border). No third tier.

## Motion

- **Approach:** Minimal-functional. Motion only when it aids comprehension.
- **Durations:** `0.12s` on chip hover transitions, `1.4s` on the
  "Looking up…" loading-state dot animation.
- **Easings:** `ease` for hover swaps. Steps function (`steps(4, end)`) for
  the loading dots — the discrete tick reads as deliberate.
- **Loading state** is a CSS-only label swap inside the submit button (no
  spinner SVG): the button stays white, copy changes to "Looking up…" with
  animated dots, input fades to `--text-2`. The browser then continues the
  full-page navigation; the old page stays painted until the new one is
  ready, which is the desired wait-scroller UX on cold lookups (4–10s).

## Mobile

Single `@media (max-width: 600px)` breakpoint in `styles.ts`:

- Searchbox stacks vertically (input above, full-width button below at 13px
  padding).
- Hero version drops from 52px to 36px.
- Project chips grow to ~40px tap targets (10/14 padding, 13.5px font, 8px
  gap).

The 660px wrap and 24px gutters mean the desktop layout already collapses
gracefully at most widths; the breakpoint is the small handful of
sub-component tweaks above.

## Fonts: serving + privacy

- Both Geist and Geist Mono are served from `/fonts/` on the worker (Workers
  Assets), not Google Fonts. Visitor IPs do not leave the Cloudflare edge.
- The HTML head preloads both woff2 files with `crossorigin=""` so the
  variable fonts arrive before first paint.
- No third-party `<link rel="preconnect">` to `fonts.googleapis.com` or
  `fonts.gstatic.com` — see `packages/web/src/ui/layout.tsx`.

## Accessibility

- Focus rings: `.searchbox:focus-within` gets a 3px translucent blue glow
  plus a bright border. `.project-chip:focus-visible` gets a 2px solid blue
  outline with 2px offset.
- Link colors on dark surfaces are always explicit. Browser-default
  `#0000EE` / `#551A8B` visited-purple are unreadable on `--bg-raised` — see
  the `.answer-meta a`, `.sec-label a`, and `a.v` rules.
- Tap targets on mobile are ≥ ~40px (project chips).
- Color contrast: all text meets **WCAG AA** on its surface. `--text-3`
  (`#8a8a8a`) is the muted floor — still clearly tertiary, but ≥ 4.5:1 on
  `--bg` / `--bg-raised` / the example tint. Keep new muted text at `--text-3`
  or lighter; don't reintroduce a sub-AA gray.
- Automated guards: `packages/web/test/a11y.test.ts` runs axe (jsdom) for
  structural issues on every `pnpm test`; `a11y-contrast.test.ts` runs axe's
  color-contrast rule in headless chromium in CI as a **full WCAG AA gate**
  (with a positive control proving it catches a bare default-blue link).

## What this design is NOT

So the next designer / agent doesn't drift:

- Not light-mode capable. There is no light theme and no toggle.
- Not gradient-friendly. No gradient buttons, no gradient text, no purple
  hero. The accent is a single flat blue.
- Not icon-heavy. The only "icons" are a 7px wordmark dot and a 6px ship
  dot — both CSS shapes, no SVG sprite.
- Not multi-column. Everything lives inside a 660px column.
- Not animated. Hover transitions and the loading-dot keyframes are the
  full motion budget.
- Not a marketing site. There is no hero illustration, no testimonial
  block, no feature grid.

## Decisions log

| Date       | Decision                                              | Rationale                                                     |
|------------|-------------------------------------------------------|---------------------------------------------------------------|
| D27→D34    | Locked dark dev-tool aesthetic, Geist + Geist Mono    | Iterated across early homepage builds; settled on this combo. |
| Federation | Self-host fonts under `/fonts/` instead of Google CDN | Keep visitor IPs on the Cloudflare edge.                      |
| 2026-05-18 | First written DESIGN.md (resolves issue #14)          | Formalize the system already locked in `styles.ts`.           |

## See also

- `packages/web/src/ui/styles.ts` — source of truth for every token above.
- `packages/web/src/ui/layout.tsx` — HTML shell, font preloads, CSP/nonce.
- `packages/web/src/ui/result-card.tsx` — the hero component this system was
  built around.
- <https://released.blabberate.com> — the live preview. Everything in this
  doc is shipped there.
