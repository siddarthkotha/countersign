# Rehearsal 1 report — Thursday 2026-09-03, ~10:00 PM CDT (first live Scenario B on the deployed site)

Written by the orchestrator from the founder's four screenshots, the browser console line, and the
flight-recorder bundle for call id 1bc5b441-f823-4e9c-94e4-5a6964e80fd9 (deployed commit 9466de6).
Every claim is labelled PROVEN (source), ESTIMATE (method), or UNKNOWN (how to find out).

## What happened (PROVEN: screenshots + bundle)
- Setup: desktop Chrome, https://countersign-bf8q.onrender.com, role "Try to break it", Start Call.
- The caller (founder as "Robert Miller") asked for $1.8M to escrow in 10 minutes, was asked the
  counsel-of-record question, answered "the PwC LLC" (KNOWLEDGE CHECK: FAIL), was asked to restate
  the amount, said "$2.1 million" (CONSISTENCY: FAIL, request version 2).
- From line 09 onward the agent said only holding lines ("One moment while that check completes",
  "I am still here", "I cannot provide a timeframe") for the rest of the call.
- The call ended at the 5-minute session cap (bundle end_reason: cap_reached). NO VERDICT.
- Reset count: 0 (no reload). G2 NOT MET: the scenario did not reach a verdict at all.
- Checks panel at the end: identity INFO, request INFO, pressure INFO ("no urgency pressure
  detected"), consistency FAIL, three readbacks PENDING, exposure PASS, knowledge FAIL, two
  consistency-probe FLAGs. No SSO context, payment context, or out-of-band card ever appeared.
  Strip: CONTEXT: PENDING, DEVICE: PENDING throughout.

## Why (PROVEN by code, see docs/AUTOPILOT_LOG.md Day 3 for file references)
1. Deadlock on the lookups. Engine rule 7 holds while the SSO, out-of-band, and context results are
   absent. The holding-line prompt never asks the model to call those tools. The server runs a tool
   only when the model asks. Nobody runs them, so the hold never ends. All 18 corpus recordings carry
   hand-written tool calls, so no test ever covered "the model never calls the tools".
2. Evaluate storm. The server re-ran the whole engine on every audio frame (~100/s while the agent
   spoke): 1,998 evaluate events in 46 s filled the recorder's 2,000-event cap, so the last four
   minutes left no server record.
3. Recorder blind spots. No event for "voice service ready", "reply started", "first audio frame",
   or transcript arrival, so the 15-second silence before the greeting cannot be attributed.

## Numbers (browser console, PROVEN as reported by the page's own timer)
| measure | value | note |
|---|---|---|
| start → ready | 708 ms | first server state event |
| ready → first audio | 14,988 ms | 15 s of silence before the greeting |
| audio underruns | 89 | browser buffer ran dry 89 times |
| turn gaps (7) | 0.4 to 14.8 ms | browser-side only; not the felt latency |
| evaluate events | 1,998 in 46 s | recorder cap hit |

Comparison: Sep 2 local smoke test measured 995 ms connect→ready and 221 ms ready→first audio
(README, n=1). ESTIMATE (from the three early engine timestamps at 0.4 s, 7.1 s, 15.3 s): about
7 s to connect to AssemblyAI from the free Render box, about 8 s more until greeting audio. UNKNOWN
which side owns the delay until the recorder can see it (FIX3 adds those events).

## Secondary observations (not yet acted on; queued)
- PRESSURE SIGNALS read "No urgency pressure detected" although the caller said "in 10 minutes".
  UNKNOWN whether the lexicon requires stronger cues; check packages/engine/src/extract against the
  recorded transcript once the call can be replayed from the recorder.
- Line 02 "loop anyone in." arrived as a separate caller turn (the sentence "Do not loop anyone in"
  was split by turn detection). Cosmetic, but a judge will see it.
- The strip's "Beneficiary: unknown" stayed unknown; the script never states a beneficiary, so the
  readback for it can never confirm. Expected under the current script; note for the shot list.

## Fixes (status at the time of writing)
- FIX1 server-initiated lookups: building in the main folder, test-first.
- FIX2 no engine run on audio frames: built, reviewed PASS, patch saved.
- FIX3 recorder timing events + evaluate dedupe: built, reviewed PASS with accepted findings.
- MERGE23: FIX2+FIX3 hand-combined into one patch (in progress).
- Deploy waits on the founder's push word.

## Next rehearsal (after the fix is live)
Same script. Expect: after the amount change and the wrong counsel answer, the three lookups appear
as cards within one reply, then WIRE FROZEN with reasons and an incident id. Send the three
`[countersign:timings]` console lines and screenshots as before. G2 needs this twice in a row.
