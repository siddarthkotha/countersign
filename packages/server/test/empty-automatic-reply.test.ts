// packages/server/test/empty-automatic-reply.test.ts
// Design E follow-up, EMPTY HOLDING REPLY (2026-09-15, measured live on deploy 39 -- see
// prompt.ts's own doc comment on STANDING_RULES): the standing rule now asks the automatic
// reply to produce literally nothing (an empty reply) rather than a "One moment." holding
// line, once it has nothing new to say -- PROVEN the old holding-beat wording made the agent
// say "One moment." four to five times per call (agent lines 14 vs 7 on the same Dana script,
// verdict-to-goodbye 13.8s vs 4.0s), and PROVEN an EMPTY automatic reply is possible at all
// (bundle 2026-09-15T08-06-07-corrected-critical-field: reply.done 0.5s after reply.started
// with no transcript in between). This file proves session.ts handles that empty-transcript
// reply cleanly end to end: not counted as a question asked, the instructed reply.create
// still follows it exactly once, and the CLOSE hang-up path is unaffected by an empty reply
// arriving before the real goodbye.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MERIDIAN, mockToolResult } from '@countersign/engine';
import type { CallContext, ServerEvent } from '@countersign/engine';
import { CallSession } from '../src/call/session.js';
import { FakeAaiSocket } from '../src/aai/fake.js';
import scenarioB from '../../engine/corpus/scenario-b-miller-fraud.json' with { type: 'json' };

const CALL_B = scenarioB.call as CallContext;

function newSession(
  clockRef: { now: number },
  call: CallContext,
  aai: FakeAaiSocket,
  sent: ServerEvent[],
  diagEvents: { kind: string; detail: unknown }[] = []
): CallSession {
  return new CallSession({
    session_id: call.session_id,
    seed: MERIDIAN,
    call,
    aai,
    now: () => clockRef.now,
    onServerEvent: (e) => sent.push(e),
    mock: mockToolResult,
    onDiagnostic: (kind, detail) => diagEvents.push({ kind, detail }),
  });
}

function replyCreatesOf(aai: FakeAaiSocket): { type?: string; instructions?: string }[] {
  return aai.sent.filter((m) => (m as { type?: string }).type === 'reply.create') as {
    type?: string;
    instructions?: string;
  }[];
}

describe('EMPTY HOLDING REPLY (2026-09-15): an automatic reply with no transcript at all is handled cleanly', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('an automatic reply that ends with no transcript is not counted as asked, and is followed by exactly one instructed reply.create carrying the goal sentence', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, CALL_B, aai, sent, diagEvents);
    session.start();

    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: scenarioB.conversation[0]!.text });
    expect(session.last?.goal.code).toBe('ASK_CHALLENGE');
    const sentence = session.last!.goal.challenge!.speak!;
    expect(replyCreatesOf(aai)).toHaveLength(1); // the proactive instructed ask (design E)

    // The reply that actually answers first is AssemblyAI's OWN automatic one -- truly empty:
    // reply.started then reply.done with NOTHING in between (no transcript.agent at all),
    // PROVEN possible live (2026-09-15T08-06-07-corrected-critical-field bundle).
    clock.now = 1200;
    aai.emit({ type: 'reply.started', reply_id: 'auto-1' });
    clock.now = 1700;
    aai.emit({ type: 'reply.done', reply_id: 'auto-1', status: 'completed' });

    // Not counted as asked -- no challenge_issued logged, the goal is unchanged.
    expect(session.logs.actions.some((a) => a.kind === 'challenge_issued')).toBe(false);
    expect(session.last?.goal.code).toBe('ASK_CHALLENGE');
    expect(session.last?.goal.challenge?.challenge_id).toBe('sess-b-1');

    // The spaced reask (+400ms, CLOSE_RETRY_MIN_GAP_MS reused for the reask timer) fires
    // exactly once, carrying the same instructed sentence -- the empty reply is treated the
    // same as any other "did not ask" reply, never specially penalized or ignored.
    vi.advanceTimersByTime(400);
    const replyCreates = replyCreatesOf(aai);
    expect(replyCreates).toHaveLength(2);
    expect(replyCreates.at(-1)!.instructions).toBe(`Say exactly this and nothing else: "${sentence}"`);

    // No further reask once nothing else changes.
    vi.advanceTimersByTime(2000);
    expect(replyCreatesOf(aai)).toHaveLength(2);
  });

  it('the goodbye path with an empty automatic reply first still ends within CLOSE_GRACE_MS + tail wait of the goodbye transcript', () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const sent: ServerEvent[] = [];
    const diagEvents: { kind: string; detail: unknown }[] = [];
    const session = newSession(clock, CALL_B, aai, sent, diagEvents);
    session.start();

    // Drive Scenario B's own c1..a4 exactly as design-e-turn-order.test.ts's own test (c) does,
    // reaching FREEZE/SEALED/CLOSE with two real challenge answers along the way.
    clock.now = 1000;
    aai.emit({ type: 'transcript.user', item_id: 'c1', text: scenarioB.conversation[0]!.text });
    clock.now = 4000;
    aai.emit({ type: 'reply.started', reply_id: 'a1' });
    aai.emit({ type: 'transcript.agent', item_id: 'x-a1', text: scenarioB.conversation[1]!.text, reply_id: 'a1', interrupted: false });
    aai.emit({ type: 'reply.done', reply_id: 'a1', status: 'completed' });

    clock.now = 8000;
    aai.emit({ type: 'transcript.user', item_id: 'c2', text: scenarioB.conversation[2]!.text });
    clock.now = 12_000;
    aai.emit({ type: 'reply.started', reply_id: 'a2' });
    aai.emit({ type: 'transcript.agent', item_id: 'x-a2', text: scenarioB.conversation[3]!.text, reply_id: 'a2', interrupted: false });
    aai.emit({ type: 'reply.done', reply_id: 'a2', status: 'completed' });

    clock.now = 40_000;
    aai.emit({ type: 'transcript.user', item_id: 'c3', text: scenarioB.conversation[4]!.text });
    clock.now = 44_000;
    aai.emit({ type: 'reply.started', reply_id: 'a3' });
    aai.emit({ type: 'transcript.agent', item_id: 'x-a3', text: scenarioB.conversation[5]!.text, reply_id: 'a3', interrupted: true });
    aai.emit({ type: 'reply.done', reply_id: 'a3', status: 'interrupted' });

    clock.now = 48_000;
    aai.emit({ type: 'transcript.user', item_id: 'c4', text: scenarioB.conversation[6]!.text });
    clock.now = 50_000;
    aai.emit({ type: 'reply.started', reply_id: 'a4' });
    aai.emit({ type: 'transcript.agent', item_id: 'x-a4', text: scenarioB.conversation[7]!.text, reply_id: 'a4', interrupted: false });
    aai.emit({ type: 'reply.done', reply_id: 'a4', status: 'completed' });

    if (session.last?.goal.code === 'ASK_CHALLENGE' && session.last.goal.challenge) {
      clock.now = 50_100;
      const s1 = session.last.goal.challenge.speak!;
      aai.emit({ type: 'reply.started', reply_id: 'x1' });
      aai.emit({ type: 'transcript.agent', item_id: 'ax1', text: s1, reply_id: 'x1', interrupted: false });
      aai.emit({ type: 'reply.done', reply_id: 'x1', status: 'completed' });
    }
    if (session.last?.goal.code === 'ASK_CHALLENGE' && session.last.goal.challenge) {
      clock.now = 50_200;
      const s2 = session.last.goal.challenge.speak!;
      aai.emit({ type: 'reply.started', reply_id: 'x2' });
      aai.emit({ type: 'transcript.agent', item_id: 'ax2', text: s2, reply_id: 'x2', interrupted: false });
      aai.emit({ type: 'reply.done', reply_id: 'x2', status: 'completed' });
    }

    expect(session.last?.state).toBe('SEALED');
    expect(session.last?.goal.code).toBe('CLOSE');
    const closeSentence = session.last!.goal.hint;

    // CLOSE's own reply.create has already gone out (tick_end). The reply that answers it
    // FIRST is AssemblyAI's own automatic one -- empty, per this task's other fix: reply.started
    // then reply.done with no transcript at all.
    clock.now = 51_000;
    aai.emit({ type: 'reply.started', reply_id: 'auto-close' });
    clock.now = 51_100;
    aai.emit({ type: 'reply.done', reply_id: 'auto-close', status: 'completed' });

    // Not the goodbye: the call must not end yet, and no false match was recorded.
    expect(sent.some((e) => e.type === 'ended')).toBe(false);

    // Defect B's own transcript-wait (1500ms) elapses with nothing to match, then the spaced
    // retry (400ms) sends the REAL close instructed reply.create.
    vi.advanceTimersByTime(1_500 + 400);
    const closeRetryDiags = diagEvents.filter(
      (e) => e.kind === 'reply_create_sent' && (e.detail as { goal_code: string }).goal_code === 'CLOSE' && (e.detail as { reason: string }).reason === 'close_retry'
    );
    expect(closeRetryDiags).toHaveLength(1);

    // This retry's own reply actually says the close sentence -- the real goodbye.
    clock.now = 53_100;
    aai.emit({ type: 'reply.started', reply_id: 'close-2' });
    aai.emit({ type: 'transcript.agent', item_id: 'x-close-2', text: closeSentence, reply_id: 'close-2', interrupted: false });
    const goodbyeHeardAt = 53_200;
    clock.now = goodbyeHeardAt;
    aai.emit({ type: 'reply.done', reply_id: 'close-2', status: 'completed' });

    // Ends within CLOSE_GRACE_MS (1500ms; no audio was ever relayed for this transcript-only
    // fixture, so the flat grace applies, never the longer audio-based tail wait) of the
    // goodbye transcript actually landing -- not blocked or delayed by the earlier empty reply.
    expect(sent.some((e) => e.type === 'ended')).toBe(false);
    vi.advanceTimersByTime(1_500);
    const ended = sent.find((e) => e.type === 'ended');
    expect(ended).toBeDefined();
  });
});
