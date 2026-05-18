# released

Find the first release containing a git commit.

Paste a commit SHA, a merged PR/MR number, or a commit URL — get back the
first release tag that contains it, plus a copy-pasteable permalink for Slack,
PR/MR comments, or just a plain link.

**Supported hosts:** GitHub plus a curated list of GitLab instances (gitlab.com,
gitlab.gnome.org, gitlab.freedesktop.org, salsa.debian.org, invent.kde.org,
gitlab.kitware.com). Self-hosted GitLab instances can be added via
`EXTRA_GITLAB_HOSTS` env var (Worker) or `--gitlab-host` flag (CLI).

- **Web**: <https://released.blabberate.com>
- **CLI** (published on npm as `git-released` — `released` was taken):
  - `npx git-released github.com/facebook/react/commit/a1b2c3d`
  - `npx git-released https://gitlab.gnome.org/GNOME/gimp/-/merge_requests/2466`
  - or `git released a1b2c3d` for the current repo (uses the `git-released` bin)

## Packages

This is a pnpm monorepo with four packages:

| Package | What | Where |
|---|---|---|
| `@released/core` | Pure-TS library: algorithm, GitHub + GitLab providers, sanitizer, parser. Web Platform APIs only — runs in Node 20+ and Cloudflare Workers unchanged. | `packages/core/` |
| `git-released` | Node CLI (installs `git-released` + `released` bin aliases). Published as `git-released` because the unscoped `released` name was taken on npm. | `packages/cli/` |
| `@released/web` | Cloudflare Worker — homepage + permalink page + JSON API. | `packages/web/` |
| `@released/web-og` | Cloudflare Worker — OG-image PNG renderer (isolated bundle weight). Service Binding to `@released/web`. | `packages/web-og/` |

## Development

```bash
pnpm install
pnpm -r test          # 180+ tests across packages
pnpm -r typecheck
pnpm -r build
```

Per-package dev:

```bash
pnpm --filter @released/web dev          # wrangler dev for web
pnpm --filter @released/web-og dev       # wrangler dev for web-og
pnpm --filter git-released dev -- <input>    # tsx-run the CLI in place
```

## Deploy (Cloudflare Workers)

Order matters — `web-og` has a Service Binding to `web`, so `web` deploys first.

### One-time setup

1. **GitHub token** for the web Worker (gives the shared anonymous fast path
   5000 req/hr instead of 60):

   ```bash
   cd packages/web
   wrangler secret put GITHUB_TOKEN
   ```

   For GitLab — anonymous calls from Workers exhaust the edge IP's shared
   budget almost immediately, so a token is effectively required for
   federation:

   ```bash
   # gitlab.com (most common case):
   cd packages/web && wrangler secret put GITLAB_TOKEN

   # Per-host PAT for a specific self-hosted instance. Name is uppercased
   # with `.` and `-` → `_`. Example for gitlab.gnome.org:
   wrangler secret put GITLAB_TOKEN_GITLAB_GNOME_ORG

   # To extend the known-hosts allowlist (so users can paste URLs from
   # additional self-hosted instances), set the env var in wrangler.toml:
   #   EXTRA_GITLAB_HOSTS = "git.example.com,gitlab.acme.net"
   ```

2. **Internal secret** shared between `web` and `web-og` (used by `web` to
   reject direct public hits to `/internal/result/*` and only accept calls
   coming through the Service Binding):

   ```bash
   cd packages/web && wrangler secret put INTERNAL_SECRET
   cd packages/web-og && wrangler secret put INTERNAL_SECRET   # same value
   ```

3. **Rate-limiting rule** in the Cloudflare dashboard (D13). Documented here so
   it's reproducible — Cloudflare doesn't yet expose this as wrangler config:

   - Zone → **Security → WAF → Rate limiting rules → Create rule**
   - Name: `released-api-per-ip`
   - Match: `(http.request.uri.path matches "^/api/lookup")`
   - Counting: by source IP
   - Rate: **60 requests per 1 minute**
   - Action: Block, with 1-minute timeout
   - Response: 429 with JSON `{"error":"rate_limited"}`

### Deploy

```bash
# Web first (web-og depends on the service binding existing):
pnpm --filter @released/web deploy
pnpm --filter @released/web-og deploy
```

### CI/CD

`.github/workflows/release.yml` runs on every push to `main`. Depending on
repo state, the Changesets step does one of:

- **Pending changeset(s) in `.changeset/`**: opens or force-pushes a "Version
  Packages" PR (`changeset-release/main` → `main`) that bumps versions,
  writes CHANGELOGs, and deletes the consumed changeset files.
- **No pending changesets + a version-bump commit just landed** (i.e., you
  just merged the "Version Packages" PR): runs `pnpm run release` (=
  `pnpm -r build && changeset publish`), which publishes `git-released` to
  npm via OIDC Trusted Publishing.

After either path, the workflow deploys the Cloudflare Workers (`web` first
— `web-og` has a Service Binding to it).

Required GitHub repo configuration:

- **Repo secrets**:
  - `CLOUDFLARE_API_TOKEN` — Workers deploy
  - `CLOUDFLARE_ACCOUNT_ID`
- **Repo settings** (Settings → Actions → General → Workflow permissions):
  - "Allow GitHub Actions to create and approve pull requests" enabled
    (the Changesets action needs this to open the Version Packages PR)
- **npm side** (one-time per published package, at
  `npmjs.com/package/git-released/access` → Trusted Publisher):
  - Repository: `lukaso/released`, Workflow: `release.yml`, Environment: blank
- Per-Worker secrets (`GITHUB_TOKEN`, `GITLAB_TOKEN`, `INTERNAL_SECRET`, etc.)
  must already be set via `wrangler secret put` — see the one-time setup above.

No `NPM_TOKEN` secret is needed — the `id-token: write` permission in
`release.yml` plus the npm-side Trusted Publisher rule above lets the
workflow exchange a GitHub OIDC token for a short-lived npm publish token
at publish time, with a signed provenance attestation attached.

### Releasing the CLI

The CLI (`git-released` on npm) ships via [Changesets](https://github.com/changesets/changesets).
No manual `npm publish` step — the only thing you do by hand is write a
changeset file and merge a PR.

1. **Make your code change** on a feature branch as normal.

2. **Add a changeset** describing what you shipped:

   ```bash
   pnpm changeset
   ```

   This is an interactive prompt:

   - **Which packages?** Only `git-released` is selectable. The internal
     packages (`@released/core`, `@released/web`, `@released/web-og`) are
     in the `ignore` list in `.changeset/config.json` and don't appear.
     `@released/core` is bundled into the CLI tarball at build time and
     is not separately published.
   - **Which type of bump?** Pick by what your change does to users:

     | Bump  | When                                                                 | Example: from `0.1.1` to… |
     |-------|----------------------------------------------------------------------|----------------------------|
     | patch | Bug fix, perf improvement, doc fix, internal refactor. No new flags, no behavior change for existing inputs. | `0.1.2` |
     | minor | New feature or flag, new supported host, new output format. No breaking changes to existing usage. | `0.2.0` |
     | major | Breaking change: removed/renamed flag, changed default behavior, dropped a Node version, changed CLI exit-code semantics, removed a previously-exported function from the bundled library. | `1.0.0` |

     **Pre-1.0 caveat**: while the CLI is `0.x`, you can also fold
     breaking changes into a minor bump (`0.1.x → 0.2.0`) rather than
     going to `1.0.0` — that's the conventional escape hatch for
     unstable APIs. Use `major` (→ `1.0.0`) only when you're consciously
     declaring stability and the bump signals "this is the API now."

   - **Summary**: one or two sentences that will land verbatim in
     `packages/cli/CHANGELOG.md`. Write it for the person who'll grep
     the changelog six months from now: lead with the user-visible
     effect, not the implementation detail.

   Commit the generated `.changeset/<random-name>.md` file alongside
   your code change. You can hand-edit or delete this file freely before
   pushing — it's just markdown with YAML frontmatter, no magic.

   **Stacking multiple changesets** is fine: run `pnpm changeset` once
   per logical change before pushing. When the Version Packages PR
   opens, it sums them — the highest bump type wins (one `minor` + two
   `patch` → minor bump), and all summaries land in the CHANGELOG under
   the new version header.

3. **Merge your change to `main`**. The `release.yml` workflow opens (or
   updates) a "chore(release): version packages" PR with the version bump
   + CHANGELOG entry.

4. **Review and merge that auto-PR**. The next `release.yml` run publishes
   to npm. You can watch the "Create release PR or publish CLI to npm"
   step in the workflow for the `+ git-released@<version>` line.

**To verify a release after CI publishes**:

```bash
npm view git-released versions --json | tail -5
npx --yes git-released github.com/facebook/react/commit/a1b2c3d
```

**To deprecate a published version** (e.g., a broken release):

```bash
npm deprecate "git-released@<version>" "reason / what to use instead"
```

Versions cannot be republished after `npm unpublish` — npm permanently
retires version numbers — so deprecation is almost always the right move
for shipping a fix, paired with bumping to the next patch.

## Architecture

```
packages/core   (pure TS — runs in Node + Workers)
   │
   ├─► packages/cli       (Node CLI; GitHub auth = --token | GITHUB_TOKEN | gh auth,
   │                       GitLab auth = --token | GITLAB_TOKEN[_<HOST>] | glab auth)
   │
   └─► packages/web       (Cloudflare Worker — homepage, /r/:o/:r/c/:sha, /api/*)
                  │
                  └── service binding ──► packages/web-og   (PNG renderer, isolated bundle)
```

**Algorithm** (in `packages/core/src/find-release.ts`):

1. Resolve PR → merge commit, or validate the commit SHA.
2. List all repo tags via GitHub GraphQL (paginated). Per-tag, use the best
   available date: GitHub Release `published_at` if any, else annotated tag
   tagger date, else the tagged commit's committer date.
3. **Sort by date ascending — NOT filter.** Git dates aren't reliably
   monotonic with topology (clock skew, manually-set dates, cherry-picks);
   filtering on date would silently drop containing tags. Date is ordering
   only; ancestry is the sole containment test.
4. Check `/compare/{tag}...{commit}` for each tag in date order, in parallel
   batches of 5, stop at the first hit. Honor soft + hard deadlines (defaults
   20s / 25s); soft → partial state, hard → `LookupTimeoutError`.
5. Build "also in" list from the next ~5 newer tags.
6. Fetch + sanitize the GitHub Release notes (via `micromark` safe profile,
   then attribute scrub for `javascript:`/`vbscript:`/`data:text/html` URIs).

## License

MIT.
