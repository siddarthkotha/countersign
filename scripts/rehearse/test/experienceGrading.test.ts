// scripts/rehearse/test/experienceGrading.test.ts
// PROVEN examples below are lifted directly from the founder's own recorded diagnostics
// bundles (scripts/rehearse/reports/founder-2026-09-18/*.diagnostics.json, gitignored, not
// checked in here -- see this repo's SONNET-JUSTIFIED build-lane spec, 2026-09-18) and from
// that morning's rehearsal-harness reports that graded PASS despite the same defects
// (scripts/rehearse/reports/2026-09-18T10-5*). Each test below reproduces the MINIMAL slice
// of real event data (exact kinds/detail shapes/timestamps) needed to exercise one check,
// so a change to any heuristic that stops catching a PROVEN example fails loudly here.
import { describe, expect, it } from 'vitest';
import {
  computeExperienceGrade,
  goodbyeDelay,
  holdingSpam,
  mergedReply,
  questionLag,
  repeatedQuestion,
  talkOver,
} from '../experienceGrading.js';
import type { RehearseDiagnosticBundle, RehearseDiagnosticEvent } from '../types.js';

function bundle(events: Array<{ t_ms: number; kind: string; detail: unknown }>): RehearseDiagnosticBundle {
  const server_events: RehearseDiagnosticEvent[] = events.map((e) => ({ t_ms: e.t_ms, kind: e.kind, detail: e.detail }));
  return {
    session_id: 'sess-1',
    started_at: 0,
    ended_at: null,
    end_reason: null,
    deployed_commit: null,
    server_events,
    client_events: [],
  };
}

function agentTranscript(t_ms: number, text: string) {
  return { t_ms, kind: 'transcript', detail: { role: 'agent', length: text.length, text } };
}
function userTranscript(t_ms: number, text: string) {
  return { t_ms, kind: 'transcript', detail: { role: 'user', length: text.length, text } };
}
function readbackIssued(t_ms: number, field: string, reply_id: string) {
  return { t_ms, kind: 'action_logged', detail: { kind: 'readback_issued', t_ms, field, spec_kind: 'READBACK', reply_id } };
}
function challengeIssued(t_ms: number, challenge_id: string, reply_id: string) {
  return { t_ms, kind: 'action_logged', detail: { kind: 'challenge_issued', t_ms, challenge_id, fact_id: null, spec_kind: 'TRAP_FACT', reply_id } };
}
function speechStarted(t_ms: number) {
  return { t_ms, kind: 'input.speech.started', detail: {} };
}
function speechStopped(t_ms: number) {
  return { t_ms, kind: 'input.speech.stopped', detail: {} };
}
function replyStarted(t_ms: number) {
  return { t_ms, kind: 'reply.started', detail: {} };
}

describe('repeatedQuestion', () => {
  it('PROVEN 32cbb410: account_last4 readback issued at 57.841s and again at 65.765s with no caller line between -- 1 repeat', () => {
    const b = bundle([
      readbackIssued(57841, 'account_last4', 'r1'),
      readbackIssued(65765, 'account_last4', 'r2'),
    ]);
    const result = repeatedQuestion(b);
    expect(result.count).toBe(1);
    expect(result.timestamps_s).toEqual([65.765]);
  });

  it('PROVEN 32cbb410: beneficiary readback issued at 72.144s and again at 77.757s -- 1 repeat', () => {
    const b = bundle([
      readbackIssued(72144, 'beneficiary', 'r1'),
      readbackIssued(77757, 'beneficiary', 'r2'),
    ]);
    expect(repeatedQuestion(b).count).toBe(1);
  });

  it('PROVEN 95b9ad42: the approver LIVE_COMMITMENT challenge asked four times (78.723, 83.793, 97.874, 110.739s) -- 3 repeats, even though a (non-answering) caller line landed between some of them', () => {
    const b = bundle([
      challengeIssued(78723, 'call-1-3', 'r1'),
      userTranscript(88000, 'I did not mention anyone.'),
      challengeIssued(83793, 'call-1-3', 'r2'),
      challengeIssued(97874, 'call-1-3', 'r3'),
      userTranscript(103000, 'I did not mention anyone.'),
      challengeIssued(110739, 'call-1-3', 'r4'),
    ]);
    const result = repeatedQuestion(b);
    expect(result.count).toBe(3);
  });

  it('does not flag a field asked only once', () => {
    const b = bundle([readbackIssued(1000, 'amount_usd', 'r1')]);
    expect(repeatedQuestion(b).count).toBe(0);
  });

  it('two DIFFERENT fields are never grouped together', () => {
    const b = bundle([readbackIssued(1000, 'amount_usd', 'r1'), readbackIssued(2000, 'account_last4', 'r2')]);
    expect(repeatedQuestion(b).count).toBe(0);
  });
});

describe('mergedReply', () => {
  it('PROVEN 32cbb410 19.7s: two sentences interleaved word-by-word, no punctuation-after-space anywhere', () => {
    const b = bundle([
      agentTranscript(
        19714,
        'Just to confirm, this transfer goes to NorthOne moment. Who isgate Partners. calling and what Is that correct is your? department?',
      ),
    ]);
    expect(mergedReply(b).count).toBe(1);
  });

  it('PROVEN 95b9ad42 19.1s: "Just toOne confirm, moment this transfer..."', () => {
    const b = bundle([
      agentTranscript(
        19084,
        'Just toOne confirm, moment this transfer goes to Northgate Partners. Who is calling and what is. Is that your authorization correct? code?',
      ),
    ]);
    expect(mergedReply(b).count).toBe(1);
  });

  it('PROVEN harness 10-54-17 18.1s: a "?" immediately followed by a capital letter, no space', () => {
    const b = bundle([
      agentTranscript(
        18147,
        'Just to confirm, this transfer goes to Northgate Partners. Is that correct?One moment. Who are you calling from and what is your primary purpose for this transfer?',
      ),
    ]);
    expect(mergedReply(b).count).toBe(1);
  });

  it('does not flag a clean, normally punctuated engine sentence', () => {
    const b = bundle([agentTranscript(1000, 'Just to confirm, the amount is $84,500. Is that correct?')]);
    expect(mergedReply(b).count).toBe(0);
  });

  it('does not flag a clean holding-line-then-question composition', () => {
    const b = bundle([agentTranscript(1000, 'One moment. Just to confirm, the amount is $84,500. Is that correct?')]);
    expect(mergedReply(b).count).toBe(0);
  });

  it('flags two "is that correct" in one line even with no punctuation/capital break', () => {
    const b = bundle([agentTranscript(1000, 'is that correct is that correct really')]);
    expect(mergedReply(b).count).toBe(1);
  });
});

describe('talkOver', () => {
  it('PROVEN 391e2a37 35.8s: caller says "No." (1 word), reply.started fires 7ms later -- the caller was cut off before continuing with "Meridian Supply."', () => {
    const b = bundle([
      speechStarted(35392),
      speechStopped(35793),
      userTranscript(35793, 'No.'),
      replyStarted(35800),
    ]);
    const result = talkOver(b);
    expect(result.count).toBe(1);
    expect(result.timestamps_s).toEqual([35.8]);
  });

  it('does not flag reply.started after a normal-length caller utterance, even with near-zero gap', () => {
    const b = bundle([
      speechStarted(1000),
      speechStopped(2000),
      userTranscript(2000, 'Yes, that is right.'),
      replyStarted(2005),
    ]);
    expect(talkOver(b).count).toBe(0);
  });

  it('flags reply.started that lands well inside an open caller speech window (genuine overlap, not a same-instant race)', () => {
    const b = bundle([
      speechStarted(1000),
      userTranscript(1000, 'placeholder'),
      replyStarted(1500),
      speechStopped(3000),
    ]);
    expect(talkOver(b).count).toBe(1);
  });

  it('does NOT flag a reply.started within 50ms of a window close (event-arrival jitter, not a real cutoff)', () => {
    const b = bundle([
      speechStarted(33927),
      userTranscript(35329, "Yes, that's right."),
      replyStarted(35334),
      speechStopped(35338),
    ]);
    expect(talkOver(b).count).toBe(0);
  });

  it('never flags the CALLER interrupting the agent (a legitimate barge-in) -- only reply.started events are ever examined', () => {
    const b = bundle([
      replyStarted(0),
      agentTranscript(300, 'Meridian payments desk...'),
      speechStarted(400),
      { t_ms: 400, kind: 'reply.done', detail: { status: 'interrupted' } },
    ]);
    expect(talkOver(b).count).toBe(0);
  });
});

describe('holdingSpam', () => {
  it('PROVEN 391e2a37 53.228s: a bare "One moment." not followed by anything for 5.469s', () => {
    const b = bundle([
      agentTranscript(53228, 'One moment.'),
      agentTranscript(58697, 'Just to confirm, the account ends in 4 4 7 1. Is that correct?'),
    ]);
    const result = holdingSpam(b);
    expect(result.count).toBe(1);
    expect(result.timestamps_s).toEqual([53.228]);
  });

  it('does not flag a bare "One moment." immediately followed by a substantive line', () => {
    const b = bundle([
      agentTranscript(1000, 'One moment.'),
      agentTranscript(1500, 'Just to confirm, the amount is $84,500. Is that correct?'),
    ]);
    expect(holdingSpam(b).count).toBe(0);
  });

  it('flags a second bare "One moment." with no caller line between the two', () => {
    const b = bundle([
      agentTranscript(1000, 'One moment.'),
      agentTranscript(1200, 'One moment.'),
      agentTranscript(1400, 'Just to confirm...'),
    ]);
    expect(holdingSpam(b).count).toBe(1);
  });

  it('does not flag two bare "One moment." lines separated by a caller turn', () => {
    const b = bundle([
      agentTranscript(1000, 'One moment.'),
      agentTranscript(1200, 'Just to confirm, the amount is $84,500. Is that correct?'),
      userTranscript(3000, 'Yes.'),
      agentTranscript(3200, 'One moment.'),
      agentTranscript(3400, 'Just to confirm, the account ends in 4471. Is that correct?'),
    ]);
    expect(holdingSpam(b).count).toBe(0);
  });
});

describe('questionLag', () => {
  it('is always skipped -- the bundle shape has no reply_id on a transcript event', () => {
    const result = questionLag(bundle([]));
    expect(result.skipped).toBe(true);
    expect(result.count).toBe(0);
    expect(result.skip_reason).toBeTruthy();
  });
});

describe('goodbyeDelay', () => {
  it('PROVEN 391e2a37: terminal_action at 73.69s, close line spoken at 84.119s -- 10.429s', () => {
    const b = bundle([
      { t_ms: 73690, kind: 'terminal_action', detail: { verdict: 'STAGE', actions: [] } },
      agentTranscript(77629, 'One moment.'),
      agentTranscript(84119, 'Your request is staged for independent approval. The payment is not released. Goodbye.'),
    ]);
    const result = goodbyeDelay(b);
    expect(result.seconds).toBeCloseTo(10.429, 2);
    expect(result.close_retry_needed).toBe(false);
  });

  it('flags close_retry_needed when a reply_create_sent with reason close_retry was sent', () => {
    const b = bundle([
      { t_ms: 1000, kind: 'terminal_action', detail: { verdict: 'STAGE', actions: [] } },
      { t_ms: 1500, kind: 'reply_create_sent', detail: { goal_code: 'CLOSE', reason: 'close_retry' } },
      agentTranscript(2000, 'Your request is staged for independent approval. The payment is not released. Goodbye.'),
    ]);
    expect(goodbyeDelay(b).close_retry_needed).toBe(true);
  });

  it('returns seconds: null and a note when no terminal_action was ever logged', () => {
    const result = goodbyeDelay(bundle([]));
    expect(result.seconds).toBeNull();
    expect(result.note).toMatch(/terminal_action/);
  });
});

describe('computeExperienceGrade', () => {
  it('ok is false the moment any of the four gating checks is non-zero', () => {
    const b = bundle([readbackIssued(1000, 'amount_usd', 'r1'), readbackIssued(2000, 'amount_usd', 'r2')]);
    const grade = computeExperienceGrade(b);
    expect(grade.repeated_question.count).toBe(1);
    expect(grade.ok).toBe(false);
  });

  it('ok is true when every gating check is zero, regardless of question_lag (skipped) or goodbye_delay (informational)', () => {
    const b = bundle([
      agentTranscript(5000, 'Meridian payments desk, verification line. How can I help you today?'),
      userTranscript(10000, 'This is Dana. I need to wire $84,500.'),
    ]);
    const grade = computeExperienceGrade(b);
    expect(grade.ok).toBe(true);
  });
});
