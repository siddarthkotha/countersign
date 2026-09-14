// packages/engine/test/missing-critical-field.test.ts
// PROVEN defect (found 2026-09-13 by an investigation lane, corroborated by
// rules.test.ts's now-updated "with neither an unconfirmed critical field nor a
// consistency_flag FAIL" case, evaluate.test.ts's Scenario A fixtures for the
// conversation/actions shape): a legitimate caller who never states one of the three
// critical fields (amount_usd / account_last4 / beneficiary) at all -- e.g. never gives an
// account number -- has NO claim for that field. `oldestUnconfirmedCritical` (fsm.ts) only
// looks at fields that HAVE a claim, so it skips a field with no claim and returns null;
// with no consistency_flag FAIL either, CONSISTENCY_CHECK fell through to STALL ("Checks
// are running. Hold the floor") on every turn, with nothing pending for the server to run.
// A live agent given that goal says a holding line and the call goes silent until the idle
// cap -- a deadlock, violating the FSM's never-deadlock rule (CLAUDE.md LAW 3 / THE
// RITUALS).
//
// Three cases below drive the REAL `evaluate()` (Dana Whitfield, seed/meridian.ts) with one
// critical field never stated: missing account_last4, missing beneficiary, and (as a direct
// phrasingGoal unit test -- see that case's own comment for why the full evaluate()
// pipeline can't produce it) missing amount_usd. A fourth case is the control: all three
// fields confirmed still reaches STAGE, unchanged.
import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/evaluate';
import { phrasingGoal } from '../src/fsm';
import { mockToolResult } from '../src/mock/backend';
import { MERIDIAN } from '../src/seed/meridian';
import type { AgentAction, CallContext, EngineInput, ToolLogEntry, Utterance } from '../src/types';

const ctxTool = { evidence_count: 0, incident_index: 0 };

function tool(name: ToolLogEntry['name'], id: string, t_ms: number, identity_id: string, request_version: number): ToolLogEntry {
  const args = { identity_id, request_version };
  return { id, name, t_ms, args, result: mockToolResult(name, args, MERIDIAN, ctxTool) };
}

// The counsel-of-record challenge, verbatim from evaluate.test.ts's Scenario A fixture --
// need floors at 1 (ruling A, 2026-09-09), so a passed knowledge card is required to clear
// row 4 before row 5 (the readback/elicit gate) is ever reached.
const counselChallenge: AgentAction = {
  id: 'ch1',
  kind: 'challenge_issued',
  t_ms: 1200,
  challenge_id: 'sess-a-1',
  spec: {
    challenge_id: 'sess-a-1',
    kind: 'SEED_FACT',
    field: 'counsel',
    ask: 'Ask which law firm is our counsel of record on the Hartwell deal.',
    expect: { accept_tokens: ['calder', 'finch'] },
    fact_id: 'counsel_of_record',
  },
};

const danaCall: CallContext = { session_id: 'sess-a', origin_kind: 'registered_device', origin_geo: 'Austin, TX' };

describe('CONSISTENCY_CHECK never STALLs on a critical field with no claim at all', () => {
  it('missing account_last4: never claimed, amount and beneficiary confirmed by readback -> not STALL, asks for the account', () => {
    const conversation: Utterance[] = [
      {
        id: 'c1',
        speaker: 'caller',
        text: 'This is Dana Whitfield, corporate treasury. I need to wire it to Meridian Supply — $84,500 — moving today instead of Friday, approved in yesterday\'s close meeting.',
        t_ms: 1000,
      },
      { id: 'c1a', speaker: 'caller', text: 'Calder Finch, like always.', t_ms: 1500 },
      { id: 'a1', speaker: 'agent', text: 'To confirm: $84,500 to Meridian Supply. Is that right?', t_ms: 2000 },
      { id: 'c2', speaker: 'caller', text: "Yes, that's right.", t_ms: 2500 },
      { id: 'a2', speaker: 'agent', text: 'And Meridian Supply is the beneficiary, correct?', t_ms: 3000 },
      { id: 'c3', speaker: 'caller', text: "Yes, that's right.", t_ms: 3500 },
    ];
    const actions: AgentAction[] = [
      counselChallenge,
      { id: 'r1', kind: 'readback_issued', t_ms: 2000, field: 'amount_usd', value: '84500' },
      { id: 'r2', kind: 'readback_issued', t_ms: 3000, field: 'beneficiary', value: 'Meridian Supply' },
    ];
    const input: EngineInput = { conversation, tools: [], actions, call: danaCall, seed: MERIDIAN };
    const out = evaluate(input);

    // Never claimed at all -- proves the field really is absent from the ledger, not just
    // unconfirmed.
    expect(out.ledger.some((c) => c.field === 'account_last4')).toBe(false);
    expect(out.assurance.critical_fields_confirmed).toBe(false);
    expect(out.state).toBe('CONSISTENCY_CHECK');
    expect(out.goal.code).toBe('ELICIT_MISSING_CRITICAL');
    expect(out.goal.hint.toLowerCase()).toContain('account');
  });

  // Important 2 (review of commit 5930450, 2026-09-13): the readback re-ask cap (founder
  // decision 2026-09-12 9:00 AM, rules.ts row 13 / compose.ts's
  // computeReadbackReaskExhausted) only ever counted `readback_issued` actions --
  // ELICIT_MISSING_CRITICAL completions were never logged as anything, so a caller who
  // never states a critical field at all got re-asked forever with no escalation. Fixed by
  // logging an `elicit_issued` action (call/session.ts's recordGoalCompletionAction) on
  // every ELICIT_MISSING_CRITICAL completion and folding its count into the same
  // per-field cap `computeReadbackReaskExhausted` already enforces for readbacks.
  describe('ELICIT_MISSING_CRITICAL re-ask cap folds into the same row 13 escalation as an unconfirmed readback', () => {
    const CAP = MERIDIAN.thresholds.max_readback_reasks; // 3

    function elicitAction(id: string, t_ms: number): AgentAction {
      return { id, kind: 'elicit_issued', t_ms, field: 'account_last4' };
    }

    // Same conversation as "missing account_last4" above, on repeat: the caller never once
    // states an account number, no matter how many times the agent asks.
    const conversation: Utterance[] = [
      {
        id: 'c1',
        speaker: 'caller',
        text: 'This is Dana Whitfield, corporate treasury. I need to wire it to Meridian Supply — $84,500 — moving today instead of Friday, approved in yesterday\'s close meeting.',
        t_ms: 1000,
      },
      { id: 'c1a', speaker: 'caller', text: 'Calder Finch, like always.', t_ms: 1500 },
      { id: 'a1', speaker: 'agent', text: 'To confirm: $84,500 to Meridian Supply. Is that right?', t_ms: 2000 },
      { id: 'c2', speaker: 'caller', text: "Yes, that's right.", t_ms: 2500 },
      { id: 'a2', speaker: 'agent', text: 'And Meridian Supply is the beneficiary, correct?', t_ms: 3000 },
      { id: 'c3', speaker: 'caller', text: "Yes, that's right.", t_ms: 3500 },
    ];

    // Same three live-check tool results the "control" test above uses -- without them
    // ssoEv/oobEv/contextEv all read PENDING/absent and row 7 holds PENDING regardless of
    // the re-ask cap, the same way row 5 would; these prove the cap firing specifically,
    // not a live-check gap.
    const tools: ToolLogEntry[] = [
      tool('check_sso_context', 't1', 1500, 'dana-whitfield', 1),
      tool('get_request_history', 't2', 1500, 'dana-whitfield', 1),
      tool('verify_out_of_band', 't3', 1600, 'dana-whitfield', 1),
    ];

    it(`${CAP} logged elicit_issued actions for the missing field -> ESCALATE, naming READBACK_LIMIT_EXCEEDED`, () => {
      const actions: AgentAction[] = [
        counselChallenge,
        { id: 'r1', kind: 'readback_issued', t_ms: 2000, field: 'amount_usd', value: '84500' },
        { id: 'r2', kind: 'readback_issued', t_ms: 3000, field: 'beneficiary', value: 'Meridian Supply' },
        ...Array.from({ length: CAP }, (_, i) => elicitAction(`e${i}`, 4000 + i * 1000)),
      ];
      const input: EngineInput = { conversation, tools, actions, call: danaCall, seed: MERIDIAN };
      const out = evaluate(input);

      expect(out.verdict).toBe('ESCALATE');
      expect(out.reasons).toContain('READBACK_LIMIT_EXCEEDED');
    });

    it(`${CAP - 1} logged elicit_issued actions (one below the cap) -> still eliciting, not yet escalated`, () => {
      const actions: AgentAction[] = [
        counselChallenge,
        { id: 'r1', kind: 'readback_issued', t_ms: 2000, field: 'amount_usd', value: '84500' },
        { id: 'r2', kind: 'readback_issued', t_ms: 3000, field: 'beneficiary', value: 'Meridian Supply' },
        ...Array.from({ length: CAP - 1 }, (_, i) => elicitAction(`e${i}`, 4000 + i * 1000)),
      ];
      const input: EngineInput = { conversation, tools: [], actions, call: danaCall, seed: MERIDIAN };
      const out = evaluate(input);

      expect(out.verdict).toBe('PENDING');
      expect(out.state).toBe('CONSISTENCY_CHECK');
      expect(out.goal.code).toBe('ELICIT_MISSING_CRITICAL');
    });
  });

  it('missing beneficiary: never claimed, amount and account confirmed by readback -> not STALL, asks for the beneficiary', () => {
    const conversation: Utterance[] = [
      {
        id: 'c1',
        speaker: 'caller',
        text: "This is Dana Whitfield, corporate treasury. I need to wire $84,500 today instead of Friday, account ending 4471, approved in yesterday's close meeting.",
        t_ms: 1000,
      },
      { id: 'c1a', speaker: 'caller', text: 'Calder Finch, like always.', t_ms: 1500 },
      { id: 'a1', speaker: 'agent', text: 'To confirm: $84,500, account ending 4471. Is that right?', t_ms: 2000 },
      { id: 'c2', speaker: 'caller', text: "Yes, that's right.", t_ms: 2500 },
      { id: 'a2', speaker: 'agent', text: 'And the account ending 4471, correct?', t_ms: 3000 },
      { id: 'c3', speaker: 'caller', text: 'Yes, correct.', t_ms: 3500 },
    ];
    const actions: AgentAction[] = [
      counselChallenge,
      { id: 'r1', kind: 'readback_issued', t_ms: 2000, field: 'amount_usd', value: '84500' },
      { id: 'r2', kind: 'readback_issued', t_ms: 3000, field: 'account_last4', value: '4471' },
    ];
    const input: EngineInput = { conversation, tools: [], actions, call: danaCall, seed: MERIDIAN };
    const out = evaluate(input);

    expect(out.ledger.some((c) => c.field === 'beneficiary')).toBe(false);
    expect(out.assurance.critical_fields_confirmed).toBe(false);
    expect(out.state).toBe('CONSISTENCY_CHECK');
    expect(out.goal.code).toBe('ELICIT_MISSING_CRITICAL');
    expect(out.goal.hint.toLowerCase()).toContain('beneficiary');
  });

  // Missing amount_usd cannot be driven through the real `evaluate()` pipeline at all: the
  // engine only ever builds `request_params` evidence (evidence/fromTranscript.ts,
  // "---- request_params (first amount only) ----") when SOME amount is found in the
  // transcript -- the same `extractAmounts` call ledger.ts uses to create the amount_usd
  // CLAIM in the first place. So a caller who never states an amount never gets
  // `request_params` evidence either, and `deriveState` (fsm.ts) never leaves CLAIM
  // (`hasRequest` stays false) -- it keeps asking ELICIT_REQUEST (see fsm.ts's
  // `elicitRequestSentence`, fixed 2026-09-14 for the P3 defect: an exact elicit-the-amount
  // question once a payment intent is recognizable, "What do you need today?" otherwise --
  // no longer the bare "Ask what the caller needs." prose this comment used to name), which
  // was never the STALL deadlock this defect describes. This is a direct
  // unit test of `phrasingGoal`'s CONSISTENCY_CHECK branch instead (the same pattern
  // rules.test.ts's "phrasingGoal (fsm.ts) -- CONSISTENCY_CHECK sub-branches" describe block
  // already uses), to prove the fix itself is field-agnostic and also covers amount_usd.
  it('missing amount_usd (direct phrasingGoal unit test -- see comment above for why evaluate() cannot reach this): not STALL, asks for the amount', () => {
    const decideResult = {
      verdict: 'PENDING' as const,
      reasons: [],
      failure_tally: 0,
      assurance: {
        identity_claimed: true,
        sso_pass_current: true,
        oob_confirmed_current: true,
        context_pass_current: true,
        no_contradictions: true,
        critical_fields_confirmed: false,
        exposure_within_limit: true,
        challenge_requirement_met: true,
        no_identity_switch: true,
        not_new_beneficiary: true,
        at_least_one_challenge_passed: true,
        no_injection_attempt: true,
      },
      invariants_ok: true,
      rule_hit: 5,
    };
    const goal = phrasingGoal({
      state: 'CONSISTENCY_CHECK',
      decideResult,
      evidence: [],
      // account_last4 and beneficiary CONFIRMED; amount_usd has no claim at all.
      ledger: [
        {
          id: 'claim-account',
          field: 'account_last4',
          value: '4471',
          kind: 'CONFIRMED',
          t_ms: 3000,
          quote: { utterance_id: 'c1', text: 'ending 4471' },
          request_version: 1,
        },
        {
          id: 'claim-beneficiary',
          field: 'beneficiary',
          value: 'Meridian Supply',
          kind: 'CONFIRMED',
          t_ms: 4000,
          quote: { utterance_id: 'c1', text: 'Meridian Supply' },
          request_version: 1,
        },
      ],
      seed: MERIDIAN,
      tools: [],
      actions: [],
      nextChallenge: null,
    });
    expect(goal.code).not.toBe('STALL');
    expect(goal.hint.toLowerCase()).toContain('amount');
  });

  it('control: all three critical fields confirmed still reaches STAGE (unchanged)', () => {
    const conversation: Utterance[] = [
      {
        id: 'c1',
        speaker: 'caller',
        text: "This is Dana Whitfield, corporate treasury. I need to wire it to Meridian Supply — $84,500, account ending 4471 — moving today instead of Friday, approved in yesterday's close meeting.",
        t_ms: 1000,
      },
      { id: 'c1a', speaker: 'caller', text: 'Calder Finch, like always.', t_ms: 1500 },
      { id: 'a1', speaker: 'agent', text: 'To confirm: $84,500 to Meridian Supply, account ending 4471. Is that right?', t_ms: 2000 },
      { id: 'c2', speaker: 'caller', text: "Yes, that's right.", t_ms: 2500 },
      { id: 'a2', speaker: 'agent', text: 'And the account ending 4471, correct?', t_ms: 3000 },
      { id: 'c3', speaker: 'caller', text: 'Yes, correct.', t_ms: 3500 },
      { id: 'a3', speaker: 'agent', text: 'And Meridian Supply is the beneficiary, correct?', t_ms: 4000 },
      { id: 'c4', speaker: 'caller', text: "Yes, that's right.", t_ms: 4500 },
    ];
    const actions: AgentAction[] = [
      counselChallenge,
      { id: 'r1', kind: 'readback_issued', t_ms: 2000, field: 'amount_usd', value: '84500' },
      { id: 'r2', kind: 'readback_issued', t_ms: 3000, field: 'account_last4', value: '4471' },
      { id: 'r3', kind: 'readback_issued', t_ms: 4000, field: 'beneficiary', value: 'Meridian Supply' },
    ];
    const tools: ToolLogEntry[] = [
      tool('check_sso_context', 't1', 1500, 'dana-whitfield', 1),
      tool('get_request_history', 't2', 1500, 'dana-whitfield', 1),
      tool('verify_out_of_band', 't3', 1600, 'dana-whitfield', 1),
    ];
    const input: EngineInput = { conversation, tools, actions, call: danaCall, seed: MERIDIAN };
    const out = evaluate(input);

    expect(out.verdict).toBe('STAGE');
    expect(out.assurance.critical_fields_confirmed).toBe(true);
  });
});

// P3 (2026-09-14, PROVEN live defect, rehearsal report
// scripts/rehearse/reports/2026-09-14T18-06-55-single-wrong-answer.md): the caller said "I
// need to request a wire correction for Meridian Supply, please" -- a recognizable request
// (payment-intent word "correction"/"wire", a named vendor) with no amount. The old
// ELICIT_REQUEST goal was the bare instruction "Ask what the caller needs.", so the model
// improvised "What is the transaction reference number?" -- a field the caller could never
// answer -- and the call idled out to NO_ACTION. fsm.ts's `elicitRequestSentence` now
// composes an exact, ready-to-speak amount-elicit question instead. Driven through the REAL
// `evaluate()` (LAW 3: never a copy of the engine).
describe('ELICIT_REQUEST composes an exact, ready-to-speak sentence for a recognizable-but-incomplete request (P3 fix)', () => {
  it('vendor named, no amount -> verbatim goal asks for the amount and names the vendor', () => {
    const conversation: Utterance[] = [
      {
        id: 'c1',
        speaker: 'caller',
        text: 'Hi, this is Dana Whitfield from Corporate Treasury. I need to request a wire correction for Meridian Supply, please.',
        t_ms: 1000,
      },
    ];
    const input: EngineInput = { conversation, tools: [], actions: [], call: danaCall, seed: MERIDIAN };
    const out = evaluate(input);

    expect(out.state).toBe('CLAIM');
    expect(out.goal.code).toBe('ELICIT_REQUEST');
    // A ready-to-speak question a caller can actually answer -- never "transaction
    // reference number" or any other invented system field.
    expect(out.goal.hint).toBe('What is the exact amount you need to send, and to which vendor?');
    expect(out.goal.hint.toLowerCase()).not.toContain('transaction reference');
  });

  it('no payment intent at all yet -> the plain opening question, not the old prose instruction', () => {
    const conversation: Utterance[] = [
      { id: 'c1', speaker: 'caller', text: 'Hi, this is Dana Whitfield from Corporate Treasury.', t_ms: 1000 },
    ];
    const input: EngineInput = { conversation, tools: [], actions: [], call: danaCall, seed: MERIDIAN };
    const out = evaluate(input);

    expect(out.state).toBe('CLAIM');
    expect(out.goal.code).toBe('ELICIT_REQUEST');
    expect(out.goal.hint).toBe('What do you need today?');
  });
});
