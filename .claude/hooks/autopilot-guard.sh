#!/bin/bash
# autopilot-guard.sh — ported from ShadePath (S165, Rails 0/1/2) to Countersign 2026-09-01.
# PreToolUse on ALL tools.
#  Rail 0: a mid-turn "autopilot stop" (which never fires UserPromptSubmit) is honored here.
#  Rail 1: outward/durable actions (push, merge, tag, PR, release, publish, deploy): DENY on
#          autopilot, ASK off autopilot. Countersign commits on main by founder law, so commit is
#          allowed; push is the outward act. No branch-aware push form exists here: push is simply
#          denied while the flag is on.
#  Rail 2: destructive shell + history-rewriting git: DENY with rephrase guidance on autopilot
#          (a night-time ask freezes the lane; deny is strictly tighter).
#  Everything else on autopilot: ALLOW, except edits to .claude/ and CLAUDE.md, which fall through
#  to the normal permission system. Heredoc bodies are excised before scanning so prose in a log
#  append never trips a rail. Fail-safe: any parse problem behaves as before (no phantom stop).
input=$(cat)
tool=$(printf '%s' "$input" | jq -r '.tool_name // ""')
PROJ="${CLAUDE_PROJECT_DIR:-.}"
FLAG="$PROJ/.claude/autopilot.on"

deny() { printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":%s}}' "$(printf '%s' "$1" | jq -Rs .)"; exit 0; }
ask()  { printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":%s}}' "$(printf '%s' "$1" | jq -Rs .)"; exit 0; }
allow(){ printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"autopilot"}}'; exit 0; }

# Rail 0 — mid-turn stop
if [ -f "$FLAG" ]; then
  transcript=$(printf '%s' "$input" | jq -r '.transcript_path // ""')
  if [ -n "$transcript" ] && [ -f "$transcript" ]; then
    last_user_msg=$(tail -200 "$transcript" 2>/dev/null \
      | jq -r 'select(.type=="user") | .message.content | if type=="array" then (map(select(.type=="text") | .text) | join(" ")) else tostring end' 2>/dev/null \
      | tail -1)
    if printf '%s' "$last_user_msg" | grep -qiE '(^|[[:space:][:punct:]])(autopilot[[:space:]]+(stop|off)|stop[[:space:]]+autopilot)[[:space:]]*([.!?;]|$)'; then
      rm -f "$FLAG"
      deny "🛑 AUTOPILOT STOPPED — the founder's mid-turn \"autopilot stop\" is honored (Rail 0). Flag removed; normal approval mode from this tool call onward. Re-issue this action under founder approval if still wanted, and give the founder the autopilot summary."
    fi
  fi
fi

if [ "$tool" = "Bash" ]; then
  cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')
  # excise heredoc bodies (data being written), keep every command line; fail-closed to full cmd
  cmd_nohd=$(printf '%s' "$cmd" | python3 -c '
import sys, re
lines = sys.stdin.read().split("\n")
out, i = [], 0
while i < len(lines):
    L = lines[i]; out.append(L)
    m = re.search(r"<<-?\s*[\x27\"]?([A-Za-z_][A-Za-z0-9_]*)", L)
    if m:
        d = m.group(1); i += 1
        while i < len(lines) and lines[i].strip() != d:
            i += 1
    i += 1
print("\n".join(out))' 2>/dev/null) || cmd_nohd="$cmd"
  [ -z "$cmd_nohd" ] && cmd_nohd="$cmd"

  # Rail 1 — outward / durable
  # NARROWED by founder ruling 2026-09-03 11:25 PM CDT: on autopilot, `git push` and deploy
  # (render/fly/vercel/wrangler) are ALLOWED so the overnight fix->push->deploy->retest loop
  # runs unattended. Still blocked on autopilot: merge, tag, branch delete, stash drop, PR,
  # release, repo edit/delete, and npm publish/version -- durable or publishing acts the
  # founder did not unlock. Off autopilot, the FULL set still asks for his explicit yes.
  if [ -f "$FLAG" ]; then
    if printf '%s' "$cmd_nohd" | grep -qE '(^|[;&|[:space:]])(git[[:space:]]+(merge|tag)|git[[:space:]]+branch[[:space:]]+-[dD]|git[[:space:]]+stash[[:space:]]+(drop|clear)|gh[[:space:]]+(pr|release|repo[[:space:]]+(edit|delete))|npm[[:space:]]+(publish|version))([[:space:]]|$)'; then
      deny "AUTOPILOT RAIL 1 (narrowed 2026-09-03): merge, tag, branch delete, stash drop, PR, release and npm publish/version remain blocked on autopilot. git push and deploy are now allowed per the founder's ruling; use those. For the rest, log it in docs/AUTOPILOT_LOG.md and leave it for the founder."
    fi
  else
    if printf '%s' "$cmd_nohd" | grep -qE '(^|[;&|[:space:]])(git[[:space:]]+(push|merge|tag)|git[[:space:]]+branch[[:space:]]+-[dD]|git[[:space:]]+stash[[:space:]]+(drop|clear)|gh[[:space:]]+(pr|release|repo[[:space:]]+(edit|delete))|npm[[:space:]]+(publish|version)|(render|flyctl|fly|vercel|wrangler)[[:space:]]+(deploy|launch|publish|up))([[:space:]]|$)'; then
      ask "FOUNDER RAIL: this is an outward or durable action — needs the founder's explicit yes."
    fi
  fi

  [ -f "$FLAG" ] || exit 0

  # Rail 2 — destructive / history-rewriting
  if printf '%s' "$cmd_nohd" | grep -qE '(^|[;&|[:space:]])(rm|rmdir|sudo|sed|mv|cp|tee|dd|chmod|chown|mkfs)[[:space:]]|(^|[;&|[:space:]])git[[:space:]]+(reset|checkout|rebase|clean)([[:space:]]|$)'; then
    deny "AUTOPILOT RAIL 2: this command class (rm/sed/mv/cp/tee/chmod/dd/git reset|checkout|rebase|clean) would raise a founder prompt and freeze the lane. Rephrase and continue: Read/Edit/Write for file changes, grep or awk for read-only extraction, python3 for copies or moves into a rejected/ folder. If the exact form is genuinely required, PARK it in docs/AUTOPILOT_LOG.md and move on."
  fi
  allow
fi

[ -f "$FLAG" ] || exit 0
case "$tool" in
  Edit|Write|NotebookEdit)
    fp=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // ""')
    case "$fp" in
      *..*) exit 0 ;;
      "$PROJ/.claude/"*|.claude/*|"$PROJ/CLAUDE.md"|CLAUDE.md) exit 0 ;;
      *) allow ;;
    esac ;;
  *) allow ;;
esac
