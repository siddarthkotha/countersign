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
    expect(computeQuestionAnswerRatio(transcript)).toEqual({ answered: 1, total: 1, unanswered: [], unanswered_no_chance: [] });
  });

  it('counts a question followed immediately by another agent line as unanswered', () => {
    const transcript = [line('agent', 'Is that right?', 0), line('agent', 'One moment, verifying.', 1000)];
    const result = computeQuestionAnswerRatio(transcript);
    expect(result.answered).toBe(0);
    expect(result.total).toBe(1);
    expect(result.unanswered).toEqual(['Is that right?']);
  });

  it('counts a question that is the last line of the transcript as unanswered', () => {
    const transcript = [line('caller', 'Hi.', 0), line('agent', 'Can you confirm the amount?', 500)];
    const result = computeQuestionAnswerRatio(transcript);
    expect(result).toEqual({ answered: 0, total: 1, unanswered: ['Can you confirm the amount?'], unanswered_no_chance: [] });
  });

  it('ignores agent lines that do not end in a question mark', () => {
    const transcript = [line('agent', 'Your request is staged.', 0)];
    expect(computeQuestionAnswerRatio(transcript)).toEqual({ answered: 0, total: 0, unanswered: [], unanswered_no_chance: [] });
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
    expect(result).toEqual({ answered: 1, total: 1, unanswered: [], unanswered_no_chance: [] });
  });

  it('collapses consecutive identical questions (normalized) into one', () => {
    const transcript = [
      line('agent', 'Which institution holds the escrow?', 5000),
      line('agent', 'I understand. Which institution holds the escrow?', 10000),
      line('caller', 'Whitmore Bank.', 15000),
    ];
    // Both questions normalize to "which institution holds the escrow"
    // So they count as ONE question (answered by the caller line)
    const result = computeQuestionAnswerRatio(transcript);
    expect(result).toEqual({ answered: 1, total: 1, unanswered: [], unanswered_no_chance: [] });
  });

  it('detects identical questions with different fillers', () => {
    const transcript = [
      line('agent', 'Which institution holds the Hartwell escrow?', 81447),
      line('agent', 'Hold on. Which institution holds the Hartwell escrow?', 86487),
      // No caller response, then close line follows
      line('agent', 'This transfer is frozen and an incident has been opened for review. Nothing has moved. Goodbye.', 94467),
    ];
    // Both agent questions normalize to the same thing and collapse to one unanswered
    // Gap is 86487 - 81447 = 5040ms > 1500ms, so the caller had a chance
    const result = computeQuestionAnswerRatio(transcript);
    expect(result.total).toBe(1);
    expect(result.answered).toBe(0);
    expect(result.unanswered).toHaveLength(1);
    expect(result.unanswered_no_chance).toHaveLength(0); // Caller had > 1500ms to respond
  });

  it('does not count questions asked at or after the close line', () => {
    const transcript = [
      line('agent', 'What is the amount?', 100),
      line('caller', '$84,500.', 200),
      line('agent', 'Your request is staged for a second, independent approval. Nothing has been released. The evidence record is complete. Goodbye.', 1000),
      line('agent', 'Are you still there?', 2000),
      line('agent', 'Hello?', 3000),
    ];
    // Only the first question should count
    const result = computeQuestionAnswerRatio(transcript);
    expect(result.total).toBe(1);
    expect(result.answered).toBe(1);
    expect(result.unanswered).toEqual([]);
    expect(result.unanswered_no_chance).toEqual([]);
  });

  it('counts a question answered if any caller line appears before the close line, even with agent lines in between', () => {
    const transcript = [
      line('agent', 'What is the amount?', 100),
      line('agent', 'Please confirm.', 150),
      line('agent', 'One moment.', 200),
      line('caller', '$84,500.', 250),
      line('agent', 'Thank you.', 300),
    ];
    // The question at t=100 is answered by the caller line at t=250, even with agent lines in between
    const result = computeQuestionAnswerRatio(transcript);
    expect(result).toEqual({ answered: 1, total: 1, unanswered: [], unanswered_no_chance: [] });
  });

  it('detects genuinely unanswered questions mid-call', () => {
    const transcript = [
      line('agent', 'What is the amount?', 100),
      line('agent', 'Please restate the amount?', 500),
      line('agent', 'Hello?', 1000),
    ];
    // All three questions are unanswered
    const result = computeQuestionAnswerRatio(transcript);
    expect(result.total).toBe(3);
    expect(result.answered).toBe(0);
    expect(result.unanswered).toEqual(['What is the amount?', 'Please restate the amount?', 'Hello?']);
  });
});

describe('questionAnswerRatioDisplay', () => {
  it('shows "answered/total"', () => {
    expect(questionAnswerRatioDisplay({ answered: 2, total: 3, unanswered: ['x'], unanswered_no_chance: [] })).toBe('2/3');
  });

  it('notes when the agent asked no questions', () => {
    expect(questionAnswerRatioDisplay({ answered: 0, total: 0, unanswered: [], unanswered_no_chance: [] })).toMatch(/no questions/);
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

  it('fails with fail_reason unanswered_agent_question when the agent gave no chance to answer', () => {
    const scenario = baseScenario();
    // Two back-to-back questions with < 1500ms gap: agent gave no chance
    const transcript = [
      line('agent', 'Can you confirm the account?', 0),
      line('agent', 'Please confirm the account?', 500),
    ];
    const result = gradeFreePlay({ scenario, actualVerdict: 'STAGE', verdictReached: true, turnGaps: [], transcript, agentSilenceFailMs: 12000 });
    expect(result.pass).toBe(false);
    expect(result.fail_reason).toBe('unanswered_agent_question');
  });

  it('passes when a question is unanswered but the agent gave the caller a chance', () => {
    const scenario = baseScenario();
    // Question with a long gap before the next agent line: caller had > 1500ms chance
    const transcript = [
      line('agent', 'Can you confirm the account?', 0),
      line('agent', 'Hello, are you there?', 2000),
    ];
    const result = gradeFreePlay({ scenario, actualVerdict: 'STAGE', verdictReached: true, turnGaps: [], transcript, agentSilenceFailMs: 12000 });
    expect(result.pass).toBe(true);
    expect(result.fail_reason).toBeUndefined();
    // There's a warning in failures, but not a fail_reason
    expect(result.failures.some((f) => f.includes('caller-chose-not-to') || f.includes('chance'))).toBe(true);
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
