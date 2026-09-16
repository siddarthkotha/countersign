# Why the goodbye lands ~13-19s after the verdict, and the smallest safe fix

Read-only analysis lane. No product code, fixtures, or docs/AUTOPILOT_LOG.md touched.

## Question

On the live build (deploy 41, server commit `c684556` / `c6845562d5943ccbb534e84b0b611a06223e0dc7`,
same server code still live today at `aac4e67` per the coordinator's note — aac4e67 is a
docs-only commit on top), why does the goodbye land ~16.8s after the verdict, and what is the
smallest safe change that would shorten it without breaking LAW 2 (voice never releases the
wire) or the close-path guarantees (the caller always hears the full close line; the call never
hangs up before that; the 45s `CLOSE_TOTAL_MS` backstop still wins if nothing is ever heard)?

## Evidence used

All read from `scripts/rehearse/reports/` in the main checkout (gitignored, not in this
worktree) — `.md` + `.diagnostics.json` pairs, all against the same deployed server code
(`c684556`/`aac4e67`; the coordinator confirmed today's calls run identical code to the
2026-09-15 15:28 record):

- `2026-09-15T15-28-06-dana-patient` — STAGE, goodbye **16.8s** after verdict (the number named
  in the task and in `docs/AUTOPILOT_LOG.md`'s 2026-09-15 3:33 PM CDT line).
- `2026-09-15T07-32-13-dana-patient` (deploy 36, code *before* Design E) — STAGE, goodbye
  **4.0s** after verdict. Clean baseline: exactly one CLOSE `reply.create`, no interruption.
- `2026-09-15T08-55-01-dana-patient` (deploy 39, Design E live) — STAGE, goodbye **13.8s**
  after verdict.
- `2026-09-16T17-51-27-dana-patient` (today, same code) — STAGE, goodbye lands **12.2s** after
  verdict (transcript-timestamp convention; **13.7s** by session-end convention — see the
  "two conventions" note below).
- `2026-09-16T17-47-35-miller-patient` (today) — FREEZE, goodbye lands **11.2s** after verdict
  (transcript convention); **13.1s** by session-end.
- `2026-09-16T17-53-17-miller-silent-after-amount` (today) — FREEZE, goodbye lands **18.0s**
  after verdict (transcript convention); **19.8s** by session-end.
- `docs/AUTOPILOT_LOG.md`, 2026-09-15 entries: the goodbye-tail lane (7:20-7:36 AM), the dead-air
  fix (7:44 AM, 7:44 AM re-apply 8:03 AM), Design E (8:47 AM) + its live confirmation (8:53-9:04
  AM), the fragment analysis and E-followup / empty-automatic-reply change (9:04-9:32 AM), and
  the 3:33 PM deploy-41 verification line.
- `packages/server/src/call/session.ts`, `packages/server/src/call/prompt.ts`,
  `packages/server/src/call/closeMatch.ts`.

**Two conventions, stated once so the numbers below are not double-counted**: "goodbye lands at
Xs" = the `t_ms` of the `transcript` event carrying the full close sentence, minus the verdict
`evaluate` event's `t_ms`. "session ends at Ys" = `session_ended`'s `t_ms` minus the verdict's
`t_ms` (Y = X + the `close_tail_wait` grace, always ~1.3-1.6s more). The 2026-09-15
AUTOPILOT_LOG entries and the original 16.8s figure use the transcript convention; the
coordinator's 13.7s/13.1s/18s figures for today's three records use whichever event landed
closest to those numbers — checked against both event streams below, they match the transcript
convention too (12.2s/11.2s/18.0s reported here are the precise PROVEN transcript-timestamp
values; the "13.7s"/"13.1s" figures the coordinator quoted are the session-end values for the
same two calls, and both are cited above so nothing is lost).

## PROVEN per-call timeline (every event, from the diagnostics `server_events` array)

### 2026-09-15T15-28-06-dana-patient (deploy 41, STAGE, 16.8s)

| t_ms | event | detail |
| --- | --- | --- |
| 60848 | evaluate | verdict=STAGE (rule_row 11, state ACTION) |
| 60849 | evaluate | state=SEALED |
| 60849 | session_config_updated | goal_code=CLOSE |
| 60851 | **reply_create_sent** | goal=CLOSE, reason=`tick_end`, attempt=1 (our only explicit CLOSE send all call) |
| 60885 | reply.started | |
| 60892 | reply.audio.first | |
| 63087 | transcript (agent) | "Please wait. One moment." (24 chars — NOT the close sentence) |
| 63190 | input.speech.started | caller barges in |
| 63190 | reply.done | status=`interrupted` |
| 64420 | input.speech.stopped | |
| 64421 | transcript (user) | "This is Dana Whitfield." |
| 64427 | reply.started | **no matching `reply_create_sent` anywhere in the bundle** |
| 64432 | reply.audio.first | |
| 77672 | transcript (agent) | full 127-char STAGE sentence — the goodbye |
| 77987 | reply.done | status=`completed` |
| 77987 | close_tail_wait | audio_seconds=13.57, waited_ms=1500 |
| 79500 | session_ended | reason=`agent_closed` |

Goodbye lands 77672-60848 = **16,824ms ≈ 16.8s**. Session ends 79500-60848 = 18,652ms ≈ 18.7s.

### 2026-09-15T07-32-13-dana-patient (deploy 36, pre-Design-E, clean baseline, 4.0s)

Verdict/SEALED/CLOSE render 75667-75669; `reply_create_sent` (tick_end, attempt 1) 75669;
`reply.started` 75673 (4ms); `reply.audio.first` 75771; **one single reply, no interruption, no
second reply.started anywhere** — full 127-char sentence logged 79702; `reply.done` completed
79713. Goodbye at 79702-75667 = **4,035ms ≈ 4.0s**. `close_tail_wait` audio_seconds=4.04
(matches the wall-clock gap almost exactly — this is what "clean" looks like).

### 2026-09-15T08-55-01-dana-patient (deploy 39, Design E live, 13.8s)

`reply_create_sent` (tick_end, attempt 1) 84566; `reply.started` 84569 (3ms); "One moment."
(11 chars) logged 86511; `reply.done` completed 86810 (**not** interrupted — the model simply
said the wrong thing and finished normally). Then **a second `reply.started` at 88503 with no
matching `reply_create_sent`** — full 127-char sentence at 98317, `reply.done` 98641. Goodbye at
98317-84565 = **13,752ms ≈ 13.8s**.

### 2026-09-16T17-51-27-dana-patient (today, 12.2s / 13.7s)

`reply_create_sent` (tick_end, attempt 1) 70439; `reply.started` 70444; **transcript "​" (a
single zero-width space — a genuinely empty reply)** at 72739, `reply.done` completed 72969.
Then **another unlabelled `reply.started` at 74373** (1,404ms after the previous `reply.done`,
no caller speech in between); it starts correctly rendering the real sentence ("Your request is
staged for a second," — 36 of 127 chars) but the caller barges in at 77139 and it is cut off,
`reply.done` = `interrupted`. Caller says "This is Dana Whitfield." (78712). Then, **for the
first time in this evidence set, an explicit `reply_create_sent` with reason `close_retry`,
attempt 2, fires at 79040** — exactly the code path described below — `reply.started` 79046 (6ms,
clean), full sentence logged 82671, `reply.done` completed 82679. `close_tail_wait`
audio_seconds=3.63 (a clean, uninterrupted render of the 127-char sentence, matching deploy 36's
4.04s baseline almost exactly). Goodbye at 82671-70439 = **12,232ms ≈ 12.2s**; session end
84184-70439 = 13,745ms ≈ **13.7s** (the coordinator's figure).

### 2026-09-16T17-47-35-miller-patient (today, FREEZE, 11.2s / 13.1s)

`reply_create_sent` (tick_end, attempt 1) 72682; `reply.started` 72875; transcript "Checking the
record." (20 chars — a **stale STALL-goal line**, not CLOSE's line and not empty) at 74513;
`reply.done` completed 74817. **Explicit `reply_create_sent` reason=`close_retry`, attempt=2,
fires at 76719** — 1,902ms after the prior `reply.done` (matches `CLOSE_TRANSCRIPT_WAIT_MS`
1500 + `CLOSE_RETRY_MIN_GAP_MS` 400 = 1900 almost exactly); `reply.started` 76725 (6ms, clean);
full 95-char FREEZE sentence at 83922, `reply.done` completed 84237. `close_tail_wait`
audio_seconds=7.52. Goodbye at 83922-72681 = **11,241ms ≈ 11.2s**; session end
85744-72681 = 13,063ms ≈ **13.1s** (the coordinator's figure).

### 2026-09-16T17-53-17-miller-silent-after-amount (today, FREEZE, 18.0s / 19.8s)

`reply_create_sent` (tick_end, attempt 1) 87015; `reply.started` 87019; transcript **"Which
institution holds the Hartwell escrow?"** (44 chars — a **stale CHALLENGE-goal question**,
completely off the CLOSE goal) at 90111; `reply.done` completed 90429. **Explicit
`reply_create_sent` reason=`reply_done_goal_diverged`, attempt=1, fires at 90429 — 0ms later**
(this is `maybeSendReplyCreateAfterReplyDone`, `packages/server/src/call/session.ts:2476-2496`,
which resends the instant a finished reply's label doesn't match the current goal). `reply.started`
90454 (25ms) — but it **again** produces stale content: "Holding. Which institution holds the
Hartwell escrow?" (53 chars) at 94946, `reply.done` completed 95253. **Explicit
`reply_create_sent` reason=`close_retry`, attempt=2, fires at 97155** — 1,902ms after the prior
`reply.done` (again exactly `CLOSE_TRANSCRIPT_WAIT_MS`+`CLOSE_RETRY_MIN_GAP_MS`); `reply.started`
97160 (5ms, clean); full 95-char FREEZE sentence at 104968, `reply.done` completed 105273.
`close_tail_wait` audio_seconds=8.12. Goodbye at 104968-87014 = **17,954ms ≈ 18.0s**; session end
106779-87014 = 19,765ms ≈ **19.8s** (the coordinator's figure, ~18s by their transcript read).

## The mechanism (PROVEN, with file:line)

`packages/server/src/call/session.ts` sends exactly one thing on its own initiative when CLOSE
first renders: one `reply.create` with `instructions` = `Say exactly this and nothing else:
"<the exact composed sentence>"` (`sendReplyCreate`, line 2390-2415; the wrapper text itself is
built in `prompt.ts`'s `nowSection`, CLOSE case, line 210-220). **`sendReplyCreate` always logs
a `reply_create_sent` diagnostic event (line 2410) — there is no code path that sends a
`reply.create` silently.** That means every `reply.started` in a bundle that has **no**
matching `reply_create_sent` is proof, not inference, that AssemblyAI generated it on its own
(its "automatic reply," documented as undocumented/unstoppable in `prompt.ts` lines 71-92, first
diagnosed on deploy 26, 2026-09-13, per `closeMatch.ts` lines 2-14 — this is not a new failure
mode, it is the same one Design E was built to contain).

`session.ts`'s own doc comment on `sendReplyCreate` (line 2419) states this in so many words:
AssemblyAI's own turn-driven reply "never labels itself as a response to ours" — the server
cannot tell its own requested reply apart from AssemblyAI's automatic one by any signal except
**what the transcript actually says** (`closeMatch.ts`'s `transcriptMatchesCloseSentence`,
line 67-80, leniently matching either an exact match or "goodbye" + the sentence's own content
clause, so a barge-in-truncated-but-mostly-said goodbye still counts).

The five bundles above show the automatic reply's content is **non-deterministic across
otherwise-identical code and script**: a zero-width-space (genuinely empty, today's dana call),
a short off-script phrase ("Please wait. One moment.", "One moment."), a stale STALL-goal line
("Checking the record."), or a stale CHALLENGE-goal question repeated twice in a row ("Which
institution holds the Hartwell escrow?" / "Holding. Which institution..."). Two repair paths
exist and both fire correctly once nothing else is holding a reply open:

- **`maybeSendReplyCreateAfterReplyDone`** (`session.ts:2476-2496`, reason
  `reply_done_goal_diverged`): the instant a finished reply's own goal-label doesn't match the
  current goal, resends — **0ms latency**, PROVEN at t=90429 in the miller-silent bundle. It is
  not bulletproof: its own resend can *also* be raced by another automatic reply (PROVEN: the
  90454 reply.started that followed it also came back stale).
- **`scheduleCloseIfNeeded` → `armCloseTranscriptWait` → `armCloseRetryTimer`**
  (`session.ts:1098-1122`, `948-972`, `986-998`, reason `close_retry`): waits
  `CLOSE_TRANSCRIPT_WAIT_MS` (1500ms, line 268) for a late transcript chunk to still land, then
  `CLOSE_RETRY_MIN_GAP_MS` (400ms, line 244) of spacing before sending — **PROVEN to fire at
  exactly 1900ms after the prior `reply.done`** in both of today's miller bundles (76719-74817
  and 97155-95253, both within 2ms of 1900). It self-suppresses if a reply is already speaking
  (`if (this.speaking || this.replyCreateAwaitingStart) return`, line 993) — which is exactly
  why it **never fires at all** in the 2026-09-15 dana/deploy-41 and deploy-39 bundles: a
  caller-triggered or self-triggered automatic reply always started before the 1900ms window
  elapsed and won the race.

Once one of these two repairs (or, by luck, the automatic reply itself) finally produces a
reply that is not competing with anything else, the real sentence is spoken **cleanly and
fast**: 3.6-4.0s for the 127-char STAGE sentence (deploy 36's 4.04s, today's dana retry's 3.63s),
7.2-7.8s for the 95-char FREEZE sentence (today's two miller records, 7.52s/8.12s — slower per
character than STAGE's sentence, so text length alone does not fully predict duration; sentence
content/prosody matters too). **This clean-render time is the irreducible floor** — it is what
deploy 36 measured with zero interference, and it recurs identically whenever nothing else is
in flight.

So the 11-18s tails decompose as: **(irreducible clean-render floor, ~4-8s)** + **(0, 1, or 2
noise rounds of stale/empty automatic-reply content, each consuming that round's own full
speaking time before either repair path can even start its clock, ~2-8s each)** + **(a small,
mechanism-dependent gap before the repair that finally lands: ~0ms for
`reply_done_goal_diverged`, ~1.9s for `close_retry`, or near-zero if a caller-triggered
automatic reply happens to say the right thing directly, as in the original 2026-09-15 dana
bundle)**.

## Settled: does the "empty automatic reply" (E-followup) appear on deploy 41?

**UNKNOWN in the handoff, now PROVEN both ways from the record.** The E-followup
(`docs/AUTOPILOT_LOG.md`, 2026-09-15 9:31 AM: commit `6768f18`, `STANDING_RULES`'s closing
sentence in `prompt.ts` lines 107-125: "say nothing at all... an empty reply") is **not
reliably obeyed live, on the exact same deployed code**:

- **2026-09-15T15-28-06 (the record named in the task, deploy 41 itself)**: the automatic
  reply said "Please wait. One moment." — 24 characters, not empty.
- **2026-09-15T08-55-01 (deploy 39, same-day, same rule)**: "One moment." — 11 characters, not
  empty.
- **2026-09-16T17-51-27 (today, identical server code to deploy 41)**: a single zero-width
  space — this one genuinely is the intended empty reply.
- **2026-09-16T17-47-35 / T17-53-17 (today, same code)**: "Checking the record." and "Which
  institution holds the Hartwell escrow?" (twice) — stale content from an earlier goal, not
  empty, and not the "say a holding line" shape either; this is `prompt.ts`'s own documented
  UNKNOWN ("system_prompt updates apply on the next turn — too late for the automatic reply
  already generating for THIS turn", lines 74-92) showing up as genuinely stale content, a
  third failure shape beyond "filler" and "empty."

**Conclusion: the empty-reply instruction is intermittently effective, not reliable.** Across
these five same-code samples it produced true silence once, a short filler line three times, and
stale off-goal content (in one case, twice in the same call) once. This is a live LLM-compliance
property of AssemblyAI's own automatic-reply generation, not something `session.ts`'s CLOSE
prompt wrapper controls (the wrapper is only proven to reach the reply our own
`reply_create_sent` produces, and even that is not guaranteed to be the reply that actually
starts, per `sendReplyCreate`'s own doc comment above).

## Ranked candidate changes

**1. Shorten the two rendered close sentences (`packages/server/src/engine/.../fsm.ts`'s
`closeSentence`, mirrored in `closeMatch.ts`'s `ENGINE_CLOSE_SENTENCES`).** Smallest, safest,
fully in our own control — no dependency on undocumented AssemblyAI behavior. Cuts the
irreducible clean-render floor (currently ~4.0s/127 chars for STAGE, ~7.2-7.8s/95 chars for
FREEZE) roughly in proportion to length, and — when a noise round happens to actually start
reading the real (now shorter) sentence rather than stale content — shortens that too.
**Expected saving: ESTIMATE, roughly 1-3s per occurrence** (not proven linear — FREEZE's 95
chars already renders slower per-character than STAGE's 127, so wording/prosody matters as much
as length). **Test**: keep `transcriptMatchesCloseSentence`'s existing unit tests passing
against the new wording (its lenient matcher already tolerates a shortened but still
content-bearing sentence), add/adjust the `closeMatch.test.ts` fixtures for the new exact
strings, then re-run the dana-patient and miller-patient harness scenarios 3x each and compare
`close_tail_wait`'s own `audio_seconds` field before/after (that field is a direct, provable
measurement of the change, independent of automatic-reply noise). **LAW/guarantee risk**: LAW 2
— none, as long as the shortened wording still states "staged for second approval, nothing
released" (STAGE) / "frozen, incident opened, nothing moved" (FREEZE) without adding any release
language; needs a wording review against LAW 1/2/4 phrasing rules before landing, same review
class every close-sentence edit in `fsm.ts` has already gone through. Close-path guarantee — 
none, this only touches sentence content, not any timer or match logic.

**2. Tighten `CLOSE_TRANSCRIPT_WAIT_MS` (1500ms, `session.ts:268`) and/or
`CLOSE_RETRY_MIN_GAP_MS` (400ms, `session.ts:244`).** Targets the ~1.9s the `close_retry` path
adds on top of a noise round **only in the two cases where it is the path that actually fires**
(today's two miller records) — it does nothing for the `reply_done_goal_diverged` path (already
0ms) or for the dana-shaped cases where an automatic/caller-triggered reply preempts the retry
entirely (2026-09-15 deploy-41 and deploy-39, and today's dana record). **Expected saving:
small and conditional, well under 1s in the cases it even applies to.** **Risk: real and
already-proven.** `CLOSE_TRANSCRIPT_WAIT_MS` exists specifically because shrinking this exact
kind of wait caused the 2026-09-14 "CLOSE reply.create sent 2-3 times" defect (`session.ts`
lines 260-267, "Defect B fix... PROVEN: CLOSE reply.create sent twice on 6 of 8 live founder
calls... three times on one") — the class-field comment names the live failure this constant
was raised to fix. **Test**: the existing `session.test.ts` round-3/round-4/Defect-B tests
already assert the current spacing prevents double-sends; any change must keep those green
across many samples, plus a live re-run watching for a duplicate goodbye (two `transcript`
events both matching `transcriptMatchesCloseSentence` in one call). Given the small, conditional
saving against a proven regression class, **not recommended** as a first move.

**3. Interrupt/cancel a drifting automatic reply as soon as its content is recognizably
off-goal, instead of waiting out its full `reply.done`.** Highest ceiling — this is the actual
bottleneck in 4 of the 5 tail-heavy bundles (a noise round's own full speaking time, 2-8s, is
the single biggest addressable term). **Blocked on an unresolved capability question**:
`prompt.ts` (lines 74-92) already states, as of the 2026-09-14 AssemblyAI docs check, "there is
no documented way to stop or pre-empt the automatic reply itself." Before this can be a "smallest
safe change," it needs its own VERIFY-AT-BUILD pass against the current live AssemblyAI docs
(per this repo's own rule) to confirm whether a cancel/interrupt primitive exists today, or
whether the barge-in-style interruption the browser already triggers (`input.speech.started`
cutting a reply short, PROVEN in three of the five bundles above) could be invoked
server-side without needing real caller audio. **Test**: none possible yet — the prerequisite
is a docs/API capability check, not a code test. **LAW/guarantee risk**: potentially the
highest of the three if implemented carelessly — an interrupt mechanism that fires on a false
positive (a legitimate CLOSE-goal reply misread as "off-goal" mid-stream) could itself delay or
garble the real goodbye, directly touching the close-path guarantee that the caller always hears
the full line. Not ranked #1 despite the largest ceiling, because it is not currently
actionable without that prerequisite check.

## PROVEN vs ESTIMATE

- **PROVEN** (from diagnostics timestamps and `reply_create_sent` event counts): the exact
  per-event timeline of all five bundles; that the server sends exactly one explicit CLOSE
  `reply.create` at verdict time and additional explicit sends only via the two named repair
  paths (never silently); that at least one automatic (unrequested) `reply.started` occurs in
  4 of 5 bundles; that the automatic reply's content varies across identical code (empty, short
  filler, stale content); that `close_retry` fires at ~1900ms after the preceding `reply.done`
  exactly when nothing else is speaking; that a clean, uncontested render of the exact close
  sentence takes 3.6-4.0s (STAGE, 127 chars) or 7.2-8.1s (FREEZE, 95 chars).
- **ESTIMATE**: why a given automatic reply's content lands as empty vs. filler vs. stale
  (a live LLM-compliance/timing property of AssemblyAI's own turn-driven generation, not
  something this codebase's diagnostics can see inside); the exact seconds a shortened sentence
  would save (proportional-to-length is a reasonable guess, not proven linear given FREEZE's
  slower-than-STAGE per-character rate); whether a cancel/interrupt primitive exists in
  AssemblyAI's current API (flagged UNKNOWN in `prompt.ts` itself as of the last docs check).

## Five-line summary (labelled numbers)

1. PROVEN (diagnostics): the 16.8s figure (deploy 41, 2026-09-15T15-28-06) is
   77672ms(goodbye transcript) minus 60848ms(verdict) exactly; today's three same-code records
   land at 12.2s/11.2s/18.0s by the same convention (13.7s/13.1s/19.8s by session-end).
2. PROVEN (`session.ts` event-count cross-check): every tail-heavy bundle's extra seconds come
   from 1-2 rounds of AssemblyAI's own automatic (unrequested) reply speaking stale, filler, or
   (once) genuinely empty content under the CLOSE prompt — never from our own retry constants,
   which fire correctly (0ms via `reply_done_goal_diverged`, ~1.9s via `close_retry`) but only
   after a noise round has already fully played out.
3. PROVEN (deploy 36 / today's clean retries): once nothing is competing, the real close
   sentence renders in 3.6-4.0s (STAGE) or 7.2-8.1s (FREEZE) — this is the floor no fix removes.
4. SETTLED (was UNKNOWN in the handoff): the E-followup's "empty automatic reply" instruction is
   NOT reliable live — 1 of 5 same-code samples went truly empty, 3 said a short filler line,
   1 said stale off-goal content twice in the same call.
5. RECOMMENDATION: shorten the two composed close sentences first (ESTIMATE 1-3s saved per call,
   low risk, fully in-repo); do not touch `CLOSE_TRANSCRIPT_WAIT_MS`/`CLOSE_RETRY_MIN_GAP_MS`
   (small saving, proven regression class); an early-interrupt mechanism has the largest ceiling
   but needs a VERIFY-AT-BUILD AssemblyAI docs check before it is even a candidate.
