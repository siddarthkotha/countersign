# Latency table

Every number below is either PROVEN (a real subtraction between two events a live run actually emitted, computed by `scripts/rehearse/latencyMath.ts`) or UNKNOWN (the bundle this row/column needs is missing or predates the event) -- never a guess, and never rounded off into a vague qualitative claim (CLAUDE.md rule: always measured p50/p95, milliseconds, stated plainly). p50/p95 use linear interpolation over the sorted sample (the same convention numpy/R-7 use); `n` is the exact sample size for that cell, stated so a small `n` reads as small, not as confidence.

How to regenerate this file: `npm run latency:table` (reads every `*.diagnostics.json` under `scripts/rehearse/reports/`, which is gitignored and lives only on the machine that ran the rehearsals -- see docs/REHEARSAL-HARNESS.md).

Runs with a diagnostics bundle: n=9, date range 2026-09-09 to 2026-09-11.
12 additional `.md` rehearsal report(s) exist in the same directory with NO matching `.diagnostics.json` bundle (older runs, before the flight-recorder fetch was added 2026-09-09) -- every column here is UNKNOWN for those runs; they are not counted in any `n` above.

## Method, per column

1. **Socket connect to AssemblyAI ready**: `aai_ready` event minus `aai_connect_start` event (the `aai_ready` event's own `ms_since_connect_start` detail is used when present, since that is the server's own measurement of the same interval; otherwise the two events' timestamps are subtracted).
2. **Ready to first agent audio**: the first `reply.audio.first` event at or after `aai_ready`, minus `aai_ready`. Labeled "greeting" when that run's `aai_ready` event carries `greeting_configured: true`; every other row is labeled "first reply" and is NOT a pure agent-latency number -- see the caveat under section 2 below.
3. **Response latency (the gap a judge feels)**: per caller turn, the LAST `input.speech.stopped` event before the next `reply.audio.first` event, subtracted from that `reply.audio.first` (falls back to the last `transcript` event with `role: "user"` on a bundle with no `input.speech.stopped` events at all -- none of the runs on disk today needed that fallback). A turn the call ended without ever hearing a reply to contributes nothing to this column (same as a run report's own "no reply audio observed after this turn" note) -- it is not counted as 0ms.
4. **Connect to terminal verdict**: the first `terminal_action` event's timestamp (baseline: `aai_connect_start` at t=0). A run with no `terminal_action` event (it never reached a verdict -- a FAIL) is UNKNOWN for this column, and excluded from `n`.
5. **Verdict to call end**: `session_ended` minus that same `terminal_action` event.

## Per-run raw numbers

| file | date | target | scenario | connect->ready | ready->first-audio | label | connect->verdict | verdict->end | turns w/ reply |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-09-09T18-20-23-scenario-a-dana-legitimate.diagnostics.json | 2026-09-09 | deployed | scenario-a-dana-legitimate | 583ms | 17982ms | first reply, greeting_configured unknown -- older bundle (includes caller talk time before the agent speaks) | 99091ms | 9754ms | 7 |
| 2026-09-09T18-56-25-scenario-a-dana-legitimate.diagnostics.json | 2026-09-09 | local | scenario-a-dana-legitimate | 1119ms | 17293ms | first reply, greeting_configured unknown -- older bundle (includes caller talk time before the agent speaks) | 117007ms | 28ms | 7 |
| 2026-09-09T19-10-25-scenario-a-dana-legitimate.diagnostics.json | 2026-09-09 | local | scenario-a-dana-legitimate | 879ms | 17499ms | first reply, greeting_configured unknown -- older bundle (includes caller talk time before the agent speaks) | UNKNOWN | UNKNOWN | 7 |
| 2026-09-09T19-14-56-scenario-a-dana-legitimate.diagnostics.json | 2026-09-09 | local | scenario-a-dana-legitimate | 979ms | 17394ms | first reply, greeting_configured unknown -- older bundle (includes caller talk time before the agent speaks) | 93741ms | 27922ms | 7 |
| 2026-09-09T20-02-51-scenario-a-dana-legitimate.diagnostics.json | 2026-09-09 | deployed | scenario-a-dana-legitimate | 650ms | 17769ms | first reply, greeting_configured unknown -- older bundle (includes caller talk time before the agent speaks) | 73805ms | 45039ms | 8 |
| 2026-09-09T20-04-50-scenario-a-dana-legitimate.diagnostics.json | 2026-09-09 | deployed | scenario-a-dana-legitimate | 456ms | 18172ms | first reply, greeting_configured unknown -- older bundle (includes caller talk time before the agent speaks) | 91521ms | 26841ms | 7 |
| 2026-09-09T20-06-19-scenario-b-miller-fraud.diagnostics.json | 2026-09-09 | deployed | scenario-b-miller-fraud | 469ms | 13367ms | first reply, greeting_configured unknown -- older bundle (includes caller talk time before the agent speaks) | 36831ms | 20615ms | 4 |
| 2026-09-11T16-35-23-scenario-a-dana-legitimate.diagnostics.json | 2026-09-11 | deployed | scenario-a-dana-legitimate | 581ms | 32ms | greeting | 75233ms | 50592ms | 8 |
| 2026-09-11T17-44-51-scenario-a-dana-legitimate.diagnostics.json | 2026-09-11 | deployed | scenario-a-dana-legitimate | 607ms | 177ms | greeting | 83266ms | 15534ms | 5 |

## 1. Socket connect to AssemblyAI ready -- p50/p95 across runs

| group | n | p50 | p95 |
| --- | --- | --- | --- |
| local / scenario-a-dana-legitimate | 3 | 979ms | 1105ms |
| local / all scenarios | 3 | 979ms | 1105ms |
| deployed / scenario-a-dana-legitimate | 5 | 583ms | 641ms |
| deployed / scenario-b-miller-fraud | 1 | 469ms | 469ms |
| deployed / all scenarios | 6 | 582ms | 639ms |
| all targets / all scenarios | 9 | 607ms | 1063ms |

## 2. Ready to first agent audio -- p50/p95 across runs, split by whether a greeting was configured

**Caveat (PROVEN against the raw event streams of every non-greeting bundle on disk):** this column is only a pure agent-turnaround number on a "greeting" row. On every other row, this scenario has the CALLER speak first (there is no scripted agent greeting), so the agent's first audio frame only fires after the caller's own opening utterance ends -- the number is dominated by how long the caller took to speak, not by the agent. This is the exact confound docs/AUTOPILOT_LOG.md's 2026-09-11 entry already flagged by hand ("the 17s was the harness caller pacing and speaking; agent reply-start to first audio 1-150ms, n=3"). Rows are split by label below specifically so a "first reply" number is never averaged together with a "greeting" number.

| group | n | p50 | p95 |
| --- | --- | --- | --- |
| local / first reply, greeting_configured unknown -- older bundle (includes caller talk time before the agent speaks) | 3 | 17394ms | 17489ms |
| deployed / first reply, greeting_configured unknown -- older bundle (includes caller talk time before the agent speaks) | 4 | 17876ms | 18144ms |
| deployed / greeting | 2 | 105ms | 170ms |
| all targets / first reply, greeting_configured unknown -- older bundle (includes caller talk time before the agent speaks) | 7 | 17499ms | 18115ms |
| all targets / greeting | 2 | 105ms | 170ms |

## 3. Response latency (caller speech end -> next agent audio) -- p50/p95 across ALL TURNS, not runs

| group | n | p50 | p95 |
| --- | --- | --- | --- |
| local / scenario-a-dana-legitimate | 21 | 11ms | 35ms |
| local / all scenarios | 21 | 11ms | 35ms |
| deployed / scenario-a-dana-legitimate | 35 | 9ms | 114ms |
| deployed / scenario-b-miller-fraud | 4 | 4ms | 10ms |
| deployed / all scenarios | 39 | 9ms | 113ms |
| all targets / all scenarios | 60 | 10ms | 97ms |

## 4. Connect to terminal verdict -- p50/p95 across runs

| group | n | p50 | p95 |
| --- | --- | --- | --- |
| local / scenario-a-dana-legitimate | 2 | 105374ms | 115844ms |
| local / all scenarios | 2 | 105374ms | 115844ms |
| deployed / scenario-a-dana-legitimate | 5 | 83266ms | 97577ms |
| deployed / scenario-b-miller-fraud | 1 | 36831ms | 36831ms |
| deployed / all scenarios | 6 | 79250ms | 97199ms |
| all targets / all scenarios | 8 | 87394ms | 110736ms |

## 5. Verdict to call end -- p50/p95 across runs

| group | n | p50 | p95 |
| --- | --- | --- | --- |
| local / scenario-a-dana-legitimate | 2 | 13975ms | 26527ms |
| local / all scenarios | 2 | 13975ms | 26527ms |
| deployed / scenario-a-dana-legitimate | 5 | 26841ms | 49481ms |
| deployed / scenario-b-miller-fraud | 1 | 20615ms | 20615ms |
| deployed / all scenarios | 6 | 23728ms | 49204ms |
| all targets / all scenarios | 8 | 23728ms | 48648ms |
