#!/bin/bash
# agent-model-guard.sh — ported to Countersign 2026-09-01 (reel-lane rule 3c dropped: not applicable). Founder law 2026-07-20 (Question & Task Routing by Criticality):
# EVERY Agent/Task launch must carry an EXPLICIT model pin, and Fable never delegates to
# Fable. Prose rules drift; hooks don't — the founder had to re-prompt the delegation law
# repeatedly, so it is now mechanical:
#   1. No "model" field on an Agent launch → BLOCK (it would silently inherit the session
#      model — Fable — which is exactly how the quota burned).
#   2. model:"fable" → BLOCK always (the orchestrator delegates DOWN, never sideways).
#   3. model:"opus" → allowed ONLY when the prompt carries the deliberate escalation
#      marker OPUS-JUSTIFIED: <reason> — hard reasoning must be a conscious choice.
#   4. model:"sonnet"/"haiku" → allow.
# Workflow launches are exempt from the pin requirement here (their per-agent() pins are
# inside the script body and workflows already require explicit founder opt-in), but the
# fable/opus text scan still applies to inline scripts.
# Exit 0 = allow · exit 2 = block (stderr shown to the model so it can fix the call).

INPUT="$(cat)"

TOOL="$(printf '%s' "$INPUT" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[A-Za-z]*"' | head -1 | grep -o '"[A-Za-z]*"$' | tr -d '"')"
case "$TOOL" in
  Agent|Task) ;;
  Workflow)
    LOWERWF="$(printf '%s' "$INPUT" | tr '[:upper:]' '[:lower:]')"
    if printf '%s' "$LOWERWF" | grep -qE "model:[[:space:]]*['\"]fable['\"]"; then
      echo "BLOCKED by agent-model-guard: workflow agents never pin model:'fable' (founder routing law 2026-07-20). Use sonnet/haiku, or opus with an OPUS-JUSTIFIED: reason." >&2
      exit 2
    fi
    exit 0 ;;
  *) exit 0 ;;
esac

LOWER="$(printf '%s' "$INPUT" | tr '[:upper:]' '[:lower:]')"

# 2. Fable delegation → never.
if printf '%s' "$LOWER" | grep -qE '"model"[[:space:]]*:[[:space:]]*"fable"'; then
  echo "BLOCKED by agent-model-guard: never delegate to Fable (founder routing law 2026-07-20 — the orchestrator delegates DOWN). Pin sonnet or haiku; opus only with OPUS-JUSTIFIED: <reason> in the prompt." >&2
  exit 2
fi

# 3. Opus needs the deliberate marker.
if printf '%s' "$LOWER" | grep -qE '"model"[[:space:]]*:[[:space:]]*"opus"'; then
  if ! printf '%s' "$LOWER" | grep -q 'opus-justified:'; then
    echo "BLOCKED by agent-model-guard: model:'opus' requires a deliberate escalation marker — include OPUS-JUSTIFIED: <one-line reason> in the prompt (founder routing law 2026-07-20). Otherwise pin sonnet/haiku." >&2
    exit 2
  fi
  exit 0
fi

# 3b. Research defaults to HAIKU (founder ruling 2026-07-23, after a price lookup ran on
# Sonnet for 15 min): a research-shaped launch pinned to Sonnet needs a deliberate
# SONNET-JUSTIFIED: <reason> — decision-grade synthesis the founder will act on
# (spend/legal/competitive). Principle: tier follows DIFFICULTY; risk routes to
# approval/rails, never to a bigger delegate. Tripwire, not a fence: keyword-shaped,
# provable via the 13-case proof (.claude/hooks/agent-model-guard-proof.sh).
if printf '%s' "$LOWER" | grep -qE '"model"[[:space:]]*:[[:space:]]*"sonnet"'; then
  if printf '%s' "$LOWER" | grep -qE 'websearch|webfetch|web search|search the web|web tools|deep[- ]research|research (the|this|a |current|latest|what|which|online)|look up (the|current|latest)|current pric|pricing'; then
    if ! printf '%s' "$LOWER" | grep -q 'sonnet-justified:'; then
      echo "BLOCKED by agent-model-guard: research-shaped launch pinned to Sonnet without SONNET-JUSTIFIED (founder ruling 2026-07-23 — research defaults to Haiku/errand preset). If this is decision-grade synthesis the founder will act on (spend/legal/competitive), re-issue with SONNET-JUSTIFIED: <one-line reason> in the prompt; otherwise pin model:'haiku'." >&2
      exit 2
    fi
  fi
  exit 0
fi

# 4. Small pins pass.
if printf '%s' "$LOWER" | grep -qE '"model"[[:space:]]*:[[:space:]]*"(sonnet|haiku)"'; then
  exit 0
fi

# 1. No pin at all → would inherit Fable → block.
echo "BLOCKED by agent-model-guard: this Agent launch has NO model pin — it would inherit the session model (Fable) and burn quota (founder routing law 2026-07-20, CLAUDE.md 'Question & Task Routing by Criticality'). Add model:'haiku' (mechanical), 'sonnet' (analysis/review), or 'opus' with OPUS-JUSTIFIED: <reason>." >&2
exit 2
