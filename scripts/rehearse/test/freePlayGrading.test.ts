// Exercises every free-play grading rule (freePlayGrading.ts) against hand-built
// TranscriptRecord/TurnGapRecord arrays -- pure functions, no CallClient, no network, per
// CLAUDE.md's "tests must not need the network" rule.
import { describe, expect, it } from 'vitest';
import {
  acceptableVerdicts,
  checkNoExcessiveSilence,
  computeQuestionAnswerRatio,
  gradeFreePlay,
  questionAnswerRatioDisplay,
  verdictIsAcceptable,
} from '../freePlayGrading.js';
import type { Scenario, TranscriptRecord, TurnGapRecord } from '../types.js';

function baseScenario(overrides: Partial<Scenario['expected']> = {}): Scenario {
  return {
    name: 'x',
    title: 'x',
    description: '',
    source: '',
    turns: [{ id: 'c1', text: 'hi' }],
    expected: { verdict: 'STAGE', max_wall_ms: 60000, ...overrides },
  };
}

describe('acceptableVerdicts / verdictIsAcceptable', () => {
  it('falls back to the single expected.verdict when expected.verdicts is absent', () => {
    const scenario = baseScenario();
    expect(acceptableVerdicts(scenario)).toEqual(['STAGE']);
    expect(verdictIsAcceptable(scenario, 'STAGE')).toBe(true);
    expect(verdictIsAcceptable(scenario, 'FREEZE')).toBe(false);
  });

  it('accepts any verdict in expected.verdicts when the scenario lists several', () => {
    const scenario = baseScenario({ verdicts: ['STAGE', 'ESCALATE'] });
    expect(verdictIsAcceptable(scenario, 'ESCALATE')).toBe(true);
    expect(verdictIsAcceptable(scenario, 'STAGE')).toBe(true);
    expect(verdictIsAcceptable(scenario, 'FREEZE')).toBe(false);
  });

  it('never accepts PENDING or null, even if somehow listed', () => {
    const scenario = baseScenario();
    expect(verdictIsAcceptable(scenario, 'PENDING')).toBe(false);
    expect(verdictIsAcceptable(scenario, null)).toBe(false);
  });
});

describe('checkNoExcessiveSilence', () => {
  const maxGapMs = 12000;

  it('passes when every gap is within the limit', () => {
    const gaps: TurnGapRecord[] = [
      { turn_id: 'c1', caller_end_ms: 0, first_reply_audio_ms: 1000, gap_ms: 1000 },
      { turn_id: 'c2', caller_end_ms: 5000, first_reply_audio_ms: 8000, gap_ms: 3000 },
    ];
    expect(checkNoExcessiveSilence(gaps, maxGapMs)).toEqual({ ok: true, failures: [] });
  });

  it('fails when a gap exceeds the limit', () => {
    const gaps: TurnGapRecord[] = [{ turn_id: 'c1', caller_end_ms: 0, first_reply_audio_ms: 20000, gap_ms: 20000 }];
    const result = checkNoExcessiveSilence(gaps, maxGapMs);
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toMatch(/c1/);
    expect(result.failures[0]).toMatch(/20000ms/);
  });

  it('fails when no reply audio was ever observed after a turn', () => {
    const gaps: TurnGapRecord[] = [{ turn_id: 'c1', caller_end_ms: 0, first_reply_audio_ms: null, gap_ms: null, note: 'no reply audio observed after this turn' }];
    const result = checkNoExcessiveSilence(gaps, maxGapMs);
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toMatch(/no agent reply audio/);
  });

  it('never flags a barge-in turn (gap_ms null, note mentions barge-in)', () => {
    const gaps: TurnGapRecord[] = [{ turn_id: 'c1', caller_end_ms: 0, first_reply_audio_ms: null, gap_ms: null, note: 'barge-in turn: gap not meaningful' }];
    expect(checkNoExcessiveSilence(gaps, maxGapMs)).toEqual({ ok: true, failures: [] });
  });
});

function line(speaker: 'agent' | 'caller', text: string, t_ms: number): TranscriptRecord {
  return { speaker, text, t_ms };
}

describe('computeQuestionAnswerRatio', () => {
  it('counts a question followed by a caller line as answered', () => {
    const transcript = [line('agent', 'Is that right?', 0), line('caller', 'Yes.', 500)];
    expect(computeQuestionAnswerRatio(transcript)).toEqual({ answered: 1, total: 1, unanswered: [] });
  });

  it('counts a question followed immediately by another agent line as unanswered', () => {
    const transcript = [line('agent', 'Is that right?', 0), line('agent', 'One moment, verifying.', 1000)];
    const result = computeQuestionAnswerRatio(transcript);
    expect(result).toEqual({ answered: 0, total: 1, unanswered: ['Is that right?'] });
  });

  it('counts a question that is the last line of the transcript as unanswered', () => {
    const transcript = [line('caller', 'Hi.', 0), line('agent', 'Can you confirm the amount?', 500)];
    const result = computeQuestionAnswerRatio(transcript);
    expect(result).toEqual({ answered: 0, total: 1, unanswered: ['Can you confirm the amount?'] });
  });

  it('ignores agent lines that do not end in a question mark', () => {
    const transcript = [line('agent', 'Your request is staged.', 0)];
    expect(computeQuestionAnswerRatio(transcript)).toEqual({ answered: 0, total: 0, unanswered: [] });
  });

  it('handles multiple questions independently, in order', () => {
    const transcript = [
      line('agent', 'Who is this?', 0),
      line('caller', 'Dana Whitfield.', 100),
      line('agent', 'What is the amount?', 200),
      line('agent', 'Never mind, restate the beneficiary?', 300),
    ];
    const result = computeQuestionAnswerRatio(transcript);
    expect(result.total).toBe(3);
    expect(result.answered).toBe(1);
    expect(result.unanswered).toEqual(['What is the amount?', 'Never mind, restate the beneficiary?']);
  });

  it('excludes any agent question timestamped after silentAfterMs entirely', () => {
    const transcript = [
      line('agent', 'What is the amount?', 100),
      line('caller', '$84,500.', 200),
      line('agent', 'Are you still there?', 5000),
      line('agent', 'Hello?', 10000),
    ];
    const result = computeQuestionAnswerRatio(transcript, 200);
    expect(result).toEqual({ answered: 1, total: 1, unanswered: [] });
  });
});

describe('questionAnswerRatioDisplay', () => {
  it('shows "answered/total"', () => {
    expect(questionAnswerRatioDisplay({ answered: 2, total: 3, unanswered: ['x'] })).toBe('2/3');
  });

  it('notes when the agent asked no questions', () => {
    expect(questionAnswerRatioDisplay({ answered: 0, total: 0, unanswered: [] })).toMatch(/no questions/);
  });
});

describe('gradeFreePlay', () => {
  it('passes when the verdict is acceptable, no excessive silence, and every question was answered', () => {
    const scenario = baseScenario();
    const transcript = [line('agent', 'Is that right?', 0), line('caller', 'Yes.', 500)];
    const turnGaps: TurnGapRecord[] = [{ turn_id: 'c1', caller_end_ms: 500, first_reply_audio_ms: 1000, gap_ms: 500 }];
    const result = gradeFreePlay({ scenario, actualVerdict: 'STAGE', verdictReached: true, turnGaps, transcript, agentSilenceFailMs: 12000 });
    expect(result.pass).toBe(true);
    expect(result.fail_reason).toBeUndefined();
  });

  it('fails with fail_reason agent_silence_exceeded on an excessive gap', () => {
    const scenario = baseScenario();
    const turnGaps: TurnGapRecord[] = [{ turn_id: 'c1', caller_end_ms: 0, first_reply_audio_ms: 20000, gap_ms: 20000 }];
    const result = gradeFreePlay({ scenario, actualVerdict: 'STAGE', verdictReached: true, turnGaps, transcript: [], agentSilenceFailMs: 12000 });
    expect(result.pass).toBe(false);
    expect(result.fail_reason).toBe('agent_silence_exceeded');
  });

  it('fails with fail_reason unanswered_agent_question when a question goes unanswered', () => {
    const scenario = baseScenario();
    const transcript = [line('agent', 'Can you confirm the account?', 0)];
    const result = gradeFreePlay({ scenario, actualVerdict: 'STAGE', verdictReached: true, turnGaps: [], transcript, agentSilenceFailMs: 12000 });
    expect(result.pass).toBe(false);
    expect(result.fail_reason).toBe('unanswered_agent_question');
  });

  it('a deliberate persona silence (silentAfterMs) never fails the run on later unanswered questions', () => {
    const scenario = baseScenario({ verdict: 'ESCALATE' });
    const transcript = [
      line('caller', 'This is Dana Whitfield, wiring $84,500.', 0),
      line('agent', 'Can you confirm the account number?', 1000),
      line('agent', 'Hello, are you still there?', 40000),
    ];
    const result = gradeFreePlay({
      scenario,
      actualVerdict: 'ESCALATE',
      verdictReached: true,
      turnGaps: [],
      transcript,
      agentSilenceFailMs: 12000,
      silentAfterMs: 0,
    });
    expect(result.pass).toBe(true);
    expect(result.question_answer.total).toBe(0);
  });

  it('turnLoopFailReason (holding line then silence) takes precedence and is passed through verbatim', () => {
    const scenario = baseScenario();
    const result = gradeFreePlay({
      scenario,
      actualVerdict: 'PENDING',
      verdictReached: false,
      turnGaps: [],
      transcript: [],
      agentSilenceFailMs: 12000,
      turnLoopFailReason: 'agent_silent_after_hold',
    });
    expect(result.pass).toBe(false);
    expect(result.fail_reason).toBe('agent_silent_after_hold');
  });

  it('fails when the verdict is not reached even if every other check passes', () => {
    const scenario = baseScenario();
    const result = gradeFreePlay({ scenario, actualVerdict: 'PENDING', verdictReached: false, turnGaps: [], transcript: [], agentSilenceFailMs: 12000 });
    expect(result.pass).toBe(false);
  });

  it('fails when the actual verdict is not in the acceptable set', () => {
    const scenario = baseScenario({ verdicts: ['STAGE', 'ESCALATE'] });
    const result = gradeFreePlay({ scenario, actualVerdict: 'FREEZE', verdictReached: true, turnGaps: [], transcript: [], agentSilenceFailMs: 12000 });
    expect(result.pass).toBe(false);
  });
});
