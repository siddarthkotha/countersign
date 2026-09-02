#!/bin/bash
# review-model-guard.sh — founder rule 2026-07-01: review agents NEVER run on Opus or Fable.
# Mechanical enforcement of the CLAUDE.md Operating Contract (prose rules drift; hooks don't):
# PreToolUse on Agent/Task/Workflow. Any launch whose text looks like REVIEW work must carry an
# explicit small-model pin (sonnet/haiku). Explicit opus/fable on review work is blocked; a
# review launch with NO pin is also blocked (it would silently inherit the session model —
# Fable/Opus — which is exactly how reviews got expensive). Non-review launches are untouched.
# Exit 0 = allow · exit 2 = block (stderr shown to the model so it can fix the call).

INPUT="$(cat)"

TOOL="$(printf '%s' "$INPUT" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[A-Za-z]*"' | head -1 | grep -o '"[A-Za-z]*"$' | tr -d '"')"
case "$TOOL" in
  Agent|Task|Workflow) ;;
  *) exit 0 ;;
esac

TEXT="$INPUT"

# Workflow may reference a script on disk instead of inline text — include its contents in the scan.
SCRIPT_PATH="$(printf '%s' "$INPUT" | grep -o '"scriptPath"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | grep -o '"[^"]*"$' | tr -d '"')"
if [ -n "$SCRIPT_PATH" ] && [ -f "$SCRIPT_PATH" ]; then
  TEXT="$TEXT
$(cat "$SCRIPT_PATH")"
fi

LOWER="$(printf '%s' "$TEXT" | tr '[:upper:]' '[:lower:]')"

# Review-shaped work? (code review, security review, verify-findings passes, reviewer agents)
# H15 (review 2026-07-31, fixed #155 2026-08-03): the same work described WITHOUT the word
# "review" — audit, critique, double-check, look over, assess-and-verdict, safe-to-merge —
# sailed past the guard and inherited the session model. The classifier now covers the
# synonyms. Overmatch is aligned with the routing law (audits are Sonnet work anyway);
# a rare false positive just needs an explicit sonnet/haiku pin to pass.
if ! printf '%s' "$LOWER" | grep -qE '(code[ -]?review|security[ -]?review|[^a-z]review(er|s)?[^a-z]|adversarial(ly)? verif|verify.{0,20}finding|[^a-z]audit(or|ing|ed|s)?[^a-z]|[^a-z]critiqu(e|ing)|double[ -]?check.{0,40}(code|diff|change|pr|commit)|look over the (code|diff|change|pr)|[^a-z]assess.{0,60}(code|diff|change|pr|merge|quality|correctness)|verdict.{0,60}(merge|code|change|safe)|safe to merge|code quality)'; then
  exit 0
fi

# Explicit big model on review work → block.
if printf '%s' "$LOWER" | grep -qE '"model"[[:space:]]*:[[:space:]]*"(opus|fable)"|model:[[:space:]]*['"'"'"](opus|fable)['"'"'"]'; then
  echo "BLOCKED by review-model-guard: review agents never run on Opus/Fable (founder rule 2026-07-01, CLAUDE.md Operating Contract). Pin model:'sonnet' (or 'haiku') on this launch." >&2
  exit 2
fi

# Review work with NO small-model pin → would inherit the session model (Fable/Opus) → block.
if ! printf '%s' "$LOWER" | grep -qE '"model"[[:space:]]*:[[:space:]]*"(sonnet|haiku)"|model:[[:space:]]*['"'"'"](sonnet|haiku)['"'"'"]'; then
  echo "BLOCKED by review-model-guard: this looks like review work with no model pin — it would inherit the session model (Opus/Fable). Add model:'sonnet' to every review agent (founder rule 2026-07-01)." >&2
  exit 2
fi

exit 0
