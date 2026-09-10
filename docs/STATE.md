# Countersign, session snapshot (overwritten at every close; never appended)

Last close: Wednesday 2026-09-09, 8:27 PM CDT (Day 4). Autopilot ran 7:41 to 8:30 PM and is OFF.

## The one-paragraph version

Five days of "the honest caller escalates instead of staging" had one cause, and it was not the
engine: the rehearsal script's file loader dropped the persona field, so every honest-caller
live run since Sep 4 was minted as the attacker. Found tonight only after the flight recorder
learned to log what the server resolved. Fixed with a regression test, proven STAGE on the local
compiled server. Twenty-one founder rulings were made and built in parallel lanes: three
rule-table changes, honest-caller facts, injection escalates, hedge bound, spoken-number fix,
timeout incident as an engine rule, em-dash sweep, autoplay, submission trim, live-path
end-to-end test, CI tuning, four new attack scenarios, external critic panel. Two pushes went
out after the full gate. Gate G2 was then MET on the deployed site at 8:05 PM (STAGE twice, zero resets) and the fraud path re-proven on the same commit.

## PROVEN (each checked against the real source tonight, not from notes)

- Main f1a765e (push 9) is LIVE: /version matches, /health ok, verified 8:30 PM. CI green on all
  three pushes tonight (9e64bc5, 1d596c0, f1a765e). npm test 1051/1051 three times before the
  last push, typecheck clean. The suite now includes the rehearsal and critique harness tests
  (was 57 files / 888 at 6 PM, is 70 / 1051).
- GATE G2 MET: scenario A twice consecutively on the DEPLOYED site, STAGE 73.8 s and 91.5 s, zero
  resets (reports 2026-09-09T20-02-51 and 20-04-50). Fraud re-check on the same commit: FREEZE,
  57.4 s wall (report 20-06-19).
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

1. Nothing is in flight. Pushes 8 and 9 landed and are verified live (README refresh, transcript
   dedupe, RULES_DOC cleanup).
2. Gate G3 evidence: every rehearsal now writes a raw bundle with the checklist per transition;
   19 recordings replay exactly. Consider a bridge from bundle to corpus file (not built).
3. Friday Sep 12 judge simulation; build the judge-sim agent then.
4. Founder decisions parked: on-screen banner for abandoned containment (visual); UI jargon
   copy; whether urgency should ever carry weight (recommendation: no); RT-9b escrow grading.
5. Housekeeping parked: 29 worktrees / 28 lane branches to remove (a delete, so founder's call);
   README still has em-dashes outside Status (pre-flip sweep).

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

"Day 5 resume: read docs/STATE.md and the tail of docs/AUTOPILOT_LOG.md. G2 is met and both
paths are proven live on 9e64bc5. First job is the parked founder decisions (containment banner,
UI jargon, urgency weight, RT-9b), then rehearsals for the latency table, then Friday's judge
simulation (build judge-sim then). Do not spend live calls re-proving what the reports already
prove."
