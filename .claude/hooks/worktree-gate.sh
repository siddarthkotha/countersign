#!/usr/bin/env bash
# ============================================================
# worktree-gate.sh — PreToolUse hook on Agent/Task launches, founder ruling
# 2026-09-03 10:38 PM CDT: "a shared file is a reason to ISOLATE the lane in a
# git worktree, never to wait." Tonight the orchestrator serialized two fixes
# because they touched the same file, citing an earlier same-file collision as
# the reason to wait. That was wrong: two worktree lanes on the same file both
# came back green in parallel. This hook makes the correct move mechanical.
#
# CONTRACT:
#   1. PASS silently for any tool that isn't Agent/Task.
#   2. PASS when: isolation:"worktree" is set; OR the prompt carries a
#      read-only marker (read-only, "do not edit any file", subagent_type
#      Explore/errand); OR the prompt declares `LANE-FILES: <globs>` and none
#      of those globs overlap a currently RUNNING lane's files in
#      .claude/backlog.json.
#   3. BLOCK (permissionDecision "deny") when: the prompt has neither
#      LANE-FILES nor a read-only marker and no worktree isolation; OR
#      LANE-FILES overlaps a running lane's files and isolation isn't
#      "worktree" — the reason names the colliding lane and says: use a
#      worktree, don't serialize.
#
# Fail-safe: any parse problem (malformed JSON, missing backlog.json, etc.)
# exits 0 silently — same contract as lane-gate.sh and agent-model-guard.sh.
# Loop-safe: this hook never re-triggers itself (PreToolUse, not Stop).
# ============================================================
set -uo pipefail

IN=$(cat 2>/dev/null) || exit 0
[ -n "$IN" ] || exit 0

export WORKTREE_GATE_JSON="$IN"
python3 <<'PYEOF' 2>/dev/null || exit 0
import sys, json, re, os

try:
    hook = json.loads(os.environ.get("WORKTREE_GATE_JSON", ""))
except Exception:
    sys.exit(0)

if not isinstance(hook, dict):
    sys.exit(0)

tool = hook.get("tool_name") or ""
if tool not in ("Agent", "Task"):
    sys.exit(0)

tool_input = hook.get("tool_input")
if not isinstance(tool_input, dict):
    tool_input = {}

prompt = tool_input.get("prompt")
prompt = prompt if isinstance(prompt, str) else ""
isolation = tool_input.get("isolation")
isolation = isolation if isinstance(isolation, str) else ""
subagent_type = tool_input.get("subagent_type")
subagent_type = subagent_type if isinstance(subagent_type, str) else ""


def deny(reason):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }))
    sys.exit(0)


# --- PASS: worktree isolation already requested. ---
if isolation.strip().lower() == "worktree":
    sys.exit(0)

# --- PASS: read-only marker. ---
low_prompt = prompt.lower()
low_subagent = subagent_type.strip().lower()
READONLY_SUBSTRINGS = ("read-only", "do not edit any file")
if any(marker in low_prompt for marker in READONLY_SUBSTRINGS):
    sys.exit(0)
if low_subagent in ("explore", "errand"):
    sys.exit(0)

# --- Require a LANE-FILES: declaration from here on. ---
m = re.search(r"^[ \t]*LANE-FILES:[ \t]*(.+)$", prompt, re.M | re.I)
NO_DECL = (
    "worktree-gate: declare `LANE-FILES: <globs>` in the prompt, or mark it "
    "READ-ONLY, or launch with isolation: \"worktree\""
)
if not m:
    deny(NO_DECL)

globs = [g for g in re.split(r"[,\s]+", m.group(1).strip()) if g]
if not globs:
    deny(NO_DECL)

SUFFIXES = ("/**", "/*", "**", "*")


def normalize(glob):
    g = glob.strip()
    for suf in SUFFIXES:
        if g.endswith(suf):
            g = g[: -len(suf)]
            break
    if g.startswith("**/"):
        g = g[3:]
    return g.rstrip("/")


def overlaps(a, b):
    pa = [p for p in normalize(a).split("/") if p]
    pb = [p for p in normalize(b).split("/") if p]
    if not pa or not pb:
        return True  # wildcard-only glob normalizes to nothing: conservative overlap
    n = min(len(pa), len(pb))
    return pa[:n] == pb[:n]


try:
    backlog_path = os.path.join(
        os.environ.get("CLAUDE_PROJECT_DIR", "."), ".claude", "backlog.json"
    )
    with open(backlog_path, "r") as f:
        backlog = json.load(f)
    items = backlog.get("items")
    if not isinstance(items, list):
        items = []
except Exception:
    items = []

for item in items:
    if not isinstance(item, dict) or item.get("status") != "running":
        continue
    files = item.get("files")
    if not isinstance(files, list) or not files:
        continue
    for lane_file in files:
        if not isinstance(lane_file, str) or not lane_file:
            continue
        for prompt_glob in globs:
            if overlaps(prompt_glob, lane_file):
                lane_id = item.get("id", "?")
                lane_title = item.get("title", "")
                deny(
                    f"worktree-gate: LANE-FILES overlaps running lane {lane_id} "
                    f"({lane_title}) on `{lane_file}` — same file is not a "
                    "dependency: relaunch with isolation: \"worktree\" (merge "
                    "order stated in the reply), never serialize"
                )

sys.exit(0)
PYEOF
exit 0
