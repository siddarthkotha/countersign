#!/bin/bash
# merge-ci-guard.sh — CI-green-before-merge (Quality Pipeline Phase 0, founder-approved 2026-07-22)
# GitHub branch protection needs Pro on private repos (403, proven 2026-07-22), so the
# required-check gate lives HERE: the only merge path to main is the gh CLI from this
# machine, and this PreToolUse hook refuses `gh pr merge` while the PR's checks are not
# all green. Founder override: prefix the command with CI_OVERRIDE=1 (visible, deliberate).
# Exit 0 = allow · exit 2 = block.

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')

# H16 (review 2026-07-31, fixed #155 2026-08-03): gh detection is path-tolerant, and the
# founder override must sit in ENV-PREFIX POSITION immediately before the gh invocation
# (same species as the GOLDEN_OVERRIDE fix, ledger #130) — the old anywhere-in-string
# match let prose like `git commit -m "note: CI_OVERRIDE=1 is our escape" && gh pr merge`
# merge an unverified PR with no founder authorization ever typed.
printf '%s' "$cmd" | grep -qE '(^|[;&|[:space:]])([^[:space:]]*/)?gh[[:space:]]+pr[[:space:]]+merge' || exit 0
printf '%s' "$cmd" | grep -qE '(^|[;&|][[:space:]]*)CI_OVERRIDE=1[[:space:]]+([A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*([^[:space:]]*/)?gh([[:space:]]|$)' && exit 0

# PR ref = first arg after "merge" that isn't a flag (empty = PR of the current branch).
ref=$(printf '%s' "$cmd" | sed -n 's/.*gh[[:space:]]\{1,\}pr[[:space:]]\{1,\}merge[[:space:]]*//p' | awk '{for(i=1;i<=NF;i++){if($i !~ /^-/){print $i; exit}}}')

rollup=$(gh pr view $ref --json statusCheckRollup --jq '[.statusCheckRollup[]? | {name: (.name // .context), status: (.status // "COMPLETED"), conclusion: (.conclusion // .state)}]' 2>/dev/null)
if [ -z "$rollup" ] || [ "$rollup" = "null" ]; then
  echo "BLOCKED by merge-ci-guard: could not read CI checks for PR '${ref:-current branch}' (offline? no PR?). Merges require VERIFIED green checks — retry when gh can reach GitHub, or the founder may re-issue with CI_OVERRIDE=1." >&2
  exit 2
fi
# ZERO checks = nothing verified anything — that is not green (fail-closed).
if [ "$(printf '%s' "$rollup" | jq 'length')" = "0" ]; then
  echo "BLOCKED by merge-ci-guard: PR '${ref:-current branch}' has NO CI checks at all — an unverified merge is not a green merge. Ensure the gate workflow ran, or founder CI_OVERRIDE=1." >&2
  exit 2
fi
bad=$(printf '%s' "$rollup" | jq -r '.[] | select((.status != "COMPLETED") or ((.conclusion // "") as $c | ($c != "SUCCESS" and $c != "NEUTRAL" and $c != "SKIPPED"))) | "  \(.name): \(.status)/\(.conclusion)"')
if [ -n "$bad" ]; then
  {
    echo "BLOCKED by merge-ci-guard: PR '${ref:-current branch}' has non-green checks — nothing merges toward main on red/pending CI (Quality Pipeline Phase 0):"
    printf '%s\n' "$bad"
    echo "Fix the reds (or wait for pending). Founder-only escape: CI_OVERRIDE=1 gh pr merge ..."
  } >&2
  exit 2
fi
exit 0
