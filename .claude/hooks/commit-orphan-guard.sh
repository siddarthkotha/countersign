#!/bin/bash
# commit-orphan-guard.sh — PostToolUse(Bash) warn on orphaned staged files (2026-07-22).
# Self-catch: `git commit <pathspec>` commits ONLY the listed paths and SILENTLY leaves
# other staged files uncommitted — hit 3x in one session (once producing a4b652a, a commit
# that imported an uncommitted file). This makes the silent orphan LOUD: after any git
# commit, if staged changes remain, warn (with the file list) so the orphan can't hide.
# Warning only (post-commit can't block) — loudness is the whole point.
input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null)
printf '%s' "$cmd" | grep -qE '(^|[;&|[:space:]])git[[:space:]]+commit' || exit 0
# skip pure --amend/--dry-run/status-only forms that aren't real orphan risks
PROJ="${CLAUDE_PROJECT_DIR:-.}"
orphans=$(git -C "$PROJ" diff --cached --name-only 2>/dev/null)
if [ -n "$orphans" ]; then
  {
    echo "⚠️  COMMIT-ORPHAN-GUARD: staged files remain AFTER a git commit — likely a pathspec"
    echo "commit that left these UNCOMMITTED (the a4b652a class, hit 3x 2026-07-22):"
    printf '  • %s\n' $orphans
    echo "If unintended: commit them now (git commit WITHOUT a pathspec). If deliberate"
    echo "(staging for a later commit), ignore this."
  } >&2
fi
exit 0
