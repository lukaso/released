#!/usr/bin/env bash
# prod-wrangler.sh — read-only wrangler wrapper for the maintaining loop's
# production senses (Live App Contract). The loop's `observe.sh` invokes this as
# the `LIVEAPP_WRANGLER` command — by default `$APP_DIR/scripts/prod-wrangler.sh`
# — calling it as `prod-wrangler.sh deployments list` and
# `prod-wrangler.sh tail --format json` to pull deploy history and a bounded log
# tail from the live Worker. Without this file those senses error out and
# production is invisible to the loop.
#
# Hard safety boundary: this wrapper ONLY runs read-only wrangler subcommands.
# Anything that could deploy, roll back, mutate state, or read/write secrets is
# refused (exit 2) — even though the local OAuth token carries write scope. The
# loop is read-only against production and CI owns deploys (push-to-main); see
# CLAUDE.md "Secrets / deploy".
#
# Targets the primary `released-web` Worker by default (where lookups and errors
# happen). Point RELEASED_WRANGLER_DIR at another package to inspect a different
# Worker, e.g. RELEASED_WRANGLER_DIR=packages/web-og for the OG renderer.
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
WORKER_DIR="${RELEASED_WRANGLER_DIR:-$ROOT/packages/web}"
case "$WORKER_DIR" in
  /*) ;;                       # already absolute
  *)  WORKER_DIR="$ROOT/$WORKER_DIR" ;;
esac

if ! command -v wrangler >/dev/null 2>&1 && ! command -v npx >/dev/null 2>&1; then
  echo "prod-wrangler.sh: wrangler not available (install it or provide npx) — production senses unavailable." >&2
  exit 0
fi

# Read-only allowlist. The first argument is the wrangler subcommand; only these
# may run. Everything else — deploy, publish, secret, delete, rollback, kv/d1/r2
# writes, versions deploy/upload — is refused.
sub="${1:-}"
case "$sub" in
  tail|whoami)
    ;;
  deployments)
    # `deployments` has carried a mutating `rollback` sub-form in older wrangler
    # lines; permit only the read-only views (v4: list|status, v3: list|view) so
    # the boundary doesn't silently widen if a future version reintroduces one.
    case "${2:-}" in
      list|status|view) ;;
      *) echo "prod-wrangler.sh: refused 'deployments ${2:-}' — read-only wrapper allows only 'deployments list|status'." >&2; exit 2 ;;
    esac
    ;;
  versions)
    # `versions` also carries mutating forms (deploy/upload/secret); permit only
    # the read-only ones.
    case "${2:-}" in
      list|view) ;;
      *) echo "prod-wrangler.sh: refused 'versions ${2:-}' — read-only wrapper allows only 'versions list|view'." >&2; exit 2 ;;
    esac
    ;;
  "")
    echo "prod-wrangler.sh: no subcommand. Read-only; allows: deployments list|status, tail, versions list|view, whoami." >&2
    exit 2
    ;;
  *)
    echo "prod-wrangler.sh: refused '$sub' — read-only wrapper. Allowed: deployments list|status, tail, versions list|view, whoami." >&2
    exit 2
    ;;
esac

# Run from the Worker's config dir so wrangler resolves the right wrangler.toml
# (and thus the right Worker name) without needing an explicit --name.
cd "$WORKER_DIR" || { echo "prod-wrangler.sh: cannot cd to $WORKER_DIR" >&2; exit 1; }

if command -v wrangler >/dev/null 2>&1; then
  exec wrangler "$@"
else
  exec npx --no-install wrangler "$@"
fi
