#!/usr/bin/env bash
# ============================================================
# worktree-sweep.test.sh — tests for .claude/hooks/worktree-sweep.sh (founder
# ruling 2026-09-21). Builds a throwaway git repo with real worktrees under
# .claude/worktrees, ages them with touch/commit dates, runs the hook with
# CLAUDE_PROJECT_DIR pointed at the throwaway repo, and asserts which folders
# survive. The real repo is never read or touched.
# Run: bash .claude/hooks/test/worktree-sweep.test.sh
# ============================================================
set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/worktree-sweep.sh"
WORKDIR=$(python3 -c 'import tempfile; print(tempfile.mkdtemp(prefix="wsweep-test-"))')
PASS=0
FAIL=0

cleanup() { python3 -c "import shutil,sys; shutil.rmtree(sys.argv[1], ignore_errors=True)" "$WORKDIR"; }
trap cleanup EXIT

check() { # check <name> <condition-exit-code>
  if [ "$2" -eq 0 ]; then PASS=$((PASS + 1)); echo "PASS $1"; else FAIL=$((FAIL + 1)); echo "FAIL $1"; fi
}

OLD_DATE="2026-01-01T00:00:00"   # far older than the 120-minute default
OLD_TOUCH="202601010000"

make_repo() {
  # make_repo <name> -> prints repo path; one commit on main, dated OLD
  local repo="$WORKDIR/$1"
  mkdir -p "$repo/.claude/worktrees"
  git -C "$repo" init -q -b main
  git -C "$repo" config user.email t@t; git -C "$repo" config user.name t
  echo base > "$repo/base.txt"
  git -C "$repo" add base.txt
  GIT_AUTHOR_DATE="$OLD_DATE" GIT_COMMITTER_DATE="$OLD_DATE" git -C "$repo" commit -qm base
  printf '{"items":[{"id":"L1","status":"running","agent_id":"runningid","files":[]}]}' > "$repo/.claude/backlog.json"
  printf '%s' "$repo"
}

add_wt() {
  # add_wt <repo> <name> [dirty|clean] [old|young]
  local repo="$1" name="$2" state="${3:-clean}" age="${4:-old}"
  local path="$repo/.claude/worktrees/$name"
  git -C "$repo" worktree add -q "$path" -b "br-$name" >/dev/null 2>&1
  if [ "$state" = dirty ]; then echo scratch > "$path/scratch.txt"; fi
  if [ "$age" = old ]; then
    touch -t "$OLD_TOUCH" "$path" "$path/.git"
  fi
}

# --- Scenario 1: the four shapes side by side --------------------------------
R=$(make_repo one)
add_wt "$R" clean-old clean old
add_wt "$R" dirty-old dirty old
add_wt "$R" clean-young clean young
add_wt "$R" agent-runningid clean old
mkdir -p "$R/.claude/worktrees/not-a-worktree"      # stray folder with no git; must be left alone

out=$(printf '{"hook_event_name":"Stop"}' | CLAUDE_PROJECT_DIR="$R" bash "$HOOK" 2>/dev/null); rc=$?
check "hook exits 0" "$rc"
[ ! -e "$R/.claude/worktrees/clean-old" ];         check "clean+old sandbox removed" $?
[ -e "$R/.claude/worktrees/dirty-old" ];           check "dirty sandbox kept" $?
[ -e "$R/.claude/worktrees/clean-young" ];         check "young sandbox kept" $?
[ -e "$R/.claude/worktrees/agent-runningid" ];     check "running lane sandbox kept" $?
[ -e "$R/.claude/worktrees/not-a-worktree" ];      check "stray non-git folder kept" $?
git -C "$R" rev-parse --verify -q br-clean-old >/dev/null; check "branch survives folder removal" $?
printf '%s' "$out" | grep -qF 'dirty-old';         check "Stop output names the dirty sandbox" $?
printf '%s' "$out" | grep -qF 'systemMessage';     check "Stop output is a non-blocking systemMessage" $?
printf '%s' "$out" | grep -qvF '"decision"';       check "Stop output never blocks" $?
grep -qF 'clean-old' "$R/.claude/worktree-sweep.log"; check "removal logged" $?

# --- Scenario 2: dry run removes nothing and reports the plan ------------------
R2=$(make_repo two)
add_wt "$R2" clean-old clean old
out=$(printf '{"hook_event_name":"SessionStart"}' | CLAUDE_PROJECT_DIR="$R2" WORKTREE_SWEEP_DRY_RUN=1 bash "$HOOK" 2>/dev/null); rc=$?
check "dry run exits 0" "$rc"
[ -e "$R2/.claude/worktrees/clean-old" ];          check "dry run keeps the folder" $?
printf '%s' "$out" | grep -qF '"would_remove": ["clean-old"]'; check "dry run reports would_remove" $?

# --- Scenario 3: age threshold is configurable -----------------------------------
R3=$(make_repo three)
add_wt "$R3" clean-young clean young
printf '{"hook_event_name":"SubagentStop"}' | CLAUDE_PROJECT_DIR="$R3" WORKTREE_SWEEP_MAX_AGE_MIN=0 bash "$HOOK" >/dev/null 2>&1
[ ! -e "$R3/.claude/worktrees/clean-young" ];      check "age 0 removes a young clean sandbox" $?

# --- Scenario 4: no dirty sandboxes -> Stop prints nothing ----------------------
R4=$(make_repo four)
add_wt "$R4" clean-young clean young
out=$(printf '{"hook_event_name":"Stop"}' | CLAUDE_PROJECT_DIR="$R4" bash "$HOOK" 2>/dev/null)
[ -z "$out" ];                                     check "quiet Stop when nothing is dirty" $?

# --- Scenario 5: the hold file disarms removal and silences output ---------------
R5=$(make_repo five)
add_wt "$R5" clean-old clean old
add_wt "$R5" dirty-old dirty old
: > "$R5/.claude/worktree-sweep.hold"
out=$(printf '{"hook_event_name":"Stop"}' | CLAUDE_PROJECT_DIR="$R5" bash "$HOOK" 2>/dev/null); rc=$?
check "hold: exits 0" "$rc"
[ -e "$R5/.claude/worktrees/clean-old" ];          check "hold: clean+old sandbox kept" $?
[ -z "$out" ];                                     check "hold: silent" $?
[ ! -e "$R5/.claude/worktree-sweep.log" ];         check "hold: nothing logged" $?
python3 -c "import os,sys; os.remove(sys.argv[1])" "$R5/.claude/worktree-sweep.hold"
printf '{"hook_event_name":"Stop"}' | CLAUDE_PROJECT_DIR="$R5" bash "$HOOK" >/dev/null 2>&1
[ ! -e "$R5/.claude/worktrees/clean-old" ];        check "hold removed: sweep arms again" $?

# --- Scenario 6: fail-safe on a project with no worktrees folder ----------------
out=$(printf '{}' | CLAUDE_PROJECT_DIR="$WORKDIR/nonexistent" bash "$HOOK" 2>/dev/null); rc=$?
check "missing worktrees dir exits 0" "$rc"
[ -z "$out" ];                                     check "missing worktrees dir prints nothing" $?

echo "worktree-sweep.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
