// packages/engine/test/compose.test.ts
// Founder-morning item 4: `reconstructIssued` trusts a recorded `AgentAction.spec` when it
// is a LEGAL choice at that point in the call, instead of only ever recomputing
// `selectChallenge` and hoping the recomputation agrees. This file is NOT part of the
// protected oracle (only test/corpus.test.ts, test/mutants.test.ts, corpus/*.json and the
// CI workflow are) -- it is a new, freely-appendable unit test file.
import { describe, expect, it } from 'vitest';
import { buildConsistencyEvidence, deriveRuleContext, reconstructIssued, resolveIdentitySwitch } from '../src/compose';
import { evidenceFromTranscript } from '../src/evidence/fromTranscript';
import { buildLedger } from '../src/ledger';
import { MERIDIAN } from '../src/seed/meridian';
import type { AgentAction, Claim, ChallengeSpec, Utterance } from '../src/types';

const SEED = MERIDIAN;

function claim(id: string, field: Claim['field'], value: string | number, t_ms: number, quoteText: string): Claim {
  return { id, field, kind: 'STATED', value, quote: { utterance_id: `u-${id}`, text: quoteText }, t_ms, request_version: 1 };
}

describe('reconstructIssued -- recorded spec, founder-morning item 4', () => {
  it('a legal SEED_FACT spec for counsel_of_record is used verbatim, even when hash order would have picked a different entry', () => {
    const counselFact = SEED.knowledge.find((k) => k.id === 'counsel_of_record')!;
    // No claims/conversation at all: with no spec recorded, `selectChallenge` would fall
    // straight through to SEED_FACT and pick a seed.knowledge entry by session-hash order
    // for 'sess-b' -- verified (via test/challenges.test.ts's own determinism test pattern)
    // to NOT be counsel_of_record for this session id, so this genuinely exercises "used
    // even when recomputation would have picked another entry", not a coincidence.
    const recordedSpec: ChallengeSpec = {
      challenge_id: 'sess-b-1',
      kind: 'SEED_FACT',
      field: 'counsel',
      ask: counselFact.ask,
      expect: { accept_tokens: counselFact.accept_tokens },
      fact_id: 'counsel_of_record',
    };
    const actions: AgentAction[] = [{ id: 'act1', kind: 'challenge_issued', t_ms: 4000, challenge_id: 'sess-b-1', spec: recordedSpec }];

    const issued = reconstructIssued([], actions, SEED, 'sess-b', []);

    expect(issued).toHaveLength(1);
    expect(issued[0]).toEqual(recordedSpec);
    expect(issued[0]!.fact_id).toBe('counsel_of_record');
  });

  it('an illegal spec (fact already issued) is dropped to the drift placeholder, not used verbatim', () => {
    const counselFact = SEED.knowledge.find((k) => k.id === 'counsel_of_record')!;
    const firstSpec: ChallengeSpec = {
      challenge_id: 'sess-x-1',
      kind: 'SEED_FACT',
      field: 'counsel',
      ask: counselFact.ask,
      expect: { accept_tokens: counselFact.accept_tokens },
      fact_id: 'counsel_of_record',
    };
    // Second action claims to ask counsel_of_record AGAIN -- illegal, since it was already
    // issued by the first action.
    const repeatedSpec: ChallengeSpec = { ...firstSpec, challenge_id: 'sess-x-2' };
    const actions: AgentAction[] = [
      { id: 'act1', kind: 'challenge_issued', t_ms: 1000, challenge_id: 'sess-x-1', spec: firstSpec },
      { id: 'act2', kind: 'challenge_issued', t_ms: 2000, challenge_id: 'sess-x-2', spec: repeatedSpec },
    ];

    const issued = reconstructIssued([], actions, SEED, 'sess-x', []);

    expect(issued).toHaveLength(2);
    expect(issued[0]).toEqual(firstSpec);
    // The second is NOT the repeated spec verbatim -- it's the drift placeholder.
    expect(issued[1]).not.toEqual(repeatedSpec);
    expect(issued[1]!.challenge_id).toBe('sess-x-2');
    expect(issued[1]!.ask).toBe(''); // the drift sentinel
    expect(issued[1]!.expect).toEqual({ accept_tokens: [] });
  });

  it('a spec whose challenge_id does not match the expected `${session_id}-${index}` is illegal -> drift', () => {
    const counselFact = SEED.knowledge.find((k) => k.id === 'counsel_of_record')!;
    const wrongIdSpec: ChallengeSpec = {
      challenge_id: 'sess-y-99', // expected would be 'sess-y-1'
      kind: 'SEED_FACT',
      field: 'counsel',
      ask: counselFact.ask,
      expect: { accept_tokens: counselFact.accept_tokens },
      fact_id: 'counsel_of_record',
    };
    const actions: AgentAction[] = [{ id: 'act1', kind: 'challenge_issued', t_ms: 1000, challenge_id: 'sess-y-99', spec: wrongIdSpec }];

    const issued = reconstructIssued([], actions, SEED, 'sess-y', []);

    expect(issued).toHaveLength(1);
    expect(issued[0]!.ask).toBe('');
  });

  it('a legal LIVE_COMMITMENT spec referencing a claim that exists as of t_ms is used verbatim', () => {
    const amountClaim = claim('c-amt', 'amount_usd', 1_800_000, 1000, '1.8 million');
    const spec: ChallengeSpec = {
      challenge_id: 'sess-z-1',
      kind: 'LIVE_COMMITMENT',
      field: 'amount_usd',
      ask: 'Ask the caller to restate the amount_usd they gave earlier. Do not say the value yourself.',
      expect: { commitment_claim_id: 'c-amt' },
    };
    const actions: AgentAction[] = [{ id: 'act1', kind: 'challenge_issued', t_ms: 2000, challenge_id: 'sess-z-1', spec }];

    const issued = reconstructIssued([amountClaim], actions, SEED, 'sess-z', []);

    expect(issued[0]).toEqual(spec);
  });

  it('a LIVE_COMMITMENT spec referencing a claim that does not exist yet at t_ms is illegal -> drift', () => {
    const amountClaim = claim('c-amt', 'amount_usd', 1_800_000, 5000, '1.8 million'); // claimed AFTER the action
    const spec: ChallengeSpec = {
      challenge_id: 'sess-w-1',
      kind: 'LIVE_COMMITMENT',
      field: 'amount_usd',
      ask: 'Ask the caller to restate the amount_usd they gave earlier. Do not say the value yourself.',
      expect: { commitment_claim_id: 'c-amt' },
    };
    const actions: AgentAction[] = [{ id: 'act1', kind: 'challenge_issued', t_ms: 2000, challenge_id: 'sess-w-1', spec }];

    const issued = reconstructIssued([amountClaim], actions, SEED, 'sess-w', []);

    expect(issued[0]!.ask).toBe('');
  });

  it('absent spec keeps the existing recomputation behavior (unchanged)', () => {
    // Identity claim added (founder ruling 2026-09-09, scoping fix): every Hartwell
    // SEED_FACT entry is now scoped to robert-miller, so recomputation needs a claimed
    // identity to find anything at all -- otherwise every entry is correctly out of scope
    // and selectChallenge legitimately returns null, which would turn this into a drift
    // placeholder instead of exercising "recomputation picked a real SEED_FACT".
    const identityClaim = claim('c-id', 'identity', 'robert-miller', 0, 'Robert Miller');
    const actions: AgentAction[] = [{ id: 'act1', kind: 'challenge_issued', t_ms: 1000, challenge_id: 'sess-v-1' }];
    const issued = reconstructIssued([identityClaim], actions, SEED, 'sess-v', []);
    expect(issued).toHaveLength(1);
    expect(issued[0]!.kind).toBe('SEED_FACT');
    expect(issued[0]!.ask).not.toBe('');
  });

  // Fix round 1 (review of 2a08920 + 7d16440), finding 1: isLegalSpec must check CONSISTENCY
  // against the id it names, not merely that the id exists.
  it('a SEED_FACT spec whose accept_tokens do not match the named fact_id is illegal -> drift', () => {
    const counselFact = SEED.knowledge.find((k) => k.id === 'counsel_of_record')!;
    const spec: ChallengeSpec = {
      challenge_id: 'sess-tok-1',
      kind: 'SEED_FACT',
      field: 'counsel',
      ask: counselFact.ask,
      expect: { accept_tokens: ['not', 'the', 'real', 'tokens'] }, // doctored -- doesn't match the seed entry
      fact_id: 'counsel_of_record',
    };
    const actions: AgentAction[] = [{ id: 'act1', kind: 'challenge_issued', t_ms: 1000, challenge_id: 'sess-tok-1', spec }];
    const issued = reconstructIssued([], actions, SEED, 'sess-tok', []);
    expect(issued[0]!.ask).toBe('');
  });

  it('a LIVE_COMMITMENT spec whose field does not match the referenced claim is illegal -> drift', () => {
    const amountClaim = claim('c-amt2', 'amount_usd', 1_800_000, 1000, '1.8 million');
    const spec: ChallengeSpec = {
      challenge_id: 'sess-mf-1',
      kind: 'LIVE_COMMITMENT',
      field: 'beneficiary', // mismatched -- the referenced claim is amount_usd
      ask: 'Ask the caller to restate the beneficiary they gave earlier. Do not say the value yourself.',
      expect: { commitment_claim_id: 'c-amt2' },
    };
    const actions: AgentAction[] = [{ id: 'act1', kind: 'challenge_issued', t_ms: 2000, challenge_id: 'sess-mf-1', spec }];
    const issued = reconstructIssued([amountClaim], actions, SEED, 'sess-mf', []);
    expect(issued[0]!.ask).toBe('');
  });

  it('a second TRAP_FACT spec in the same call is illegal -> drift, mirroring selectChallenge once-per-call', () => {
    const approverClaim = claim('c-appr', 'approver', 'marcus obi', 1000, 'Marcus Obi');
    const beneficiaryClaim = claim('c-ben', 'beneficiary', 'meridian supply', 1000, 'Meridian Supply');
    const firstTrap: ChallengeSpec = {
      challenge_id: 'sess-tf-1',
      kind: 'TRAP_FACT',
      field: 'approver',
      ask: 'Confirm the request back to the caller as if summarizing, but say "Elena Park" in place of their approver, then pause.',
      expect: { trap_value: 'Elena Park', true_claim_id: 'c-appr' },
    };
    const secondTrap: ChallengeSpec = {
      challenge_id: 'sess-tf-2',
      kind: 'TRAP_FACT',
      field: 'beneficiary',
      ask: 'Confirm the request back to the caller as if summarizing, but say "Whitmore & Bass" in place of their beneficiary, then pause.',
      expect: { trap_value: 'Whitmore & Bass', true_claim_id: 'c-ben' },
    };
    const actions: AgentAction[] = [
      { id: 'act1', kind: 'challenge_issued', t_ms: 1000, challenge_id: 'sess-tf-1', spec: firstTrap },
      { id: 'act2', kind: 'challenge_issued', t_ms: 2000, challenge_id: 'sess-tf-2', spec: secondTrap },
    ];
    const issued = reconstructIssued([approverClaim, beneficiaryClaim], actions, SEED, 'sess-tf', []);
    expect(issued[0]).toEqual(firstTrap);
    expect(issued[1]!.ask).toBe(''); // drift -- a second TRAP_FACT is never legal in one call
  });

  it('a legal RELATIONAL spec is used verbatim when its dependent field has been claimed', () => {
    const escrowClaim = claim('c-esc', 'escrow_institution', 'first meridian trust', 1000, 'First Meridian Trust');
    const spec: ChallengeSpec = {
      challenge_id: 'sess-rel-1',
      kind: 'RELATIONAL',
      field: 'account_last4',
      ask: 'Ask for the last four digits of the account attached to the escrow institution they named.',
      expect: { accept_tokens: ['8830'] },
    };
    const actions: AgentAction[] = [{ id: 'act1', kind: 'challenge_issued', t_ms: 2000, challenge_id: 'sess-rel-1', spec }];
    const issued = reconstructIssued([escrowClaim], actions, SEED, 'sess-rel', []);
    expect(issued[0]).toEqual(spec);
  });

  it('a second RELATIONAL spec in the same call is illegal -> drift, mirroring selectChallenge once-per-call', () => {
    const escrowClaim = claim('c-esc2', 'escrow_institution', 'first meridian trust', 1000, 'First Meridian Trust');
    const firstSpec: ChallengeSpec = {
      challenge_id: 'sess-rel2-1',
      kind: 'RELATIONAL',
      field: 'account_last4',
      ask: 'Ask for the last four digits of the account attached to the escrow institution they named.',
      expect: { accept_tokens: ['8830'] },
    };
    const secondSpec: ChallengeSpec = { ...firstSpec, challenge_id: 'sess-rel2-2' };
    const actions: AgentAction[] = [
      { id: 'act1', kind: 'challenge_issued', t_ms: 2000, challenge_id: 'sess-rel2-1', spec: firstSpec },
      { id: 'act2', kind: 'challenge_issued', t_ms: 3000, challenge_id: 'sess-rel2-2', spec: secondSpec },
    ];
    const issued = reconstructIssued([escrowClaim], actions, SEED, 'sess-rel2', []);
    expect(issued[0]).toEqual(firstSpec);
    expect(issued[1]!.ask).toBe('');
  });
});

function u(id: string, speaker: Utterance['speaker'], text: string, t_ms: number): Utterance {
  return { id, speaker, text, t_ms };
}

describe('deriveRuleContext -- challenge_awaiting_answer (ruling C, 2026-09-09, item 21)', () => {
  const WINDOW = SEED.thresholds.challenge_answer_window_ms;

  it('false when no challenge has ever been issued', () => {
    const ctx = deriveRuleContext([], 1, [], [], [], [], 0, SEED);
    expect(ctx.challenge_awaiting_answer).toBe(false);
  });

  it('true when the most recent challenge_issued action has no caller utterance after it and the call is still live', () => {
    const actions: AgentAction[] = [{ id: 'ch1', kind: 'challenge_issued', t_ms: 10_000, challenge_id: 'sess-1' }];
    const conversation: Utterance[] = [u('c1', 'caller', 'This is Robert Miller.', 1_000)];
    // Latest event (the action itself) is 0ms after the challenge was issued -- well within window.
    const ctx = deriveRuleContext([], 1, [], [], conversation, actions, 1, SEED);
    expect(ctx.challenge_awaiting_answer).toBe(true);
  });

  it('false once a caller utterance follows the most recent challenge_issued action (answered)', () => {
    const actions: AgentAction[] = [{ id: 'ch1', kind: 'challenge_issued', t_ms: 10_000, challenge_id: 'sess-1' }];
    const conversation: Utterance[] = [
      u('c1', 'caller', 'This is Robert Miller.', 1_000),
      u('c2', 'caller', 'Zurich.', 10_500), // reply after the challenge was issued
    ];
    const ctx = deriveRuleContext([], 1, [], [], conversation, actions, 1, SEED);
    expect(ctx.challenge_awaiting_answer).toBe(false);
  });

  it('false once the answer window has elapsed with no reply (a silent/abandoned caller)', () => {
    const actions: AgentAction[] = [{ id: 'ch1', kind: 'challenge_issued', t_ms: 10_000, challenge_id: 'sess-1' }];
    // No caller reply, but a later tool event proves the call is still "live" past the window.
    const tools = [{ id: 't1', name: 'check_sso_context' as const, t_ms: 10_000 + WINDOW + 1, args: {} }];
    const ctx = deriveRuleContext([], 1, [], tools, [], actions, 1, SEED);
    expect(ctx.challenge_awaiting_answer).toBe(false);
  });
});

// Founder decision 2026-09-11 10:15 PM, option B: resolveIdentitySwitch is the fix for the
// PROVEN permanent trap (rules.ts row 6 had no exit -- see the investigation this task was
// handed) -- real extraction, real ledger throughout (no hand-built Claim/Evidence here),
// same convention fsm.test.ts's "full round trip" tests already use.
describe('resolveIdentitySwitch (founder decision 2026-09-11 10:15 PM, option B)', () => {
  function transcriptEvAfterResolution(conversation: Utterance[], actions: AgentAction[] = []) {
    const { claims } = buildLedger(conversation, actions, MERIDIAN);
    const raw = evidenceFromTranscript(conversation, MERIDIAN);
    return resolveIdentitySwitch(raw, conversation, claims, MERIDIAN);
  }

  it('stays FLAG when the switch is never followed by anything (no re-statement, no resolution)', () => {
    const convo = [
      u('c1', 'caller', 'This is Dana Whitfield. Wire $84,500 to Meridian Supply.', 1000),
      u('c2', 'caller', 'Actually, this is Robert Miller speaking, I will take it from here.', 5000),
    ];
    const ev = transcriptEvAfterResolution(convo);
    expect(ev.find((e) => e.id === 'ev-identity-switch')!.status).toBe('FLAG');
  });

  it('stays FLAG when the request changes to a different, still-unconfirmed value after the switch', () => {
    const convo = [
      u('c1', 'caller', 'This is Dana Whitfield. Wire $84,500 to Meridian Supply.', 1000),
      u('c2', 'caller', 'Actually, this is Robert Miller speaking, I will take it from here.', 5000),
      u('c3', 'caller', 'This is Robert Miller. Make it $200,000 to Northgate Partners instead.', 9000),
    ];
    const ev = transcriptEvAfterResolution(convo);
    expect(ev.find((e) => e.id === 'ev-identity-switch')!.status).toBe('FLAG');
  });

  it('resolves (status INFO) once the caller re-states the new identity and repeats the SAME request unchanged', () => {
    const convo = [
      u('c1', 'caller', 'This is Dana Whitfield. Wire $84,500 to Meridian Supply.', 1000),
      u('c2', 'caller', 'Actually, this is Robert Miller speaking, I will take it from here.', 5000),
      u('c3', 'caller', 'This is Robert Miller. Send the $84,500 to Meridian Supply now.', 9000),
    ];
    const ev = transcriptEvAfterResolution(convo);
    const switchCard = ev.find((e) => e.id === 'ev-identity-switch')!;
    expect(switchCard.status).toBe('INFO');
    // Resolution never erases the switch: facts and quotes (LAW 4) are untouched.
    expect(switchCard.facts).toMatchObject({ first_id: 'dana-whitfield', later_id: 'robert-miller' });
    expect(switchCard.quotes).toEqual([
      { utterance_id: 'c1', text: 'Dana Whitfield' },
      { utterance_id: 'c2', text: 'Robert Miller' },
    ]);
  });

  it('resolves when the pre-switch request was already CONFIRMED via readback and stays unchanged after', () => {
    const convo = [
      u('c1', 'caller', 'This is Dana Whitfield. Wire $84,500 to Meridian Supply, account ending 4471.', 1000),
      u('a1', 'agent', 'Just to confirm, the amount is $84,500. Is that correct?', 2000),
      u('c2', 'caller', 'Yes, that is right.', 2500),
      u('c3', 'caller', 'Actually, this is Robert Miller speaking, I will take it from here.', 5000),
      u('c4', 'caller', 'This is Robert Miller. I am taking this over.', 9000),
    ];
    const actions: AgentAction[] = [{ id: 'r1', kind: 'readback_issued', t_ms: 2000, field: 'amount_usd', value: '84500' }];
    const ev = transcriptEvAfterResolution(convo, actions);
    expect(ev.find((e) => e.id === 'ev-identity-switch')!.status).toBe('INFO');
  });

  it('does not resolve when the SAME identity is merely repeated before any switch happens', () => {
    // Sanity: no switch card at all -> nothing for resolveIdentitySwitch to touch or crash on.
    const convo = [
      u('c1', 'caller', 'This is Dana Whitfield. Wire $84,500 to Meridian Supply.', 1000),
      u('c2', 'caller', 'This is Dana Whitfield again, confirming the same request.', 5000),
    ];
    const ev = transcriptEvAfterResolution(convo);
    expect(ev.find((e) => e.id === 'ev-identity-switch')).toBeUndefined();
  });

  it('is idempotent / a no-op on evidence with no identity_switch card', () => {
    const convo = [u('c1', 'caller', 'This is Dana Whitfield. Wire $84,500 to Meridian Supply.', 1000)];
    const { claims } = buildLedger(convo, [], MERIDIAN);
    const raw = evidenceFromTranscript(convo, MERIDIAN);
    expect(resolveIdentitySwitch(raw, convo, claims, MERIDIAN)).toEqual(raw);
  });

  // Follow-up (option B review, commit b56be9e): a chain A -> B -> C (a double switch) used
  // to be invisible past the first switch -- fromTranscript.ts locked `later_id` to B
  // forever, so resolveIdentitySwitch could only ever check for a re-statement of B, never
  // C. These tests prove the chain is tracked correctly end to end (real extraction, real
  // ledger, same convention as the rest of this describe block).
  describe('a double switch (chain A -> B -> C)', () => {
    it('stays FLAG once C is claimed but never restated -- the card tracks B -> C, not A -> B', () => {
      const convo = [
        u('c1', 'caller', 'This is Dana Whitfield. Wire $84,500 to Meridian Supply.', 1000), // A
        u('c2', 'caller', 'Actually, this is Elena Park speaking, I will take it from here.', 5000), // A -> B
        u('c3', 'caller', 'Actually, this is Robert Miller now, I will take it from here myself.', 9000), // B -> C
      ];
      const ev = transcriptEvAfterResolution(convo);
      const switchCard = ev.find((e) => e.id === 'ev-identity-switch')!;
      expect(switchCard.facts).toMatchObject({ first_id: 'elena-park', later_id: 'robert-miller' });
      expect(switchCard.status).toBe('FLAG'); // nobody has restated Robert Miller (C) yet
    });

    it('does not resolve by reclaiming an EARLIER identity in the chain (B) -- that reopens as a further switch, C -> B', () => {
      const convo = [
        u('c1', 'caller', 'This is Dana Whitfield. Wire $84,500 to Meridian Supply.', 1000), // A
        u('c2', 'caller', 'Actually, this is Elena Park speaking, I will take it from here.', 5000), // A -> B
        u('c3', 'caller', 'Actually, this is Robert Miller now, I will take it from here myself.', 9000), // B -> C
        u('c4', 'caller', 'No wait, this is Elena Park again.', 13000), // C -> B (a THIRD, distinct switch)
      ];
      const ev = transcriptEvAfterResolution(convo);
      const switchCard = ev.find((e) => e.id === 'ev-identity-switch')!;
      // Restating B does not resolve the B -> C switch; it is itself a new, later switch
      // (C -> B), and the card always tracks the LATEST pair -- proving resolution can
      // never be satisfied by restating the identity that was abandoned two hops back.
      expect(switchCard.facts).toMatchObject({ first_id: 'robert-miller', later_id: 'elena-park' });
      expect(switchCard.status).toBe('FLAG');
    });

    it('resolves (status INFO) once C is restated and the request is unchanged since the latest switch', () => {
      const convo = [
        u('c1', 'caller', 'This is Dana Whitfield. Wire $84,500 to Meridian Supply.', 1000), // A
        u('c2', 'caller', 'Actually, this is Elena Park speaking, I will take it from here.', 5000), // A -> B
        u('c3', 'caller', 'Actually, this is Robert Miller now, I will take it from here myself.', 9000), // B -> C
        u('c4', 'caller', 'This is Robert Miller. Send the $84,500 to Meridian Supply now.', 13000), // restates C
      ];
      const ev = transcriptEvAfterResolution(convo);
      const switchCard = ev.find((e) => e.id === 'ev-identity-switch')!;
      expect(switchCard.facts).toMatchObject({ first_id: 'elena-park', later_id: 'robert-miller' });
      expect(switchCard.status).toBe('INFO');
      // Resolution never erases the switch: facts and quotes (LAW 4) are untouched, and they
      // name the LATEST pair (Elena, Robert Miller) -- never the original claimant (Dana).
      expect(switchCard.quotes).toEqual([
        { utterance_id: 'c2', text: 'Elena Park' },
        { utterance_id: 'c3', text: 'Robert Miller' },
      ]);
    });

    it('stays FLAG when the request changes to a different, still-unconfirmed value after the latest switch', () => {
      const convo = [
        u('c1', 'caller', 'This is Dana Whitfield. Wire $84,500 to Meridian Supply.', 1000),
        u('c2', 'caller', 'Actually, this is Elena Park speaking, I will take it from here.', 5000),
        u('c3', 'caller', 'Actually, this is Robert Miller now, I will take it from here myself.', 9000),
        u('c4', 'caller', 'This is Robert Miller. Make it $200,000 to Northgate Partners instead.', 13000),
      ];
      const ev = transcriptEvAfterResolution(convo);
      expect(ev.find((e) => e.id === 'ev-identity-switch')!.status).toBe('FLAG');
    });
  });
});

// Follow-up (option B review, commit b56be9e): the ledger already records EACH distinct
// identity switch as its own CONTRADICTED claim (buildLedger compares against the CURRENT
// claim, never just the first one), so buildConsistencyEvidence -- unchanged by this task --
// already builds one FAIL card per switch. This test makes that existing behavior explicit
// for a double switch (chain A -> B -> C), since it's exactly the "contradiction weight
// counts each switch" guarantee the follow-up asked to be proven or documented.
describe('buildConsistencyEvidence -- a double identity switch counts each switch toward the tally', () => {
  it('produces one FAIL consistency_flag card per contradicted identity claim in the chain, capped at 2', () => {
    const convo = [
      u('c1', 'caller', 'This is Dana Whitfield. Wire $84,500 to Meridian Supply.', 1000),
      u('c2', 'caller', 'Actually, this is Elena Park speaking, I will take it from here.', 5000), // A -> B
      u('c3', 'caller', 'Actually, this is Robert Miller now, I will take it from here myself.', 9000), // B -> C
    ];
    const { claims, request_version } = buildLedger(convo, [], MERIDIAN);
    const identityContradictions = claims.filter((c) => c.field === 'identity' && c.kind === 'CONTRADICTED');
    expect(identityContradictions).toHaveLength(2); // Dana->Elena, Elena->Miller

    const consistencyEv = buildConsistencyEvidence(claims, request_version);
    const identityCards = consistencyEv.filter((e) => e.kind === 'consistency_flag' && e.id.startsWith('ev-consistency-identity'));
    expect(identityCards).toHaveLength(2);
    expect(identityCards.every((e) => e.status === 'FAIL')).toBe(true);
  });
});
