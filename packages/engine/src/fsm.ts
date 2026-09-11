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
}

function goal(code: GoalCode, hint: string, keyterms: string[], patient: boolean, extra?: Partial<PhrasingGoal>): PhrasingGoal {
  return { code, hint, keyterms, turn_detection_hint: patient ? 'patient' : 'default', ...extra };
}

export function phrasingGoal(input: PhrasingGoalInput): PhrasingGoal {
  const { state, decideResult, evidence, ledger, seed, tools, nextChallenge } = input;
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
    return goal('CLOSE', 'Close the call politely; the hash-chained evidence export is complete.', keyterms, patient);
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
      return goal(
        'RE_ELICIT_AFTER_SWITCH',
        'The caller switched who they claim to be mid-call. Re-establish identity and re-elicit the request from scratch; treat everything gathered before the switch as stale.',
        keyterms,
        patient,
      );
    }
    const hasIdentity = evidence.some((e) => e.kind === 'identity_claim');
    return hasIdentity
      ? goal('ELICIT_REQUEST', 'Ask what the caller needs.', keyterms, patient)
      : goal('ELICIT_IDENTITY', 'Ask who is calling.', keyterms, patient);
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
    return goal('ASK_CHALLENGE', nextChallenge?.speak ?? nextChallenge?.ask ?? 'Ask the caller a verification question.', keyterms, patient, {
      ...(nextChallenge ? { challenge: nextChallenge } : {}),
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
