# Countersign — session snapshot (overwritten at every close; never appended)

Last close: Friday 2026-09-04, ~1:10 AM CDT (Day 3 ran past midnight, autopilot on).
Founder asleep. Autopilot still ON: say "autopilot stop" to take back the wheel.

## The one-paragraph version

Your rehearsal at 10 PM found that the demo never reached a verdict. Two separate,
unconditional bugs meant a staged outcome was impossible for ANY caller, and the call looped
until the cap. Both are fixed, reviewed and deployed. The fraud interrogation now runs end to
end on the live site with no human: FREEZE in 58 seconds, PROVEN at 1:07 AM against
https://countersign-bf8q.onrender.com. The legitimate path no longer stalls but ends in
ESCALATE rather than STAGE, and that last gap is the first thing to look at.

## Live and PROVEN (each verified by me tonight, not from notes)

- Deployed: https://countersign-bf8q.onrender.com serves commit bc88761 (GET /version, added
  tonight precisely so a deploy can be confirmed without guessing). Health ok. CI green.
- Fraud path PASSES on the DEPLOYED site: scenario B, FREEZE, 57.9s, zero human input.
  Report: scripts/rehearse/reports/2026-09-04T01-07-41-scenario-b-miller-fraud.md
- 809 tests green three runs in a row, typecheck clean, all 18 recorded calls replay exactly.
- Roughly 19 minutes of AssemblyAI credits spent tonight (ESTIMATE, harness wall clock).
- GitHub Actions: 6 runs and about 10 billed minutes of 2000 this month. The keepalive cron
  stays disabled; enabled it would burn thousands of runs.

## What was wrong, and what fixed it

1. Nobody ran the three background checks on a live call, so the engine held forever. The
   server now runs them itself from the state machine (422d750).
2. The engine re-ran on every audio frame, about 100 times a second, filling the flight
   recorder in 46 seconds. Fixed, and the recorder gained real timing events (b6e5ba7).
3. The model was offered tool schemas, read a field name off one, and demanded an "identity
   id" no caller could know. It is now offered no tools at all (42d720f).
4. The readback confirmation compared a formatted string against a raw number, so two of the
   three critical fields could never be confirmed. The engine now composes the exact sentence
   and stores a comparable value (571ee31).
5. Every live call was labelled an unverified gateway, which fails the sign-in check by
   design, so staging was unreachable. A named demo persona now maps, server-side only, to
   the simulated telemetry (3ff88d3).
6. My own mistake: I shipped a change that made the agent read its stage directions aloud to
   a caller, after its own author warned me it would. Caught on the next live call and fixed
   (c2fc4bd). The lesson is in the log: a flagged risk in an agent's report is a blocker.

## Open on you (in the order I would take them)

1. **The staging gap.** The legitimate call reaches ESCALATE, not STAGE. The terminal action
   fires as the third challenge is asked, before the caller's answer arrives. UNKNOWN whether
   that is engine grading, the challenge budget, or my scripted caller being too slow. Needs
   an investigation, not another live call.
2. **What an honest caller gets asked.** Every seeded knowledge fact belongs to the
   fraudster's deal, so an honest caller can be asked something she cannot answer. The fix is
   built and tested but NOT committed, because on its own it leaves her with no question at
   all. Two options and my recommendation: docs/PARKED-CHALLENGE-SCOPING.md.
3. **Six more attack paths** found by a red-team agent, each needing a policy ruling rather
   than a patch: docs/RED-TEAM-2026-09-03.md. The one I would fix first is that an abandoned
   call leaves no incident at all, which is a real hole in LAW 2.
4. **The judge card: 26 of 40, "does not place as it stands."** docs/JUDGE-SIM-2026-09-03.md.
   Most of its findings are already fixed; the rest are your calls.
5. **Small rulings:** the submission's judged section grew to 524 words from 399; em-dashes
   are all through the shipped interface copy while your style law bans them; should the
   flagship recording play automatically for a judge.
6. **The external model panel never ran.** No OpenRouter or Gemini key is in .env, and the
   keys are not in the ShadePath files either. The runner is built and dry-run verified, so
   it fires the moment you drop a key in.

## How to test without being the tester

`npm run rehearse` plays scripted callers against the real stack with a synthesised voice and
grades the result. Read docs/REHEARSAL-HARNESS.md first, including the trap: the local server
loads the COMPILED engine, so run `npm run build:engine` before testing an engine change or
you will test the old code.

## Next session

"Day 4 resume: read docs/STATE.md, docs/RED-TEAM-2026-09-03.md and
docs/PARKED-CHALLENGE-SCOPING.md, then .claude/backlog.json and the tail of
docs/AUTOPILOT_LOG.md. First job is the staging gap: find why the legitimate call ends in
ESCALATE instead of STAGE, using the harness locally rather than live calls. Then bring the
founder the challenge-scoping decision. The fraud path is proven live and must not regress."
