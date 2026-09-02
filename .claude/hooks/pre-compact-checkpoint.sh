#!/bin/bash
# pre-compact-checkpoint.sh — S165 compaction flight recorder.
# Fires the moment BEFORE Claude's context is compacted (summarized).
# Appends a snapshot of the working tree to .claude/compaction-log.txt so the
# post-compaction session can mechanically re-ground itself instead of trusting
# a summary. Never blocks compaction — always exits 0.

REPO_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
LOG_FILE="$REPO_DIR/.claude/compaction-log.txt"

{
  echo "=== COMPACTION @ $(date '+%Y-%m-%d %H:%M:%S %Z') ==="
  echo "--- branch ---"
  git -C "$REPO_DIR" branch --show-current 2>/dev/null
  echo "--- git status (short) ---"
  git -C "$REPO_DIR" status --short 2>/dev/null
  echo "--- uncommitted diff stat ---"
  git -C "$REPO_DIR" diff --stat 2>/dev/null | tail -25
  echo "--- autopilot flag ---"
  [ -f "$REPO_DIR/.claude/autopilot.on" ] && echo "autopilot: ON" || echo "autopilot: OFF"
  echo ""
} >> "$LOG_FILE" 2>/dev/null

# Keep the log from growing forever: keep the last ~400 lines.
if [ -f "$LOG_FILE" ] && [ "$(wc -l < "$LOG_FILE")" -gt 600 ]; then
  tail -400 "$LOG_FILE" > "$LOG_FILE.tmp" 2>/dev/null && cat "$LOG_FILE.tmp" > "$LOG_FILE" && rm -f "$LOG_FILE.tmp" 2>/dev/null
fi

exit 0
