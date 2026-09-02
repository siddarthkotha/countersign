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
    const actions: AgentAction[] = [{ id: 'act1', kind: 'challenge_issued', t_ms: 1000, challenge_id: 'sess-v-1' }];
    const issued = reconstructIssued([], actions, SEED, 'sess-v', []);
    expect(issued).toHaveLength(1);
    expect(issued[0]!.kind).toBe('SEED_FACT');
    expect(issued[0]!.ask).not.toBe('');
  });
});
