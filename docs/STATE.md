# Countersign, session snapshot (overwritten at every close; never appended)

Last close: Friday 2026-09-04, 4:58 AM CDT (Day 3 ran through the night on autopilot).
Autopilot is OFF. Founder travelling until Sep 8; rehearsals resume Sep 9.

## The one-paragraph version

The 10 PM rehearsal found the demo never reached a verdict. Three separate unconditional bugs
each made that impossible, and hundreds of green tests missed all three because the recorded
corpus never exercises what the live server actually builds. All three are fixed, reviewed,
deployed and proven. The fraud interrogation now runs end to end on the live site with no
human: FREEZE in 58 seconds. The legitimate path no longer stalls but ends in ESCALATE rather
than STAGE, and closing that is the next job.

## PROVEN (verified at 4:31 AM against the real sources, not from notes)

- Live: https://countersign-bf8q.onrender.com serves commit fbfc84f, health ok, CI green on
  that commit. GET /version was added last night so a deploy can be confirmed, not guessed.
- Fraud path PASSES on the DEPLOYED site with no human: scenario B, FREEZE, 57.9s.
  Report: scripts/rehearse/reports/2026-09-04T01-07-41-scenario-b-miller-fraud.md
- Close gate at 4:58 AM: 809 tests pass across 53 files, typecheck clean. All 18 recorded
  calls replayed exactly through the real engine earlier in the session.
- Spend: about 19 minutes of AssemblyAI credits overnight (ESTIMATE, harness wall clock).
  GitHub Actions: 6 runs, about 10 billed minutes of 2000 this month. The keepalive cron
  stays disabled; enabling it would burn thousands of runs.

## What was wrong, and what fixed it

1. Nobody ran the three background checks on a live call, so the engine held forever. The
   server now runs them itself from the state machine (422d750).
2. The engine re-ran on every audio frame, filling the flight recorder in 46 seconds. Fixed,
   and the recorder gained real timing events (b6e5ba7).
3. The model was offered tool schemas, read a field name off one, and demanded an "identity
   id" no caller could know. It is offered no tools at all now (42d720f).
4. The readback confirmation compared a formatted string against a raw number, so two of the
   three critical fields could never be confirmed (571ee31).
5. Every live call was labelled an unverified gateway, which fails the sign-in check by
   design, so staging was unreachable. A named demo persona now maps, server-side only, to
   the simulated telemetry (3ff88d3).
6. My own error: I shipped a change that made the agent read its stage directions aloud to a
   caller, after its author had warned me it would. Caught on the next live call, fixed
   (c2fc4bd). Lesson recorded: a flagged risk in an agent's report is a blocker, not a note.

## Open on the founder, in the order I would take them

1. **The staging gap.** A legitimate call reaches ESCALATE, not STAGE. The terminal action
   fires as the third challenge is asked, before the caller's answer lands. UNKNOWN whether
   that is engine grading, the challenge budget, or the scripted caller being too slow. Use
   the harness locally; do not spend live calls guessing.
2. **What an honest caller is asked.** Every seeded knowledge fact belongs to the fraudster's
   deal. The fix is built and tested but NOT committed, because alone it leaves an honest
   caller with no question at all. Two options and a recommendation:
   docs/PARKED-CHALLENGE-SCOPING.md
3. **Six attack paths** needing policy rulings, not patches: docs/RED-TEAM-2026-09-03.md. The
   one to fix first is that an abandoned call leaves no incident, a real hole in LAW 2.
4. **Judge card, 26 of 40, "does not place as it stands":** docs/JUDGE-SIM-2026-09-03.md.
   Most findings are already fixed; the rest are founder calls.
5. **Small rulings:** the submission's judged section is 524 words against a 399 target;
   em-dashes run through the shipped interface copy while the style law bans them; whether the
   flagship recording should play automatically for a judge.
6. **The external model panel never ran.** No OpenRouter or Gemini key exists in .env, and
   they are not in the ShadePath files either. The runner is built and dry-run verified, so it
   fires the moment a key lands.

## How to test without being the tester

`npm run rehearse` plays scripted callers against the real stack in a synthesised voice and
grades the outcome. Read docs/REHEARSAL-HARNESS.md first, including the trap that cost a live
call: the local server loads the COMPILED engine, so run `npm run build:engine` before testing
any engine change or you will be testing the old code.

## Next session

"Day 4 resume: read docs/STATE.md, docs/PARKED-CHALLENGE-SCOPING.md and
docs/RED-TEAM-2026-09-03.md, then .claude/backlog.json and the tail of docs/AUTOPILOT_LOG.md.
First job is the staging gap: find why a legitimate call ends in ESCALATE instead of STAGE,
using the harness locally rather than live calls. Then put the challenge-scoping decision to
the founder with its two options. The fraud path is proven live and must not regress."
