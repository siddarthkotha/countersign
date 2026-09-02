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

  it('then picks SEED_FACT (RELATIONAL is inapplicable here -- no beneficiary/escrow claim), then returns null once max_challenges (3) are issued', () => {
    // Ruled reorder (2026-09-01, 11:24 PM CDT): RELATIONAL now ranks ABOVE SEED_FACT, but
    // this fixture's claims are only amount_usd and counsel -- no beneficiary or
    // escrow_institution claim exists, so `selectRelational` still finds nothing and the
    // third pick falls through to SEED_FACT exactly as before the reorder.
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
    // conversation makes every claim "old enough" — so mark TRAP_FACT as already issued),
    // and use a seed with NO knowledge entries so SEED_FACT is naturally unavailable
    // (rather than exhausted by issuing escrow_account_last4 itself — fix round 1's
    // RELATIONAL dedup would then correctly block RELATIONAL too, since it would be the
    // same fact asked twice; that scenario has its own "RELATIONAL dedup" test below).
    const trap: ChallengeSpec = {
      challenge_id: 'sessR-1',
      kind: 'TRAP_FACT',
      field: 'beneficiary',
      ask: 'x',
      expect: { trap_value: 'Northgate Partners', true_claim_id: 'c-ben' },
    };
    const noKnowledgeSeed = { ...SEED, knowledge: [], thresholds: { ...SEED.thresholds, max_challenges: 100 } };
    const spec = selectChallenge(withBeneficiary, [trap], {}, noKnowledgeSeed, 'sessR', undefined);
    expect(spec?.kind).toBe('RELATIONAL');
    expect(spec?.field).toBe('account_last4');
    // No escrow_account_last4 knowledge entry in this seed ⇒ accept_tokens falls back to [].
    expect(spec?.expect).toEqual({ accept_tokens: [] });
  });

  it('ruled reorder: picks RELATIONAL over SEED_FACT when BOTH are available (real seed, unused knowledge entries)', () => {
    // Unlike the previous test, this uses the real MERIDIAN seed (knowledge entries
    // present and unused, including escrow_account_last4) with a plain high max_challenges
    // -- so before the reorder this would have picked a SEED_FACT entry. Proves RELATIONAL
    // now wins whenever both are simultaneously eligible.
    const withBeneficiary: Claim[] = [claim('c-ben2', 'beneficiary', 'STATED', 'meridian supply', 1000, 'Meridian Supply')];
    const trapAlready: ChallengeSpec = {
      challenge_id: 'sessR2-1',
      kind: 'TRAP_FACT',
      field: 'beneficiary',
      ask: 'x',
      expect: { trap_value: 'Northgate Partners', true_claim_id: 'c-ben2' },
    };
    const bigMaxSeed = { ...SEED, thresholds: { ...SEED.thresholds, max_challenges: 100 } };
    const spec = selectChallenge(withBeneficiary, [trapAlready], {}, bigMaxSeed, 'sessR2', undefined);
    expect(spec?.kind).toBe('RELATIONAL');
    expect(spec?.field).toBe('account_last4');
    const escrowLast4 = SEED.knowledge.find((k) => k.id === 'escrow_account_last4')!;
    expect(spec?.expect).toEqual({ accept_tokens: escrowLast4.accept_tokens });
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

  // Fix round 1 (reviewer finding, Important): the old `lexiconHit` was a raw substring
  // test, so negate_lexicon's "no" fired inside "know" and affirm_lexicon's "right" fired
  // inside "alright"/"copyright". Now backed by the shared word-boundary
  // `hasLexiconHit`/`lexiconHit` in src/normalize.ts (commit a695632).
  it('PASS via the restated-original path, not a false negate from "know" containing "no"', () => {
    const conversation = [utt('u1', 3000, "I know it's Whitmore & Bass")];
    const result = gradeChallenges(conversation, actions, [spec], SEED, [counselClaim]);
    expect(result['g3-1']?.result).toBe('PASS');
  });

  it('AMBIGUOUS for "Alright, that\'s fine" — no genuine affirm word (not "right" inside "alright")', () => {
    const conversation = [utt('u1', 3000, "Alright, that's fine")];
    const result = gradeChallenges(conversation, actions, [spec], SEED, [counselClaim]);
    expect(result['g3-1']?.result).toBe('AMBIGUOUS');
  });

  it('FAIL for "yes, right" — a genuine whole-word affirm', () => {
    const conversation = [utt('u1', 3000, 'yes, right')];
    const result = gradeChallenges(conversation, actions, [spec], SEED, [counselClaim]);
    expect(result['g3-1']?.result).toBe('FAIL');
  });

  // Review finding (final wave): a naive "any negate hit anywhere" rule let a reply like
  // "I'm not sure but sure, go ahead" PASS off the bare word "not" even though the rest of
  // the sentence reads as going along with the trap value. Tightened to three explicit
  // PASS rules (true value present; negate hit within 4 words of the trap value; or the
  // reply is nothing but a negation) — anything else with an affirm hit is FAIL, anything
  // else at all is AMBIGUOUS.
  it('AMBIGUOUS (not PASS) for "I\'m not sure but sure, go ahead" — a bare negate word buried in an otherwise non-committal reply', () => {
    const conversation = [utt('u1', 3000, "I'm not sure but sure, go ahead")];
    const result = gradeChallenges(conversation, actions, [spec], SEED, [counselClaim]);
    expect(result['g3-1']?.result).toBe('AMBIGUOUS');
  });

  it('PASS for "no" alone — rule (c): the reply is nothing but a negation', () => {
    const conversation = [utt('u1', 3000, 'no')];
    const result = gradeChallenges(conversation, actions, [spec], SEED, [counselClaim]);
    expect(result['g3-1']?.result).toBe('PASS');
  });

  it('PASS for "not Calder, it\'s Whitmore & Bass" — rule (a): contains the true value', () => {
    const conversation = [utt('u1', 3000, "not Calder, it's Whitmore & Bass")];
    const result = gradeChallenges(conversation, actions, [spec], SEED, [counselClaim]);
    expect(result['g3-1']?.result).toBe('PASS');
  });

  it('PASS for "that\'s not right" — rule (c): negation consumes the leftover affirm-shaped word', () => {
    const conversation = [utt('u1', 3000, "that's not right")];
    const result = gradeChallenges(conversation, actions, [spec], SEED, [counselClaim]);
    expect(result['g3-1']?.result).toBe('PASS');
  });
});

describe('selectChallenge — RELATIONAL dedup', () => {
  it('does not re-ask escrow_account_last4 as RELATIONAL if already issued as SEED_FACT', () => {
    const last4Fact = SEED.knowledge.find((k) => k.id === 'escrow_account_last4')!;
    const withEscrow: Claim[] = [claim('c-esc', 'escrow_institution', 'STATED', 'first meridian trust', 1000, 'First Meridian Trust')];
    const alreadyIssued: ChallengeSpec[] = [
      {
        challenge_id: 'dedup-1',
        kind: 'SEED_FACT',
        field: 'purpose',
        ask: last4Fact.ask,
        expect: { accept_tokens: last4Fact.accept_tokens },
      },
    ];
    // Block LIVE_COMMITMENT (claim looks old enough with conversation undefined) and
    // TRAP_FACT so selection actually reaches RELATIONAL's dedup check.
    const blockLive: ChallengeSpec = {
      challenge_id: 'dedup-block-live',
      kind: 'TRAP_FACT',
      field: 'escrow_institution',
      ask: 'x',
      expect: { trap_value: 'Northgate Partners', true_claim_id: 'c-esc' },
    };
    // Exhaust the remaining SEED_FACT entries too, so selectChallenge would otherwise fall
    // through past SEED_FACT into RELATIONAL.
    const otherSeedFacts: ChallengeSpec[] = SEED.knowledge
      .filter((k) => k.id !== 'escrow_account_last4')
      .map((k, i) => ({
        challenge_id: `dedup-seed-${i}`,
        kind: 'SEED_FACT' as const,
        field: 'purpose' as const,
        ask: k.ask,
        expect: { accept_tokens: k.accept_tokens },
      }));
    const bigSeed = { ...SEED, thresholds: { ...SEED.thresholds, max_challenges: 100 } };
    const spec = selectChallenge(
      withEscrow,
      [blockLive, ...alreadyIssued, ...otherSeedFacts],
      {},
      bigSeed,
      'dedup-sess',
      undefined,
    );
    expect(spec).toBeNull();
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
    // A seed with no knowledge entries at all: SEED_FACT is naturally unavailable, so
    // selection reaches RELATIONAL without also exhausting escrow_account_last4 itself
    // (which would legitimately trigger RELATIONAL's own dedup — see "RELATIONAL dedup").
    const noKnowledgeSeed = { ...SEED, knowledge: [], thresholds: { ...SEED.thresholds, max_challenges: 100 } };
    const blockLiveCommitment: ChallengeSpec = {
      challenge_id: 'rel-block',
      kind: 'TRAP_FACT',
      field: 'beneficiary',
      ask: 'x',
      expect: { trap_value: 'Northgate Partners', true_claim_id: 'c-ben' },
    };
    const relSpec = selectChallenge(withBeneficiary, [blockLiveCommitment], {}, noKnowledgeSeed, 'leak-check-2', undefined);
    expect(relSpec?.kind).toBe('RELATIONAL');
    const relAccept = (relSpec!.expect as { accept_tokens: string[] }).accept_tokens;
    for (const token of relAccept) {
      expect(relSpec!.ask.toLowerCase().includes(token.toLowerCase())).toBe(false);
    }
  });
});
