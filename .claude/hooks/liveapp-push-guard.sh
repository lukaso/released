#!/usr/bin/env bash
# liveapp-guard-version: 5
#
# liveapp-push-guard.sh — the Live App Contract's PreToolUse hook, shipped by the engine and
# installed/version-migrated into an adopted app's .claude/hooks/ by the `agent_hooks` bootstrap.
#
# v5 PARSES NO COMMANDS. Versions 1-4 tried to re-derive push/commit targets from command
# STRINGS; four independent review rounds found bypass after bypass (compound commands, ssh/https
# remotes, HEAD/@, +force markers, refs/heads/ forms, words inside -m messages) — a shell/git
# string matcher cannot be simultaneously complete (never miss the default branch) and loop-safe
# (never block feature work). The DECISION now lives in the GIT-NATIVE hooks the bootstrap
# installs (liveapp-pre-push.sh / liveapp-pre-commit.sh): git hands them the exact resolved refs,
# so there is nothing left to parse — and nothing left to bypass.
#
# This hook keeps exactly two jobs:
#   1. TOKEN MINTING — on each Bash call, read the session's LAST USER MESSAGE (transcript); if
#      it carries an approval phrase ("ship it" / "push" / "land it" / "commit", not negated),
#      mint the short-TTL ONE-SHOT approval token at
#      $(git rev-parse --git-common-dir)/liveapp-approve for the session cwd's repo. The
#      git-native hooks honor and consume it. Command text is never consulted.
#   2. SELF-PROTECTION — deny Edit/Write/Bash-mutation of this guard, the git-native hooks
#      (installed names, template names, and .liveapp-chained originals), and the hook config.
# Everything else is ALLOW — a matcher miss can no longer be a bypass, because the matcher no
# longer decides.
#
# Hook I/O (Claude Code): stdin JSON has .tool_name, .tool_input.command (Bash) | .tool_input.file_path
# (Edit/Write), .cwd, and .transcript_path. DENY = print {"hookSpecificOutput":{...,"deny",...}} +
# exit 0. ALLOW = print nothing + exit 0 (defer to normal flow).
#
# LIVEAPP_* it reads (real path first; the rest are test/override hooks):
#   transcript_path (JSON)   the live transcript — last user message is read for the approval phrase
#   LIVEAPP_LAST_USER_MSG    override the last user message — skips transcript parsing (tests)
#   LIVEAPP_GUARD_SELF       absolute path of this guard's live copy (self-protection)
set -uo pipefail
set -f          # no globbing: `for tok in $CMD` must word-split only

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
  # control chars (a newline-y file path, say) would break the JSON — flatten them first
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":%s}}\n' \
    "$(printf '%s' "$1" | tr '\000-\037' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/')"
  exit 0
}

# Could not parse -> ALLOW (defer to normal flow). A malformed payload is not something this hook
# could have judged anyway, and a blanket deny would brick every tool call.
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

# ---- self-protection: this guard, the GIT-NATIVE gates, and anything that controls hooks ----
is_protected_path() {
  case "$1" in
    *"/.claude/hooks/"*|*"/.claude/settings.json"|*"/.claude/settings.local.json") return 0;;
    */liveapp-push-guard.sh|*/liveapp-pre-push.sh|*/liveapp-pre-commit.sh) return 0;;
    *hooks/pre-push|*hooks/pre-commit|*.liveapp-chained) return 0;;
  esac
  [ -n "${LIVEAPP_GUARD_SELF:-}" ] && [ "$1" = "$LIVEAPP_GUARD_SELF" ] && return 0
  return 1
}
case "$TOOL" in
  Edit|Write|NotebookEdit|MultiEdit)
    is_protected_path "$FPATH" && deny "refusing to let an edit modify the push guard / git-native gates / hook config ($FPATH)"
    exit 0 ;;
  Bash) : ;;
  *)    exit 0 ;;
esac

[ -z "$CMD" ] && exit 0
# Bash mutation of a protected path (best-effort; the server-side wall is the real backstop)
if printf '%s' "$CMD" | grep -Eq '(>>?|[[:space:]]tee[[:space:]]|sed[[:space:]]+-i|[[:space:]](cp|mv|dd|install|truncate)[[:space:]]|rm[[:space:]])'; then
  for tok in $CMD; do is_protected_path "$tok" && deny "refusing a Bash mutation of the push guard / git-native gates ($tok)"; done
  for tok in $(printf '%s' "$CMD" | tr '>' ' '); do is_protected_path "$tok" && deny "refusing a Bash redirect onto the push guard / git-native gates ($tok)"; done
fi

# ---- token minting: the last USER message is the approval, never the command ----
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

# union of the old commit+push phrase lists — one token serves both git-native gates
APPROVE_RE='(^|[[:space:]])(commit|ok commit|push|push it|ok push|ship it|land it|go ahead and (commit|push))([[:space:][:punct:]]|$)'
NEGATE_RE="(don'?t|do not|never|wait|please not)[^.]{0,40}(commit|push|ship it|land it)"

if [ -n "$NORM" ] && printf '%s' "$NORM" | grep -qiE "$APPROVE_RE" && ! printf '%s' "$NORM" | grep -qiE "$NEGATE_RE"; then
  gd="$( cd "$HCWD" 2>/dev/null && git rev-parse --git-common-dir 2>/dev/null )"
  if [ -n "${gd:-}" ]; then
    case "$gd" in /*) : ;; *) gd="$HCWD/$gd" ;; esac
    [ -d "$gd" ] && date +%s > "$gd/liveapp-approve" 2>/dev/null
  fi
fi
exit 0
