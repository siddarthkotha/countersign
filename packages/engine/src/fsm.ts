// packages/engine/src/fsm.ts
// The state machine: turns a DecideResult (from rules.ts) plus the evidence/ledger/tool
// context into the judge-visible EngineState, the per-state tool allowlist, the terminal
// actions still owed, and the phrasing goal handed to the LLM (never a verdict -- only an
// instruction for HOW to talk within the state the engine already decided). Per v1 Task 5
// text (docs/superpowers/plans/2026-09-01-day1-engine-and-scaffold.md, "### Task 5"),
// extended per amendment-v2-brief.md section A/D for the v2 goals and states.
import type { DecideResult } from './rules';
import { currentClaim } from './ledger';
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
} from './types';

// ---------- allowedTools ----------

const ACTION_ALLOWLIST: Record<'STAGE' | 'FREEZE' | 'ESCALATE', ToolName[]> = {
  STAGE: ['stage_payment_for_second_approval', 'alert_principal', 'seal_evidence_record'],
  FREEZE: ['freeze_transaction_rail', 'open_incident', 'alert_principal', 'seal_evidence_record'],
  ESCALATE: ['open_incident', 'alert_principal', 'seal_evidence_record'],
};

export function allowedTools(state: EngineState, _verdict: Verdict): ToolName[] {
  if (state === 'CHALLENGE') return [];
  if (state === 'EVIDENCE' || state === 'CONSISTENCY_CHECK') {
    return ['get_request_history', 'check_sso_context', 'verify_out_of_band'];
  }
  // Review finding (IMPORTANT 4, final review): ACTION's terminal tools (stage/freeze/
  // incident/alert/seal) are NEVER offered to the LLM -- the server runs them itself the
  // instant a verdict turns terminal (call/session.ts's runTerminalActionsIfNeeded, which
  // never goes through a tool.call at all), before the LLM could ever be handed a live
  // ASSISTANT-callable schema for one. Exposing them here was a standing (harmless in
  // practice, since the server never wired an ACTION-state tool.call through) but wrong-by-
  // design widening of what the voice channel could ever reach -- LAW 2 says voice never
  // releases the wire, and the ceiling for what the LLM is even OFFERED should say the same.
  // `ACTION_ALLOWLIST` below is unchanged and still drives `requiredActions` -- the server's
  // own list of what it must run, not what it hands to the model.
  // INTAKE, CLAIM, DECISION, ACTION, SEALED, OUT_OF_SCOPE: nothing to call.
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
  const done = new Set(tools.filter((t) => t.result !== undefined).map((t) => t.name));
  return ACTION_ALLOWLIST[verdict].filter((name) => !done.has(name));
}

// ---------- deriveState ----------

const CRITICAL_FIELDS: ClaimField[] = ['amount_usd', 'account_last4', 'beneficiary'];

export function deriveState(decideResult: DecideResult, evidence: Evidence[], tools: ToolLogEntry[]): EngineState {
  if (decideResult.verdict === 'NO_ACTION') return 'OUT_OF_SCOPE';
  if (tools.some((t) => t.name === 'seal_evidence_record' && t.result !== undefined)) return 'SEALED';
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

function money(n: number): string {
  return `$${n.toLocaleString('en-US')}`;
}

function oldestUnconfirmedCritical(claims: Claim[]): { field: ClaimField; claim: Claim } | null {
  let best: { field: ClaimField; claim: Claim } | null = null;
  for (const field of CRITICAL_FIELDS) {
    const claim = currentClaim(claims, field);
    if (!claim || claim.kind === 'CONFIRMED') continue;
    if (!best || claim.t_ms < best.claim.t_ms) best = { field, claim };
  }
  return best;
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
    return goal('GREET', 'Greet as Countersign for the Meridian treasury desk; ask who is calling and what they need.', keyterms, patient);
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
      const displayValue = oldest.field === 'amount_usd' ? money(Number(oldest.claim.value)) : oldest.claim.quote.text;
      return goal(
        'READBACK',
        `Read the ${oldest.field.replace('_', ' ')} back to the caller as "${displayValue}" and ask them to confirm it.`,
        keyterms,
        patient,
        { readback: { field: oldest.field, value: displayValue } },
      );
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
    return goal('ASK_CHALLENGE', nextChallenge?.ask ?? 'Ask the caller a verification question.', keyterms, patient, {
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
