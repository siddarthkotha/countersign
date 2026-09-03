#!/usr/bin/env bash
# ============================================================
# agent-watchdog.sh — Stop + UserPromptSubmit hook, founder task H1 (2026-09-02).
#
# RULE (founder orchestration law): "any agent that stalls is a re-orchestration
# trigger, not a status to relay." Today an agent stalled for an hour unnoticed.
#
# MECHANICAL FORM: for every .claude/backlog.json item with status "running" and a
# non-empty agent_id, look for that agent's task-output file. If its mtime is more
# than 20 minutes old, the lane is STALLED:
#   - on Stop: block once, naming the stalled lane(s) and telling the founder to
#     stop-and-re-dispatch or mark the item done/held.
#   - on UserPromptSubmit: never block a founder prompt — just surface the same
#     warning as additionalContext so it's visible without interrupting typing.
#
# Output file location: /private/tmp/claude-501/-Users-siddarthkotha-countersign/
#   <session_id>/tasks/<agent_id>.output ; if that exact path is missing, fall back
#   to globbing .../*/tasks/<agent_id>.output (agent may have been dispatched from a
#   different session id than the one currently running).
#
# TEST OVERRIDE: set AGENT_WATCHDOG_TASKS_ROOT to point the whole lookup at a fake
# tasks root (used by pipe-tests; never set in real settings.json).
#
# CONTRACT (copied from ambition-pass-gate / lane-gate): fail-safe — any parse
# problem exits 0 silently. Loop-safe — stop_hook_active=true passes through on Stop.
# ============================================================
set -uo pipefail

IN=$(cat 2>/dev/null) || exit 0
[ -n "$IN" ] || exit 0

export WATCHDOG_HOOK_JSON="$IN"
export WATCHDOG_PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
python3 <<'PYEOF' 2>/dev/null || exit 0
import sys, json, os, glob, time

try:
    hook = json.loads(os.environ.get("WATCHDOG_HOOK_JSON", ""))
except Exception:
    sys.exit(0)

if not isinstance(hook, dict):
    sys.exit(0)

# Figure out which event fired us. Prefer the explicit field; fall back to
# event-specific fields present in the payload (mirrors how the other hooks in
# this repo already key off stop_hook_active / prompt without a shared helper).
event = hook.get("hook_event_name") or hook.get("hookEventName") or ""
if not event:
    if "prompt" in hook:
        event = "UserPromptSubmit"
    elif "stop_hook_active" in hook:
        event = "Stop"

if event == "Stop" and hook.get("stop_hook_active"):
    sys.exit(0)  # loop-safe: don't re-block our own re-invocation

project_dir = os.environ.get("WATCHDOG_PROJECT_DIR", ".")
backlog_path = os.path.join(project_dir, ".claude", "backlog.json")

try:
    with open(backlog_path, "r") as f:
        backlog = json.load(f)
    items = backlog.get("items")
    if not isinstance(items, list):
        items = []
except Exception:
    items = []

session_id = hook.get("session_id") or ""
tasks_root = os.environ.get(
    "AGENT_WATCHDOG_TASKS_ROOT",
    "/private/tmp/claude-501/-Users-siddarthkotha-countersign",
)

STALE_SECONDS = 20 * 60
now = time.time()
stalled = []  # list of (title, minutes_idle)

for it in items:
    if not isinstance(it, dict):
        continue
    if it.get("status") != "running":
        continue
    agent_id = str(it.get("agent_id") or "").strip()
    if not agent_id:
        continue
    title = it.get("title") or it.get("id") or "(untitled)"

    candidates = []
    if session_id:
        primary = os.path.join(tasks_root, session_id, "tasks", f"{agent_id}.output")
        if os.path.isfile(primary):
            candidates.append(primary)
    if not candidates:
        try:
            candidates = [
                p for p in glob.glob(os.path.join(tasks_root, "*", "tasks", f"{agent_id}.output"))
                if os.path.isfile(p)
            ]
        except Exception:
            candidates = []

    if not candidates:
        # No output file yet — can't judge staleness (agent may just have started).
        continue

    try:
        newest = max(candidates, key=lambda p: os.path.getmtime(p))
        mtime = os.path.getmtime(newest)
    except Exception:
        continue

    age = now - mtime
    if age > STALE_SECONDS:
        stalled.append((title, int(age // 60)))

if not stalled:
    sys.exit(0)

msg_parts = [
    f"lane {title} stalled: {mins} min without output — stop it and re-dispatch, or mark it done/held"
    for title, mins in stalled
]
warning = " | ".join(msg_parts)

if event == "UserPromptSubmit":
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": f"[agent-watchdog] {warning}",
        }
    }))
    sys.exit(0)

# Default / Stop: block once.
print(json.dumps({
    "decision": "block",
    "reason": f"agent-watchdog: {warning}",
}))
sys.exit(0)
PYEOF
exit 0
