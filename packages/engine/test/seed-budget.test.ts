// packages/engine/test/seed-budget.test.ts
// Seed invariant (found by read-only investigation, 2026-09-11): `selectChallenge`
// (src/challenges.ts) returns null once `seed.thresholds.max_challenges` challenges have
// been issued (rules.ts row 13 then turns that exhausted budget into a terminal verdict:
// see corpus/one-word-answers-exhaust-budget.json). But `selectChallenge` ALSO returns
// null whenever no challenge strategy applies -- LIVE_COMMITMENT needs an aged, unasked
// claim; TRAP_FACT/RELATIONAL fire at most once per call; SEED_FACT is gated by
// `factInScope`, which only ever admits a caller whose *claimed* identity appears in a
// fact's `identity_ids` (Marcus Obi and Elena Park have NO seed.knowledge entries scoped
// to them at all -- see seed/meridian.ts). If a caller's request ever left every strategy
// with nothing to ask BEFORE the budget was spent, the call would stall in CHALLENGE with
// a generic filler goal forever, never reaching a terminal verdict on its own. Nothing in
// challenges.ts guards against a seed that is this thin for some identity/request shape.
//
// This file is a REGRESSION GUARD, not a redesign: it drives the real `selectChallenge`
// (never a copy of its logic) through every identity the seed lets a caller claim, against
// every request shape the demo actually presents (see corpus/scenario-a-dana-legitimate.json,
// corpus/scenario-b-miller-fraud.json, and the bare-minimum shape every other corpus file
// confirms via readback), and asserts the pool never runs dry before `max_challenges` is
// spent. A caller who answers every challenge with the same uninformative one-word reply
// ("Sure.") never gets a free PASS either kind -- see `assertNeverPasses` below for why that
// one word is safe against every ChallengeSpec shape the engine can produce.
import { describe, expect, it } from 'vitest';
import { gradeChallenges, selectChallenge } from '../src/challenges';
import { MERIDIAN } from '../src/seed/meridian';
import type { AgentAction, Claim, ChallengeResult, ChallengeSpec, Utterance } from '../src/types';

const SEED = MERIDIAN;
const MAX = SEED.thresholds.max_challenges;

function utt(id: string, t_ms: number, text: string): Utterance {
  return { id, speaker: 'caller', text, t_ms };
}

function claim(
  id: string,
  field: Claim['field'],
  value: string | number,
  t_ms: number,
  quoteText: string,
): Claim {
  return { id, field, kind: 'CONFIRMED', value, quote: { utterance_id: `u-${id}`, text: quoteText }, t_ms, request_version: 1 };
}

/** The one wire-transfer request every corpus file eventually confirms: an amount, a
 *  beneficiary, and the account it lands in (see e.g. corpus/scenario-a-dana-legitimate.json).
 *  A "request" that never names a beneficiary is not a request at all -- every corpus file
 *  either has one or never leaves INTAKE/CLAIM, so the challenge budget is moot there. This
 *  is the leanest complete request shape; it deliberately omits approver/counsel/escrow so
 *  it does not lean on LIVE_COMMITMENT fields the demo doesn't always get (a caller need not
 *  volunteer who approved it) -- if the pool holds up on THIS shape, richer real transcripts
 *  (which only add more LIVE_COMMITMENT-eligible claims) can only do better, never worse.
 */
function bareRequestClaims(identityId: string): Claim[] {
  return [
    claim('c-id', 'identity', identityId, 0, identityId),
    claim('c-amount', 'amount_usd', 84_500, 2000, '$84,500'),
    claim('c-account', 'account_last4', '4471', 2000, 'account ending 4471'),
    // The named vendor is a real seed.payments beneficiary (pay-4471) so RELATIONAL has
    // something to grade against too, for whichever identity is claiming it.
    claim('c-beneficiary', 'beneficiary', 'meridian supply', 2000, 'Meridian Supply'),
  ];
}

/** The Scenario-A/Dana shape (corpus/scenario-a-dana-legitimate.json): the bare request
 *  plus a named approver, exactly what an honest treasury caller volunteers unprompted. */
function fullRequestWithApproverClaims(identityId: string): Claim[] {
  return [...bareRequestClaims(identityId), claim('c-approver', 'approver', 'someone else', 2000, 'approved by someone else')];
}

/** The Scenario-B/Miller shape (corpus/scenario-b-miller-fraud.json): an escrow wire with
 *  no scheduled payment on file, naming counsel and the escrow institution instead of a
 *  vendor/account -- the OTHER request shape the demo actually drives a caller through. */
function hartwellStyleClaims(identityId: string): Claim[] {
  return [
    claim('c-id', 'identity', identityId, 0, identityId),
    claim('c-amount', 'amount_usd', 1_800_000, 2000, '$1.8 million'),
    claim('c-counsel', 'counsel', 'whitmore and bass', 2000, 'Whitmore & Bass'),
    claim('c-escrow', 'escrow_institution', 'some other bank', 2000, 'some other bank'),
  ];
}

/** SEED-THIN-IDENTITIES (backlog, found 2026-09-11 by this very guard lane): the leanest
 *  possible request of all -- an amount and NOTHING else. No beneficiary, no account, no
 *  approver, no counsel, no escrow -- so TRAP_FACT and RELATIONAL both have no claim to
 *  work from (both require a beneficiary/counsel/escrow_institution/approver claim) and
 *  LIVE_COMMITMENT has only the one amount_usd field to restate. Once that single
 *  LIVE_COMMITMENT round is spent, everything left to fill the budget has to come from
 *  SEED_FACT -- which is exactly why Marcus Obi and Elena Park having zero scoped
 *  seed.knowledge entries stalled them two challenges short (see the two new facts each in
 *  seed/meridian.ts). This shape is not claimed to be reachable through today's FSM/prompt
 *  path (a request without a beneficiary may never reach CHALLENGE in the live demo) -- it
 *  is the shape that most sharply isolates the SEED_FACT-only budget, so it is the one this
 *  guard needs to hold for every identity regardless of whether the UI can currently drive
 *  a caller into it. */
function amountOnlyClaims(identityId: string): Claim[] {
  return [claim('c-id', 'identity', identityId, 0, identityId), claim('c-amount', 'amount_usd', 84_500, 2000, '$84,500')];
}

const REQUEST_SHAPES: Record<string, (identityId: string) => Claim[]> = {
  'bare request (amount + beneficiary + account only)': bareRequestClaims,
  'Scenario-A/Dana shape (+ named approver)': fullRequestWithApproverClaims,
  'Scenario-B/Miller Hartwell-escrow shape (counsel + escrow, no beneficiary)': hartwellStyleClaims,
  'amount-only shape (no beneficiary at all)': amountOnlyClaims,
};

/** Two caller turns strictly after every claim's t_ms=2000 (the LIVE_COMMITMENT age gate,
 *  `callerTurnsAfter(...) < 2` disqualifies anything younger), before any challenge starts. */
function baseConversation(): Utterance[] {
  return [utt('u-age-1', 3000, 'go ahead'), utt('u-age-2', 4000, 'still here')];
}

/** Drives `selectChallenge` for every identity the seed allows a caller to claim (all of
 *  `MERIDIAN.identities`, not only the two the demo scripts as callers -- LAW 3's engine
 *  makes no distinction and neither should this test), for every request shape above,
 *  grading each one-word reply through the REAL `gradeChallenges`. */
describe('seed invariant: the challenge pool never runs dry before the budget does', () => {
  for (const identity of MERIDIAN.identities) {
    for (const [shapeName, buildClaims] of Object.entries(REQUEST_SHAPES)) {
      it(`${identity.id} (${identity.role}) / ${shapeName}: selectChallenge returns ${MAX} distinct non-null challenges, none of which ever PASSes on a one-word reply`, () => {
        const claims = buildClaims(identity.id);
        let conversation = baseConversation();
        const actions: AgentAction[] = [];
        const issued: ChallengeSpec[] = [];
        const sessionId = `sess-budget-${identity.id}`;

        for (let i = 0; i < MAX; i++) {
          const t_ms = 5000 + i * 1000;
          const spec = selectChallenge(claims, issued, {}, SEED, sessionId, conversation);
          expect(spec, `round ${i + 1}/${MAX}: selectChallenge returned null before the budget (${MAX}) was spent`).not.toBeNull();
          issued.push(spec!);
          actions.push({ id: `act-${i}`, kind: 'challenge_issued', t_ms, challenge_id: spec!.challenge_id });
          // "Sure." is deliberately uninformative for every ChallengeSpec shape:
          //  - accept_tokens (SEED_FACT/RELATIONAL): "sure" is never one of the seed's
          //    accept tokens -> allPresent is false -> FAIL.
          //  - trap_value (TRAP_FACT): not the true value, no negation near the trap value,
          //    not a pure negation, and "sure" is not in affirm_lexicon -> AMBIGUOUS.
          //  - commitment_claim_id (LIVE_COMMITMENT): no digits, no two-capitalized-word
          //    name, no date -> AMBIGUOUS for every field kind. Never PASS, either way.
          conversation = [...conversation, utt(`u-reply-${i}`, t_ms + 500, 'Sure.')];
        }

        // The budget is genuinely spent, not just "asked" -- one more call returns null.
        expect(selectChallenge(claims, issued, {}, SEED, sessionId, conversation)).toBeNull();

        // Dedupe rules (spent-fact tracking, once-per-call TRAP_FACT/RELATIONAL) must not
        // shrink the pool below the budget: every issued spec answers a genuinely distinct
        // question, never the same fact asked twice under two kinds.
        const expectSignatures = issued.map((s) => JSON.stringify(s.expect));
        expect(new Set(expectSignatures).size, 'two issued challenges asked the same underlying fact').toBe(MAX);

        const results = gradeChallenges(conversation, actions, issued, SEED, claims);
        expect(Object.keys(results)).toHaveLength(MAX);
        for (const spec of issued) {
          const result: ChallengeResult = results[spec.challenge_id]!.result;
          expect(result, `${spec.kind}/${spec.field} graded PASS on an uninformative one-word reply`).not.toBe('PASS');
        }
      });
    }
  }

  it('sanity: every seed identity id used above is a real MERIDIAN.identities entry (fails loudly if the seed ever drops one)', () => {
    const ids = MERIDIAN.identities.map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining(['robert-miller', 'dana-whitfield', 'marcus-obi', 'elena-park']));
    expect(ids.length).toBe(4);
  });
});
