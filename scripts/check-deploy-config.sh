#!/usr/bin/env bash
# `pnpm check:deploy-config` — prove both Workers' deploy config actually builds.
#
# Neither Worker has a `build` script, so `pnpm -r build` never bundles them and
# nothing else in CI parses their wrangler.toml. A bad binding, a malformed
# [[durable_objects]] migration or a broken Dockerfile would otherwise first
# surface in the production deploy, after merge.
#
# Each Worker's `check:deploy-config` is `wrangler deploy --dry-run`: it bundles
# the Worker, parses wrangler.toml and BUILDS the container image, while
# contacting no Cloudflare API and deploying nothing.
#
# Workers are DISCOVERED (any package dir with a wrangler.toml), not listed, so
# a third Worker is covered the day it lands. Both the discovery and the script
# are asserted: `pnpm -r run <script>` exits 0 when NO package defines the
# script, so a rename or a dropped script would silently turn this gate into a
# no-op that stays green forever. That is the one failure mode a gate must not
# have, hence the explicit checks below.
#
# What it still cannot see: remote state. A [[migrations]] tag conflicting with
# what is already applied to released-web, web-og's [[services]] binding naming
# a Worker that does not exist, or a missing secret all need the real API.
#
# Strict by design, like check-publish.sh: any failure exits non-zero, and it
# does NOT skip when CI=true. Needs Docker (it builds the image); validate.sh
# skips it gracefully when Docker isn't running — CI is the authoritative gate.
#
# Bash 3.2 (macOS default): no arrays, no `${arr[@]}` under `set -u`.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

SCRIPT="check:deploy-config"
found=0
missing=""

for toml in packages/*/wrangler.toml; do
  [ -e "$toml" ] || continue
  pkg_dir=$(dirname "$toml")
  pkg_json="$pkg_dir/package.json"
  [ -f "$pkg_json" ] || continue
  found=$((found + 1))

  name=$(node -p "require('./$pkg_json').name")
  has=$(node -p "Boolean(require('./$pkg_json').scripts && require('./$pkg_json').scripts['$SCRIPT'])")
  if [ "$has" != "true" ]; then
    missing="$missing    - $name ($pkg_dir)
"
    continue
  fi

  echo "→ $name — wrangler dry run (bundle + config + container image)"
  pnpm --filter "$name" "$SCRIPT"
done

if [ "$found" -eq 0 ]; then
  echo "✗ no Workers found (no packages/*/wrangler.toml) — this gate would be a silent no-op." >&2
  exit 1
fi

if [ -n "$missing" ]; then
  echo "✗ Worker package(s) with a wrangler.toml but no '$SCRIPT' script:" >&2
  printf '%s' "$missing" >&2
  echo "  Add \"$SCRIPT\": \"wrangler deploy --dry-run\" to each, or this gate skips them silently." >&2
  exit 1
fi

echo "✓ check:deploy-config passed — $found Worker(s) bundle, parse and build."
