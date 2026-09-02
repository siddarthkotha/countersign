#!/bin/bash
# statusline.sh — Countersign orchestration status line (mirrors ShadePath's founder spec v3,
# founder ask 2026-09-01 "i want to see similar structure here"):
#   dir · branch · MAIN model(effort) out-tokens │ deleg by tier │ Mac/git │ repos: <projects engaged> · gh N │ Ctx bar
# Reads the standard statusLine stdin payload + the session usage ledger written by
# .claude/hooks/usage-ledger.sh. Empty/corrupt ledger reads as "no data", never blanks counters.
INPUT="$(cat)"
J() { printf '%s' "$INPUT" | jq -r "$1 // empty" 2>/dev/null; }

DIRPATH=$(J '.workspace.project_dir'); [ -z "$DIRPATH" ] && DIRPATH=$(J '.cwd')
BASE=$(basename "${DIRPATH:-?}")
BRANCH=$(git --no-optional-locks -C "${DIRPATH:-.}" branch --show-current 2>/dev/null)
MODEL=$(J '.model.display_name'); EFFORT=$(J '.effort.level')
OUTTOK=$(J '.context_window.total_output_tokens')
PCT=$(J '.context_window.used_percentage')
SID=$(J '.session_id')

k() { local n=$1; [ -z "$n" ] || [ "$n" = "0" ] && { echo "0"; return; }; if [ "$n" -ge 1000 ]; then echo "$((n / 1000))k"; else echo "$n"; fi; }

LEDGER="${DIRPATH:-.}/.claude/session-usage/${SID}.json"
DELEG=""; MAC=0; GIT=0; GH=0; GHC=""
if [ -s "$LEDGER" ] && jq -e . "$LEDGER" >/dev/null 2>&1; then
  # delegated agents by pinned tier: "Sonnet ×N 120k" — the model is shown the moment it is used,
  # tokens appended only when capturable (background agents report after the hook ran).
  DELEG=$(jq -r '
    (.tiers // {}) as $t | (.delegated // {}) as $d |
    [ (($t + $d) | keys[]) | select(. != "inherit")
      | . as $k
      | (($k[0:1] | ascii_upcase) + $k[1:])
        + (if ($t[$k] // 0) > 0 then " ×" + ($t[$k] | tostring) else "" end)
        + (if ($d[$k] // 0) > 0 then " " + (($d[$k] / 1000) | floor | tostring) + "k" else "" end)
    ] | join("  ")' "$LEDGER" 2>/dev/null)
  MAC=$(jq -r '(.mac_runs // 0)' "$LEDGER" 2>/dev/null)
  GIT=$(jq -r '(.git_runs // 0)' "$LEDGER" 2>/dev/null)
  GH=$(jq -r '(.gh_runs // 0)' "$LEDGER" 2>/dev/null)
  # GitHub PROJECTS engaged this session, busiest first, short codes so the context bar never
  # falls off the line. Full names stay in the ledger.
  GHC=$(jq -r '
    [ (.gh_repos // {}) | to_entries[]
      | { k: (.key
              | sub("^superpowers:.*$"; "sp")
              | sub("^vitest$"; "vt") | sub("^vite$"; "vi") | sub("^tsx$"; "tsx")
              | sub("^typescript$"; "tsc") | sub("^playwright$"; "pw")
              | sub("^assemblyai$"; "aai") | sub("^render$"; "rnd")),
          v: .value }
    ]
    | group_by(.k) | map({k: .[0].k, v: (map(.v) | add)})
    | sort_by(-.v) | .[0:4]
    | map(.k + "×" + (.v|tostring)) | join(" ")' "$LEDGER" 2>/dev/null)
fi

BAR=""
if [ -n "$PCT" ]; then
  FULL=$(( ${PCT%.*} / 10 )); [ "$FULL" -gt 10 ] && FULL=10
  i=0; while [ $i -lt 10 ]; do if [ $i -lt "$FULL" ]; then BAR="${BAR}█"; else BAR="${BAR}░"; fi; i=$((i+1)); done
  BAR="Ctx [${BAR}] ${PCT%.*}%"
fi

OUT="$BASE"
[ -n "$BRANCH" ] && OUT="$OUT · $BRANCH"
[ -n "$MODEL" ] && { OUT="$OUT · $MODEL"; [ -n "$EFFORT" ] && OUT="$OUT $EFFORT"; [ -n "$OUTTOK" ] && OUT="$OUT $(k "$OUTTOK")"; }
[ -n "$DELEG" ] && OUT="$OUT │ deleg $DELEG"
OUT="$OUT │ Mac $MAC · git $GIT"
[ -n "$GHC" ] && OUT="$OUT │ repos: $GHC"
[ "${GH:-0}" != "0" ] && OUT="$OUT · gh $GH"
[ -n "$BAR" ] && OUT="$OUT │ $BAR"
printf '%s' "$OUT"
