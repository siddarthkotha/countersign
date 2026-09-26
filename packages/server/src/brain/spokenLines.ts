// packages/server/src/brain/spokenLines.ts
// ONE-BRAIN LIVE PATH (2026-09-22, engine goal-state -> exact-sentence mapping, docs/plans/
// 2026-09-22-spoken-lines-draft.md). `session.ts`'s `PLACEHOLDER_GOAL_LINES` (~line 134) is
// the ONLY thing `nextSpokenLine()` falls back to today for the 12 `GoalCode`s that don't
// already carry an exact, ready-to-speak sentence in `goal.hint`/`goal.challenge.speak` -- and
// every one of those placeholder lines is deliberately, visibly fake (the `[PLACEHOLDER ...]`
// prefix is the point -- see that constant's own doc comment). `renderGoalLine` below is the
// real replacement: one plain, speakable, desk-officer sentence per code, composed from
// nothing but the `PhrasingGoal` itself -- never an LLM paraphrase (LAW 3), never a value this
// module invents on its own (LAW 4-adjacent: a slot is filled from the goal's own data or the
// line falls back to slot-free wording, never a guess).
//
// Wired (2026-09-22 10:20 PM): `CallSession.nextSpokenLine` renders every non-exact goal code
// through `renderGoalLine`. Its only production caller is brain/endpoint.ts, so this speaks
// only when COUNTERSIGN_BRAIN=endpoint; the legacy prompt path never calls it.
//
// Source data for every line below: docs/plans/2026-09-22-spoken-lines-draft.md's "12 goal
// codes needing sentences drafted from scratch" section (plain candidates, chosen over the
// warm candidates for consistency with the desk's existing terse style -- e.g. READBACK/CLOSE/
// the STALL library are all plain, not warm) and packages/engine/src/fsm.ts's own `phrasingGoal`
// (the exact hint text every regex below matches against, cited by line number inline).
//
// Two structural findings from the draft, both still true here (not this lane's job to fix):
// (1) `EXPLAIN_OUT_OF_SCOPE` always renders the FIRST-disclosure line -- the draft's 3-line
//     judge-off-script ROTATION (first disclosure / goodbye / anything-else) needs session-level
//     state (`ctx.outOfScopeExplained`, tracked in `session.ts`, never on `PhrasingGoal` itself)
//     that a pure `(goal) => string` function structurally cannot see. Wiring that rotation in
//     is the swap-in lane's job, not this one -- `PLACEHOLDER_GOAL_LINES` has exactly the same
//     one-line-per-code shape today, so this keeps parity with what it replaces.
// (2) `REFUSE_AUTHORITY` is dead code in `fsm.ts` today (`grep -rn "REFUSE_AUTHORITY"
//     packages/engine/src` finds only the type declaration) -- no real `goal.hint` ever exists
//     to read a slot from, so its line below is always the fixed fallback.
//
// Pure, dependency-free (besides the real `stalls.ts` STALL library, reused rather than
// duplicated -- see below), no I/O, no Math.random/Date.now anywhere in this file: the same
// `PhrasingGoal` always renders the same string.
import type { GoalCode, PhrasingGoal } from '@countersign/engine';
import { stallLineFor } from '../call/stalls.js';

/** Exactly the key set `PLACEHOLDER_GOAL_LINES` (session.ts ~line 134-151) covers today --
 *  the SAME `Exclude<...>` expression over `GoalCode`, so the two stay TS-enforced in lockstep:
 *  a future `GoalCode` addition (or removal) that isn't reflected in both fails to compile in
 *  both files, never silently drifts in just one. */
type SpokenLineGoalCode = Exclude<
  GoalCode,
  'READBACK' | 'RE_ELICIT_AFTER_SWITCH' | 'ELICIT_MISSING_CRITICAL' | 'ELICIT_REQUEST' | 'CLOSE' | 'ASK_CHALLENGE'
>;

// ---------- slot extraction: regexes over the exact hint templates fsm.ts composes today ----------
// Each of these three goal codes carries its real, non-invented data (an approver name, a
// verdict's reasons, a caller's own two contradicting quotes) baked directly into `goal.hint`'s
// English text -- `PhrasingGoal` has no dedicated field for any of them (confirmed against
// `packages/engine/src/types.ts`'s `PhrasingGoal` interface and `fsm.ts`'s `goal()` call sites).
// Parsing the hint back out is therefore the only way to reuse the engine's own real value
// without inventing one; a hint that doesn't match the expected shape (a future fsm.ts wording
// change, or a hand-built test fixture) falls back to the draft's slot-free wording rather than
// guessing.

// fsm.ts:519 -- `Say the request is staged for second approval by ${approverName}; voice alone
// never releases a transfer.`
const ANNOUNCE_STAGED_HINT_RE = /^Say the request is staged for second approval by (.+); voice alone never releases a transfer\.$/;

// fsm.ts:511 -- `State plainly, in plain words, the reasons this is frozen (${reasons})${...
// incident id...}; the transfer rail is frozen and nothing moves.` `reasons` is
// `decideResult.reasons.join(', ').toLowerCase()` over `VerdictReason` values (e.g.
// `IDENTITY_UNVERIFIED` -> `identity_unverified`) -- underscored, not humanized; this module
// humanizes just the ONE reason it speaks (underscores -> spaces), never inventing a reason not
// already in the engine's own list. The incident id (if present) is deliberately never spoken --
// matches `closeSentence`'s own FREEZE case, which also omits it from speech (draft's own rule).
const ANNOUNCE_FROZEN_HINT_RE =
  /^State plainly, in plain words, the reasons this is frozen \(([^)]*)\)(?: and the incident id \S+)?; the transfer rail is frozen and nothing moves\.$/;

// fsm.ts:446 -- `A moment ago the caller said "${q1.text}"; now "${q2.text}". Ask which is
// correct and why it changed.` `q1`/`q2` are exact STT substrings (LAW 4) -- never trimmed or
// paraphrased here, even when that makes the rendered line run long (the draft's own read-aloud
// check flags this as the riskiest line for naturalness; LAW 4 wins over the word-count target
// for a caller's own long or disfluent quote).
const PROBE_CONSISTENCY_HINT_RE = /^A moment ago the caller said "([\s\S]*)"; now "([\s\S]*)"\. Ask which is correct and why it changed\.$/;

function renderAnnounceStaged(goal: PhrasingGoal): string {
  const approverName = goal.hint.match(ANNOUNCE_STAGED_HINT_RE)?.[1]?.trim();
  return approverName
    ? `This is staged for second approval by ${approverName}. Voice alone never moves a payment.`
    : 'This is staged for a second approval. Voice alone never moves a payment.';
}

function renderAnnounceFrozen(goal: PhrasingGoal): string {
  const reasonsRaw = goal.hint.match(ANNOUNCE_FROZEN_HINT_RE)?.[1]?.trim();
  const firstReason = reasonsRaw ? reasonsRaw.split(',')[0]?.trim().replace(/_/g, ' ') : undefined;
  return firstReason
    ? `This transfer is frozen because ${firstReason}. An incident is open. Nothing moves.`
    : 'This transfer is frozen. An incident is open. Nothing moves.';
}

function renderProbeConsistency(goal: PhrasingGoal): string {
  const match = goal.hint.match(PROBE_CONSISTENCY_HINT_RE);
  const quote1 = match?.[1];
  const quote2 = match?.[2];
  return quote1 && quote2
    ? `A moment ago you said ${quote1}. Just now you said ${quote2}. Which is correct?`
    : 'A moment ago you said something different than just now. Which is correct?';
}

/** STALL reuses the REAL, already-shipped generic-kind holding line from `stalls.ts` (line 1 of
 *  8, `'One moment while that check completes.'`) rather than drafting new copy -- exactly the
 *  draft's own recommendation ("Fix needed: tighten the relay wrapper to match READBACK's, not
 *  new copy"). Always the FIRST generic line: this function is pure (no session `used` state to
 *  read), and `stallLineFor` is itself pure/deterministic given an empty `used` set, so the same
 *  goal always renders the same line, as required. */
function renderStall(): string {
  return stallLineFor('generic', new Set());
}

const RENDERERS: Record<SpokenLineGoalCode, (goal: PhrasingGoal) => string> = {
  // fsm.ts:403 -- no slots.
  GREET: () => "Who's calling, and what do you need today?",
  // fsm.ts:426 -- no slots.
  ELICIT_IDENTITY: () => 'Who am I speaking with, please?',
  // fsm.ts:465/479/536 -- see renderStall's own doc comment.
  STALL: renderStall,
  PROBE_CONSISTENCY: renderProbeConsistency,
  // Dead code in fsm.ts today (see this file's top-of-file doc comment, finding 2) -- always
  // the fixed fallback; there is no real `goal.hint` template to read a slot from.
  REFUSE_AUTHORITY: () => "Urgency or authority doesn't skip verification. I still need to confirm the details.",
  ANNOUNCE_STAGED: renderAnnounceStaged,
  ANNOUNCE_FROZEN: renderAnnounceFrozen,
  // fsm.ts:526 -- no slots.
  ANNOUNCE_ESCALATED: () => "This can't be completed by voice. Someone will call you back on the registered number.",
  // fsm.ts:533 -- no slots.
  CONTAIN: () => "I'm finishing up on my end. Is there anything else on this request?",
  // fsm.ts:474 -- no slots. Deliberately never names what was flagged (injection/pressure) --
  // disclosing the flag would tip the caller off to a mechanism, not just a result.
  CONTAIN_NO_DISCLOSURE: () => "I can't share details of what I'm checking. Can you confirm the request again?",
  // fsm.ts:384-386 -- always the first-disclosure line (see finding 1 above). No slots.
  EXPLAIN_OUT_OF_SCOPE: () =>
    "This is a demo for a fictional company. Play Dana, who's legitimate, or the caller claiming to be the CEO. Nothing will move.",
  // fsm.ts:377 -- no slots. Never says "staged"/"frozen" (LAW-2 terms reserved for a real
  // verdict) -- says "stays open"/"nothing moves" instead, same as the draft's own stated
  // rule (the draft's own PLAIN candidate text actually says "nothing is staged", which
  // contradicts its own rule -- this module follows the rule, not that slip).
  EXPLAIN_OPEN_REQUEST: () => 'This is a demo, so your request stays open. Nothing moves on it. A real desk would route this to a person.',
};

/** The exact next line to speak for `goal.code`, for every `GoalCode` `PLACEHOLDER_GOAL_LINES`
 *  covers today (`null` for the six codes handled elsewhere -- `goal.hint` directly for
 *  READBACK/RE_ELICIT_AFTER_SWITCH/ELICIT_MISSING_CRITICAL/ELICIT_REQUEST/CLOSE,
 *  `goal.challenge.speak` for ASK_CHALLENGE -- see `nextSpokenLine`'s own doc comment,
 *  session.ts ~line 5205). Read-only: never mutates anything, never does I/O, safe to call as
 *  many times as needed. Not wired into `session.ts`/`nextSpokenLine` by this lane -- see this
 *  file's top-of-file doc comment. */
export function renderGoalLine(goal: PhrasingGoal): string | null {
  if (!(goal.code in RENDERERS)) return null;
  return RENDERERS[goal.code as SpokenLineGoalCode](goal);
}

/** SAFETY NET (2026-09-25, founder live defect -- see `CallSession.nextSpokenLine`'s own doc
 *  comment in session.ts for the full incident and why this exists as a defense-in-depth on
 *  TOP of the root-cause engine fix, not instead of it): the one line `nextSpokenLine()` speaks
 *  in place of a challenge question it would otherwise render byte-identical to the agent's own
 *  immediately-preceding turn, with a caller turn in between. Deliberately generic -- names
 *  neither the field nor the expected value (LAW 3: the LLM/server never leaks what answer would
 *  pass) -- and deliberately ends in "?" so `questionMatch.ts`'s own `transcriptAsksQuestion`
 *  bare-"?" branch still recognizes it as asking a real question, so the server still logs a
 *  fresh `challenge_issued` action for this re-ask (LAW 4: the evidence record must reflect what
 *  was actually said) instead of silently dropping it the way an un-asked rendering does. */
export const CHALLENGE_REASK_REWORD_LINE = "I still need an answer to that one -- can you say it a different way?";
