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
# Workers are DISCOVERED, not listed: any package under packages/ holding a
# wrangler config in any of the three forms wrangler accepts (wrangler.toml /
# .jsonc / .json; jsonc is what `wrangler init` scaffolds now) is picked up —
# so a third Worker under packages/ is covered the day it lands. A Worker under
# a DIFFERENT workspace root (apps/, services/) is not matched by that glob, so
# the pnpm-workspace cross-check below catches it: pnpm-workspace.yaml is the
# source of truth for what's a package, and anything it names that the glob
# missed fails loud rather than shipping unvalidated. The script-existence
# check is enforced BY CONSTRUCTION: each package is invoked with
# `pnpm --dir "$pkg" run`, which exits NON-ZERO if the script is absent.
# (`pnpm --filter <name> <script>` was rejected because it exits 0 on EITHER a
# name no-match OR a missing script — a silent no-op, the one failure mode a
# gate must not have.)
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
  pkg_dir=$(cd "$(dirname "$cfg")" && pwd)
  case "$seen" in
    *":$pkg_dir:"*) continue ;;
  esac
  seen="$seen:$pkg_dir:"
  # A wrangler config with no package.json is a half-scaffolded Worker we can't
  # invoke (pnpm --dir needs package.json). Fail loudly rather than silently
  # dropping it — the dropped Worker is exactly the silent no-op this gate
  # exists to forbid.
  if [ ! -f "$pkg_dir/package.json" ]; then
    echo "✗ $pkg_dir has a wrangler config but no package.json — cannot run check:deploy-config." >&2
    exit 1
  fi
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

# Defense-in-depth against a SILENT no-op the packages/* glob above cannot see.
# The glob is scoped to packages/* — the only root pnpm-workspace.yaml declares
# today. The day the workspace gains another root (apps/, services/), a Worker
# there holds a wrangler config the glob never matches, yet `found` stays > 0
# (the packages/* Workers still match) so the found==0 guard never fires — that
# Worker ships unvalidated, the exact silent no-op this gate exists to forbid.
# pnpm-workspace.yaml is the source of truth, so ask pnpm (not a second glob)
# which packages exist and fail loud if one holds a wrangler config discovery
# did not already run. pnpm expands any workspace shape (apps/*, services/**),
# so this is not itself a re-declared layout. Non-fatal if pnpm is unreachable:
# the discovery above still gated the packages/* Workers; this is the wider net.
ws_pkgs=$(pnpm -r list --depth -1 --parseable 2>/dev/null || true)
while IFS= read -r ws_pkg; do
  [ -z "$ws_pkg" ] && continue
  [ -f "$ws_pkg/package.json" ] || continue
  case "$seen" in *":$ws_pkg:"*) continue ;; esac   # discovery already ran it
  for ws_cfg in "$ws_pkg"/wrangler.toml "$ws_pkg"/wrangler.jsonc "$ws_pkg"/wrangler.json; do
    if [ -e "$ws_cfg" ]; then
      echo "✗ $ws_pkg holds a wrangler config the packages/* discovery glob did not cover — pnpm-workspace.yaml names a Worker this gate would silently skip. Move it under packages/ or extend the glob. A gate must not silently no-op." >&2
      exit 1
    fi
  done
done <<< "$ws_pkgs"

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

# Only mention skips when any happened. `${skipped:+ ...}` fires on "0" too —
# "0" is set and non-empty — which would append "(0 skipped)" to every clean run
# and weaken the "a skip happened" test assertion. Guard on the integer instead.
suffix=""
[ "$skipped" -gt 0 ] && suffix=" ($skipped skipped)"
echo "✓ check:deploy-config passed — $ran/$found Worker(s) bundle, parse and build${suffix}."
