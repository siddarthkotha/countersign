// packages/engine/test/ledger.test.ts
// Story ledger: every fact the caller states, committed verbatim, with a lifecycle. A
// legitimate correction (close in time, or flagged with a correction word) is graded
// differently from an unexplained contradiction. See amendment-v2-brief.md §B.
import { describe, expect, it } from 'vitest';
import { buildLedger, currentClaim, isConfirmed } from '../src/ledger';
import { MERIDIAN } from '../src/seed/meridian';
import type { AgentAction, Utterance } from '../src/types';

function u(id: string, text: string, t_ms: number): Utterance {
  return { id, speaker: 'caller', text, t_ms };
}

describe('buildLedger', () => {
  it('1. two amounts 9s apart, no correction words -> CONTRADICTED (time alone is not evidence of honesty)', () => {
    const conversation = [u('u1', 'I need to wire $1.8 million.', 0), u('u2', 'Make that $2.1 million.', 9000)];
    const { claims, request_version } = buildLedger(conversation, [], MERIDIAN);
    const amountClaims = claims.filter((c) => c.field === 'amount_usd');
    expect(amountClaims).toHaveLength(2);
    expect(amountClaims[0]).toMatchObject({ id: 'cl-1', kind: 'STATED', value: 1_800_000 });
    expect(amountClaims[1]).toMatchObject({
      id: 'cl-2',
      kind: 'CONTRADICTED',
      value: 2_100_000,
      supersedes: 'cl-1',
    });
    expect(request_version).toBe(2);
    expect(currentClaim(claims, 'amount_usd')?.value).toBe(2_100_000);
  });

  it('2. "sorry, I mean" 12s later -> CORRECTED via lexicon', () => {
    const conversation = [
      u('u1', 'I need to wire $1.8 million.', 0),
      u('u2', 'Sorry, I mean $1.9 million.', 12_000),
    ];
    const { claims, request_version } = buildLedger(conversation, [], MERIDIAN);
    const amountClaims = claims.filter((c) => c.field === 'amount_usd');
    expect(amountClaims).toHaveLength(2);
    expect(amountClaims[1]).toMatchObject({ kind: 'CORRECTED', value: 1_900_000, supersedes: 'cl-1' });
    expect(request_version).toBe(2);
  });

  it('3. 5s later, no lexicon, no readback-repair -> CONTRADICTED (time alone is not enough)', () => {
    const conversation = [u('u1', 'I need to wire $1.8 million.', 0), u('u2', 'It is $1.9 million.', 5000)];
    const { claims } = buildLedger(conversation, [], MERIDIAN);
    const amountClaims = claims.filter((c) => c.field === 'amount_usd');
    expect(amountClaims).toHaveLength(2);
    expect(amountClaims[1]).toMatchObject({ kind: 'CONTRADICTED', value: 1_900_000, supersedes: 'cl-1' });
  });

  it('4. "around two million" then 30s later an exact figure -> APPROXIMATE then CORRECTED', () => {
    const conversation = [
      u('u1', "We're thinking around two million for this deal.", 0),
      u('u2', 'The wire will be $2.1 million.', 30_000),
    ];
    const { claims, request_version } = buildLedger(conversation, [], MERIDIAN);
    const amountClaims = claims.filter((c) => c.field === 'amount_usd');
    expect(amountClaims).toHaveLength(2);
    expect(amountClaims[0]).toMatchObject({ kind: 'APPROXIMATE', value: 2_000_000 });
    expect(amountClaims[1]).toMatchObject({ kind: 'CORRECTED', value: 2_100_000, supersedes: amountClaims[0]!.id });
    expect(request_version).toBe(2);
  });

  it('5. readback + affirm -> CONFIRMED; readback + negate -> UNKNOWN', () => {
    const readback: AgentAction = { id: 'a1', kind: 'readback_issued', t_ms: 5000, field: 'amount_usd', value: '84500' };

    const affirmConversation = [
      u('u1', 'Please send $84,500 to Meridian Supply.', 0),
      u('u2', "Yes, that's right.", 8000),
    ];
    const { claims: affirmClaims } = buildLedger(affirmConversation, [readback], MERIDIAN);
    expect(currentClaim(affirmClaims, 'amount_usd')?.kind).toBe('CONFIRMED');
    expect(isConfirmed(affirmClaims, 'amount_usd')).toBe(true);

    const negateConversation = [
      u('u1', 'Please send $84,500 to Meridian Supply.', 0),
      u('u2', "No, that's not right.", 8000),
    ];
    const { claims: negateClaims } = buildLedger(negateConversation, [readback], MERIDIAN);
    expect(currentClaim(negateClaims, 'amount_usd')?.kind).toBe('UNKNOWN');
    expect(isConfirmed(negateClaims, 'amount_usd')).toBe(false);
  });

  it('5b. word-boundary lexicon matching: "I know that\'s correct" affirms (not a false negate)', () => {
    const readback: AgentAction = { id: 'a1', kind: 'readback_issued', t_ms: 5000, field: 'amount_usd', value: '84500' };
    const conversation = [
      u('u1', 'Please send $84,500 to Meridian Supply.', 0),
      u('u2', "I know that's correct.", 8000),
    ];
    const { claims } = buildLedger(conversation, [readback], MERIDIAN);
    expect(currentClaim(claims, 'amount_usd')?.kind).toBe('CONFIRMED');
  });

  it('5c. word-boundary lexicon matching: "no, that\'s wrong" negates -> UNKNOWN', () => {
    const readback: AgentAction = { id: 'a1', kind: 'readback_issued', t_ms: 5000, field: 'amount_usd', value: '84500' };
    const conversation = [
      u('u1', 'Please send $84,500 to Meridian Supply.', 0),
      u('u2', "No, that's wrong.", 8000),
    ];
    const { claims } = buildLedger(conversation, [readback], MERIDIAN);
    expect(currentClaim(claims, 'amount_usd')?.kind).toBe('UNKNOWN');
  });

  it('5d. word-boundary lexicon matching: "ignore the earlier figure" is NOT a negate hit by itself', () => {
    // "ignore" contains the raw substring "no" ("igNOre") — a naive substring match would
    // wrongly treat this as a negate and close the readback as UNKNOWN before the caller's
    // actual "yes" (still within the 2-utterance follow-up cap) could confirm it.
    const readback: AgentAction = { id: 'a1', kind: 'readback_issued', t_ms: 5000, field: 'amount_usd', value: '84500' };
    const conversation = [
      u('u1', 'Please send $84,500 to Meridian Supply.', 0),
      u('u2', "Ignore the earlier figure, it's 1.9.", 8000),
      u('u3', "Yes, that's right.", 9000),
    ];
    const { claims } = buildLedger(conversation, [readback], MERIDIAN);
    expect(currentClaim(claims, 'amount_usd')?.kind).toBe('CONFIRMED');
  });

  it('5e. readback-repair path: negated readback, then a correction inside the window -> CORRECTED; then re-confirmed', () => {
    const readback1: AgentAction = { id: 'a1', kind: 'readback_issued', t_ms: 5000, field: 'amount_usd', value: '1800000' };
    const conversation1 = [
      u('u1', 'I need to wire $1.8 million.', 0),
      u('u2', "No, that's not right.", 8000),
      u('u3', "It's $1.9 million.", 12_000), // 4s after the "no", 7s after the readback — inside the window
    ];
    const { claims: repaired, request_version } = buildLedger(conversation1, [readback1], MERIDIAN);
    const amountClaims = repaired.filter((c) => c.field === 'amount_usd');
    expect(amountClaims).toHaveLength(2);
    expect(amountClaims[0]!.kind).toBe('UNKNOWN');
    expect(amountClaims[1]).toMatchObject({ kind: 'CORRECTED', value: 1_900_000, supersedes: amountClaims[0]!.id });
    expect(request_version).toBe(2);

    const readback2: AgentAction = { id: 'a2', kind: 'readback_issued', t_ms: 15_000, field: 'amount_usd', value: '1900000' };
    const conversation2 = [...conversation1, u('u4', "Yes, that's right.", 18_000)];
    const { claims: reconfirmed } = buildLedger(conversation2, [readback1, readback2], MERIDIAN);
    expect(currentClaim(reconfirmed, 'amount_usd')?.kind).toBe('CONFIRMED');
    expect(isConfirmed(reconfirmed, 'amount_usd')).toBe(true);
  });

  it('6. cued names: approver and counsel, verbatim quotes, normalized values', () => {
    const conversation = [
      u(
        'u1',
        'This was approved by Dana Whitfield in the close meeting, counsel is Whitmore & Bass.',
        0,
      ),
    ];
    const { claims } = buildLedger(conversation, [], MERIDIAN);
    const approver = currentClaim(claims, 'approver');
    const counsel = currentClaim(claims, 'counsel');
    expect(approver).toMatchObject({ value: 'dana whitfield', quote: { text: 'Dana Whitfield' } });
    expect(counsel).toMatchObject({ value: 'whitmore and bass', quote: { text: 'Whitmore & Bass' } });
  });

  it('7. identity switch -> second claim CONTRADICTED, supersedes first, version increments', () => {
    const conversation = [u('u1', 'This is Robert Miller.', 0), u('u2', "Actually, I'm Dana Whitfield.", 5000)];
    const { claims, request_version } = buildLedger(conversation, [], MERIDIAN);
    const identityClaims = claims.filter((c) => c.field === 'identity');
    expect(identityClaims).toHaveLength(2);
    expect(identityClaims[0]).toMatchObject({ kind: 'STATED', value: 'robert-miller' });
    expect(identityClaims[1]).toMatchObject({
      kind: 'CONTRADICTED',
      value: 'dana-whitfield',
      supersedes: identityClaims[0]!.id,
    });
    expect(request_version).toBe(2);
  });

  it('8. same value restated -> one claim only, request_version stays 1', () => {
    const conversation = [
      u('u1', 'I need to wire $1.8 million.', 0),
      u('u2', "That's $1.8 million total.", 5000),
    ];
    const { claims, request_version } = buildLedger(conversation, [], MERIDIAN);
    const amountClaims = claims.filter((c) => c.field === 'amount_usd');
    expect(amountClaims).toHaveLength(1);
    expect(request_version).toBe(1);
  });

  it('9. every claim quote is a verbatim substring of its own utterance text', () => {
    const conversation = [
      u('u1', 'This is Dana Whitfield calling.', 0),
      u('u2', 'Please wire $84,500 to Meridian Supply, account ending in 4471, by end of day.', 5000),
      u(
        'u3',
        'It was approved by Robert Miller, counsel is Whitmore & Bass, escrow institution is First Meridian Trust.',
        10_000,
      ),
    ];
    const { claims } = buildLedger(conversation, [], MERIDIAN);
    expect(claims.length).toBeGreaterThan(0);
    for (const claim of claims) {
      const utterance = conversation.find((c) => c.id === claim.quote.utterance_id);
      expect(utterance).toBeDefined();
      expect(utterance!.text.includes(claim.quote.text)).toBe(true);
    }
  });
});
