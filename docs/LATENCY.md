# Latency table

Every number below is either PROVEN (a real subtraction between two events a live run actually emitted, computed by `scripts/rehearse/latencyMath.ts`) or UNKNOWN (the bundle this row/column needs is missing or predates the event) -- never a guess, and never rounded off into a vague qualitative claim (CLAUDE.md rule: always measured p50/p95, milliseconds, stated plainly). p50/p95 use linear interpolation over the sorted sample (the same convention numpy/R-7 use); `n` is the exact sample size for that cell, stated so a small `n` reads as small, not as confidence.

How to regenerate this file: `npm run latency:table` (reads every `*.diagnostics.json` under `scripts/rehearse/reports/`, which is gitignored and lives only on the machine that ran the rehearsals -- see docs/REHEARSAL-HARNESS.md).

Runs with a diagnostics bundle: n=223, date range 2026-09-09 to 2026-09-17.
15 additional `.md` rehearsal report(s) exist in the same directory with NO matching `.diagnostics.json` bundle (older runs, before the flight-recorder fetch was added 2026-09-09) -- every column here is UNKNOWN for those runs; they are not counted in any `n` above.

**Perceived response latency (headline number -- the gap a judge actually feels, ESTIMATE, harness wall clock, all runs/all targets): p50=639ms, p95=1832ms (n=1187 turns; 117 turn(s) excluded as n/a -- see section 3b for the exact method and the per-target/per-scenario breakdown).**

## Method, per column

1. **Socket connect to AssemblyAI ready**: `aai_ready` event minus `aai_connect_start` event (the `aai_ready` event's own `ms_since_connect_start` detail is used when present, since that is the server's own measurement of the same interval; otherwise the two events' timestamps are subtracted).
2. **Ready to first agent audio**: the first `reply.audio.first` event at or after `aai_ready`, minus `aai_ready`. Labeled "greeting" when that run's `aai_ready` event carries `greeting_configured: true`; every other row is labeled "first reply" and is NOT a pure agent-latency number -- see the caveat under section 2 below.
3a. **Server relay gap after AssemblyAI's end-of-turn event (not perceived latency)**: per caller turn, the LAST `input.speech.stopped` event before the next `reply.audio.first` event, subtracted from that `reply.audio.first` (falls back to the last `transcript` event with `role: "user"` on a bundle with no `input.speech.stopped` events at all -- none of the runs on disk today needed that fallback). Review finding 2026-09-11: this is NOT the gap a judge feels -- `input.speech.stopped` is AssemblyAI's own end-of-turn DETECTION event, which lags the caller's actual last word by AssemblyAI's own (unmeasured by this harness) turn-detection delay, and on at least one turn in the corpus (2026-09-11T17-44-51, turn c4) the server's own `reply.started` event fired BEFORE `input.speech.stopped` did -- proof this column can even race backward relative to the real conversation. Kept here as a distinct, separately labeled number (never blended with 3b) because it is still a real, useful diagnostic of AssemblyAI's own relay/detection behavior. A turn the call ended without ever hearing a reply contributes nothing to this column (same as a run report's own "no reply audio observed after this turn" note) -- it is not counted as 0ms.
3b. **Perceived response latency (the gap a judge feels) -- ESTIMATE**: parsed from each run's own paired `.md` report's "Per-turn gaps" table. Method: harness wall clock from the synthetic caller's last audio frame to the agent's first reply audio; includes AssemblyAI end-of-turn detection; ESTIMATE because the synthetic caller is not a human. A turn whose gap is "n/a" in that table (no reply arrived before the call ended or the next turn started) is EXCLUDED from the p50/p95 sample and COUNTED separately (see the per-run table's "perceived n/a" column and each aggregate row's own turn count) -- it is never treated as 0ms.
4. **Connect to terminal verdict**: the first `terminal_action` event's timestamp (baseline: `aai_connect_start` at t=0). A run with no `terminal_action` event (it never reached a verdict -- a FAIL) is UNKNOWN for this column, and excluded from `n`.
5. **Verdict to call end**: `session_ended` minus that same `terminal_action` event.

## Per-run raw numbers

| file | date | target | scenario | connect->ready | ready->first-audio | label | connect->verdict | verdict->end | relay-gap turns | perceived turns | perceived n/a |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-09-09T18-20-23-scenario-a-dana-legitimate.diagnostics.json | 2026-09-09 | deployed | scenario-a-dana-legitimate | 583ms | 17982ms | first reply, greeting_configured unknown -- older bundle (includes caller talk time before the agent speaks) | 99091ms | 9754ms | 7 | 10 | 0 |
| 2026-09-09T18-56-25-scenario-a-dana-legitimate.diagnostics.json | 2026-09-09 | local | scenario-a-dana-legitimate | 1119ms | 17293ms | first reply, greeting_configured unknown -- older bundle (includes caller talk time before the agent speaks) | 117007ms | 28ms | 7 | 10 | 0 |
| 2026-09-09T19-10-25-scenario-a-dana-legitimate.diagnostics.json | 2026-09-09 | local | scenario-a-dana-legitimate | 879ms | 17499ms | first reply, greeting_configured unknown -- older bundle (includes caller talk time before the agent speaks) | UNKNOWN | UNKNOWN | 7 | 10 | 0 |
| 2026-09-09T19-14-56-scenario-a-dana-legitimate.diagnostics.json | 2026-09-09 | local | scenario-a-dana-legitimate | 979ms | 17394ms | first reply, greeting_configured unknown -- older bundle (includes caller talk time before the agent speaks) | 93741ms | 27922ms | 7 | 9 | 1 |
| 2026-09-09T20-02-51-scenario-a-dana-legitimate.diagnostics.json | 2026-09-09 | deployed | scenario-a-dana-legitimate | 650ms | 17769ms | first reply, greeting_configured unknown -- older bundle (includes caller talk time before the agent speaks) | 73805ms | 45039ms | 8 | 9 | 1 |
| 2026-09-09T20-04-50-scenario-a-dana-legitimate.diagnostics.json | 2026-09-09 | deployed | scenario-a-dana-legitimate | 456ms | 18172ms | first reply, greeting_configured unknown -- older bundle (includes caller talk time before the agent speaks) | 91521ms | 26841ms | 7 | 9 | 1 |
| 2026-09-09T20-06-19-scenario-b-miller-fraud.diagnostics.json | 2026-09-09 | deployed | scenario-b-miller-fraud | 469ms | 13367ms | first reply, greeting_configured unknown -- older bundle (includes caller talk time before the agent speaks) | 36831ms | 20615ms | 4 | 4 | 1 |
| 2026-09-11T16-35-23-scenario-a-dana-legitimate.diagnostics.json | 2026-09-11 | deployed | scenario-a-dana-legitimate | 581ms | 32ms | greeting | 75233ms | 50592ms | 8 | 9 | 1 |
| 2026-09-11T17-44-51-scenario-a-dana-legitimate.diagnostics.json | 2026-09-11 | deployed | scenario-a-dana-legitimate | 607ms | 177ms | greeting | 83266ms | 15534ms | 5 | 6 | 1 |
| 2026-09-11T21-48-50-scenario-a-dana-legitimate.diagnostics.json | 2026-09-11 | deployed | scenario-a-dana-legitimate | 593ms | 178ms | greeting | 80856ms | 15279ms | 5 | 6 | 1 |
| 2026-09-11T21-50-28-scenario-b-miller-fraud.diagnostics.json | 2026-09-11 | deployed | scenario-b-miller-fraud | 378ms | 182ms | greeting | 91691ms | 4ms | 5 | 4 | 1 |
| 2026-09-11T21-52-38-barge-in-interrupt.diagnostics.json | 2026-09-11 | deployed | barge-in-interrupt | 532ms | 34ms | greeting | 123706ms | 4ms | 5 | 7 | 1 |
| 2026-09-11T21-53-19-judge-out-of-scope.diagnostics.json | 2026-09-11 | deployed | judge-out-of-scope | 362ms | 173ms | greeting | UNKNOWN | UNKNOWN | 2 | 2 | 0 |
| 2026-09-11T21-56-33-identity-switch.diagnostics.json | 2026-09-11 | deployed | identity-switch | 378ms | 173ms | greeting | 187801ms | 7ms | 8 | 9 | 0 |
| 2026-09-11T21-58-01-prompt-injection-midcall.diagnostics.json | 2026-09-11 | deployed | prompt-injection-midcall | 394ms | 176ms | greeting | 63170ms | 15004ms | 4 | 5 | 1 |
| 2026-09-11T22-00-04-structuring-two-wires.diagnostics.json | 2026-09-11 | deployed | structuring-two-wires | 372ms | 175ms | greeting | 116233ms | 124ms | 7 | 8 | 0 |
| 2026-09-11T22-01-13-hangup-after-request.diagnostics.json | 2026-09-11 | deployed | hangup-after-request | 385ms | 203ms | greeting | 63041ms | 1ms | 1 | 1 | 0 |
| 2026-09-11T22-02-53-single-wrong-answer.diagnostics.json | 2026-09-11 | deployed | single-wrong-answer | 362ms | 182ms | greeting | 75390ms | 15005ms | 5 | 7 | 1 |
| 2026-09-11T22-04-38-scenario-a-dana-legitimate.diagnostics.json | 2026-09-11 | deployed | scenario-a-dana-legitimate | 533ms | 43ms | greeting | 81496ms | 15853ms | 5 | 6 | 1 |
| 2026-09-11T22-05-48-scenario-b-miller-fraud.diagnostics.json | 2026-09-11 | deployed | scenario-b-miller-fraud | 374ms | 185ms | greeting | 45133ms | 15005ms | 3 | 3 | 2 |
| 2026-09-11T22-07-53-barge-in-interrupt.diagnostics.json | 2026-09-11 | deployed | barge-in-interrupt | 429ms | 35ms | greeting | 119363ms | 3ms | 5 | 7 | 1 |
| 2026-09-11T22-08-31-judge-out-of-scope.diagnostics.json | 2026-09-11 | deployed | judge-out-of-scope | 463ms | 45ms | greeting | UNKNOWN | UNKNOWN | 2 | 2 | 0 |
| 2026-09-11T22-11-33-identity-switch.diagnostics.json | 2026-09-11 | deployed | identity-switch | 317ms | 168ms | greeting | 175728ms | 4ms | 8 | 9 | 0 |
| 2026-09-11T22-13-00-prompt-injection-midcall.diagnostics.json | 2026-09-11 | deployed | prompt-injection-midcall | 416ms | 176ms | greeting | 61343ms | 15004ms | 4 | 5 | 1 |
| 2026-09-11T22-14-57-structuring-two-wires.diagnostics.json | 2026-09-11 | deployed | structuring-two-wires | 419ms | 173ms | greeting | 97373ms | 11644ms | 7 | 7 | 1 |
| 2026-09-11T22-16-03-hangup-after-request.diagnostics.json | 2026-09-11 | deployed | hangup-after-request | 511ms | 220ms | greeting | 60070ms | 1ms | 1 | 1 | 0 |
| 2026-09-11T22-17-38-single-wrong-answer.diagnostics.json | 2026-09-11 | deployed | single-wrong-answer | 449ms | 64ms | greeting | 69718ms | 15004ms | 5 | 7 | 1 |
| 2026-09-11T22-19-15-scenario-a-dana-legitimate.diagnostics.json | 2026-09-11 | deployed | scenario-a-dana-legitimate | 458ms | 42ms | greeting | 74031ms | 14872ms | 5 | 5 | 1 |
| 2026-09-11T22-20-25-scenario-b-miller-fraud.diagnostics.json | 2026-09-11 | deployed | scenario-b-miller-fraud | 461ms | 44ms | greeting | 42822ms | 15003ms | 3 | 3 | 2 |
| 2026-09-11T22-23-13-barge-in-interrupt.diagnostics.json | 2026-09-11 | deployed | barge-in-interrupt | 336ms | 173ms | greeting | 160828ms | 4ms | 8 | 9 | 1 |
| 2026-09-11T22-23-51-judge-out-of-scope.diagnostics.json | 2026-09-11 | deployed | judge-out-of-scope | 347ms | 177ms | greeting | UNKNOWN | UNKNOWN | 2 | 2 | 0 |
| 2026-09-11T22-26-53-identity-switch.diagnostics.json | 2026-09-11 | deployed | identity-switch | 357ms | 180ms | greeting | 175979ms | 3ms | 8 | 9 | 0 |
| 2026-09-11T22-32-01-structuring-two-wires.diagnostics.json | 2026-09-11 | deployed | structuring-two-wires | 972ms | 83ms | greeting | 106733ms | 11335ms | 7 | 7 | 1 |
| 2026-09-11T22-33-12-hangup-after-request.diagnostics.json | 2026-09-11 | deployed | hangup-after-request | 364ms | 170ms | greeting | 64541ms | 1ms | 1 | 1 | 0 |
| 2026-09-11T22-35-27-single-wrong-answer.diagnostics.json | 2026-09-11 | deployed | single-wrong-answer | 339ms | 222ms | greeting | 128669ms | 6ms | 6 | 8 | 0 |
| 2026-09-11T22-37-25-scenario-a-dana-legitimate.diagnostics.json | 2026-09-11 | deployed | scenario-a-dana-legitimate | 348ms | 183ms | greeting | 95815ms | 15078ms | 6 | 8 | 1 |
| 2026-09-11T22-38-40-scenario-b-miller-fraud.diagnostics.json | 2026-09-11 | deployed | scenario-b-miller-fraud | 438ms | 42ms | greeting | 48706ms | 16390ms | 3 | 3 | 2 |
| 2026-09-11T22-42-34-judge-out-of-scope.diagnostics.json | 2026-09-11 | deployed | judge-out-of-scope | 522ms | 201ms | greeting | UNKNOWN | UNKNOWN | 2 | 2 | 0 |
| 2026-09-11T22-44-31-identity-switch.diagnostics.json | 2026-09-11 | deployed | identity-switch | 349ms | 211ms | greeting | 92952ms | 13853ms | 5 | 6 | 1 |
| 2026-09-11T22-47-03-prompt-injection-midcall.diagnostics.json | 2026-09-11 | deployed | prompt-injection-midcall | 438ms | 205ms | greeting | 145205ms | 6ms | 6 | 8 | 0 |
| 2026-09-11T22-48-44-structuring-two-wires.diagnostics.json | 2026-09-11 | deployed | structuring-two-wires | 357ms | 220ms | greeting | 77214ms | 15005ms | 6 | 6 | 1 |
| 2026-09-11T22-51-38-barge-in-interrupt.diagnostics.json | 2026-09-11 | deployed | barge-in-interrupt | 389ms | 183ms | greeting | 160970ms | 6ms | 9 | 9 | 1 |
| 2026-09-11T23-28-26-barge-in-interrupt.diagnostics.json | 2026-09-11 | deployed | barge-in-interrupt | 790ms | 175ms | greeting | 86350ms | 14374ms | 6 | 6 | 2 |
| 2026-09-11T23-45-09-barge-in-interrupt.diagnostics.json | 2026-09-11 | deployed | barge-in-interrupt | 721ms | 179ms | greeting | 82177ms | 14848ms | 6 | 6 | 2 |
| 2026-09-12T00-06-08-barge-in-interrupt.diagnostics.json | 2026-09-12 | deployed | barge-in-interrupt | 690ms | 175ms | greeting | 84843ms | 14437ms | 6 | 6 | 2 |
| 2026-09-13T22-23-50-miller-patient.diagnostics.json | 2026-09-13 | deployed | miller-patient | 608ms | 179ms | greeting | 47566ms | 3504ms | 3 | 3 | 1 |
| 2026-09-13T22-56-35-miller-patient.diagnostics.json | 2026-09-13 | deployed | miller-patient | 622ms | 183ms | greeting | 48289ms | 11275ms | 4 | 3 | 1 |
| 2026-09-13T22-57-34-miller-patient.diagnostics.json | 2026-09-13 | deployed | miller-patient | 347ms | 179ms | greeting | 43310ms | 4337ms | 4 | 3 | 1 |
| 2026-09-13T22-58-41-miller-patient.diagnostics.json | 2026-09-13 | deployed | miller-patient | 441ms | 176ms | greeting | 46700ms | 11460ms | 4 | 3 | 1 |
| 2026-09-13T23-00-15-dana-patient.diagnostics.json | 2026-09-13 | deployed | dana-patient | 422ms | 169ms | greeting | 73582ms | 5452ms | 5 | 5 | 0 |
| 2026-09-14T13-44-21-judge-out-of-scope.diagnostics.json | 2026-09-14 | deployed | judge-out-of-scope | 688ms | 173ms | greeting | UNKNOWN | UNKNOWN | 2 | 2 | 0 |
| 2026-09-14T13-45-58-dana-patient.diagnostics.json | 2026-09-14 | deployed | dana-patient | 365ms | 175ms | greeting | 70528ms | 15007ms | 6 | 5 | 0 |
| 2026-09-14T13-47-07-miller-patient.diagnostics.json | 2026-09-14 | deployed | miller-patient | 428ms | 46ms | greeting | 46893ms | 15005ms | 4 | 3 | 2 |
| 2026-09-14T13-49-05-identity-switch.diagnostics.json | 2026-09-14 | deployed | identity-switch | 415ms | 175ms | greeting | 97174ms | 15005ms | 6 | 6 | 1 |
| 2026-09-14T13-50-46-barge-in-interrupt.diagnostics.json | 2026-09-14 | deployed | barge-in-interrupt | 425ms | 39ms | greeting | 81484ms | 15004ms | 6 | 6 | 2 |
| 2026-09-14T13-53-07-single-wrong-answer.diagnostics.json | 2026-09-14 | deployed | single-wrong-answer | 425ms | 179ms | greeting | 139929ms | 45ms | 7 | 8 | 0 |
| 2026-09-14T13-54-12-hangup-after-request.diagnostics.json | 2026-09-14 | deployed | hangup-after-request | 446ms | 34ms | greeting | 63646ms | 1ms | 1 | 1 | 0 |
| 2026-09-14T13-56-09-prompt-injection-midcall.diagnostics.json | 2026-09-14 | deployed | prompt-injection-midcall | 309ms | 199ms | greeting | 114996ms | 175ms | 7 | 8 | 0 |
| 2026-09-14T13-58-08-structuring-two-wires.diagnostics.json | 2026-09-14 | deployed | structuring-two-wires | 347ms | 176ms | greeting | 100215ms | 15006ms | 7 | 7 | 1 |
| 2026-09-14T13-59-34-miller-silent-after-amount.diagnostics.json | 2026-09-14 | deployed | miller-silent-after-amount | 343ms | 178ms | greeting | 72778ms | 2ms | 2 | 3 | 1 |
| 2026-09-14T15-05-21-miller-patient.diagnostics.json | 2026-09-14 | deployed | miller-patient | 517ms | 173ms | greeting | 41782ms | 7039ms | 5 | 3 | 1 |
| 2026-09-14T15-06-52-dana-patient.diagnostics.json | 2026-09-14 | deployed | dana-patient | 342ms | 184ms | greeting | 72906ms | 17212ms | 5 | 5 | 0 |
| 2026-09-14T15-08-40-identity-switch.diagnostics.json | 2026-09-14 | deployed | identity-switch | 323ms | 177ms | greeting | 95892ms | 5455ms | 6 | 6 | 1 |
| 2026-09-14T15-10-32-structuring-two-wires.diagnostics.json | 2026-09-14 | deployed | structuring-two-wires | 445ms | 171ms | greeting | 110406ms | 150ms | 7 | 8 | 0 |
| 2026-09-14T15-12-40-single-wrong-answer.diagnostics.json | 2026-09-14 | deployed | single-wrong-answer | 495ms | 46ms | greeting | 126361ms | 163ms | 6 | 8 | 0 |
| 2026-09-14T15-13-45-hangup-after-request.diagnostics.json | 2026-09-14 | deployed | hangup-after-request | 363ms | 179ms | greeting | 63542ms | 201ms | 1 | 1 | 0 |
| 2026-09-14T15-15-12-miller-silent-after-amount.diagnostics.json | 2026-09-14 | deployed | miller-silent-after-amount | 297ms | 171ms | greeting | 73587ms | 12525ms | 3 | 3 | 1 |
| 2026-09-14T15-16-49-barge-in-interrupt.diagnostics.json | 2026-09-14 | deployed | barge-in-interrupt | 502ms | 40ms | greeting | 80272ms | 14734ms | 7 | 6 | 2 |
| 2026-09-14T15-17-24-judge-out-of-scope.diagnostics.json | 2026-09-14 | deployed | judge-out-of-scope | 378ms | 176ms | greeting | UNKNOWN | UNKNOWN | 2 | 2 | 0 |
| 2026-09-14T15-19-20-prompt-injection-midcall.diagnostics.json | 2026-09-14 | deployed | prompt-injection-midcall | 337ms | 178ms | greeting | 113872ms | 315ms | 7 | 8 | 0 |
| 2026-09-14T15-47-29-miller-patient.diagnostics.json | 2026-09-14 | deployed | miller-patient | 585ms | 175ms | greeting | 70573ms | 8730ms | 2 | 2 | 0 |
| 2026-09-14T15-49-25-structuring-two-wires.diagnostics.json | 2026-09-14 | deployed | structuring-two-wires | 295ms | 174ms | greeting | 108965ms | 5446ms | 8 | 8 | 0 |
| 2026-09-14T15-51-53-single-wrong-answer.diagnostics.json | 2026-09-14 | deployed | single-wrong-answer | 407ms | 177ms | greeting | 134191ms | 12328ms | 6 | 8 | 0 |
| 2026-09-14T15-53-10-hangup-after-request.diagnostics.json | 2026-09-14 | deployed | hangup-after-request | 341ms | 177ms | greeting | 61385ms | 14334ms | 1 | 1 | 0 |
| 2026-09-14T15-55-21-prompt-injection-midcall.diagnostics.json | 2026-09-14 | deployed | prompt-injection-midcall | 433ms | 176ms | greeting | 113013ms | 17182ms | 7 | 8 | 0 |
| 2026-09-14T17-18-03-dana-patient.diagnostics.json | 2026-09-14 | deployed | dana-patient | 662ms | 34ms | greeting | 163027ms | 8188ms | 8 | 8 | 0 |
| 2026-09-14T17-20-30-dana-patient.diagnostics.json | 2026-09-14 | deployed | dana-patient | 423ms | 44ms | greeting | 138092ms | 8085ms | 8 | 7 | 0 |
| 2026-09-14T17-23-27-dana-patient.diagnostics.json | 2026-09-14 | deployed | dana-patient | 346ms | 176ms | greeting | 170803ms | 4059ms | 8 | 8 | 0 |
| 2026-09-14T17-25-03-miller-patient.diagnostics.json | 2026-09-14 | deployed | miller-patient | 335ms | 177ms | greeting | 81692ms | 12882ms | 4 | 4 | 0 |
| 2026-09-14T17-26-35-miller-patient.diagnostics.json | 2026-09-14 | deployed | miller-patient | 355ms | 178ms | greeting | 78033ms | 12654ms | 3 | 3 | 0 |
| 2026-09-14T17-28-02-miller-patient.diagnostics.json | 2026-09-14 | deployed | miller-patient | 459ms | 34ms | greeting | 73463ms | 11640ms | 3 | 3 | 0 |
| 2026-09-14T17-32-22-judge-out-of-scope.diagnostics.json | 2026-09-14 | deployed | judge-out-of-scope | 380ms | 170ms | greeting | UNKNOWN | UNKNOWN | 11 | 11 | 0 |
| 2026-09-14T17-36-00-judge-out-of-scope.diagnostics.json | 2026-09-14 | deployed | judge-out-of-scope | 369ms | 172ms | greeting | UNKNOWN | UNKNOWN | 11 | 10 | 0 |
| 2026-09-14T17-40-14-judge-out-of-scope.diagnostics.json | 2026-09-14 | deployed | judge-out-of-scope | 700ms | 45ms | greeting | UNKNOWN | UNKNOWN | 11 | 11 | 0 |
| 2026-09-14T17-42-59-identity-switch.diagnostics.json | 2026-09-14 | deployed | identity-switch | 294ms | 176ms | greeting | 143764ms | 19187ms | 8 | 6 | 0 |
| 2026-09-14T17-45-39-identity-switch.diagnostics.json | 2026-09-14 | deployed | identity-switch | 470ms | 39ms | greeting | 154434ms | 4061ms | 7 | 7 | 0 |
| 2026-09-14T17-48-29-identity-switch.diagnostics.json | 2026-09-14 | deployed | identity-switch | 387ms | 175ms | greeting | 162646ms | 6357ms | 7 | 7 | 0 |
| 2026-09-14T17-51-49-barge-in-interrupt.diagnostics.json | 2026-09-14 | deployed | barge-in-interrupt | 438ms | 222ms | greeting | 187198ms | 11200ms | 11 | 8 | 1 |
| 2026-09-14T17-54-34-barge-in-interrupt.diagnostics.json | 2026-09-14 | deployed | barge-in-interrupt | 381ms | 180ms | greeting | 154541ms | 8930ms | 9 | 7 | 1 |
| 2026-09-14T17-58-23-barge-in-interrupt.diagnostics.json | 2026-09-14 | deployed | barge-in-interrupt | 356ms | 172ms | greeting | 173058ms | 45005ms | 9 | 8 | 2 |
| 2026-09-14T18-02-37-single-wrong-answer.diagnostics.json | 2026-09-14 | deployed | single-wrong-answer | 323ms | 175ms | greeting | 216868ms | 35085ms | 9 | 9 | 0 |
| 2026-09-14T18-05-49-single-wrong-answer.diagnostics.json | 2026-09-14 | deployed | single-wrong-answer | 388ms | 166ms | greeting | 182537ms | 8330ms | 8 | 8 | 0 |
| 2026-09-14T18-06-55-single-wrong-answer.diagnostics.json | 2026-09-14 | deployed | single-wrong-answer | 437ms | 174ms | greeting | UNKNOWN | UNKNOWN | 1 | 1 | 0 |
| 2026-09-14T18-07-40-hangup-after-request.diagnostics.json | 2026-09-14 | deployed | hangup-after-request | 468ms | 39ms | greeting | UNKNOWN | UNKNOWN | 0 | 0 | 0 |
| 2026-09-14T18-08-25-hangup-after-request.diagnostics.json | 2026-09-14 | deployed | hangup-after-request | 379ms | 175ms | greeting | UNKNOWN | UNKNOWN | 0 | 0 | 0 |
| 2026-09-14T18-09-15-hangup-after-request.diagnostics.json | 2026-09-14 | deployed | hangup-after-request | 347ms | 181ms | greeting | UNKNOWN | UNKNOWN | 0 | 0 | 0 |
| 2026-09-14T18-12-18-prompt-injection-midcall.diagnostics.json | 2026-09-14 | deployed | prompt-injection-midcall | 337ms | 175ms | greeting | 173708ms | 7974ms | 8 | 8 | 0 |
| 2026-09-14T18-20-41-prompt-injection-midcall.diagnostics.json | 2026-09-14 | deployed | prompt-injection-midcall | 431ms | 40ms | greeting | 172881ms | 9836ms | 8 | 8 | 0 |
| 2026-09-14T18-22-25-structuring-two-wires.diagnostics.json | 2026-09-14 | deployed | structuring-two-wires | 422ms | 183ms | greeting | 83982ms | 18707ms | 5 | 4 | 0 |
| 2026-09-14T18-23-35-structuring-two-wires.diagnostics.json | 2026-09-14 | deployed | structuring-two-wires | 389ms | 176ms | greeting | UNKNOWN | UNKNOWN | 1 | 1 | 0 |
| 2026-09-14T18-24-45-structuring-two-wires.diagnostics.json | 2026-09-14 | deployed | structuring-two-wires | 380ms | 176ms | greeting | UNKNOWN | UNKNOWN | 1 | 1 | 0 |
| 2026-09-14T18-26-08-miller-silent-after-amount.diagnostics.json | 2026-09-14 | deployed | miller-silent-after-amount | 424ms | 180ms | greeting | 69515ms | 11766ms | 4 | 3 | 0 |
| 2026-09-14T18-27-24-miller-silent-after-amount.diagnostics.json | 2026-09-14 | deployed | miller-silent-after-amount | 346ms | 179ms | greeting | 60413ms | 13774ms | 5 | 3 | 0 |
| 2026-09-14T18-28-51-miller-silent-after-amount.diagnostics.json | 2026-09-14 | deployed | miller-silent-after-amount | 432ms | 178ms | greeting | 73992ms | 12008ms | 3 | 3 | 0 |
| 2026-09-14T20-44-01-miller-patient.diagnostics.json | 2026-09-14 | deployed | miller-patient | 788ms | 31ms | greeting | 41945ms | 4434ms | 3 | 3 | 1 |
| 2026-09-14T20-45-32-dana-patient.diagnostics.json | 2026-09-14 | deployed | dana-patient | 514ms | 177ms | greeting | 84177ms | 5547ms | 5 | 5 | 0 |
| 2026-09-14T21-39-16-judge-out-of-scope.diagnostics.json | 2026-09-14 | deployed | judge-out-of-scope | 757ms | 41ms | greeting | UNKNOWN | UNKNOWN | 2 | 2 | 0 |
| 2026-09-14T22-22-23-barge-in-interrupt.diagnostics.json | 2026-09-14 | deployed | barge-in-interrupt | 396ms | 182ms | greeting | 92858ms | 14903ms | 6 | 6 | 2 |
| 2026-09-14T22-24-55-single-wrong-answer.diagnostics.json | 2026-09-14 | deployed | single-wrong-answer | 338ms | 172ms | greeting | 137236ms | 12578ms | 7 | 8 | 0 |
| 2026-09-14T22-28-02-prompt-injection-midcall.diagnostics.json | 2026-09-14 | deployed | prompt-injection-midcall | 405ms | 178ms | greeting | 170750ms | 14291ms | 8 | 8 | 0 |
| 2026-09-14T22-30-29-corrected-critical-field.diagnostics.json | 2026-09-14 | deployed | corrected-critical-field | 334ms | 177ms | greeting | 133886ms | 11459ms | 6 | 6 | 0 |
| 2026-09-15T07-32-13-dana-patient.diagnostics.json | 2026-09-15 | deployed | dana-patient | 606ms | 178ms | greeting | 75667ms | 5551ms | 5 | 5 | 0 |
| 2026-09-15T07-33-25-miller-patient.diagnostics.json | 2026-09-15 | deployed | miller-patient | 397ms | 172ms | greeting | 44463ms | 9635ms | 5 | 3 | 2 |
| 2026-09-15T07-34-00-judge-out-of-scope.diagnostics.json | 2026-09-15 | deployed | judge-out-of-scope | 511ms | 178ms | greeting | UNKNOWN | UNKNOWN | 2 | 2 | 0 |
| 2026-09-15T07-35-54-identity-switch.diagnostics.json | 2026-09-15 | deployed | identity-switch | 603ms | 49ms | greeting | 99567ms | 10083ms | 6 | 6 | 1 |
| 2026-09-15T07-37-34-barge-in-interrupt.diagnostics.json | 2026-09-15 | deployed | barge-in-interrupt | 527ms | 42ms | greeting | 91292ms | 5546ms | 6 | 6 | 2 |
| 2026-09-15T07-40-19-single-wrong-answer.diagnostics.json | 2026-09-15 | deployed | single-wrong-answer | 467ms | 27ms | greeting | 146164ms | 16408ms | 7 | 8 | 0 |
| 2026-09-15T07-41-41-hangup-after-request.diagnostics.json | 2026-09-15 | deployed | hangup-after-request | 363ms | 173ms | greeting | 67191ms | 13516ms | 1 | 1 | 0 |
| 2026-09-15T07-43-58-prompt-injection-midcall.diagnostics.json | 2026-09-15 | deployed | prompt-injection-midcall | 405ms | 177ms | greeting | 117678ms | 17918ms | 8 | 8 | 0 |
| 2026-09-15T07-46-14-structuring-two-wires.diagnostics.json | 2026-09-15 | deployed | structuring-two-wires | 293ms | 171ms | greeting | 116059ms | 18645ms | 8 | 8 | 0 |
| 2026-09-15T07-48-03-miller-silent-after-amount.diagnostics.json | 2026-09-15 | deployed | miller-silent-after-amount | 327ms | 178ms | greeting | 76796ms | 31072ms | 4 | 4 | 0 |
| 2026-09-15T07-50-36-corrected-critical-field.diagnostics.json | 2026-09-15 | deployed | corrected-critical-field | 452ms | 38ms | greeting | 137299ms | 13956ms | 6 | 6 | 0 |
| 2026-09-15T07-53-26-judge-out-of-scope.diagnostics.json | 2026-09-15 | deployed | judge-out-of-scope | 578ms | 173ms | greeting | UNKNOWN | UNKNOWN | 2 | 2 | 0 |
| 2026-09-15T08-06-07-corrected-critical-field.diagnostics.json | 2026-09-15 | deployed | corrected-critical-field | 731ms | 179ms | greeting | 84494ms | 15954ms | 7 | 6 | 0 |
| 2026-09-15T08-53-19-miller-patient.diagnostics.json | 2026-09-15 | deployed | miller-patient | 614ms | 175ms | greeting | 34201ms | 17874ms | 2 | 2 | 0 |
| 2026-09-15T08-55-01-dana-patient.diagnostics.json | 2026-09-15 | deployed | dana-patient | 412ms | 168ms | greeting | 84565ms | 15580ms | 6 | 5 | 0 |
| 2026-09-15T08-56-33-miller-silent-after-amount.diagnostics.json | 2026-09-15 | deployed | miller-silent-after-amount | 619ms | 40ms | greeting | 45310ms | 14834ms | 3 | 3 | 1 |
| 2026-09-15T08-58-17-corrected-critical-field.diagnostics.json | 2026-09-15 | deployed | corrected-critical-field | 302ms | 216ms | greeting | 87163ms | 15040ms | 6 | 5 | 0 |
| 2026-09-15T08-59-09-miller-patient.diagnostics.json | 2026-09-15 | deployed | miller-patient | 416ms | 176ms | greeting | 33695ms | 16541ms | 2 | 2 | 0 |
| 2026-09-15T09-00-51-dana-patient.diagnostics.json | 2026-09-15 | deployed | dana-patient | 411ms | 176ms | greeting | 86572ms | 14909ms | 5 | 5 | 0 |
| 2026-09-15T14-27-39-dana-patient.diagnostics.json | 2026-09-15 | deployed | dana-patient | 500ms | 170ms | greeting | 73059ms | 13744ms | 8 | 6 | 0 |
| 2026-09-15T14-30-08-dana-patient.diagnostics.json | 2026-09-15 | deployed | dana-patient | 428ms | 184ms | greeting | 80288ms | 15355ms | 6 | 7 | 0 |
| 2026-09-15T15-28-06-dana-patient.diagnostics.json | 2026-09-15 | deployed | dana-patient | 686ms | 41ms | greeting | 60848ms | 18652ms | 6 | 5 | 0 |
| 2026-09-16T17-47-35-miller-patient.diagnostics.json | 2026-09-16 | deployed | miller-patient | 723ms | 34ms | greeting | 72680ms | 13064ms | 7 | 4 | 1 |
| 2026-09-16T17-50-00-miller-patient.diagnostics.json | 2026-09-16 | deployed | miller-patient | 394ms | 172ms | greeting | 96156ms | 45003ms | 2 | 2 | 3 |
| 2026-09-16T17-51-27-dana-patient.diagnostics.json | 2026-09-16 | deployed | dana-patient | 573ms | 175ms | greeting | 70439ms | 13745ms | 9 | 6 | 0 |
| 2026-09-16T17-53-17-miller-silent-after-amount.diagnostics.json | 2026-09-16 | deployed | miller-silent-after-amount | 466ms | 37ms | greeting | 87014ms | 19765ms | 5 | 4 | 0 |
| 2026-09-16T17-54-56-corrected-critical-field.diagnostics.json | 2026-09-16 | deployed | corrected-critical-field | 378ms | 168ms | greeting | 80734ms | 14481ms | 7 | 6 | 0 |
| 2026-09-16T17-56-27-dana-patient.diagnostics.json | 2026-09-16 | deployed | dana-patient | 437ms | 40ms | greeting | 84392ms | 5546ms | 5 | 5 | 0 |
| 2026-09-16T19-28-00-miller-patient.diagnostics.json | 2026-09-16 | deployed | miller-patient | 647ms | 33ms | greeting | 51010ms | 6598ms | 4 | 3 | 2 |
| 2026-09-16T19-28-55-miller-patient.diagnostics.json | 2026-09-16 | deployed | miller-patient | 546ms | 66ms | greeting | 39318ms | 14344ms | 6 | 3 | 1 |
| 2026-09-16T19-31-28-dana-patient.diagnostics.json | 2026-09-16 | deployed | dana-patient | 394ms | 157ms | greeting | 137933ms | 5315ms | 9 | 6 | 4 |
| 2026-09-16T19-33-27-dana-patient.diagnostics.json | 2026-09-16 | deployed | dana-patient | 448ms | 37ms | greeting | 72612ms | 19244ms | 9 | 6 | 0 |
| 2026-09-16T20-13-55-dana-patient.diagnostics.json | 2026-09-16 | deployed | dana-patient | 607ms | 181ms | greeting | 147066ms | 9674ms | 10 | 9 | 0 |
| 2026-09-16T20-16-27-dana-patient.diagnostics.json | 2026-09-16 | deployed | dana-patient | 330ms | 172ms | greeting | 132987ms | 17255ms | 9 | 7 | 0 |
| 2026-09-16T20-19-35-dana-patient.diagnostics.json | 2026-09-16 | deployed | dana-patient | 429ms | 33ms | greeting | 178591ms | 7763ms | 11 | 8 | 0 |
| 2026-09-16T20-21-04-miller-patient.diagnostics.json | 2026-09-16 | deployed | miller-patient | 400ms | 177ms | greeting | 62657ms | 24812ms | 4 | 4 | 0 |
| 2026-09-16T20-22-38-miller-patient.diagnostics.json | 2026-09-16 | deployed | miller-patient | 327ms | 178ms | greeting | 75478ms | 13672ms | 5 | 4 | 1 |
| 2026-09-16T20-23-44-miller-patient.diagnostics.json | 2026-09-16 | deployed | miller-patient | 347ms | 175ms | greeting | 55811ms | 7640ms | 4 | 3 | 0 |
| 2026-09-16T20-28-29-judge-out-of-scope.diagnostics.json | 2026-09-16 | deployed | judge-out-of-scope | 323ms | 179ms | greeting | UNKNOWN | UNKNOWN | 16 | 14 | 0 |
| 2026-09-16T20-32-50-judge-out-of-scope.diagnostics.json | 2026-09-16 | deployed | judge-out-of-scope | 374ms | 178ms | greeting | UNKNOWN | UNKNOWN | 12 | 10 | 0 |
| 2026-09-16T20-37-49-judge-out-of-scope.diagnostics.json | 2026-09-16 | deployed | judge-out-of-scope | 366ms | 179ms | greeting | UNKNOWN | UNKNOWN | 13 | 12 | 0 |
| 2026-09-16T20-40-21-identity-switch.diagnostics.json | 2026-09-16 | deployed | identity-switch | 421ms | 179ms | greeting | 136690ms | 13686ms | 9 | 6 | 0 |
| 2026-09-16T20-42-56-identity-switch.diagnostics.json | 2026-09-16 | deployed | identity-switch | 427ms | 172ms | greeting | 132990ms | 19953ms | 8 | 7 | 0 |
| 2026-09-16T20-45-30-identity-switch.diagnostics.json | 2026-09-16 | deployed | identity-switch | 413ms | 173ms | greeting | 138677ms | 13476ms | 9 | 6 | 0 |
| 2026-09-16T20-47-50-barge-in-interrupt.diagnostics.json | 2026-09-16 | deployed | barge-in-interrupt | 362ms | 172ms | greeting | 130625ms | 8156ms | 9 | 5 | 1 |
| 2026-09-16T20-51-12-barge-in-interrupt.diagnostics.json | 2026-09-16 | deployed | barge-in-interrupt | 479ms | 42ms | greeting | 153437ms | 45008ms | 13 | 7 | 3 |
| 2026-09-16T20-54-33-barge-in-interrupt.diagnostics.json | 2026-09-16 | deployed | barge-in-interrupt | 339ms | 179ms | greeting | 142947ms | 45007ms | 10 | 7 | 2 |
| 2026-09-16T20-57-05-single-wrong-answer.diagnostics.json | 2026-09-16 | deployed | single-wrong-answer | 368ms | 179ms | greeting | 136234ms | 12512ms | 8 | 6 | 1 |
| 2026-09-16T21-00-04-single-wrong-answer.diagnostics.json | 2026-09-16 | deployed | single-wrong-answer | 421ms | 176ms | greeting | 153688ms | 23657ms | 10 | 9 | 0 |
| 2026-09-16T21-02-41-single-wrong-answer.diagnostics.json | 2026-09-16 | deployed | single-wrong-answer | 396ms | 193ms | greeting | 88566ms | 45002ms | 3 | 4 | 2 |
| 2026-09-16T21-04-18-hangup-after-request.diagnostics.json | 2026-09-16 | deployed | hangup-after-request | 403ms | 209ms | greeting | 76643ms | 18482ms | 2 | 1 | 0 |
| 2026-09-16T21-06-38-hangup-after-request.diagnostics.json | 2026-09-16 | deployed | hangup-after-request | 430ms | 174ms | greeting | 125035ms | 13704ms | 4 | 3 | 0 |
| 2026-09-16T21-08-10-hangup-after-request.diagnostics.json | 2026-09-16 | deployed | hangup-after-request | 365ms | 177ms | greeting | 74612ms | 15361ms | 2 | 1 | 0 |
| 2026-09-16T21-12-46-prompt-injection-midcall.diagnostics.json | 2026-09-16 | deployed | prompt-injection-midcall | 398ms | 180ms | greeting | 148863ms | 21701ms | 7 | 6 | 2 |
| 2026-09-16T21-15-17-prompt-injection-midcall.diagnostics.json | 2026-09-16 | deployed | prompt-injection-midcall | 398ms | 174ms | greeting | 97366ms | 45004ms | 3 | 3 | 3 |
| 2026-09-16T21-18-23-prompt-injection-midcall.diagnostics.json | 2026-09-16 | deployed | prompt-injection-midcall | 359ms | 175ms | greeting | 128166ms | 45009ms | 9 | 7 | 1 |
| 2026-09-16T21-20-33-structuring-two-wires.diagnostics.json | 2026-09-16 | deployed | structuring-two-wires | 440ms | 33ms | greeting | 103350ms | 18186ms | 6 | 5 | 1 |
| 2026-09-16T21-22-26-structuring-two-wires.diagnostics.json | 2026-09-16 | deployed | structuring-two-wires | 756ms | 92ms | greeting | 84817ms | 22297ms | 5 | 4 | 1 |
| 2026-09-16T21-23-52-structuring-two-wires.diagnostics.json | 2026-09-16 | deployed | structuring-two-wires | 427ms | 39ms | greeting | 75291ms | 9044ms | 5 | 4 | 0 |
| 2026-09-16T21-25-25-miller-silent-after-amount.diagnostics.json | 2026-09-16 | deployed | miller-silent-after-amount | 408ms | 183ms | greeting | 45805ms | 45005ms | 5 | 3 | 0 |
| 2026-09-16T21-26-48-miller-silent-after-amount.diagnostics.json | 2026-09-16 | deployed | miller-silent-after-amount | 362ms | 173ms | greeting | 59229ms | 18901ms | 4 | 3 | 1 |
| 2026-09-16T21-29-15-miller-silent-after-amount.diagnostics.json | 2026-09-16 | deployed | miller-silent-after-amount | 363ms | 178ms | greeting | 89966ms | 45004ms | 4 | 4 | 1 |
| 2026-09-16T21-32-40-corrected-critical-field.diagnostics.json | 2026-09-16 | deployed | corrected-critical-field | 395ms | 192ms | greeting | 197946ms | 5313ms | 9 | 9 | 1 |
| 2026-09-16T21-35-48-corrected-critical-field.diagnostics.json | 2026-09-16 | deployed | corrected-critical-field | 346ms | 177ms | greeting | 157145ms | 29589ms | 8 | 7 | 0 |
| 2026-09-16T21-37-49-corrected-critical-field.diagnostics.json | 2026-09-16 | deployed | corrected-critical-field | 396ms | 172ms | greeting | 109887ms | 5306ms | 3 | 3 | 3 |
| 2026-09-17T07-37-05-miller-patient.diagnostics.json | 2026-09-17 | deployed | miller-patient | 579ms | 169ms | greeting | 47138ms | 11366ms | 4 | 3 | 1 |
| 2026-09-17T07-38-27-dana-patient.diagnostics.json | 2026-09-17 | deployed | dana-patient | 451ms | 85ms | greeting | 74314ms | 5463ms | 6 | 5 | 0 |
| 2026-09-17T07-39-58-corrected-critical-field.diagnostics.json | 2026-09-17 | deployed | corrected-critical-field | 412ms | 168ms | greeting | 85074ms | 5454ms | 7 | 5 | 0 |
| 2026-09-17T07-41-10-miller-patient.diagnostics.json | 2026-09-17 | deployed | miller-patient | 426ms | 178ms | greeting | 44480ms | 9713ms | 7 | 3 | 2 |
| 2026-09-17T07-42-38-dana-patient.diagnostics.json | 2026-09-17 | deployed | dana-patient | 363ms | 183ms | greeting | 80867ms | 5545ms | 6 | 5 | 0 |
| 2026-09-17T07-44-14-miller-silent-after-amount.diagnostics.json | 2026-09-17 | deployed | miller-silent-after-amount | 345ms | 173ms | greeting | 72606ms | 21217ms | 5 | 4 | 0 |
| 2026-09-17T07-45-15-miller-patient.diagnostics.json | 2026-09-17 | deployed | miller-patient | 477ms | 33ms | greeting | 45544ms | 14644ms | 8 | 3 | 1 |
| 2026-09-17T07-46-45-dana-patient.diagnostics.json | 2026-09-17 | deployed | dana-patient | 451ms | 39ms | greeting | 76116ms | 12319ms | 6 | 5 | 0 |
| 2026-09-17T07-48-21-corrected-critical-field.diagnostics.json | 2026-09-17 | deployed | corrected-critical-field | 309ms | 176ms | greeting | 87972ms | 5518ms | 7 | 5 | 0 |
| 2026-09-17T07-50-11-identity-switch.diagnostics.json | 2026-09-17 | deployed | identity-switch | 358ms | 183ms | greeting | 94824ms | 10094ms | 7 | 6 | 1 |
| 2026-09-17T08-35-38-dana-patient.diagnostics.json | 2026-09-17 | deployed | dana-patient | 569ms | 170ms | greeting | 141228ms | 45009ms | 9 | 6 | 0 |
| 2026-09-17T08-37-45-dana-patient.diagnostics.json | 2026-09-17 | deployed | dana-patient | 319ms | 170ms | greeting | 115486ms | 9350ms | 7 | 5 | 0 |
| 2026-09-17T08-40-06-dana-patient.diagnostics.json | 2026-09-17 | deployed | dana-patient | 362ms | 176ms | greeting | 121729ms | 18198ms | 7 | 5 | 0 |
| 2026-09-17T08-42-13-miller-patient.diagnostics.json | 2026-09-17 | deployed | miller-patient | 401ms | 35ms | greeting | 95805ms | 29446ms | 4 | 5 | 0 |
| 2026-09-17T08-43-35-miller-patient.diagnostics.json | 2026-09-17 | deployed | miller-patient | 424ms | 37ms | greeting | 57888ms | 20516ms | 5 | 3 | 1 |
| 2026-09-17T08-45-11-miller-patient.diagnostics.json | 2026-09-17 | deployed | miller-patient | 409ms | 179ms | greeting | 66619ms | 27574ms | 6 | 4 | 0 |
| 2026-09-17T08-46-58-judge-out-of-scope.diagnostics.json | 2026-09-17 | deployed | judge-out-of-scope | 343ms | 175ms | greeting | UNKNOWN | UNKNOWN | 4 | 3 | 0 |
| 2026-09-17T08-51-48-judge-out-of-scope.diagnostics.json | 2026-09-17 | deployed | judge-out-of-scope | 499ms | 199ms | greeting | UNKNOWN | UNKNOWN | 14 | 13 | 0 |
| 2026-09-17T08-56-48-judge-out-of-scope.diagnostics.json | 2026-09-17 | deployed | judge-out-of-scope | 305ms | 176ms | greeting | UNKNOWN | UNKNOWN | 12 | 12 | 0 |
| 2026-09-17T08-59-36-identity-switch.diagnostics.json | 2026-09-17 | deployed | identity-switch | 333ms | 176ms | greeting | 131601ms | 34549ms | 8 | 6 | 0 |
| 2026-09-17T09-02-35-identity-switch.diagnostics.json | 2026-09-17 | deployed | identity-switch | 426ms | 35ms | greeting | 164288ms | 12891ms | 10 | 6 | 0 |
| 2026-09-17T09-05-44-identity-switch.diagnostics.json | 2026-09-17 | deployed | identity-switch | 359ms | 182ms | greeting | 162623ms | 22380ms | 8 | 6 | 1 |
| 2026-09-17T09-07-50-barge-in-interrupt.diagnostics.json | 2026-09-17 | deployed | barge-in-interrupt | 340ms | 178ms | greeting | 113403ms | 9280ms | 8 | 4 | 1 |
| 2026-09-17T09-09-50-barge-in-interrupt.diagnostics.json | 2026-09-17 | deployed | barge-in-interrupt | 364ms | 173ms | greeting | 108028ms | 10253ms | 8 | 4 | 1 |
| 2026-09-17T09-11-52-barge-in-interrupt.diagnostics.json | 2026-09-17 | deployed | barge-in-interrupt | 367ms | 173ms | greeting | 110433ms | 10675ms | 7 | 4 | 1 |
| 2026-09-17T09-15-29-single-wrong-answer.diagnostics.json | 2026-09-17 | deployed | single-wrong-answer | 320ms | 175ms | greeting | 187388ms | 3679ms | 11 | 8 | 2 |
| 2026-09-17T09-17-51-single-wrong-answer.diagnostics.json | 2026-09-17 | deployed | single-wrong-answer | 391ms | 181ms | greeting | 131151ms | 9456ms | 8 | 6 | 0 |
| 2026-09-17T09-21-22-single-wrong-answer.diagnostics.json | 2026-09-17 | deployed | single-wrong-answer | 401ms | 172ms | greeting | 181239ms | 20653ms | 11 | 9 | 1 |
| 2026-09-17T09-22-53-hangup-after-request.diagnostics.json | 2026-09-17 | deployed | hangup-after-request | 401ms | 42ms | greeting | 75459ms | 14129ms | 2 | 1 | 0 |
| 2026-09-17T09-24-18-hangup-after-request.diagnostics.json | 2026-09-17 | deployed | hangup-after-request | 429ms | 42ms | greeting | 64312ms | 18761ms | 1 | 1 | 0 |
| 2026-09-17T09-25-49-hangup-after-request.diagnostics.json | 2026-09-17 | deployed | hangup-after-request | 873ms | 175ms | greeting | 74463ms | 14936ms | 2 | 1 | 0 |
| 2026-09-17T09-28-15-prompt-injection-midcall.diagnostics.json | 2026-09-17 | deployed | prompt-injection-midcall | 448ms | 34ms | greeting | 127603ms | 16546ms | 7 | 7 | 0 |
| 2026-09-17T09-30-37-prompt-injection-midcall.diagnostics.json | 2026-09-17 | deployed | prompt-injection-midcall | 387ms | 179ms | greeting | 128146ms | 12305ms | 7 | 6 | 0 |
| 2026-09-17T09-32-38-prompt-injection-midcall.diagnostics.json | 2026-09-17 | deployed | prompt-injection-midcall | 399ms | 173ms | greeting | 105232ms | 11854ms | 5 | 5 | 0 |
| 2026-09-17T09-34-18-structuring-two-wires.diagnostics.json | 2026-09-17 | deployed | structuring-two-wires | 352ms | 176ms | greeting | 82753ms | 15330ms | 4 | 4 | 0 |
| 2026-09-17T09-38-22-structuring-two-wires.diagnostics.json | 2026-09-17 | deployed | structuring-two-wires | 475ms | 37ms | greeting | 199515ms | 42981ms | 11 | 8 | 0 |
| 2026-09-17T09-39-50-structuring-two-wires.diagnostics.json | 2026-09-17 | deployed | structuring-two-wires | 390ms | 172ms | greeting | 73847ms | 12898ms | 3 | 3 | 0 |
| 2026-09-17T09-41-33-miller-silent-after-amount.diagnostics.json | 2026-09-17 | deployed | miller-silent-after-amount | 398ms | 181ms | greeting | 77010ms | 19065ms | 4 | 3 | 1 |
| 2026-09-17T09-43-26-miller-silent-after-amount.diagnostics.json | 2026-09-17 | deployed | miller-silent-after-amount | 356ms | 176ms | greeting | 92820ms | 18452ms | 7 | 4 | 0 |
| 2026-09-17T09-45-14-miller-silent-after-amount.diagnostics.json | 2026-09-17 | deployed | miller-silent-after-amount | 385ms | 171ms | greeting | 91147ms | 13865ms | 4 | 4 | 0 |
| 2026-09-17T09-48-18-corrected-critical-field.diagnostics.json | 2026-09-17 | deployed | corrected-critical-field | 390ms | 172ms | greeting | 163274ms | 5311ms | 7 | 6 | 3 |
| 2026-09-17T09-50-27-corrected-critical-field.diagnostics.json | 2026-09-17 | deployed | corrected-critical-field | 369ms | 176ms | greeting | 94331ms | 32842ms | 4 | 4 | 0 |
| 2026-09-17T09-52-22-corrected-critical-field.diagnostics.json | 2026-09-17 | deployed | corrected-critical-field | 368ms | 181ms | greeting | 86070ms | 27572ms | 3 | 4 | 0 |
| 2026-09-17T09-55-03-miller-patient.diagnostics.json | 2026-09-17 | deployed | miller-patient | 645ms | 175ms | greeting | 45416ms | 11362ms | 4 | 3 | 1 |
| 2026-09-17T09-56-34-dana-patient.diagnostics.json | 2026-09-17 | deployed | dana-patient | 324ms | 174ms | greeting | 84292ms | 5452ms | 5 | 5 | 0 |
| 2026-09-17T09-58-04-corrected-critical-field.diagnostics.json | 2026-09-17 | deployed | corrected-critical-field | 390ms | 176ms | greeting | 82947ms | 5451ms | 7 | 5 | 0 |
| 2026-09-17T09-59-38-dana-patient.diagnostics.json | 2026-09-17 | deployed | dana-patient | 388ms | 173ms | greeting | 80364ms | 11934ms | 7 | 5 | 0 |

## 1. Socket connect to AssemblyAI ready -- p50/p95 across runs

| group | n | p50 | p95 |
| --- | --- | --- | --- |
| local / scenario-a-dana-legitimate | 3 | 979ms | 1105ms |
| local / all scenarios | 3 | 979ms | 1105ms |
| deployed / barge-in-interrupt | 20 | 411ms | 724ms |
| deployed / corrected-critical-field | 14 | 384ms | 550ms |
| deployed / dana-patient | 28 | 426ms | 643ms |
| deployed / hangup-after-request | 16 | 393ms | 602ms |
| deployed / identity-switch | 17 | 378ms | 497ms |
| deployed / judge-out-of-scope | 18 | 379ms | 709ms |
| deployed / miller-patient | 28 | 435ms | 696ms |
| deployed / miller-silent-after-amount | 15 | 363ms | 512ms |
| deployed / prompt-injection-midcall | 16 | 399ms | 441ms |
| deployed / scenario-a-dana-legitimate | 9 | 581ms | 633ms |
| deployed / scenario-b-miller-fraud | 5 | 438ms | 467ms |
| deployed / single-wrong-answer | 17 | 396ms | 473ms |
| deployed / structuring-two-wires | 17 | 390ms | 799ms |
| deployed / all scenarios | 220 | 402ms | 688ms |
| all targets / all scenarios | 223 | 405ms | 719ms |

## 2. Ready to first agent audio -- p50/p95 across runs, split by whether a greeting was configured

**Caveat (PROVEN against the raw event streams of every non-greeting bundle on disk):** this column is only a pure agent-turnaround number on a "greeting" row. On every other row, this scenario has the CALLER speak first (there is no scripted agent greeting), so the agent's first audio frame only fires after the caller's own opening utterance ends -- the number is dominated by how long the caller took to speak, not by the agent. This is the exact confound docs/AUTOPILOT_LOG.md's 2026-09-11 entry already flagged by hand ("the 17s was the harness caller pacing and speaking; agent reply-start to first audio 1-150ms, n=3"). Rows are split by label below specifically so a "first reply" number is never averaged together with a "greeting" number.

| group | n | p50 | p95 |
| --- | --- | --- | --- |
| local / first reply, greeting_configured unknown -- older bundle (includes caller talk time before the agent speaks) | 3 | 17394ms | 17489ms |
| deployed / first reply, greeting_configured unknown -- older bundle (includes caller talk time before the agent speaks) | 4 | 17876ms | 18144ms |
| deployed / greeting | 216 | 175ms | 199ms |
| all targets / first reply, greeting_configured unknown -- older bundle (includes caller talk time before the agent speaks) | 7 | 17499ms | 18115ms |
| all targets / greeting | 216 | 175ms | 199ms |

## 3a. Server relay gap after AssemblyAI's end-of-turn event (not perceived latency) -- p50/p95 across ALL TURNS, not runs

**This is NOT the gap a judge feels.** See method 3a above -- `input.speech.stopped` is AssemblyAI's own end-of-turn detection event and can lag (or even race backward against) the agent's actual reply. Use section 3b below for the perceived-latency number.

| group | n | p50 | p95 |
| --- | --- | --- | --- |
| local / scenario-a-dana-legitimate | 21 | 11ms | 35ms |
| local / all scenarios | 21 | 11ms | 35ms |
| deployed / barge-in-interrupt | 154 | 9ms | 3970ms |
| deployed / corrected-critical-field | 87 | 11ms | 3948ms |
| deployed / dana-patient | 196 | 11ms | 3945ms |
| deployed / hangup-after-request | 20 | 8ms | 11510ms |
| deployed / identity-switch | 128 | 10ms | 2969ms |
| deployed / judge-out-of-scope | 122 | 6ms | 4028ms |
| deployed / miller-patient | 118 | 11ms | 3990ms |
| deployed / miller-silent-after-amount | 62 | 9ms | 8483ms |
| deployed / prompt-injection-midcall | 105 | 9ms | 894ms |
| deployed / scenario-a-dana-legitimate | 56 | 9ms | 114ms |
| deployed / scenario-b-miller-fraud | 18 | 7ms | 181ms |
| deployed / single-wrong-answer | 118 | 9ms | 3955ms |
| deployed / structuring-two-wires | 98 | 8ms | 3954ms |
| deployed / all scenarios | 1282 | 9ms | 3966ms |
| all targets / all scenarios | 1303 | 9ms | 3966ms |

## 3b. Perceived response latency (the gap a judge feels) -- ESTIMATE, p50/p95 across ALL TURNS, not runs

Method: harness wall clock from the synthetic caller's last audio frame to the agent's first reply audio; includes AssemblyAI end-of-turn detection; ESTIMATE because the synthetic caller is not a human. Source: each run's paired `.md` report's own "Per-turn gaps" table (parsed by `parsePerTurnGapsFromMd`), not the diagnostics.json event stream. Turns with gap "n/a" are excluded from `n` below and counted separately in the per-run table's "perceived n/a" column.

| group | n | p50 | p95 |
| --- | --- | --- | --- |
| local / scenario-a-dana-legitimate | 29 | 657ms | 1813ms |
| local / all scenarios | 29 | 657ms | 1813ms |
| deployed / barge-in-interrupt | 128 | 642ms | 4087ms |
| deployed / corrected-critical-field | 77 | 655ms | 4606ms |
| deployed / dana-patient | 164 | 651ms | 2971ms |
| deployed / hangup-after-request | 15 | 528ms | 1000ms |
| deployed / identity-switch | 114 | 645ms | 1786ms |
| deployed / judge-out-of-scope | 114 | 8ms | 719ms |
| deployed / miller-patient | 87 | 666ms | 1497ms |
| deployed / miller-silent-after-amount | 51 | 639ms | 1831ms |
| deployed / prompt-injection-midcall | 108 | 641ms | 1799ms |
| deployed / scenario-a-dana-legitimate | 68 | 620ms | 1772ms |
| deployed / scenario-b-miller-fraud | 17 | 628ms | 803ms |
| deployed / single-wrong-answer | 122 | 737ms | 4480ms |
| deployed / structuring-two-wires | 93 | 653ms | 1861ms |
| deployed / all scenarios | 1158 | 639ms | 1828ms |
| all targets / all scenarios | 1187 | 639ms | 1832ms |

## 4. Connect to terminal verdict -- p50/p95 across runs

| group | n | p50 | p95 |
| --- | --- | --- | --- |
| local / scenario-a-dana-legitimate | 2 | 105374ms | 115844ms |
| local / all scenarios | 2 | 105374ms | 115844ms |
| deployed / barge-in-interrupt | 20 | 116383ms | 173765ms |
| deployed / corrected-critical-field | 14 | 91152ms | 175409ms |
| deployed / dana-patient | 28 | 84235ms | 168081ms |
| deployed / hangup-after-request | 13 | 64541ms | 96000ms |
| deployed / identity-switch | 17 | 138677ms | 178343ms |
| deployed / judge-out-of-scope | 0 | UNKNOWN | UNKNOWN |
| deployed / miller-patient | 28 | 47928ms | 90865ms |
| deployed / miller-silent-after-amount | 15 | 73587ms | 91649ms |
| deployed / prompt-injection-midcall | 16 | 122641ms | 173088ms |
| deployed / scenario-a-dana-legitimate | 9 | 81496ms | 97781ms |
| deployed / scenario-b-miller-fraud | 5 | 45133ms | 83094ms |
| deployed / single-wrong-answer | 16 | 136735ms | 194758ms |
| deployed / structuring-two-wires | 15 | 100215ms | 141218ms |
| deployed / all scenarios | 196 | 87089ms | 175791ms |
| all targets / all scenarios | 198 | 87568ms | 175766ms |

## 5. Verdict to call end -- p50/p95 across runs

| group | n | p50 | p95 |
| --- | --- | --- | --- |
| local / scenario-a-dana-legitimate | 2 | 13975ms | 26527ms |
| local / all scenarios | 2 | 13975ms | 26527ms |
| deployed / barge-in-interrupt | 20 | 10938ms | 45007ms |
| deployed / corrected-critical-field | 14 | 12708ms | 30728ms |
| deployed / dana-patient | 28 | 10804ms | 19037ms |
| deployed / hangup-after-request | 13 | 13704ms | 18594ms |
| deployed / identity-switch | 17 | 12891ms | 24814ms |
| deployed / judge-out-of-scope | 0 | UNKNOWN | UNKNOWN |
| deployed / miller-patient | 28 | 12147ms | 28791ms |
| deployed / miller-silent-after-amount | 15 | 18452ms | 45004ms |
| deployed / prompt-injection-midcall | 16 | 14648ms | 45005ms |
| deployed / scenario-a-dana-legitimate | 9 | 15534ms | 48371ms |
| deployed / scenario-b-miller-fraud | 5 | 15005ms | 19770ms |
| deployed / single-wrong-answer | 16 | 12545ms | 37564ms |
| deployed / structuring-two-wires | 15 | 15005ms | 28502ms |
| deployed / all scenarios | 196 | 13695ms | 45003ms |
| all targets / all scenarios | 198 | 13695ms | 45003ms |
