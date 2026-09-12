# Countersign, session snapshot (overwritten at every close; never appended)

Last close: Saturday 2026-09-12, 10:27 AM CDT (Day 5, which ran Friday 3:21 PM to Saturday
10:27 AM with autopilot from 8:48 PM to 12:08 AM). Autopilot is OFF.

## The one-paragraph version

Day 5 turned the demo from "proven twice" into "proven across nine scenarios": 25 pushes, all
gated on main (three test runs, typecheck, corpus replay, separate review) and verified live.
The agent now greets first, asks its questions, says one exact closing sentence per outcome and
hangs up itself. Fraud froze 3 of 4 times in a 34-run batch; identity switches now resolve and
freeze (founder option B, then a double-switch follow-up); one wrong answer escalates instead of
freezing; a readback is re-asked at most three times before a human callback; an exact
restatement confirms a readback; a stray "actually" cannot launder a doubled amount; barge-in
passes end to end with a real interrupted line. The credits-exhausted replay mode the brief
required now exists, with a token-gated admin reset. Judge sim 1 ran twice (click-driven judge
cannot speak; scores 7/5/6/8 then 7/6/6/8) and its three fixes are done or decided. Business
line (FBI 2025 report) is on the landing page and README; cover chosen (frozen variant, real
transcript lines). Pre-flip checklist 6 of 10 done; every cross-project reference is gone.

## PROVEN (checked against real sources at close)

- Live: a04241f served at 10:10 AM, /health ok, live_calls available. 70 commits since the Day
  4 close; pushes 10 to 25 today, each with CI green.
- Close gate 10:26 AM: 1380 tests across 77 files, typecheck clean.
- Corpus: 25 recordings replay exactly (128 assertions); five are hand-built and labelled so.
- Batch 2026-09-11 (scripts/rehearse/reports/batch-2026-09-11.log): 34 runs, 22 pass, 62 min;
  per scenario in docs/AUTOPILOT_LOG.md 10:51 PM. After the fixes: barge-in PASS (12:06 AM,
  interrupted greeting, STAGE 100.3 s), identity-switch FREEZE 110 s (10:44 PM), single-wrong-
  answer ESCALATE (10:35 PM). 59 rehearsal reports on disk.
- Latency (docs/LATENCY.md, ESTIMATE, synthetic caller, harness wall clock): perceived caller-
  to-agent gap p50 622 ms, p95 1774 ms, n=76 turns. The "9 ms" relay column is labelled as such.
- STT mishears across ~45 reports: account digits 1/36, amounts 0/72.
- Gates: G1, G2 met; G3 (25 corpus replays) met; G4 by test; G5 partial (40 rehearsals on the
  deployed site, latency table exists; needs 10+ more incl. socket-drop); G6 not started (plan
  in docs/VIDEO-RECORDING-PLAN.md, 35 to 40 founder-minutes).

## What is on main and live (highlights, all reviewed)

Greeting first + GREET no-double; CLOSE verbatim + server hang-up (reply_id gated); standing
rule: never announce an outcome; RE_ELICIT_AFTER_SWITCH verbatim; identity switch option B +
chain; readback exact restatement (spoken numbers, spaced digits); correction-cue lookback with
the magnitude gate; readback re-ask cap (new row 13; old 13 is 14, old 14 is 15); RT-9b escrow
scoping; speakable challenge sentences (engine only, prompt still paraphrases); Marcus/Elena
seed facts; seed-budget guard; credits-exhausted mode (402/keyword, 3-in-10-min counter,
COUNTERSIGN_ADMIN_TOKEN reset, COUNTERSIGN_DEBUG_HOOKS drop route); NO_ACTION banner; link-lost
"nothing staged or frozen" message; jargon rewrites; FBI business line; covers; latency table +
batch runner; barge-in anchored to reply audio and retargeted at the greeting; scenario matcher
with and/unless groups; recorder logs session_config_updated and greeting_configured; Replay
test de-flaked (proven cause); hooks and CLAUDE.md redacted.

## Open, in the order to take them

1. Video (G6): founder session, docs/VIDEO-RECORDING-PLAN.md. Engine is final for the take.
2. Sep 18 judge sim: agent definition now scores the live axis from harness reports; build
   SIM-ONE-COMMAND (batch + latency table + report list) first; run the batch that morning.
3. G5: 10+ more rehearsals incl. socket-drop-resume (needs COUNTERSIGN_DEBUG_HOOKS=1 on Render
   for the window) and story-shift/pressure variants.
4. Pre-flip founder items: positioning line, submission form (cover: cover-2-final.png), commit
   8afaf2a reword, .env.example COUNTERSIGN_DEBUG_HOOKS line (pre-commit hook blocks .env*).
5. Founder access items: COUNTERSIGN_ADMIN_TOKEN in Render; decide TOOLS-NOT-OFFERED (an
   AssemblyAI judge sees the tool feature unused; README carries the trade-off).
6. Quiet-moment follow-ups: INTERRUPTED-PROBE-LOST, WORKTREE-INSTALL hook, CHALLENGE-VERBATIM-
   FLIP (ruled not now), REPLAY-TRUE-RESUME, CRIT-partial-tool-failure banner (visual).

## Housekeeping

62 git worktrees and 4 stash entries (all already applied) await the founder's delete word.
Lane rules learned this session (memory): lanes must npm install in their worktree and confirm
the base commit; only the re-gate on main is proof.

## How to test without being the tester

`npm run rehearse -- --scenario <name> --url https://countersign-bf8q.onrender.com` (credits);
`npm run rehearse:batch -- --url <url> --runs 30 --scenarios a,b,c --max-minutes 60`;
`npm run latency:table` regenerates docs/LATENCY.md from the bundles on disk.

## Next session

"Day 6 resume: read docs/STATE.md and the tail of docs/AUTOPILOT_LOG.md. Engine is final for
the video; first job is SIM-ONE-COMMAND and the G5 rehearsal top-up, then the founder's video
session from docs/VIDEO-RECORDING-PLAN.md. Do not re-prove what the 2026-09-11 batch and
reports already prove."
