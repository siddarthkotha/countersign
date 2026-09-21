#!/usr/bin/env bash
# ============================================================
# worktree-cap.test.sh — pipe tests for .claude/hooks/worktree-cap.sh (founder
# ruling 2026-09-21). Same shape as worktree-gate.test.sh: feed a fixed hook
# JSON payload over stdin with a throwaway CLAUDE_PROJECT_DIR, assert on
# exit code + stdout. Run: bash .claude/hooks/test/worktree-cap.test.sh
# ============================================================
set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/worktree-cap.sh"
WORKDIR=$(python3 -c 'import tempfile; print(tempfile.mkdtemp(prefix="wcap-test-"))')
PASS=0
FAIL=0

cleanup() { python3 -c "import shutil,sys; shutil.rmtree(sys.argv[1], ignore_errors=True)" "$WORKDIR"; }
trap cleanup EXIT

make_proj() {
  # make_proj <name> <sandbox-count>
  local proj="$WORKDIR/$1" n="$2" i
  mkdir -p "$proj/.claude/worktrees"
  for ((i = 1; i <= n; i++)); do mkdir -p "$proj/.claude/worktrees/lane-$i"; done
  printf '%s' "$proj"
}

run_case() {
  # run_case <name> <proj> <input-json> <expect: pass|deny> [needle] [extra env]
  local name="$1" proj="$2" input="$3" expect="$4" needle="${5:-}" extra="${6:-}"
  local out rc
  out=$(env CLAUDE_PROJECT_DIR="$proj" $extra bash "$HOOK" <<<"$input" 2>/dev/null)
  rc=$?
  local decision
  decision=$(printf '%s' "$out" | python3 -c 'import sys,json
try:
    d=json.load(sys.stdin); print(d.get("hookSpecificOutput",{}).get("permissionDecision",""))
except Exception:
    print("")' 2>/dev/null)
  local ok=1
  if [ "$rc" -ne 0 ]; then ok=0; fi
  if [ "$expect" = pass ] && [ -n "$out" ]; then ok=0; fi
  if [ "$expect" = deny ] && [ "$decision" != deny ]; then ok=0; fi
  if [ -n "$needle" ] && ! printf '%s' "$out" | grep -qF -- "$needle"; then ok=0; fi
  if [ "$ok" -eq 1 ]; then PASS=$((PASS + 1)); echo "PASS $name"; else FAIL=$((FAIL + 1)); echo "FAIL $name (rc=$rc) out=$out"; fi
}

AGENT_WT='{"tool_name":"Agent","tool_input":{"prompt":"fix X","isolation":"worktree"}}'
AGENT_PLAIN='{"tool_name":"Agent","tool_input":{"prompt":"fix X"}}'
BASH_ADD='{"tool_name":"Bash","tool_input":{"command":"git worktree add .claude/worktrees/foo -b foo"}}'
BASH_OTHER='{"tool_name":"Bash","tool_input":{"command":"git worktree list"}}'

# Under the cap, healthy disk floor (0 GB) -> everything passes.
P0=$(make_proj under 2)
run_case "under-cap agent worktree passes" "$P0" "$AGENT_WT" pass "" "WORKTREE_FLOOR_GB=0"
run_case "under-cap bash worktree add passes" "$P0" "$BASH_ADD" pass "" "WORKTREE_FLOOR_GB=0"

# At the cap -> deny for both launch shapes, naming the sandboxes.
P1=$(make_proj at-cap 6)
run_case "at-cap agent worktree denied" "$P1" "$AGENT_WT" deny "6 sandboxes" "WORKTREE_FLOOR_GB=0"
run_case "at-cap bash worktree add denied" "$P1" "$BASH_ADD" deny "lane-1" "WORKTREE_FLOOR_GB=0"

# Non-sandbox calls never trip the cap even when over it.
run_case "at-cap plain agent passes" "$P1" "$AGENT_PLAIN" pass "" "WORKTREE_FLOOR_GB=0"
run_case "at-cap other bash passes" "$P1" "$BASH_OTHER" pass "" "WORKTREE_FLOOR_GB=0"
run_case "at-cap other tool passes" "$P1" '{"tool_name":"Read","tool_input":{"file_path":"x"}}' pass "" "WORKTREE_FLOOR_GB=0"

# Cap is configurable.
run_case "cap raised to 10 passes at 6" "$P1" "$AGENT_WT" pass "" "WORKTREE_FLOOR_GB=0 WORKTREE_CAP=10"

# Disk floor: an impossible floor (99999 GB) denies even under the cap.
run_case "disk floor denies" "$P0" "$AGENT_WT" deny "GB free" "WORKTREE_FLOOR_GB=99999"

# Malformed input is fail-safe.
run_case "malformed json passes" "$P0" '{not json' pass ""
run_case "missing worktrees dir passes" "$WORKDIR/nonexistent" "$AGENT_WT" pass "" "WORKTREE_FLOOR_GB=0"

echo "worktree-cap.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
