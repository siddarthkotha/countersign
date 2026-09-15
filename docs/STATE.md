# Countersign, session snapshot (overwritten at every close; never appended)

Last close: Tuesday 2026-09-15, 2:25 PM CDT (Day 8, which ran Monday 7:37 PM to Tuesday
2:25 PM with two API-limit outages, 10:34 PM to 11:40 PM and 10:41 AM to 11:30 AM; autopilot
on 10:29 PM to 1:30 PM). Autopilot is OFF. No lanes in flight.

## The one-paragraph version

Day 8 was the founder's first full live run of all eleven cases (Monday 9:50 to 10:14 PM):
four verdicts wrong (5, 6, 8, 11), case 7 never hung up, goodbyes cut off, case 11 looped,
and the recorder had stored no words. Overnight and this morning the logs were analysed and
every finding fixed test-first: a bare-name answer no longer reads as a new caller; the idle
timer counts caller silence, not microphone frames; the goodbye waits for its own audio and
is sent once; every record carries verbatim words and AssemblyAI's billed seconds; the case 11
script now corrects to Dana's real $84,500 (the $48,500 script could never stage by design of
the payment record check). Design E (holding beat plus one instructed reply per caller turn)
went live in push 39 and measured worse on chatter and no better on the goodbye tail, so two
follow-ups landed: a fragment brake and an empty automatic reply. The engine now leaves a
question waiting when a reply carries no answer, re-asks up to twice, recognises terse
answers and spoken digits, and never grades filler as an answer. Founder rulings: case 11 is
STAGE and corrected amounts do not count toward exposure (ruling 5); an injection attempt
escalates on its own and no longer feeds the freeze count (ruling 6); the three recordings
whose numbers changed under the new grading are approved; the admin token stays.

## PROVEN at this close
- Live: deploy 39 (06368f6) served at the time of writing; push 40 (fifteen commits, main at
  fd75123) goes out with this close and is verified below in the log.
- Close gate numbers are on the closing log line (typecheck, full suite, corpus).
- Harness on deploy 36: 10 of 11 pass; case 11 passed on deploy 38 (STAGE, 100 s, billed
  100.19 s recorded). Design E confirmation on deploy 39: 5 of 6 pass, one defensible freeze.
- Report of the whole round: docs/RERUN-2026-09-15.md. Plan: docs/TEST-PLAN.md (rulings 5, 6).
- Founder dashboard credit: 3.8 h used, $83.01 left at Monday 8:45 PM; about 45 min of
  harness time since (ESTIMATE); npm run credits:ledger reads billed seconds from deploy 38 on.

## Open, in the order to take them
1. Verify deploy 40, then the second six-call confirmation (miller, dana, miller-silent,
   case 11, miller, dana) against deploy 36 on goodbye delay, agent lines, wall time. If it
   beats deploy 36, the founder plays cases 5, 7, 8, 11 (he is ready; about 20 min).
2. Free-play batch (45 min) once the confirmation passes; regrade; classify non-passes.
3. Rewrite injection-plus-two-slips-escalates.json as a real ruling-6 proof (append a new
   fixture with explicit challenge specs so two wrong answers grade FAIL).
4. Founder decisions parked: case sheet on the landing page; two .claude edits (pre-commit
   gate false failures in worktrees; status line model name).
5. Known limits, labelled: the empty automatic reply is UNKNOWN live until measured;
   magnitude number words ("two thousand and one") are not digitised for account fields.

## Lessons written today (memory)
Founder calls need zero-step capture and verbatim words; prove the capture path with a
harness call before any founder session; `isolation: "worktree"` cuts from the session-start
tip, hand-cut worktrees from main instead; a lane's green count is not proof until the gate
runs on main; copy the injected clock, never infer the time; "simplify X" may mean "explain
X simply", ask before changing a rule.

## How to test without being the tester
`npm run rehearse -- --scenario <name> --url https://countersign-bf8q.onrender.com`
(scenarios: dana-patient, miller-patient, judge-out-of-scope, identity-switch,
barge-in-interrupt, single-wrong-answer, hangup-after-request, prompt-injection-midcall,
structuring-two-wires, miller-silent-after-amount, corrected-critical-field);
`npm run sim:freeplay -- --url <url> --model openai/gpt-4o-mini --runs 3 --seed <n>`;
`npm run rehearse:regrade -- <report.md>`; `npm run credits:ledger`;
live records: GET /api/admin/sessions (bearer COUNTERSIGN_ADMIN_TOKEN from .env), then
GET /api/session/<id or 8-char code>/diagnostics.

## Next session
"Day 9 resume: read docs/STATE.md, docs/RERUN-2026-09-15.md, then the tail of
docs/AUTOPILOT_LOG.md. Nothing is in flight. Start by confirming deploy 40 is served, run the
six-call confirmation, compare with deploy 36, then hand the founder cases 5, 7, 8, 11. Live
tests only; fetch every founder record before any push; Haiku by default, Sonnet for server
timing and reviews."
