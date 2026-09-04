import { describe, it, expect } from 'vitest';
import { resolvePersona, callContextForPersona, DEFAULT_PERSONA } from '../src/personas.js';

// Bug fix (2026-09-04): the live CallContext used to be hardcoded to `unverified_voip`/
// `unknown` for every call, which made the SSO check fail always, which made STAGE
// structurally unreachable (packages/engine/src/evidence/fromTools.ts's `ssoEvidence`).
// This table is the fix's single source of truth -- it must mirror the recorded corpus
// exactly: scenario-a-dana-legitimate.json / honest-correction-stages.json /
// pressure-only-still-stages.json all use `registered_device` + "Austin, TX";
// scenario-b-miller-fraud.json uses `unverified_voip` + "unknown".
describe('personas', () => {
  describe('callContextForPersona', () => {
    it('legitimate -> registered_device in Austin, TX (mirrors scenario-a-dana-legitimate.json)', () => {
      expect(callContextForPersona('sess-1', 'legitimate')).toEqual({
        session_id: 'sess-1',
        origin_kind: 'registered_device',
        origin_geo: 'Austin, TX',
      });
    });

    it('attacker -> unverified_voip with unknown geo (mirrors scenario-b-miller-fraud.json)', () => {
      expect(callContextForPersona('sess-1', 'attacker')).toEqual({
        session_id: 'sess-1',
        origin_kind: 'unverified_voip',
        origin_geo: 'unknown',
      });
    });

    it('carries the given session_id through unchanged', () => {
      expect(callContextForPersona('sess-xyz', 'legitimate').session_id).toBe('sess-xyz');
      expect(callContextForPersona('sess-xyz', 'attacker').session_id).toBe('sess-xyz');
    });
  });

  describe('resolvePersona', () => {
    it('accepts the exact allowlisted values unchanged', () => {
      expect(resolvePersona('legitimate')).toBe('legitimate');
      expect(resolvePersona('attacker')).toBe('attacker');
    });

    it('DEFAULT_PERSONA is attacker -- the safe fallback, never the permissive one', () => {
      expect(DEFAULT_PERSONA).toBe('attacker');
    });

    const badInputs: unknown[] = [
      undefined,
      null,
      '',
      'legit',
      'LEGITIMATE',
      'Legitimate',
      'registered_device',
      'ceo-override',
      42,
      {},
      [],
      true,
      false,
      { persona: 'legitimate' }, // nested, not a bare string -- must not unwrap
      'attacker ', // trailing whitespace -- strict equality only, no trimming/coercion
    ];
    for (const bad of badInputs) {
      it(`falls back to the attacker persona for ${JSON.stringify(bad)}`, () => {
        expect(resolvePersona(bad)).toBe('attacker');
      });
    }
  });
});
