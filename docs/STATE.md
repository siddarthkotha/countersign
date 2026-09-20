# Countersign, session snapshot (overwritten at every close; never appended)

Last close: Saturday 2026-09-19, 11:10 PM CDT (Day 11, which ran 12:08 PM to 11:10 PM with a
session-limit gap from about 3:40 PM to 8:07 PM). Autopilot ON throughout. No lanes in flight.

## The one-paragraph version

Day 11 was the day the harness stopped lying about goodbyes and the demo finally read clean.
The deploy-53 batch found two grader blind spots (fixed) and one real regression: AssemblyAI
folded its own automatic reply into our goodbye. Chasing that exposed, one layer at a time,
a stale line before every goodbye, a goodbye talked over a barging caller, a goodbye cut by a
barging caller, and folded goodbyes that reported "complete" with under a second of audio so
the server hung up on silence. Seven pushes (54 to 60) closed all of it. Deploy 60 is the first
batch to read 10 of 10 clean on every experience count, and every rehearsal now records the
agent's audio. The founder's feedback at 8:07 PM was about cost, not correctness: five live
batches and seven lanes in one day hit the session limit before he saw the clean result. The
cadence rule is now written down (memory: feedback-batch-cadence-and-session-budget).

## PROVEN at this close
- Live: https://countersign-bf8q.onrender.com is UP, /health 200 at 11:08 PM (21.5 s cold
  start, idle service waking), /version e23ae04 (deploy 60).
- Gate on main at e23ae04: typecheck clean, 2348/2348 tests on 120 files.
- Deploy 60 batch (3:45 PM, roll-up 2026-09-19T15-45-43-batch-rollup.md): 10/10 PASS,
  repeated_question 0, merged_reply 0, talk_over 0, holding_spam 0 on every run; goodbyes
  play in full starting right after the verdict (5.7 to 7.5 s to the end of the line on eight
  runs, 9.2 and 15.9 s on two that needed one retry); ten .agent.wav files recorded.
- The day in counts (same grader, per deploy, repeated/merged/talk_over/holding over N):
  53: 0/3/1/0 over 14 · 55: 1/0/3/0 over 10 · 57: 0/0/1/0 over 10 · 58: 0/2/4/1 over 10 ·
  60: 0/0/0/0 over 10.
- Cost of the day: about 65 minutes of live calls (ESTIMATE, roll-up minutes summed, about
  $4.90 at $4.50 per hour), seven lanes, pushes 54 to 60.

## What deploy 60 runs (the settled configuration)
- turn_detection OMITTED on connect by default (COUNTERSIGN_TURN_DETECTION unset = omit;
  "explicit" restores the deploy-52 defaults). Omitted keeps AssemblyAI's adaptive turn-taking,
  which took comma-pause cutoffs from 4 of 10 (deploy 58) to 0 of 10.
- The goodbye (CLOSE/ANNOUNCE_*) is sent synchronously on the caller-turn tick
  (FORCE_SPEAK_SETTLE_MS 0); fresh questions keep the 150 ms settle.
- The CLOSE session.update sets interrupt_response false (no barge-in during the goodbye;
  mid-session mutability quoted from the docs, live effect measured clean once).
- A goodbye counts as heard only when its relayed audio bytes reach 50 percent of about
  4,000 bytes per character; otherwise it is retried, synchronously at the caller's turn end.
- An owed send is never made while the caller is speaking (callerSpeaking, cleared by
  speech.stopped and by transcript.user); the 45 s cap remains the backstop.
- Evaluate diags are written on any evidence-card change; the grader's talk_over check
  exempts a window whose final transcript already landed.

## Open, in the order to take them
1. FOUNDER VOICE SESSION on deploy 60: cases 11, 5, 7 (the three he quit on Day 10), about
   twenty minutes, morning. Before it: one 3-run check on those cases (about 4 min), not a
   full batch. Fetch his records before any deploy (memory: founder-calls-need-zero-step-capture).
2. Read the first .agent.wav timelines from the deploy-60 reports (Audio section) and settle
   the one open measurement: our instructed goodbyes carried about 3 s of audio on deploy 58
   while automatic replies speaking the same sentence carried 7 s; deploy 60 goodbyes read
   5.7 to 7.5 s, so this may already be closed. Say so with the numbers.
3. DEGRADED-CLOSE-FLOOR-INCONSISTENT (flat 2,000 ms audio floor vs the new scaled floor).
4. Residuals to keep counting, not fix blind: STALE-AMBIENT-LINE-AFTER-VERDICT and
   AMBIENT-DOUBLE-TURN-END-REPEAT (AssemblyAI-side; 0 occurrences on deploy 60).
5. Parked founder rulings (nine): LAW-F-FLOOR-JUSTIFICATION-WRONG is now moot for deploy 60
   (no floor needed while omitted); SECOND-SEED-NAME-IS-CONTAMINATION, CHALLENGE-WINDOW-
   LATE-UTTERANCE (ruling 10), plus the Day-9 set.
6. Then G5 (50+ rehearsals with tail latency: docs/LATENCY.md now reads p50 629 ms, p95
   1840 ms over 1532 turns, ESTIMATE) and G6 (video, due Sunday 2026-09-27). Submission
   Wednesday 2026-09-30.

## Cadence rule from the founder (2026-09-19 8:07 PM)
Full 10-run batches only before a founder session or after a BUNDLE of fixes. Mid-day: 3-run
checks on the affected cases. At most two lanes at once, each with a stated budget. One status
per batch end, never per run. Close before the budget runs out.

## How to test without being the tester
`npm run rehearse:batch -- --url https://countersign-bf8q.onrender.com --runs 3 --scenarios
<case,case,case> --max-minutes 10` for a check; the same with `--runs 10` and the eight-case
list (miller-patient,identity-switch,corrected-critical-field,barge-in-interrupt,
hangup-after-request,prompt-injection-midcall,dana-patient,judge-out-of-scope) for a batch.
`npm run grade:record -- <bundle.diagnostics.json>` for the experience counts;
`npm run audio:timeline -- <run>.agent.wav <run>.diagnostics.json` for what the caller heard.
Keep the laptop awake (caffeinate -i wraps the batch; the lid must stay open).

## Housekeeping
A git stash entry tagged GOODBYE-CUT-VERIFY-RED-CHECK is inert in the stash stack (a lane's
RED check; the rails would not let it drop). Two lane checkpoint commits sit on main (dd88270,
the config lane's "wip", and the sequence is otherwise clean). About 110 lane worktrees exist
under .claude/worktrees; none is in use.

## Next session
"Day 12 resume: read docs/STATE.md, then the tail of docs/AUTOPILOT_LOG.md from the
2026-09-19 3:38 PM entry. Live is e23ae04 (deploy 60), the first 10/10 clean batch. First:
confirm /health, run a 3-run check on cases 11, 5, 7, read their Audio sections, then ask
the founder for his twenty-minute voice session on those three cases. No full batch before
that. One status per batch, two lanes at most."
