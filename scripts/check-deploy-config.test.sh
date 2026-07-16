#!/usr/bin/env bash
# Regression tests for scripts/check-deploy-config.sh — the gate's whole value is
# that it must NOT silently no-op, so this pins the behaviours that keep it
# honest: discovery of every config form, dedup of a package holding two forms,
# a loud failure on a missing script, a loud failure on a config with no
# package.json, a loud failure when no Worker is found, and the local skip of
# container Workers.
#
# Stubs `pnpm` so no real wrangler / Docker / network is needed (the script under
# test only shells out to `pnpm --dir <pkg> run <script>`). Run:
#   bash scripts/check-deploy-config.test.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
BIN="$TMP/bin"
mkdir -p "$BIN"

# Faithful pnpm stub for `pnpm --dir <pkg> run <script>`: exits 0 iff that
# package's package.json declares the script, non-zero otherwise — mirroring real
# `pnpm --dir ... run`, which a missing script makes fail loudly (exit 254).
cat > "$BIN/pnpm" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
pkg=""; script=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) pkg="$2"; shift 2 ;;
    run)   script="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -z "$pkg" ] || [ -z "$script" ]; then echo "stub: bad invocation" >&2; exit 64; fi
declared=$(node -e "const p=require('path').resolve(process.cwd(),'$pkg','package.json');const s=require(p).scripts||{};process.stdout.write(s['$script']?'true':'false')" 2>/dev/null || echo false)
if [ "$declared" = "true" ]; then echo "  stub: $pkg $script OK"; exit 0; fi
echo "  stub: $pkg has no '$script'" >&2; exit 254
STUB
chmod +x "$BIN/pnpm"

export PATH="$BIN:$PATH"
TARGET="$REPO/scripts/check-deploy-config.sh"

pass=0; fail=0
assert_exit() { # <name> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1))
  else echo "  FAIL  $1 — expected exit $2, got $3"; fail=$((fail+1)); fi
}
assert_nonzero() { # <name> <actual>  — the guard's point is "not a silent exit 0"
  if [ "$2" -ne 0 ]; then echo "  PASS  $1 (exit $2)"; pass=$((pass+1))
  else echo "  FAIL  $1 — expected non-zero, got 0 (silent no-op)"; fail=$((fail+1)); fi
}
assert_grep() { # <name> <pattern> <haystack>
  if printf '%s' "$3" | grep -q "$2"; then echo "  PASS  $1"; pass=$((pass+1))
  else echo "  FAIL  $1 — output missing /$2/"; fail=$((fail+1)); fi
}
mkpkg() { # <dir> <with-script> <ext> [<dockerfile>]
  mkdir -p "$TMP/$1"
  if [ "$2" = "1" ]; then
    printf '{"name":"%s","scripts":{"check:deploy-config":"echo dryrun"}}\n' "$1" > "$TMP/$1/package.json"
  else
    printf '{"name":"%s","scripts":{}}\n' "$1" > "$TMP/$1/package.json"
  fi
  : > "$TMP/$1/wrangler.$3"
  if [ "${4:-}" = "docker" ]; then : > "$TMP/$1/Dockerfile"; fi
}
# Run the script under test in a subshell; capture its real exit code into $rc
# without set -e killing the harness (`cmd && rc=0 || rc=$?` is set -e-safe).
echo "A — two valid Workers → discovered, exit 0"
rm -rf "$TMP/packages"; mkdir -p "$TMP/packages"
mkpkg packages/web 1 toml; mkpkg packages/web-og 1 toml
out=$(ROOT_DIR="$TMP" bash "$TARGET" 2>&1) && rc=0 || rc=$?
assert_exit "A exit 0" 0 "$rc"
assert_grep "A reports 2 Workers" "2/2 Worker" "$out"

echo "B — a Worker missing the script → exit 1 (not a silent no-op)"
rm -rf "$TMP/packages"; mkdir -p "$TMP/packages"
mkpkg packages/web 0 toml; mkpkg packages/web-og 1 toml
out=$(ROOT_DIR="$TMP" bash "$TARGET" 2>&1) && rc=0 || rc=$?
# Any non-zero exit is a loud failure — the exact code is pnpm's, not ours.
assert_nonzero "B missing script fails loudly" "$rc"

echo "C — no wrangler config at all → exit 1 (found-eq-0 guard)"
rm -rf "$TMP/packages"; mkdir -p "$TMP/packages"
mkdir -p "$TMP/packages/cli"; printf '{"name":"cli"}\n' > "$TMP/packages/cli/package.json"
out=$(ROOT_DIR="$TMP" bash "$TARGET" 2>&1) && rc=0 || rc=$?
assert_exit "C exit 1" 1 "$rc"
assert_grep "C says silent no-op" "silent no-op" "$out"

echo "D — a wrangler.jsonc-only Worker is discovered (not dropped)"
rm -rf "$TMP/packages"; mkdir -p "$TMP/packages"
mkpkg packages/web 1 toml; mkpkg packages/og 1 jsonc
out=$(ROOT_DIR="$TMP" bash "$TARGET" 2>&1) && rc=0 || rc=$?
assert_exit "D exit 0" 0 "$rc"
assert_grep "D reports 2 Workers" "2/2 Worker" "$out"

echo "E — SKIP_CONTAINER_WORKERS skips the image Worker, still runs the other"
rm -rf "$TMP/packages"; mkdir -p "$TMP/packages"
mkpkg packages/web 1 toml docker; mkpkg packages/web-og 1 toml
out=$(ROOT_DIR="$TMP" SKIP_CONTAINER_WORKERS=1 bash "$TARGET" 2>&1) && rc=0 || rc=$?
assert_exit "E exit 0" 0 "$rc"
# Precise patterns: "web-og" alone also matches a skip line, and "skipped" alone
# matches the success banner — so they pass whether the skip logic skipped
# nothing, skipped web (correct), or skipped everything. Anchor on the actual
# ran/skip lines so the assertions can tell those apart.
assert_grep "E skipped web" "web — skipped" "$out"
assert_grep "E still ran web-og" "web-og — wrangler dry run" "$out"

echo "F — a package holding two config forms → dedups to one dry run"
rm -rf "$TMP/packages"; mkdir -p "$TMP/packages"
mkpkg packages/web 1 toml; : > "$TMP/packages/web/wrangler.jsonc"   # second form, same package
out=$(ROOT_DIR="$TMP" bash "$TARGET" 2>&1) && rc=0 || rc=$?
assert_exit "F exit 0" 0 "$rc"
assert_grep "F counts one Worker" "1/1 Worker" "$out"

echo "G — a wrangler config with no package.json → exit 1 (not silently dropped)"
rm -rf "$TMP/packages"; mkdir -p "$TMP/packages"
mkpkg packages/web 1 toml
mkdir -p "$TMP/packages/newworker"; : > "$TMP/packages/newworker/wrangler.toml"   # config, NO package.json
out=$(ROOT_DIR="$TMP" bash "$TARGET" 2>&1) && rc=0 || rc=$?
assert_nonzero "G config-without-package.json fails loudly" "$rc"
assert_grep "G names the culprit" "no package.json" "$out"

echo
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ] || exit 1
