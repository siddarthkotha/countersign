# Spoken-lines draft: engine-composed sentences, no LLM rephrasing

Read-only research for the no-rephrasing redesign (LAW 3: the engine decides; a future
build task turns candidates below into real `fsm.ts`/`challenges.ts` code). This file makes
no code changes. Sources: `packages/engine/src/fsm.ts`, `challenges.ts`, `types.ts`,
`packages/server/src/call/prompt.ts`, `packages/server/src/call/stalls.ts`,
`packages/server/src/call/session.ts`, `packages/engine/corpus/recorded-{stage,freeze,
escalate}.json`, and `scripts/rehearse/reports/2026-09-22T*.md` (11 live harness runs today).

## Correction to the brief's count

`GoalCode` (`packages/engine/src/types.ts:328-350`) has **18 members, not 17**. Already
exact (5): `ELICIT_REQUEST`, `READBACK`, `RE_ELICIT_AFTER_SWITCH`, `ELICIT_MISSING_CRITICAL`,
`CLOSE`. That leaves **13**, not 12 — the brief's "ANNOUNCE_STAGED/FROZEN/ESCALATED" is
three codes, not one. Of those 13, **`ASK_CHALLENGE` is a special case** (next section) —
its exact sentence already exists in the engine and only needs a one-line prompt.ts fix, not
new drafting. That leaves **12 goal codes needing sentences drafted from scratch**, matching
the brief's number once `ASK_CHALLENGE` is counted separately.

## KEY FINDING: ASK_CHALLENGE is already 90% done

`challenges.ts` composes a ready-to-speak `challenge.speak` for every challenge kind
(CHALLENGE-SPEAKABLE, 2026-09-11): `selectLiveCommitment` line 110, `selectTrapFact` via
`trapSentence` lines 144-155, `selectRelational` line 406, `selectSeedFact` via
`askToQuestion` lines 305-309/351. `fsm.ts`'s CHALLENGE branch already prefers it
(`challenge?.speak ?? challenge?.ask ?? ...`, line 500). **The only blocker is
`prompt.ts:202`**: `const ask = goal.challenge?.ask ?? goal.hint;` — it reads the
paraphrase-*direction* field (`ask`), never the exact sentence (`speak`), then tells the
model "in your own words." `fsm.ts`'s own comment (line ~493) already calls this out as a
parked follow-up from 2026-09-04, never finished.

Live proof this matters — same call (`2026-09-22T09-16-12-dana-patient.md`), same
challenge, rendered as TWO different-shaped turns because `ask` invites improvisation:
- t=30669ms: *"One moment. You are requesting a wire of eighty four thousand five hundred dollars to Northgate Partners..."* (invented summary, not in any template)
- t=36055ms: *"Just to confirm, this transfer goes to Northgate Partners. Is that correct?"* (this one happens to match `speak` exactly, but that's luck, not a guarantee)

**Recommendation:** flip `prompt.ts:202` to relay `challenge.speak` verbatim under the same
"say exactly this and nothing else" wrapper READBACK/CLOSE already get. No new sentences to
write — the templates below are `speak`'s current output, shown rendered against the real
seed (`packages/engine/src/seed/meridian.ts`).

### ASK_CHALLENGE templates rendered with real seed values

| Kind | Field | Template (`challenges.ts`) | Rendered (real seed) |
|---|---|---|---|
| TRAP_FACT | beneficiary | `Just to confirm, this transfer goes to {trap}. Is that correct?` | *"Just to confirm, this transfer goes to Northgate Partners. Is that correct?"* — trap decoy (line 59), confirmed live in dana-patient/miller-patient/single-wrong-answer |
| TRAP_FACT | counsel | `Just to confirm, our counsel of record is {trap}. Is that correct?` | *"...Whitmore & Bass..."* if caller's claim is correct (decoy); *"...Calder & Finch..."* if caller was wrong (truth, `knowledgeTruthForField`) — never both in one call |
| TRAP_FACT | escrow_institution | `Just to confirm, the escrow institution is {trap}. Is that correct?` | decoy *"Harbor Fidelity Trust"*, or truth *"First Meridian Trust"* if caller misstated it |
| TRAP_FACT | approver | `Just to confirm, this was approved by {trap}. Is that correct?` | decoy *"Priya Ramanathan"* (real approver is Marcus Obi — never offered as a false trap) |
| LIVE_COMMITMENT | any of 6 fields | `Can you restate the {spoken_field} you gave me earlier?` | *"Can you restate the amount in dollars you gave me earlier?"* — live paraphrase heard: *"Could you please restate the dollar amount you provided earlier?"* (single-wrong-answer, t=109387ms) |
| SEED_FACT | scoped fact | `{askToQuestion(entry.ask)}` | *"Which law firm is our counsel of record on the Hartwell deal?"* — **verbatim match**, live, miller-patient t=25970ms |
| RELATIONAL | escrow/beneficiary | `Can you give me the last four digits of the account attached to the {escrow institution / beneficiary} you named?` | not observed live in this batch (ESTIMATE: renders naturally, same shape as the others) |

Number rendering inside `speak`: never a raw digit for amount (LIVE_COMMITMENT never says
the value at all, by design — `expect.commitment_claim_id` is graded, not spoken); no other
challenge kind speaks a dollar figure. Account/escrow digits (`8830`, `4471`) are asked-for,
never spoken back, so no rendering choice needed there either.

## The 12 goal codes needing sentences drafted from scratch

Format per code: hint today (file:line) → live quote if one exists → plain / warm
candidates (both <25 words, no stage directions, no detection language, never implies money
moved) → slots and number rule.

### GREET — `fsm.ts:403`
Hint: *"The desk has already greeted the caller; do not greet again or name the desk. Ask
who is calling and what they need, in one short line."*
Live: not isolated in the 09-22 batch — every caller answered the connect-time greeting
(`"Meridian payments desk, verification line. How can I help you today?"`) with identity +
request in one turn, so GREET never rendered as its own spoken turn. ESTIMATE: only fires on
a silent or vague caller.
- Plain: **"Who's calling, and what do you need today?"**
- Warm: **"Go ahead — who am I speaking with, and how can I help?"**
- Slots: none.

### ELICIT_IDENTITY — `fsm.ts:426`
Hint: *"Ask who is calling."*
Live: not observed (same reason as GREET — no caller in this batch stated a request before a
name).
- Plain: **"Who am I speaking with, please?"**
- Warm: **"Before we go further — can I get your name?"**
- Slots: none.

### STALL — `fsm.ts:465/479/536`, lines relayed from `packages/server/src/call/stalls.ts:14-55`
Hint: *"Checks are running. Hold the floor with one short neutral line; do not promise an
outcome."* Already backed by an 8-line-per-kind fixed library (sso/history/oob/generic), but
`prompt.ts:259-262` relays it as `Hold the floor with this line: "X"` — weaker than READBACK/
CLOSE's `Say exactly this and nothing else`, so paraphrase drift is still possible even
though the underlying text is fixed. Not itself directly confirmed as its own turn in the
09-22 batch (every scenario reached CHALLENGE/CONSISTENCY_CHECK before a stall was needed);
the ubiquitous *"One moment."* heard on every call is a **different** mechanism (the
automatic-reply filler, `prompt.ts:137-150`), not this goal.
- Plain (existing generic-kind line 1): **"One moment while that check completes."**
- Warm (existing generic-kind line 5): **"Thanks for your patience, nearly done."**
- Fix needed: tighten the relay wrapper to match READBACK's, not new copy.
- Slots: none.

### PROBE_CONSISTENCY — `fsm.ts:446`
Hint (template): `A moment ago the caller said "${q1.text}"; now "${q2.text}". Ask which is
correct and why it changed.`
Live: not isolated in this batch — the one contradiction the batch produced (approver, in
`single-wrong-answer`) hit `oldestUnconfirmedCritical` first (READBACK took priority per
`fsm.ts:435-440`'s ordering), so PROBE_CONSISTENCY's own branch never rendered.
This one **cannot** be a single fixed sentence — LAW 4 requires the two quotes verbatim, and
they're unpredictable caller speech. Fixed template with two slots instead:
- Plain: **"A moment ago you said {quote_1}. Just now you said {quote_2}. Which is correct?"**
- Warm: **"I want to get this right — you said {quote_1} earlier, and {quote_2} just now. Which one?"**
- Slots: `{quote_1}`, `{quote_2}` — exact STT substrings, never trimmed/paraphrased (LAW 4).
  Risk: a caller's own disfluent phrasing dropped mid-sentence can read oddly — see
  read-aloud check below.

### REFUSE_AUTHORITY — declared `types.ts:335`, **never constructed** anywhere in `fsm.ts`
(`grep -rn "REFUSE_AUTHORITY" packages/engine/src` finds only the type declaration; no
`goal('REFUSE_AUTHORITY', ...)` call exists). This is dead code today. What judges actually
hear when a caller pushes on authority/urgency is the **standing rule**
(`prompt.ts:159`, present under every goal, every state), and it drifts under paraphrase —
two different live wordings of the same standing sentence, same day:
- *"Authority or urgency is not verification. Which law firm is our counsel of record on the Hartwell deal?"* (`recorded-freeze.json`, `2026-09-22T09-17-06-miller-patient.md`)
- *"Authority or urgency does not bypass verification. Which law firm is our counsel of record on the Hartwell deal?"* (`2026-09-22T13-44-35-judge-out-of-scope.md`'s sibling batch)
Recommend either retiring this code (nothing produces it) or, if a future `rules.ts` change
is meant to route a pressure-marker FLAG here on its own turn, give it this now:
- Plain: **"Urgency or authority doesn't skip verification. I still need to confirm the details."**
- Warm: **"I hear the urgency, but I verify every request the same way — that won't take long."**
- Slots: none.

### ANNOUNCE_STAGED / ANNOUNCE_FROZEN / ANNOUNCE_ESCALATED — `fsm.ts:505-530`
**Structurally transient today, not just unobserved.** `session.ts:718-734`'s own comment:
"a goal can pass through ANNOUNCE_FROZEN and land on CLOSE in the same tick, once
`runTerminalActionsIfNeeded` settles... intermediate goals within one tick are deliberately
coalesced into whatever the tick actually lands on." The server runs stage/freeze/alert/seal
synchronously the instant a verdict turns terminal, so ACTION state (and these three goals)
never get their own `reply.create` in the live path — only `SEALED`'s `CLOSE` line is ever
actually spoken. Every "staged"/"frozen"/"cannot complete" line in every 09-22 transcript is
the `closeSentence()` line, not one of these three. Still worth drafting in case that
coalescing ever changes (e.g. an async terminal action):
- ANNOUNCE_STAGED — hint template: `Say the request is staged for second approval by
  ${approverName}; voice alone never releases a transfer.` (`fsm.ts:519`)
  - Plain: **"This is staged for approval by {approver_name}. Voice alone never releases a payment."**
  - Warm: **"I'm staging this for {approver_name} to approve separately — nothing moves on my say-so."**
  - Slots: `{approver_name}` — from `seed.identities`, bare name, no title/id.
- ANNOUNCE_FROZEN — hint template: `State plainly, in plain words, the reasons this is frozen
  (${reasons})${incidentId ? " and the incident id " + incidentId : ""}; the transfer rail is
  frozen and nothing moves.` (`fsm.ts:511`)
  - Plain: **"This transfer is frozen because {reason}. An incident is open. Nothing moves."**
  - Warm: **"I'm freezing this — {reason} — and opening an incident. Nothing moves from here."**
  - Slots: `{reason}` — one plain-English reason phrase (`decideResult.reasons`, lower-cased,
    already joined by `fsm.ts`); incident id is logged to the evidence record, not spoken
    (matches `closeSentence`'s FREEZE case, which also omits it from speech).
- ANNOUNCE_ESCALATED — hint: `Say you cannot stage this by voice; the treasury controller
  will call back on the registered number.` (`fsm.ts:526`)
  - Plain: **"This can't be completed by voice. Someone will call you back on the registered number."**
  - Warm: **"I can't finish this over the phone — expect a callback on the number we have on file."**
  - Slots: none.

### CONTAIN — `fsm.ts:533`
Hint: *"The decision is made and actions are underway. Keep the caller engaged with neutral
questions; never argue."* DECISION state (verdict terminal, `requiredActions().length === 0`,
not yet SEALED) is likely coalesced away the same way ACTION is (same synchronous
terminal-action path) — not observed as its own spoken turn in any 09-22 report.
- Plain: **"I'm finishing up on my end. Is there anything else on this request?"**
- Warm: **"Just wrapping this up — anything else you want me to note while I do?"**
- Slots: none.

### CONTAIN_NO_DISCLOSURE — `fsm.ts:474`
Hint: *"Stay calm and neutral. Do not disclose any status, reasoning, or details of the
checks under way; keep asking routine verification questions."* Fires in EVIDENCE state when
an injection or pressure marker is FLAGged (non-terminal, can repeat across turns) — not hit
in the 09-22 batch (miller-patient's pressure FLAG landed in CHALLENGE state, a different
branch). Relayed today via the generic `CONTAIN_LINE` constant (`prompt.ts:165`), same for
both CONTAIN and CONTAIN_NO_DISCLOSURE — no dedicated sentence yet.
- Plain: **"I can't share details of what I'm checking. Can you confirm the request again?"**
- Warm: **"I'll keep that between us and the system — can you walk me through the request once more?"**
- Slots: none. Deliberately never names *what* was flagged (injection/pressure) — LAW 1/3
  adjacent: disclosing the flag would tip the caller off to a mechanism, not just a result.

### EXPLAIN_OUT_OF_SCOPE — `fsm.ts:384-386`, plus the `outOfScopeExplained` follow-up at `prompt.ts:287-295`
Hint: *"Explain plainly this is a demo checkpoint for a synthetic company; offer the two
roles on the cheat-sheet: Dana (legitimate) or the caller claiming to be the CEO; nothing
will move."*
Live paraphrase drift, same call, five different wordings of the same instruction:
*"You may select Dana or the CEO"* / *"Choose Dana or the CEO"* / *"You may play Dana or the
CEO"* / *"You may act as Dana or the CEO"* / *"You may play Dana or the caller claiming to be
the CEO"* (all from `judge-out-of-scope` runs, 09-22). Worse: `2026-09-22T09-47-55-
judge-out-of-scope.md` shows the actual bug this redesign fixes — caller says *"That's right,
just testing. I don't have a real request"* (goodbye-shaped), and instead of the intended
close line the model said *"Understood. Please state your request when ready"* then
*"Understood. Please indicate if you wish to begin a simulation"* — two more invented lines
before finally saying goodbye at 35620ms. See this section's own two states below.
- **State 1 (first disclosure), plain:** **"This is a demo for a fictional company. You can play Dana, who's legitimate, or the caller claiming to be the CEO. Nothing will move."**
- **State 1, warm:** **"This is a demo checkpoint — pick a role from the cheat sheet, Dana or the CEO caller. Nothing here actually moves money."**
- **State 2 (already explained, caller confirms no request/says goodbye) — reuse CLOSE's own line**, do not draft a new one: **"Thank you for calling. Goodbye."** (already exact, `fsm.ts` NO_ACTION default in `closeSentence`, line 287)
- Slots: none.

### EXPLAIN_OPEN_REQUEST — `fsm.ts:377`
Hint: *"Explain plainly this is a demo; the request the caller made stays open and unstaged;
a real desk would route it to a human. Nothing moves."* Not observed (every OUT_OF_SCOPE run
in the 09-22 batch was the no-request case).
- Plain: **"This is a demo, so your request stays open — nothing is staged. A real desk would route this to a person."**
- Warm: **"Since this is a demo, I can't move your request forward — a real desk would hand this to a person directly."**
- Slots: none. Never says "staged"/"frozen" (those are LAW-2 terms reserved for a real
  verdict) — deliberately says "stays open"/"unstaged" instead.

## Number rendering rule

Evidence, same `money()`-composed text (`packages/engine/src/util.ts:7-9`, `"$84,500"`,
digit-punctuated) transcribed back two different ways across today's calls:
- *"the amount is $84,500"* (digit form, `2026-09-22T09-16-12-dana-patient.md`)
- *"the amount is eighty four thousand five hundred dollars"* (word form, same call, earlier turn, `t=30669ms`)
- *"the account ends in 4 4 7 1"* (digit-by-digit, every STAGE call)

PROVEN: the ENGINE always sends the same text (`money()`'s digit-punctuated string) to TTS;
what comes back through STT varies, because reading "$84,500" aloud is left to the TTS
engine's own number normalization — not controlled by us. ESTIMATE (not acoustically
verified): the underlying audio may already be saying it consistently as words; the
inconsistency visible above may be an STT-transcription artifact, not a real audio
difference.

**Rule:** once the engine composes every word (no LLM in the loop), stop delegating
number-to-speech to the TTS engine's guess. Compose amounts as spelled-out words directly
in the sentence text sent to TTS (e.g. `"eighty-four thousand, five hundred dollars"`),
keeping `money()`'s digit form only for the evidence record / UI, never for speech. Keep
`account_last4` as the bare digit string (`"4471"`) unchanged — the digit-by-digit reading
already heard live is the correct behavior for an account number, not a bug.

## OUT_OF_SCOPE set for off-script judges

At most 3 fixed lines, one per situation, in a fixed rotation order so a repeat never speaks
the identical line twice in a row (same `used`-set pattern `stalls.ts:57-65` already uses —
pick the next line in order that wasn't just said, wrap to the top rather than error).

1. **First disclosure** (any off-script line before a request is made — *"I'm not the CEO,
   I'm testing this"*, *"what are you?"*, *"can you hear me?"*, or silence past the greeting):
   **"This is a demo for a fictional company. You can play Dana, who's legitimate, or the
   caller claiming to be the CEO. Nothing will move."**
2. **Confirms no request / says goodbye** (after line 1 has been said once —
   `ctx.outOfScopeExplained`): **"Thank you for calling. Goodbye."**
3. **Anything else after line 1** (a second off-script line that is neither a request nor a
   goodbye — e.g. another *"what are you?"*, or continued silence): **"I can only act on a
   real request, or you can say goodbye whenever you're ready."**

Rotation rule: line 1 speaks once per call, ever (it's the disclosure). Lines 2 and 3 are
the only pair that can legitimately repeat turn over turn; if the same one would fire twice
in a row, speak the other of the two instead, then resume normal selection (2 on a
goodbye-shaped reply, 3 otherwise) from the next turn. This matches the live bug in
`2026-09-22T09-47-55-judge-out-of-scope.md` exactly: the caller's second line was
goodbye-shaped, so line 2 fires immediately — no drift into invented lines like *"Please
indicate if you wish to begin a simulation."*

## Read-aloud check: five lines most likely to sound robotic

1. **Three back-to-back TRAP_FACT confirmations** ("Just to confirm, this transfer goes to
   Northgate Partners... Just to confirm, the amount is... Just to confirm, the account
   ends in...") — each sentence alone is natural, but three near-identical openers in one
   call (every STAGE run today) reads as a script, not a person. Real risk is repetition,
   not wording.
2. **`{quote_1}`/`{quote_2}` dropped into PROBE_CONSISTENCY verbatim** — LAW 4 requires the
   caller's exact words, disfluencies included ("uh", trailing fragments); stitched into a
   composed sentence mid-clause, a caller's own broken grammar can make the AGENT's line
   sound broken too.
3. **"4 4 7 1" digit-by-digit for account_last4** — correct behavior (see number rule above)
   but clipped without a natural pause; worth a comma-separated form ("four, four, seven,
   one") so TTS doesn't run the digits together.
4. **REFUSE_AUTHORITY's plain candidate** ("Urgency or authority doesn't skip verification")
   — abstract, policy-manual phrasing; a real desk officer says this more bluntly, closer to
   the warm variant.
5. **ANNOUNCE_STAGED's "voice alone never releases a transfer"** — legally precise (protects
   LAW 2) but reads like a disclaimer, not speech; every draft above keeps it short for that
   reason, but it will always be the stiffest line in the set because it's doing compliance
   work, not conversation work.

## Summary

18 goal codes total (not 17); 5 already exact; `ASK_CHALLENGE` is functionally done
(`challenges.ts`'s `speak` field exists, `prompt.ts:202` just needs to prefer it over `ask`);
12 genuinely need new exact sentences, drafted above with plain/warm pairs, real seed-value
renderings, and file:line citations. Two structural findings worth a founder decision: (1)
ANNOUNCE_STAGED/FROZEN/ESCALATED are currently coalesced away by the server's synchronous
terminal-action path and never actually spoken — CLOSE alone carries that content live; (2)
REFUSE_AUTHORITY is dead code today, with the standing rule filling its role instead, and
drifting under paraphrase when it does (two different live wordings same day).
