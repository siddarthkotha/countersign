import { describe, expect, it } from 'vitest';
import { MERIDIAN } from '../src/seed/meridian';
import type { ToolName } from '../src/types';

// Compile-time guard (final-review fix -- the old runtime-only version of this check was
// misleadingly named: it asserted `MERIDIAN.rails` never contains a 'record_answer' id,
// which is a payment-rail list ('TREASURY-WIRE', ...) and was never going to contain a
// tool name regardless of what ToolName allows -- so it always trivially passed and never
// actually exercised the type it claimed to. This line is the real check: it fails to
// TYPE-CHECK (`npm run typecheck`), not just to run, if 'record_answer' is ever re-added to
// the ToolName union (controller ruling, amendment v2 §A).
type AssertRecordAnswerNotAToolName = 'record_answer' extends ToolName ? never : true;
const _recordAnswerExcludedFromToolName: AssertRecordAnswerNotAToolName = true;
void _recordAnswerExcludedFromToolName;

describe('seed', () => {
  it('has unique identity ids and a second approver that exists', () => {
    const ids = MERIDIAN.identities.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(MERIDIAN.second_approver_id);
  });

  it('knowledge accept tokens are lower-case', () => {
    for (const k of MERIDIAN.knowledge) for (const t of k.accept_tokens) expect(t).toBe(t.toLowerCase());
  });

  it('counsel of record is NOT Whitmore & Bass (the scripted wrong answer)', () => {
    const k = MERIDIAN.knowledge.find((x) => x.id === 'counsel_of_record')!;
    expect(k.truth.toLowerCase()).not.toContain('whitmore');
  });

  it('has at least 6 SEED_FACT knowledge entries (amendment v2 §A)', () => {
    expect(MERIDIAN.knowledge.length).toBeGreaterThanOrEqual(6);
    const ids = MERIDIAN.knowledge.map((k) => k.id);
    expect(ids).toContain('hartwell_target_ceo');
    expect(ids).toContain('deal_signing_city');
    expect(ids).toContain('escrow_account_last4');
    expect(ids).toContain('board_approval_date');
  });

  it('hartwell_target_ceo is Lena Voss', () => {
    const k = MERIDIAN.knowledge.find((x) => x.id === 'hartwell_target_ceo')!;
    expect(k.truth).toBe('Lena Voss');
    expect(k.accept_tokens).toEqual(['lena', 'voss']);
  });

  it('escrow_account_last4 is 8830 (referenced by id from the RELATIONAL challenge)', () => {
    const k = MERIDIAN.knowledge.find((x) => x.id === 'escrow_account_last4')!;
    expect(k.truth).toBe('8830');
  });

  it('counsel_of_record, escrow_institution, and escrow_account_last4 carry the ratified demo-script priorities in that order (founder ruling 2026-09-09 added the third); every other knowledge entry is unprioritized', () => {
    const counsel = MERIDIAN.knowledge.find((k) => k.id === 'counsel_of_record')!;
    const escrow = MERIDIAN.knowledge.find((k) => k.id === 'escrow_institution')!;
    const escrowDigits = MERIDIAN.knowledge.find((k) => k.id === 'escrow_account_last4')!;
    expect(counsel.priority).toBe(1);
    expect(escrow.priority).toBe(2);
    expect(escrowDigits.priority).toBe(3);
    for (const k of MERIDIAN.knowledge) {
      if (['counsel_of_record', 'escrow_institution', 'escrow_account_last4'].includes(k.id)) continue;
      expect(k.priority).toBeUndefined();
    }
  });

  it('founder ruling 2026-09-09: every Hartwell fact is scoped to robert-miller only; Dana Whitfield has her own facts scoped to dana-whitfield only, and the two scopes never overlap', () => {
    const hartwellIds = ['counsel_of_record', 'escrow_institution', 'hartwell_target_ceo', 'deal_signing_city', 'escrow_account_last4', 'board_approval_date'];
    for (const id of hartwellIds) {
      const k = MERIDIAN.knowledge.find((x) => x.id === id)!;
      expect(k.identity_ids).toEqual(['robert-miller']);
    }
    const danaIds = MERIDIAN.knowledge.filter((k) => k.identity_ids?.includes('dana-whitfield')).map((k) => k.id);
    expect(danaIds.length).toBeGreaterThanOrEqual(2);
    for (const id of danaIds) expect(hartwellIds).not.toContain(id);
    for (const k of MERIDIAN.knowledge) {
      if (danaIds.includes(k.id)) expect(k.identity_ids).toEqual(['dana-whitfield']);
    }
  });

  it('thresholds carry the v2 values: max_challenges 3, correction_window_ms 20000, tool_timeout_ms 45000', () => {
    expect(MERIDIAN.thresholds.max_challenges).toBe(3);
    expect(MERIDIAN.thresholds.correction_window_ms).toBe(20000);
    expect(MERIDIAN.thresholds.tool_timeout_ms).toBe(45000);
    expect(MERIDIAN.thresholds.high_value_usd).toBe(50_000);
    expect(MERIDIAN.thresholds.pressure_flag_min).toBe(2);
  });

  it('has the four v2 lexicons, non-empty and lower-case', () => {
    for (const lex of [
      MERIDIAN.correction_lexicon,
      MERIDIAN.affirm_lexicon,
      MERIDIAN.negate_lexicon,
      MERIDIAN.injection_lexicon,
    ]) {
      expect(lex.length).toBeGreaterThan(0);
      for (const phrase of lex) expect(phrase).toBe(phrase.toLowerCase());
    }
  });

  it('injection_lexicon matches the amendment list', () => {
    expect(MERIDIAN.injection_lexicon).toEqual([
      'ignore previous',
      'ignore your instructions',
      'system prompt',
      'mark this verified',
      'override',
      'developer mode',
    ]);
  });

  it('has the seed keyterms list', () => {
    for (const term of [
      'wire transfer',
      'escrow',
      'Hartwell',
      'Meridian',
      'treasury',
      'SSO',
      'out-of-band',
      'verification',
      'VoIP',
      'incident',
      'second approval',
      'beneficiary',
      'routing number',
      'Whitmore',
      'Calder',
      'Finch',
      'First Meridian Trust',
    ]) {
      expect(MERIDIAN.keyterms).toContain(term);
    }
  });

  it('no payment rail is accidentally named "record_answer" (data hygiene; the real record_answer-is-gone check is the compile-time guard at the top of this file)', () => {
    expect(MERIDIAN.rails.every((r) => r.id !== 'record_answer')).toBe(true);
  });
});
