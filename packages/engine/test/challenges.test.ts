// packages/engine/test/challenges.test.ts
// Task 9: engine-issued challenges. THE LLM MAY ASK, IT MAY NEVER GRADE — `selectChallenge`
// only ever produces a phrasing goal (`ask`) that never leaks the expected answer;
// `gradeChallenges` is the sole, deterministic grader, from plain transcript text.
import { describe, expect, it } from 'vitest';
import { fnv1a, gradeChallenges, selectChallenge } from '../src/challenges';
import { MERIDIAN } from '../src/seed/meridian';
import type { AgentAction, Claim, ChallengeResult, ChallengeSpec, Utterance } from '../src/types';

const SEED = MERIDIAN;

function utt(id: string, t_ms: number, text: string, speaker: 'caller' | 'agent' = 'caller'): Utterance {
  return { id, speaker, text, t_ms };
}

function claim(
  id: string,
  field: Claim['field'],
  kind: Claim['kind'],
  value: string | number,
  t_ms: number,
  quoteText: string,
): Claim {
  return { id, field, kind, value, quote: { utterance_id: `u-${id}`, text: quoteText }, t_ms, request_version: 1 };
}

function issuedAction(id: string, challenge_id: string, t_ms: number): AgentAction {
  return { id, kind: 'challenge_issued', t_ms, challenge_id };
}

describe('selectChallenge — selection order', () => {
  // Amount claim at t=1000, with 4 caller turns after it (t=2000..5000, the last one
  // carrying the counsel claim). The counsel claim itself, at t=5000, has ZERO caller
  // turns after it, so it never qualifies for LIVE_COMMITMENT (< 2 turns old) and instead
  // surfaces via TRAP_FACT.
  const claims: Claim[] = [
    claim('c-amount', 'amount_usd', 'STATED', 1000, 1000, 'a thousand dollars'),
    claim('c-counsel', 'counsel', 'STATED', 'whitmore and bass', 5000, 'Whitmore and Bass'),
  ];
  const conversation: Utterance[] = [
    utt('u1', 1000, "it's a thousand dollars"),
    utt('u2', 2000, 'ok go on'),
    utt('u3', 3000, 'still here'),
    utt('u4', 4000, 'one more thing'),
    utt('u5', 5000, 'counsel is Whitmore and Bass'),
  ];

  it('picks LIVE_COMMITMENT on the oldest eligible claim first', () => {
    const spec = selectChallenge(claims, [], {}, SEED, 'sess1', conversation);
    expect(spec?.kind).toBe('LIVE_COMMITMENT');
    expect(spec?.field).toBe('amount_usd');
    expect(spec?.challenge_id).toBe('sess1-1');
    expect(spec?.expect).toEqual({ commitment_claim_id: 'c-amount' });
  });

  it('then picks TRAP_FACT on counsel, offering the truth because the caller was wrong', () => {
    const spec1 = selectChallenge(claims, [], {}, SEED, 'sess1', conversation)!;
    const spec2 = selectChallenge(claims, [spec1], {}, SEED, 'sess1', conversation);
    expect(spec2?.kind).toBe('TRAP_FACT');
    expect(spec2?.field).toBe('counsel');
    expect(spec2?.challenge_id).toBe('sess1-2');
    expect(spec2?.expect).toEqual({ trap_value: 'Calder & Finch', true_claim_id: 'c-counsel' });
  });

  it('then picks SEED_FACT, then returns null once max_challenges (3) are issued', () => {
    const spec1 = selectChallenge(claims, [], {}, SEED, 'sess1', conversation)!;
    const spec2 = selectChallenge(claims, [spec1], {}, SEED, 'sess1', conversation)!;
    const spec3 = selectChallenge(claims, [spec1, spec2], {}, SEED, 'sess1', conversation);
    expect(spec3?.kind).toBe('SEED_FACT');
    expect(spec3?.challenge_id).toBe('sess1-3');
    expect('accept_tokens' in spec3!.expect).toBe(true);

    const spec4 = selectChallenge(claims, [spec1, spec2, spec3!], {}, SEED, 'sess1', conversation);
    expect(spec4).toBeNull();
  });

  it('picks RELATIONAL once a beneficiary/escrow claim exists and both prior kinds are exhausted', () => {
    const withBeneficiary: Claim[] = [claim('c-ben', 'beneficiary', 'STATED', 'meridian supply', 1000, 'to Meridian Supply')];
    // Force straight to RELATIONAL: no LIVE_COMMITMENT-eligible claim (turns < 2, absent
    // conversation makes every claim "old enough" — so mark TRAP_FACT and SEED_FACT as
    // already issued/exhausted instead).
    const trap: ChallengeSpec = {
      challenge_id: 'sessR-1',
      kind: 'TRAP_FACT',
      field: 'beneficiary',
      ask: 'x',
      expect: { trap_value: 'Northgate Partners', true_claim_id: 'c-ben' },
    };
    const seedFacts: ChallengeSpec[] = SEED.knowledge.map((k, i) => ({
      challenge_id: `sessR-${i + 2}`,
      kind: 'SEED_FACT',
      field: 'purpose',
      ask: k.ask,
      expect: { accept_tokens: k.accept_tokens },
    }));
    const bigSeed = { ...SEED, thresholds: { ...SEED.thresholds, max_challenges: 100 } };
    const spec = selectChallenge(withBeneficiary, [trap, ...seedFacts], {}, bigSeed, 'sessR', undefined);
    expect(spec?.kind).toBe('RELATIONAL');
    expect(spec?.field).toBe('account_last4');
    expect(spec?.expect).toEqual({ accept_tokens: ['8830'] });
  });
});

describe('selectChallenge — determinism', () => {
  it('same inputs twice produce an identical spec', () => {
    const claims: Claim[] = [claim('c1', 'amount_usd', 'STATED', 500, 0, '$500')];
    const a = selectChallenge(claims, [], {}, SEED, 'same-session', undefined);
    const b = selectChallenge(claims, [], {}, SEED, 'same-session', undefined);
    expect(a).toEqual(b);
  });

  it('uses fnv1a to order SEED_FACT entries, and different session ids can change the order', () => {
    expect(fnv1a('a')).not.toBe(fnv1a('b'));

    // No claims at all ⇒ LIVE_COMMITMENT and TRAP_FACT both find nothing ⇒ straight to
    // SEED_FACT. Compute the expected winner independently via the exported fnv1a and
    // compare against what selectChallenge actually returns, for two different session ids.
    for (const sessionId of ['session-alpha', 'session-beta']) {
      const expectedEntry = [...SEED.knowledge].sort(
        (x, y) => fnv1a(`${sessionId}:${x.id}`) - fnv1a(`${sessionId}:${y.id}`),
      )[0]!;
      const spec = selectChallenge([], [], {}, SEED, sessionId, undefined);
      expect(spec?.kind).toBe('SEED_FACT');
      expect(spec?.expect).toEqual({ accept_tokens: expectedEntry.accept_tokens });
    }

    // And the two session ids actually do disagree on the winner (proves the ordering
    // function is genuinely in use, not a fixed/ignored argument).
    const winnerFor = (sessionId: string) =>
      [...SEED.knowledge].sort((x, y) => fnv1a(`${sessionId}:${x.id}`) - fnv1a(`${sessionId}:${y.id}`))[0]!.id;
    expect(winnerFor('session-alpha')).not.toBe(winnerFor('session-beta'));
  });
});

describe('gradeChallenges — SEED_FACT', () => {
  const counselFact = SEED.knowledge.find((k) => k.id === 'counsel_of_record')!;
  const spec: ChallengeSpec = {
    challenge_id: 'g1-1',
    kind: 'SEED_FACT',
    field: 'counsel',
    ask: counselFact.ask,
    expect: { accept_tokens: counselFact.accept_tokens },
  };
  const actions: AgentAction[] = [issuedAction('a1', 'g1-1', 6000)];

  it('PASS with a quote when the caller supplies all accept_tokens', () => {
    const conversation = [utt('u1', 7000, 'Calder and Finch')];
    const result = gradeChallenges(conversation, actions, [spec], SEED, []);
    expect(result['g1-1']).toEqual({
      result: 'PASS',
      quote: { utterance_id: 'u1', text: 'Calder and Finch' },
      eligible_utterance_ids: ['u1'],
    });
  });

  it('FAIL when the caller supplies a wrong answer', () => {
    const conversation = [utt('u1', 7000, 'Whitmore & Bass')];
    const result = gradeChallenges(conversation, actions, [spec], SEED, []);
    expect(result['g1-1']?.result).toBe('FAIL');
  });

  it('REFUSED when the caller declines to answer', () => {
    const conversation = [utt('u1', 7000, "I don't know")];
    const result = gradeChallenges(conversation, actions, [spec], SEED, []);
    expect(result['g1-1']?.result).toBe('REFUSED');
  });

  it('UNANSWERED when there is no caller utterance at all', () => {
    const result = gradeChallenges([], actions, [spec], SEED, []);
    expect(result['g1-1']).toEqual({ result: 'UNANSWERED', eligible_utterance_ids: [] });
  });

  it('an utterance after a second challenge_issued is NOT eligible for the first', () => {
    const spec2: ChallengeSpec = { ...spec, challenge_id: 'g1-2' };
    const twoActions: AgentAction[] = [issuedAction('a1', 'g1-1', 6000), issuedAction('a2', 'g1-2', 8000)];
    const conversation = [utt('u1', 9000, 'Calder and Finch')];
    const result = gradeChallenges(conversation, twoActions, [spec, spec2], SEED, []);
    expect(result['g1-1']).toEqual({ result: 'UNANSWERED', eligible_utterance_ids: [] });
  });
});

describe('gradeChallenges — LIVE_COMMITMENT', () => {
  const amountClaim = claim('c-amt', 'amount_usd', 'STATED', 1_800_000, 1000, '1.8 million');
  const spec: ChallengeSpec = {
    challenge_id: 'g2-1',
    kind: 'LIVE_COMMITMENT',
    field: 'amount_usd',
    ask: 'Ask the caller to restate the amount_usd they gave earlier. Do not say the value yourself.',
    expect: { commitment_claim_id: 'c-amt' },
  };
  const actions: AgentAction[] = [issuedAction('a1', 'g2-1', 2000)];

  it('PASS when the caller restates the exact committed amount', () => {
    const conversation = [utt('u1', 3000, 'one point eight million, as I said')];
    const result = gradeChallenges(conversation, actions, [spec], SEED, [amountClaim]);
    expect(result['g2-1']?.result).toBe('PASS');
  });

  it('FAIL when the caller states a different amount', () => {
    const conversation = [utt('u1', 3000, "it's 2.1 million")];
    const result = gradeChallenges(conversation, actions, [spec], SEED, [amountClaim]);
    expect(result['g2-1']?.result).toBe('FAIL');
  });

  it('AMBIGUOUS when the caller neither confirms nor states a number', () => {
    const conversation = [utt('u1', 3000, 'why do you need that')];
    const result = gradeChallenges(conversation, actions, [spec], SEED, [amountClaim]);
    expect(result['g2-1']?.result).toBe('AMBIGUOUS');
  });
});

describe('gradeChallenges — TRAP_FACT', () => {
  const counselClaim = claim('c-cns', 'counsel', 'STATED', 'whitmore and bass', 1000, 'Whitmore and Bass');
  const spec: ChallengeSpec = {
    challenge_id: 'g3-1',
    kind: 'TRAP_FACT',
    field: 'counsel',
    ask: 'Confirm the request back to the caller as if summarizing, but say "Calder & Finch" in place of their counsel, then pause.',
    expect: { trap_value: 'Calder & Finch', true_claim_id: 'c-cns' },
  };
  const actions: AgentAction[] = [issuedAction('a1', 'g3-1', 2000)];

  it('PASS when the caller objects with their original (true) claim', () => {
    const conversation = [utt('u1', 3000, "No, it's Whitmore & Bass")];
    const result = gradeChallenges(conversation, actions, [spec], SEED, [counselClaim]);
    expect(result['g3-1']?.result).toBe('PASS');
  });

  it('FAIL when the caller affirms the trap value', () => {
    const conversation = [utt('u1', 3000, 'Yes, correct')];
    const result = gradeChallenges(conversation, actions, [spec], SEED, [counselClaim]);
    expect(result['g3-1']?.result).toBe('FAIL');
  });

  it('AMBIGUOUS when the caller neither affirms nor objects', () => {
    const conversation = [utt('u1', 3000, 'hmm')];
    const result = gradeChallenges(conversation, actions, [spec], SEED, [counselClaim]);
    expect(result['g3-1']?.result).toBe('AMBIGUOUS');
  });
});

describe('selectChallenge — ask never leaks the expected answer', () => {
  function collectAllTokensToCheck(spec: ChallengeSpec, claims: Claim[]): string[] {
    const tokens: string[] = [];
    const exp = spec.expect;
    if ('accept_tokens' in exp) tokens.push(...exp.accept_tokens);
    if ('commitment_claim_id' in exp) {
      const commitmentClaimId = exp.commitment_claim_id;
      const c = claims.find((cl) => cl.id === commitmentClaimId);
      if (c) tokens.push(String(c.value));
    }
    if ('trap_value' in exp) {
      // The trap value itself is DELIBERATELY spoken by the ask — that's the trap. What
      // must never leak is the TRUE claim value (the thing that makes the caller's
      // objection gradeable as PASS).
      const trueClaimId = exp.true_claim_id;
      const trueClaim = claims.find((cl) => cl.id === trueClaimId);
      if (trueClaim) tokens.push(String(trueClaim.value));
    }
    return tokens;
  }

  it('across every kind of generated spec, ask contains none of the graded tokens', () => {
    const claims: Claim[] = [
      claim('c-amount', 'amount_usd', 'STATED', 1000, 1000, 'a thousand dollars'),
      claim('c-counsel', 'counsel', 'STATED', 'whitmore and bass', 5000, 'Whitmore and Bass'),
    ];
    const conversation: Utterance[] = [
      utt('u1', 1000, "it's a thousand dollars"),
      utt('u2', 2000, 'ok go on'),
      utt('u3', 3000, 'still here'),
      utt('u4', 4000, 'one more thing'),
      utt('u5', 5000, 'counsel is Whitmore and Bass'),
    ];

    const issued: ChallengeSpec[] = [];
    for (let i = 0; i < SEED.thresholds.max_challenges; i++) {
      const spec = selectChallenge(claims, issued, {}, SEED, 'leak-check', conversation);
      if (!spec) break;
      const ask = spec.ask.toLowerCase();
      for (const token of collectAllTokensToCheck(spec, claims)) {
        expect(ask.includes(token.toLowerCase())).toBe(false);
      }
      issued.push(spec);
    }
    expect(issued.length).toBeGreaterThan(0);

    // Also check a RELATIONAL spec explicitly (not reached in the sequence above because
    // max_challenges caps out first).
    const withBeneficiary: Claim[] = [claim('c-ben', 'beneficiary', 'STATED', 'meridian supply', 1000, 'Meridian Supply')];
    const bigSeed = { ...SEED, thresholds: { ...SEED.thresholds, max_challenges: 100 } };
    const blockLiveCommitment: ChallengeSpec = {
      challenge_id: 'rel-block',
      kind: 'TRAP_FACT',
      field: 'beneficiary',
      ask: 'x',
      expect: { trap_value: 'Northgate Partners', true_claim_id: 'c-ben' },
    };
    const relSpec = selectChallenge(
      withBeneficiary,
      [
        blockLiveCommitment,
        ...SEED.knowledge.map((k, i) => ({
          challenge_id: `rel-${i}`,
          kind: 'SEED_FACT' as const,
          field: 'purpose' as const,
          ask: k.ask,
          expect: { accept_tokens: k.accept_tokens },
        })),
      ],
      {},
      bigSeed,
      'leak-check-2',
      undefined,
    );
    expect(relSpec?.kind).toBe('RELATIONAL');
    const relAccept = (relSpec!.expect as { accept_tokens: string[] }).accept_tokens;
    for (const token of relAccept) {
      expect(relSpec!.ask.toLowerCase().includes(token.toLowerCase())).toBe(false);
    }
  });
});
