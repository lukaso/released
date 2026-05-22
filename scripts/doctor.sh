#!/usr/bin/env bash
# `pnpm doctor` — one-shot prerequisite check for the released repo.
#
# Reports setup across three tiers: to contribute, to run the CLI against live
# hosts, and to publish/deploy. Prints the exact fix for each miss. Exits 1 only
# when a CONTRIBUTE-tier requirement is missing, so it can gate setup; optional
# tools (osv-scanner, gh, tokens) only warn — they never fail the command.
#
# Bash 3.2 + BSD-tool friendly (macOS default shell).
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m⚠\033[0m %s\n' "$1"; }
miss() { printf '  \033[31m✗\033[0m %s\n' "$1"; }

FAIL=0

echo "To contribute (build · test · lint · push · open PRs):"
if command -v node >/dev/null 2>&1; then
  ok "node $(node -v)"
else
  miss "node not found — install Node 20+ (https://nodejs.org)"
  FAIL=1
fi
if command -v pnpm >/dev/null 2>&1; then
  ok "pnpm $(pnpm -v)"
else
  miss "pnpm not found — 'npm i -g pnpm' or 'corepack enable'"
  FAIL=1
fi
if command -v osv-scanner >/dev/null 2>&1; then
  ok "osv-scanner $(osv-scanner --version 2>/dev/null | head -1 | awk '{print $NF}')"
else
  warn "osv-scanner not installed — local dependency CVE scan is skipped (CI still scans every PR). Install: brew install osv-scanner | https://google.github.io/osv-scanner/installation/"
fi

echo
echo "Optional — to run the CLI against live hosts (the test suite uses mocks, so this is NOT needed for dev):"
if [ -n "${GITHUB_TOKEN:-}${GH_TOKEN:-}" ]; then
  ok "GitHub token present (5000 req/hr)"
else
  warn "no GITHUB_TOKEN/GH_TOKEN — CLI falls back to the 60 req/hr anonymous GitHub limit; tests don't need it"
fi
if [ -n "${GITLAB_TOKEN:-}" ]; then
  ok "GITLAB_TOKEN present"
else
  warn "no GITLAB_TOKEN — gitlab.com CLI lookups will 403 (see README 'Deploy'); not needed for dev"
fi
if command -v gh >/dev/null 2>&1; then
  if gh auth status >/dev/null 2>&1; then
    ok "gh authenticated (enables 'pnpm ci:status')"
  else
    warn "gh installed but not authenticated — run 'gh auth login' to use 'pnpm ci:status'"
  fi
else
  warn "gh not installed — 'pnpm ci:status' needs it (https://cli.github.com)"
fi

echo
echo "Maintainer only — to publish/deploy (contributors never need these):"
warn "npm publish + Cloudflare deploy run only in .github/workflows/release.yml via OIDC + repo secrets. Nothing to set up locally."

echo
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32mReady to contribute.\033[0m Daily loop: edit -> pnpm validate -> push -> pnpm ci:status\n'
else
  printf '\033[31mMissing a contribute-tier prerequisite above.\033[0m Fix it and re-run: pnpm doctor\n'
fi
exit "$FAIL"
