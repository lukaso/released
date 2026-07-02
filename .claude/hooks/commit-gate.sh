#!/usr/bin/env bash
# PreToolUse hook on Bash. Blocks `git commit` AND `git push` unless BOTH:
#
#   1. The last user-text message in the transcript contains an explicit
#      approval phrase for that action, with no nearby negation:
#        commit: commit | ok commit | go ahead and commit | ship it | land it
#        push:   push   | ok push   | go ahead and push   | push it | ship it | land it
#
#   2. If Claude edited any .ts/.tsx this session (Write/Edit/MultiEdit),
#      ./scripts/validate.sh has run successfully since that edit (tracked
#      via /tmp/released-validate.stamp, which validate.sh touches on success).
#
# Adapted from ~/projects/chiefofstaff/.claude/hooks/commit-gate.sh, extended
# to also gate `git push` (the original only gated commit).

set -u

INPUT=$(cat)

TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null || echo "")
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.transcript_path // ""' 2>/dev/null || echo "")

[ "$TOOL_NAME" = "Bash" ] || exit 0

# Identify the action: commit or push (skip otherwise — this hook is silent
# on every other Bash invocation).
ACTION=""
if printf '%s' "$CMD" | grep -qE '(^|[[:space:];&|(])git[[:space:]]+commit([[:space:]]|$)'; then
  ACTION="commit"
elif printf '%s' "$CMD" | grep -qE '(^|[[:space:];&|(])git[[:space:]]+push([[:space:]]|$)'; then
  ACTION="push"
else
  exit 0
fi

# ── Branch-scoped bypass (resolves #37) ──────────────────────────────
# Only the default branch auto-deploys, and merge is gated by review, so a
# commit/push to any NON-default branch is safe without the approval phrase.
# The default branch still requires it (gate 1). Gate 2 (validate.sh fresh)
# still applies to every branch. A command that explicitly targets main/master
# by refspec is also treated as default-branch and still gated.
ON_DEFAULT_BRANCH=1
CUR_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
DEFAULT_BRANCH=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@')
DEFAULT_BRANCH="${DEFAULT_BRANCH:-main}"
if [ -n "$CUR_BRANCH" ] && [ "$CUR_BRANCH" != "$DEFAULT_BRANCH" ] \
   && [ "$CUR_BRANCH" != "master" ] \
   && ! printf '%s' "$CMD" | grep -qE "(^|[[:space:]:/])(${DEFAULT_BRANCH}|master)([[:space:]:]|$)"; then
  ON_DEFAULT_BRANCH=""
fi

deny() {
  jq -cn --arg r "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    }
  }'
  exit 0
}

# ── Gate 1: explicit user approval in the last user message ────────────
LAST=""
if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
  LAST=$(jq -rs '
    [.[]?
     | select((.type // "") == "user")
     | . as $m
     | (try $m.message.content catch null) as $c
     | select($c != null
              and (($c | type) == "string"
                   or (($c | type) == "array" and ($c | any((.type? // "") == "text")))))
    ]
    | last
    | .message.content
    | if type=="string" then .
      else (map(select((.type? // "") == "text") | (.text? // "")) | join(" "))
      end
  ' "$TRANSCRIPT" 2>/dev/null || echo "")
fi

NORM=$(printf '%s' "$LAST" | tr '\n' ' ')

if [ "$ACTION" = "commit" ]; then
  APPROVE_RE='(^|[[:space:]])(commit|ship it|land it|go ahead and commit)([[:space:][:punct:]]|$)'
  NEGATE_RE="(don'?t|do not|never|wait|please not)[^.]{0,40}(commit|ship it|land it)"
  HINT="Ask first (e.g. 'commit', 'ok commit', 'ship it', 'land it')."
else
  APPROVE_RE='(^|[[:space:]])(push|push it|ship it|land it|go ahead and push)([[:space:][:punct:]]|$)'
  NEGATE_RE="(don'?t|do not|never|wait|please not)[^.]{0,40}(push|ship it|land it)"
  HINT="Ask first (e.g. 'push', 'ok push', 'push it', 'ship it', 'land it')."
fi

# liveapp-guard-version: 2 — push/commit-to-default now owned by .claude/hooks/liveapp-push-guard.sh
ON_DEFAULT_BRANCH=""   # liveapp: branch decision delegated to the push guard (single source)
if [ -n "$ON_DEFAULT_BRANCH" ]; then
  if ! printf '%s' "$NORM" | grep -qiE "$APPROVE_RE" || printf '%s' "$NORM" | grep -qiE "$NEGATE_RE"; then
    deny "No explicit user approval for git $ACTION in the last user message. $HINT"
  fi
fi

# ── Gate 2: validate.sh fresh for any TS edited this session ──────────
if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then
  exit 0
fi

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
  deny "TypeScript was edited this session but ./scripts/validate.sh has not run successfully. Run it first, confirm it passes, then re-try the $ACTION."
fi

MARKER_MTIME=$(mtime "$MARKER")

for f in "${FILES[@]}"; do
  [ -f "$f" ] || continue
  F_MTIME=$(mtime "$f")
  if [ "$F_MTIME" -gt "$MARKER_MTIME" ]; then
    deny "TypeScript was edited this session after the last successful ./scripts/validate.sh. Re-run it, confirm it passes, then re-try the $ACTION."
  fi
done

exit 0
