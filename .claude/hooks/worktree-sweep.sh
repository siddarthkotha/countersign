#!/usr/bin/env bash
# ============================================================
# worktree-sweep.sh — SubagentStop / Stop / SessionStart hook, founder ruling
# 2026-09-21 8:56 AM CDT: "we need to add a mechanical hook that prevents future
# mess like this." That morning 110 finished lane sandboxes (git worktrees under
# .claude/worktrees, ~144 MB each = 14 GB) sat on a laptop with 5.7 GB free.
# Nobody removed them because no rule did. This hook makes removal mechanical.
#
# CONTRACT:
#   1. `git worktree prune` first (drops registrations whose folder is gone).
#   2. For every folder under .claude/worktrees/:
#        - SKIP if it belongs to a lane that .claude/backlog.json marks
#          "running" (folder name agent-<agent_id>).
#        - SKIP (and report) if DIRTY: `git status --porcelain` is non-empty,
#          i.e. uncommitted edits or untracked non-ignored files. A dirty
#          sandbox is never deleted by a machine; the orchestrator commits or
#          discards, and worktree-cap.sh blocks new lanes until it does.
#        - SKIP if YOUNG: last activity (folder mtime, .git file mtime, last
#          commit time, whichever is latest) is under WORKTREE_SWEEP_MAX_AGE_MIN
#          minutes ago (default 120) — a lane that just finished may still be
#          read by the orchestrator while its fix is re-applied on main.
#        - REMOVE otherwise: `git worktree remove --force <path>`. Branch
#          commits are untouched (they live in the main .git), only the
#          folder and its node_modules/dist copies go.
#   3. Every removal is appended to .claude/worktree-sweep.log (evidence).
#   4. On Stop, if dirty sandboxes remain, emit a non-blocking systemMessage
#      naming them. Never blocks a reply — the cap hook is the hard guard.
#
# Env: WORKTREE_SWEEP_DRY_RUN=1 lists what would be removed and removes nothing.
# Hold: while the file .claude/worktree-sweep.hold exists the sweep removes
#   nothing and stays silent (the founder's pending decision on 2026-09-21).
#   Delete the hold file to arm it.
# Fail-safe: any error exits 0 silently, same contract as the other hooks.
# Loop-safe: never launches anything; Stop output is non-blocking.
# ============================================================
set -uo pipefail

IN=$(cat 2>/dev/null) || IN=""
export SWEEP_HOOK_JSON="$IN"
export SWEEP_PROJ="${CLAUDE_PROJECT_DIR:-.}"
export SWEEP_DRY_RUN="${WORKTREE_SWEEP_DRY_RUN:-0}"
export SWEEP_MAX_AGE_MIN="${WORKTREE_SWEEP_MAX_AGE_MIN:-120}"

python3 <<'PYEOF' 2>/dev/null || exit 0
import json, os, subprocess, sys, time, datetime

proj = os.environ.get("SWEEP_PROJ", ".")
dry = os.environ.get("SWEEP_DRY_RUN", "0") == "1"
try:
    max_age_min = float(os.environ.get("SWEEP_MAX_AGE_MIN", "120"))
except Exception:
    max_age_min = 120.0

try:
    hook = json.loads(os.environ.get("SWEEP_HOOK_JSON", "") or "{}")
except Exception:
    hook = {}
event = hook.get("hook_event_name", "") if isinstance(hook, dict) else ""

root = os.path.join(proj, ".claude", "worktrees")
if not os.path.isdir(root):
    sys.exit(0)
if os.path.exists(os.path.join(proj, ".claude", "worktree-sweep.hold")) and not dry:
    sys.exit(0)


def git(*args, cwd=proj, timeout=60):
    r = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True, timeout=timeout)
    return r.returncode, r.stdout, r.stderr


# 1. prune stale registrations
try:
    git("worktree", "prune")
except Exception:
    pass

# running lanes from the backlog
running_ids = set()
try:
    with open(os.path.join(proj, ".claude", "backlog.json")) as f:
        for it in json.load(f).get("items", []):
            if isinstance(it, dict) and it.get("status") == "running":
                aid = it.get("agent_id")
                if isinstance(aid, str) and aid.strip():
                    running_ids.add(aid.strip())
except Exception:
    pass

now = time.time()
removed, dirty, young, skipped = [], [], [], []

for name in sorted(os.listdir(root)):
    path = os.path.join(root, name)
    if not os.path.isdir(path):
        continue
    if any(name == f"agent-{aid}" for aid in running_ids):
        skipped.append(name)
        continue
    try:
        rc, out, _ = git("status", "--porcelain", cwd=path)
    except Exception:
        skipped.append(name)
        continue
    if rc != 0:
        skipped.append(name)
        continue
    if out.strip():
        dirty.append(name)
        continue
    stamps = []
    try:
        stamps.append(os.stat(path).st_mtime)
        dotgit = os.path.join(path, ".git")
        if os.path.exists(dotgit):
            stamps.append(os.stat(dotgit).st_mtime)
        rc, ct, _ = git("log", "-1", "--format=%ct", cwd=path)
        if rc == 0 and ct.strip():
            stamps.append(float(ct.strip()))
    except Exception:
        pass
    age_min = (now - max(stamps)) / 60.0 if stamps else 0.0
    if age_min < max_age_min:
        young.append(name)
        continue
    if dry:
        removed.append(name)
        continue
    ok = False
    try:
        rc, _, _ = git("worktree", "remove", "--force", path, timeout=300)
        ok = rc == 0 and not os.path.exists(path)
    except Exception:
        ok = False
    if not ok:
        try:
            import shutil
            shutil.rmtree(path, ignore_errors=True)
            git("worktree", "prune")
            ok = not os.path.exists(path)
        except Exception:
            ok = False
    if ok:
        removed.append(name)
    else:
        skipped.append(name)

# 3. evidence log
if removed and not dry:
    try:
        with open(os.path.join(proj, ".claude", "worktree-sweep.log"), "a") as f:
            stamp = datetime.datetime.now().astimezone().strftime("%Y-%m-%d %H:%M %Z")
            f.write(f"{stamp} event={event or '-'} removed={len(removed)} kept_dirty={len(dirty)} kept_young={len(young)} :: {' '.join(removed)}\n")
    except Exception:
        pass

# 4. output
if dry:
    print(json.dumps({"dry_run": True, "would_remove": removed, "dirty": dirty, "young": young, "skipped": skipped}))
    sys.exit(0)

if event == "Stop" and dirty:
    print(json.dumps({
        "systemMessage": (
            f"worktree-sweep: {len(dirty)} dirty sandbox(es) kept under .claude/worktrees "
            f"({', '.join(dirty[:6])}{'…' if len(dirty) > 6 else ''}) — commit or discard their "
            "uncommitted files; worktree-cap blocks new lanes while they pile up."
        )
    }))
sys.exit(0)
PYEOF
exit 0
