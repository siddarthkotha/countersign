// packages/engine/test/challenges.test.ts
// Task 9: engine-issued challenges. THE LLM MAY ASK, IT MAY NEVER GRADE — `selectChallenge`
// only ever produces a phrasing goal (`ask`) that never leaks the expected answer;
// `gradeChallenges` is the sole, deterministic grader, from plain transcript text.
import { describe, expect, it } from 'vitest';
import { fnv1a, gradeChallenges, isAnswerShapedFor, selectChallenge } from '../src/challenges';
import { normalizeText } from '../src/normalize';
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
    // FIX (2026-09-18, founder live defect): TRAP_DECOYS.approver used to be 'Marcus Obi',
    // which is not a scoping leak (Marcus Obi is the org's real second approver for
    // everyone, not a secret scoped away from anyone) but IS a decoy that equals the seed's
    // own truth -- a different, more serious bug (see the
    // "TRAP_FACT approver: a decoy must never equal the seed truth..." describe block
    // below), now fixed by replacing it with a synthetic name ('Priya Ramanathan') that
    // matches no seed identity at all. This set is kept empty (not deleted) so a future
    // decoy choice that reintroduces a real scoped-or-unscoped seed name still has an
    // explicit, intentional place to be logged as safe, rather than silently allowed.
    const KNOWN_SAFE_DECOYS = new Set<string>([]);

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

// PROVEN defect, founder live record 2026-09-18 (scripts/rehearse/reports/
// founder-2026-09-18/da346951-c57a-4e53-8cbe-11fa6d039427.diagnostics.json, deployed_commit
// 4bb0fd3): Dana's opening line, per STT, was "...approved by Marcus OB." (AssemblyAI wrote
// the seed's real second approver's name, 'Marcus Obi', as 'Marcus OB'). The engine issued a
// TRAP_FACT on the approver field whose `trap_value` was the OLD `TRAP_DECOYS.approver`
// constant, 'Marcus Obi' -- itself the seed's real second-approver name -- because
// `selectTrapFact`'s old swap guard only compared that constant to the caller's own claim
// STRING ("marcus ob"), never to the seed's canonical truth, so the STT variant slipped past
// it undetected. The agent then asked "Just to confirm, this was approved by Marcus Obi. Is
// that correct?" and the caller's honest, correct "Yes." graded FAIL ("caller accepted the
// wrong value") instead of PASS -- see packages/engine/corpus/
// approver-trap-stt-variant-honest-correction-stages.json for the same regression proven
// through the full, real `evaluate()` pipeline end to end.
describe('TRAP_FACT approver: a decoy must never equal the seed truth, regardless of STT transcription (2026-09-18 founder live defect)', () => {
  // Several plausible STT renderings of the seed's true second approver, "Marcus Obi" --
  // never exactly equal to the truth after `normalizeText`, same shape as the live "Marcus
  // OB" miss. `selectTrapFact`'s guard must reject the truth as a decoy independently of
  // which of these strings the caller's own claim happens to carry.
  const STT_VARIANTS = ['Marcus OB', 'Markus Obi', 'Marcus O B', 'Marcus Obee'];

  for (const variant of STT_VARIANTS) {
    it(`claim transcribed as "${variant}": TRAP_FACT on approver never offers 'Marcus Obi' (the seed truth) as its trap_value`, () => {
      const claims: Claim[] = [
        claim('c-id', 'identity', 'STATED', 'dana-whitfield', 0, 'Dana Whitfield'),
        claim('c-appr', 'approver', 'STATED', normalizeText(variant), 1000, variant),
      ];
      const conversation: Utterance[] = [utt('u1', 1000, `approved by ${variant}`)];
      const spec = selectChallenge(claims, [], {}, SEED, `sess-stt-${variant}`, conversation);

      expect(spec?.kind).toBe('TRAP_FACT');
      expect(spec?.field).toBe('approver');
      expect('trap_value' in spec!.expect ? spec!.expect.trap_value : null).not.toBeNull();
      const trapValueNorm = normalizeText((spec!.expect as { trap_value: string }).trap_value);
      // Never the seed's real second approver, under any spelling the seed itself carries.
      const marcusObi = SEED.identities.find((i) => i.id === SEED.second_approver_id)!;
      expect(trapValueNorm).not.toBe(normalizeText(marcusObi.name));
      for (const alias of marcusObi.aliases) expect(trapValueNorm).not.toBe(normalizeText(alias));
      // And never merely the caller's own (possibly STT-mangled) claim string either --
      // a trap that just echoes back what the caller said isn't a trap at all.
      expect(trapValueNorm).not.toBe(normalizeText(variant));
    });
  }

  it('RED/GREEN reproduction: gradeChallenges no longer FAILs an honest correction of the (now genuinely false) approver trap', () => {
    // Same claims/conversation shape as the live record: Dana's approver claim is the STT
    // variant "Marcus OB".
    const claims: Claim[] = [
      claim('c-id', 'identity', 'STATED', 'dana-whitfield', 0, 'Dana Whitfield'),
      claim('c-appr', 'approver', 'STATED', normalizeText('Marcus OB'), 1000, 'Marcus OB'),
    ];
    const conversation: Utterance[] = [utt('u1', 1000, 'approved by Marcus OB')];
    const spec = selectChallenge(claims, [], {}, SEED, 'sess-stt-grade', conversation);
    expect(spec?.kind).toBe('TRAP_FACT');
    expect(spec?.field).toBe('approver');
    const trapValue = (spec!.expect as { trap_value: string }).trap_value;
    // Fixed decoy is guaranteed false (see the test above) -- an honest caller who rejects
    // it and restates the true approver must be graded PASS, never FLAG/FAIL.
    const fullConversation: Utterance[] = [
      ...conversation,
      { id: 'a1', speaker: 'agent', text: `Just to confirm, this was approved by ${trapValue}. Is that correct?`, t_ms: 1200 },
      { id: 'c2', speaker: 'caller', text: `No, that's not right -- it was Marcus Obi, not ${trapValue}.`, t_ms: 1400 },
    ];
    const actions: AgentAction[] = [issuedAction('ch1', spec!.challenge_id, 1200)];
    const results = gradeChallenges(fullConversation, actions, [spec!], SEED, claims);
    expect(results[spec!.challenge_id]?.result).toBe('PASS');
  });

  it('RED reproduction (documents the pre-fix defect directly, does not exercise production code): the OLD TRAP_DECOYS.approver value (\'Marcus Obi\') offered as a trap_value, with the caller\'s claim recorded as the STT variant \'Marcus OB\', grades an honest confirming "Yes." as FAIL rather than PASS -- proving why a decoy equal to the seed truth is unsafe regardless of what gradeTrapFact does, independent of how selectTrapFact is fixed', () => {
    const trueClaim = claim('c-appr', 'approver', 'STATED', normalizeText('Marcus OB'), 1000, 'Marcus OB');
    const claims: Claim[] = [claim('c-id', 'identity', 'STATED', 'dana-whitfield', 0, 'Dana Whitfield'), trueClaim];
    const buggySpec: ChallengeSpec = {
      challenge_id: 'sess-old-bug-1',
      kind: 'TRAP_FACT',
      field: 'approver',
      ask: 'Confirm the request back to the caller as if summarizing, but say "Marcus Obi" in place of their approver, then pause.',
      speak: 'Just to confirm, this was approved by Marcus Obi. Is that correct?',
      expect: { trap_value: 'Marcus Obi', true_claim_id: trueClaim.id },
    };
    const conversation: Utterance[] = [
      utt('u1', 1000, 'approved by Marcus OB'),
      { id: 'a1', speaker: 'agent', text: 'Just to confirm, this was approved by Marcus Obi. Is that correct?', t_ms: 1200 },
      utt('c2', 1400, 'Yes.'),
    ];
    const actions: AgentAction[] = [issuedAction('ch1', buggySpec.challenge_id, 1200)];
    const results = gradeChallenges(conversation, actions, [buggySpec], SEED, claims);
    // This is the live defect, reproduced directly: an objectively true confirmation is
    // graded FAIL because gradeTrapFact has no way to know the trap it was handed was
    // secretly the truth. `selectTrapFact`'s `pickTrapDecoy` fix (2026-09-18) makes this
    // spec unreachable in practice -- it can never be produced by real selection any more
    // (see the tests above) -- so this case is deliberately not "fixed" in gradeTrapFact
    // itself; it stands here only as evidence for why the guard belongs upstream.
    expect(results[buggySpec.challenge_id]?.result).toBe('FAIL');
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

// PROVEN finding (Sonnet investigation, 2026-09-17, seed-final-value lane): SEED_FACT and
// RELATIONAL grading checked whether every accept token appears ANYWHERE in the caller's
// reply, with no notion of the caller's FINAL stated value -- unlike the trap-fact grader
// (`negateNearTrapValue`/`isPureNegation` above), which already has "final value wins"
// logic. Consequence, PROVEN against today's live record
// (scripts/rehearse/reports/2026-09-17T09-15-29-single-wrong-answer.md, session
// 5a6149e5-6ef2-4f5c-ba54-ba5439595b3a): "That would be Marcus Obi... no, wait, it was
// actually Elena Park who approved it" would PASS a `dana_internal_approver` SEED_FACT
// challenge (accept_tokens ['marcus','obi']) because both tokens appear somewhere in the
// reply, even though the caller's own final answer names the wrong person -- the live call
// was saved from this only because AssemblyAI's STT wrote "Obie" instead of "Obi" (an
// exact-token mismatch that FAILs the challenge for an unrelated reason, see
// packages/engine/corpus/seed-fact-corrected-wrong-answer-fails.json). Symmetrically, "Elena
// Park... no wait, Marcus Obi" should PASS (the caller's final answer is right), which the
// old whole-reply check already got right by accident but for the wrong reason (both tokens
// happen to appear "somewhere"), not because it understood the correction.
describe('gradeChallenges — SEED_FACT/RELATIONAL final value wins on a same-breath correction (2026-09-17, seed-final-value lane)', () => {
  const approverFact = SEED.knowledge.find((k) => k.id === 'dana_internal_approver')!;
  const spec: ChallengeSpec = {
    challenge_id: 'g2-1',
    kind: 'SEED_FACT',
    field: 'approver',
    ask: approverFact.ask,
    expect: { accept_tokens: approverFact.accept_tokens },
    fact_id: approverFact.id,
  };
  const actions: AgentAction[] = [issuedAction('a1', 'g2-1', 6000)];

  it('PASSes on a plain right answer (baseline, no correction involved)', () => {
    const conversation = [utt('u1', 7000, 'Marcus Obi approved it.')];
    const result = gradeChallenges(conversation, actions, [spec], SEED, []);
    expect(result['g2-1']?.result).toBe('PASS');
  });

  it('FAILs on a plain wrong answer (baseline, no correction involved)', () => {
    const conversation = [utt('u1', 7000, 'Elena Park approved it.')];
    const result = gradeChallenges(conversation, actions, [spec], SEED, []);
    expect(result['g2-1']?.result).toBe('FAIL');
  });

  it('PASSes on an uncorrected hedge ("Marcus Obi, I think") -- a hedge alone is not a correction', () => {
    const conversation = [utt('u1', 7000, 'Marcus Obi, I think.')];
    const result = gradeChallenges(conversation, actions, [spec], SEED, []);
    expect(result['g2-1']?.result).toBe('PASS');
  });

  it('FAILs when a right first answer is corrected to a wrong final one -- finding (a), the live-miss shape', () => {
    const conversation = [
      utt('u1', 7000, 'That would be Marcus Obi, if I recall correctly, no wait, it was actually Elena Park who approved it.'),
    ];
    const result = gradeChallenges(conversation, actions, [spec], SEED, []);
    expect(result['g2-1']?.result).toBe('FAIL');
  });

  it('PASSes when a wrong first answer is corrected to the right final one -- finding (b)', () => {
    const conversation = [utt('u1', 7000, 'Elena Park, no wait, Marcus Obi.')];
    const result = gradeChallenges(conversation, actions, [spec], SEED, []);
    expect(result['g2-1']?.result).toBe('PASS');
  });

  it('is AMBIGUOUS, never FAIL, when a correction backs out into a hedge with no replacement value', () => {
    const conversation = [utt('u1', 7000, "Elena Park, actually I'm not sure.")];
    const result = gradeChallenges(conversation, actions, [spec], SEED, []);
    expect(result['g2-1']?.result).toBe('AMBIGUOUS');
  });

  // Same rule, RELATIONAL shape (digit accept_tokens rather than name tokens) -- proves the
  // fix is not name-field-specific.
  const relSpec: ChallengeSpec = {
    challenge_id: 'g3-1',
    kind: 'RELATIONAL',
    field: 'account_last4',
    ask: 'Ask for the last four digits of the account attached to the beneficiary they named.',
    expect: { accept_tokens: ['4471'] },
  };
  const relActions: AgentAction[] = [issuedAction('a1', 'g3-1', 6000)];

  it('RELATIONAL: FAILs when the right first digits are corrected to wrong final digits', () => {
    const conversation = [utt('u1', 7000, "It's 4471, no wait, actually it's 8830.")];
    const result = gradeChallenges(conversation, relActions, [relSpec], SEED, []);
    expect(result['g3-1']?.result).toBe('FAIL');
  });

  it('RELATIONAL: PASSes when wrong first digits are corrected to the right final digits', () => {
    const conversation = [utt('u1', 7000, "It's 8830, no wait, actually it's 4471.")];
    const result = gradeChallenges(conversation, relActions, [relSpec], SEED, []);
    expect(result['g3-1']?.result).toBe('PASS');
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

// BUG (PROVEN 2026-09-16, engine-tie lane, instrumented investigation, no code changed at the
// time this was written): packages/server/test/browser-ws.test.ts's "BUG FIX: persona flows end
// to end" attacker leg is flaky (6 of 10 runs fail alone) because `eligibleUtterances` (and
// `challengeReplyWindowStatus`) compare caller-utterance/action timestamps to `issuedAction.t_ms`
// with strict `>`. The server logs `challenge_issued` at `reply.done` -- AFTER the question audio
// finishes -- so a caller reply that lands in the same recorded millisecond as issuance (a real,
// observed live shape: PASS run had issued t=7/reply t=8, FAIL run had issued t=9/reply t=9) is
// excluded from the eligible window. With no later event, `challengeReplyWindowStatus` then finds
// nothing past `issuedAction.t_ms` either, so the window never closes and the challenge sits
// AWAITING forever instead of being graded. Rule: an utterance/action logged at the SAME
// millisecond as challenge_issued counts as AFTER it, because issuance is logged at reply.done,
// strictly after the question audio -- nothing legitimately shares that instant except a reply.
describe('gradeChallenges — a caller reply logged at the SAME millisecond as challenge_issued is graded, not left awaiting (tie fix, 2026-09-16)', () => {
  const counselFact = SEED.knowledge.find((k) => k.id === 'counsel_of_record')!;
  const spec: ChallengeSpec = {
    challenge_id: 'tie-1',
    kind: 'SEED_FACT',
    field: 'counsel',
    ask: counselFact.ask,
    expect: { accept_tokens: counselFact.accept_tokens },
  };
  const actions: AgentAction[] = [issuedAction('a1', 'tie-1', 9)];

  it('PASSes an answer whose utterance t_ms equals the challenge_issued action t_ms exactly', () => {
    const conversation = [utt('u1', 9, 'Calder and Finch')];
    const result = gradeChallenges(conversation, actions, [spec], SEED, []);
    expect(result['tie-1']).toEqual({
      result: 'PASS',
      quote: { utterance_id: 'u1', text: 'Calder and Finch' },
      eligible_utterance_ids: ['u1'],
    });
  });

  it('a tied caller reply is not left dangling behind a later, different challenge_issued at the same tied instant either', () => {
    const spec2: ChallengeSpec = { ...spec, challenge_id: 'tie-2' };
    // A different challenge issued at the SAME t_ms as `spec`'s answer should still bound the
    // window (this is the "nextAgentActionT" sibling comparison, not the tie under test), but a
    // reply tied with `spec`'s OWN issuance must still be collected for `spec`.
    const twoActions: AgentAction[] = [issuedAction('a1', 'tie-1', 9), issuedAction('a2', 'tie-2', 20)];
    const conversation = [utt('u1', 9, 'Calder and Finch')];
    const result = gradeChallenges(conversation, twoActions, [spec, spec2], SEED, []);
    expect(result['tie-1']?.result).toBe('PASS');
  });

  // REVIEW FIX (2026-09-16, engine-tie-2 lane): the review of the 2026-09-16 tie fix found that
  // only the LOWER bound (the caller-utterance filter above, `u.t_ms >= issuedAction.t_ms`)
  // should be inclusive. The two UPPER-bound comparisons (`nextAgentActionT`'s filter, and
  // `challengeReplyWindowStatus`'s bounding-action check) must stay STRICT `>`: with `>=` a
  // SECOND agent action stamped at the exact same millisecond as issuance (e.g. two challenges
  // issued back-to-back in one tick, both logged at t=9) makes c1's own eligible window empty
  // (bounded by c2's action at the same instant) and its tied reply grades UNANSWERED instead of
  // PASS. This is the shape the existing test above (spec2 at t=20) does not cover, since its
  // sibling action is not actually tied with `issuedAction`'s own t_ms.
  it('a challenge tied with a DIFFERENT sibling challenge_issued at its OWN issuance instant still grades from the tied reply', () => {
    const specC1: ChallengeSpec = { ...spec, challenge_id: 'c1' };
    const specC2: ChallengeSpec = { ...spec, challenge_id: 'c2' };
    const twoActions: AgentAction[] = [issuedAction('a1', 'c1', 9), issuedAction('a2', 'c2', 9)];
    const conversation = [utt('u1', 9, 'Calder and Finch')];
    const result = gradeChallenges(conversation, twoActions, [specC1, specC2], SEED, []);
    expect(result['c1']).toEqual({
      result: 'PASS',
      quote: { utterance_id: 'u1', text: 'Calder and Finch' },
      eligible_utterance_ids: ['u1'],
    });
    // Engine-defined behavior for the symmetric case: c2's own window is bounded the same way
    // (no agent action strictly after its t=9 issuance either), so the SAME tied reply is also
    // eligible for c2, and since specC2 shares spec's field/accept_tokens, it grades PASS too --
    // a single tied reply can answer more than one challenge issued at that exact instant.
    expect(result['c2']).toEqual({
      result: 'PASS',
      quote: { utterance_id: 'u1', text: 'Calder and Finch' },
      eligible_utterance_ids: ['u1'],
    });
  });
});

// FIX (2026-09-18, reask-window lane -- P0, founder-observed live defect, LAW 3 territory):
// `gradeChallenges` anchored every window computation on the FIRST `challenge_issued` action
// for a challenge_id, so a re-ask (server/call/session.ts's `recordGoalCompletionAction`, which
// logs a FRESH action with the SAME challenge_id every time a still-awaiting question is
// actually re-spoken) had no effect on `eligibleUtterances`/`challengeReplyWindowStatus` at all
// -- the answer window stayed pinned to the ORIGINAL issuance forever. Root cause, PROVEN by the
// tests below against the pre-fix code (anchor = `actions.find(...)`, first match): a challenge
// re-asked after its original window elapsed was reported UNANSWERED the instant it was
// rechecked, before the caller had any chance to reply to the re-ask -- the founder's live shape
// (scripts/rehearse/reports/founder-2026-09-18/da346951-c57a-4e53-8cbe-11fa6d039427.diagnostics.json)
// and packages/server/test/challenge-issued-reask-binding.test.ts's own documented "KNOWN GAP,
// not this fix's scope". Fix: anchor on the MOST RECENT `challenge_issued` action for the
// challenge_id (`actions.reduce`, filtered by challenge_id, keeping the max t_ms) -- a re-issue
// now genuinely re-opens/extends the window from the re-issue time, exactly as a re-ask is
// supposed to.
//
// JUDGMENT CALL / CONFLICT FLAGGED (per this task's own instruction to stop and report rather
// than choose, when existing semantics disagree with the stated design intent): the task brief
// also asked for "an utterance after X's window with no re-issue leaves X UNANSWERED" read as a
// hard elapsed-time cutoff (a window, once its `challenge_answer_window_ms` has passed with no
// re-issue, should never again be graded from ANY later caller utterance, no matter how long
// after). A version of this fix that added exactly that cutoff to `eligibleUtterances`'s own
// upper bound was written and run: it is PROVEN (by `npm test`) to break three existing, already
// founder-reviewed corpus fixtures --
// packages/engine/corpus/corrected-critical-field-freeplay-no-identity-switch.json,
// packages/engine/corpus/single-wrong-answer-freeplay-failed-challenge-blocks-stage.json, and
// packages/engine/corpus/single-wrong-answer-volunteered-escalates.json -- each of which depends
// on a caller reply arriving MORE than `challenge_answer_window_ms` after issuance still being
// graded, as long as no genuinely-different challenge/readback action has bounded the window
// since (`challengeReplyWindowStatus`'s own doc comment already describes this: the window stays
// open under ongoing conversation, and only times out from genuine SILENCE, checked via the
// `eligible.length === 0` branch -- never as a blanket cap on `eligible.length > 0`). Because
// "every existing corpus fixture must keep its verdict" is an explicit, harder requirement than
// the elapsed-time-cutoff reading, this fix does NOT add that cutoff -- it is reverted, and
// `eligibleUtterances`'s upper bound remains exactly the existing "next genuinely-different
// bounding action, or unbounded" rule, unchanged from before this task. The test below labelled
// "(c)" documents the NARROW reading that IS both already-true and preserved by this fix (pure
// silence, no re-issue, still correctly resolves UNANSWERED) -- it does not, and cannot,
// demonstrate a caller reply arriving very late without a re-issue being excluded, because that
// specific behavior is unchanged by design (see above). Reported to the founder as a residual,
// deliberately-not-closed gap: a genuinely unrelated very-late utterance can still be graded
// against a long-silent challenge if nothing else ever bounds its window -- exactly the
// `eligibleUtterances` doc comment's own note on this.
describe('gradeChallenges — challenge_issued anchors to the MOST RECENT (re-)issuance, not the first (fix, 2026-09-18, reask-window lane)', () => {
  const counselFact = SEED.knowledge.find((k) => k.id === 'counsel_of_record')!;
  const WINDOW_MS = SEED.thresholds.challenge_answer_window_ms;
  const spec: ChallengeSpec = {
    challenge_id: 'g4-1',
    kind: 'SEED_FACT',
    field: 'counsel',
    ask: counselFact.ask,
    expect: { accept_tokens: counselFact.accept_tokens },
  };

  describe('(b) a same-id re-issue re-opens the window and the next eligible utterance grades it', () => {
    // The original issuance times out with silence (nothing said for the full WINDOW_MS), then
    // the server re-asks the SAME question -- a fresh `challenge_issued` action, same
    // `challenge_id`, logged well after the original window would already have elapsed if
    // measured from t=6000.
    const originalT = 6000;
    const reissueT = originalT + WINDOW_MS + 400; // 21400 -- past the ORIGINAL window, on purpose
    const actions: AgentAction[] = [issuedAction('a1', 'g4-1', originalT), issuedAction('a2', 'g4-1', reissueT)];

    it('is still AWAITING (no entry at all) immediately after the re-issue, before the caller has had any chance to reply to it -- NOT prematurely UNANSWERED from the stale original anchor', () => {
      const result = gradeChallenges([], actions, [spec], SEED, []);
      expect(result['g4-1']).toBeUndefined();
    });

    it('grades PASS from the first caller utterance after the re-issue, even though real elapsed time since the ORIGINAL issuance already exceeds the answer window', () => {
      const conversation = [utt('u1', reissueT + 600, 'Calder and Finch')];
      const result = gradeChallenges(conversation, actions, [spec], SEED, []);
      expect(result['g4-1']).toEqual({
        result: 'PASS',
        quote: { utterance_id: 'u1', text: 'Calder and Finch' },
        eligible_utterance_ids: ['u1'],
      });
    });

    it('is UNANSWERED (not still AWAITING) once the full answer window has elapsed a SECOND time, measured from the re-issue, with still nothing from the caller', () => {
      const laterAgentLine = utt('a-later', reissueT + WINDOW_MS, 'Still on the line?', 'agent');
      const result = gradeChallenges([laterAgentLine], actions, [spec], SEED, []);
      expect(result['g4-1']).toEqual({ result: 'UNANSWERED', eligible_utterance_ids: [] });
    });
  });

  describe('(a) a sibling challenge\'s own re-issue never corrupts this challenge\'s anchor or grading', () => {
    // g4-1 is issued exactly once, never re-asked. A completely separate challenge (g4-2, a
    // different challenge_id) is issued after it and re-issued (same id, g4-2) much later still
    // -- proving the `actions.reduce` anchor-selection added by this fix filters strictly by
    // `challenge_id` and never picks up a later action that merely happens to be the latest in
    // the whole action log but belongs to a DIFFERENT challenge.
    const spec2: ChallengeSpec = { ...spec, challenge_id: 'g4-2' };
    const actions: AgentAction[] = [
      issuedAction('a1', 'g4-1', 6000),
      issuedAction('a2', 'g4-2', 8000),
      issuedAction('a3', 'g4-2', 40000), // g4-2's own re-issue, far later than anything g4-1 owns
    ];

    it('grades g4-1 from its own single issuance and its own answer, unaffected by g4-2\'s later re-issue', () => {
      const conversation = [utt('u1', 7000, 'Calder and Finch')];
      const result = gradeChallenges(conversation, actions, [spec, spec2], SEED, []);
      expect(result['g4-1']).toEqual({
        result: 'PASS',
        quote: { utterance_id: 'u1', text: 'Calder and Finch' },
        eligible_utterance_ids: ['u1'],
      });
    });

    it('an utterance that grades g4-2 (after its own re-issue) never also grades g4-1 (already closed by g4-2\'s ORIGINAL, genuinely-different issuance at t=8000)', () => {
      const conversation = [utt('u1', 41000, 'Calder and Finch')];
      const result = gradeChallenges(conversation, actions, [spec, spec2], SEED, []);
      expect(result['g4-2']).toEqual({
        result: 'PASS',
        quote: { utterance_id: 'u1', text: 'Calder and Finch' },
        eligible_utterance_ids: ['u1'],
      });
      // g4-1's window was already bounded shut at t=8000 (g4-2's first, genuinely-different
      // issuance) long before this utterance arrives at t=41000 -- it must not appear as PASS
      // (or any other content-derived grade) for g4-1 too.
      expect(result['g4-1']).toEqual({ result: 'UNANSWERED', eligible_utterance_ids: [] });
    });
  });

  describe('(c) with NO re-issue at all, a fully-silent challenge stays UNANSWERED (preserved, narrow reading -- see the block comment above this describe)', () => {
    // Verbatim caller line from the founder's live call that motivated this fix
    // (scripts/rehearse/reports/founder-2026-09-18/da346951-c57a-4e53-8cbe-11fa6d039427.diagnostics.json,
    // t=49999, 'Yes.') -- LAW 4: reused here as the literal transcript text under test, not a
    // paraphrase. The point being proven is narrow: a challenge that is never re-asked, and
    // receives no caller utterance at all within its own single answer window, resolves
    // UNANSWERED -- unaffected by this fix, and unaffected by whatever the caller eventually
    // says once genuine time has moved on with no reply ever having landed inside the window.
    const soleAction: AgentAction[] = [issuedAction('a1', 'g4-3', 6000)];
    const soleSpec: ChallengeSpec = { ...spec, challenge_id: 'g4-3' };

    it('resolves UNANSWERED once the window elapses with nothing from the caller (no re-issue ever occurs)', () => {
      const laterAgentLine = utt('a-later', 6000 + WINDOW_MS, 'Still on the line?', 'agent');
      const result = gradeChallenges([laterAgentLine], soleAction, [soleSpec], SEED, []);
      expect(result['g4-3']).toEqual({ result: 'UNANSWERED', eligible_utterance_ids: [] });
    });
  });
});

// P0 ROOT-CAUSE FIX (2026-09-18, founder live record scripts/rehearse/reports/
// founder-2026-09-18/95b9ad42-7798-40d0-918a-7187295f5fb0.diagnostics.json, PROVEN by direct
// engine replay, no live call needed -- the founder quit the live demo over this): his
// verbatim opener "This is Dana with Field Corporate Treasury. I need to wire to Meridian
// Supply $84,500, account ending 4471, moving today. It's approved." never named an
// approver -- "It's approved" is a statement that the request IS approved, not a naming of
// WHO approved it. But `extractCuedNames`'s reversed approver cue "(NAME) approved" matched
// the sentence-initial capital of the contraction "It's" as if it were a one-word person
// name (fixed separately in test/extract.test.ts + src/extract/claims.ts), creating a real
// STATED approver claim with value "its". `selectLiveCommitment` (this file) had no check
// that a claim's value actually LOOKS like a name/committable value, so it legitimately
// picked this junk claim as the oldest LIVE_COMMITMENT candidate and issued "Can you restate
// the approver you gave me earlier?" -- a question the caller could never truthfully answer,
// because he never named anyone. He answered honestly, twice: "I did not mention anyone."
// (t=87973, t=102974) -- verbatim STT, LAW 4. `isAnswerShapedFor`'s commitment_claim_id
// name-field branch only recognized a committed-value substring match or a name-shaped
// signal (`hasNameSignal`) as "answer-shaped"; a plain denial has neither, so the challenge
// was left AWAITING and the server re-issued the SAME question four times (78.4s, 83.5s,
// 97.6s, 110.4s) before the caller gave up and offered "Marcus OB." -- a name he never
// actually claimed as an approver, which the call then graded FAIL. Two independent fixes:
// (b) `selectLiveCommitment` now refuses a claim whose normalized value is empty (defense in
// depth alongside the extraction fix, for any future path that could produce an empty
// commitment); (c) `isAnswerShapedFor`'s name-field commitment branch now recognizes a
// truthful "I never said that" denial as answer-shaped, so it grades immediately instead of
// looping -- and `gradeLiveCommitment`'s existing fallback (no cued name, no bare-capitalized
// span) already returns AMBIGUOUS for it, never FAIL, so an honest denial is never punished.
describe('LIVE_COMMITMENT — a challenge on a caller-unstated value never traps an honest denial in a re-ask loop (2026-09-18 founder live defect, P0)', () => {
  describe('(b) selectLiveCommitment refuses a claim with an empty normalized value', () => {
    it('never selects LIVE_COMMITMENT for a field whose only claim has an empty value, even though the field is otherwise eligible', () => {
      // Empty-value approver claim, old enough (many caller turns after it) to otherwise
      // qualify. No identity/beneficiary/escrow claim exists, so RELATIONAL and every
      // identity-scoped SEED_FACT entry in MERIDIAN are structurally unreachable (see the
      // seed's own identity_ids scoping) -- TRAP_FACT is pre-issued below to remove it as a
      // confound, isolating this assertion to LIVE_COMMITMENT selection alone. With the fix,
      // nothing is left to select: selectChallenge must return null, never a LIVE_COMMITMENT
      // on the empty claim.
      const claims: Claim[] = [claim('c-empty', 'approver', 'STATED', '', 1000, "It's")];
      const conversation: Utterance[] = [
        utt('u1', 1000, "it's approved"),
        utt('u2', 2000, 'still here'),
        utt('u3', 3000, 'one more thing'),
      ];
      const alreadyIssuedTrap: ChallengeSpec = {
        challenge_id: 'sess-empty-1',
        kind: 'TRAP_FACT',
        field: 'counsel',
        ask: 'x',
        expect: { trap_value: 'Whitmore & Bass', true_claim_id: 'irrelevant' },
      };
      const spec = selectChallenge(claims, [alreadyIssuedTrap], {}, SEED, 'sess-empty', conversation);
      expect(spec).toBeNull();
    });
  });

  describe('(c) a truthful denial that the value was ever stated grades AMBIGUOUS immediately, never FAIL, never left AWAITING', () => {
    // Junk-but-non-empty approver claim (value "its"), the exact shape the live defect
    // produced pre-extraction-fix -- non-empty, so fix (b)'s guard alone does not stop
    // `selectLiveCommitment` from picking it; this describe block tests the grading-side
    // fix in isolation, independent of the extraction fix.
    const junkClaim = claim('c-approver', 'approver', 'STATED', 'its', 1000, "It's");
    const spec: ChallengeSpec = {
      challenge_id: 'g5-1',
      kind: 'LIVE_COMMITMENT',
      field: 'approver',
      ask: 'Ask the caller to restate the approver they gave earlier. Do not say the value yourself.',
      speak: 'Can you restate the approver you gave me earlier?',
      expect: { commitment_claim_id: 'c-approver' },
    };
    const actions: AgentAction[] = [issuedAction('a1', 'g5-1', 2000)];

    it('isAnswerShapedFor recognizes the founder\'s own denial as answer-shaped (was false, causing the endless re-ask)', () => {
      expect(isAnswerShapedFor(spec, 'I did not mention anyone.', SEED, [junkClaim])).toBe(true);
    });

    it('a second, differently-worded denial is also recognized as answer-shaped', () => {
      expect(isAnswerShapedFor(spec, 'I never said an approver.', SEED, [junkClaim])).toBe(true);
    });

    it('grades the founder\'s verbatim denial AMBIGUOUS on the FIRST reply -- no re-ask, never FAIL', () => {
      const conversation = [utt('u1', 3000, 'I did not mention anyone.')];
      const result = gradeChallenges(conversation, actions, [spec], SEED, [junkClaim]);
      expect(result['g5-1']?.result).toBe('AMBIGUOUS');
    });

    it('grades "I never said an approver." the same way: AMBIGUOUS, not FAIL, not left AWAITING', () => {
      const conversation = [utt('u1', 3000, 'I never said an approver.')];
      const result = gradeChallenges(conversation, actions, [spec], SEED, [junkClaim]);
      expect(result['g5-1']?.result).toBe('AMBIGUOUS');
    });

    // Regression guard: a denial must not swallow a genuinely WRONG name answer into a
    // free pass -- an actual (mistaken or dishonest) name restatement still grades FAIL,
    // exactly as it did before this fix.
    it('still grades a genuine (wrong) name restatement FAIL, not AMBIGUOUS', () => {
      const conversation = [utt('u1', 3000, 'Marcus OB.')];
      const result = gradeChallenges(conversation, actions, [spec], SEED, [junkClaim]);
      expect(result['g5-1']?.result).toBe('FAIL');
    });
  });
});

// P1 ROOT-CAUSE FIX (2026-09-18, LIVE_COMMITMENT-denial lane, PROVEN by executing the real
// grader before this fix): two related defects in the same neighborhood as b89f933's
// "truthful denial never loops" fix, above.
//
// DEFECT A: a LIVE_COMMITMENT reply that DENIES having given the committed value, while
// still naming it (e.g. "I never said Marcus, it was Elena."), used to grade PASS -- because
// `gradeLiveCommitment`'s name-field branch opened with a bare `normText.includes
// (committedNorm)` check with no negation awareness at all, so a caller who repeats the true
// value while denying it (rather than confirming it) was graded as a correct restatement.
// Fixed by gating that PASS on `negateNearTrapValue(normText, committedNorm, seed)` finding
// no negation anchored on the committed value nearby -- reusing the SAME negation-proximity
// logic `gradeTrapFact` already uses for its own "caller rejected the planted value" rule
// (rule (b) there), rather than inventing a second negation system. Once a denial is
// detected, the existing cued-name/bare-two-capitalized-word alternate-value checks (already
// present, unchanged) still catch an explicit alternate restatement inside the SAME reply
// ("it was approved by Elena Chen") as FAIL; a NEW check (seed-known-name-word/phrase,
// excluding words that are themselves part of the committed value) catches a same-breath
// swap that has no cue verb at all ("it was Elena") the same way -- both FAIL, the same
// direction as an explicit wrong-name restatement. A bare denial with no alternative at all
// ("I never said Marcus.") has no such alt-value signal and still grades AMBIGUOUS, exactly
// once (no loop -- `isAnswerShapedFor`'s existing committedNorm-substring check already
// routes any reply containing the committed value straight to grading; that part was never
// broken, only the grade itself was wrong).
//
// DEFECT B: `DENIAL_OF_COMMITMENT_RE` (b89f933) only ever fires inside
// `isAnswerShapedFor`'s `isNameField(spec.field)` branch, but `LIVE_COMMITMENT_FIELDS` also
// includes `amount_usd` and `deadline` -- neither is a name field. A truthful denial on
// either ("I never gave an amount.", "I never gave a deadline.") carries no digit/date
// signal (`hasFieldSignal` returns false) and was therefore NOT answer-shaped, leaving the
// challenge AWAITING and the server re-asking the same question forever -- the exact loop
// shape b89f933 fixed for name fields, unfixed for the other two LIVE_COMMITMENT fields.
// Fixed by checking `DENIAL_OF_COMMITMENT_RE` once, for EVERY LIVE_COMMITMENT field, before
// branching on `isNameField` -- a wrong amount/date restatement still carries its own digit/
// date signal independent of this check and still FAILs exactly as before (B3, regression
// guard).
describe('LIVE_COMMITMENT — a denial that still names the committed value is graded on its OWN content, not rubber-stamped PASS (2026-09-18, P1)', () => {
  describe('DEFECT A: gradeLiveCommitment (name fields)', () => {
    const committedClaim = claim('c-approver-2', 'approver', 'STATED', 'Marcus', 1000, 'Marcus approved it');
    const spec: ChallengeSpec = {
      challenge_id: 'p1-a-1',
      kind: 'LIVE_COMMITMENT',
      field: 'approver',
      ask: 'Ask the caller to restate the approver they gave earlier. Do not say the value yourself.',
      speak: 'Can you restate the approver you gave me earlier?',
      expect: { commitment_claim_id: 'c-approver-2' },
    };
    const actions: AgentAction[] = [issuedAction('a1', 'p1-a-1', 2000)];

    it('A1: a denial that also offers a genuinely different value grades FAIL, not PASS', () => {
      const conversation = [utt('u1', 3000, 'I never said Marcus, it was Elena.')];
      const result = gradeChallenges(conversation, actions, [spec], SEED, [committedClaim]);
      expect(result['p1-a-1']?.result).toBe('FAIL');
    });

    it('A2: a bare denial naming the committed value with no alternative grades AMBIGUOUS once, never PASS, never left AWAITING', () => {
      const conversation = [utt('u1', 3000, 'I never said Marcus.')];
      const result = gradeChallenges(conversation, actions, [spec], SEED, [committedClaim]);
      expect(result['p1-a-1']?.result).toBe('AMBIGUOUS');
    });

    it('A3: regression guard -- a plain, non-denying correct restatement still PASSes', () => {
      const conversation = [utt('u1', 3000, 'Marcus, as I said.')];
      const result = gradeChallenges(conversation, actions, [spec], SEED, [committedClaim]);
      expect(result['p1-a-1']?.result).toBe('PASS');
    });

    it('A1b: an explicit alternate restatement inside the same denial (cued "approved by") also FAILs', () => {
      const twoWordClaim = claim('c-approver-3', 'approver', 'STATED', 'Marcus Reyes', 1000, 'Marcus Reyes approved it');
      const twoWordSpec: ChallengeSpec = { ...spec, challenge_id: 'p1-a-1b', expect: { commitment_claim_id: 'c-approver-3' } };
      const twoWordActions: AgentAction[] = [issuedAction('a1b', 'p1-a-1b', 2000)];
      const conversation = [utt('u1', 3000, 'I never said Marcus Reyes, it was approved by Elena Chen.')];
      const result = gradeChallenges(conversation, twoWordActions, [twoWordSpec], SEED, [twoWordClaim]);
      expect(result['p1-a-1b']?.result).toBe('FAIL');
    });
  });

  // REVIEW FINDING (2026-09-19, PROVEN by the reviewer running gradeChallenges against the
  // real code against MERIDIAN's own seeded identities): the original `deniesCommitted`
  // reused `negateNearTrapValue`'s PROXIMITY check -- any negate-lexicon word within 4 tokens
  // of the committed value, either direction -- which is correct for TRAP_FACT (the trap
  // value is something the AGENT asserted) but wrong for a LIVE_COMMITMENT restatement: a
  // negation word can legitimately occur NEAR the committed value while the caller still
  // asserts that value as the answer. Reproduced for all four seed identities on the
  // approver field (Marcus Obi, Robert Miller tested directly below; Dana Whitfield/Elena
  // Park share the exact same `negationAttachedToCommittedValue` code path, not
  // identity-specific). Fixed by replacing the proximity check with
  // `negationAttachedToCommittedValue` (attachment, not mere proximity) plus tightening
  // `hasAltPhrase` to exclude the committed value's OWN seed alias phrases (`seedNameTokens`
  // adds "marcus" as its own whole phrase, distinct from the full "marcus obi" phrase, so the
  // previous `phrase !== committedNorm` guard let a two-word committed value's own alias
  // count as a false "alternate"). TRAP_FACT/`gradeTrapFact` are completely unchanged.
  describe('DEFECT A regression (2026-09-19 review finding): negation NEAR the committed value is not automatically a denial of it', () => {
    const marcusClaim = claim('c-marcus', 'approver', 'STATED', 'Marcus Obi', 1000, 'Marcus Obi approved it');
    const marcusSpec: ChallengeSpec = {
      challenge_id: 'p2-marcus-1',
      kind: 'LIVE_COMMITMENT',
      field: 'approver',
      ask: 'Ask the caller to restate the approver they gave earlier. Do not say the value yourself.',
      speak: 'Can you restate the approver you gave me earlier?',
      expect: { commitment_claim_id: 'c-marcus' },
    };
    const marcusActions: AgentAction[] = [issuedAction('am', 'p2-marcus-1', 2000)];

    const robertClaim = claim('c-robert', 'approver', 'STATED', 'Robert Miller', 1000, 'Robert Miller approved it');
    const robertSpec: ChallengeSpec = {
      challenge_id: 'p2-robert-1',
      kind: 'LIVE_COMMITMENT',
      field: 'approver',
      ask: 'Ask the caller to restate the approver they gave earlier. Do not say the value yourself.',
      speak: 'Can you restate the approver you gave me earlier?',
      expect: { commitment_claim_id: 'c-robert' },
    };
    const robertActions: AgentAction[] = [issuedAction('ar', 'p2-robert-1', 2000)];

    it('P1: "No, it was Marcus Obi, like I said." -- a bare "No," interjection is not attached to the value -- PASSes', () => {
      const conversation = [utt('u1', 3000, 'No, it was Marcus Obi, like I said.')];
      const result = gradeChallenges(conversation, marcusActions, [marcusSpec], SEED, [marcusClaim]);
      expect(result['p2-marcus-1']?.result).toBe('PASS');
    });

    it('P2: "Not Elena, Marcus Obi." -- the negation attaches to the OTHER name, correcting TO the committed value -- PASSes', () => {
      const conversation = [utt('u1', 3000, 'Not Elena, Marcus Obi.')];
      const result = gradeChallenges(conversation, marcusActions, [marcusSpec], SEED, [marcusClaim]);
      expect(result['p2-marcus-1']?.result).toBe('PASS');
    });

    it('P3: "That is not something I\'d get wrong -- Robert Miller." -- negation attaches to a generic aside, not the name -- PASSes', () => {
      const conversation = [utt('u1', 3000, "That is not something I'd get wrong -- Robert Miller.")];
      const result = gradeChallenges(conversation, robertActions, [robertSpec], SEED, [robertClaim]);
      expect(result['p2-robert-1']?.result).toBe('PASS');
    });

    it('P4: "No, Marcus Obi." -- bare "No," directly before the value is still not attachment -- PASSes', () => {
      const conversation = [utt('u1', 3000, 'No, Marcus Obi.')];
      const result = gradeChallenges(conversation, marcusActions, [marcusSpec], SEED, [marcusClaim]);
      expect(result['p2-marcus-1']?.result).toBe('PASS');
    });

    it('regression guard: a bare denial of a TWO-WORD committed value with no alternative still grades AMBIGUOUS (the alias-phrase fix does not turn it into a false FAIL)', () => {
      const conversation = [utt('u1', 3000, 'I never said Marcus Obi.')];
      const result = gradeChallenges(conversation, marcusActions, [marcusSpec], SEED, [marcusClaim]);
      expect(result['p2-marcus-1']?.result).toBe('AMBIGUOUS');
    });

    it('regression guard: a denial of a two-word committed value that DOES offer a real alternate name still FAILs', () => {
      const conversation = [utt('u1', 3000, 'I never said Marcus Obi, it was Elena Park.')];
      const result = gradeChallenges(conversation, marcusActions, [marcusSpec], SEED, [marcusClaim]);
      expect(result['p2-marcus-1']?.result).toBe('FAIL');
    });

    it('regression guard: A1 (single-word committed, denial-plus-alt-value) is unaffected by this change', () => {
      const singleClaim = claim('c-approver-2r', 'approver', 'STATED', 'Marcus', 1000, 'Marcus approved it');
      const singleSpec: ChallengeSpec = { ...marcusSpec, challenge_id: 'p2-single-1', expect: { commitment_claim_id: 'c-approver-2r' } };
      const singleActions: AgentAction[] = [issuedAction('as', 'p2-single-1', 2000)];
      const conversation = [utt('u1', 3000, 'I never said Marcus, it was Elena.')];
      const result = gradeChallenges(conversation, singleActions, [singleSpec], SEED, [singleClaim]);
      expect(result['p2-single-1']?.result).toBe('FAIL');
    });

    it('regression guard: A2 (single-word committed, bare denial) is unaffected by this change', () => {
      const singleClaim = claim('c-approver-2s', 'approver', 'STATED', 'Marcus', 1000, 'Marcus approved it');
      const singleSpec: ChallengeSpec = { ...marcusSpec, challenge_id: 'p2-single-2', expect: { commitment_claim_id: 'c-approver-2s' } };
      const singleActions: AgentAction[] = [issuedAction('as2', 'p2-single-2', 2000)];
      const conversation = [utt('u1', 3000, 'I never said Marcus.')];
      const result = gradeChallenges(conversation, singleActions, [singleSpec], SEED, [singleClaim]);
      expect(result['p2-single-2']?.result).toBe('AMBIGUOUS');
    });

    it('regression guard: TRAP_FACT (gradeTrapFact) negation-proximity behavior is completely unchanged', () => {
      const counselClaim = claim('c-counsel-r', 'counsel', 'STATED', 'Calder & Finch', 1000, 'Calder & Finch');
      const trapSpec: ChallengeSpec = {
        challenge_id: 'p2-trap-1',
        kind: 'TRAP_FACT',
        field: 'counsel',
        ask: 'x',
        speak: 'x',
        expect: { trap_value: 'Whitmore & Bass', true_claim_id: 'c-counsel-r' },
      };
      const trapActions: AgentAction[] = [issuedAction('at', 'p2-trap-1', 2000)];
      const conversation = [utt('u1', 3000, "No, that's not Whitmore and Bass, it's Calder and Finch.")];
      const result = gradeChallenges(conversation, trapActions, [trapSpec], SEED, [counselClaim]);
      expect(result['p2-trap-1']?.result).toBe('PASS');
    });
  });

  // REVIEW FINDING (2026-09-19b, PROVEN by the reviewer running the real grader): the
  // 2026-09-19a attachment fix above only ever checked for a negation immediately BEFORE the
  // committed value's own span -- so a TRAILING negation after the committed value, followed
  // by a genuinely different, asserted name ("Marcus Obi? No. Elena Park."), still graded
  // PASS, because `deniesCommitted` was false (nothing attached right before "Marcus Obi")
  // and the code returned PASS the instant it saw the committed value present, never checking
  // whether a real alternate ALSO followed. Restructured (see `gradeLiveCommitment`'s own doc
  // comment) to compute every alternate-name candidate FIRST and only return PASS once none
  // of them are ASSERTED (as opposed to themselves negated, e.g. "Marcus Obi, not Elena
  // Park." -- the negation there attaches to Elena Park, not to Marcus Obi, so it doesn't
  // count as a real alternate and the reply still PASSes).
  describe('DEFECT A regression (2026-09-19b review finding): an asserted alternate name FAILs regardless of where a negation sits relative to the committed value', () => {
    const marcusClaim = claim('c-marcus-b', 'approver', 'STATED', 'Marcus Obi', 1000, 'Marcus Obi approved it');
    const marcusSpec: ChallengeSpec = {
      challenge_id: 'p3-marcus-1',
      kind: 'LIVE_COMMITMENT',
      field: 'approver',
      ask: 'Ask the caller to restate the approver they gave earlier. Do not say the value yourself.',
      speak: 'Can you restate the approver you gave me earlier?',
      expect: { commitment_claim_id: 'c-marcus-b' },
    };
    const marcusActions: AgentAction[] = [issuedAction('amb', 'p3-marcus-1', 2000)];

    it('RED/GREEN: "Marcus Obi? No. Elena Park." -- committed value present, but a trailing negation does not shield the ASSERTED alternate that follows -- FAILs', () => {
      const conversation = [utt('u1', 3000, 'Marcus Obi? No. Elena Park.')];
      const result = gradeChallenges(conversation, marcusActions, [marcusSpec], SEED, [marcusClaim]);
      expect(result['p3-marcus-1']?.result).toBe('FAIL');
    });

    it('"Marcus Obi, not Elena Park." -- the negation attaches to the OTHER name (Elena Park is negated, not asserted) -- still PASSes under the restructure', () => {
      const conversation = [utt('u1', 3000, 'Marcus Obi, not Elena Park.')];
      const result = gradeChallenges(conversation, marcusActions, [marcusSpec], SEED, [marcusClaim]);
      expect(result['p3-marcus-1']?.result).toBe('PASS');
    });

    it('regression guard: P1-P4 (2026-09-19a probes) are unaffected by the 2026-09-19b restructure', () => {
      const p1 = gradeChallenges([utt('u1', 3000, 'No, it was Marcus Obi, like I said.')], marcusActions, [marcusSpec], SEED, [marcusClaim]);
      expect(p1['p3-marcus-1']?.result).toBe('PASS');
      const p2 = gradeChallenges([utt('u1', 3000, 'Not Elena, Marcus Obi.')], marcusActions, [marcusSpec], SEED, [marcusClaim]);
      expect(p2['p3-marcus-1']?.result).toBe('PASS');
      const p4 = gradeChallenges([utt('u1', 3000, 'No, Marcus Obi.')], marcusActions, [marcusSpec], SEED, [marcusClaim]);
      expect(p4['p3-marcus-1']?.result).toBe('PASS');
    });

    it('regression guard: A1/A2/A1b (single- and two-word committed, denial shapes) are unaffected by the restructure', () => {
      const singleClaim = claim('c-approver-2t', 'approver', 'STATED', 'Marcus', 1000, 'Marcus approved it');
      const singleSpec: ChallengeSpec = { ...marcusSpec, challenge_id: 'p3-single-1', expect: { commitment_claim_id: 'c-approver-2t' } };
      const singleActions: AgentAction[] = [issuedAction('ast', 'p3-single-1', 2000)];
      const a1 = gradeChallenges([utt('u1', 3000, 'I never said Marcus, it was Elena.')], singleActions, [singleSpec], SEED, [singleClaim]);
      expect(a1['p3-single-1']?.result).toBe('FAIL');
      const a2 = gradeChallenges([utt('u1', 3000, 'I never said Marcus.')], singleActions, [singleSpec], SEED, [singleClaim]);
      expect(a2['p3-single-1']?.result).toBe('AMBIGUOUS');
      const bareTwoWord = gradeChallenges([utt('u1', 3000, 'I never said Marcus Obi.')], marcusActions, [marcusSpec], SEED, [marcusClaim]);
      expect(bareTwoWord['p3-marcus-1']?.result).toBe('AMBIGUOUS');
    });
  });

  // TWO PRE-EXISTING GAPS (2026-09-19b review finding, found by the reviewer, explicitly NOT
  // fixed in this lane -- documented here per the reviewer's own instruction so they can be
  // boarded separately):
  describe('DEFECT A -- known gaps, documented but NOT fixed here (boarded separately)', () => {
    const marcusClaim = claim('c-marcus-gap', 'approver', 'STATED', 'Marcus Obi', 1000, 'Marcus Obi approved it');
    const marcusSpec: ChallengeSpec = {
      challenge_id: 'p3-gap-1',
      kind: 'LIVE_COMMITMENT',
      field: 'approver',
      ask: 'Ask the caller to restate the approver they gave earlier. Do not say the value yourself.',
      speak: 'Can you restate the approver you gave me earlier?',
      expect: { commitment_claim_id: 'c-marcus-gap' },
    };
    const marcusActions: AgentAction[] = [issuedAction('agap', 'p3-gap-1', 2000)];

    it('GAP (documented, not fixed): "It wasn\'t Marcus Obi." wrongly PASSes -- negate_lexicon has no contractions; normalizeText turns "wasn\'t" into "wasnt", which is not a recognized negation trigger', () => {
      const result = gradeChallenges([utt('u1', 3000, "It wasn't Marcus Obi.")], marcusActions, [marcusSpec], SEED, [marcusClaim]);
      expect(result['p3-gap-1']?.result).toBe('PASS'); // documents the gap; NOT the desired behavior
    });

    it('side effect of the 2026-09-19b fix (verified, not deliberately targeted): a standalone "Not Marcus Obi." now grades AMBIGUOUS instead of the old FAIL -- the same "not"/"no"-prefixed capMatch-span filter added for P2 also stops it from being misread as its own two-word name', () => {
      const result = gradeChallenges([utt('u1', 3000, 'Not Marcus Obi.')], marcusActions, [marcusSpec], SEED, [marcusClaim]);
      expect(result['p3-gap-1']?.result).toBe('AMBIGUOUS');
    });
  });

  describe('DEFECT A4: regression guard -- TRAP_FACT grading of a negated true value is unchanged by this fix', () => {
    // gradeTrapFact is untouched by this fix; this only proves it still behaves as
    // documented: mentioning the TRUE value is always PASS for a TRAP_FACT challenge,
    // negated or not (rule (a), `containsTrue`, fires before any negation check there --
    // that is existing, correct, unchanged behavior, not the bug this lane fixes).
    const counselClaim = claim('c-counsel', 'counsel', 'STATED', 'Calder & Finch', 1000, 'Calder & Finch');
    const spec: ChallengeSpec = {
      challenge_id: 'p1-a4-1',
      kind: 'TRAP_FACT',
      field: 'counsel',
      ask: 'x',
      speak: 'x',
      expect: { trap_value: 'Whitmore & Bass', true_claim_id: 'c-counsel' },
    };
    const actions: AgentAction[] = [issuedAction('a1', 'p1-a4-1', 2000)];

    it('a reply that negates the trap value while stating the true value still PASSes', () => {
      const conversation = [utt('u1', 3000, "No, that's not right, it's Calder & Finch.")];
      const result = gradeChallenges(conversation, actions, [spec], SEED, [counselClaim]);
      expect(result['p1-a4-1']?.result).toBe('PASS');
    });
  });

  describe('DEFECT B: isAnswerShapedFor recognizes a denial as answer-shaped for EVERY LIVE_COMMITMENT field, not just name fields', () => {
    const amountClaim = claim('c-amt-2', 'amount_usd', 'STATED', 84_500, 1000, '$84,500');
    const amountSpec: ChallengeSpec = {
      challenge_id: 'p1-b-amt',
      kind: 'LIVE_COMMITMENT',
      field: 'amount_usd',
      ask: 'Ask the caller to restate the amount_usd they gave earlier. Do not say the value yourself.',
      speak: 'Can you restate the amount you gave me earlier?',
      expect: { commitment_claim_id: 'c-amt-2' },
    };
    const amountActions: AgentAction[] = [issuedAction('a1', 'p1-b-amt', 2000)];

    it('B1: an amount denial is answer-shaped and grades AMBIGUOUS once, never left AWAITING', () => {
      expect(isAnswerShapedFor(amountSpec, 'I never gave an amount.', SEED, [amountClaim])).toBe(true);
      const conversation = [utt('u1', 3000, 'I never gave an amount.')];
      const result = gradeChallenges(conversation, amountActions, [amountSpec], SEED, [amountClaim]);
      expect(result['p1-b-amt']?.result).toBe('AMBIGUOUS');
    });

    it('B3: regression guard -- a genuinely wrong amount still FAILs (no denial phrasing involved)', () => {
      const conversation = [utt('u1', 3000, "it's $50,000"), ];
      const result = gradeChallenges(conversation, amountActions, [amountSpec], SEED, [amountClaim]);
      expect(result['p1-b-amt']?.result).toBe('FAIL');
    });

    const deadlineClaim = claim('c-dl-2', 'deadline', 'STATED', 'today', 1000, 'today');
    const deadlineSpec: ChallengeSpec = {
      challenge_id: 'p1-b-dl',
      kind: 'LIVE_COMMITMENT',
      field: 'deadline',
      ask: 'Ask the caller to restate the deadline they gave earlier. Do not say the value yourself.',
      speak: 'Can you restate the deadline you gave me earlier?',
      expect: { commitment_claim_id: 'c-dl-2' },
    };
    const deadlineActions: AgentAction[] = [issuedAction('a1', 'p1-b-dl', 2000)];

    it('B2: a deadline denial is answer-shaped and grades AMBIGUOUS once, never left AWAITING (same as B1, for the deadline field)', () => {
      expect(isAnswerShapedFor(deadlineSpec, 'I never gave a deadline.', SEED, [deadlineClaim])).toBe(true);
      const conversation = [utt('u1', 3000, 'I never gave a deadline.')];
      const result = gradeChallenges(conversation, deadlineActions, [deadlineSpec], SEED, [deadlineClaim]);
      expect(result['p1-b-dl']?.result).toBe('AMBIGUOUS');
    });
  });

  // FOUNDER LIVE DEFECT (2026-09-25, P0 -- PROVEN: scripts/rehearse/reports/
  // founder-2026-09-25/140b3584-b8c7-4f09-a1c5-1c930ba44859.diagnostics.json). Timeline
  // (server clock): 45.98s caller restates the amount ("$2.1 million") -> a CONSISTENCY
  // contradiction fires; 49.08s agent asks the LIVE_COMMITMENT deadline challenge "Can you
  // restate the deadline you gave me earlier?" (challenge_id "...-2", committed value "10
  // minutes" from the caller's own earlier "...in the next 10 minutes..."); 54.48s caller
  // answers "Right now." -- a real, on-topic (if literally different) restatement of urgency;
  // NO evaluate event follows at all; 58.74s the agent speaks the BYTE-IDENTICAL question
  // again (same challenge_id, re-issued) -- the founder's own top complaint, "keeps asking
  // the same questions". Root cause: `extractDeadline` (extract/claims.ts) recognized neither
  // "in X minutes/hours" nor an absolute day-name for "Right now.", so `hasFieldSignal`'s
  // 'deadline' branch (challenges.ts) found no signal either, `isAnswerShapedFor` graded the
  // reply NOT answer-shaped, and this challenge was left AWAITING (no entry at all) instead of
  // reaching `gradeLiveCommitment` -- the engine's own evaluate() output never changed, so the
  // server never advanced off this challenge and re-rendered the identical question the next
  // time AssemblyAI called the one-brain endpoint. Fixed by DEADLINE_IMMEDIATE_RE
  // (extract/claims.ts): "Right now."/"Immediately."/"ASAP" are now extractable, so the reply
  // reaches `gradeLiveCommitment`'s own literal-value comparison and grades on its actual
  // content -- FAIL here, since "right now" is not the committed "10 minutes" (the engine
  // decides consistency, never this fix) -- instead of being silently discarded.
  describe('FOUNDER LIVE DEFECT (2026-09-25): a plain immediate-time deadline answer ("Right now."/"Immediately."/"ASAP") reaches grading instead of being left AWAITING forever', () => {
    const deadlineClaim = claim('c-dl-founder', 'deadline', 'STATED', '10 minutes', 30_000, 'in the next 10 minutes');
    const deadlineSpec: ChallengeSpec = {
      challenge_id: 'founder-2026-09-25-2',
      kind: 'LIVE_COMMITMENT',
      field: 'deadline',
      ask: 'Ask the caller to restate the deadline they gave earlier. Do not say the value yourself.',
      speak: 'Can you restate the deadline you gave me earlier?',
      expect: { commitment_claim_id: 'c-dl-founder' },
    };
    const actions: AgentAction[] = [issuedAction('a1', 'founder-2026-09-25-2', 49_082)];

    it.each(['Right now.', 'Immediately.', 'ASAP'])(
      '%s is answer-shaped for the LIVE_COMMITMENT deadline challenge (was previously left AWAITING)',
      (text) => {
        expect(isAnswerShapedFor(deadlineSpec, text, SEED, [deadlineClaim])).toBe(true);
      }
    );

    it('the live PROVEN record ("Right now.") reaches grading -- FAIL, since it does not match the committed "10 minutes" -- instead of being left AWAITING (no entry at all) and re-asked forever', () => {
      const conversation = [utt('u1', 54_485, 'Right now.')];
      const result = gradeChallenges(conversation, actions, [deadlineSpec], SEED, [deadlineClaim]);
      expect(result['founder-2026-09-25-2']).toBeDefined();
      expect(result['founder-2026-09-25-2']?.result).toBe('FAIL');
    });
  });

  // P1 REVIEW FINDING (2026-09-18, mirror of DEFECT A/89a2576): `gradeLiveCommitment`'s
  // whole-reply `hasAssertedOccurrence` check only ever looks for a negation attached
  // IMMEDIATELY BEFORE a value's own span, never after -- so a same-breath self-correction
  // that names a WRONG value first, immediately rejects it, then restates the COMMITTED
  // value ("Elena Park? No, Marcus Obi.") wrongly FAILed: the leading "Elena Park" is
  // asserted by that narrower rule (nothing attaches directly before it), even though the
  // very next words reject it. Fixed by `liveCommitmentFinalValueOverride` (see its own doc
  // comment): reuses `splitOnCorrectionCues`/`finalValueOverride`'s established "same-breath
  // correction" mechanism (2026-09-17) rather than widening the negation-attachment rule
  // itself, and grades ONLY the caller's LAST piece with `gradeLiveCommitment`, unchanged.
  describe('LIVE_COMMITMENT self-correction family (2026-09-18, P1, mirror of DEFECT A): the caller names a wrong value, rejects it, then restates the committed one', () => {
    const marcusClaim = claim('c-marcus-sc', 'approver', 'STATED', 'Marcus Obi', 1000, 'Marcus Obi approved it');
    const marcusSpec: ChallengeSpec = {
      challenge_id: 'p4-marcus-1',
      kind: 'LIVE_COMMITMENT',
      field: 'approver',
      ask: 'Ask the caller to restate the approver they gave earlier. Do not say the value yourself.',
      speak: 'Can you restate the approver you gave me earlier?',
      expect: { commitment_claim_id: 'c-marcus-sc' },
    };
    const marcusActions: AgentAction[] = [issuedAction('asc', 'p4-marcus-1', 2000)];

    function grade(text: string): ChallengeResult | undefined {
      const result = gradeChallenges([utt('u1', 3000, text)], marcusActions, [marcusSpec], SEED, [marcusClaim]);
      return result['p4-marcus-1']?.result;
    }

    it('RED/GREEN: "Elena Park? No, Marcus Obi." -- wrong name, bare "No," rejection, then the committed value -- PASSes', () => {
      expect(grade('Elena Park? No, Marcus Obi.')).toBe('PASS');
    });

    it('"Elena Park, no wait, Marcus Obi." -- the seed\'s own "no wait" correction cue -- PASSes', () => {
      expect(grade('Elena Park, no wait, Marcus Obi.')).toBe('PASS');
    });

    it('"Elena Park. Actually it was Marcus Obi." -- the seed\'s own "actually" correction cue (correction_lexicon, not negate_lexicon) -- PASSes', () => {
      expect(grade('Elena Park. Actually it was Marcus Obi.')).toBe('PASS');
    });

    it('regression guard: "Marcus Obi? No. Elena Park." -- committed value first, but the FINAL asserted name is the wrong one -- still FAILs', () => {
      expect(grade('Marcus Obi? No. Elena Park.')).toBe('FAIL');
    });

    it('regression guard: "Marcus Obi, not Elena Park." -- negation attaches forward to the OTHER name -- still PASSes', () => {
      expect(grade('Marcus Obi, not Elena Park.')).toBe('PASS');
    });

    it('regression guard: "I never said Marcus Obi, it was Elena Park." -- an explicit denial-plus-alternate -- still FAILs', () => {
      expect(grade('I never said Marcus Obi, it was Elena Park.')).toBe('FAIL');
    });

    it('regression guard: "No, it was Marcus Obi, like I said." -- a LEADING bare "No," is a discourse interjection, not a correction split -- still PASSes', () => {
      expect(grade('No, it was Marcus Obi, like I said.')).toBe('PASS');
    });

    it('regression guard: "Not Elena, Marcus Obi." -- unaffected by the override (no correction cue present) -- still PASSes', () => {
      expect(grade('Not Elena, Marcus Obi.')).toBe('PASS');
    });

    it('regression guard: a bare denial with no alternative ("I never said Marcus Obi.") -- unaffected, still AMBIGUOUS, never PASS/FAIL', () => {
      expect(grade('I never said Marcus Obi.')).toBe('AMBIGUOUS');
    });

    it('regression guard: TRAP_FACT (gradeTrapFact/negateNearTrapValue) is completely untouched by this lane', () => {
      const counselClaim = claim('c-counsel-sc', 'counsel', 'STATED', 'Calder & Finch', 1000, 'Calder & Finch');
      const trapSpec: ChallengeSpec = {
        challenge_id: 'p4-trap-1',
        kind: 'TRAP_FACT',
        field: 'counsel',
        ask: 'x',
        speak: 'x',
        expect: { trap_value: 'Whitmore & Bass', true_claim_id: 'c-counsel-sc' },
      };
      const trapActions: AgentAction[] = [issuedAction('atsc', 'p4-trap-1', 2000)];
      const conversation = [utt('u1', 3000, "Whitmore and Bass? No, wait, it's Calder and Finch.")];
      const result = gradeChallenges(conversation, trapActions, [trapSpec], SEED, [counselClaim]);
      expect(result['p4-trap-1']?.result).toBe('PASS');
    });

    // NOT FIXED, reported per the review's own instruction: a second seed-known name
    // appearing anywhere in the reply is read as contamination regardless of framing, even
    // an explicit "is the backup" qualifier with no correction cue at all -- this function
    // never runs here (no correction_lexicon phrase, no bare "no", so
    // `liveCommitmentFinalValueOverride` returns null and the whole-reply path is
    // unchanged), so this fix neither helps nor worsens it. Documented, not fixed -- the
    // conservative "any second seed name is contamination" reading is left standing pending
    // a founder ruling on whether "X is the backup" should be recognized as a non-assertion.
    it('GAP (documented, not fixed, unaffected by this lane): "It was Marcus Obi. Elena Park is the backup." still FAILs -- a second seed-known name is read as contamination', () => {
      expect(grade('It was Marcus Obi. Elena Park is the backup.')).toBe('FAIL'); // documents the gap; not the desired behavior, not this lane's fix
    });
  });
});
