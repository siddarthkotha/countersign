import { describe, it, expect } from 'vitest';
import { stallLineFor, kindFromHint, type StallKind } from '../src/call/stalls.js';

const KINDS: StallKind[] = ['sso', 'history', 'oob', 'generic'];

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
