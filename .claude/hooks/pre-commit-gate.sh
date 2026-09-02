#!/bin/bash
# pre-commit-gate.sh — ported from ShadePath pre-commit-review-gate.sh (S141/S164/S168) to Countersign
# 2026-09-01, adapted for a solo repo that commits on main. PreToolUse on Bash `git commit`.
# Gates, in order:
#   0. SECRETS: a staged diff that adds an API key / token / .env content is BLOCKED outright
#      (Countersign hygiene law: no secrets in the repo, ever). No override.
#   1. SCRATCH SCATTER: new scratch files (_*, zz*, tmp_*, *probe*) under packages/*/test/ block the commit.
#   2. PROTECTED ORACLE: the adversarial corpus, its replay test, the mutation test and the CI workflow may be
#      APPENDED to freely; MODIFYING or DELETING a line in them is blocked on autopilot (no override) and needs
#      GOLDEN_OVERRIDE=1 in env-prefix position interactively (founder sees a before/after first). This is the
#      anti-gaming lock: the agent writes both the engine and its tests, so the oracle must not be agent-editable.
#   3. EXECUTABLE GATE: when code is staged (packages/, .github/), `npm test` and `npm run typecheck` must be green.
# exit 0 = allow · exit 2 = block (stderr shown to the model).
input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')
GIT_TOK='([^[:space:]]*/)?git([[:space:]]+-[^[:space:]]+([[:space:]]+[^-[:space:]][^[:space:]]*)?)*'
printf '%s' "$cmd" | grep -qE "(^|[;&|[:space:]])${GIT_TOK}[[:space:]]+commit([[:space:]]|\$)" || exit 0
PROJ="${CLAUDE_PROJECT_DIR:-.}"

# Will the command itself stage files? Then judge the working tree, not the (pre-add) index.
will_add=0
printf '%s' "$cmd" | grep -qE "(^|[;&|[:space:]])${GIT_TOK}[[:space:]]+add|${GIT_TOK}[[:space:]]+commit[^|;&]*([[:space:]]-a|[[:space:]]-am|--all)" && will_add=1

# --- 0. SECRETS ---
if [ -n "${PRECOMMIT_GATE_TEST_DIFF:-}" ]; then diff_text=$(cat "$PRECOMMIT_GATE_TEST_DIFF" 2>/dev/null)
elif [ "$will_add" = 1 ]; then diff_text=$(git -C "$PROJ" diff 2>/dev/null; git -C "$PROJ" diff --cached 2>/dev/null; git -C "$PROJ" ls-files --others --exclude-standard 2>/dev/null | while read -r f; do [ -f "$PROJ/$f" ] && printf '+++ %s\n' "$f" && head -c 200000 "$PROJ/$f" | sed 's/^/+/'; done)
else diff_text=$(git -C "$PROJ" diff --cached 2>/dev/null); fi
leak=$(printf '%s' "$diff_text" | grep -nE '^\+.*(ASSEMBLYAI_API_KEY[[:space:]]*[=:][[:space:]]*["'"'"']?[A-Za-z0-9]{16,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|ghp_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|Bearer [A-Za-z0-9._-]{30,})' | head -5)
[ -z "$leak" ] && leak=$(printf '%s' "$diff_text" | grep -nE '^\+\+\+ .*(^|/)\.env(\.[A-Za-z]+)?$' | head -3)
if [ -n "$leak" ]; then
  { echo "BLOCKED by pre-commit-gate (SECRETS): the staged content looks like it contains a credential or a .env file:"; printf '%s\n' "$leak" | cut -c1-120; echo "Countersign law: no secrets in the repo, ever. Remove it, rotate the key if it was real, keep keys in .env (gitignored) and the host's secret store."; } >&2
  exit 2
fi

# --- 1. SCRATCH SCATTER ---
scatter=$(git -C "$PROJ" status --porcelain --ignored 2>/dev/null | grep -E '^(\?\?|!!|A )' | awk '{print $NF}' | grep -E '^packages/[^/]+/test/([^/]*/)*(_|zz|tmp_)[^/]*$|^packages/[^/]+/test/([^/]*/)*[^/]*probe[^/]*/')
if [ -n "$scatter" ]; then
  { echo "BLOCKED by pre-commit-gate: scratch/probe files under packages/*/test/ (one scratch place: \$CLAUDE_JOB_DIR/tmp or .superpowers/):"; printf '  %s\n' $scatter; } >&2
  exit 2
fi

# --- 2. PROTECTED ORACLE ---
PROTECTED_ORACLE=( "packages/engine/corpus/*.json" "packages/engine/test/corpus.test.ts" "packages/engine/test/mutants.test.ts" ".github/workflows/ci.yml" )
oracle_violations=$(
  { git -C "$PROJ" diff --cached --numstat -- "${PROTECTED_ORACLE[@]}" 2>/dev/null | awk '($1 == "-" && $2 == "-") || ($2 ~ /^[0-9]+$/ && $2 > 0) { print $3 }'
    git -C "$PROJ" diff --cached --name-status -- "${PROTECTED_ORACLE[@]}" 2>/dev/null | awk '$1 ~ /^(D|R|C)/ { print $2 }'
    # In add-mode, only the paths the command itself adds count (parallel lanes leave other files dirty).
    if [ "$will_add" = 1 ]; then
      _addp=$(printf '%s' "$cmd" | tr '\n' ' ' | sed -E 's/.*git[[:space:]]+add[[:space:]]+//; s/[[:space:]]*(&&|;|\|).*$//')
      if printf '%s' "$_addp" | grep -qE '(^|[[:space:]])(-A|--all|\.)([[:space:]]|$)'; then
        git -C "$PROJ" diff --numstat -- "${PROTECTED_ORACLE[@]}" 2>/dev/null | awk '($1 == "-" && $2 == "-") || ($2 ~ /^[0-9]+$/ && $2 > 0) { print $3 }'
      else
        for _f in $_addp; do
          if [ "${_f#-}" != "$_f" ]; then continue; fi
          git -C "$PROJ" diff --numstat -- "$_f" 2>/dev/null | awk '($1 == "-" && $2 == "-") || ($2 ~ /^[0-9]+$/ && $2 > 0) { print $3 }'
        done | grep -E '^(packages/engine/corpus/.*[.]json|packages/engine/test/corpus[.]test[.]ts|packages/engine/test/mutants[.]test[.]ts|[.]github/workflows/ci[.]yml)$'
      fi
    fi
  } | sort -u)
if [ -n "$oracle_violations" ]; then
  if [ -f "$PROJ/.claude/autopilot.on" ]; then
    { echo "BLOCKED by pre-commit-gate — PROTECTED ORACLE modified on AUTOPILOT (the replay corpus, its tests, the CI workflow). Appending is fine; changing or deleting an existing line is not, because a changed expected verdict is a changed product. Files:"; printf '  %s\n' $oracle_violations; echo "Revert the change to these files and continue, or park it in docs/AUTOPILOT_LOG.md for the founder."; } >&2
    exit 2
  fi
  if ! printf '%s' "$cmd" | grep -qE '(^|[;&|[:space:]])GOLDEN_OVERRIDE=1[[:space:]]+([A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*([^[:space:]]*/)?git([[:space:]]|$)'; then
    { echo "BLOCKED by pre-commit-gate — you are about to MODIFY or DELETE a protected oracle file:"; printf '  %s\n' $oracle_violations; echo "Appending new corpus files or tests is always allowed. Changing an existing expected verdict, assertion, or the CI workflow needs the founder's explicit yes: show a plain-English BEFORE/AFTER, get the yes, then re-issue as: GOLDEN_OVERRIDE=1 git commit ..."; } >&2
    exit 2
  fi
fi

# --- 3. EXECUTABLE GATE (runs against a SNAPSHOT of what is being committed, never the live tree) ---
# Parallel lanes share one working tree: another agent's half-written file must not block this commit.
# Snapshot = the index exported to a temp dir, plus (when the command itself runs `git add`) the paths it names
# copied from the working tree. `git add -A|.|--all` = the whole working tree.
add_paths=""; add_all=0
if [ "$will_add" = 1 ]; then
  add_paths=$(printf '%s' "$cmd" | tr '\n' ' ' | sed -E 's/.*git[[:space:]]+add[[:space:]]+//; s/[[:space:]]*(&&|;|\|).*$//')
  printf '%s' "$add_paths" | grep -qE '(^|[[:space:]])(-A|--all|\.)([[:space:]]|$)' && add_all=1
fi
if [ "$will_add" = 1 ] && [ "$add_all" = 0 ]; then
  # named paths: ONLY those paths are this commit's business (the shared index belongs to every lane)
  staged=$(printf '%s' "$add_paths" | tr ' ' '\n' | grep -E '^(packages/|\.github/)')
elif [ "$will_add" = 1 ]; then
  staged=$(git -C "$PROJ" status --porcelain 2>/dev/null | awk '{print $NF}' | grep -E '^(packages/|\.github/)')
else
  staged=$(git -C "$PROJ" diff --cached --name-only 2>/dev/null | grep -E '^(packages/|\.github/)')
fi
[ -z "$staged" ] && exit 0
[ -n "${PRECOMMIT_GATE_TEST_DIFF:-}" ] && exit 0   # test harness stops before running the suite
SNAP=$(mktemp -d "${TMPDIR:-/tmp}/csgate.XXXXXX") || exit 0
cleanup() { rm -rf "$SNAP" 2>/dev/null; }
trap cleanup EXIT
if [ "$will_add" = 1 ] && [ "$add_all" = 0 ]; then
  # named paths: snapshot = HEAD (what git will actually build the commit on) + the named paths from the working tree
  git -C "$PROJ" archive HEAD 2>/dev/null | tar -x -C "$SNAP" 2>/dev/null || { echo "pre-commit-gate: could not snapshot HEAD; allowing (fail-open on infrastructure, logged)" >&2; exit 0; }
else
  git -C "$PROJ" checkout-index -a --prefix="$SNAP/" 2>/dev/null || { echo "pre-commit-gate: could not snapshot the index; allowing (fail-open on infrastructure, logged)" >&2; exit 0; }
fi
if [ "$will_add" = 1 ]; then
  if [ "$add_all" = 1 ]; then
    (cd "$PROJ" && git ls-files -m -o --exclude-standard -z 2>/dev/null | while IFS= read -r -d '' f; do mkdir -p "$SNAP/$(dirname "$f")"; [ -f "$f" ] && cp "$f" "$SNAP/$f"; done)
  else
    for f in $add_paths; do case "$f" in -*) continue;; esac; if [ -d "$PROJ/$f" ]; then (cd "$PROJ" && find "$f" -type f -not -path '*/node_modules/*' | while read -r g; do mkdir -p "$SNAP/$(dirname "$g")"; cp "$g" "$SNAP/$g"; done); elif [ -f "$PROJ/$f" ]; then mkdir -p "$SNAP/$(dirname "$f")"; cp "$PROJ/$f" "$SNAP/$f"; fi; done
  fi
fi
[ -d "$PROJ/node_modules" ] && ln -s "$PROJ/node_modules" "$SNAP/node_modules"
for w in "$PROJ"/packages/*/; do n=$(basename "$w"); [ -d "$w/node_modules" ] && [ -d "$SNAP/packages/$n" ] && ln -s "$w/node_modules" "$SNAP/packages/$n/node_modules"; done
if ! gate_log=$( (cd "$SNAP" && npm test --silent 2>&1 && npm run typecheck --silent 2>&1) ); then
  { echo "BLOCKED by pre-commit-gate — the executable gate is RED on the snapshot of what you are committing (npm test / npm run typecheck). Countersign law: nothing is done without a green test importing the real code. Fix the failure; never bypass. (Other agents' uncommitted files are NOT in this snapshot — the red is yours.)"; printf '%s\n' "$gate_log" | tail -30; } >&2
  exit 2
fi
exit 0
