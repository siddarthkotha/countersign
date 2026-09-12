#!/bin/bash
# usage-ledger.sh — per-session delegation + rig ledger (an earlier project pattern, founder ask 2026-07-22;
# brought to Countersign 2026-09-01). PostToolUse on Agent|Task|Workflow: count agents by pinned
# model tier (+ tokens when the result carries them). PostToolUse on Bash: count Mac runs vs git
# vs gh, and attribute the GitHub PROJECT engaged (vitest, vite, tsx, typescript, playwright,
# assemblyai, render). PostToolUse on Skill: record the plugin:skill used.
INPUT="$(cat)"
DIR="${CLAUDE_PROJECT_DIR:-.}/.claude/session-usage"
mkdir -p "$DIR" 2>/dev/null || exit 0
SID=$(printf '%s' "$INPUT" | jq -r '.session_id // "unknown"' 2>/dev/null)
[ -z "$SID" ] && exit 0
LEDGER="$DIR/$SID.json"
{ [ -s "$LEDGER" ] && jq -e . "$LEDGER" >/dev/null 2>&1; } || echo '{"delegated":{},"tiers":{},"agents":0,"mac_runs":0,"git_runs":0,"gh_runs":0,"gh_repos":{}}' > "$LEDGER"

bump() { jq "$1" "$LEDGER" > "$LEDGER.tmp" 2>/dev/null && mv -f "$LEDGER.tmp" "$LEDGER" 2>/dev/null; }

TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)
case "$TOOL" in
  Bash)
    CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)
    REPO=""
    case "$CMD" in
      *vitest*|*"npm test"*|*"npm run test"*) REPO="vitest" ;;
      *"npm run build"*|*"npm run dev"*|*" vite"*|*vite\ *) REPO="vite" ;;
      *"npx tsx"*|*" tsx "*|*"npm run replay"*) REPO="tsx" ;;
      *"npm run typecheck"*|*" tsc"*) REPO="typescript" ;;
      *playwright*) REPO="playwright" ;;
      *assemblyai.com*|*ASSEMBLYAI*) REPO="assemblyai" ;;
      *render.com*|*"render "*) REPO="render" ;;
    esac
    [ -n "$REPO" ] && bump ".gh_repos[\"$REPO\"] = ((.gh_repos[\"$REPO\"] // 0) + 1)"
    if printf '%s' "$CMD" | grep -qE '(^|[;&|[:space:]])gh[[:space:]]'; then
      bump '.gh_runs = ((.gh_runs // 0) + 1)'
    elif printf '%s' "$CMD" | grep -qE '(^|[;&|[:space:]])git[[:space:]]'; then
      bump '.git_runs = ((.git_runs // 0) + 1)'
    else
      bump '.mac_runs = ((.mac_runs // 0) + 1)'
    fi
    ;;
  Skill)
    SK=$(printf '%s' "$INPUT" | jq -r '.tool_input.skill // ""' 2>/dev/null)
    if [ -n "$SK" ]; then
      KEY=$(printf '%s' "$SK" | awk -F: '{ if (NF>1) print $1 ":" $NF; else print "skill:" $1 }')
      bump ".gh_repos[\"$KEY\"] = ((.gh_repos[\"$KEY\"] // 0) + 1)"
    fi
    ;;
  Agent|Task|Workflow)
    MODEL=$(printf '%s' "$INPUT" | jq -r '.tool_input.model // "inherit"' 2>/dev/null)
    TOK=$(printf '%s' "$INPUT" | jq -r '.tool_response | tostring' 2>/dev/null | grep -oE 'subagent_tokens[>: ]+[0-9]+' | grep -oE '[0-9]+' | head -1)
    [ -z "$TOK" ] && TOK=0
    bump ".agents = ((.agents // 0) + 1) | .delegated[\"$MODEL\"] = ((.delegated[\"$MODEL\"] // 0) + $TOK) | .tiers[\"$MODEL\"] = ((.tiers[\"$MODEL\"] // 0) + 1)"
    ;;
esac
exit 0
