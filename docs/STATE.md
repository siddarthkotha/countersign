# Countersign, session snapshot (overwritten at every close; never appended)

Last write: Sunday 2026-09-13, 11:05 PM CDT (Day 6, which ran 2:34 PM to 11:05 PM; autopilot ON
from 10:21 PM by founder word; this snapshot written on autopilot, founder has not said close).

## The one-paragraph version

Day 6 was the day the founder's own hour exposed what forty green rehearsals had hidden. His
Dana call hit a question the run sheet did not carry; his Miller call heard "one moment while I
verify" and then silence, then a hang-up. His screen recording proved the closing sentence was
never spoken. Root cause: the server changed the agent's instructions mid-turn but never asked
AssemblyAI to speak (their API needs a separate reply.create), and the hang-up guard mistook the
holding line for the goodbye. A harness sweep then proved NO fraud-path run since Sep 3 had ever
spoken its goodbye; only the honest path had. Three server attempts: the first two labelled
replies and failed review or failed live; the third confirms the goodbye by reading the agent's
own transcript for the verbatim close sentence, re-requests it up to three times, and only then
hangs up. Deploy 27 carries it. Live proof under the new grading: Miller 3 of 3, Dana 1 of 1,
goodbye spoken every time. The harness now fails any server-closed call without the goodbye and
has a patient-caller mode that waits like a person. Also landed: the one-command Friday sim
runner, three video artboards, two engine deadlock fixes (a never-stated critical field now gets
asked for, capped and escalated), and the Dana knowledge answers in the run sheet and harness.

## PROVEN (checked against real sources at this write)

- Live: 1befbb2 served at 10:55 PM, /health ok. Pushes 26 (10:20 PM, 21 commits) and 27.
- Gate on main at 0e3ce23 (code tip): 1508 tests across 81 files, typecheck clean, corpus
  128/128, server 395/395, rehearse 329/329. Commits after it are docs and one scenario file.
- Live proof on deploy 27: scripts/rehearse/reports/2026-09-13T22-56-35, T22-57-34, T22-58-41
  (miller-patient, FREEZE, Close line: spoken) and T23-00-15 (dana-patient, STAGE, spoken).
- Regrade sweep (npm run rehearse:regrade over every stored report): 24 former passes across
  seven fraud-path scenarios flip to close_line_not_spoken; Dana and out-of-scope hold. The G5
  "40 rehearsals" count is therefore void and must be rebuilt.
- Founder's recording evidence: session 84ddf47a frames at 75 s and 105 s (scratchpad only).
- Credits tonight ESTIMATE ~5 min (harness wall clock).

## What is on main and live since Day 5 (all gated; reviewed where code)

sim:friday runner (--dry-run); docs/video artboards + BRIEF "In 2024"; engine
ELICIT_MISSING_CRITICAL (spoken verbatim, counts toward the row-13 cap); harness patient-caller
mode, close-line grading, regrade tool, miller-patient / dana-patient / miller-silent-after-
amount scenarios, Dana knowledge answers; server reply.create at tick end and after reply.done,
CONTAIN_NO_DISCLOSURE as a holding goal, transcript-confirmed CLOSE with bounded close_retry.

## Open, in the order to take them

1. Founder: re-record the two calls (docs/VIDEO-RECORDING-PLAN.md, Shot B now carries the
   knowledge answers, Shot C step 6 rewritten). Estimate 30 founder-minutes, not 60.
2. G5 rebuild (founder credits call): `npm run sim:friday -- --runs 6 --max-minutes 45`.
3. POST-GOODBYE-STRAY-LINE (cosmetic; proposal in the log 11:02 PM).
4. Sep 18 judge sim; pre-flip founder items; Render env items; the "after the sim" holds.

## Lessons written to memory today

Prove the script through the harness with the founder's exact words, with a caller that pauses,
the same day, before any founder-time block. Lanes must state their base commit and only the
re-gate on main is proof (two lanes tonight claimed a newer base than they had). A lane silent
for an hour is hung: stop and re-dispatch. Merges are rail-denied on autopilot: cherry-pick.

## How to test without being the tester

`npm run rehearse -- --scenario miller-patient --url https://countersign-bf8q.onrender.com`
(credits, ~1 min); `npm run rehearse:regrade -- <report.md>` re-grades a stored run for free;
`npm run sim:friday -- --dry-run` prints the Friday plan without spending anything.

## Next session

"Day 7 resume: read docs/STATE.md and the tail of docs/AUTOPILOT_LOG.md. The goodbye bug is fixed
and proven live on deploy 27; the founder's re-record is the first founder item; the G5 count must
be rebuilt with the close-line grading; do not trust any rehearsal report older than 2026-09-13
10:43 PM as a pass."
