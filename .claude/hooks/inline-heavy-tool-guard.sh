#!/bin/bash
# inline-heavy-tool-guard.sh — founder law 2026-09-01 11:03 PM CDT (Countersign; the LinkedIn-post
# scenario): the MAIN session model (Fable) never drives token-heavy surfaces INLINE. Browser
# automation (screenshots, page reads, DOM dumps) and web research return large payloads straight
# into the most expensive context in the loop; one such errand can burn a session's budget.
# PreToolUse on mcp__claude-in-chrome__* | WebSearch | WebFetch. Subagent calls carry "agent_id"
# in the payload and PASS (agents are where this work belongs, model-pinned to haiku/sonnet).
# Main-session calls are DENIED with routing guidance. Escape hatch (mirrors the user-level
# research guard): a single WebFetch the founder explicitly asked for, re-issued with
# FOUNDER-ASKED in its prompt field. No escape for Chrome: delegate, always.
INPUT="$(cat)"
if printf '%s' "$INPUT" | grep -q '"agent_id"'; then exit 0; fi
TOOL="$(printf '%s' "$INPUT" | jq -r '.tool_name // ""')"
case "$TOOL" in
  mcp__claude-in-chrome__*)
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"inline-heavy-tool-guard (founder law 2026-09-01): the main session never drives Chrome inline — screenshots and page reads land in the most expensive context in the loop. Delegate to a model-pinned agent (model: haiku for a lookup/screenshot errand, sonnet for a multi-page walk); agents pass this guard. State the split to the founder."}}'
    exit 0 ;;
  WebSearch|WebFetch)
    if [ "$TOOL" = "WebFetch" ] && printf '%s' "$INPUT" | grep -q 'FOUNDER-ASKED'; then exit 0; fi
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"inline-heavy-tool-guard (founder law 2026-09-01): web research never runs inline in the main session. Spawn a model-pinned agent (haiku: single-fact lookups; sonnet: multi-source synthesis with SONNET-JUSTIFIED). Exception: a URL the founder explicitly asked to fetch — re-issue the WebFetch with FOUNDER-ASKED in its prompt field."}}'
    exit 0 ;;
esac
exit 0
