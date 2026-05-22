#!/usr/bin/env bash
# `pnpm check:publish` — prove the git-released CLI is publishable AND installable.
# The authoritative pre-publish gate (release.yml runs this before
# `changeset publish`); also runnable on demand.
#
#   1. publint — structural lint of the package (exports, files, bin targets).
#   2. Smoke test — npm pack the CLI, install the tarball into a clean temp dir
#      with ONLY its declared deps, and run `git-released --help`. This is the
#      check that reproduces the 0.1.0 break: an unresolvable runtime dependency
#      (or a missing dist file, or a bad bin path) fails the install/run here
#      instead of on a user's machine after publish.
#
# Strict by design: any failure exits non-zero, and this does NOT skip when
# CI=true (unlike validate.sh) — it is the publish gate and must always run.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
ROOT=$PWD

echo "→ build CLI"
pnpm --filter git-released build

echo "→ publint"
pnpm exec publint ./packages/cli

echo "→ pack + clean-install + run smoke test"
TARBALL=$(cd packages/cli && npm pack --silent)
TARBALL_ABS="$ROOT/packages/cli/$TARBALL"
TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; rm -f "$TARBALL_ABS"; }
trap cleanup EXIT

cd "$TMP"
npm init -y >/dev/null 2>&1
# Installing the packed tarball pulls its DECLARED deps from the public registry.
# If a dependency can't resolve (the 0.1.0 failure), npm install fails here.
npm install --no-audit --no-fund "$TARBALL_ABS" >/dev/null 2>&1
# Run the installed bin — proves it executes with only its published deps, no
# workspace symlinks, no dev deps.
"$TMP/node_modules/.bin/git-released" --help >/dev/null
echo "  ✓ installed from tarball into a clean dir and ran git-released --help"

echo "✓ check:publish passed — packs, installs clean, and runs."
