#!/usr/bin/env bash
# `pnpm check:deploy-config` — prove both Workers' deploy config actually builds.
#
# Neither Worker has a `build` script, so `pnpm -r build` never bundles them and
# nothing else in CI parses their wrangler config. A bad binding, a malformed
# [[durable_objects]] migration or a broken Dockerfile would otherwise first
# surface in the production deploy, after merge.
#
# Each Worker's `check:deploy-config` is `wrangler deploy --dry-run`: it bundles
# the Worker, parses the config and BUILDS the container image, while contacting
# no Cloudflare API and deploying nothing.
#
# Workers are DISCOVERED — any package holding a wrangler config in any of the
# three forms wrangler accepts (wrangler.toml / .jsonc / .json; jsonc is what
# `wrangler init` scaffolds now), not listed — so a third Worker is covered the
# day it lands. The script-existence check is enforced BY CONSTRUCTION: each
# package is invoked with `pnpm --dir "$pkg" run`, which exits NON-ZERO if the
# script is absent. (`pnpm --filter <name> <script>` was rejected because it
# exits 0 on EITHER a name no-match OR a missing script — a silent no-op, the
# one failure mode a gate must not have.)
#
# What it still cannot see: remote state. A [[migrations]] tag conflicting with
# what is already applied to released-web, web-og's [[services]] binding naming
# a Worker that does not exist, or a missing secret all need the real API.
#
# Strict by design, like check-publish.sh: any failure exits non-zero, and it
# does NOT skip when CI=true. Needs Docker for any Worker whose package ships a
# Dockerfile (the container image); set SKIP_CONTAINER_WORKERS=1 to skip those
# only (validate.sh does this when Docker isn't running, so Docker-free Workers
# like web-og are still gated locally) — CI is the authoritative gate.
#
# Bash 3.2 (macOS default): no arrays, no `${arr[@]}` under `set -u`.
set -euo pipefail

# Repo root — overridable so scripts/check-deploy-config.test.sh can point this
# at a temp packages/ tree with a stubbed `pnpm`.
ROOT_DIR="${ROOT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || echo .)}"
cd "$ROOT_DIR"

SCRIPT="check:deploy-config"
found=0
ran=0
skipped=0
seen=""

# A package may hold two config forms (e.g. wrangler.toml alongside the
# wrangler.jsonc wrangler actually loads); dedupe by package dir so its dry run
# runs once. wrangler resolves the ACTIVE config by its own precedence, so which
# glob matched first is irrelevant — we only need to find the package.
for cfg in packages/*/wrangler.toml packages/*/wrangler.jsonc packages/*/wrangler.json; do
  [ -e "$cfg" ] || continue
  pkg_dir=$(dirname "$cfg")
  case "$seen" in
    *":$pkg_dir:"*) continue ;;
  esac
  seen="$seen:$pkg_dir:"
  [ -f "$pkg_dir/package.json" ] || continue
  found=$((found + 1))

  # Local-only fast path: when Docker isn't available, skip the Workers whose
  # config builds an image (presence of a Dockerfile) but still validate the
  # rest. CI never sets this.
  if [ "${SKIP_CONTAINER_WORKERS:-0}" = "1" ] && [ -f "$pkg_dir/Dockerfile" ]; then
    skipped=$((skipped + 1))
    echo "→ $pkg_dir — skipped (container image; Docker unavailable). CI gates it."
    continue
  fi

  ran=$((ran + 1))
  echo "→ $pkg_dir — wrangler dry run (bundle + config + container image)"
  # `pnpm --dir` runs in the package's own context and exits non-zero if the
  # script is missing — so a rename or a dropped script fails loudly, not silently.
  pnpm --dir "$pkg_dir" run "$SCRIPT"
done

if [ "$found" -eq 0 ]; then
  echo "✗ no Workers found (no packages/*/wrangler.{toml,jsonc,json}) — this gate would be a silent no-op." >&2
  exit 1
fi

if [ "$ran" -eq 0 ]; then
  # Every discovered Worker was skipped (SKIP_CONTAINER_WORKERS). Nothing was
  # actually validated, so do not claim success — but this is a local-only path;
  # exit 0 so validate.sh's best-effort pass doesn't block a push CI will gate.
  echo "⚠ found $found Worker(s) but validated none (all skipped — Docker unavailable). CI is the authoritative gate."
  exit 0
fi

echo "✓ check:deploy-config passed — $ran/$found Worker(s) bundle, parse and build${skipped:+ ($skipped skipped)}."
