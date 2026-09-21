#!/usr/bin/env bash
# ============================================================
# worktree-cap.sh — PreToolUse hook on Agent/Task (isolation: "worktree") and
# on Bash commands that run `git worktree add`. Founder ruling 2026-09-21
# 8:56 AM CDT: "we need to add a mechanical hook that prevents future mess
# like this" — 110 leftover sandboxes, 14 GB, 5.7 GB free.
#
# CONTRACT:
#   1. PASS silently for anything that does not create a sandbox: Agent/Task
#      without isolation "worktree", Bash commands without `git worktree add`,
#      every other tool.
#   2. DENY when the number of folders under .claude/worktrees is already at
#      or above WORKTREE_CAP (default 6). The reason names the sandboxes and
#      says how to clear them (the sweep hook removes clean ones over 2h old
#      by itself; dirty ones need a commit or a discard).
#   3. DENY when free disk on the project volume is below WORKTREE_FLOOR_GB
#      (default 10). Each sandbox costs ~150 MB of installed packages.
#
# Fail-safe: any parse problem exits 0 silently — same contract as
# worktree-gate.sh. Loop-safe: PreToolUse only, never re-triggers itself.
# ============================================================
set -uo pipefail

IN=$(cat 2>/dev/null) || exit 0
[ -n "$IN" ] || exit 0

export CAP_HOOK_JSON="$IN"
export CAP_PROJ="${CLAUDE_PROJECT_DIR:-.}"
export CAP_MAX="${WORKTREE_CAP:-6}"
export CAP_FLOOR_GB="${WORKTREE_FLOOR_GB:-10}"

python3 <<'PYEOF' 2>/dev/null || exit 0
import json, os, re, shutil, sys

try:
    hook = json.loads(os.environ.get("CAP_HOOK_JSON", ""))
except Exception:
    sys.exit(0)
if not isinstance(hook, dict):
    sys.exit(0)

tool = hook.get("tool_name") or ""
ti = hook.get("tool_input")
ti = ti if isinstance(ti, dict) else {}

creates_sandbox = False
if tool in ("Agent", "Task"):
    iso = ti.get("isolation")
    creates_sandbox = isinstance(iso, str) and iso.strip().lower() == "worktree"
elif tool == "Bash":
    cmd = ti.get("command")
    cmd = cmd if isinstance(cmd, str) else ""
    creates_sandbox = re.search(r"(^|[;&|\s])git\s+worktree\s+add(\s|$)", cmd) is not None
if not creates_sandbox:
    sys.exit(0)

proj = os.environ.get("CAP_PROJ", ".")
try:
    cap = int(os.environ.get("CAP_MAX", "6"))
except Exception:
    cap = 6
try:
    floor_gb = float(os.environ.get("CAP_FLOOR_GB", "10"))
except Exception:
    floor_gb = 10.0


def deny(reason):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }))
    sys.exit(0)


root = os.path.join(proj, ".claude", "worktrees")
names = []
if os.path.isdir(root):
    names = sorted(n for n in os.listdir(root) if os.path.isdir(os.path.join(root, n)))

if len(names) >= cap:
    shown = ", ".join(names[:8]) + ("…" if len(names) > 8 else "")
    deny(
        f"worktree-cap: {len(names)} sandboxes already exist under .claude/worktrees "
        f"(cap {cap}): {shown}. Clear finished lanes first — the sweep hook removes "
        "clean sandboxes older than 2h on its own; a dirty one needs its uncommitted "
        "files committed or discarded, then `git worktree remove --force <path>`. "
        "Then relaunch."
    )

try:
    free_gb = shutil.disk_usage(proj).free / 1e9
except Exception:
    free_gb = None

if free_gb is not None and free_gb < floor_gb:
    deny(
        f"worktree-cap: only {free_gb:.1f} GB free on this disk (floor {floor_gb:g} GB). "
        "Each sandbox costs ~150 MB. Free space before launching a lane; park the "
        "lane in docs/AUTOPILOT_LOG.md if it cannot wait."
    )

sys.exit(0)
PYEOF
exit 0
