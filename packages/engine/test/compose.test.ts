// packages/engine/test/compose.test.ts
// Founder-morning item 4: `reconstructIssued` trusts a recorded `AgentAction.spec` when it
// is a LEGAL choice at that point in the call, instead of only ever recomputing
// `selectChallenge` and hoping the recomputation agrees. This file is NOT part of the
// protected oracle (only test/corpus.test.ts, test/mutants.test.ts, corpus/*.json and the
// CI workflow are) -- it is a new, freely-appendable unit test file.
import { describe, expect, it } from 'vitest';
import { reconstructIssued } from '../src/compose';
import { MERIDIAN } from '../src/seed/meridian';
import type { AgentAction, Claim, ChallengeSpec } from '../src/types';

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
