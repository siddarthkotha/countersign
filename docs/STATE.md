# Countersign, session snapshot (overwritten at every close; never appended)

Last close: Thursday 2026-09-17, 11:58 AM CDT (Day 9, which ran Wednesday 5:45 PM to
Thursday 11:58 AM with a pause 9:15 PM to 6:45 AM; the 10:40 PM resume never self-started,
see the lesson below). Autopilot was ON for the whole day. No lanes in flight.

## The one-paragraph version

Day 9 was the free-play day. Six pushes (42 to 47, 47 commits) went out, each behind a triple
gate and a Sonnet review. The defect of the day: after an automatic AssemblyAI reply that
starts within 10 ms of our instructed reply, the agent's transcripts stop for the rest of the
call. It was invisible (unmodelled messages were dropped uncounted), then observable (push
43), then countered: the "One moment." holding beat restored and a degraded-transcripts mode
that stops blind re-asks and confirms the goodbye from audio. Rate: 6 dead calls of 33 on
deploy 43, 1 of 33 on deploy 45. Two free-play batches (66 calls, an AI caller improvising
inside each scenario) went 12 of 33 then 17 of 33 clean, fraud cases 9 of 9 on the second,
and surfaced real engine gaps, all fixed with verbatim fixtures: an honest Dana frozen by
"Marcus is the one who approved", "ends in 4471" and "wire $84,500 to Meridian Supply" not
extracted, a volunteered approver contradiction graded as a correction, and the row-11 hole
(STAGE with a failed knowledge check) closed as proposed ruling 9. Founder ruling 7 changed
the close lines to "The payment is not released." Scripted proofs on deploys 44 to 47: 16 of
16 clean; the STAGE goodbye now lands 5.5 s after the verdict.

## PROVEN at this close
- Live: push 47 (989e91a) served, /health ok (checked 11:46 AM). Close gate numbers on the
  closing log line.
- Scripted proofs: deploy 44 10/10, deploy 46 4/4, deploy 47 2/2 (records 2026-09-17T07,
  T09-5, T10-1). Free play: docs/AUTOPILOT_LOG.md 6:48 AM and 10:06 AM entries; roll-ups
  2026-09-16T21-37-49 and 2026-09-17T09-52-22 in scripts/rehearse/reports.
- Analyses: docs/analysis/goodbye-tail-2026-09-16.md, docs/analysis/case11-freeplay-2026-09-17.md,
  docs/SPIKE2-2026-09-16.md. Latency table regenerated (n=142, p50 616 ms, p95 1767 ms, ESTIMATE
  by harness wall clock).
- Credit: 92 live calls on Day 9, ESTIMATE about $16; ledger has PROVEN billed seconds per
  day (npm run credits:ledger); dashboard balance UNKNOWN (last read $83.01 Monday 8:45 PM).

## Open, in the order to take them
1. Founder play-through of cases 5, 7, 8, 11 on deploy 47 (about 20 min). Fetch the records
   before any push (GET /api/admin/sessions, then /api/session/<id>/diagnostics).
2. Founder rulings, batched: 8 (approver named after an agent question is a contradiction),
   9 (a failed knowledge check blocks STAGE), 9b (same-breath correction graded on the final
   value); accept ESCALATE-or-FREEZE for miller-silent and structuring in the harness (six
   plus five records, timing decides); out-of-scope role prompt (judge says "I'll go with
   CEO" and gets interrogated about location); never-speak-JSON rule (one live instance);
   a Sonnet cap in the model hook (today 34 Sonnet lanes vs 7 Haiku; the marker is checked,
   not its merit).
3. Friday judge simulation (2026-09-18) against the live URL, then G5 (50+ rehearsals, tail
   latency) by Monday 2026-09-21 and G6 video by 2026-09-27.
4. Held follow-ups, all bounded: FINAL-VALUE-TWO-UTTERANCES, BENEFICIARY-SPOKEN-AMOUNT,
   NEGATION-INTERJECTION, HOLD-FOLLOWUP-RESCHEDULE, CLOSE-MATCH-GARBLED-LIMIT,
   SESSION-UPDATE-MID-REPLY, plus the older founder-decision items on the board.

## Lessons written today (memory)
A named resume time gets a scheduled wake-up or a plain "I cannot self-start", never "say
resume" (eight hours lost). Never launch lanes at "open countersign"; the lane-gate hook's
launch text is advisory. Lanes can edit the main checkout by mistake and can report green
counts that do not hold on main: the pre-commit gate is the proof, not the lane. Corpus
fixtures are named for what they prove, never for a verdict they do not reach. Free-play
batches have diminishing returns after two; the next signal is the founder's voice and the
judge sim.

## How to test without being the tester
`npm run rehearse -- --scenario <name> --url https://countersign-bf8q.onrender.com`
(eleven scenarios, see scripts/rehearse/scenarios); `npm run rehearse:batch -- --url <url>
--runs <total calls> --scenarios a,b,c --max-minutes <m>`; free play needs the env loaded:
`set -a; source .env; set +a; npm run sim:freeplay -- --url <url> --model openai/gpt-4o-mini
--runs 3 --seed <n>` (33 calls, about 80 min, about $6); `npm run rehearse:regrade --
<report.md>`; `npm run credits:ledger`. Dead-transcript scan and per-call tails: the
scratchpad scripts deadscan.py and compare.py from this session (re-create from the log if
the scratchpad is gone; each is 40 lines over the diagnostics bundles).

## Next session
"Day 10 resume: read docs/STATE.md, then the tail of docs/AUTOPILOT_LOG.md from the 2026-09-17
6:48 AM entry. Nothing is in flight; live is push 47. First: the founder plays cases 5, 7, 8,
11 and answers the batched rulings; fetch his records before any push. Then Friday's judge
simulation. Haiku first for lanes, Sonnet only after a Haiku miss on the same item."
