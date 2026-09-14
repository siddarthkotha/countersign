# Countersign, session snapshot (overwritten at every close; never appended)

Last write: Monday 2026-09-14, 6:43 PM CDT (Day 7; founder present; autopilot toggled on and
off during the day). Three fix lanes may still be in flight when the next session opens: see
"Lanes in flight" below and check them FIRST.

## The one-paragraph version

Day 7 turned the goodbye bug into a way of working. Rounds 4 and 5 of the server close path
landed (time-budgeted retries, transcript-armed hang-up, idle-timeout goodbye, no speech after
the goodbye), then the question path got the same treatment (re-ask when the model swapped a
holding line for the question; imperative questions count; an issued action follows the
transcript). The harness grew free-play mode (an improvising caller with random pauses), waits
for the server's own hang-up, grades the goodbye, dedupes repeated questions and can regrade
stored reports. The founder set the definition of done (a judge in their own words, any pauses,
any pronunciation, every case), killed the simulator idea with two external panel seats, ruled
live tests only, and approved about five hours of credit. The AssemblyAI docs were fetched and
settle the design: no verbatim-speech primitive exists; the server orders the moments and
verifies the transcript; the next design step (E) is to let the automatic reply be a holding
beat and send one instructed reply.create for the engine's line. The first free-play batch
(deploy 30) scored 21 of 30 on verdict after regrade; three product defects and six harness
defects were classified and handed to lanes. Push 31 is live (7e24cf4).

## PROVEN at this write
- Live: 7e24cf4 served 6:34 PM, /health ok. Pushes 26 to 31 today.
- Gate on main at 4014872 (last code tip before docs): rehearse 437/437, full 1674/1674 (88
  files), typecheck clean, corpus 128/128.
- Credits (founder dashboard 5:34 PM): 2.9 h used, $86.92 left, about $4.50 per hour. The
  free-play batch used about 35 min (harness wall clock).
- The standing plan: docs/TEST-PLAN.md (rulings, docs quotes, design E, milestones, pass
  criteria, cases incl. case 11, commands, findings, next-session order).
- Panel record: docs/PANEL-2026-09-14-TEST-PLAN.md.

## Lanes in flight at this write (check with git branch --list 'worktree-agent-*' and the log)
- P1 server (Sonnet): sealed verdict must never move; goodbye is the sealed verdict's sentence;
  idle end must not precede the goodbye. Evidence: reports T18-22-25 structuring, T17-58-23
  barge-in.
- P2+P3 engine (Sonnet): corrected value wins in readbacks and knowledge checks (case 11);
  verbatim elicit for a request missing its amount or vendor. Evidence: T18-05-49, T18-06-55.
- Harness (Haiku): holding prefix + question is a question; hang-up and silent personas state
  the request first; injection persona says the injection line.
If a lane's commit exists on its worktree branch: cherry-pick onto main (merge is rail-denied
on autopilot), gate (npm test, typecheck, corpus), scoped review for server/engine changes,
then push and verify /version.

## Open, in the order to take them
See docs/TEST-PLAN.md "Next session, in this order". Founder items unchanged: re-record (with
docs/PLAY-SHEET.md), Render env items, pre-flip items, the Sep 18 judge sim.

## Lessons written to memory today
Done means any judge (feedback-done-means-any-judge). Prove the script before founder time.
Lanes claim newer bases than they have; only the re-gate on main is proof. Haiku is the default
lane model (hook enforces SONNET-JUSTIFIED). Live is the only ground truth for speech; the
AssemblyAI docs settle the primitives (see the panel record).

## Next session
"Day 8 resume: read docs/TEST-PLAN.md first, then docs/STATE.md and the tail of
docs/AUTOPILOT_LOG.md. Land any evening lane still on its branch, gate, review, push, verify.
Then design E test-first, then the 30 min live confirmation, then the 45 min free-play batch.
Live tests only; log every minute; a fix that fails twice live is parked."
