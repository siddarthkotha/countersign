#!/bin/bash
# post-compact-context.sh — Countersign adaptation (2026-09-01) of an earlier project's S165 re-grounding injector.
cat <<'JSON'
{
  "hookSpecificOutput": {
    "hookEventName": "PostCompact",
    "additionalContext": "COMPACTION JUST OCCURRED — mandatory re-grounding (founder rule):\n1. Re-read CLAUDE.md, docs/BRIEF.md §15-§16, and the active SDD ledger (.superpowers/sdd/*/progress.md) plus docs/AUTOPILOT_LOG.md if autopilot is ON, before continuing any work.\n2. Treat EVERY remembered file/line/code claim from before compaction as UNVERIFIED — re-read the real source (Audit 0). Trust `git log` and the ledger over your own recollection; never re-dispatch a task the ledger marks complete.\n3. Check the tail of .claude/compaction-log.txt for the exact pre-compaction working-tree snapshot.\n4. If mid-task: re-run `npm test` and `npm run typecheck` before building further. Nothing is done without a green executable test importing the real engine.\n5. Do NOT re-decide anything the founder already decided (BRIEF §16 D1-D5 are law).\n6. Standing rails: commits on main are fine; no push/merge/PR/publish/deploy without the founder; no detection claims; STAGE is the ceiling; every number labeled PROVEN/ESTIMATE/UNKNOWN; every reply carries the local time."
  }
}
JSON
exit 0
