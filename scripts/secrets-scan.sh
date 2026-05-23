#!/usr/bin/env bash
# Secret scanning via gitleaks (https://github.com/gitleaks/gitleaks).
#
# Modes:
#   --staged   scan only what's staged (pre-commit). Fast; blocks a commit that
#              would add a token/key. This is what stops a stray `git add` of a
#              .dev.vars from ever reaching a commit.
#   (default)  scan the full git history (pre-push + CI authoritative gate).
#
# Real local secrets live in gitignored, never-committed .dev.vars files, so
# neither mode flags them — only an actual attempt to track a secret trips it.
#
# If gitleaks isn't installed: warn and exit 0. It's an optional LOCAL tool (a
# contributor may not have it, especially on Windows); CI installs it and runs
# this same script as the authoritative gate on every PR. See README.
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" || exit 1

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "⚠ gitleaks not installed — skipping local secret scan."
  echo "  Install: brew install gitleaks  |  https://github.com/gitleaks/gitleaks#installing"
  echo "  (CI scans every PR regardless — this is a local-only heads-up.)"
  exit 0
fi

if [ "${1:-}" = "--staged" ]; then
  gitleaks protect --staged --redact --no-banner
else
  gitleaks detect --redact --no-banner
fi
