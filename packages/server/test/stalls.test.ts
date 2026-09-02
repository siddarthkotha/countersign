import { describe, it, expect } from 'vitest';
import type { AssuranceChecklist, EngineOutput, Evidence, EvidenceKind, EvidenceStatus } from '@countersign/engine';
import { stallLineFor, kindFromHint, stallKindFor, type StallKind } from '../src/call/stalls.js';

const KINDS: StallKind[] = ['sso', 'history', 'oob', 'generic'];

const ASSURANCE_ALL_FALSE: AssuranceChecklist = {
  identity_claimed: false,
  sso_pass_current: false,
  oob_confirmed_current: false,
  context_pass_current: false,
  no_contradictions: true,
  critical_fields_confirmed: false,
  exposure_within_limit: true,
  challenge_requirement_met: false,
  no_identity_switch: true,
  not_new_beneficiary: true,
};

function evidenceCard(id: string, kind: EvidenceKind, status: EvidenceStatus): Evidence {
  return {
    id,
    kind,
    t_ms: 0,
    label: id,
    status,
    detail: 'test fixture',
    facts: {},
    quotes: [],
    source: 'tool',
    provenance: 'SIMULATED_SYSTEM',
    request_version: 1,
  };
}

/** A minimal-but-type-complete `EngineOutput` fixture: only `evidence` and `goal.hint` vary
 *  per test -- everything else is a plausible EVIDENCE-state placeholder. */
function fixtureOutput(evidence: Evidence[], hint = 'Checks are running. Hold the floor with one short neutral line.'): EngineOutput {
  return {
    state: 'EVIDENCE',
    verdict: 'PENDING',
    reasons: [],
    failure_tally: 0,
    evidence,
    allowed_tools: [],
    required_actions: [],
    goal: { code: 'STALL', hint, keyterms: [], turn_detection_hint: 'patient' },
    claimed_identity_id: null,
    ledger: [],
    request_version: 1,
    challenges: { issued: [], results: {} },
    assurance: ASSURANCE_ALL_FALSE,
    invariants_ok: true,
  };
}

describe('stallLineFor', () => {
  for (const kind of KINDS) {
    it(`has >=8 distinct lines for kind "${kind}" and never repeats while alternatives remain`, () => {
      const used = new Set<string>();
      const seen: string[] = [];
      for (let i = 0; i < 8; i++) {
        const line = stallLineFor(kind, used);
        expect(used.has(line)).toBe(false);
        seen.push(line);
        used.add(line);
      }
      expect(new Set(seen).size).toBe(8);
    });
  }

  it('is pure: does not mutate the `used` set itself', () => {
    const used = new Set<string>(['One moment while that check completes.']);
    stallLineFor('generic', used);
    expect(used.size).toBe(1);
  });

  it('is deterministic: same (kind, used) always yields the same line', () => {
    const used = new Set<string>();
    expect(stallLineFor('sso', used)).toBe(stallLineFor('sso', used));
  });

  it('falls back to repeating once every alternative for a kind is used', () => {
    const used = new Set<string>();
    for (let i = 0; i < 8; i++) {
      used.add(stallLineFor('oob', used));
    }
    // every alternative is now in `used` -- the 9th pick must still return a real line
    // from the library rather than throwing or returning something empty.
    const again = stallLineFor('oob', used);
    expect(typeof again).toBe('string');
    expect(again.length).toBeGreaterThan(0);
  });

  it('matches the brief\'s example line as the first pick for each named kind', () => {
    const empty = new Set<string>();
    expect(stallLineFor('sso', empty)).toBe('Give me one second on that sign-in session.');
    expect(stallLineFor('history', empty)).toBe('Pulling the payment file now.');
    expect(stallLineFor('oob', empty)).toBe("I've sent a confirmation to the registered device; a moment.");
    expect(stallLineFor('generic', empty)).toBe('One moment while that check completes.');
  });
});

describe('kindFromHint', () => {
  it('maps SSO-naming hints to "sso"', () => {
    expect(kindFromHint('Stall while the SSO session context check completes.')).toBe('sso');
    expect(kindFromHint('Confirming the sign-in session, hold the floor.')).toBe('sso');
  });

  it('maps history-naming hints to "history"', () => {
    expect(kindFromHint('Stall while the request history check completes.')).toBe('history');
    expect(kindFromHint('Hold the floor -- pulling the payment file.')).toBe('history');
  });

  it('maps out-of-band-naming hints to "oob"', () => {
    expect(kindFromHint('Stall while the out-of-band confirmation is pending.')).toBe('oob');
    expect(kindFromHint('Waiting on the registered device.')).toBe('oob');
  });

  it('falls back to "generic" for a hint that names no specific check (the engine\'s actual STALL hints today)', () => {
    expect(kindFromHint('Checks are running. Hold the floor with one short neutral line; do not promise an outcome.')).toBe(
      'generic',
    );
  });
});

describe('stallKindFor (fix round 1, finding 2)', () => {
  it('picks "oob" from a PENDING ev-oob card, per the reviewer\'s exact fixture', () => {
    const output = fixtureOutput([
      evidenceCard('ev-sso', 'sso_context_result', 'PASS'),
      evidenceCard('ev-oob', 'oob_verification_result', 'PENDING'),
    ]);
    expect(stallKindFor(output)).toBe('oob');
  });

  it('picks "sso" from a PENDING ev-sso card', () => {
    const output = fixtureOutput([evidenceCard('ev-sso', 'sso_context_result', 'PENDING')]);
    expect(stallKindFor(output)).toBe('sso');
  });

  it('picks "history" from a PENDING ev-context card', () => {
    const output = fixtureOutput([evidenceCard('ev-context', 'context_check_result', 'PENDING')]);
    expect(stallKindFor(output)).toBe('history');
  });

  it('ignores a resolved (PASS/FAIL) card and only matches a genuinely PENDING one', () => {
    const output = fixtureOutput([
      evidenceCard('ev-sso', 'sso_context_result', 'PASS'),
      evidenceCard('ev-context', 'context_check_result', 'FAIL'),
      evidenceCard('ev-oob', 'oob_verification_result', 'PENDING'),
    ]);
    expect(stallKindFor(output)).toBe('oob');
  });

  it('falls back to kindFromHint(goal.hint) when nothing is PENDING', () => {
    const noPending = fixtureOutput(
      [evidenceCard('ev-sso', 'sso_context_result', 'PASS')],
      'Stall while the SSO session context check completes.',
    );
    expect(stallKindFor(noPending)).toBe('sso');

    const noEvidenceAtAll = fixtureOutput([]);
    expect(stallKindFor(noEvidenceAtAll)).toBe('generic');
  });
});
