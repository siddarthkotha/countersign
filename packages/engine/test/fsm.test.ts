// packages/engine/test/fsm.test.ts
// Bug fix (2026-09-03, founder-observed live run tonight, see
// scripts/rehearse/reports/2026-09-03T23-04-42-scenario-a-dana-legitimate.md): the voice
// model was offered the three EVIDENCE/CONSISTENCY_CHECK lookup tools' schemas (each
// carrying a required `identity_id: string` parameter), learned that field name, and started
// asking the caller for their "identity id" -- violating the standing rule (one question at
// a time) and inventing a system field the caller can never know. Since commit 422d750 the
// server runs get_request_history/check_sso_context/verify_out_of_band itself
// (`runLookupsIfNeeded`, call/session.ts) the instant EVIDENCE/CONSISTENCY_CHECK is reached,
// so the model never needed to be OFFERED these tools at all. This test proves
// `allowedTools` returns [] for every EngineState -- the voice model is offered NO tools,
// ever, ceiling zero, not just for the states that used to already return [].
import { describe, it, expect } from 'vitest';
import { allowedTools, phrasingGoal } from '../src/fsm';
import { buildLedger, currentClaim } from '../src/ledger';
import { MERIDIAN } from '../src/seed/meridian';
import type { DecideResult } from '../src/rules';
import type { AssuranceChecklist, Claim, ClaimField, EngineState, Utterance, Verdict } from '../src/types';

const ALL_STATES: EngineState[] = [
  'INTAKE',
  'CLAIM',
  'CHALLENGE',
  'EVIDENCE',
  'CONSISTENCY_CHECK',
  'DECISION',
  'ACTION',
  'SEALED',
  'OUT_OF_SCOPE',
];

const SOME_VERDICTS: Verdict[] = ['PENDING', 'ESCALATE', 'STAGE', 'FREEZE', 'NO_ACTION'];

describe('allowedTools -- the voice model is offered no tools, ever', () => {
  for (const state of ALL_STATES) {
    for (const verdict of SOME_VERDICTS) {
      it(`returns [] for state=${state}, verdict=${verdict}`, () => {
        expect(allowedTools(state, verdict)).toEqual([]);
      });
    }
  }

  it('covers every EngineState member (fails loudly if a new state is ever added here without a test)', () => {
    expect(ALL_STATES).toHaveLength(9);
  });
});

// ---------------------------------------------------------------------------------------
// Bug fix (2026-09-03 later that night, founder-observed live call + three separate harness
// runs -- scripts/rehearse/reports/2026-09-03T23-04-42-, T23-32-42- and T23-39-25-
// scenario-a-dana-legitimate.md): the legitimate-caller scenario never reached STAGE. The
// engine's CONSISTENCY_CHECK/READBACK goal only ever handed the model a PROSE instruction
// ("Read back amount usd as '$84,500' and ask them to confirm it."), never an exact
// sentence -- across the three runs the model improvised past it and invented a different
// unanswerable demand each time ("identity id", "authorization code", "the purpose of the
// transaction"), so the caller never heard a plain confirmable question, never confirmed,
// and the call sat in CONSISTENCY_CHECK until idle timeout. These tests prove the READBACK
// goal now carries a ready-to-speak, exact sentence (`goal.hint`, per-field natural
// phrasing) instead of prose -- and separately prove a second bug found while fixing the
// first: `goal.readback.value` (which call/session.ts copies verbatim into the
// `readback_issued` AgentAction that ledger.ts later re-normalizes to test the caller's
// reply against) used to be the DISPLAY string for amount_usd ("$84,500", which
// `normalizeValue`'s `Number()` call can never parse back to 84500) and the full cue-phrase
// match for account_last4 ("ending 4471", never equal to the bare-digit claim value
// "4471") -- so those two fields could never be confirmed via the live path even with a
// perfect model. `value` is now always `String(claim.value)`, the already-normalized form,
// for every critical field uniformly.
// ---------------------------------------------------------------------------------------

/** A minimal, legal `DecideResult` stub. `phrasingGoal`'s CONSISTENCY_CHECK/READBACK branch
 *  never reads anything off this but `rule_hit` (only for the unrelated `patient` flag) --
 *  the `state` argument, which the caller controls directly, is what actually selects the
 *  branch -- so a fixed dummy `assurance`/`verdict`/etc. is fine everywhere in this file. */
function stubDecideResult(rule_hit: number): DecideResult {
  const assurance: AssuranceChecklist = {
    identity_claimed: true,
    sso_pass_current: false,
    oob_confirmed_current: false,
    context_pass_current: false,
    no_contradictions: true,
    critical_fields_confirmed: false,
    exposure_within_limit: true,
    challenge_requirement_met: true,
    no_identity_switch: true,
    not_new_beneficiary: true,
  };
  return { verdict: 'PENDING', reasons: [], failure_tally: 0, assurance, invariants_ok: true, rule_hit };
}

function u(id: string, text: string, t_ms: number): Utterance {
  return { id, speaker: 'caller', text, t_ms };
}

/** One unconfirmed (STATED) critical-field claim, shaped exactly like what `buildLedger`
 *  itself produces for that field (see extract/claims.ts): `value` is the NORMALIZED form
 *  (a number for amount_usd, the bare digit string for account_last4, the lower-cased name
 *  for beneficiary); `quote.text` is the VERBATIM substring the extractor captured, which
 *  for account_last4 includes the cue phrase (e.g. "ending 4471"), not just the digits. */
function unconfirmedClaim(field: ClaimField, value: string | number, quoteText: string, t_ms = 1000): Claim {
  return {
    id: `cl-${field}`,
    field,
    kind: 'STATED',
    value,
    quote: { utterance_id: 'c1', text: quoteText },
    t_ms,
    request_version: 1,
  };
}

describe('phrasingGoal -- READBACK carries a ready-to-speak exact sentence, not prose', () => {
  const cases: { field: ClaimField; value: string | number; quoteText: string; mustContain: string[] }[] = [
    { field: 'amount_usd', value: 84_500, quoteText: '$84,500', mustContain: ['$84,500'] },
    { field: 'account_last4', value: '4471', quoteText: 'ending 4471', mustContain: ['4471'] },
    { field: 'beneficiary', value: 'meridian supply', quoteText: 'Meridian Supply', mustContain: ['Meridian Supply'] },
  ];

  for (const { field, value, quoteText, mustContain } of cases) {
    it(`${field}: goal.hint is a speakable sentence with the formatted value and a confirmation question`, () => {
      const claim = unconfirmedClaim(field, value, quoteText);
      const out = phrasingGoal({
        state: 'CONSISTENCY_CHECK',
        decideResult: stubDecideResult(5),
        evidence: [],
        ledger: [claim],
        seed: MERIDIAN,
        tools: [],
        actions: [],
        nextChallenge: null,
      });

      expect(out.code).toBe('READBACK');
      for (const needle of mustContain) expect(out.hint).toContain(needle);
      expect(out.hint).toMatch(/is that correct\?/i);
      expect(out.readback).toEqual({ field, value: String(value) });
    });
  }

  it('amount_usd: readback.value is the RAW ledger-normalizable number string, never the "$"/"," display form', () => {
    const claim = unconfirmedClaim('amount_usd', 84_500, '$84,500');
    const out = phrasingGoal({
      state: 'CONSISTENCY_CHECK',
      decideResult: stubDecideResult(5),
      evidence: [],
      ledger: [claim],
      seed: MERIDIAN,
      tools: [],
      actions: [],
      nextChallenge: null,
    });
    expect(out.readback?.value).toBe('84500');
    // The regression itself: Number() can never parse a "$"/"," display string back to a
    // number, so if this ever regresses to a display string, this assertion catches it
    // directly rather than only downstream in the ledger round-trip test below.
    expect(Number(out.readback?.value)).toBe(84_500);
  });

  it('account_last4: readback.value is the bare digit string, never the cue-phrase quote ("ending 4471")', () => {
    const claim = unconfirmedClaim('account_last4', '4471', 'ending 4471');
    const out = phrasingGoal({
      state: 'CONSISTENCY_CHECK',
      decideResult: stubDecideResult(5),
      evidence: [],
      ledger: [claim],
      seed: MERIDIAN,
      tools: [],
      actions: [],
      nextChallenge: null,
    });
    expect(out.readback?.value).toBe('4471');
  });
});

describe('READBACK closes the loop: readback + affirm actually confirms the field (regression for the 2026-09-03 CONSISTENCY_CHECK stall)', () => {
  /** Mirrors exactly what call/session.ts's `recordGoalCompletionAction` does when the
   *  agent's reply for a READBACK goal completes: writes a `readback_issued` action from the
   *  goal's OWN `field`/`value` -- never from what the model actually said (LAW 3: the LLM
   *  never writes evidence). */
  function readbackIssuedFrom(goalOut: ReturnType<typeof phrasingGoal>, t_ms: number) {
    if (!goalOut.readback) throw new Error('expected a readback goal');
    return { id: `a-${t_ms}`, kind: 'readback_issued' as const, t_ms, field: goalOut.readback.field, value: goalOut.readback.value };
  }

  // Each statement names exactly one critical field, so `oldestUnconfirmedCritical` can only
  // ever pick THAT field -- no tie-break with the other two critical fields to reason about.
  const cases: { field: ClaimField; statement: string }[] = [
    { field: 'amount_usd', statement: 'I need to wire $84,500 today.' },
    { field: 'account_last4', statement: 'The account is ending 4471.' },
    { field: 'beneficiary', statement: 'Please wire it to Meridian Supply.' },
  ];

  for (const { field, statement } of cases) {
    it(`${field}: after the engine's own readback is issued and the caller affirms, the ledger marks it CONFIRMED`, () => {
      // Real extraction, real ledger -- no hand-built Claim here. This is the full round
      // trip: caller statement -> buildLedger extracts the claim -> phrasingGoal computes the
      // READBACK goal off that real ledger -> the goal's own field/value becomes the
      // AgentAction (exactly as session.ts writes it) -> buildLedger again with the caller's
      // affirming reply -> the field must now read CONFIRMED.
      const stated = u('c1', statement, 1000);
      const { claims: afterStatement } = buildLedger([stated], [], MERIDIAN);
      const claimBefore = currentClaim(afterStatement, field);
      expect(claimBefore).not.toBeNull(); // sanity: the extractor actually caught this field
      expect(claimBefore!.kind).not.toBe('CONFIRMED');

      const out = phrasingGoal({
        state: 'CONSISTENCY_CHECK',
        decideResult: stubDecideResult(5),
        evidence: [],
        ledger: afterStatement,
        seed: MERIDIAN,
        tools: [],
        actions: [],
        nextChallenge: null,
      });
      expect(out.code).toBe('READBACK');
      expect(out.readback?.field).toBe(field);

      const readbackAction = readbackIssuedFrom(out, 5000);
      const affirming = u('c2', "Yes, that's right.", 8000);
      const { claims: afterAffirm } = buildLedger([stated, affirming], [readbackAction], MERIDIAN);

      expect(currentClaim(afterAffirm, field)?.kind).toBe('CONFIRMED');
    });
  }
});
