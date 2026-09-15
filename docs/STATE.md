# Countersign, session snapshot (overwritten at every close; never appended)

Last close: Monday 2026-09-14, 7:31 PM CDT (Day 7, which ran 8:41 AM to 7:31 PM; autopilot
on 3:33 PM to 7:05 PM). Autopilot is OFF. No lanes in flight: every lane of the day landed.

## The one-paragraph version

Day 7 turned the goodbye bug into a way of working. The server close path got a time budget,
a transcript-armed hang-up, an idle-timeout goodbye and no speech after the goodbye; the
question path got a re-ask when the model swaps a holding line for the question, imperative
asks count, and an "issued" action follows the transcript. The harness grew free-play mode
(an improvising caller with seeded random pauses), waits for the server's own hang-up,
grades the goodbye, dedupes repeated questions and regrades stored reports. The founder set
the definition of done (a judge in their own words, any pauses, any pronunciation, every
case), killed the simulator idea with two external panel seats, ruled live tests only,
approved about five hours of credit, and made Haiku the default lane model. The AssemblyAI
docs were fetched and settle the design: no verbatim-speech event exists, the automatic reply
cannot be stopped, reply.create is the only "speak now"; the next design step (E) lets the
automatic reply be a holding beat and sends one instructed reply.create. The first free-play
batch (deploy 30) scored 21 of 30 on verdict after regrade; three product defects (a sealed
verdict drifted and spoke the wrong goodbye; a self-correction lost in the readback; a request
without an amount produced an invented question) were fixed, reviewed and deployed as push 32.

## PROVEN at this close
- Live: 6ddd9e9 served 7:27 PM, /health ok. Pushes 26 to 32 today, CI green on each.
- Close gate 7:31 PM: 1692 tests across 88 files, typecheck clean; corpus 128/128 (7:11 PM).
- Credits (founder dashboard 5:34 PM): 2.9 h used, $86.92 left, about $4.50 per hour. The
  free-play batch used about 35 min; today's harness total about 56 min plus the batch
  (ESTIMATE, wall clock).
- Standing plan: docs/TEST-PLAN.md (rulings, docs quotes, design E, milestones, pass criteria,
  eleven cases, commands, batch findings, next-session order with step 1b follow-ups).
- Panel record: docs/PANEL-2026-09-14-TEST-PLAN.md. Play sheet: docs/PLAY-SHEET.md (proof
  lines from the deploy-28 scripted runs; free-play batch results in TEST-PLAN).

## Open, in the order to take them (mirrors docs/TEST-PLAN.md)
1. Step 1b follow-ups (Haiku): seal truncation by array position; department words not
   captured as an approver; watchdog boundary test for a long goodbye. Plus
   questionMatch.ts returning the new ELICIT_REQUEST sentence.
2. Design E (holding beat, then one instructed reply.create), test-first, one lane, scoped
   review, push, verify.
3. 30 min live confirmation on the three known races; then the 45 min free-play batch;
   regrade; classify every non-pass HARNESS / PRODUCT / UNKNOWN with its report.
4. Case 11 scenario and persona. Sheet proof lines. Founder play-through in his own words.
5. Founder items: re-record; Render env items; pre-flip items; the Sep 18 judge sim.

## Lessons written to memory today
Done means any judge. Prove the script before founder time. Only the re-gate on main is
proof. Haiku by default (hook enforces SONNET-JUSTIFIED). Live is the only ground truth for
speech. Do not launch lanes after a token warning without the founder's word; the autopilot
toggle only fires on a message that is the words alone.

## How to test without being the tester
`npm run rehearse -- --scenario miller-patient --url https://countersign-bf8q.onrender.com`;
`npm run sim:freeplay -- --url https://countersign-bf8q.onrender.com --model openai/gpt-4o-mini --runs 3 --seed <n>` (needs OPENROUTER_API_KEY exported);
`npm run rehearse:regrade -- scripts/rehearse/reports/<report>.md` (free).

## Next session
"Day 8 resume: read docs/TEST-PLAN.md first, then docs/STATE.md and the tail of
docs/AUTOPILOT_LOG.md. Nothing is in flight. Start at step 1b, then design E, then the 30 min
live confirmation, then the 45 min batch. Live tests only; log every minute; a fix that fails
twice live is parked; Haiku by default."
