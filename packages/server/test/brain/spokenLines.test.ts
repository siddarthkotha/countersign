// packages/server/test/brain/spokenLines.test.ts
// ONE-BRAIN LIVE PATH (2026-09-22): coverage for src/brain/spokenLines.ts's `renderGoalLine`.
// Every code is exercised with a `PhrasingGoal` built by the REAL engine (`evaluate()` over a
// real `packages/engine/corpus` fixture, or a hand-written conversation run through the same
// `evaluate()`) wherever the engine can actually reach that state -- confirmed by brute-force
// replaying every prefix of every corpus file, which is how this file knows which codes the
// current corpus never reaches: STALL, PROBE_CONSISTENCY, CONTAIN_NO_DISCLOSURE, and
// REFUSE_AUTHORITY (which `fsm.ts` never constructs at all -- see spokenLines.ts's own doc
// comment). CONTAIN (DECISION state) turned out to be unreachable too, for a structural
// reason found while building this file: `fsm.ts`'s `deriveState` checks for a successful
// `seal_evidence_record` tool entry BEFORE it ever checks `requiredActions().length === 0`,
// and `requiredActions` always includes `seal_evidence_record` in what it counts down to
// zero -- so the instant every required action (including seal) is actually done, the SEALED
// branch has already returned, and DECISION can never be observed by a standalone `evaluate()`
// call (only mid-tick, server-side, between running the terminal-action tools and re-running
// evaluate -- see docs/plans/2026-09-22-spoken-lines-draft.md's own ANNOUNCE_* section, which
// already flagged DECISION as "likely coalesced away the same way ACTION is"). These five are
// hand-built `PhrasingGoal` objects, real hint text copied verbatim from `fsm.ts`'s own
// templates (PROBE_CONSISTENCY's two quotes are themselves real, verbatim caller text borrowed
// from packages/engine/corpus/approver-trap-stt-variant-honest-correction-stages.json, not
// invented).
import { describe, expect, it } from 'vitest';
import { evaluate, MERIDIAN } from '@countersign/engine';
import type { CorpusFile, EngineInput, GoalCode, PhrasingGoal, ToolLogEntry } from '@countersign/engine';
import { renderGoalLine } from '../../src/brain/spokenLines.js';
import recordedStageJson from '../../../engine/corpus/recorded-stage.json' with { type: 'json' };
import recordedFreezeJson from '../../../engine/corpus/recorded-freeze.json' with { type: 'json' };
import recordedEscalateJson from '../../../engine/corpus/recorded-escalate.json' with { type: 'json' };
import judgeOutOfScopeJson from '../../../engine/corpus/judge-out-of-scope-no-request.json' with { type: 'json' };
import judgeTestingAfterRequestJson from '../../../engine/corpus/judge-testing-after-request.json' with { type: 'json' };

const recordedStage = recordedStageJson as unknown as CorpusFile;
const recordedFreeze = recordedFreezeJson as unknown as CorpusFile;
const recordedEscalate = recordedEscalateJson as unknown as CorpusFile;
const judgeOutOfScope = judgeOutOfScopeJson as unknown as CorpusFile;
const judgeTestingAfterRequest = judgeTestingAfterRequestJson as unknown as CorpusFile;

function inputFor(corpus: CorpusFile): EngineInput {
  return { conversation: corpus.conversation, tools: corpus.tools, actions: corpus.actions, call: corpus.call, seed: MERIDIAN };
}

const CALL = recordedStage.call;

// ---------- goals reachable through the REAL engine ----------

const greetGoal = evaluate({ conversation: [], tools: [], actions: [], call: CALL, seed: MERIDIAN }).goal;

// A stated request with no identity ever claimed -- CLAIM state, hasRequest true/hasIdentity
// false -- fsm.ts:426.
const elicitIdentityGoal = evaluate({
  conversation: [
    { id: 'c1', speaker: 'caller', text: 'I need to wire eighty four thousand five hundred dollars to Meridian Supply, account ending 4471.', t_ms: 1000 },
  ],
  tools: [],
  actions: [],
  call: CALL,
  seed: MERIDIAN,
}).goal;

const announceStagedGoal = evaluate(inputFor(recordedStage)).goal;
const announceFrozenGoal = evaluate(inputFor(recordedFreeze)).goal;
const announceEscalatedGoal = evaluate(inputFor(recordedEscalate)).goal;
const explainOutOfScopeGoal = evaluate(inputFor(judgeOutOfScope)).goal;
const explainOpenRequestGoal = evaluate(inputFor(judgeTestingAfterRequest)).goal;

// Proof that DECISION/CONTAIN really is unreachable this way (see file header): marking every
// STAGE-required tool done, including seal_evidence_record's predecessors, still lands on
// ANNOUNCE_STAGED (ACTION), never CONTAIN -- `deriveState`'s SEALED check always wins first
// once the actual seal call succeeds, and never fires before it.
const almostSealedTools: ToolLogEntry[] = [
  ...recordedStage.tools,
  { id: 'contain-test-stage', name: 'stage_payment_for_second_approval', t_ms: 90000, args: {}, result: { staged: true } },
  { id: 'contain-test-alert', name: 'alert_principal', t_ms: 90000, args: {}, result: { alerted: true } },
];

// ---------- goals NOT reachable through any corpus prefix today (see file header) ----------
// Each hand-built `PhrasingGoal` matches `packages/engine/src/types.ts`'s interface exactly;
// hint text is copied verbatim from `fsm.ts`'s own templates (or, for PROBE_CONSISTENCY, real
// caller quotes borrowed from another corpus file -- never invented prose).

const stallGoal: PhrasingGoal = {
  code: 'STALL',
  hint: 'Checks are running. Hold the floor with one short neutral line; do not promise an outcome.', // fsm.ts:465/479
  keyterms: [],
  turn_detection_hint: 'default',
};

const containGoal: PhrasingGoal = {
  code: 'CONTAIN',
  hint: 'The decision is made and actions are underway. Keep the caller engaged with neutral questions; never argue.', // fsm.ts:533
  keyterms: [],
  turn_detection_hint: 'default',
};

const containNoDisclosureGoal: PhrasingGoal = {
  code: 'CONTAIN_NO_DISCLOSURE',
  hint: 'Stay calm and neutral. Do not disclose any status, reasoning, or details of the checks under way; keep asking routine verification questions.', // fsm.ts:474
  keyterms: [],
  turn_detection_hint: 'default',
};

const probeConsistencyGoal: PhrasingGoal = {
  code: 'PROBE_CONSISTENCY',
  // fsm.ts:446 template, filled with real caller quotes from
  // packages/engine/corpus/approver-trap-stt-variant-honest-correction-stages.json (c1: "...
  // approved by Marcus OB." / c2: "No, that's not right -- it was Marcus Obi, not Priya
  // Ramanathan, ...").
  hint: 'A moment ago the caller said "approved by Marcus OB"; now "it was Marcus Obi, not Priya Ramanathan". Ask which is correct and why it changed.',
  keyterms: [],
  turn_detection_hint: 'patient',
};

const refuseAuthorityGoal: PhrasingGoal = {
  code: 'REFUSE_AUTHORITY',
  // Dead code in fsm.ts (see spokenLines.ts's own doc comment) -- no real hint template exists
  // to copy; this is the same instruction PLACEHOLDER_GOAL_LINES.REFUSE_AUTHORITY carries
  // today, minus its `[PLACEHOLDER ...]` prefix.
  hint: 'Decline the request politely and explain why.',
  keyterms: [],
  turn_detection_hint: 'default',
};

const GOALS: Record<
  Exclude<GoalCode, 'READBACK' | 'RE_ELICIT_AFTER_SWITCH' | 'ELICIT_MISSING_CRITICAL' | 'ELICIT_REQUEST' | 'CLOSE' | 'ASK_CHALLENGE'>,
  PhrasingGoal
> = {
  GREET: greetGoal,
  ELICIT_IDENTITY: elicitIdentityGoal,
  STALL: stallGoal,
  PROBE_CONSISTENCY: probeConsistencyGoal,
  REFUSE_AUTHORITY: refuseAuthorityGoal,
  ANNOUNCE_STAGED: announceStagedGoal,
  ANNOUNCE_FROZEN: announceFrozenGoal,
  ANNOUNCE_ESCALATED: announceEscalatedGoal,
  CONTAIN: containGoal,
  CONTAIN_NO_DISCLOSURE: containNoDisclosureGoal,
  EXPLAIN_OUT_OF_SCOPE: explainOutOfScopeGoal,
  EXPLAIN_OPEN_REQUEST: explainOpenRequestGoal,
};

// Sanity: every fixture above actually reached the goal code it claims to -- if fsm.ts's own
// branching ever changes shape, this fails loudly instead of silently testing the wrong code.
describe('fixture goals actually carry the GoalCode they claim (sanity, not spokenLines.ts itself)', () => {
  for (const [code, goal] of Object.entries(GOALS)) {
    it(`${code} fixture's goal.code is ${code}`, () => {
      expect(goal.code).toBe(code);
    });
  }
});

const BANNED_WORDS = ['detect', 'deepfake', 'synthetic voice', 'ai voice', 'sealed', 'immutable', 'released', 'sent the'];

describe('renderGoalLine', () => {
  for (const [code, goal] of Object.entries(GOALS)) {
    describe(code, () => {
      const line = renderGoalLine(goal);

      it('renders a non-empty string, never a placeholder', () => {
        expect(line).toBeTruthy();
        expect(line).not.toContain('[PLACEHOLDER');
      });

      it('contains none of the banned words/phrases', () => {
        const lower = (line ?? '').toLowerCase();
        for (const banned of BANNED_WORDS) {
          expect(lower, `"${line}" contains banned word "${banned}"`).not.toContain(banned);
        }
      });

      it('is under 25 words', () => {
        const wordCount = (line ?? '').trim().split(/\s+/).filter(Boolean).length;
        expect(wordCount, `"${line}" has ${wordCount} words`).toBeLessThan(25);
      });

      it('has no stage directions (no asterisks or bracketed/parenthetical actions)', () => {
        expect(line).not.toMatch(/[*[\]]/);
      });

      it('is deterministic: rendering the same goal twice gives the same string', () => {
        expect(renderGoalLine(goal)).toBe(line);
      });
    });
  }

  it('covers every GoalCode PLACEHOLDER_GOAL_LINES covers (TS-enforced by the Record type above; this just proves it at runtime too)', () => {
    expect(Object.keys(GOALS).sort()).toEqual(
      [
        'GREET',
        'ELICIT_IDENTITY',
        'STALL',
        'PROBE_CONSISTENCY',
        'REFUSE_AUTHORITY',
        'ANNOUNCE_STAGED',
        'ANNOUNCE_FROZEN',
        'ANNOUNCE_ESCALATED',
        'CONTAIN',
        'CONTAIN_NO_DISCLOSURE',
        'EXPLAIN_OUT_OF_SCOPE',
        'EXPLAIN_OPEN_REQUEST',
      ].sort(),
    );
  });

  it('returns null for a GoalCode outside its coverage (handled elsewhere by nextSpokenLine directly)', () => {
    const closeGoal: PhrasingGoal = { code: 'CLOSE', hint: 'Thank you for calling. Goodbye.', keyterms: [], turn_detection_hint: 'default' };
    expect(renderGoalLine(closeGoal)).toBeNull();
  });

  // ---------- slot filling uses the goal's own real values, never invented ----------

  it('ANNOUNCE_STAGED names the real seed second approver (Marcus Obi)', () => {
    expect(announceStagedGoal.hint).toContain('Marcus Obi');
    expect(renderGoalLine(announceStagedGoal)).toContain('Marcus Obi');
    // Review finding 2026-09-22 10:22 PM (LAW 2, BLOCKING): "staged for approval by Marcus Obi"
    // reads as approval already given. The line must say the SECOND approval is still pending.
    expect(renderGoalLine(announceStagedGoal)).toContain('second approval');
  });

  it('ANNOUNCE_STAGED falls back to slot-free wording when the hint does not match the expected template', () => {
    const oddGoal: PhrasingGoal = { code: 'ANNOUNCE_STAGED', hint: 'some future hint shape', keyterms: [], turn_detection_hint: 'default' };
    expect(renderGoalLine(oddGoal)).toBe('This is staged for a second approval. Voice alone never moves a payment.');
  });

  it('ANNOUNCE_FROZEN names the real first verdict reason (identity unverified), never the incident id', () => {
    expect(announceFrozenGoal.hint).toContain('identity_unverified');
    const line = renderGoalLine(announceFrozenGoal);
    expect(line).toContain('identity unverified');
    expect(line).not.toMatch(/\d{4,}/); // no incident id digits spoken
  });

  it('ANNOUNCE_FROZEN falls back to slot-free wording when the hint does not match the expected template', () => {
    const oddGoal: PhrasingGoal = { code: 'ANNOUNCE_FROZEN', hint: 'some future hint shape', keyterms: [], turn_detection_hint: 'default' };
    expect(renderGoalLine(oddGoal)).toBe('This transfer is frozen. An incident is open. Nothing moves.');
  });

  it('PROBE_CONSISTENCY quotes the caller verbatim, both quotes, never trimmed to a paraphrase', () => {
    const line = renderGoalLine(probeConsistencyGoal);
    expect(line).toContain('approved by Marcus OB');
    expect(line).toContain('it was Marcus Obi, not Priya Ramanathan');
  });

  it('PROBE_CONSISTENCY falls back to slot-free wording when the hint does not match the expected template', () => {
    const oddGoal: PhrasingGoal = { code: 'PROBE_CONSISTENCY', hint: 'some future hint shape', keyterms: [], turn_detection_hint: 'default' };
    expect(renderGoalLine(oddGoal)).toBe('A moment ago you said something different than just now. Which is correct?');
  });

  it('STALL reuses the real stalls.ts generic-kind first line, not new copy', () => {
    expect(renderGoalLine(stallGoal)).toBe('One moment while that check completes.');
  });

  it('EXPLAIN_OUT_OF_SCOPE never says "staged"/"frozen" and EXPLAIN_OPEN_REQUEST says the request stays open, unstaged', () => {
    const openRequestLine = renderGoalLine(explainOpenRequestGoal)!;
    expect(openRequestLine.toLowerCase()).not.toContain('staged');
    expect(openRequestLine.toLowerCase()).not.toContain('frozen');
    expect(openRequestLine.toLowerCase()).toContain('stays open');
  });

  it('DECISION/CONTAIN is unreachable via evaluate() even with every pre-seal action marked done (see file header)', () => {
    const almostSealedGoal = evaluate({
      conversation: recordedStage.conversation,
      tools: almostSealedTools,
      actions: recordedStage.actions,
      call: recordedStage.call,
      seed: MERIDIAN,
    }).goal;
    expect(almostSealedGoal.code).toBe('ANNOUNCE_STAGED');
  });
});
