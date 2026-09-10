# Countersign, session snapshot (overwritten at every close; never appended)

Last written: Wednesday 2026-09-09, 8:04 PM CDT, on autopilot (founder said "Autopilot Start"
at 7:41 PM). Day 4. This file is a running snapshot tonight; the close pass rewrites it.

## The one-paragraph version

Five days of "the honest caller escalates instead of staging" had one cause, and it was not the
engine: the rehearsal script's file loader dropped the persona field, so every honest-caller
live run since Sep 4 was minted as the attacker. Found tonight only after the flight recorder
learned to log what the server resolved. Fixed with a regression test, proven STAGE on the local
compiled server. Twenty-one founder rulings were made and built in parallel lanes: three
rule-table changes, honest-caller facts, injection escalates, hedge bound, spoken-number fix,
timeout incident as an engine rule, em-dash sweep, autoplay, submission trim, live-path
end-to-end test, CI tuning, four new attack scenarios, external critic panel. Two pushes went
out after the full gate. Deployed proof of STAGE (gate G2) is the open item.

## PROVEN (each checked against the real source tonight, not from notes)

- Main 9e64bc5 pushed 8:02 PM. npm test 1049/1049 three times, typecheck clean. The suite now
  includes the rehearsal and critique harness tests (was 57 files / 888 at 6 PM, is 69 / 1049).
- CI green on b556864 (push 6). Push 7 (9e64bc5) CI and Render deploy were being polled at the
  time of writing; see docs/AUTOPILOT_LOG.md for the outcome line.
- Honest scenario STAGE on the LOCAL compiled server: report
  scripts/rehearse/reports/2026-09-09T19-14-56-scenario-a-dana-legitimate.md, verdict STAGE at
  93.7 s, every checklist item true, persona recorded as legitimate at mint and attach.
- Root cause: scripts/rehearse/scenario.ts never copied demo_persona (fixed 75e31df). The
  recorder's session_minted event showed persona_input_present=false, body_bytes=0.
- Fraud path unchanged and still proven live from Sep 4 (FREEZE, 57.9 s).
- 19 recorded calls replay exactly through the engine (was 18; abandoned-open-request.json added).
- External critic panel ran (GPT-4o, Perplexity; Grok and Gemini ids fixed for next time):
  65 findings; three verified with file:line, one refuted, rest triaged on the board.

## What landed tonight (all reviewed by a separate lane before push)

Rules: no STAGE without one passed question (row 4 floor + checklist item); injection attempt
adds a full point and blocks STAGE; the last question can no longer go terminal before the
answer (challenge_answer_window_ms); call ends with open request => ESCALATE by engine row 14.
Challenges: every fact scoped to an identity, Dana has three of her own (INV-7734, Marcus Obi,
quarterly parts restock), trap question can no longer speak another identity's truth, spent
facts never re-asked, relational grading uses the named beneficiary. Ledger: a hedge that
more than doubles or halves is CONTRADICTED. Numbers: "thanks a million" is not a claim.
Server: export hash survives a fast hang-up; recorder logs rule row, checklist, cards,
counters, readbacks, resolved persona and call context; errored containment never reads
SEALED. Web: em-dashes gone (guard test incl. corpus titles), flagship recording autoplays,
honest labels for the two new checklist items and for the replay Play control. Docs:
submission long description 400 words. CI: concurrency cancel + docs path filter. Harness:
raw diagnostics bundle saved per run; four adversarial scenarios written (not run).

## Open, in the order to take them

1. Gate G2: two consecutive honest runs against the DEPLOYED site once push 7 is live. The
   auto-mode classifier blocked `npm run rehearse -- --url <deployed>` from me twice; the
   founder pastes the command (docs/REHEARSAL-HARNESS.md) or allows it once.
2. README Status refresh after the deployed STAGE proof (it still names a live blocker).
3. Two follow-up lanes in flight at time of writing: RULES_DOC row 4 wording plus dead
   amendment_only field; transcript item_id dedupe after an AssemblyAI resume.
4. Founder decisions parked: on-screen banner for abandoned containment (visual); UI jargon
   copy; whether urgency should ever carry weight (recommendation: no); RT-9b escrow grading.
5. Judge simulation Friday Sep 12 (build the judge-sim agent then, not before).

## Founder rulings recorded tonight

Subscription tier vs OpenRouter: parked until after Sep 30. OpenRouter serves the Anthropic
protocol (proven by a live call); its only job now is the Friday critic panel. Ponytail,
Graphify, RTK: none during the hackathon; RTK trial after Sep 30 in a throwaway folder.
Corpus gate yes given 7:01 PM for the five extended recordings and the injection flip.

## How to test without being the tester

`npm run rehearse -- --scenario scenario-a-dana-legitimate` against a local server (build first:
`npm run build`, then `node packages/server/dist/index.js` with .env loaded). Add
`--url https://countersign-bf8q.onrender.com` for the deployed site (spends credits). Every run
now writes a raw diagnostics bundle next to its report with the checklist per transition.

## Next session

"Day 5 resume: read docs/STATE.md and the tail of docs/AUTOPILOT_LOG.md. First job is G2: two
consecutive honest runs on the deployed site (the founder runs or allows the command). Then the
README status refresh, then the parked founder decisions, then Friday's judge simulation."
