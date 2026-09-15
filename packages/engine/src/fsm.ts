// packages/engine/src/fsm.ts
// The state machine: turns a DecideResult (from rules.ts) plus the evidence/ledger/tool
// context into the judge-visible EngineState, the per-state tool allowlist, the terminal
// actions still owed, and the phrasing goal handed to the LLM (never a verdict -- only an
// instruction for HOW to talk within the state the engine already decided). Per v1 Task 5
// text (docs/superpowers/plans/2026-09-01-day1-engine-and-scaffold.md, "### Task 5"),
// extended per amendment-v2-brief.md section A/D for the v2 goals and states.
import type { DecideResult } from './rules.js';
import { currentClaim } from './ledger.js';
import { money } from './util.js';
import type {
  AgentAction,
  Claim,
  ClaimField,
  ChallengeSpec,
  Evidence,
  EngineState,
  GoalCode,
  PhrasingGoal,
  SeedConfig,
  ToolLogEntry,
  ToolName,
  Utterance,
  Verdict,
} from './types.js';

// ---------- allowedTools ----------

const ACTION_ALLOWLIST: Record<'STAGE' | 'FREEZE' | 'ESCALATE', ToolName[]> = {
  STAGE: ['stage_payment_for_second_approval', 'alert_principal', 'seal_evidence_record'],
  FREEZE: ['freeze_transaction_rail', 'open_incident', 'alert_principal', 'seal_evidence_record'],
  ESCALATE: ['open_incident', 'alert_principal', 'seal_evidence_record'],
};

/** The voice model is offered NO tool schema, in ANY state -- always []. Kept as a function
 *  (not inlined as a constant at the call site) because callers still pass `state`/`verdict`
 *  and the shape is part of the engine's public contract (`EngineOutput.allowed_tools`,
 *  read by call/session.ts to build the `tools` field of every session.update).
 *
 *  History, two fixes:
 *
 *  1. Review finding (IMPORTANT 4, final review): ACTION's terminal tools (stage/freeze/
 *     incident/alert/seal) were removed from here first -- the server runs them itself the
 *     instant a verdict turns terminal (call/session.ts's runTerminalActionsIfNeeded, which
 *     never goes through a tool.call at all), before the LLM could ever be handed a live
 *     ASSISTANT-callable schema for one. `ACTION_ALLOWLIST` below is unaffected by either fix
 *     and still drives `requiredActions` -- the server's own list of what IT must run, never
 *     what it hands to the model.
 *
 *  2. Bug fix (2026-09-03, founder-observed live run tonight, see
 *     scripts/rehearse/reports/2026-09-03T23-04-42-scenario-a-dana-legitimate.md): EVIDENCE
 *     and CONSISTENCY_CHECK used to offer get_request_history/check_sso_context/
 *     verify_out_of_band -- each schema carrying a required `identity_id: string` parameter.
 *     On a live run the voice model spoke the required trap-fact challenge, then ADDED
 *     "Please state your identity id" and repeated variants of that on the next two turns --
 *     violating the standing rule "one question at a time" and inventing a system field the
 *     caller can never know, because it had learned that field name straight off the
 *     advertised schema. Since commit 422d750 the server already runs all three lookups
 *     itself the instant EVIDENCE/CONSISTENCY_CHECK is reached (`runLookupsIfNeeded`,
 *     call/session.ts) -- the model never needed to be OFFERED them at all. Both fixes now
 *     read the same way: the ceiling of what the LLM is even offered is zero tools, for
 *     every EngineState, full stop -- LAW 2 (voice never releases the wire) and LAW 3 (only
 *     the engine decides) are both best served by never dangling a tool schema in front of
 *     the voice channel in the first place. `handleToolCall` (call/session.ts) stays as a
 *     defensive path: any stray tool.call the model still emits is rejected as
 *     `not_allowed_in_state` and logged `ignored`, same as always. */
export function allowedTools(_state: EngineState, _verdict: Verdict): ToolName[] {
  return [];
}

// ---------- requiredActions ----------

/** The ACTION allowlist for the verdict, minus tools already present in the log WITH a
 *  result, ordered: freeze/stage first, incident, alert, seal last. Per v1 Task 5 text:
 *  `alert_principal` is always part of a terminal verdict's required actions (staging,
 *  freezing or escalating a case always notifies the principal) -- a pressure flag does
 *  not add a NEW action, it just changes how the agent talks about it (see phrasingGoal). */
export function requiredActions(verdict: Verdict, tools: ToolLogEntry[]): ToolName[] {
  if (verdict !== 'STAGE' && verdict !== 'FREEZE' && verdict !== 'ESCALATE') return [];
  const done = new Set(tools.filter((t) => t.result !== undefined && t.result.error === undefined).map((t) => t.name));
  return ACTION_ALLOWLIST[verdict].filter((name) => !done.has(name));
}

// ---------- deriveState ----------

const CRITICAL_FIELDS: ClaimField[] = ['amount_usd', 'account_last4', 'beneficiary'];

export function deriveState(decideResult: DecideResult, evidence: Evidence[], tools: ToolLogEntry[]): EngineState {
  // NOTE (naming clarification, no state rename): OUT_OF_SCOPE is the terminal state for
  // EVERY NO_ACTION verdict, not only the lexicon-triggered "I'm not the CEO, this is a
  // demo" case (rules.ts rows 1/2). Invariant I4 also produces NO_ACTION for a call that
  // simply goes dead mid-check with no open request (see corpus/hangup-mid-check.json) --
  // there is nothing at stake and no human to route an open request to, so it lands in the
  // same OUT_OF_SCOPE state/goal as an honest off-script judge, even though "out of scope"
  // doesn't literally describe a dropped line. phrasingGoal's OUT_OF_SCOPE branch already
  // handles both shapes (EXPLAIN_OUT_OF_SCOPE vs EXPLAIN_OPEN_REQUEST) via hasRequest.
  if (decideResult.verdict === 'NO_ACTION') return 'OUT_OF_SCOPE';
  if (tools.some((t) => t.name === 'seal_evidence_record' && t.result !== undefined && t.result.error === undefined)) return 'SEALED';
  if (decideResult.verdict === 'STAGE' || decideResult.verdict === 'FREEZE' || decideResult.verdict === 'ESCALATE') {
    return requiredActions(decideResult.verdict, tools).length > 0 ? 'ACTION' : 'DECISION';
  }

  // verdict === 'PENDING'
  const hasIdentity = evidence.some((e) => e.kind === 'identity_claim');
  const hasRequest = evidence.some((e) => e.kind === 'request_params');
  if (!hasIdentity && !hasRequest) return 'INTAKE';
  if (!hasIdentity || !hasRequest) return 'CLAIM';

  switch (decideResult.rule_hit) {
    case 5:
      return 'CONSISTENCY_CHECK'; // reading back an unconfirmed critical field
    case 6:
      return 'CLAIM'; // re-establishing identity/claims after a switch
    case 4:
    case 12:
      return 'CHALLENGE';
    case 7:
    default:
      return 'EVIDENCE';
  }
}

// ---------- phrasingGoal ----------

function oldestUnconfirmedCritical(claims: Claim[]): { field: ClaimField; claim: Claim } | null {
  let best: { field: ClaimField; claim: Claim } | null = null;
  for (const field of CRITICAL_FIELDS) {
    const claim = currentClaim(claims, field);
    if (!claim || claim.kind === 'CONFIRMED') continue;
    if (!best || claim.t_ms < best.claim.t_ms) best = { field, claim };
  }
  return best;
}

/** Bug fix (2026-09-13, PROVEN defect found by an investigation lane, corroborated by
 *  rules.test.ts's now-updated "with neither an unconfirmed critical field nor a
 *  consistency_flag FAIL" case and test/missing-critical-field.test.ts): a caller who never
 *  states one of the three critical fields at all (e.g. never gives an account number) has
 *  NO claim for that field -- `oldestUnconfirmedCritical` above only looks at fields that
 *  HAVE a claim, so it skips a field with no claim at all and returns null. With no
 *  consistency_flag FAIL either, `phrasingGoal`'s CONSISTENCY_CHECK branch used to fall all
 *  the way through to STALL ("Checks are running. Hold the floor") on every turn, with
 *  nothing pending for the server to run: a deadlock (never-deadlock rule, CLAUDE.md LAW 3
 *  / THE RITUALS) -- the live agent says a holding line forever and the call goes silent
 *  until the idle cap. `computeCriticalConfirmed` (compose.ts) requires ALL THREE fields
 *  CONFIRMED, so whenever row 5 (rules.ts) is the reason CONSISTENCY_CHECK was entered,
 *  `critical_confirmed` is false, which means at least one CRITICAL_FIELDS field is either
 *  claimed-but-unconfirmed (caught above by `oldestUnconfirmedCritical`) or missing
 *  entirely (caught here) -- one of the two always fires; the STALL fallback below is kept
 *  only as a defensive default for a hand-built input that doesn't actually reflect that
 *  invariant (as the pre-existing rules.test.ts unit test does). */
function missingCriticalField(claims: Claim[]): ClaimField | null {
  for (const field of CRITICAL_FIELDS) {
    if (!currentClaim(claims, field)) return field;
  }
  return null;
}

/** Plain, speakable, ready-to-say sentence asking for a critical field that was never
 *  stated at all -- same treatment `readbackSentence`/`closeSentence` above already give
 *  READBACK/CLOSE: one exact sentence, never a system field name, so the model has nothing
 *  left to improvise. */
function elicitMissingSentence(field: ClaimField): string {
  switch (field) {
    case 'amount_usd':
      return 'What is the exact amount for this payment?';
    case 'account_last4':
      return 'Which account ending should this go to? Please give me the last four digits.';
    case 'beneficiary':
      return 'Who is the beneficiary of this payment?';
    default:
      return `What is the ${field.replace(/_/g, ' ')} for this payment?`;
  }
}

/** Bug fix (P3, 2026-09-14, PROVEN live defect, rehearsal report
 *  scripts/rehearse/reports/2026-09-14T18-06-55-single-wrong-answer.md): the caller said "I
 *  need to request a wire correction for Meridian Supply, please" with no amount.
 *  `evidenceFromTranscript`'s `request_params` card only ever fires once SOME amount is
 *  found (see its own "request_params (first amount only)" section) -- with identity
 *  claimed but no amount, `deriveState` stays in CLAIM and `phrasingGoal`'s CLAIM branch
 *  used to hand the model the bare instruction "Ask what the caller needs." (same class of
 *  bug READBACK/CLOSE/ELICIT_MISSING_CRITICAL were already fixed for): the model invented
 *  "What is the transaction reference number?" -- a field the caller could never answer --
 *  and the call idled out to NO_ACTION. A request is "recognizable" once the caller has
 *  said a payment-intent word (wire/transfer/payment/correction/refund/invoice/
 *  reimbursement/ach) even with no amount yet; this composes the exact, ready-to-speak
 *  question for the one missing piece (the amount), naming the vendor when one is already
 *  on the ledger (a beneficiary claim can exist with no amount claim -- extractCuedNames
 *  and extractAmounts run independently over the same utterance). With no payment-intent
 *  word at all, the caller hasn't described a request yet, so a plain, still-verbatim
 *  opening question is used instead -- never the old prose instruction. */
const PAYMENT_INTENT_RE = /\b(?:wire|transfer|payment|correction|refund|invoice|reimbursement|ach)\b/i;

function hasPaymentIntent(conversation: Utterance[]): boolean {
  return conversation.some((u) => u.speaker === 'caller' && PAYMENT_INTENT_RE.test(u.text));
}

function elicitRequestSentence(intentStated: boolean, beneficiaryClaim: Claim | null): string {
  if (!intentStated) return 'What do you need today?';
  if (beneficiaryClaim) return `What is the exact amount for this payment to ${beneficiaryClaim.quote.text}?`;
  return 'What is the exact amount you need to send, and to which vendor?';
}

/** Bug fix (2026-09-03 later that night, founder-observed live call + three harness runs --
 *  scripts/rehearse/reports/2026-09-03T23-04-42-, T23-32-42- and T23-39-25-
 *  scenario-a-dana-legitimate.md): the legitimate-caller scenario never reached STAGE. Two
 *  compounding bugs, both fixed here:
 *
 *  1. The READBACK goal used to hand the model only a PROSE instruction ("Read back amount
 *     usd as '$84,500' and ask them to confirm it."), never an exact sentence. Across the
 *     three runs the model improvised past it and invented a different unanswerable demand
 *     each time ("identity id", then "authorization code", then "the purpose of the
 *     transaction") instead of asking a plain confirmable question -- so the caller never
 *     had anything to confirm, and the call sat in CONSISTENCY_CHECK until idle timeout.
 *     `readbackSentence` below composes the exact, ready-to-speak sentence itself (natural
 *     per-field phrasing, `money()` for amount so it reads naturally); it's carried in
 *     `goal.hint` (not a new field on `goal.readback` -- that type lives in types.ts,
 *     outside this fix's file), and prompt.ts's nowSection hands it to the model verbatim
 *     with a "say exactly this and nothing else" instruction, the same treatment STALL's
 *     holding lines already get.
 *
 *  2. A second, independent bug found while fixing the first: `goal.readback.value` is what
 *     call/session.ts's recordGoalCompletionAction copies verbatim into the `readback_issued`
 *     AgentAction, which ledger.ts later re-normalizes (`normalizeValue(field,
 *     pending.action.value)`) to test against the caller's affirm/negate reply. The OLD code
 *     put the DISPLAY string here -- `money()`-formatted for amount_usd (e.g. "$84,500") and
 *     the full extractor-quote match for account_last4 (e.g. "ending 4471", the cue phrase
 *     included, not the bare digits). Both are wrong for this purpose (see normalize.ts):
 *     `normalizeValue('amount_usd', ...)` is a bare `Number(v)` call, and `Number('$84,500')`
 *     is `NaN` (a "$" or a "," is not valid `Number()` input); `normalizeValue('account_last4',
 *     ...)` is `String(v)` with no parsing at all, so "ending 4471" can never equal the
 *     bare-digit claim value "4471" it's compared against. So amount_usd and account_last4
 *     could NEVER be confirmed via the live path, no matter how well the model spoke the
 *     readback and no matter how plainly the caller affirmed it (beneficiary happened to
 *     already work, since its quote IS the bare name and `normalizeText` is idempotent on
 *     it). `value` is now always `String(claim.value)` -- the SAME already-normalized form
 *     the ledger itself stored the claim as -- for every critical field uniformly, matching
 *     the convention every corpus fixture and evaluate.test.ts's hand-authored Scenario A
 *     actions already use (e.g. corpus/scenario-a-dana-legitimate.json's own readback_issued
 *     actions: "84500", "4471", "Meridian Supply" -- never a display string). Corpus replay
 *     is unaffected either way: a corpus file supplies its OWN fixed `actions` array straight
 *     to `evaluate()`/`buildLedger` -- this function's output never feeds back into that.
 *
 *  See fsm.test.ts ("READBACK carries a ready-to-speak exact sentence" and "READBACK closes
 *  the loop") and packages/server/test/session.test.ts's live-driven Scenario A replay for
 *  the regression tests. */
function readbackSentence(field: ClaimField, claim: Claim): string {
  switch (field) {
    case 'amount_usd':
      return `Just to confirm, the amount is ${money(Number(claim.value))}. Is that correct?`;
    case 'account_last4':
      return `Just to confirm, the account ends in ${claim.value}. Is that correct?`;
    case 'beneficiary':
      return `Just to confirm, the beneficiary is ${claim.quote.text}. Is that correct?`;
    default:
      return `Just to confirm, the ${field.replace(/_/g, ' ')} is ${claim.quote.text}. Is that correct?`;
  }
}

/** Bug fix (2026-09-11, PROVEN from scripts/rehearse/reports/2026-09-11T16-35-23-
 *  scenario-a-dana-legitimate.md): the SEALED goal used to hand the model a bare PROSE
 *  instruction ("Close the call politely; the hash-chained evidence export is complete."),
 *  the same class of bug READBACK/ASK_CHALLENGE already had fixed on 2026-09-03 (see
 *  `readbackSentence` above) -- the model filled the gap with three improvised, off-goal
 *  turns ("Please state the authorization code", ...) over 47 seconds before ever saying
 *  something close-shaped. `phrasingGoal`'s SEALED branch now composes the exact,
 *  ready-to-speak close sentence itself, one per outcome, and hands it to prompt.ts's CLOSE
 *  case the same "say exactly this and nothing else" way READBACK's sentence is relayed.
 *  Each sentence is honest (LAW 1: no detection language), names no forbidden word for the
 *  evidence record (LAW 4: never "immutable"/"sealed"/"cryptographically guaranteed" in
 *  speech), and stays under 25 words. `state === 'SEALED'` is only ever reached for a
 *  STAGE/FREEZE/ESCALATE verdict (deriveState checks NO_ACTION first, line 96, and
 *  `requiredActions`/`ACTION_ALLOWLIST` only ever add `seal_evidence_record` for those three
 *  -- see this task's report for why NO_ACTION's own close line, kept below for
 *  completeness and for whichever future lane wires OUT_OF_SCOPE's own close, is never
 *  actually selected via this branch today). */
function closeSentence(verdict: Verdict): string {
  switch (verdict) {
    case 'STAGE':
      return 'Your request is staged for a second, independent approval. Nothing has been released. The evidence record is complete. Goodbye.';
    case 'FREEZE':
      return 'This transfer is frozen and an incident has been opened for review. Nothing has moved. Goodbye.';
    case 'ESCALATE':
      return 'This cannot be completed by voice. A callback on the registered number will follow. Goodbye.';
    default:
      return 'Thank you for calling. Goodbye.';
  }
}

/** seed keyterms + every proper noun/amount the caller has stated, fed to `session.update`
 *  as listening vocabulary. For an amount, BOTH forms go in -- the caller's verbatim quote
 *  (e.g. "$1.8 million" or "one point eight million") and the normalized display string
 *  (e.g. "$1,800,000") -- since either could be what the speech recognizer needs boosted
 *  (review finding, fix round 1: the normalized string alone dropped the spoken form).
 *  Also pulls in every evidence quote (e.g. a knowledge-challenge card's captured reply),
 *  since a caller-said proper noun doesn't always become a ledger claim (no cue pattern
 *  matched it) but was still said on the call and is still worth boosting. */
function buildKeyterms(seed: SeedConfig, claims: Claim[], evidence: Evidence[]): string[] {
  const names = new Set<string>(seed.keyterms);
  for (const c of claims) {
    if (c.field === 'amount_usd') {
      names.add(money(Number(c.value)));
      names.add(c.quote.text);
    } else if (typeof c.value === 'string' && c.value.length > 0) {
      names.add(c.quote.text);
    }
  }
  for (const e of evidence) {
    for (const q of e.quotes) {
      if (q.text.trim().length > 0) names.add(q.text);
    }
  }
  return [...names];
}

export interface PhrasingGoalInput {
  state: EngineState;
  decideResult: DecideResult;
  evidence: Evidence[];
  ledger: Claim[];
  seed: SeedConfig;
  tools: ToolLogEntry[];
  actions: AgentAction[];
  nextChallenge: ChallengeSpec | null; // precomputed by evaluate.ts via selectChallenge
  // P3 fix (2026-09-14): the CLAIM/ELICIT_REQUEST branch needs the raw caller utterances to
  // detect a stated-but-incomplete request (payment intent with no amount yet) -- see
  // `hasPaymentIntent`/`elicitRequestSentence` above. Nothing else in this file reads it.
  // Optional (defaults to []) so every pre-existing hand-built PhrasingGoalInput in the test
  // suite -- none of which exercise the CLAIM branch -- keeps compiling unchanged.
  conversation?: Utterance[];
}

function goal(code: GoalCode, hint: string, keyterms: string[], patient: boolean, extra?: Partial<PhrasingGoal>): PhrasingGoal {
  return { code, hint, keyterms, turn_detection_hint: patient ? 'patient' : 'default', ...extra };
}

/** FIX (2026-09-15, fragment-shaped challenges, PROVEN live defect -- bundle
 *  scripts/rehearse/reports/2026-09-15T08-56-33-miller-silent-after-amount.diagnostics.json):
 *  the most-recently-issued challenge's own spec, ONLY when it is still genuinely AWAITING a
 *  caller reply -- i.e. `challenges.ts`'s `gradeChallenges` has not yet written a
 *  `knowledge_check_result` evidence card for it (that function deliberately omits one while
 *  a non-answer-shaped reply is still under `seed.thresholds.max_challenge_reasks` -- see its
 *  own doc comment). `selectChallenge` (challenges.ts) intentionally does NOT track this
 *  itself (its own doc comment explains why: too many existing unit tests call it directly
 *  with a hand-built `issued` history and pass `results: {}` to mean "selection order only,
 *  I don't care about grading" -- baking an awaiting-check into that function broke ~30 of
 *  them). So the CHALLENGE branch below asks here FIRST, and falls back to
 *  `nextChallenge` (`selectChallenge`'s own pick) only when nothing is awaiting -- keeping
 *  the caller on the SAME question (same `challenge_id`, same `speak`) across AssemblyAI
 *  endpointing splitting one scripted line into multiple `transcript.user` turns, instead of
 *  racing ahead to a different one the instant any caller utterance (fragment or not) lands.
 *
 *  Requires the action's own recorded `spec` (real server calls always set this --
 *  call/session.ts's `recordGoalCompletionAction` writes `spec: goal.challenge` on every
 *  `challenge_issued` action); a hand-built action with no recorded spec has nothing to
 *  re-ask verbatim and falls through to `nextChallenge` like before this fix. */
function awaitingChallenge(actions: AgentAction[], evidence: Evidence[]): ChallengeSpec | null {
  const lastIssued = actions
    .filter((a): a is AgentAction & { challenge_id: string } => a.kind === 'challenge_issued' && a.challenge_id !== undefined)
    .reduce<(AgentAction & { challenge_id: string }) | null>((latest, a) => (!latest || a.t_ms > latest.t_ms ? a : latest), null);
  if (!lastIssued || !lastIssued.spec) return null;
  const hasCard = evidence.some((e) => e.id === `ev-knowledge-${lastIssued.challenge_id}`);
  return hasCard ? null : lastIssued.spec;
}

export function phrasingGoal(input: PhrasingGoalInput): PhrasingGoal {
  const { state, decideResult, evidence, ledger, seed, tools, actions, nextChallenge, conversation = [] } = input;
  const keyterms = buildKeyterms(seed, ledger, evidence);
  const patient = state === 'CHALLENGE' || (state === 'CONSISTENCY_CHECK' && decideResult.rule_hit === 5);

  if (state === 'OUT_OF_SCOPE') {
    const hasRequest = evidence.some((e) => e.kind === 'request_params');
    if (hasRequest) {
      return goal(
        'EXPLAIN_OPEN_REQUEST',
        'Explain plainly this is a demo; the request the caller made stays open and unstaged; a real desk would route it to a human. Nothing moves.',
        keyterms,
        patient,
      );
    }
    return goal(
      'EXPLAIN_OUT_OF_SCOPE',
      'Explain plainly this is a demo checkpoint for a synthetic company; offer the two roles on the cheat-sheet: Dana (legitimate) or the caller claiming to be the CEO; nothing will move.',
      keyterms,
      patient,
    );
  }

  if (state === 'SEALED') {
    return goal('CLOSE', closeSentence(decideResult.verdict), keyterms, patient);
  }

  if (state === 'INTAKE') {
    // Fix (2026-09-11, composes with the sibling AAI-greeting lane, commit e200f20): the
    // fixed connect-time audio greeting (AssemblyAI's `greeting` field, "Meridian payments
    // desk, verification line. How can I help you today?") now speaks the desk name BEFORE
    // this goal is ever rendered, so GREET must not name the desk or greet again -- it only
    // asks the one open question. Kept as goal kind 'GREET' (stalls.ts's kindFromHint and
    // anything else that keys off the goal code are unaffected; only the hint text changed).
    return goal(
      'GREET',
      'The desk has already greeted the caller; do not greet again or name the desk. Ask who is calling and what they need, in one short line.',
      keyterms,
      patient,
    );
  }

  if (state === 'CLAIM') {
    if (decideResult.rule_hit === 6) {
      // Bug fix (2026-09-11, live identity-switch rehearsal, see
      // scratchpad/identity-switch-investigation.md section 3): this used to be bare prose
      // with no dedicated prompt.ts case, so the model filled the gap by demanding "the four
      // digit account ending" four times -- violating STANDING_RULES's own "never ask the
      // caller for identifiers, ids, codes, or system fields" line. Same fix pattern as
      // READBACK/CLOSE (`readbackSentence`/`closeSentence` above): one exact, ready-to-speak
      // sentence, plain English, asking for nothing but a name and a request.
      return goal(
        'RE_ELICIT_AFTER_SWITCH',
        'I heard a different name than the one this call started with. Please tell me again who is calling and what you need.',
        keyterms,
        patient,
      );
    }
    const hasIdentity = evidence.some((e) => e.kind === 'identity_claim');
    if (!hasIdentity) return goal('ELICIT_IDENTITY', 'Ask who is calling.', keyterms, patient);
    // P3 fix (see `elicitRequestSentence` above): a recognizable-but-incomplete request
    // (payment intent stated, no amount yet) gets an exact, ready-to-speak question naming
    // the one missing piece, never the old open-ended "Ask what the caller needs." prose.
    const beneficiaryClaim = currentClaim(ledger, 'beneficiary');
    return goal('ELICIT_REQUEST', elicitRequestSentence(hasPaymentIntent(conversation), beneficiaryClaim), keyterms, patient);
  }

  if (state === 'CONSISTENCY_CHECK') {
    const oldest = oldestUnconfirmedCritical(ledger);
    if (oldest) {
      return goal('READBACK', readbackSentence(oldest.field, oldest.claim), keyterms, patient, {
        readback: { field: oldest.field, value: String(oldest.claim.value) },
      });
    }
    const flag = evidence.find((e) => e.kind === 'consistency_flag' && e.status === 'FAIL');
    if (flag && flag.quotes.length >= 2) {
      const [q1, q2] = flag.quotes;
      return goal(
        'PROBE_CONSISTENCY',
        `A moment ago the caller said "${q1!.text}"; now "${q2!.text}". Ask which is correct and why it changed.`,
        keyterms,
        patient,
      );
    }
    // Bug fix (2026-09-13, see `missingCriticalField`'s doc comment above): a critical
    // field with no claim at all -- never caught by `oldestUnconfirmedCritical` -- gets
    // asked for directly instead of falling through to STALL. Checked after the
    // consistency_flag FAIL branch above: a live contradiction on a non-critical field
    // (e.g. a corrected deadline) is worth surfacing to the caller even while a critical
    // field also happens to be unclaimed.
    const missing = missingCriticalField(ledger);
    if (missing) {
      // Important 2 (review of this commit, 2026-09-13): carries `elicit: { field: missing }`
      // so call/session.ts's recordGoalCompletionAction can log an `elicit_issued` action
      // naming the field -- the same data channel `readback` already gives READBACK, folded
      // into the same re-ask cap (compose.ts's computeReadbackReaskExhausted).
      return goal('ELICIT_MISSING_CRITICAL', elicitMissingSentence(missing), keyterms, patient, { elicit: { field: missing } });
    }
    return goal('STALL', 'Checks are running. Hold the floor with one short neutral line; do not promise an outcome.', keyterms, patient);
  }

  if (state === 'EVIDENCE') {
    const injection = evidence.some((e) => e.kind === 'injection_marker' && e.status === 'FLAG');
    const pressure = evidence.find((e) => e.kind === 'pressure_marker')?.status === 'FLAG';
    if (injection || pressure) {
      return goal(
        'CONTAIN_NO_DISCLOSURE',
        'Stay calm and neutral. Do not disclose any status, reasoning, or details of the checks under way; keep asking routine verification questions.',
        keyterms,
        patient,
      );
    }
    return goal('STALL', 'Checks are running. Hold the floor with one short neutral line; do not promise an outcome.', keyterms, patient);
  }

  if (state === 'CHALLENGE') {
    // CHALLENGE-SPEAKABLE (2026-09-11): `nextChallenge.speak` (challenges.ts's
    // selectLiveCommitment/selectTrapFact/selectRelational/selectSeedFact) is the engine-
    // composed, ready-to-speak sentence for this challenge -- same treatment
    // `readbackSentence` above already gives READBACK. Prefer it over the older `ask`
    // instruction-string when present; `ask` is kept as the fallback (for any spec that
    // predates this field, e.g. a hand-authored test fixture or a replayed corpus action)
    // and untouched everywhere else it's used (evidence-label building in compose.ts).
    // NOT yet wired into the live voice prompt: `goal.challenge` (below) still carries the
    // full spec including `ask`, and packages/server/src/call/prompt.ts's ASK_CHALLENGE
    // case still reads `goal.challenge.ask` and tells the model to paraphrase it, not
    // `goal.hint`/`goal.challenge.speak` verbatim -- flipping that is a separate, deliberately
    // un-taken step (see this task's report and prompt.ts's "Parked follow-up" comment).
    //
    // FIX (2026-09-15, fragment-shaped challenges): re-ask the SAME challenge, verbatim,
    // while it is still genuinely AWAITING a caller reply -- see `awaitingChallenge`'s doc
    // comment above for why this check lives here rather than in `selectChallenge`.
    const challenge = awaitingChallenge(actions, evidence) ?? nextChallenge;
    return goal('ASK_CHALLENGE', challenge?.speak ?? challenge?.ask ?? 'Ask the caller a verification question.', keyterms, patient, {
      ...(challenge ? { challenge } : {}),
    });
  }

  if (state === 'ACTION') {
    if (decideResult.verdict === 'FREEZE') {
      const incident = tools.find((t) => t.name === 'open_incident' && t.result)?.result;
      const incidentId = incident ? String(incident.incident_id ?? '') : null;
      return goal(
        'ANNOUNCE_FROZEN',
        `State plainly, in plain words, the reasons this is frozen (${decideResult.reasons.join(', ').toLowerCase()})${incidentId ? ` and the incident id ${incidentId}` : ''}; the transfer rail is frozen and nothing moves.`,
        keyterms,
        patient,
      );
    }
    if (decideResult.verdict === 'STAGE') {
      return goal(
        'ANNOUNCE_STAGED',
        `Say the request is staged for second approval by ${seed.identities.find((i) => i.id === seed.second_approver_id)?.name ?? 'the second approver'}; voice alone never releases a transfer.`,
        keyterms,
        patient,
      );
    }
    return goal(
      'ANNOUNCE_ESCALATED',
      'Say you cannot stage this by voice; the treasury controller will call back on the registered number.',
      keyterms,
      patient,
    );
  }

  if (state === 'DECISION') {
    return goal('CONTAIN', 'The decision is made and actions are underway. Keep the caller engaged with neutral questions; never argue.', keyterms, patient);
  }

  return goal('STALL', 'Hold the floor briefly with one neutral line.', keyterms, patient);
}
