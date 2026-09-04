#!/usr/bin/env bash
# ============================================================
# worktree-gate.test.sh — pipe tests for .claude/hooks/worktree-gate.sh (H2,
# founder ruling 2026-09-03 10:38 PM CDT). Same shape as the hooks it tests:
# feed a fixed hook-JSON payload into the script over stdin, assert on exit
# code + stdout. No prior hook-test file existed in this repo to match
# against (checked: `git log --all --diff-filter=A --name-only | grep -i
# hook.*test` and a full-tree grep both came back empty) -- this file is
# written fresh, following the hooks' own conventions (bash wrapper,
# fail-safe python3 body, JSON decision output).
#
# Uses a throwaway CLAUDE_PROJECT_DIR per test so the real .claude/backlog.json
# is never read or touched. Run directly: bash .claude/hooks/test/worktree-gate.test.sh
# ============================================================
set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/worktree-gate.sh"
WORKDIR=$(python3 -c 'import tempfile; print(tempfile.mkdtemp(prefix="wgate-test-"))')
PASS=0
FAIL=0

cleanup() { python3 -c "import shutil,sys; shutil.rmtree(sys.argv[1], ignore_errors=True)" "$WORKDIR"; }
trap cleanup EXIT

fixture_backlog() {
  # $1 = path to write the fixture backlog.json into
  cat > "$1" <<'EOF'
{
  "items": [
    {
      "id": "S9",
      "title": "S9 running lane",
      "files": ["packages/server/**"],
      "status": "running",
      "held_because": "",
      "agent_id": "x"
    },
    {
      "id": "S10",
      "title": "S10 held lane (should be ignored)",
      "files": ["packages/web/**"],
      "status": "held",
      "held_because": "founder ruling",
      "agent_id": ""
    }
  ]
}
EOF
}

run_case() {
  # run_case <name> <input-json> <expect: pass|block> [substring expected in reason, block only]
  local name="$1" input="$2" expect="$3" needle="${4:-}"
  local proj="$WORKDIR/$name"
  mkdir -p "$proj/.claude"
  fixture_backlog "$proj/.claude/backlog.json"

  local out rc
  out=$(CLAUDE_PROJECT_DIR="$proj" bash "$HOOK" <<<"$input" 2>/dev/null)
  rc=$?

  local ok=1
  if [ "$rc" -ne 0 ]; then
    ok=0
    echo "FAIL $name: hook exited $rc, expected 0 (hooks are fail-safe, never nonzero)"
  fi

  case "$expect" in
    pass)
      if [ -n "$out" ]; then
        ok=0
        echo "FAIL $name: expected silent pass, got output: $out"
      fi
      ;;
    block)
      if [ -z "$out" ]; then
        ok=0
        echo "FAIL $name: expected a deny decision, got no output"
      elif ! printf '%s' "$out" | grep -q '"permissionDecision": *"deny"'; then
        ok=0
        echo "FAIL $name: expected permissionDecision deny, got: $out"
      elif [ -n "$needle" ] && ! printf '%s' "$out" | grep -qF "$needle"; then
        ok=0
        echo "FAIL $name: expected reason to mention '$needle', got: $out"
      fi
      ;;
  esac

  if [ "$ok" -eq 1 ]; then
    PASS=$((PASS + 1))
    echo "PASS $name"
  else
    FAIL=$((FAIL + 1))
  fi
}

# --- 1. worktree isolation passes ---
run_case "worktree-passes" \
  '{"tool_name":"Agent","tool_input":{"isolation":"worktree","prompt":"LANE-FILES: packages/server/**"}}' \
  pass

# --- 2. read-only marker passes (several spellings) ---
run_case "readonly-upper-passes" \
  '{"tool_name":"Agent","tool_input":{"prompt":"READ-ONLY: look at the code"}}' \
  pass

run_case "readonly-lower-passes" \
  '{"tool_name":"Agent","tool_input":{"prompt":"do a read-only pass over the diff"}}' \
  pass

run_case "readonly-do-not-edit-passes" \
  '{"tool_name":"Agent","tool_input":{"prompt":"look but do not edit any file"}}' \
  pass

run_case "readonly-review-comma-passes" \
  '{"tool_name":"Agent","tool_input":{"prompt":"review, read-only, of the merge"}}' \
  pass

run_case "explore-subagent-passes" \
  '{"tool_name":"Agent","tool_input":{"subagent_type":"Explore","prompt":"find the file"}}' \
  pass

run_case "errand-subagent-passes" \
  '{"tool_name":"Agent","tool_input":{"subagent_type":"errand","prompt":"look up the price"}}' \
  pass

# --- 3. LANE-FILES disjoint from the running lane passes ---
run_case "lane-files-disjoint-passes" \
  '{"tool_name":"Agent","tool_input":{"prompt":"do the web fix\nLANE-FILES: packages/web/**"}}' \
  pass

run_case "lane-files-docs-disjoint-passes" \
  '{"tool_name":"Agent","tool_input":{"prompt":"write it up\nLANE-FILES: docs/X.md"}}' \
  pass

# --- 4. LANE-FILES overlapping the running lane blocks, names the lane ---
run_case "lane-files-overlap-file-blocks" \
  '{"tool_name":"Agent","tool_input":{"prompt":"fix session.ts\nLANE-FILES: packages/server/src/call/session.ts"}}' \
  block "S9"

run_case "lane-files-overlap-glob-blocks" \
  '{"tool_name":"Agent","tool_input":{"prompt":"touch the server\nLANE-FILES: packages/server/test/**"}}' \
  block "S9"

# --- overlap against a HELD lane must NOT block (only "running" counts) ---
run_case "lane-files-vs-held-lane-passes" \
  '{"tool_name":"Agent","tool_input":{"prompt":"touch web\nLANE-FILES: packages/web/**"}}' \
  pass

# --- 5. missing declaration (no LANE-FILES, no read-only, no worktree) blocks ---
run_case "missing-declaration-blocks" \
  '{"tool_name":"Agent","tool_input":{"prompt":"just go fix the bug"}}' \
  block "declare \`LANE-FILES:"

# --- with isolation explicitly not worktree, still needs LANE-FILES ---
run_case "non-worktree-isolation-still-needs-declaration-blocks" \
  '{"tool_name":"Agent","tool_input":{"isolation":"none","prompt":"just go fix the bug"}}' \
  block

# --- 6. non-Agent/Task tool passes untouched, even with colliding content ---
run_case "non-agent-tool-passes" \
  '{"tool_name":"Bash","tool_input":{"command":"echo LANE-FILES: packages/server/**"}}' \
  pass

# --- Task alias is treated the same as Agent ---
run_case "task-alias-overlap-blocks" \
  '{"tool_name":"Task","tool_input":{"prompt":"fix it\nLANE-FILES: packages/server/**"}}' \
  block "S9"

run_case "task-alias-worktree-passes" \
  '{"tool_name":"Task","tool_input":{"isolation":"worktree","prompt":"fix it\nLANE-FILES: packages/server/**"}}' \
  pass

# --- 7. malformed JSON exits 0 with no output ---
run_case "malformed-json-passes-silently" \
  'not json at all {{{' \
  pass

echo "----------------------------------------"
echo "worktree-gate.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
