#!/usr/bin/env bash
# Dependency CVE scan via osv-scanner (https://osv.dev).
#
# Gating policy: exit 1 ONLY on High/Critical vulnerabilities. Medium/Low are
# printed but do not fail — the published CLI bundles only cac + micromark, so
# dev-tooling mediums (esbuild/vite/ws from the Workers + test stack) are noise
# here; track those via Dependabot. A new High/Critical is the real risk and
# gates.
#
# If osv-scanner is not installed: warn and exit 0. It's an optional LOCAL tool
# (a contributor may not have it, especially on Windows), and CI installs it and
# runs this same script as the authoritative gate on every PR. See README.
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

if ! command -v osv-scanner >/dev/null 2>&1; then
  echo "⚠ osv-scanner not installed — skipping local dependency CVE scan."
  echo "  Install: brew install osv-scanner  |  https://google.github.io/osv-scanner/installation/"
  echo "  (CI scans every PR regardless — this is a local-only heads-up.)"
  exit 0
fi

# osv-scanner exits non-zero whenever ANY vuln is found; we re-derive the gate
# from its severity tally instead, so capture output and don't let -e trip.
OUT=$(osv-scanner scan --lockfile=pnpm-lock.yaml 2>&1 || true)
echo "$OUT"

# Tally line looks like: "...(0 Critical, 0 High, 3 Medium, 0 Low, 0 Unknown)..."
CRIT=$(printf '%s\n' "$OUT" | grep -oE '[0-9]+ Critical' | head -1 | grep -oE '[0-9]+' || echo 0)
HIGH=$(printf '%s\n' "$OUT" | grep -oE '[0-9]+ High' | head -1 | grep -oE '[0-9]+' || echo 0)
CRIT=${CRIT:-0}
HIGH=${HIGH:-0}

if [ "$CRIT" -gt 0 ] || [ "$HIGH" -gt 0 ]; then
  echo "✗ osv: ${CRIT} Critical + ${HIGH} High vulnerability(ies) — must be resolved before merge."
  exit 1
fi
echo "✓ osv: no High/Critical vulnerabilities. (Any Medium/Low above are tracked via Dependabot.)"
exit 0
