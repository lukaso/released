#!/usr/bin/env bash
# Stop hook. Nudges Claude to run ./scripts/validate.sh before declaring
# done, but ONLY when Claude actually edited TypeScript in THIS session.
#
# How it works:
#   1. Reads $transcript_path to find .ts/.tsx files Claude wrote/edited
#      this session (Write / Edit / MultiEdit tool calls).
#   2. If any such file is newer than /tmp/released-validate.stamp,
#      returns {"decision":"block"} so Claude re-runs validate.sh.
#   3. Respects stop_hook_active so we nudge once, not indefinitely.
#
# Adapted from ~/projects/chiefofstaff/.claude/hooks/verify-build-gate.sh.

set -u

INPUT=$(cat)

STOP_ACTIVE=$(printf '%s' "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null || echo "false")
[ "$STOP_ACTIVE" = "true" ] && exit 0

TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.transcript_path // ""' 2>/dev/null || echo "")
[ -z "$TRANSCRIPT" ] && exit 0
[ ! -f "$TRANSCRIPT" ] && exit 0

FILES=()
while IFS= read -r f; do
  [ -n "$f" ] && FILES+=("$f")
done < <(jq -rs '
  [.[]?
   | select((.type? // "") == "assistant")
   | (try .message.content catch [])
   | if type == "array" then .[] else empty end
   | select((.type? // "") == "tool_use")
   | select((.name? // "") == "Write" or (.name? // "") == "Edit" or (.name? // "") == "MultiEdit")
   | (.input.file_path? // empty)
  ]
  | unique
  | .[]
  | select(test("\\.(ts|tsx)$"))
' "$TRANSCRIPT" 2>/dev/null || true)

[ ${#FILES[@]} -eq 0 ] && exit 0

MARKER="/tmp/released-validate.stamp"

mtime() {
  stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0
}

if [ ! -f "$MARKER" ]; then
  printf '%s\n' '{"decision":"block","reason":"TypeScript was edited this session but ./scripts/validate.sh has not run successfully. Run it and confirm all checks pass before declaring done."}'
  exit 0
fi

MARKER_MTIME=$(mtime "$MARKER")

for f in "${FILES[@]}"; do
  [ -f "$f" ] || continue
  F_MTIME=$(mtime "$f")
  if [ "$F_MTIME" -gt "$MARKER_MTIME" ]; then
    printf '%s\n' '{"decision":"block","reason":"TypeScript was edited this session after the last successful ./scripts/validate.sh. Re-run it and confirm all checks pass before declaring done."}'
    exit 0
  fi
done

exit 0
