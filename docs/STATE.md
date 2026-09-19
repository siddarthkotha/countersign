# Countersign, session snapshot (overwritten at every close; never appended)

Last close: Saturday 2026-09-19, 12:05 PM CDT (Day 10, which ran Friday 8:55 AM to Saturday
noon; the founder was present 8:55 AM to about 11:15 AM Friday and again at noon Saturday).
Autopilot ON throughout. No lanes in flight.

## The one-paragraph version

Day 10 was the day the founder's own voice broke the demo and the harness could not see it.
He played cases 11, 5, 7 on deploy 47 and later replayed on deploy 50, and quit: "keeps
asking the same questions", "does not let me complete my sentence", "this will probably be
trashed in seconds". Every complaint was PROVEN in his records within the hour. Six pushes
(48 to 53) fixed: the fake goodbye (the first CLOSE reply went out bare and the model
improvised a question), the garbled first reply (our reply.create raced AssemblyAI's own
automatic reply in the same millisecond), the trap that asserted the TRUE approver
("Marcus Obi" was literally the decoy), a phantom "restate the approver" caused by "It's
approved" being read as a person named "It's", the one-behind question bookkeeping, the
re-ask window, and the big one: the ambient AssemblyAI reply speaks our own question and our
code then asked it again, every readback, every call. A new EXPERIENCE GRADER now fails a
call on repeated questions, merged replies, talk-overs and holding spam; it fails all three
of his records and it failed four harness calls the old grader had passed.

## PROVEN at this close
- Live: https://countersign-bf8q.onrender.com is UP, /health 200 at 12:04 PM (21.5 s cold
  start), /version 95d4948.
- THERE WAS NO OUTAGE. Founder correction 2026-09-19 12:06 PM, and his observation outranks
  my inference: he shut the laptop lid. Every probe I ran was on his machine, so "TCP
  connected in 48 ms then zero bytes for 6784 s" is a SUSPENDED CURL, not a silent server.
  The tell was in my own output and I missed it: a curl with --max-time 45 reported
  total=428 s, and one with --max-time 120 reported 6784 s. The 12:04 PM recovery was a
  21.5 s cold start, which is an idle Render service waking, not a hung process recovering.
  The redeploy (95d4948) was unnecessary and harmless. The matcher measurement stands and is
  still useful: replyCoversCurrentRendering is linear, 20 ms on a 300 KB transcript.
- Credit scare checked and FALSE: the "488 s" call ended cleanly server-side at 115.6 s,
  billed 115.57 s; the "33,626 s" call is harness wall clock across the sleeping laptop with
  no session behind it (diagnostics fetch failed because the session was long gone).
- Experience grades, same eight cases, same grader: deploy 51 repeated_question 23,
  merged 0, talk_over 8; deploy 52 repeats 2, merged 0, talk_over 4, goodbye ~3 s.
  Deploy 53's batch is INCOMPLETE and unusable (the lid closed mid-batch: 7 of 8, two runs
  corrupted by machine sleep).
- Close gate numbers on the closing AUTOPILOT_LOG line.

## Open, in the order to take them
1. Re-run the eight-case graded batch on deploy 53 (95d4948) with the laptop awake. This is
   the first clean read on whether the last repeat fix and the turn_detection removal worked.
   Target: repeated_question 0, merged_reply 0, talk_over 0, holding_spam 0.
2. Harness hygiene, the real lesson: a sleeping laptop corrupts every wall-clock number the
   harness and my own probes produce (it invented a 488 s call that really ran 115.6 s and a
   33,626 s call that never existed). Before any batch, confirm the machine will stay awake,
   and treat any probe whose elapsed time exceeds its own --max-time as suspended, not as
   evidence about the server.
3. EVALUATE-DIAG-DEDUP-HIDES-GRADING (P1): the server only writes an evaluate diag when
   verdict/state/goal/reasons change, so the grader's "was it already graded" condition is
   effectively dead for readbacks. Fix before trusting the grader on new shapes.
4. Founder decisions parked: LAW-F-FLOOR-JUSTIFICATION-WRONG (I justified removing the
   brief's law (f) silence floor partly on entity-aware waiting, which is PROVEN scoped to
   tool parameters and we offer zero tools; the removal stands on measurement alone),
   SECOND-SEED-NAME-IS-CONTAMINATION, CHALLENGE-WINDOW-LATE-UTTERANCE (proposed ruling 10),
   plus the seven rulings still open from Day 9.
5. Then G5 (50+ rehearsals, tail latency) and G6 (video, due 2026-09-27). Submission Sep 30.

## Lessons written today (memory)
Founder-clean is not verdict-clean: a grader that scores verdicts cannot see what a human
hears, and "4 of 4 clean" was true and worthless. Agent worktrees are cut from origin/main,
not local main, so a lane launched mid-push-cycle builds on a stale base and its green counts
do not hold. A flagged risk is a blocker: I held push 52 twice on review findings that were
called non-blocking, and both were real.

## How to test without being the tester
`npm run rehearse:batch -- --url https://countersign-bf8q.onrender.com --runs 8 --scenarios
corrected-critical-field,barge-in-interrupt,hangup-after-request,prompt-injection-midcall,
dana-patient,miller-patient,identity-switch,judge-out-of-scope --max-minutes 25`
then `npm run grade:record -- <bundle.diagnostics.json>` for the experience counts, or read
the Experience table in each report. Keep the laptop awake for the whole batch: a sleeping
machine corrupts the harness's wall-clock grading.

## Next session
"Day 11 resume: read docs/STATE.md, then the tail of docs/AUTOPILOT_LOG.md from the
2026-09-18 3:00 PM entry. Live is 95d4948 and UP; there was no outage, the laptop lid was
closed. First: confirm /health, then re-run the eight-case graded batch with the laptop awake and report repeated_question, merged_reply,
talk_over, holding_spam. Do not ask the founder for his voice until that batch is 0/0/0/0."
