import { describe, expect, it } from 'vitest';
import { MERIDIAN } from '../src/seed/meridian';

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

  it('ToolName no longer includes record_answer (controller ruling, amendment v2 §A)', () => {
    // Type-level check: this would fail to compile if 'record_answer' were required anywhere.
    // Runtime companion: no tool entry in the seed's static data references it.
    expect(MERIDIAN.rails.every((r) => r.id !== 'record_answer')).toBe(true);
  });
});
