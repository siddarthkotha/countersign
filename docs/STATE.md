# Countersign, session snapshot (overwritten at every close; never appended)

Snapshot: Tuesday 2026-09-22, 10:57 PM CDT (Day 13 evening, same session continues overnight on
autopilot). Founder asleep; his rulings tonight are below. Live: 5942159.

## The one-paragraph version

The founder's three calls at 6:52 to 6:58 PM all failed (case 6 twice because my run sheet asked
him to contradict an approver question the agent never asks; case 1 from a missed name-first
payee, a dropped STT fragment, a double question and a four-times goodbye). He had two external
AI panel rounds critique the plan (docs/PANEL-2026-09-22-LIVE-RELIABILITY.md). They converged:
two voices per call (AssemblyAI's automatic reply plus our instructed replies) is the root of
the repeat bugs, 9/10 on ten calls is not evidence, and the submission should lead with a
recorded call. AssemblyAI's docs confirmed there is no switch to silence the automatic reply,
that "connect your own LLM" lets our endpoint write every reply, and that my Day 13 min_silence
setting switched off their adaptive pause handling. Tonight: the replay with his real voice was
built and verified live; the "one voice" build (our deterministic engine writes every word via
the own-LLM endpoint) was spiked, planned, red-teamed and built in reviewed pieces behind
COUNTERSIGN_BRAIN (default legacy, inert on the live site). Its first live run (local server
behind a tunnel) failed twice: a per-goal session.update erased the per-call token; fixed and
audited at 5942159. Next live run: Wednesday 6:47 AM (scheduled wake-up).

## Founder rulings tonight
- 7:43 PM option (ii): the recorded call is the primary judge path; live is a labeled
  experimental bonus; three cases (STAGED, FROZEN, ESCALATED).
- 8:00 PM his own voice may be public in the replay.
- 8:22 PM landing option A: "Watch a recorded attack" opens his recorded fraud call with audio;
  the live button reads "Try it live (experimental)".
- 10:12 PM keep Thursday Sep 24 as the submit target; decide Wednesday noon on the one-brain
  results.

## PROVEN at this snapshot
- Live 5942159 since 10:48 PM: /health 200; POST /api/brain/chat/completions 404 (absent);
  replay audio 200. Real-Chrome walk on 43189e5 (9:15 PM): recorded calls play his real voice
  in sync via Web Audio, WIRE FROZEN / STAGED verdicts, labels correct.
- Gate on main at 5942159: typecheck clean, 2653/2653 tests, three consecutive runs.
- "Ignored landing clicks" = automation artifact (unselected tab, document.hidden true), not a
  product bug.

## One-brain status (plan: docs/plans/2026-09-22-one-brain-live-path.md)
Built and reviewed: token registry + wait hook + two-writer gating (c73ae21), endpoint route
(935bf12), close grace after a heard goodbye with the audio floor (1b682bf), stored-agent
bootstrap and bind wiring (4630a8a), late-transcript catch-up with staleness guard (4a0c931),
agent REST timeouts (c88352f), interim spoken lines (spokenLines.ts, plain desk-officer drafts),
token-overwrite fix + no duplicate agents (5942159). Env needed to switch on:
docs/ONE-BRAIN-ENV.md (not set anywhere yet).

## Overnight rule
The judge site switches to endpoint mode ONLY if each case (dana-patient STAGE,
scenario-b-miller-fraud FREEZE, single-wrong-answer ESCALATE) reaches 3 consecutive clean
harness runs and a review is clean. Otherwise legacy stays. Hard stop after two failed grades.

## Parked for the founder
- WALKER-SELECTED-TAB-CHECK: add a selected-tab check to qa-walker / judge-sim definitions.
- Branch deletes for worktree-agent-* branches (hook-blocked on autopilot; harmless).
- .env.example lines for the turn-detection and brain env vars (pre-commit gate blocks it).
- Spoken lines are interim drafts; he reacts to real audio.

## Next session
"Resume: read docs/STATE.md and the AUTOPILOT_LOG tail from 2026-09-22 10:33 PM. At 6:47 AM
Wednesday: rerun the live endpoint trial on a local server behind a tunnel (three cases, hard
stop after two failed grades), switch the judge site only on 3 clean runs per case, then write
docs/MORNING-2026-09-23.md and notify the founder. Noon Wednesday: his submit decision."
