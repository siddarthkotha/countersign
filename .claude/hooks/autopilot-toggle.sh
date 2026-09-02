#!/bin/bash
# autopilot-toggle.sh — ported from ShadePath (S165) to Countersign 2026-09-01 (founder ask 10:44 PM CDT).
# UserPromptSubmit hook: the founder types "autopilot start" / "autopilot stop" (or "start/stop
# autopilot") as a standalone clause and this flips the flag file autopilot-guard.sh reads on every
# tool call. Mechanical; no tool calls.
# While the flag exists: work auto-approves; hard rails stay: no push, merge, PR, release, publish,
# deploy, or edits to .claude/ or CLAUDE.md. Commits on main ARE allowed here (Countersign law:
# incremental commits on main are the submission story) — push is the outward act and stays railed.
input=$(cat)
prompt=$(printf '%s' "$input" | jq -r '.prompt // ""')
FLAG="${CLAUDE_PROJECT_DIR:-.}/.claude/autopilot.on"

if printf '%s' "$prompt" | grep -qiE '(^|[[:space:][:punct:]])(autopilot[[:space:]]+(start|on)|start[[:space:]]+autopilot)[[:space:]]*([.!?;]|$)'; then
  touch "$FLAG"
  printf '%s' '{"systemMessage":"🚀 AUTOPILOT ENGAGED — Claude works without permission prompts. Hard rails stay on: no push/merge/PR/release/publish/deploy, no destructive commands, no edits to .claude/ or CLAUDE.md. Local commits on main are allowed. Confidence gate: not 100% sure = research or park, never guess. Say \"autopilot stop\" to disengage.","hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"AUTOPILOT is now ON (flag file created). Work autonomously: tool calls auto-approve (edits in packages/ docs/ tests, npm test/typecheck/build, tsx scripts, subagents). HARD RAILS (hook-denied, do not attempt): git push, git merge/tag, gh pr/release, npm publish, render/fly/vercel deploy commands, destructive shell (rm/mv/cp/sed/tee/chmod/dd) and history-rewriting git; edits to .claude/ or CLAUDE.md fall through to normal prompts. Countersign laws still bind: nothing is done without a green test importing the real engine; every number labeled PROVEN/ESTIMATE/UNKNOWN; no detection claims; STAGE is the ceiling. CONFIDENCE GATE: before each item, if you are not absolutely sure of the approach or a fact, read the real source or verify against live docs first; if doubt remains, PARK the item in docs/AUTOPILOT_LOG.md for the founder and move on. UI/UX: build only founder-approved looks (BRIEF §15/§16); never invent visual decisions on autopilot; park realistic options instead. WORK LOG: append every completed or parked item to docs/AUTOPILOT_LOG.md with the local time, gates run (npm test / typecheck / review), confidence, and what remains. Same fix failing twice = park it. When blocked or when a deliverable is ready for the founder, notify via PushNotification if available, then continue with the next item or wrap up cleanly. The founder will say autopilot stop when back."}}'
  exit 0
fi

if printf '%s' "$prompt" | grep -qiE '(^|[[:space:][:punct:]])(autopilot[[:space:]]+(stop|off)|stop[[:space:]]+autopilot)[[:space:]]*([.!?;]|$)'; then
  rm -f "$FLAG"
  printf '%s' '{"systemMessage":"🛑 AUTOPILOT DISENGAGED — normal approval mode. Pushes and outward actions ask the founder explicitly.","hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"AUTOPILOT is now OFF (flag file removed). Resume normal founder-approval mode. Give the founder a plain-English summary of everything done during autopilot, with the local time: what was built, which gates passed or failed, what is ready to look at, what was parked and why."}}'
  exit 0
fi

if [ -f "$FLAG" ]; then
  printf '%s' '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"[Reminder: AUTOPILOT is ON — no permission prompts; push/merge/PR/release/publish/deploy, destructive commands and .claude//CLAUDE.md edits are hook-denied. Founder says autopilot stop to disengage.]"}}'
fi
exit 0
