#!/usr/bin/env bash
# liveapp-guard-version: 1
#
# liveapp-push-guard.sh — the Live App Contract's INTERACTIVE push-to-default guard, shipped by
# the engine and installed/version-migrated into an adopted app's .claude/hooks/ by the
# `agent_hooks` bootstrap module. It is a Claude Code PreToolUse hook.
#
# WHAT IT DOES (and why it differs from the engine's own bin/contract-guard.sh):
#   * It gates `git push`/`git commit` whose TARGET is the DEFAULT branch behind an explicit
#     approval phrase in the last user message ("push" / "ship it" / "land it"). For an
#     interactive human this is the "don't push to main until I say so" belt; for the autonomous
#     loop (no user message) it is an unconditional block on the default branch — which is exactly
#     right (the loop must never push the default branch; contract-guard + branch protection agree).
#   * A FEATURE-branch target is ALWAYS allowed (loop + human). This is the bug the prior leaky
#     hook got wrong: it resolved the branch from the HOOK's own cwd (the app's main checkout, on
#     main), so a feature-branch push issued from the main checkout was wrongly denied. This guard
#     is REFSPEC-AWARE — it reads the push target from the command, not the checkout's HEAD —
#     mirroring bin/contract-guard.sh's detection (kept in lock-step by test/pushguard.sh's parity).
#   * It does NOT gate merge/deploy/publish — that is the loop's contract-guard concern, not the
#     human-dev belt. Keep this hook's job narrow: commit/push to the default branch only.
#
# Self-contained ON PURPOSE: it lives in the app repo and cannot import the engine's bin/, so the
# default-branch detection is duplicated from contract-guard.sh. The parity test is the DRY guard.
#
# Hook I/O (Claude Code): stdin JSON has .tool_name, .tool_input.command (Bash) | .tool_input.file_path
# (Edit/Write), .cwd, and .transcript_path. DENY = print {"hookSpecificOutput":{...,"deny",...}} +
# exit 0. ALLOW = print nothing + exit 0 (defer to normal flow).
#
# LIVEAPP_* it reads (real path first; the rest are test/override hooks):
#   transcript_path (JSON)   the live transcript — last user message is read for the approval phrase
#   LIVEAPP_DEFAULT_BRANCH   the app's default branch (default: main; master is always default-class)
#   LIVEAPP_CURRENT_BRANCH   override the resolved current branch (bare push / commit) — skips git
#   LIVEAPP_LAST_USER_MSG    override the last user message — skips transcript parsing (tests)
#   LIVEAPP_GUARD_SELF       absolute path of this guard's live copy (self-protection)
set -uo pipefail
set -f          # no globbing: `for tok in $CMD` must word-split only

DEF="${LIVEAPP_DEFAULT_BRANCH:-main}"

# ---- parse the hook JSON (node preferred, python3 fallback; base64 fields so an arbitrary
# command string with tabs/newlines/quotes can't corrupt the split) ----
RAW="$(cat)"
parsed=""
if command -v node >/dev/null 2>&1; then
  parsed="$(printf '%s' "$RAW" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try{const j=JSON.parse(s);const b=x=>Buffer.from(String(x==null?"":x)).toString("base64");
        process.stdout.write([j.tool_name||"",b((j.tool_input||{}).command),b((j.tool_input||{}).file_path),b(j.cwd),b(j.transcript_path)].join("\t"));
      }catch(e){process.exit(7)}});' 2>/dev/null)"
fi
if [ -z "$parsed" ] && command -v python3 >/dev/null 2>&1; then
  parsed="$(printf '%s' "$RAW" | python3 -c '
import sys,json,base64
try:
  j=json.load(sys.stdin); ti=j.get("tool_input",{}) or {}
  b=lambda x: base64.b64encode(str(x if x is not None else "").encode()).decode()
  print("\t".join([j.get("tool_name","") or "", b(ti.get("command","")), b(ti.get("file_path","")), b(j.get("cwd","")), b(j.get("transcript_path",""))]))
except Exception:
  sys.exit(7)' 2>/dev/null)"
fi

deny() {
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":%s}}\n' \
    "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/')"
  exit 0
}

# Could not parse -> ALLOW (defer to normal flow). A malformed payload is not something a string
# matcher could have judged anyway, and a blanket deny would brick every tool call.
[ -z "$parsed" ] && exit 0

TOOL="${parsed%%	*}"
rest="${parsed#*	}"
CMD_B64="${rest%%	*}"; rest="${rest#*	}"
PATH_B64="${rest%%	*}"; rest="${rest#*	}"
CWD_B64="${rest%%	*}"; TRANSCRIPT_B64="${rest#*	}"
b64d() { printf '%s' "$1" | { base64 -d 2>/dev/null || base64 -D 2>/dev/null; }; }
CMD="$(b64d "$CMD_B64")"
FPATH="$(b64d "$PATH_B64")"
HCWD="$(b64d "$CWD_B64")"
TRANSCRIPT="$(b64d "$TRANSCRIPT_B64")"

# ---- self-protection: this guard's own copy + anything that controls hooks ----
is_protected_path() {
  case "$1" in
    *"/.claude/hooks/"*|*"/.claude/settings.json"|*"/.claude/settings.local.json") return 0;;
    */liveapp-push-guard.sh) return 0;;
  esac
  [ -n "${LIVEAPP_GUARD_SELF:-}" ] && [ "$1" = "$LIVEAPP_GUARD_SELF" ] && return 0
  return 1
}
case "$TOOL" in
  Edit|Write|NotebookEdit|MultiEdit)
    is_protected_path "$FPATH" && deny "refusing to let an edit modify the push guard or hook config ($FPATH)"
    exit 0 ;;
  Bash) : ;;
  *)    exit 0 ;;
esac

[ -z "$CMD" ] && exit 0
# Bash mutation of a protected path (best-effort, mirrors contract-guard)
if printf '%s' "$CMD" | grep -Eq '(>>?|[[:space:]]tee[[:space:]]|sed[[:space:]]+-i|[[:space:]](cp|mv|dd|install|truncate)[[:space:]]|rm[[:space:]])'; then
  for tok in $CMD; do is_protected_path "$tok" && deny "refusing a Bash mutation of the push guard / hook config ($tok)"; done
  for tok in $(printf '%s' "$CMD" | tr '>' ' '); do is_protected_path "$tok" && deny "refusing a Bash redirect onto the push guard / hook config ($tok)"; done
fi

low=$(printf '%s' "$CMD" | tr '[:upper:]' '[:lower:]')

# ---- identify the action: git commit or git push (else not our concern -> ALLOW) ----
ACTION=""
if printf '%s' "$low" | grep -Eq '(^|[;&|([:space:]])git[[:space:]]+([^;&|]*[[:space:]])?commit([[:space:]]|$)'; then
  ACTION=commit
elif printf '%s' "$low" | grep -Eq '(^|[;&|([:space:]])git[[:space:]]+([^;&|]*[[:space:]])?push([[:space:]]|$)'; then
  ACTION=push
else
  exit 0
fi

def_lc=$(printf '%s' "$DEF" | tr '[:upper:]' '[:lower:]')
is_default_name() { [ "$1" = "$def_lc" ] || [ "$1" = master ]; }

# Effective repo dir for a bare push / commit: `git -C <dir>`, else a leading `cd <dir>`, else cwd.
effective_dir() {
  local d="$HCWD"
  if printf '%s' "$CMD" | grep -Eq '(^|[[:space:]])git[[:space:]]+-c[[:space:]]'; then
    d=$(printf '%s' "$CMD" | sed -E 's@.*[[:space:]]git[[:space:]]+-[cC][[:space:]]+([^[:space:]]+).*@\1@')
  elif printf '%s' "$CMD" | grep -Eq '^[[:space:]]*cd[[:space:]]'; then
    d=$(printf '%s' "$CMD" | sed -E 's@^[[:space:]]*cd[[:space:]]+([^[:space:]]+).*@\1@')
  fi
  printf '%s' "$d"
}
resolve_current() {
  local cur="${LIVEAPP_CURRENT_BRANCH:-}"
  if [ -z "$cur" ]; then
    local d; d="$(effective_dir)"
    [ -n "$d" ] && cur=$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
  fi
  printf '%s' "$cur"
}

# ---- decide whether the TARGET is the default branch (refspec-aware for push) ----
# gated=1 means "this acts on the default branch -> needs the approval phrase".
gated=0
if [ "$ACTION" = push ]; then
  pushargs=$(printf '%s' "$low" | sed -E 's@^.*[[:space:]]push([[:space:]]+|$)@@')
  positionals=""
  for tok in $pushargs; do
    case "$tok" in -*) continue;; esac
    positionals="$positionals $tok"
  done
  # (1) any positional naming the default branch as its destination -> gated
  for tok in $positionals; do
    case "$tok" in
      *:*) [ -n "${tok##*:}" ] && is_default_name "${tok##*:}" && gated=1;;
      *)   is_default_name "$tok" && gated=1;;
    esac
  done
  if [ "$gated" = 0 ]; then
    npos=$(printf '%s' "$positionals" | wc -w | tr -d ' ')
    if printf '%s' "$positionals" | grep -q ':' || [ "${npos:-0}" -ge 2 ]; then
      : # explicit feature refspec / remote+branch, none default -> feature target -> allow
    else
      # (3) bare push or `git push <remote>` -> destination is the current branch
      cur="$(resolve_current)"
      if [ -n "$cur" ]; then
        cur_lc=$(printf '%s' "$cur" | tr '[:upper:]' '[:lower:]')
        is_default_name "$cur_lc" && gated=1
      else
        gated=1   # fail-closed: a push we cannot prove is a feature branch needs the phrase
      fi
    fi
  fi
else
  # commit: gate only when we POSITIVELY resolve the current branch to the default (else allow —
  # an unresolvable commit must not block the loop, and a commit is harmless until pushed).
  cur="$(resolve_current)"
  if [ -n "$cur" ]; then
    cur_lc=$(printf '%s' "$cur" | tr '[:upper:]' '[:lower:]')
    is_default_name "$cur_lc" && gated=1
  fi
fi

[ "$gated" = 0 ] && exit 0   # feature target -> ALLOW (loop's 99% path; never deadlocks)

# ---- the target IS the default branch: allow iff the last user message approves ----
LAST="${LIVEAPP_LAST_USER_MSG:-}"
if [ -z "$LAST" ] && [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] && command -v jq >/dev/null 2>&1; then
  LAST=$(jq -rs '
    [.[]? | select((.type // "") == "user")
     | . as $m | (try $m.message.content catch null) as $c
     | select($c != null and (($c|type)=="string" or (($c|type)=="array" and ($c|any((.type? // "")=="text")))))]
    | last | .message.content
    | if type=="string" then . else (map(select((.type? // "")=="text")|(.text? // ""))|join(" ")) end
  ' "$TRANSCRIPT" 2>/dev/null || echo "")
fi
NORM=$(printf '%s' "$LAST" | tr '\n' ' ')

if [ "$ACTION" = commit ]; then
  APPROVE_RE='(^|[[:space:]])(commit|ok commit|ship it|land it|go ahead and commit)([[:space:][:punct:]]|$)'
  NEGATE_RE="(don'?t|do not|never|wait|please not)[^.]{0,40}(commit|ship it|land it)"
  HINT="Ask first (e.g. 'commit', 'ok commit', 'ship it', 'land it')."
else
  APPROVE_RE='(^|[[:space:]])(push|push it|ok push|ship it|land it|go ahead and push)([[:space:][:punct:]]|$)'
  NEGATE_RE="(don'?t|do not|never|wait|please not)[^.]{0,40}(push|ship it|land it)"
  HINT="Ask first (e.g. 'push', 'ok push', 'push it', 'ship it', 'land it')."
fi

if printf '%s' "$NORM" | grep -qiE "$APPROVE_RE" && ! printf '%s' "$NORM" | grep -qiE "$NEGATE_RE"; then
  exit 0   # explicit human approval on the default branch -> ALLOW
fi
deny "No explicit user approval for git $ACTION to the default branch '$DEF' in the last user message. $HINT"
