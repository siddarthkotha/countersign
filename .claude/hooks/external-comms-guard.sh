#!/bin/bash
# external-comms-guard.sh — Countersign adaptation (2026-09-01) of ShadePath's SHA-51 rule, per BRIEF §15:
# "nothing published or linked without his word." PreToolUse on outbound-capable tools (Artifact publish,
# email send/reply/forward/draft, social posts). On autopilot: DENY (nothing leaves the building unattended).
# Off autopilot: ASK — the founder sees exactly what is about to go out. SendUserFile (to the founder himself)
# and PushNotification pass. exit 0 = allow / decision JSON on stdout.
INPUT="$(cat)"
TOOL="$(printf '%s' "$INPUT" | jq -r '.tool_name // ""')"
PROJ="${CLAUDE_PROJECT_DIR:-.}"
case "$TOOL" in
  Artifact)
    ACTION="$(printf '%s' "$INPUT" | jq -r '.tool_input.action // "publish"')"
    case "$ACTION" in publish|reply|resolve|write_db|upload_asset|delete_asset) ;; *) exit 0 ;; esac ;;
  *Gmail__send*|*Gmail__reply*|*Gmail__forward*|*Gmail__create_draft*|*Gmail__update_draft*) ;;
  *Buffer__create_post*|*Buffer__edit_post*|*Buffer__create_idea*|*Buffer__execute_mutation*) ;;
  *Canva__publish*|*Google_Drive__share_file*) ;;
  *) exit 0 ;;
esac
if [ -f "$PROJ/.claude/autopilot.on" ]; then
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"external-comms-guard: nothing is published, posted, sent, or shared on autopilot (BRIEF §15: nothing outward without the founder'"'"'s word). Write the artifact locally, log it in docs/AUTOPILOT_LOG.md, and let the founder send it."}}'
else
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"external-comms-guard: this leaves the building (publish / send / post / share). Founder'"'"'s explicit yes required (BRIEF §15)."}}'
fi
exit 0
