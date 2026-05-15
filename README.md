# released

Find the first release containing a git commit.

Paste a commit SHA, a merged PR number, or a GitHub commit URL — get back the
first release tag that contains it, plus a copy-pasteable permalink for Slack,
GitHub PR comments, or just a plain link.

- **Web**: <https://released.blabberate.com>
- **CLI**: `npx released github.com/facebook/react/commit/a1b2c3d` (or `git released a1b2c3d`)

## Packages

This is a pnpm monorepo with four packages:

| Package | What | Where |
|---|---|---|
| `@released/core` | Pure-TS library: algorithm, GitHub client, sanitizer, parser. Web Platform APIs only — runs in Node 20+ and Cloudflare Workers unchanged. | `packages/core/` |
| `released` | Node CLI (`released` + `git-released` bin aliases). | `packages/cli/` |
| `@released/web` | Cloudflare Worker — homepage + permalink page + JSON API. | `packages/web/` |
| `@released/web-og` | Cloudflare Worker — OG-image PNG renderer (isolated bundle weight). Service Binding to `@released/web`. | `packages/web-og/` |

## Development

```bash
pnpm install
pnpm -r test          # 70+ tests across packages
pnpm -r typecheck
pnpm -r build
```

Per-package dev:

```bash
pnpm --filter @released/web dev          # wrangler dev for web
pnpm --filter @released/web-og dev       # wrangler dev for web-og
pnpm --filter released dev -- <input>    # tsx-run the CLI in place
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

`.github/workflows/release.yml` runs the above sequence automatically on push
to `main` after the Changesets "Version Packages" PR is merged. Required
secrets:

- `NPM_TOKEN` — npm publish access for the CLI
- `CLOUDFLARE_API_TOKEN` — Workers deploy
- `CLOUDFLARE_ACCOUNT_ID`
- (per-Worker secrets above must already be set via `wrangler secret put`)

## Architecture

```
packages/core   (pure TS — runs in Node + Workers)
   │
   ├─► packages/cli       (Node CLI; auth = --token | GITHUB_TOKEN | gh auth)
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
