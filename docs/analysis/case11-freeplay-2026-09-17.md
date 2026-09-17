# Case 11 (corrected-critical-field) free-play failures, deploy 43 (bdf907d) — 2026-09-17

Scenario expects STAGE. All three PROVEN FAIL (reports/2026-09-16T{21-32-40,21-35-48,21-37-49}-corrected-critical-field.md
+ .diagnostics.json). Scripted run passed 2026-09-16T17-54-56 (STAGE) — ruling 5's core mechanism
(corrected amount wins, readback names $84,500) is itself sound: run 1 below readback-confirmed
$84,500, not $84,100 (PROVEN t=71216-79009). Nothing here is a ruling-5 regression.

## Run 1: 21-32-40 — ESCALATE (expected STAGE)

Timeline (PROVEN t_ms from the .md/.diagnostics.json):
- 24071 caller: "...wire transfer of $84,100— ah, sorry, wait, I meant $84,500 to Meridian Supply." (no account#, no approver — scripted c1 has both)
- 27584/31470 agent asks authorization code, then approver; 42907 caller names Marcus Obie (approver)
- 64338 evaluate rule_row=5, challenges issued=3/failed=2 (invoice-ref, purpose — not in this scenario's free-play truth)
- 71216 agent readback "$84,500. Is that correct?" → 79009 caller confirms → readback.amount_usd=true (rule_row=5 still, t=79010)
- 80138 agent asks account ending (ELICIT_MISSING_CRITICAL — account_last4 has NO claim yet)
- 91187 caller: "The account ends in 4471." → 93455/96318/99211 three agent replies transcribed as "​" (zero-width space) — `elicit_issued` never logged (transcriptAsksQuestion finds nothing to match, session.ts:2096)
- 105519→118837 (12,318ms audio, PROVEN reply.audio.first→reply.done) agent reply with **zero transcript event** — dead-transcript reply, matches task's "105.5 to 118.8s"
- 197945 idle_timeout → rule_row=15 → ESCALATE (readback still account_last4=false, beneficiary=false)

**Exact reason STAGE unreached:** row 5 never clears — account_last4 and beneficiary claims never register, so `critical_confirmed` stays false until the call idles out.
**Rule row / evidence:** rule_row 5→15; no FAIL/contradiction card at all — this is a stuck PENDING, not a freeze/fail path.

Root cause (ENGINE DEFECT, PROVEN by regex inspection):
- `ACCOUNT_LAST4_RE` (packages/engine/src/extract/claims.ts:11) matches `ending|ending in|last four|last 4|suffix`, **not** "ends in" — caller's exact words at 91187 never match.
- Beneficiary CUE_PATTERN (claims.ts:134) requires `(pay|wire|send|transfer)\s+(...)?to\s+(NAME)` with nothing else between verb and "to" — "wire transfer **of $84,500** to Meridian Supply" has "of $84,500" in the gap, so it never matches either.
- The three "​" replies are a second, already-known issue: the automatic holding reply rendering empty text instead of a real sentence (git log 3a107ee, "One moment." fix, staged but not yet in deploy bdf907d).

Dead channel (105.5–118.8s) vs engine/caller: the dead reply happened during a STALL turn answering caller chit-chat ("Thanks for your help. Can you proceed..."), after the two extractor gaps had already stalled the field claims — the dead transcript added ~13s of unrecoverable dead air but did not itself cause the stuck fields.
Caller artefact (contributing, not causal): free-play turn 1 dropped account# and approver that the scripted line included, forcing the ELICIT_MISSING path the scripted run never hit.

**Classification:** ENGINE DEFECT (claims.ts:11, claims.ts:134) + SERVER/PLATFORM (dead transcript) + caller artefact (contributing).

## Run 2: 21-35-48 — FREEZE (expected STAGE, worst-case verdict)

Timeline:
- 24769 caller states request (with correction) truthfully; 47621 gives account+approver
- 67210 caller: "Yes, that's correct." then **70009 caller (separate utterance): "Marcus is the one who approved this transfer."**
- 70010 evaluate rule_row=6: `ev-identity-switch` FLAG, `ev-consistency-identity` FAIL — identity flipped to `marcus-obi`
- 85982/109267/138015/161163 agent repeats "I heard a different name... tell me again" four times despite caller re-stating "This is Dana Whitfield..." at 101424, 157143 (switch never resolves per rule 6's doc: once flagged it never leaves the record)
- 157144 evaluate rule_row=8 (freeze): tally=4 (2 capped contradiction + 2 knowledge FAIL, both real checks PASS) → FREEZE, spoken close at 185217

**Exact reason STAGE unreached:** rule_row 8c (`tally >= 3`): 2 (contradiction cap) + 2 (knowledge FAIL) = 4.
**Evidence card:** `ev-identity-switch` FLAG + `ev-consistency-identity` FAIL, both traced to the single utterance at 70009.

Root cause (ENGINE DEFECT, PROVEN by regex inspection): `marcus-obi` is a registered seed identity (aliases: `marcus`, seed/meridian.ts:21). identity.ts's `DISQUALIFYING_CONTINUATIONS` (lines 95–99) is built to disqualify "Marcus is our counsel" / "Marcus approved it" — an aux run of up to 3 words then the verb *immediately*. "Marcus **is the one who** approved this transfer" inserts "the one who" between the aux and the verb, so the regex doesn't match, `startsUtteranceValidly` returns true, and a mention of the approver becomes a false self-identification. This is not a caller artefact — it's exactly the natural third-person phrasing the same file's own fix-round comments say they intended to cover.

**Classification:** ENGINE DEFECT (identity.ts:95-107) — sole cause, no dead-transcript involvement in this run.

## Run 3: 21-37-49 — ESCALATE (expected STAGE)

Timeline:
- 22636 caller states request+correction; 23174 agent reply garbled ("Please provideFor the the intended invoice recipient reference'...") — self-corrects at 28080 with a clean sentence, same reply.done cycle, no lasting damage
- 41372 caller gives invoice "56789" (not seed's real INV-7734 — this scenario's truth block never gives Dana an invoice number) + approver "Marcus Obie"
- 42583 agent asks "Which internal approver signed off on this payment?" (clean transcript, PROVEN)
- **42589→51847 (9,258ms) second reply, zero transcript** — the dead-transcript window matching the task's "42.6 to 51.8s"
- 53749/60397/73804/79368 four `question_reask_sent` (`reason: question_not_asked`) — the ASK_CHALLENGE goal never advances because `recordGoalCompletionAction` (session.ts:2092-2096) can't confirm the question was asked (no transcript to match against), so `challenge_issued` never logs
- 61161 caller finally answers "That would be Marcus Obie. He approved it for processing." — correct, but with no matching issued challenge to grade it against
- 119093 idle_timeout → rule_row=15 → ESCALATE; challenges issued=2/failed=2, 0 PASS

**Exact reason STAGE unreached:** `at_least_one_challenge_passed` never true — the one challenge (approver) the caller answered correctly is never credited a PASS because the engine's own LAW-4 safeguard (never claim a question was asked when it wasn't) correctly refuses to log it, orphaning the caller's real answer.
**Rule row / evidence:** rule_row 4→15 (never leaves the "ask a challenge" loop); no FAIL/contradiction card — two knowledge FAILs are both the unscoped invoice number, asked/reasked, never the approver question.

Dead channel vs engine: this is exactly TEST-PLAN.md's documented race ("the empty reply after an instant request") — a second reply.create fired immediately after the challenge question's own reply, before the caller spoke, and its transcript never arrived. The engine's downstream behavior (refuse to credit an unconfirmed ask) is correct given the evidence it has; the dead transcript is what created the false negative.
Caller artefact / expectation: the invented invoice number "56789" is not a defect — this scenario's `truth` block never gives the free-play persona a real invoice reference, so any invoice answer necessarily FAILs (matches seed/meridian.ts:96-98's real value INV-7734, absent from this scenario file). That FAIL is expected and harmless on its own (need=1, only one PASS required) — it only mattered because the dead transcript stole the one challenge that would have passed.

**Classification:** SERVER/PLATFORM defect (dead transcript, same race TEST-PLAN §"turn order design change (E)" already names) — sole cause of the terminal failure; the invoice FAIL is expectation-neutral (a genuinely unscoped fact).

## Summary

| Run | Verdict | Rule row | Root cause |
|---|---|---|---|
| 21-32-40 | ESCALATE | 5→15 | engine (2 extractor regex gaps) + platform (dead transcript, contributing) |
| 21-35-48 | FREEZE | 6→8c | engine (identity false-positive regex gap) only |
| 21-37-49 | ESCALATE | 4→15 | platform (dead-transcript race, matches TEST-PLAN's known "empty reply after instant request") |

## Single most valuable fix before the founder plays case 11

Fix identity.ts's `DISQUALIFYING_CONTINUATIONS` first: it is the only ENGINE-only defect (no platform variance to hide behind), it is fully deterministic and unit-testable, and it produces the single worst outcome in this batch — a **FREEZE** on an honest caller (run 2), the exact false-positive the product's credibility depends on avoiding. Add an intervening low-content run (`(?:the one who|the person who|the one that)`) to the aux/verb gap, or generalize `AUX_RUN` to allow a short relative-clause filler before the disqualifying verb.

**Test that proves it:** a new case in `packages/engine/test/` (identity extraction or fsm.test.ts) asserting `extractIdentityClaim("Marcus is the one who approved this transfer.", seed)` with Dana as current identity returns no identity claim / no switch, mirroring the existing "Marcus Obi has approved it" regression already covered.

Second priority (same session, both Haiku-sized, both test-first): claims.ts:11 add `ends in` to `ACCOUNT_LAST4_RE`; claims.ts:134 loosen the beneficiary pattern to tolerate an amount/filler clause between the verb and "to" (e.g. `\b(?:pay|wire|send|transfer)\b.{0,40}?\bto\s+(NAME)`, non-greedy, capped). Both are PROVEN causal to run 1's stall.

Do not attempt to "fix" the dead-transcript race (runs 1 and 3) inside this analysis window — it is TEST-PLAN's already-scoped design-E turn-order change, still pending its own 30-minute live confirmation; re-running case 11 before that lands will likely reproduce run 3's exact failure regardless of any engine fix.

## UNKNOWN

- Whether design E (once live) actually eliminates the "empty reply after an instant request" race for THIS scenario specifically — UNKNOWN until its own 30-min confirmation runs.
- Whether AssemblyAI ever sent the transcript.agent message for the two dead windows and the server/harness dropped it, vs. AssemblyAI never sent it at all — UNKNOWN; the new observability (push 43, 4e192cd/5b3606e) surfaces unmodelled messages but neither report's `aai_unhandled_message` list contains a stray transcript.agent for either dead window (checked both diagnostics files) — ESTIMATE this favors "AssemblyAI never sent it," not a server drop, but not proven.
- Whether grading "I don't have the invoice number on hand" as knowledge-check FAIL (not the documented 0.5-weight FLAG/REFUSED) is itself a small separate defect — UNKNOWN, and it did not change any of the three verdicts in this batch (tally would still clear the relevant thresholds either way), so left out of scope here.
