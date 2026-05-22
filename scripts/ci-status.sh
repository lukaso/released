#!/usr/bin/env bash
# `pnpm ci:status` — show CI results for the current HEAD commit so you (or the
# agent) can self-diagnose right after a push instead of waiting for someone to
# relay a red build. Reports BOTH workflows (ci.yml + release.yml) for HEAD, and
# for any failed run dumps the failed-step logs. Read-only.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

if ! command -v gh >/dev/null 2>&1; then
  echo "gh (GitHub CLI) not installed — needed to read CI status."
  echo "  Install: https://cli.github.com   then: gh auth login"
  exit 0
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "gh is installed but not authenticated."
  echo "  Fix: gh auth login    (then re-run: pnpm ci:status)"
  exit 0
fi

SHA=$(git rev-parse HEAD)
SHORT=$(git rev-parse --short HEAD)
echo "CI status for HEAD ${SHORT}:"
echo

ROWS=$(gh run list --commit "$SHA" \
  --json databaseId,workflowName,status,conclusion,url \
  --jq '.[] | (if .status != "completed" then "… " elif .conclusion == "success" then "✓ " else "✗ " end) + .workflowName + ": " + (.conclusion // .status) + "  " + .url' \
  2>/dev/null || true)

if [ -z "$ROWS" ]; then
  echo "  No CI runs found for ${SHORT} yet."
  echo "  (Pushed just now? The run may not have registered — retry in a few seconds.)"
  exit 0
fi
printf '%s\n' "$ROWS" | sed 's/^/  /'

FAILED=$(gh run list --commit "$SHA" \
  --json databaseId,status,conclusion \
  --jq '.[] | select(.status=="completed" and .conclusion!=null and .conclusion!="success" and .conclusion!="skipped" and .conclusion!="cancelled") | .databaseId' \
  2>/dev/null || true)

if [ -n "$FAILED" ]; then
  echo
  echo "Failed-step logs:"
  for id in $FAILED; do
    echo "--- run $id ---"
    gh run view "$id" --log-failed 2>/dev/null | tail -40 || echo "  (could not fetch logs for run $id)"
  done
fi
