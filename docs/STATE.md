# Countersign, session snapshot (overwritten at every close; never appended)

Last close: Monday 2026-09-21, 11:20 PM CDT (autopilot night run after the 10:35 PM close) (Day 12, which ran 8:39 AM to 10:35 PM with a
founder gap from about 9:45 AM to 7:36 PM). Autopilot ON throughout. No lanes in flight.
No sandboxes on disk (worktree-cap + worktree-sweep hooks live since b62dc4b).

## The one-paragraph version

Day 12 was the founder's first clean voice session, and it took three defects to get there.
Morning: 110 leftover lane sandboxes (14 GB) were removed with his yes, disk went from 5.7
to 34 GB free, and two hooks now make that mechanical. Evening: he passed cases 11 and 7
by ear on deploy 60; case 5 failed three ways in sequence, each PROVEN from his own record.
(1) A one-second pause after his name ended the turn, AssemblyAI's automatic reply asked
"What do you need today?", and the server asked it again at once because the paraphrase
goals never matched (d813717, Sonnet lane, 11 tests; grader gained a repeated-identical-
question signal, 5 tests; two new harness cases). (2) His speech through the agent's
question vanished for six seconds on the browser side: the harness transcribed the same
overlap in full; AssemblyAI's browser docs say noiseSuppression OFF and ours was on
(5c5d7c1; mic_level trace added; his next two calls captured every word). (3) After a hard
reload he started with no role card, the server defaulted to the attacker context, and an
honest script correctly escalated (8316ca3: button gated, card named on screen, kept across
reload). He also ruled: freeze new behaviour; his voice is the gate; Thursday Sep 24 is the
submission target; the employer service-desk arena is a separate post-Sep-30 track and never
enters the repo.

## PROVEN at this close
- Live: https://countersign-bf8q.onrender.com UP, /health 200, /version 6bc7ea1 (11:20 PM; product code
  unchanged since 8316ca3, the later commits are docs and harness only).
- Gate on main at 8316ca3 (run 10:24 PM on this tree): typecheck clean, 2387/2387 tests on
  121 files, web build clean.
- Founder calls today (records copied to scripts/rehearse/reports/2026-09-21-founder-*):
  case 11 STAGE (5af4583c), case 7 ESCALATE (b674e6e8), case 5 failed on deploy 60
  (d27536a0) and on d813717 (b8114756), case 5 STAGE on 5c5d7c1 (163fef3a), plus aec29b64
  ESCALATE from the no-card trap. Mic rms 0.05 to 0.17 every second he spoke on 5c5d7c1.
- Night batch on 8316ca3 (10:43 to 10:56 PM): 10/10 verdicts correct, 8/10 clean on every
  experience count; the two grader hits are held AssemblyAI-side classes on the board.
- Harness on today's deploys: corrected-critical-field, barge-in-interrupt,
  hangup-after-request, barge-in-pause-after-name, barge-in-talk-through-question all PASS
  with repeated_question 0 (one run each; the 8:31 PM FAIL was a mid-call redeploy).
- Disk: 34 GB free at 9:14 AM after removing 110 sandboxes; countersign folder 574 MB.

## Rulings today (founder)
- Freeze new behaviour; only demo-path defects get fixed; the founder's voice is the gate.
- Submission target Thursday 2026-09-24 (deadline Wed Sep 30 10:00 AM Central).
- Whether lablab lets a submission be edited after sending: UNKNOWN (pages silent); the
  team page form behind his login would show it.
- Employer arena (service-desk identity verification): separate track after Sep 30; run the
  Origination Protocol then; never in the repo (memory: project-employer-arena-stays-out-of-repo).
- Cleanup is mechanical now; never leave sandboxes behind.

## Open, in the order to take them
1. TUESDAY: founder plays cases 1, 2, 3 (honest Dana, CEO impostor, off-script judge) and
   case 5 once more on 8316ca3, laptop speakers and built-in mic, own words. Before it: one
   3-run check (cases 1, 2, 3) so the line and the capture path are proven that day. Fetch
   his records via /api/admin/sessions (token in .env), never ask for codes.
2. Fix only what his session finds. Then code freeze Tuesday night if clean.
3. Wednesday: README final pass, docs/PREFLIP_CHECKLIST.md dry run (the private-reference
   grep runs whole-word across tracked files and history, excluding docs/design),
   record the video (>= 2:20 live agent). The private-reference search terms live in the
   orchestrator's local memory, never here.
4. Thursday: judge-sim on the full package, submit; Friday to Sep 30 is buffer.
5. Residuals held, count before fixing: TALK-OVER-AFTER-TRAP-CORRECTION (grader talk_over=1 on
   both 10 PM calls, verdicts right), BARGE-IN-FLUSH-LAG (376 ms), MIC-TRACK-SETTINGS-NOT-
   RECORDED, CASE11-GOODBYE-RETRY-FOUNDER (15 s goodbye, one extra hold line),
   TURN-ENDS-ON-NAME-PAUSE (AssemblyAI min_silence default 1000 ms).

## Cadence rules in force
Full 10-run batches only before a founder session or after a bundle of fixes; 3-run checks
mid-day; at most two lanes at once; one status per batch; never push while a live check is
in flight (the 8:31 PM lesson); remove a lane's sandbox the minute its files land.

## How to test without being the tester
`npm run rehearse:batch -- --url https://countersign-bf8q.onrender.com --runs 3 --scenarios
<case,case,case> --max-minutes 10`; `npm run grade:record -- <bundle.diagnostics.json>`;
founder records: GET /api/admin/sessions (Bearer COUNTERSIGN_ADMIN_TOKEN) then
GET /api/session/<id>/diagnostics. Keep the lid open (caffeinate -i wraps batches).

## Next session
"Day 13 resume: read docs/STATE.md, then the tail of docs/AUTOPILOT_LOG.md from the
2026-09-21 8:35 PM entry. Live is 6bc7ea1 (product = 8316ca3). First: confirm /health and /version, run a 3-run
check on dana-patient, miller-patient, judge-out-of-scope, then hand the founder the script
for cases 1, 2, 3 and 5. No full batch before that. Freeze holds: fix only what he finds."
