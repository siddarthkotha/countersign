// packages/engine/test/challenges.test.ts
// Task 9: engine-issued challenges. THE LLM MAY ASK, IT MAY NEVER GRADE — `selectChallenge`
// only ever produces a phrasing goal (`ask`) that never leaks the expected answer;
// `gradeChallenges` is the sole, deterministic grader, from plain transcript text.
import { describe, expect, it } from 'vitest';
import { fnv1a, gradeChallenges, isAnswerShapedFor, selectChallenge } from '../src/challenges';
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
  // Identity claim added (founder ruling 2026-09-09, scoping fix): every Hartwell
  // SEED_FACT entry is now scoped to robert-miller, so a claimed identity is required for
  // this Hartwell-flavored fixture (counsel-of-record) to still reach any of them --
  // matches the real call shape, where identity is claimed on the caller's opening line.
  const claims: Claim[] = [
    claim('c-id', 'identity', 'STATED', 'robert-miller', 0, 'Robert Miller'),
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
    // Founder ruling 2026-09-09 ("spent facts"): spec2 (TRAP_FACT) just spoke the true
    // counsel_of_record value ("Calder & Finch") aloud, offering it to a caller who got
    // counsel wrong. Without the spent-fact fix, counsel_of_record (priority 1, the lowest
    // remaining priority) would win this pick, letting the caller simply repeat what the
    // agent itself just said. With the fix, that fact is spent for the rest of the call, so
    // escrow_institution (priority 2, the next-lowest) wins instead.
    expect(spec3?.fact_id).toBe('escrow_institution');

    const spec4 = selectChallenge(claims, [spec1, spec2, spec3!], {}, SEED, 'sess1', conversation);
    expect(spec4).toBeNull();
  });

  it('a fact spoken by TRAP_FACT is never re-asked as SEED_FACT, even directly (founder ruling 2026-09-09, "spent facts")', () => {
    // Isolated, minimal reproduction: identity claimed, a wrong counsel claim (so TRAP_FACT
    // speaks the true counsel_of_record value), then go straight to SEED_FACT selection.
    const spokenClaims: Claim[] = [
      claim('c-id', 'identity', 'STATED', 'robert-miller', 0, 'Robert Miller'),
      claim('c-counsel', 'counsel', 'STATED', 'whitmore and bass', 1000, 'Whitmore and Bass'),
    ];
    // Zero caller turns after the counsel claim (the conversation ends right at t=1000) so
    // it never qualifies for LIVE_COMMITMENT (needs >= 2) and TRAP_FACT gets the first pick.
    const noFollowUp: Utterance[] = [utt('u1', 1000, 'counsel is Whitmore and Bass')];
    const trapSpec = selectChallenge(spokenClaims, [], {}, SEED, 'sess-spent', noFollowUp)!;
    expect(trapSpec.kind).toBe('TRAP_FACT');
    expect(trapSpec.expect).toEqual({ trap_value: 'Calder & Finch', true_claim_id: 'c-counsel' });

    const next = selectChallenge(spokenClaims, [trapSpec], {}, SEED, 'sess-spent', noFollowUp);
    expect(next?.kind).toBe('SEED_FACT');
    // The bug: without the fix this is 'counsel_of_record' (priority 1), letting the
    // caller pass by repeating the value the agent just spoke in the trap.
    expect(next?.fact_id).not.toBe('counsel_of_record');
    expect(next?.fact_id).toBe('escrow_institution');
  });

  it('picks RELATIONAL once a beneficiary/escrow claim exists and both prior kinds are exhausted, grading against the NAMED beneficiary\'s own seeded account (founder ruling 2026-09-09)', () => {
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
    // "meridian supply" is a real seed.payments vendor (pay-4471, account ending 4471) --
    // the sibling bug (founder ruling 2026-09-09) always graded against the unrelated
    // Hartwell escrow account (8830) regardless of who was named; fixed to grade against
    // the NAMED beneficiary's own seeded account, which is entirely independent of
    // seed.knowledge (empty here) since it comes from seed.payments instead.
    expect(spec?.expect).toEqual({ accept_tokens: ['4471'] });
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
    // Founder ruling 2026-09-09 (sibling bug): "meridian supply" is the beneficiary named,
    // so grading must use HER OWN seeded account (pay-4471, ending 4471) -- never the
    // Hartwell escrow account (8830), which is what the old, buggy code always graded
    // against regardless of who was named.
    expect(spec?.expect).toEqual({ accept_tokens: ['4471'] });
  });
});

// Reviewer finding (live test, 2026-09-09): selectSeedFact/factInScope already scope
// SEED_FACT correctly, but selectTrapFact/knowledgeTruthForField did NOT go through the
// same check -- a caller claiming an identity with no rights to a Hartwell fact could still
// get a TRAP_FACT challenge that speaks the true Hartwell value aloud (the "caller was
// wrong: the trap offers the truth" branch), because knowledgeTruthForField looked the
// truth up by FIELD alone, ignoring who is on the line. Fix: gate that truth lookup through
// factInScope using the claimed identity; out of scope -> fall back to the existing
// decoy-only trap (fail-safe), never speak the value.
// Only `ask` is ever SPOKEN to the caller -- `expect` is server-side grading data (e.g.
// RELATIONAL's accept_tokens), never read aloud, so it is out of scope for a "does the
// agent say this out loud" leak check (and, separately, out of scope for this fix: a
// pre-existing gap where selectRelational's escrow branch always grades against Robert
// Miller's own escrow_account_last4 regardless of who is on the line is a real bug but not
// an audible leak, and not what this fix addresses).
function specText(spec: ChallengeSpec): string {
  return spec.ask.toLowerCase();
}

const TRAP_FIELDS: Array<'beneficiary' | 'counsel' | 'escrow_institution' | 'approver'> = [
  'beneficiary',
  'counsel',
  'escrow_institution',
  'approver',
];

describe('TRAP_FACT never leaks a fact scoped to a different identity', () => {
  it('Dana claims an escrow institution: no challenge text contains the Hartwell truth (First Meridian Trust) or its counsel (Calder)', () => {
    const claims: Claim[] = [
      claim('c-id', 'identity', 'STATED', 'dana-whitfield', 0, 'Dana Whitfield'),
      claim('c-escrow', 'escrow_institution', 'STATED', 'northgate bank', 1000, 'Northgate Bank'),
    ];
    const conversation: Utterance[] = [utt('u1', 1000, 'the escrow is with Northgate Bank')];
    let issued: ChallengeSpec[] = [];
    for (let i = 0; i < 10; i++) {
      const spec = selectChallenge(claims, issued, {}, SEED, 'sess-dana-leak', conversation);
      if (!spec) break;
      const text = specText(spec);
      expect(text).not.toContain('first meridian trust');
      expect(text).not.toContain('calder');
      issued = [...issued, spec];
    }
  });

  it("Robert Miller's TRAP_FACT behaviour is unchanged: a wrong counsel claim still offers his own true Hartwell counsel", () => {
    const claims: Claim[] = [
      claim('c-id', 'identity', 'STATED', 'robert-miller', 0, 'Robert Miller'),
      claim('c-counsel', 'counsel', 'STATED', 'whitmore and bass', 1000, 'Whitmore and Bass'),
    ];
    const conversation: Utterance[] = [utt('u1', 1000, 'counsel is Whitmore and Bass')];
    const spec = selectChallenge(claims, [], {}, SEED, 'sess-rm-unchanged', conversation);
    expect(spec?.kind).toBe('TRAP_FACT');
    expect(spec?.field).toBe('counsel');
    expect(spec?.expect).toEqual({ trap_value: 'Calder & Finch', true_claim_id: 'c-counsel' });
  });

  it('general: for every identity and every knowledge-backed trap field, no issued challenge ever speaks a truth scoped to a different identity', () => {
    // Known-safe collision: TRAP_DECOYS.approver ('Marcus Obi') is a plain decoy string
    // that happens to equal Dana's own dana_internal_approver truth -- Marcus Obi really is
    // the org's second approver for everyone, not a secret scoped away from anyone, so his
    // name appearing as a decoy is not the scoping leak this suite guards against.
    const KNOWN_SAFE_DECOYS = new Set(['marcus obi']);

    const identityIds = SEED.identities.map((i) => i.id);
    for (const identityId of identityIds) {
      const outOfScopeTruths = SEED.knowledge
        .filter((k) => k.identity_ids && k.identity_ids.length > 0 && !k.identity_ids.includes(identityId))
        .map((k) => k.truth.toLowerCase())
        .filter((t) => !KNOWN_SAFE_DECOYS.has(t));
      if (outOfScopeTruths.length === 0) continue;

      for (const field of TRAP_FIELDS) {
        const claims: Claim[] = [
          claim('c-id', 'identity', 'STATED', identityId, 0, identityId),
          claim(`c-${field}`, field, 'STATED', 'zzz-not-a-real-value', 1000, 'zzz-not-a-real-value'),
        ];
        const conversation: Utterance[] = [utt('u1', 1000, 'zzz-not-a-real-value')];
        let issued: ChallengeSpec[] = [];
        for (let i = 0; i < 10; i++) {
          const spec = selectChallenge(claims, issued, {}, SEED, `sess-${identityId}-${field}`, conversation);
          if (!spec) break;
          const text = specText(spec);
          for (const truth of outOfScopeTruths) {
            expect(text.includes(truth)).toBe(false);
          }
          issued = [...issued, spec];
        }
      }
    }
  });
});

describe('selectChallenge — determinism', () => {
  it('same inputs twice produce an identical spec', () => {
    const claims: Claim[] = [claim('c1', 'amount_usd', 'STATED', 500, 0, '$500')];
    const a = selectChallenge(claims, [], {}, SEED, 'same-session', undefined);
    const b = selectChallenge(claims, [], {}, SEED, 'same-session', undefined);
    expect(a).toEqual(b);
  });

  it('priority orders SEED_FACT: counsel_of_record, escrow_institution, escrow_account_last4 in that order, across three session ids; the rest keep per-session fnv1a entropy', () => {
    expect(fnv1a('a')).not.toBe(fnv1a('b'));

    // Claimed identity robert-miller ⇒ LIVE_COMMITMENT and TRAP_FACT both find nothing (no
    // other claims at all) ⇒ straight to SEED_FACT, scoped (founder ruling 2026-09-09) to
    // the 6 Hartwell entries -- Dana Whitfield's 3 own facts are out of scope for this
    // caller and never selectable here. `counsel_of_record` (priority 1),
    // `escrow_institution` (priority 2), and `escrow_account_last4` (priority 3, added by
    // the same ruling) must win picks 1-3 in that exact order for EVERY session id -- the
    // founder's ratified demo script. The remaining, unprioritized Hartwell entries keep
    // the pre-existing per-session fnv1a ordering (checked below by confirming the three
    // sessions don't all agree on it).
    const bigMaxSeed = { ...SEED, thresholds: { ...SEED.thresholds, max_challenges: 100 } };
    const robertMiller: Claim[] = [claim('c-id', 'identity', 'STATED', 'robert-miller', 0, 'Robert Miller')];
    const hartwellFactCount = SEED.knowledge.filter((k) => k.identity_ids?.includes('robert-miller')).length;
    const sequences: Record<string, string[]> = {};

    for (const sessionId of ['session-alpha', 'session-beta', 'session-gamma']) {
      const seq: string[] = [];
      let issued: ChallengeSpec[] = [];
      for (let i = 0; i < hartwellFactCount; i++) {
        const spec = selectChallenge(robertMiller, issued, {}, bigMaxSeed, sessionId, undefined);
        expect(spec?.kind).toBe('SEED_FACT');
        seq.push(spec!.fact_id!);
        issued = [...issued, spec!];
      }
      expect(seq[0]).toBe('counsel_of_record');
      expect(seq[1]).toBe('escrow_institution');
      expect(seq[2]).toBe('escrow_account_last4');
      sequences[sessionId] = seq;
    }

    // Entropy preserved: the fourth-onward order is not identical across all three sessions.
    const restOf = (sessionId: string) => sequences[sessionId]!.slice(3).join(',');
    const allIdentical =
      restOf('session-alpha') === restOf('session-beta') && restOf('session-beta') === restOf('session-gamma');
    expect(allIdentical).toBe(false);

    // Dana Whitfield never sees a Hartwell fact: with her identity claimed instead, the
    // sequence is entirely her own facts (dana_*), never one of the 6 robert-miller ids.
    const dana: Claim[] = [claim('c-id2', 'identity', 'STATED', 'dana-whitfield', 0, 'Dana Whitfield')];
    const danaFactCount = SEED.knowledge.filter((k) => k.identity_ids?.includes('dana-whitfield')).length;
    let danaIssued: ChallengeSpec[] = [];
    for (let i = 0; i < danaFactCount; i++) {
      const spec = selectChallenge(dana, danaIssued, {}, bigMaxSeed, 'session-dana', undefined);
      expect(spec?.kind).toBe('SEED_FACT');
      expect(spec!.fact_id!.startsWith('dana_')).toBe(true);
      danaIssued = [...danaIssued, spec!];
    }
    expect(selectChallenge(dana, danaIssued, {}, bigMaxSeed, 'session-dana', undefined)).toBeNull();
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

  // FIX (2026-09-15/16, Dana regression -- scripts/rehearse/reports/2026-09-15T14-27-39-dana-
  // patient.diagnostics.json, PROVEN by direct engine reproduction): grading a just-issued
  // challenge UNANSWERED the INSTANT it's checked, with zero elapsed caller turns, defeated
  // fsm.ts's `awaitingChallenge` re-ask-verbatim protection on literally the very next tick --
  // before the caller had any chance to reply -- letting the engine race ahead to a genuinely
  // NEW challenge (a fresh challenge_id) and then grade the caller's real, on-topic answer FAIL
  // against the wrong one once it finally arrived. `gradeChallenges` must give the SAME
  // `challenge_answer_window_ms` grace `compose.ts`'s `computeChallengeAwaitingAnswer` already
  // grants for the identical "is this still awaiting" question before conceding UNANSWERED for
  // lack of ANY reply.
  it('still AWAITING (no entry at all), not UNANSWERED, immediately after issue -- before the answer window has had any time to elapse', () => {
    const result = gradeChallenges([], actions, [spec], SEED, []);
    expect(result['g1-1']).toBeUndefined();
  });

  it('UNANSWERED once the full answer window has elapsed with still no caller utterance at all', () => {
    const windowMs = SEED.thresholds.challenge_answer_window_ms;
    // Any later event (an agent line, not a caller reply) proves real time/conversation has
    // moved on past the window -- `challengeReplyWindowStatus` counts every speaker, since the
    // signal is "has the caller genuinely had the chance", not "did the caller specifically
    // speak again".
    const laterAgentLine = utt('a-later', 6000 + windowMs, 'Still on the line?', 'agent');
    const result = gradeChallenges([laterAgentLine], actions, [spec], SEED, []);
    expect(result['g1-1']).toEqual({ result: 'UNANSWERED', eligible_utterance_ids: [] });
  });

  it('an utterance after a second challenge_issued is NOT eligible for the first, and the first grades UNANSWERED right away (a later, different challenge already bounds its window, regardless of elapsed time)', () => {
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

  // FIX (2026-09-15, fragment-shaped challenges): "why do you need that" carries no amount
  // signal at all (no digits, no dollar figure) -- `isAnswerShapedFor` now leaves a reply
  // like this AWAITING rather than grading it AMBIGUOUS the instant it lands, so a caller
  // line AssemblyAI's endpointing splits mid-sentence doesn't burn the pending challenge on
  // its first, content-free fragment. With only one such reply recorded (under
  // `seed.thresholds.max_challenge_reasks`), gradeChallenges omits this challenge_id from
  // its output entirely -- see test/fsm.test.ts's "still awaiting" cases for the
  // re-ask-the-same-question behavior this feeds, and the "exhausts the re-ask budget" case
  // below for what happens once the cap is reached.
  it('leaves the challenge AWAITING (no entry at all) when the caller neither confirms nor states a number', () => {
    const conversation = [utt('u1', 3000, 'why do you need that')];
    const result = gradeChallenges(conversation, actions, [spec], SEED, [amountClaim]);
    expect(result['g2-1']).toBeUndefined();
  });

  it('exhausts the re-ask budget: two non-answer-shaped replies grade UNANSWERED, not AMBIGUOUS', () => {
    const twoReplies = [utt('u1', 3000, 'why do you need that'), utt('u2', 3200, 'seriously, why')];
    const result = gradeChallenges(twoReplies, actions, [spec], SEED, [amountClaim]);
    expect(result['g2-1']?.result).toBe('UNANSWERED');
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

  // FIX (2026-09-15, fragment-shaped challenges): "hmm" carries none of the signals
  // `isAnswerShapedFor` checks for a TRAP_FACT reply (the true value, the trap value, a
  // negation, or an affirm-lexicon hit) -- it leaves the challenge AWAITING (no entry at
  // all) rather than grading it AMBIGUOUS immediately, same reasoning as the LIVE_COMMITMENT
  // case above.
  it('leaves the challenge AWAITING (no entry at all) when the caller neither affirms nor objects', () => {
    const conversation = [utt('u1', 3000, 'hmm')];
    const result = gradeChallenges(conversation, actions, [spec], SEED, [counselClaim]);
    expect(result['g3-1']).toBeUndefined();
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

  // FIX (2026-09-15, fragment-shaped challenges): same word-boundary point as before ("right"
  // inside "alright" is not a genuine affirm hit), but "Alright, that's fine" carries no OTHER
  // answer signal either (no true/trap value, no negation) -- so it now leaves the challenge
  // AWAITING rather than reaching AMBIGUOUS grading at all.
  it('leaves the challenge AWAITING for "Alright, that\'s fine" — no genuine affirm word (not "right" inside "alright") and no other answer signal', () => {
    const conversation = [utt('u1', 3000, "Alright, that's fine")];
    const result = gradeChallenges(conversation, actions, [spec], SEED, [counselClaim]);
    expect(result['g3-1']).toBeUndefined();
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
  // FIX (2026-09-15, fragment-shaped challenges): "sure" is not in affirm_lexicon and "not"
  // here strips to a multi-word remainder (not a pure negation), so this reply still carries
  // no answer signal for `isAnswerShapedFor` -- it now leaves the challenge AWAITING (never
  // reaching AMBIGUOUS grading) rather than PASS, same never-PASS guarantee as before, one
  // step earlier in the pipeline.
  it('leaves the challenge AWAITING (never PASS) for "I\'m not sure but sure, go ahead" — a bare negate word buried in an otherwise non-committal reply', () => {
    const conversation = [utt('u1', 3000, "I'm not sure but sure, go ahead")];
    const result = gradeChallenges(conversation, actions, [spec], SEED, [counselClaim]);
    expect(result['g3-1']).toBeUndefined();
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

// FIX (finding 1, Sonnet review, 2026-09-15/16): `isAnswerShapedFor` (via `hasNameSignal`)
// now also recognizes a single word matching any seed-known identity/alias/first name/last
// name/place/institution token, and (via `hasFieldSignal`) a compound/doubled digit-word
// reading of an account-style number -- catching genuine but cue-less/terse replies that
// were previously left permanently AWAITING (never graded at all, wasting the re-ask
// budget). These call `isAnswerShapedFor` directly since the account_last4 case is not
// reachable through a real `selectChallenge`-produced LIVE_COMMITMENT/TRAP_FACT spec today
// (account_last4 is never one of `LIVE_COMMITMENT_FIELDS`/`TRAP_FIELD_ORDER`) -- exercised
// here as a defensive/exhaustiveness fix per the function's own comment ("in case that
// invariant is ever loosened").
describe('isAnswerShapedFor — finding 1 (Sonnet review, 2026-09-15/16): seed-known name/place tokens and compound digit words', () => {
  it('TRAP_FACT: "it was Marcus" is answer-shaped (single known first name, no cue verb) -- was previously left AWAITING', () => {
    const trueClaim = claim('c-appr', 'approver', 'STATED', 'marcus obi', 1000, 'Marcus Obi');
    const spec: ChallengeSpec = {
      challenge_id: 'nm-1',
      kind: 'TRAP_FACT',
      field: 'approver',
      ask: 'x',
      expect: { trap_value: 'Northgate Partners', true_claim_id: 'c-appr' },
    };
    expect(isAnswerShapedFor(spec, 'It was Marcus.', SEED, [trueClaim])).toBe(true);

    // End-to-end through gradeChallenges: the challenge is now actually GRADED (a real
    // AMBIGUOUS card -- the bare first name still doesn't match the full committed "Marcus
    // Obi" well enough for gradeTrapFact to PASS it) instead of silently staying AWAITING
    // forever with no evidence card at all.
    const actions: AgentAction[] = [issuedAction('a1', 'nm-1', 2000)];
    const conversation = [utt('u1', 3000, 'It was Marcus.')];
    const result = gradeChallenges(conversation, actions, [spec], SEED, [trueClaim]);
    expect(result['nm-1']?.result).toBe('AMBIGUOUS');
  });

  it('LIVE_COMMITMENT: "the one in Zurich" is answer-shaped (single known seed place, no cue verb) -- was previously left AWAITING', () => {
    const committed = claim('c-esc', 'escrow_institution', 'STATED', 'first meridian trust', 1000, 'First Meridian Trust');
    const spec: ChallengeSpec = {
      challenge_id: 'nm-2',
      kind: 'LIVE_COMMITMENT',
      field: 'escrow_institution',
      ask: 'x',
      expect: { commitment_claim_id: 'c-esc' },
    };
    expect(isAnswerShapedFor(spec, 'The one in Zurich.', SEED, [committed])).toBe(true);
  });

  // LIVE_COMMITMENT (not TRAP_FACT): TRAP_FACT's affirm-lexicon shortcut already makes a
  // bare "yes" answer-shaped for an unrelated, pre-existing reason (it affirms the trap
  // value) -- LIVE_COMMITMENT's name-field branch has no such shortcut, so it isolates
  // whether the seedNameTokens addition itself introduces a false positive.
  it('does not loosen so far that a bare "yes" or unrelated prose becomes answer-shaped', () => {
    const committed = claim('c-appr2', 'approver', 'STATED', 'marcus obi', 1000, 'Marcus Obi');
    const spec: ChallengeSpec = {
      challenge_id: 'nm-3',
      kind: 'LIVE_COMMITMENT',
      field: 'approver',
      ask: 'x',
      expect: { commitment_claim_id: 'c-appr2' },
    };
    expect(isAnswerShapedFor(spec, 'yes', SEED, [committed])).toBe(false);
    expect(isAnswerShapedFor(spec, 'the final figure moved this morning', SEED, [committed])).toBe(false);
  });

  it('account_last4 field-signal: a compound tens+ones digit-word reading ("eighty-eight thirty") is answer-shaped, not just literal digits or single spelled digits', () => {
    const committed = claim('c-acct', 'account_last4', 'STATED', '8830', 1000, '8830');
    const spec: ChallengeSpec = {
      challenge_id: 'nm-4',
      kind: 'LIVE_COMMITMENT',
      field: 'account_last4',
      ask: 'x',
      expect: { commitment_claim_id: 'c-acct' },
    };
    // Old behavior: neither the bare `\d{2,}` numeral check nor the single-spelled-digit
    // check fires on tens words like "eighty"/"thirty" at all.
    expect(isAnswerShapedFor(spec, 'Eighty-eight, thirty.', SEED, [committed])).toBe(true);
    expect(isAnswerShapedFor(spec, 'Double eight, three oh.', SEED, [committed])).toBe(true);
  });
});

// CRITICAL FIX (2026-09-16, name-tokens lane, Sonnet review of 6a81b98): `seedNameTokens`
// used to add every word of every seed.knowledge `accept_tokens` entry and every payment
// vendor/alias, so `hasNameSignal` treated common words that merely appear INSIDE a longer
// seeded org/place name ("first", "trust", "supply", "co", "parts") as name signals all by
// themselves. That made ordinary filler answer-shaped for a pending TRAP_FACT challenge,
// grading an honest caller's unrelated small talk AMBIGUOUS (0.5) and closing the awaiting
// window early. Fixed: organisation/place names now count only as WHOLE PHRASES (matched
// intact, never split into their individual words); only PERSON names (seed identities'
// full names and aliases) contribute single-word tokens, and only when >= 3 characters and
// not in the small common-word stoplist.
describe('isAnswerShapedFor — CRITICAL (Sonnet review of 6a81b98, 2026-09-16): name tokens come only from person names and whole-phrase org/place names', () => {
  const trueClaim = claim('c-counsel-nt', 'counsel', 'STATED', 'calder and finch', 1000, 'Calder & Finch');
  const spec: ChallengeSpec = {
    challenge_id: 'nt-1',
    kind: 'TRAP_FACT',
    field: 'counsel',
    ask: 'x',
    expect: { trap_value: 'Whitmore & Bass', true_claim_id: 'c-counsel-nt' },
  };

  it('"Trust me, this is legitimate." is NOT answer-shaped (the word "trust" alone, from "First Meridian Trust", must not count)', () => {
    expect(isAnswerShapedFor(spec, 'Trust me, this is legitimate.', SEED, [trueClaim])).toBe(false);
  });

  it('"We supply parts to them regularly." is NOT answer-shaped (the words "supply"/"parts", from "Meridian Supply"/"Quarterly parts restock", must not count)', () => {
    expect(isAnswerShapedFor(spec, 'We supply parts to them regularly.', SEED, [trueClaim])).toBe(false);
  });

  it('"the first one" is NOT answer-shaped (the word "first", from "First Meridian Trust", must not count)', () => {
    expect(isAnswerShapedFor(spec, 'the first one', SEED, [trueClaim])).toBe(false);
  });

  it('"it was Marcus" IS answer-shaped (a real seeded person first name, cue-less)', () => {
    expect(isAnswerShapedFor(spec, 'it was Marcus', SEED, [trueClaim])).toBe(true);
  });

  it('"Marcus" alone IS answer-shaped', () => {
    expect(isAnswerShapedFor(spec, 'Marcus', SEED, [trueClaim])).toBe(true);
  });

  it('"Calder and Finch" IS answer-shaped (whole-phrase org match)', () => {
    expect(isAnswerShapedFor(spec, 'Calder and Finch', SEED, [trueClaim])).toBe(true);
  });

  it('"the one in Zurich" IS answer-shaped (whole-phrase, single-word place)', () => {
    expect(isAnswerShapedFor(spec, 'the one in Zurich', SEED, [trueClaim])).toBe(true);
  });

  it('"First Meridian Trust" IS answer-shaped (whole-phrase org match, and also the bare two-capitalized-word check)', () => {
    expect(isAnswerShapedFor(spec, 'First Meridian Trust', SEED, [trueClaim])).toBe(true);
  });
});

describe('gradeChallenges — accept_tokens digit-word matching (finding 1, Sonnet review, 2026-09-15/16)', () => {
  it('RELATIONAL account challenge PASSes when the digits are read back as compound number words ("forty-four seventy-one" -> 4471)', () => {
    const beneficiaryClaim = claim('c-ben3', 'beneficiary', 'STATED', 'meridian supply', 1000, 'Meridian Supply');
    const spec: ChallengeSpec = {
      challenge_id: 'dg-1',
      kind: 'RELATIONAL',
      field: 'account_last4',
      ask: 'Ask for the last four digits of the account attached to the beneficiary they named.',
      expect: { accept_tokens: ['4471'] },
    };
    const actions: AgentAction[] = [issuedAction('a1', 'dg-1', 2000)];
    const conversation = [utt('u1', 3000, 'Forty-four, seventy-one.')];
    const result = gradeChallenges(conversation, actions, [spec], SEED, [beneficiaryClaim]);
    expect(result['dg-1']?.result).toBe('PASS');
  });

  it('RELATIONAL account challenge PASSes when the digits are read back as single spelled-out digits ("double four seven one" -> 4471)', () => {
    const beneficiaryClaim = claim('c-ben4', 'beneficiary', 'STATED', 'meridian supply', 1000, 'Meridian Supply');
    const spec: ChallengeSpec = {
      challenge_id: 'dg-2',
      kind: 'RELATIONAL',
      field: 'account_last4',
      ask: 'Ask for the last four digits of the account attached to the beneficiary they named.',
      expect: { accept_tokens: ['4471'] },
    };
    const actions: AgentAction[] = [issuedAction('a1', 'dg-2', 2000)];
    const conversation = [utt('u1', 3000, 'Double four, seven one.')];
    const result = gradeChallenges(conversation, actions, [spec], SEED, [beneficiaryClaim]);
    expect(result['dg-2']?.result).toBe('PASS');
  });

  it('still FAILs a wrong digit-word reading, not a vacuous PASS', () => {
    const beneficiaryClaim = claim('c-ben5', 'beneficiary', 'STATED', 'meridian supply', 1000, 'Meridian Supply');
    const spec: ChallengeSpec = {
      challenge_id: 'dg-3',
      kind: 'RELATIONAL',
      field: 'account_last4',
      ask: 'Ask for the last four digits of the account attached to the beneficiary they named.',
      expect: { accept_tokens: ['4471'] },
    };
    const actions: AgentAction[] = [issuedAction('a1', 'dg-3', 2000)];
    const conversation = [utt('u1', 3000, 'Ninety-nine, twelve.')];
    const result = gradeChallenges(conversation, actions, [spec], SEED, [beneficiaryClaim]);
    expect(result['dg-3']?.result).toBe('FAIL');
  });

  // CRITICAL FIX (2026-09-16, name-tokens lane, Sonnet review of 6a81b98): normalizeSpokenDigits
  // must run PER ELIGIBLE UTTERANCE, never over an already-joined multi-utterance string --
  // joining "eighty-eight" and "thirty" from two SEPARATE caller turns with a single space (the
  // same join gradeChallenges always does before grading) is byte-for-byte identical to one
  // utterance saying "eighty-eight thirty", so only normalizing each utterance's own text
  // separately (never the joined result) can tell them apart.
  it('a RELATIONAL digit challenge does NOT PASS when the digits arrive as two separate caller utterances ("eighty-eight" then "thirty")', () => {
    const beneficiaryClaim = claim('c-ben6', 'beneficiary', 'STATED', 'meridian supply', 1000, 'Meridian Supply');
    const spec: ChallengeSpec = {
      challenge_id: 'dg-4',
      kind: 'RELATIONAL',
      field: 'account_last4',
      ask: 'Ask for the last four digits of the account attached to the beneficiary they named.',
      expect: { accept_tokens: ['8830'] },
    };
    const actions: AgentAction[] = [issuedAction('a1', 'dg-4', 2000)];
    const conversation = [utt('u1', 3000, 'eighty-eight'), utt('u2', 3200, 'thirty')];
    const result = gradeChallenges(conversation, actions, [spec], SEED, [beneficiaryClaim]);
    expect(result['dg-4']?.result).not.toBe('PASS');
  });

  // Same shape, but the SAME single utterance saying both words together: must still PASS
  // (the fix must not overcorrect into never merging within one real utterance).
  it('the same digits DO PASS when spoken in one continuous caller utterance ("eighty-eight thirty")', () => {
    const beneficiaryClaim = claim('c-ben7', 'beneficiary', 'STATED', 'meridian supply', 1000, 'Meridian Supply');
    const spec: ChallengeSpec = {
      challenge_id: 'dg-5',
      kind: 'RELATIONAL',
      field: 'account_last4',
      ask: 'Ask for the last four digits of the account attached to the beneficiary they named.',
      expect: { accept_tokens: ['8830'] },
    };
    const actions: AgentAction[] = [issuedAction('a1', 'dg-5', 2000)];
    const conversation = [utt('u1', 3000, 'eighty-eight thirty')];
    const result = gradeChallenges(conversation, actions, [spec], SEED, [beneficiaryClaim]);
    expect(result['dg-5']?.result).toBe('PASS');
  });
});

// FIX (finding 2, Sonnet review, 2026-09-15/16): `max_challenge_reasks` now actually controls
// both the eligible-utterance window size and the grading cap, wired to the same seeded
// value. Proven with the seed value overridden to 3: under the old hardcoded-window-of-2 bug,
// `eligibleUtterances` could never collect a 3rd caller utterance no matter how many
// non-answer-shaped fragments arrived, so `eligible.length` could never reach a
// `max_challenge_reasks` of 3 and the challenge would stay AWAITING forever -- this exact
// scenario (3 non-answer-shaped fragments, cap 3) is only reachable/exhaustible with the fix.
describe('gradeChallenges — max_challenge_reasks is live, not cosmetic (finding 2, Sonnet review, 2026-09-15/16)', () => {
  const SEED_CAP3 = { ...SEED, thresholds: { ...SEED.thresholds, max_challenge_reasks: 3 } };
  const amountClaim = claim('c-amt2', 'amount_usd', 'STATED', 1_800_000, 1000, '1.8 million');
  const spec: ChallengeSpec = {
    challenge_id: 'cap-1',
    kind: 'LIVE_COMMITMENT',
    field: 'amount_usd',
    ask: 'x',
    expect: { commitment_claim_id: 'c-amt2' },
  };
  const actions: AgentAction[] = [issuedAction('a1', 'cap-1', 2000)];

  it('with a seed cap of 3, two non-answer-shaped fragments still leave the challenge AWAITING (window not exhausted yet)', () => {
    const conversation = [utt('u1', 3000, 'why do you need that'), utt('u2', 3200, 'seriously, why')];
    const result = gradeChallenges(conversation, actions, [spec], SEED_CAP3, [amountClaim]);
    expect(result['cap-1']).toBeUndefined();
  });

  it('with a seed cap of 3, a THIRD non-answer-shaped fragment exhausts the window to UNANSWERED -- only reachable because the window itself is now sized to the seeded cap, not hardcoded to 2', () => {
    const conversation = [
      utt('u1', 3000, 'why do you need that'),
      utt('u2', 3200, 'seriously, why'),
      utt('u3', 3400, 'come on, really'),
    ];
    const result = gradeChallenges(conversation, actions, [spec], SEED_CAP3, [amountClaim]);
    expect(result['cap-1']?.result).toBe('UNANSWERED');
  });
});

describe('selectChallenge — RELATIONAL grades against the named beneficiary\'s own account (founder ruling 2026-09-09, sibling bug)', () => {
  it('grades against the beneficiary\'s own seeded account (Meridian Supply -> 4471), never the unrelated Hartwell escrow account (8830)', () => {
    const withBeneficiary: Claim[] = [claim('c-ben', 'beneficiary', 'STATED', 'meridian supply', 1000, 'Meridian Supply')];
    const blockLive: ChallengeSpec = {
      challenge_id: 'sib-block-live',
      kind: 'TRAP_FACT',
      field: 'beneficiary',
      ask: 'x',
      expect: { trap_value: 'Northgate Partners', true_claim_id: 'c-ben' },
    };
    const bigSeed = { ...SEED, thresholds: { ...SEED.thresholds, max_challenges: 100 } };
    const spec = selectChallenge(withBeneficiary, [blockLive], {}, bigSeed, 'sib-sess', undefined);
    expect(spec?.kind).toBe('RELATIONAL');
    // The bug: the old code always graded against seed.knowledge's escrow_account_last4
    // (8830) regardless of who the caller named. Fixed to look up the NAMED beneficiary's
    // own scheduled payment (pay-4471, Meridian Supply, account ending 4471) instead.
    expect(spec?.expect).toEqual({ accept_tokens: ['4471'] });
    expect(spec?.expect).not.toEqual({ accept_tokens: ['8830'] });
  });

  it('returns no RELATIONAL challenge (fail-safe null, not a wrong grade) when the named beneficiary has no seeded payment on file', () => {
    const unknownBeneficiary: Claim[] = [
      claim('c-ben2', 'beneficiary', 'STATED', 'colinwood analytics', 1000, 'Colinwood Analytics'),
    ];
    const blockLive: ChallengeSpec = {
      challenge_id: 'unk-block-live',
      kind: 'TRAP_FACT',
      field: 'beneficiary',
      ask: 'x',
      expect: { trap_value: 'Northgate Partners', true_claim_id: 'c-ben2' },
    };
    const bigSeed = { ...SEED, thresholds: { ...SEED.thresholds, max_challenges: 100 } };
    // Only LIVE_COMMITMENT/TRAP_FACT/RELATIONAL/SEED_FACT are checked; with TRAP_FACT
    // already issued and no LIVE_COMMITMENT-eligible claim (no conversation), selection
    // reaches RELATIONAL, finds no payment for "Colinwood Analytics", and must fall through
    // to SEED_FACT (a real Hartwell/robert-miller fact here) rather than fabricate a wrong
    // grade -- so assert on the RELATIONAL step directly instead, via a seed with no
    // knowledge entries at all so SEED_FACT can't mask the result.
    const noKnowledgeSeed = { ...bigSeed, knowledge: [] };
    const spec = selectChallenge(unknownBeneficiary, [blockLive], {}, noKnowledgeSeed, 'unk-sess', undefined);
    expect(spec).toBeNull();
  });
});

describe('selectChallenge — RELATIONAL escrow branch grades against the identity who named the escrow institution (RT-9b-escrow-grading)', () => {
  it('Robert Miller names the Hartwell escrow institution: RELATIONAL grades against his own escrow_account_last4 (8830)', () => {
    const claims: Claim[] = [
      claim('c-id', 'identity', 'STATED', 'robert-miller', 0, 'Robert Miller'),
      claim('c-esc', 'escrow_institution', 'STATED', 'first meridian trust', 1000, 'First Meridian Trust'),
    ];
    const blockLive: ChallengeSpec = {
      challenge_id: 'rm-block-live',
      kind: 'TRAP_FACT',
      field: 'escrow_institution',
      ask: 'x',
      expect: { trap_value: 'Harbor Fidelity Trust', true_claim_id: 'c-esc' },
    };
    const bigSeed = { ...SEED, thresholds: { ...SEED.thresholds, max_challenges: 100 } };
    const spec = selectChallenge(claims, [blockLive], {}, bigSeed, 'rm-esc-sess', undefined);
    expect(spec?.kind).toBe('RELATIONAL');
    expect(spec?.expect).toEqual({ accept_tokens: ['8830'] });
  });

  it('bug reproduction: Dana Whitfield names an escrow institution that is not hers -- must never be graded against Robert Miller\'s escrow_account_last4 (8830)', () => {
    // Dana Whitfield has no Hartwell business at all -- escrow_account_last4 is scoped
    // (identity_ids: ['robert-miller']) to Robert Miller only. The old code's escrow branch
    // looked up seed.knowledge's escrow_account_last4 by id alone, with no identity gate, so
    // ANY caller who named ANY escrow institution was graded against Robert Miller's digits
    // regardless of who was actually on the line -- found by the trap-scope lane, 2026-09-09.
    const claims: Claim[] = [
      claim('c-id', 'identity', 'STATED', 'dana-whitfield', 0, 'Dana Whitfield'),
      claim('c-esc', 'escrow_institution', 'STATED', 'northgate bank', 1000, 'Northgate Bank'),
    ];
    const blockLive: ChallengeSpec = {
      challenge_id: 'dana-block-live',
      kind: 'TRAP_FACT',
      field: 'escrow_institution',
      ask: 'x',
      expect: { trap_value: 'Harbor Fidelity Trust', true_claim_id: 'c-esc' },
    };
    const bigSeed = { ...SEED, thresholds: { ...SEED.thresholds, max_challenges: 100 } };
    const spec = selectChallenge(claims, [blockLive], {}, bigSeed, 'dana-esc-sess', undefined);
    // Dana has no escrow account of her own in this seed -- there is nothing correct to
    // grade against, so RELATIONAL must fail safe (same shape as selectSeedFact's
    // out-of-scope null) rather than reach for Robert Miller's account.
    expect(spec?.expect).not.toEqual({ accept_tokens: ['8830'] });
    expect(spec?.kind).not.toBe('RELATIONAL');
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

// CHALLENGE-SPEAKABLE (2026-09-11, backlog): FIX7 (571ee31) gave the READBACK goal a
// deterministic, ready-to-speak sentence composed by the engine instead of a prose
// instruction for the LLM to paraphrase (fsm.ts's `readbackSentence`). Challenge questions
// were left as prose ("Ask the caller to restate X...", "Confirm the request back... say Y
// in place of Z"), which is why the server's ASK_CHALLENGE prompt (prompt.ts) still tells
// the model to phrase the direction "in your own words" instead of relaying it verbatim --
// see that file's "Parked follow-up" comment. These tests pin down the same treatment for
// every `ChallengeSpec.speak`: a deterministic, natural, speakable sentence that never names
// a raw field id, never asks for an identifier/code, and never leaks a fact belonging to a
// different claimed identity. Wiring the server to require verbatim speech is a separate,
// deliberately un-taken step (see fsm.test.ts's ASK_CHALLENGE section and this task's report).
describe('selectChallenge — speak: a deterministic, ready-to-speak sentence per kind', () => {
  const FORBIDDEN_RE = /\b(id|ids|identifier|code|ssn|ein|password|pin)\b/i;
  const RAW_FIELD_RE = /amount_usd|account_last4|escrow_institution(?!\s)/;

  it('LIVE_COMMITMENT: asks to restate the field in spoken words, never the raw field id or the value itself', () => {
    const claims: Claim[] = [claim('c-amount', 'amount_usd', 'STATED', 84_500, 1000, '$84,500')];
    const conversation: Utterance[] = [
      utt('u1', 1000, "it's $84,500"),
      utt('u2', 2000, 'still here'),
      utt('u3', 3000, 'one more thing'),
    ];
    const spec = selectChallenge(claims, [], {}, SEED, 'speak-live', conversation);
    expect(spec?.kind).toBe('LIVE_COMMITMENT');
    expect(spec?.speak).toBe('Can you restate the amount in dollars you gave me earlier?');
    expect(spec!.speak).not.toMatch(RAW_FIELD_RE);
    expect(spec!.speak).not.toMatch(FORBIDDEN_RE);
    expect(spec!.speak).not.toContain('84,500'); // never says the value back
    expect(spec!.speak!.trim().endsWith('?')).toBe(true);
  });

  it('TRAP_FACT: states the wrong value back as a plain confirmation, one field, no raw field id', () => {
    // The claim's own utterance is the LAST one in `conversation` (0 caller turns after
    // it), which disqualifies it from LIVE_COMMITMENT (< 2 turns old -- see
    // `callerTurnsAfter`) so selection falls through to TRAP_FACT, same technique the
    // file's first describe block ("selectChallenge — selection order") already uses.
    const claims: Claim[] = [claim('c-cns', 'counsel', 'STATED', 'whitmore and bass', 1000, 'Whitmore and Bass')];
    const conversation: Utterance[] = [utt('u1', 1000, 'counsel is Whitmore and Bass')];
    const spec = selectChallenge(claims, [], {}, SEED, 'speak-trap', conversation);
    expect(spec?.kind).toBe('TRAP_FACT');
    const trapValue = (spec!.expect as { trap_value: string }).trap_value;
    expect(spec?.speak).toBe(`Just to confirm, our counsel of record is ${trapValue}. Is that correct?`);
    expect(spec!.speak).not.toMatch(FORBIDDEN_RE);
    expect(spec!.speak!.trim().endsWith('?')).toBe(true);
  });

  it('TRAP_FACT: every trap field gets natural, distinct phrasing (no field enum names)', () => {
    const fixtures: { field: Claim['field']; value: string; quoteText: string }[] = [
      { field: 'beneficiary', value: 'meridian supply', quoteText: 'Meridian Supply' },
      { field: 'escrow_institution', value: 'first meridian trust', quoteText: 'First Meridian Trust' },
      { field: 'approver', value: 'marcus obi', quoteText: 'Marcus Obi' },
    ];
    for (const { field, value, quoteText } of fixtures) {
      const claims: Claim[] = [claim(`c-${field}`, field, 'STATED', value, 1000, quoteText)];
      const conversation: Utterance[] = [utt('u1', 1000, quoteText)];
      const spec = selectChallenge(claims, [], {}, SEED, `speak-trap-${field}`, conversation);
      expect(spec?.kind).toBe('TRAP_FACT');
      expect(spec?.field).toBe(field);
      const trapValue = (spec!.expect as { trap_value: string }).trap_value;
      expect(spec!.speak).toContain(trapValue);
      expect(spec!.speak).toMatch(/is that correct\?/i);
      expect(spec!.speak).not.toMatch(RAW_FIELD_RE);
      expect(spec!.speak).not.toMatch(FORBIDDEN_RE);
    }
  });

  it('RELATIONAL: asks for the last four digits in plain words, names the human field, no raw field id', () => {
    const withBeneficiary: Claim[] = [claim('c-ben', 'beneficiary', 'STATED', 'meridian supply', 1000, 'Meridian Supply')];
    const noKnowledgeSeed = { ...SEED, knowledge: [], thresholds: { ...SEED.thresholds, max_challenges: 100 } };
    // Same blocker technique as "selectChallenge — RELATIONAL grades against the named
    // beneficiary's own account" above: a placeholder TRAP_FACT already issued on the
    // `beneficiary` field blocks both LIVE_COMMITMENT (field already issued) and TRAP_FACT
    // (kind already issued, once-per-call), so selection reaches RELATIONAL.
    const blockLive: ChallengeSpec = {
      challenge_id: 'speak-rel-block',
      kind: 'TRAP_FACT',
      field: 'beneficiary',
      ask: 'x',
      expect: { trap_value: 'Northgate Partners', true_claim_id: 'c-ben' },
    };
    const spec = selectChallenge(withBeneficiary, [blockLive], {}, noKnowledgeSeed, 'speak-rel', undefined);
    expect(spec?.kind).toBe('RELATIONAL');
    expect(spec?.speak).toBe('Can you give me the last four digits of the account attached to the beneficiary you named?');
    expect(spec!.speak).not.toMatch(RAW_FIELD_RE);
    expect(spec!.speak).not.toMatch(FORBIDDEN_RE);
    expect(spec!.speak!.trim().endsWith('?')).toBe(true);
  });

  it('SEED_FACT: turns the seed author\'s "Ask ..." instruction into a direct, capitalized question', () => {
    const claims: Claim[] = [claim('c-id', 'identity', 'STATED', 'robert-miller', 0, 'Robert Miller')];
    const spec = selectChallenge(claims, [], {}, SEED, 'speak-seed', undefined);
    expect(spec?.kind).toBe('SEED_FACT');
    expect(spec?.fact_id).toBe('counsel_of_record'); // priority 1, the ratified demo opener
    expect(spec?.ask).toBe('Ask which law firm is our counsel of record on the Hartwell deal.');
    expect(spec?.speak).toBe('Which law firm is our counsel of record on the Hartwell deal?');
    expect(spec!.speak!.startsWith('Ask')).toBe(false);
    expect(spec!.speak!.trim().endsWith('?')).toBe(true);
  });

  it('SEED_FACT: never surfaces a fact belonging to a different claimed identity (Dana never gets a Hartwell/robert-miller speak line)', () => {
    const dana: Claim[] = [claim('c-id2', 'identity', 'STATED', 'dana-whitfield', 0, 'Dana Whitfield')];
    const spec = selectChallenge(dana, [], {}, SEED, 'speak-dana', undefined);
    expect(spec?.kind).toBe('SEED_FACT');
    expect(spec!.fact_id!.startsWith('dana_')).toBe(true);
    expect(spec!.speak).not.toMatch(/hartwell|calder|finch|voss|zurich/i);
  });

  it('every generated spec across a full selection sequence carries a non-empty, question-shaped speak with no raw field id and no forbidden id/code words', () => {
    const claims: Claim[] = [
      claim('c-id', 'identity', 'STATED', 'robert-miller', 0, 'Robert Miller'),
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
    const bigMaxSeed = { ...SEED, thresholds: { ...SEED.thresholds, max_challenges: 100 } };
    let issued: ChallengeSpec[] = [];
    for (let i = 0; i < 20; i++) {
      const spec = selectChallenge(claims, issued, {}, bigMaxSeed, 'speak-sweep', conversation);
      if (!spec) break;
      expect(spec.speak).toBeTruthy();
      expect(spec.speak!.trim().length).toBeGreaterThan(0);
      expect(spec.speak!.trim().endsWith('?')).toBe(true);
      expect(spec.speak).not.toMatch(RAW_FIELD_RE);
      expect(spec.speak).not.toMatch(FORBIDDEN_RE);
      issued = [...issued, spec];
    }
    expect(issued.length).toBeGreaterThan(0);
  });

  it('is deterministic: the same inputs always compose the same speak text', () => {
    const claims: Claim[] = [claim('c-cns', 'counsel', 'STATED', 'whitmore and bass', 1000, 'Whitmore and Bass')];
    const spec1 = selectChallenge(claims, [], {}, SEED, 'speak-det', undefined);
    const spec2 = selectChallenge(claims, [], {}, SEED, 'speak-det', undefined);
    expect(spec1?.speak).toBe(spec2?.speak);
  });
});
