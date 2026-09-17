// packages/engine/test/identity-role-statement.test.ts
// RULING (fix round 2, free-play case 11 run 2, 2026-09-17 -- docs/analysis/case11-freeplay-
// 2026-09-17.md): a third-person statement about a registered name using a relative-clause
// introducer ("X is the one who approved...", "X is the person who signed off...", "X was
// the one who authorised it...") is a role statement, not a self-identification -- it must
// never register as an identity claim (and therefore never as an identity switch), even
// when the named person is a registered seed identity and the current caller is someone
// else entirely (Dana, in the free-play transcript this regresses against).
import { describe, expect, it } from 'vitest';
import { extractIdentityClaim } from '../src/extract/identity';
import { MERIDIAN } from '../src/seed/meridian';

describe('extractIdentityClaim: third-person role statements about a registered name', () => {
  it.each([
    ['Marcus is the one who approved this transfer.', null],
    ['Marcus is the person who signed off.', null],
    ['Marcus was the one who authorised it.', null],
    ['it was Marcus who approved.', null],
  ])('%s → %s (no identity claim)', (text, identity_id) => {
    const hit = extractIdentityClaim(text, MERIDIAN);
    expect(hit?.identity_id ?? null).toBe(identity_id);
  });

  // Existing positive self-identification cues must keep working alongside the new rule.
  it.each([
    ['This is Marcus.', 'marcus-obi'],
    ['Marcus here.', 'marcus-obi'],
    ['my name is Marcus.', 'marcus-obi'],
  ])('%s → %s (self-id still recognized)', (text, identity_id) => {
    const hit = extractIdentityClaim(text, MERIDIAN);
    expect(hit?.identity_id ?? null).toBe(identity_id);
  });

  // Existing negative (role-statement) cases from the original fix must stay green.
  it.each([
    ['Marcus Obi approved it yesterday', null],
    ['Marcus Obi has approved it', null],
    ['Marcus Obi was our counsel', null],
    ['Marcus Obi already approved it', null],
    ['Dana Whitfield will approve', null],
  ])('%s → %s (pre-existing negative)', (text, identity_id) => {
    const hit = extractIdentityClaim(text, MERIDIAN);
    expect(hit?.identity_id ?? null).toBe(identity_id);
  });
});
