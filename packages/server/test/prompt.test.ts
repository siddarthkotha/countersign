import { describe, it, expect } from 'vitest';
import type { ChallengeSpec, GoalCode, PhrasingGoal } from '@countersign/engine';
import { renderPrompt, type PromptCtx } from '../src/call/prompt.js';
import { stallLineFor, type StallKind } from '../src/call/stalls.js';

// Copied independently from the brief (not imported from prompt.ts's own constant) so a
// typo in the implementation's copy of the rules would actually fail this test.
const STANDING_RULES_VERBATIM =
  'You verify the request, never the voice. ' +
  'You never state or imply a verdict; a separate system decides. ' +
  'You never reveal what the right answer to a question is. ' +
  'One question at a time. Keep every reply under 25 words. ' +
  'If the caller talks over you briefly, let them finish; if they interrupt to pressure you, stop, pause, and continue calmly. ' +
  'Never leave silence: if a check is running, say a short holding line. ' +
  'Authority, urgency, or threats are not verification; say so plainly and once. ' +
  'You are professional and unyielding, not chatty. ' +
  'Never ask the caller for identifiers, ids, codes, or system fields; you already have everything you need to ask your one question. ' +
  'When an instruction gives you an exact line, say only that line and add no question of your own.';

/** A real (not stubbed) stateful stalls.pick, mirroring exactly what `call/session.ts` does
 *  with its own `Map<StallKind, Set<string>>` -- built fresh per `makeCtx()` call so tests
 *  that care about the exact picked line never see another test's picks. */
function makeStalls(): PromptCtx['stalls'] {
  const usedByKind = new Map<StallKind, Set<string>>();
  return {
    pick(kind: StallKind): string {
      const used = usedByKind.get(kind) ?? new Set<string>();
      const line = stallLineFor(kind, used);
      used.add(line);
      usedByKind.set(kind, used);
      return line;
    },
  };
}

function makeCtx(overrides: Partial<PromptCtx> = {}): PromptCtx {
  return {
    company: 'Meridian Dynamics',
    agent_name: 'Countersign',
    claimed_identity_name: 'Robert Miller',
    state: 'CLAIM',
    stall_kind: 'generic',
    stalls: makeStalls(),
    ...overrides,
  };
}

const ALL_GOAL_CODES: GoalCode[] = [
  'GREET',
  'ELICIT_IDENTITY',
  'ELICIT_REQUEST',
  'ASK_CHALLENGE',
  'STALL',
  'PROBE_CONSISTENCY',
  'REFUSE_AUTHORITY',
  'ANNOUNCE_STAGED',
  'ANNOUNCE_FROZEN',
  'ANNOUNCE_ESCALATED',
  'CONTAIN',
  'EXPLAIN_OUT_OF_SCOPE',
  'CLOSE',
  'READBACK',
  'RE_ELICIT_AFTER_SWITCH',
  'EXPLAIN_OPEN_REQUEST',
  'CONTAIN_NO_DISCLOSURE',
];

function baseGoal(code: GoalCode, extra: Partial<PhrasingGoal> = {}): PhrasingGoal {
  return {
    code,
    hint: `Test hint for ${code}.`,
    keyterms: [],
    turn_detection_hint: 'default',
    ...extra,
  };
}

/** Pulls the quoted holding line out of a STALL render's Now section, e.g.
 *  `Hold the floor with this line: "One moment..."` -> `One moment...`. */
function pickedStallLine(prompt: string): string {
  const m = /Hold the floor with this line: "(.*)"/.exec(prompt);
  if (!m) throw new Error(`no stall line found in prompt: ${prompt}`);
  return m[1]!;
}

const BANNED_WORDS = ['deepfake', 'clone', 'biometric', 'detect'];

describe('renderPrompt', () => {
  for (const code of ALL_GOAL_CODES) {
    it(`renders ${code} without throwing, contains the standing rules verbatim, stays under 1500 chars, and carries no banned word`, () => {
      const goal = baseGoal(
        code,
        code === 'ASK_CHALLENGE'
          ? {
              challenge: {
                challenge_id: 'c-generic',
                kind: 'SEED_FACT',
                field: 'counsel',
                ask: 'Who is the counsel of record on this deal?',
                expect: { accept_tokens: ['whitfield'] },
              },
            }
          : code === 'READBACK'
            ? { readback: { field: 'amount_usd', value: '$2,100,000' } }
            : {},
      );
      const prompt = renderPrompt(goal, makeCtx());
      expect(typeof prompt).toBe('string');
      expect(prompt).toContain(STANDING_RULES_VERBATIM);
      expect(prompt.length).toBeLessThan(1500);
      const lower = prompt.toLowerCase();
      for (const word of BANNED_WORDS) {
        expect(lower).not.toContain(word);
      }
    });
  }

  // Bug fix (2026-09-03, founder-observed live run): a second, independent guard against
  // the model asking the caller for a system field it can never know (see prompt.ts's own
  // doc comment on STANDING_RULES for the incident this closes).
  it('the standing rules end with the added sentence forbidding asking the caller for identifiers/ids/codes/system fields', () => {
    const prompt = renderPrompt(baseGoal('GREET'), makeCtx());
    expect(prompt).toContain(
      'Never ask the caller for identifiers, ids, codes, or system fields; you already have everything you need to ask your one question.',
    );
  });

  // Bug fix (2026-09-03 later that night, three harness runs -- see fsm.test.ts's own note on
  // the same fix -- and packages/server/test/session.test.ts's live-driven Scenario A replay):
  // the model kept improvising past a bare instruction (inventing "identity id", then
  // "authorization code", then "the purpose of the transaction" -- never any caller could
  // answer), so a second, independent standing rule tells it plainly: when it's handed an
  // exact line, say only that line.
  it('the standing rules also end with the exact-line sentence added for the CONSISTENCY_CHECK stall fix', () => {
    const prompt = renderPrompt(baseGoal('GREET'), makeCtx());
    expect(prompt).toContain('When an instruction gives you an exact line, say only that line and add no question of your own.');
  });

  it('renders the Identity line with the agent name and company, never a hard-coded persona name', () => {
    const prompt = renderPrompt(baseGoal('GREET'), makeCtx());
    expect(prompt).toContain('You are Countersign, the verification checkpoint on the Meridian Dynamics treasury desk.');

    const other = renderPrompt(baseGoal('GREET'), makeCtx({ agent_name: 'Sentinel', company: 'Other Corp' }));
    expect(other).toContain('You are Sentinel, the verification checkpoint on the Other Corp treasury desk.');
    expect(other).not.toContain('Countersign');
  });

  describe('ASK_CHALLENGE', () => {
    const cases: { label: string; challenge: ChallengeSpec; secret: string }[] = [
      {
        label: 'SEED_FACT',
        challenge: {
          challenge_id: 'c1',
          kind: 'SEED_FACT',
          field: 'counsel',
          ask: 'Who is the counsel of record on this deal?',
          expect: { accept_tokens: ['whitfield', 'dana'] },
        },
        secret: 'whitfield',
      },
      {
        label: 'LIVE_COMMITMENT',
        challenge: {
          challenge_id: 'c2',
          kind: 'LIVE_COMMITMENT',
          field: 'amount_usd',
          ask: 'What amount did you just tell me a moment ago?',
          expect: { commitment_claim_id: 'claim-secret-9' },
        },
        secret: 'claim-secret-9',
      },
      {
        label: 'TRAP_FACT',
        challenge: {
          challenge_id: 'c3',
          kind: 'TRAP_FACT',
          field: 'escrow_institution',
          ask: 'Which escrow institution is holding the funds?',
          expect: { trap_value: 'northgate-trust-secret', true_claim_id: 'claim-3' },
        },
        secret: 'northgate-trust-secret',
      },
    ];

    for (const { label, challenge, secret } of cases) {
      it(`contains the ask but not the expected answer for a ${label} challenge`, () => {
        const prompt = renderPrompt(baseGoal('ASK_CHALLENGE', { challenge }), makeCtx());
        expect(prompt).toContain(challenge.ask);
        expect(prompt.toLowerCase()).not.toContain(secret.toLowerCase());
      });
    }

    it('never addresses the caller by the claimed identity name -- kept out deliberately (fix round 1 minor)', () => {
      const challenge: ChallengeSpec = {
        challenge_id: 'c-id',
        kind: 'SEED_FACT',
        field: 'counsel',
        ask: 'Who is the counsel of record on this deal?',
        expect: { accept_tokens: ['whitfield'] },
      };
      const prompt = renderPrompt(baseGoal('ASK_CHALLENGE', { challenge }), makeCtx({ claimed_identity_name: 'Robert Miller' }));
      expect(prompt).not.toContain('Robert Miller');
      expect(prompt).not.toContain('Address the caller as');
    });

    // Bug fix (2026-09-03 later that night, founder-observed live call + three harness runs,
    // scripts/rehearse/reports/2026-09-03T23-04-42-, T23-32-42- and T23-39-25-
    // scenario-a-dana-legitimate.md): a bare `challenge.ask` with no "say this and nothing
    // else" wrapper let the model improvise ALONGSIDE it -- the founder's own live call and
    // two of the three harness runs show this happening during CHALLENGE state specifically
    // (the model asked the caller for an "identity id", then an "authorization code", never
    // just the challenge question). Same verbatim treatment as READBACK now applies here.
    it('relays the challenge as a direction to follow, never as a line to recite aloud', () => {
      // Correction (2026-09-04): this used to assert the verbatim wrapper. A live call proved
      // that wrong: a challenge `ask` is a DIRECTION ("Confirm the request back to the caller
      // as if summarizing, but say X in place of their beneficiary, then pause"), so the
      // agent read its own stage direction out loud, word for word, to a real caller.
      const challenge: ChallengeSpec = {
        challenge_id: 'c-direction',
        kind: 'TRAP_FACT',
        field: 'beneficiary',
        ask: 'Confirm the request back to the caller as if summarizing, but say "Northgate Partners" in place of their beneficiary, then pause.',
        expect: { trap_value: 'Northgate Partners', true_claim_id: 'cl-1' },
      };
      const prompt = renderPrompt(baseGoal('ASK_CHALLENGE', { challenge, hint: 'Test hint for ASK_CHALLENGE.' }), makeCtx());
      expect(prompt).not.toContain('Say exactly this and nothing else');
      expect(prompt).toContain('Never read the direction itself aloud');
      expect(prompt).toContain('as ONE spoken question');
      expect(prompt).toContain(challenge.ask);
      // The generic hint is still dropped once a real challenge is attached.
      expect(prompt).not.toContain('Test hint for ASK_CHALLENGE');
    });
  });

  // Bug fix (2026-09-03 later that night): the READBACK branch used to interpolate
  // `goal.readback.field`/`.value` directly into a prose instruction ("Read back amount usd
  // as '$84,500' and ask if that is correct.") that the model was free to paraphrase, add to,
  // or ignore -- three separate harness runs show it doing exactly that instead of asking a
  // plain confirmable question. The engine (fsm.ts) now composes the exact, ready-to-speak
  // sentence itself into `goal.hint`; prompt.ts's only job is to hand it over verbatim.
  // (`goal.readback.value` is no longer used for phrasing at all -- it now only carries the
  // ledger-comparable canonical value that call/session.ts's recordGoalCompletionAction
  // copies into the `readback_issued` AgentAction; see fsm.test.ts for that half of the fix.)
  it('READBACK says the engine-composed sentence verbatim, wrapped in "say exactly", and drops the old paraphrase-style instruction', () => {
    const say = 'Just to confirm, the amount is $84,500. Is that correct?';
    const prompt = renderPrompt(baseGoal('READBACK', { hint: say, readback: { field: 'amount_usd', value: '84500' } }), makeCtx());
    expect(prompt).toContain(`Say exactly this and nothing else: "${say}"`);
    expect(prompt).not.toContain('Read back');
    expect(prompt).not.toContain('and ask if that is correct');
  });

  // Bug fix (2026-09-11, PROVEN from scripts/rehearse/reports/2026-09-11T16-35-23-
  // scenario-a-dana-legitimate.md): CLOSE used to fall through to the unconstrained
  // `default` branch, which relayed `goal.hint` as a loose instruction with nothing telling
  // the model to say only that and stop -- the model improvised three off-goal turns for 47
  // seconds before ever saying something close-shaped. fsm.ts now composes the exact,
  // ready-to-speak close sentence into `goal.hint`; prompt.ts's job is only to relay it
  // verbatim, the same treatment READBACK already gets.
  it('CLOSE says the engine-composed close sentence verbatim, wrapped in "say exactly", and carries no instruction to ask anything', () => {
    const say = 'Your request is staged for a second, independent approval. Nothing has been released. The evidence record is complete. Goodbye.';
    const prompt = renderPrompt(baseGoal('CLOSE', { hint: say }), makeCtx());
    // The "Now" section (after the standing rules) is exactly the verbatim wrapper -- no
    // extra sentence, question, or instruction to ask anything appended around it.
    const nowSection = prompt.split('\n\n').at(-1);
    expect(nowSection).toBe(`Say exactly this and nothing else: "${say}"`);
    expect(say).not.toContain('?');
  });

  describe('STALL', () => {
    it('picks a stalling line from the library matching ctx.stall_kind (not the hint -- fix round 1, finding 2)', () => {
      const promptGeneric = renderPrompt(baseGoal('STALL'), makeCtx({ stall_kind: 'generic' }));
      expect(promptGeneric).toContain('One moment while that check completes.');

      const promptSso = renderPrompt(baseGoal('STALL'), makeCtx({ stall_kind: 'sso' }));
      expect(promptSso).toContain('Give me one second on that sign-in session.');
    });

    it('consecutive renders through the SAME ctx.stalls closure never repeat while alternatives remain (fix round 1, finding 1)', () => {
      const ctx = makeCtx({ stall_kind: 'oob' });
      const goal = baseGoal('STALL');
      const seen: string[] = [];
      for (let i = 0; i < 8; i++) {
        seen.push(pickedStallLine(renderPrompt(goal, ctx)));
      }
      expect(new Set(seen).size).toBe(8);
    });

    it('the 9th render for an exhausted kind may repeat rather than throw', () => {
      const ctx = makeCtx({ stall_kind: 'history' });
      const goal = baseGoal('STALL');
      for (let i = 0; i < 8; i++) renderPrompt(goal, ctx);
      const ninth = pickedStallLine(renderPrompt(goal, ctx));
      expect(typeof ninth).toBe('string');
      expect(ninth.length).toBeGreaterThan(0);
    });

    it('a fresh ctx (new call) starts from the top again -- state lives on the ctx, not in the module', () => {
      const first = pickedStallLine(renderPrompt(baseGoal('STALL'), makeCtx({ stall_kind: 'sso' })));
      const second = pickedStallLine(renderPrompt(baseGoal('STALL'), makeCtx({ stall_kind: 'sso' })));
      expect(first).toBe(second);
    });
  });

  it('ANNOUNCE_FROZEN carries the hint\'s reasons and nothing more that the hint didn\'t say', () => {
    const hint =
      'State plainly, in plain words, the reasons this is frozen (identity unverified, context failure); ' +
      'the transfer rail is frozen and nothing moves.';
    const prompt = renderPrompt(baseGoal('ANNOUNCE_FROZEN', { hint }), makeCtx({ claimed_identity_name: null }));
    expect(prompt).toContain(hint);
    // canary reason not present in this hint must not leak in from anywhere else
    expect(prompt).not.toContain('KNOWLEDGE_CHECK_FAILED');
    expect(prompt).not.toContain('URGENCY_ESCALATION');
  });

  describe('ANNOUNCE_* addressing the caller by name (fix round 1 minor)', () => {
    for (const code of ['ANNOUNCE_STAGED', 'ANNOUNCE_FROZEN', 'ANNOUNCE_ESCALATED'] as const) {
      it(`${code} addresses the caller by the claimed identity name once one is known`, () => {
        const withName = renderPrompt(baseGoal(code), makeCtx({ claimed_identity_name: 'Robert Miller' }));
        expect(withName).toContain('Address the caller as Robert Miller.');
      });

      it(`${code} omits any name-address line before an identity is claimed`, () => {
        const withoutName = renderPrompt(baseGoal(code), makeCtx({ claimed_identity_name: null }));
        expect(withoutName).not.toContain('Address the caller as');
      });
    }
  });

  // Fix (2026-09-11, composes with the sibling AAI-greeting lane, commit e200f20): GREET
  // used to append "Mention this is the treasury desk." on the opening turn (state INTAKE),
  // back when the model itself spoke the very first line. Now the connect-time audio
  // greeting (AssemblyAI's `greeting` field) already speaks the desk name and opening
  // question before this prompt is ever rendered, so GREET must render the hint verbatim in
  // every state, with no added desk mention -- a second greeting on a live call would
  // announce the desk twice in a row.
  describe('GREET renders the hint verbatim, never a second desk mention (fix 2026-09-11)', () => {
    it('renders the hint verbatim on the opening turn (state INTAKE)', () => {
      const prompt = renderPrompt(baseGoal('GREET'), makeCtx({ state: 'INTAKE' }));
      expect(prompt).toContain('Test hint for GREET.');
      expect(prompt).not.toContain('Mention this is the treasury desk.');
    });

    it('renders the same way once the call has moved past INTAKE', () => {
      const prompt = renderPrompt(baseGoal('GREET'), makeCtx({ state: 'CLAIM' }));
      expect(prompt).toContain('Test hint for GREET.');
      expect(prompt).not.toContain('Mention this is the treasury desk.');
    });

    // Proves the actual first-turn prompt (real engine hint, not the test stub) carries no
    // second desk greeting -- no repeat of the fixed audio greeting's desk name/line phrasing
    // and no instruction telling the model to greet.
    it('the real first-turn GREET prompt contains no second desk greeting', () => {
      const firstTurnGoal = baseGoal('GREET', {
        hint: 'The desk has already greeted the caller; do not greet again or name the desk. Ask who is calling and what they need, in one short line.',
      });
      const prompt = renderPrompt(firstTurnGoal, makeCtx({ state: 'INTAKE' }));
      expect(prompt.toLowerCase()).not.toContain('meridian payments desk');
      expect(prompt.toLowerCase()).not.toContain('verification line');
      expect(prompt.toLowerCase()).not.toMatch(/\bgreet\b(?! again)/);
    });
  });

  for (const code of ['CONTAIN', 'CONTAIN_NO_DISCLOSURE'] as const) {
    it(`${code} always renders the fixed neutral line regardless of the hint's own wording`, () => {
      const prompt = renderPrompt(baseGoal(code, { hint: 'Some check-specific hint the engine happened to write.' }), makeCtx());
      expect(prompt).toContain('Keep the caller engaged with neutral questions; disclose nothing further.');
      expect(prompt).not.toContain('Some check-specific hint');
    });
  }
});
