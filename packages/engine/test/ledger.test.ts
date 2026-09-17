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

  it('4b. approximate then more than double the value -> CONTRADICTED (red team item 2)', () => {
    const conversation = [
      u('u1', "It's about fifty thousand-ish.", 0),
      u('u2', 'The wire will be two hundred forty thousand.', 30_000),
    ];
    const { claims, request_version } = buildLedger(conversation, [], MERIDIAN);
    const amountClaims = claims.filter((c) => c.field === 'amount_usd');
    expect(amountClaims).toHaveLength(2);
    expect(amountClaims[0]).toMatchObject({ kind: 'APPROXIMATE', value: 50_000 });
    expect(amountClaims[1]).toMatchObject({
      kind: 'CONTRADICTED',
      value: 240_000,
      supersedes: amountClaims[0]!.id,
    });
    expect(request_version).toBe(2);
  });

  it('4c. approximate then a value within the jump ratio -> stays CORRECTED', () => {
    const conversation = [
      u('u1', 'It is about fifty thousand.', 0),
      u('u2', 'The wire will be fifty two thousand four hundred.', 30_000),
    ];
    const { claims, request_version } = buildLedger(conversation, [], MERIDIAN);
    const amountClaims = claims.filter((c) => c.field === 'amount_usd');
    expect(amountClaims).toHaveLength(2);
    expect(amountClaims[0]).toMatchObject({ kind: 'APPROXIMATE', value: 50_000 });
    expect(amountClaims[1]).toMatchObject({
      kind: 'CORRECTED',
      value: 52_400,
      supersedes: amountClaims[0]!.id,
    });
    expect(request_version).toBe(2);
  });

  it('4d. review fix: an implausible jump from an APPROXIMATE claim stays CONTRADICTED even when a correction-lexicon word sits in the immediately preceding caller turn', () => {
    // Reviewer finding on e433670/d9846d0: the cross-turn correction lookback (a2, added
    // for the structuring-two-wires split-turn bug) ran BEFORE the Sep-9 ratified
    // magnitude bound (isImplausibleJumpFromApproximate), so a correction-lexicon word
    // landing in the turn immediately before an implausible jump laundered it to
    // CORRECTED -- the same 4.8x jump that stays CONTRADICTED inside one utterance (test
    // 4b) must also stay CONTRADICTED when the "actually" and the new figure are split
    // across two adjacent caller turns with no agent turn between them.
    const conversation = [
      u('u1', "It's about fifty thousand-ish.", 0),
      u('u2', 'Actually, hold on one second.', 30_000),
      u('u3', 'The wire will be two hundred forty thousand.', 31_000),
    ];
    const { claims } = buildLedger(conversation, [], MERIDIAN);
    const amountClaims = claims.filter((c) => c.field === 'amount_usd');
    expect(amountClaims).toHaveLength(2);
    expect(amountClaims[0]).toMatchObject({ kind: 'APPROXIMATE', value: 50_000 });
    expect(amountClaims[1]).toMatchObject({
      kind: 'CONTRADICTED',
      value: 240_000,
      supersedes: amountClaims[0]!.id,
    });
  });

  it('4e. ...but a SMALL refinement split the same way still grades CORRECTED (the cue still works within the ratified bound)', () => {
    const conversation = [
      u('u1', 'It is about fifty thousand.', 0),
      u('u2', 'Actually, hold on one second.', 30_000),
      u('u3', 'The wire will be fifty two thousand four hundred.', 31_000),
    ];
    const { claims } = buildLedger(conversation, [], MERIDIAN);
    const amountClaims = claims.filter((c) => c.field === 'amount_usd');
    expect(amountClaims).toHaveLength(2);
    expect(amountClaims[0]).toMatchObject({ kind: 'APPROXIMATE', value: 50_000 });
    expect(amountClaims[1]).toMatchObject({
      kind: 'CORRECTED',
      value: 52_400,
      supersedes: amountClaims[0]!.id,
    });
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

  it('5f. bare exact restatement (no affirm/negate lexicon word) confirms: beneficiary', () => {
    // fix (live barge-in rehearsal, report 2026-09-11T22-51-38-barge-in-interrupt.md):
    // the caller repeated "Meridian Supply." five times to a beneficiary readback and it
    // was never treated as an answer at all, because neither "Meridian Supply" nor "."
    // is an affirm/negate lexicon phrase.
    const readback: AgentAction = { id: 'a1', kind: 'readback_issued', t_ms: 5000, field: 'beneficiary', value: 'Meridian Supply' };
    const conversation = [
      u('u1', 'The beneficiary is Meridian Supply.', 0),
      u('u2', 'Meridian Supply.', 8000),
    ];
    const { claims } = buildLedger(conversation, [readback], MERIDIAN);
    expect(currentClaim(claims, 'beneficiary')?.kind).toBe('CONFIRMED');
    expect(isConfirmed(claims, 'beneficiary')).toBe(true);
  });

  it('5g. bare exact restatement confirms: amount ("It\'s $84,500." with a leading filler word)', () => {
    const readback: AgentAction = { id: 'a1', kind: 'readback_issued', t_ms: 5000, field: 'amount_usd', value: '84500' };
    const conversation = [u('u1', 'I need to wire $84,500.', 0), u('u2', "It's $84,500.", 8000)];
    const { claims } = buildLedger(conversation, [readback], MERIDIAN);
    expect(currentClaim(claims, 'amount_usd')?.kind).toBe('CONFIRMED');
  });

  it('5h. bare exact restatement confirms: account last four digits', () => {
    const readback: AgentAction = { id: 'a1', kind: 'readback_issued', t_ms: 5000, field: 'account_last4', value: '4471' };
    const conversation = [u('u1', 'The account ending in 4471.', 0), u('u2', '4471.', 8000)];
    const { claims } = buildLedger(conversation, [readback], MERIDIAN);
    expect(currentClaim(claims, 'account_last4')?.kind).toBe('CONFIRMED');
  });

  it('5h2. bare exact restatement confirms: account last four digits spoken/typed as spaced single digits ("4 4 7 1")', () => {
    // Reviewer finding: a spaced-digit readback answer ("4 4 7 1", matching how the agent
    // itself reads the digits back per the live transcripts) never matched the joined
    // stored value "4471" and stayed unresolved.
    const readback: AgentAction = { id: 'a1', kind: 'readback_issued', t_ms: 5000, field: 'account_last4', value: '4471' };
    const conversation = [u('u1', 'The account ending in 4471.', 0), u('u2', '4 4 7 1.', 8000)];
    const { claims } = buildLedger(conversation, [readback], MERIDIAN);
    expect(currentClaim(claims, 'account_last4')?.kind).toBe('CONFIRMED');
  });

  it('5g2. bare exact restatement confirms: amount spoken as number words ("eighty four thousand five hundred")', () => {
    // Reviewer finding: reuses the Sep 9 spoken-number parser (extractSpokenAmounts) so a
    // spoken-word restatement of the readback value also counts, not just digit forms.
    const readback: AgentAction = { id: 'a1', kind: 'readback_issued', t_ms: 5000, field: 'amount_usd', value: '84500' };
    const conversation = [
      u('u1', 'I need to wire $84,500.', 0),
      u('u2', "It's eighty four thousand five hundred.", 8000),
    ];
    const { claims } = buildLedger(conversation, [readback], MERIDIAN);
    expect(currentClaim(claims, 'amount_usd')?.kind).toBe('CONFIRMED');
  });

  it('5g3. a WRONG spoken-number restatement does not confirm -- it grades as a new differing value, same as any other amount change', () => {
    const readback: AgentAction = { id: 'a1', kind: 'readback_issued', t_ms: 5000, field: 'amount_usd', value: '84500' };
    const conversation = [
      u('u1', 'I need to wire $84,500.', 0),
      u('u2', 'Eighty five thousand.', 8000),
    ];
    const { claims } = buildLedger(conversation, [readback], MERIDIAN);
    // Not CONFIRMED (the spoken restatement is a different number, "Eighty five thousand"
    // = 85000 != 84500). "Eighty five thousand" carries its own scale word, so it's
    // picked up by the ordinary extractAmounts path too and lands a new CONTRADICTED
    // claim -- exactly as any other differing amount would, no special-casing needed.
    const amountClaims = claims.filter((c) => c.field === 'amount_usd');
    expect(amountClaims).toHaveLength(2);
    expect(amountClaims[1]).toMatchObject({ kind: 'CONTRADICTED', value: 85_000 });
    expect(isConfirmed(claims, 'amount_usd')).toBe(false);
  });

  it('5i. a genuinely different value in reply to a readback is still graded CORRECTED/CONTRADICTED as before (restatement path does not touch it)', () => {
    const readback: AgentAction = { id: 'a1', kind: 'readback_issued', t_ms: 5000, field: 'amount_usd', value: '84500' };
    const conversation = [u('u1', 'I need to wire $84,500.', 0), u('u2', 'Actually, make that $90,000.', 8000)];
    const { claims } = buildLedger(conversation, [readback], MERIDIAN);
    const amountClaims = claims.filter((c) => c.field === 'amount_usd');
    expect(amountClaims).toHaveLength(2);
    // classified via the correction lexicon ("actually"), exactly as before this fix.
    expect(amountClaims[1]).toMatchObject({ kind: 'CORRECTED', value: 90_000 });
  });

  it('5j. a SUPERSET of the readback value ("Meridian Supply Inc") does NOT silently confirm -- ruling: stays unresolved', () => {
    const readback: AgentAction = { id: 'a1', kind: 'readback_issued', t_ms: 5000, field: 'beneficiary', value: 'Meridian Supply' };
    const conversation = [u('u1', 'The beneficiary is Meridian Supply.', 0), u('u2', 'Meridian Supply Inc.', 8000)];
    const { claims } = buildLedger(conversation, [readback], MERIDIAN);
    // Not CONFIRMED (the restatement isn't exact), and no cue phrase in "Meridian Supply
    // Inc." for extractCuedNames to pick up either, so the original STATED claim is left
    // untouched -- unresolved, not silently upgraded and not wrongly downgraded.
    expect(currentClaim(claims, 'beneficiary')?.kind).toBe('STATED');
    expect(isConfirmed(claims, 'beneficiary')).toBe(false);
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

  it('10. a correction-lexicon word split across two adjacent caller turns (no intervening agent turn) still counts as CORRECTED, not CONTRADICTED', () => {
    // Live finding, run 34: scripts/rehearse/reports/2026-09-11T22-48-44-structuring-two-wires.md.
    // The scripted line "Actually, there's a second one too -- $42,300 to the same account,
    // same vendor." is normally one utterance (correction_lexicon hit "actually" and the new
    // amount in the same u.text -- condition (a) fires directly). AssemblyAI's endpointing
    // instead finalized it as two caller turns with no agent turn between them; "actually"
    // landed in the FIRST turn, leaving the amount-bearing turn with no correction cue of its
    // own. Before this fix that fell through to CONTRADICTED; three other same-build runs that
    // night did not split the line and graded CORRECTED, so this was pure STT/turn-segmentation
    // variance, not a caller behavior difference.
    const conversation = [
      u('u1', 'I need to wire $42,250 to the vendor.', 0),
      u('u2', "Actually, there's a second one too.", 60_000),
      u('u3', '$42,300 to the same account, same vendor.', 65_000),
    ];
    const { claims } = buildLedger(conversation, [], MERIDIAN);
    const amountClaims = claims.filter((c) => c.field === 'amount_usd');
    expect(amountClaims).toHaveLength(2);
    expect(amountClaims[0]).toMatchObject({ kind: 'STATED', value: 42_250 });
    expect(amountClaims[1]).toMatchObject({ kind: 'CORRECTED', value: 42_300, supersedes: amountClaims[0]!.id });
  });

  it('10b. ...but NOT when an agent turn intervenes between the two caller utterances (the correction has gone stale)', () => {
    const conversation: Utterance[] = [
      u('u1', 'I need to wire $42,250 to the vendor.', 0),
      u('u2', "Actually, there's a second one too.", 60_000),
      { id: 'a1', speaker: 'agent', text: 'One moment while I pull that up.', t_ms: 62_000 },
      u('u3', '$42,300 to the same account, same vendor.', 65_000),
    ];
    const { claims } = buildLedger(conversation, [], MERIDIAN);
    const amountClaims = claims.filter((c) => c.field === 'amount_usd');
    expect(amountClaims).toHaveLength(2);
    // The agent's turn means the caller's "Actually" is no longer "the same breath" as the
    // new figure -- graded exactly as before this fix.
    expect(amountClaims[1]).toMatchObject({ kind: 'CONTRADICTED', value: 42_300 });
  });

  // 11. Corrected critical field (P2, PROVEN live defect, rehearsal report
  // scripts/rehearse/reports/2026-09-14T18-05-49-single-wrong-answer.md): the caller said
  // "approved by Marcus Obie— wait, I mean Elena Park approved it." -- ONE utterance, a
  // correction cue ("wait", "i mean" -- "i mean" is in seed.correction_lexicon), and a
  // corrected name. The live agent read back "Marcus Obi" (the PRE-correction value)
  // because extractCuedNames's only approver pattern was "approved by (NAME)" -- "Elena
  // Park approved it" never matched (the name comes BEFORE "approved", not after "by").
  // Founder's definition of "corrected critical field": no security-relevant value becomes
  // final until an unambiguous complete answer or a confirmed readback of the CORRECTED
  // value -- so the current claim must be Elena Park, and the first (superseded) quote
  // must still be on the record (LAW 4: facts kept, never erased).
  it('11. self-correction inside one utterance ("approved by X— wait, I mean Y approved it") -> Y is the current approver claim, X kept as superseded', () => {
    const conversation = [
      u('u1', 'This is Dana Whitfield, corporate treasury.', 0),
      u(
        'u2',
        "It's a small correction from the number on file, approved by Marcus Obie— wait, I mean Elena Park approved it.",
        20_000,
      ),
    ];
    const { claims } = buildLedger(conversation, [], MERIDIAN);
    const approverClaims = claims.filter((c) => c.field === 'approver');
    expect(approverClaims).toHaveLength(2);
    expect(approverClaims[0]).toMatchObject({ kind: 'STATED', value: 'marcus obie', quote: { text: 'Marcus Obie' } });
    expect(approverClaims[1]).toMatchObject({
      kind: 'CORRECTED',
      value: 'elena park',
      quote: { text: 'Elena Park' },
      supersedes: approverClaims[0]!.id,
    });
    expect(currentClaim(claims, 'approver')?.value).toBe('elena park');
    // Both quotes are still on the record -- the first is marked superseded, not deleted.
    expect(claims.find((c) => c.id === approverClaims[0]!.id)).toBeDefined();
  });

  // 11b. The same correction, split across two adjacent caller utterances with no
  // intervening agent turn -- the cue lands in the FIRST utterance, the corrected name in
  // the SECOND (the same adjacency rule test 10 already proves for amount_usd, condition
  // (a2)). Proves the fix is not merely a same-utterance special case.
  it('11b. self-correction split across two adjacent utterances (no intervening agent turn) -> same result as 11', () => {
    const conversation = [
      u('u1', 'This is Dana Whitfield, corporate treasury. This has been approved by Marcus Obie.', 0),
      u('u2', 'Actually, hold on.', 20_000),
      u('u3', 'Elena Park approved it.', 21_000),
    ];
    const { claims } = buildLedger(conversation, [], MERIDIAN);
    const approverClaims = claims.filter((c) => c.field === 'approver');
    expect(approverClaims).toHaveLength(2);
    expect(approverClaims[0]).toMatchObject({ kind: 'STATED', value: 'marcus obie' });
    expect(approverClaims[1]).toMatchObject({ kind: 'CORRECTED', value: 'elena park', supersedes: approverClaims[0]!.id });
    expect(currentClaim(claims, 'approver')?.value).toBe('elena park');
  });

  // 11c. (2026-09-16, approver-contradiction lane, PROVEN live miss: free-play harness run,
  // report scripts/rehearse/reports/2026-09-16T20-57-05-single-wrong-answer.md +
  // .diagnostics.json) A hedge word ("Sorry, I mean...") no longer launders a differing
  // `approver` value into CORRECTED once an agent turn has intervened since the original
  // claim -- unlike 11/11b (a same-breath self-correction with NO agent turn in between,
  // still correctly graded CORRECTED), this is a revision of an already-settled claim after
  // the conversation moved on to something else (mirrors 10b's "the correction has gone
  // stale" ruling for amount_usd, applied here to the field itself never being honestly
  // "mis-transcribed" the way a digit can be).
  it('11c. self-correction with a hedge word, but an agent turn intervenes since the ORIGINAL approver claim -> CONTRADICTED, not CORRECTED', () => {
    const conversation: Utterance[] = [
      u('u1', "Yes, that's correct. $84,600 approved by Marcus Obie, I believe.", 85_941),
      { id: 'a1', speaker: 'agent', text: 'Just to confirm, the account ends in 4 4 7 1. Is that correct?', t_ms: 89_886 },
      u('u2', 'Yes, that\'s right.', 104_033),
      u(
        'u3',
        'The account ends in 4471. Sorry, I meant to say it was approved by Elena Park, not Marcus Obie.',
        113_546,
      ),
    ];
    const { claims } = buildLedger(conversation, [], MERIDIAN);
    const approverClaims = claims.filter((c) => c.field === 'approver');
    expect(approverClaims).toHaveLength(2);
    expect(approverClaims[0]).toMatchObject({ kind: 'STATED', value: 'marcus obie', quote: { text: 'Marcus Obie' } });
    expect(approverClaims[1]).toMatchObject({
      kind: 'CONTRADICTED',
      value: 'elena park',
      quote: { text: 'Elena Park' },
      supersedes: approverClaims[0]!.id,
    });
    expect(currentClaim(claims, 'approver')?.value).toBe('elena park');
    // Both quotes are still on the record -- LAW 4, facts kept, never erased.
    expect(claims.find((c) => c.id === approverClaims[0]!.id)).toBeDefined();
  });

  // Bare-name-challenge-answer fix (2026-09-14): a bare name opening an utterance is NOT a
  // self-identification when that utterance answers a pending readback for a person-shaped
  // field. Dana identifies as Dana Whitfield, then when asked "which internal approver signed
  // off", she answers "Marcus Obi." The bare name should NOT create an identity claim
  // (contradicting the caller's original identity). Instead, it's recorded as an answer to
  // the approver readback question. Before the fix, this would create a CONTRADICTED identity
  // claim and freeze the call in RE_ELICIT_AFTER_SWITCH.
  it('12. bare name answering a person-readback does not trigger false identity switch', () => {
    const conversation = [
      u('u1', 'This is Dana Whitfield, corporate treasury. I need to wire $84,500 to Meridian Supply, account ending 4471.', 0),
      // Challenge issued by agent (not modeled as utterance, just as action below)
      u('u2', 'Marcus Obi.', 3000),
      // Readback and confirmations (not shown for brevity, but would follow in real scenario)
    ];
    const actions: AgentAction[] = [
      {
        id: 'ch1',
        kind: 'challenge_issued',
        t_ms: 1000,
        challenge_id: 'sess-test-1',
        spec: {
          challenge_id: 'sess-test-1',
          kind: 'SEED_FACT',
          field: 'approver',
          ask: 'Ask which approver.',
          expect: { accept_tokens: ['marcus', 'obi'] },
          fact_id: 'dana_internal_approver',
        },
      },
      {
        id: 'r1',
        kind: 'readback_issued',
        t_ms: 2000,
        field: 'approver',
        value: 'Marcus Obi',
      },
    ];
    const { claims } = buildLedger(conversation, actions, MERIDIAN);
    const identityClaims = claims.filter((c) => c.field === 'identity');
    // Only Dana's original identity should be claimed, not Marcus Obi
    expect(identityClaims).toHaveLength(1);
    expect(identityClaims[0]).toMatchObject({ kind: 'STATED', value: 'dana-whitfield' });
    // The approver value should have been extracted (in a real scenario, this would be from
    // a cued pattern "approved by Marcus Obi" or from a challenge answer). For this test,
    // we just verify that no false identity switch occurred.
    expect(currentClaim(claims, 'identity')?.value).toBe('dana-whitfield');
  });
});
