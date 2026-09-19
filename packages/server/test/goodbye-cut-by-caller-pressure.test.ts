// packages/server/test/goodbye-cut-by-caller-pressure.test.ts
// GOODBYE-CUT-BY-CALLER-PRESSURE (2026-09-19, PROVEN live on deploy 58): three scripted
// barge-ins during the CLOSE goodbye let the caller hang up having heard, at most, a fragment
// of it -- proven three separate ways on three separate live bundles the same day:
//
//   (B1) scripts/rehearse/reports/2026-09-19T14-17-22-miller-patient.diagnostics.json: after
//   the FREEZE verdict our CLOSE reply.create went out at 42020 (19ms after the caller's own
//   turn), reply.started (ours:true) at 42032. The caller then barged in three times: attempt
//   1 cut after "This" (55,680 bytes/1.2s); attempt 2 cut after "This transfer is frozen"
//   (104,640 bytes/2.2s); attempt 3 produced the FULL 86-char transcript at 50001 -- but
//   input.speech.started AND that same reply's own reply.done{status:'interrupted'} both
//   landed 5ms later, at 50006, with only 37,920 bytes (0.79s) of audio ever relayed.
//   close_tail_wait accepted the transcript alone and the call ended 1.5s later: the caller
//   heard at most "This" of the real goodbye.
//
//   (B2) scripts/rehearse/reports/2026-09-19T14-20-58-corrected-critical-field
//   .diagnostics.json: PROVES `reply.done.status === 'completed'` is not sufficient evidence
//   either. A reply folded an automatic "One moment." holding beat together with the real
//   STAGE goodbye (97 chars total) and reported reply.done COMPLETED at 84574 -- but only the
//   first ("One moment.") segment's audio was ever streamed: 81,120 bytes (1.69s) total. The
//   caller never heard the goodbye, and the call still ended on schedule.
//
//   (C) scripts/rehearse/reports/2026-09-19T14-19-30-identity-switch.diagnostics.json: our own
//   CLOSE reply (ours:true) was cut after "This" (62,400 bytes) by a barge-in; the retry chain
//   (armCloseTranscriptWait -> armCloseRetryTimer) then tried to re-send while the caller was
//   still mid-utterance, was correctly dropped by the existing `callerSpeaking` guard -- but
//   NOTHING recorded the goodbye as still owed. When the caller's turn actually ended, an
//   AssemblyAI automatic reply (ours:false, 19ms gap) took the slot instead of our own retry,
//   and only its own (eventually correct) goodbye ended the call, 25.6s after CLOSE first
//   rendered (`goodbye_delay`).
//
// Three mechanisms close all three (call/session.ts):
//   (A) Per-goal session.update for CLOSE now carries `turn_detection: { vad_threshold: 0.5,
//       interrupt_response: false }` -- AssemblyAI's own docs ("Mutability after
//       session.ready": "input.turn_detection" -- "Yes. Adjust ... barge-in on the fly.";
//       `interrupt_response`: "Set `false` to disable barge-in entirely.") say this is mutable
//       mid-session and does exactly what (B1)/(C) need: once the verdict is sealed (LAW 2
//       containment has already run), nothing the caller says can change it, so there is no
//       reason left to let them interrupt the goodbye. See docs/ASSEMBLYAI_INTEGRATION.md's
//       dated subsection for the full verbatim quote. This suite does not re-test (A)'s wire
//       payload directly (session.test.ts's "never sends the turn_detection key ... EXCEPT
//       CLOSE" test already does, byte for byte) -- it exists as a first line of defense the
//       live docs say should work, with (B) and (C) below as the belt-and-braces backstop for
//       whenever a barge-in still gets through anyway (a caller already mid-utterance when
//       CLOSE first renders, for instance -- turn_detection changes what happens to FUTURE
//       speech, not speech already in flight).
//   (B) `closeReplyHasEnoughAudio` (session.ts): a goodbye is confirmed only once at least 50%
//       of its expected TTS byte count (~4,000 bytes/char, measured from two clean, fully
//       relayed goodbyes the same day: 339,840 bytes/86 chars and 361,080 bytes/86 chars) has
//       actually been relayed -- REGARDLESS of transcript match or `reply.done.status`. This
//       is ANDed into every confirmation branch that used to accept a transcript match alone
//       (`maybeArmCloseOnTranscript`, `scheduleCloseIfNeeded`, `armCloseTranscriptWait`).
//   (C) The turn-end catch-up (`maybeSendOwedAfterCallerTurnEnds`) and the close-retry timer's
//       own drop path (`armCloseRetryTimer`) now record a dropped-for-callerSpeaking CLOSE
//       send as owed (`owedForceSpeakGoalKey`) and deliver it SYNCHRONOUSLY
//       (`forceSpeakSettleMs`, 0 by default) the instant the caller's turn ends, instead of
//       waiting `AUTOMATIC_REPLY_SETTLE_MS` (150ms) -- PROVEN live gaps for an AssemblyAI
//       automatic reply are 8-63ms, comfortably inside that 150ms window, so waiting handed it
//       the slot every time.
//
// Determinism law: packages/engine is untouched by this task (verified separately via
// `git diff --stat`). LAW 3: the engine, not this server layer, computes every verdict -- these
// tests only touch how the ALREADY-SEALED goodbye is confirmed and retried.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MERIDIAN, mockToolResult } from '@countersign/engine';
import type { CallContext, ServerEvent } from '@countersign/engine';
import { CallSession } from '../src/call/session.js';
import { FakeAaiSocket } from '../src/aai/fake.js';
import { ENGINE_CLOSE_SENTENCES } from '../src/call/closeMatch.js';
import scenarioB from '../../engine/corpus/scenario-b-miller-fraud.json' with { type: 'json' };

const CALL_B = scenarioB.call as CallContext;

// CallSession.AUTOMATIC_REPLY_SETTLE_MS -- the constant every OTHER test in this codebase opts
// back into via `forceSpeakSettleMs`. These tests deliberately do NOT pass that option: they
// exercise the real production default (`forceSpeakSettleMs` unset -> the class default 0,
// synchronous), because mechanism (C) is specifically about that default's own behavior.
const AUTOMATIC_REPLY_SETTLE_MS = 150;

function newProductionSession(
  sessionId: string,
  clock: { now: number },
  aai: FakeAaiSocket,
  sent: ServerEvent[],
  diagEvents: { kind: string; detail: unknown }[],
  callOverride?: CallContext
): CallSession {
  const call: CallContext = callOverride ?? { session_id: sessionId, origin_kind: 'registered_device', origin_geo: 'Austin, TX' };
  return new CallSession({
    session_id: call.session_id,
    seed: MERIDIAN,
    call,
    aai,
    now: () => clock.now,
    onServerEvent: (e) => sent.push(e),
    mock: mockToolResult,
    onDiagnostic: (kind, detail) => diagEvents.push({ kind, detail }),
    // forceSpeakSettleMs deliberately OMITTED -- the real production default (0, synchronous),
    // matching every bundle these tests replay (all recorded post-deploy-57's turn_detection
    // restore, which is what made the synchronous default correct -- see call/session.ts's own
    // FORCE-SPEAK-SETTLE-ZERO doc comment).
  });
}

function closeReplyCreates(diagEvents: { kind: string; detail: unknown }[]) {
  return diagEvents.filter((e) => e.kind === 'reply_create_sent' && (e.detail as { goal_code: string }).goal_code === 'CLOSE');
}

/** Drives Scenario B's own real corpus (Robert Miller, wire fraud -- the same text
 *  `driveToFreezeCloseWithFirstSend` in session.test.ts's own round-3 describe block uses) to
 *  FREEZE/SEALED/CLOSE, with the FIRST CLOSE reply.create already sent. Unlike that sibling
 *  helper (and unlike `driveToSealedStageProductionDefaults` below), this one does NOT advance
 *  past a settle window after the final caller turn -- with `forceSpeakSettleMs` at its
 *  production default (0), the CLOSE send is synchronous, in the same tick as c3's own
 *  `transcript.user`. */
function driveToFreezeProductionDefaults(session: CallSession, aai: FakeAaiSocket, clock: { now: number }): void {
  vi.useFakeTimers();
  clock.now = 1000;
  aai.emit({ type: 'transcript.user', item_id: 'c1', text: scenarioB.conversation[0]!.text });
  vi.advanceTimersByTime(AUTOMATIC_REPLY_SETTLE_MS);
  clock.now = 1500;
  aai.emit({ type: 'reply.started', reply_id: 'a1' });
  aai.emit({ type: 'transcript.agent', item_id: 'a1', text: scenarioB.conversation[1]!.text, reply_id: 'a1', interrupted: false });
  clock.now = 2000;
  aai.emit({ type: 'reply.done', reply_id: 'a1', status: 'completed' });

  clock.now = 2500;
  aai.emit({ type: 'transcript.user', item_id: 'c2', text: scenarioB.conversation[2]!.text });
  vi.advanceTimersByTime(AUTOMATIC_REPLY_SETTLE_MS);
  clock.now = 3000;
  aai.emit({ type: 'reply.started', reply_id: 'a2' });
  aai.emit({
    type: 'transcript.agent',
    item_id: 'a2',
    text: `${scenarioB.conversation[3]!.text} Which institution holds it?`,
    reply_id: 'a2',
    interrupted: false,
  });
  clock.now = 3500;
  aai.emit({ type: 'reply.done', reply_id: 'a2', status: 'completed' });

  clock.now = 4000;
  aai.emit({ type: 'transcript.user', item_id: 'c3', text: scenarioB.conversation[4]!.text });
  // c3's own tick reaches FREEZE/SEALED/CLOSE entirely from server-driven lookups. Production
  // default forceSpeakSettleMs=0: the CLOSE reply.create fires SYNCHRONOUSLY here, in the same
  // tick as c3's own transcript.user -- no settle window to advance past.
}

/** Drives Scenario A's own real corpus (Dana Whitfield, legitimate -- the same script
 *  `close-tail-wait.test.ts`'s own `driveToSealedStage` uses) to STAGE/SEALED/CLOSE instead of
 *  FREEZE, for the (B2) folded-reply replay below. Same "no trailing settle advance" shape as
 *  `driveToFreezeProductionDefaults` above, for the same reason. */
function driveToSealedStageProductionDefaults(session: CallSession, aai: FakeAaiSocket, clock: { now: number }): void {
  vi.useFakeTimers();
  clock.now = 1000;
  aai.emit({
    type: 'transcript.user',
    item_id: 'c1',
    text: "This is Dana Whitfield, corporate treasury. I need to wire it to Meridian Supply — $84,500, account ending 4471 — moving today instead of Friday, approved in yesterday's close meeting.",
  });
  vi.advanceTimersByTime(AUTOMATIC_REPLY_SETTLE_MS);
  clock.now = 1500;
  aai.emit({ type: 'reply.started', reply_id: 'a1' });
  aai.emit({
    type: 'transcript.agent',
    item_id: 'a1',
    text: 'You are requesting a wire transfer of $84,500 to Northgate Partners. Is that correct?',
    reply_id: 'a1',
    interrupted: false,
  });
  clock.now = 2000;
  aai.emit({ type: 'reply.done', reply_id: 'a1', status: 'completed' });

  clock.now = 2500;
  aai.emit({ type: 'transcript.user', item_id: 'c2', text: "No, that's wrong. It's Meridian Supply." });
  vi.advanceTimersByTime(AUTOMATIC_REPLY_SETTLE_MS);
  clock.now = 3000;
  aai.emit({ type: 'reply.started', reply_id: 'a2' });
  aai.emit({ type: 'transcript.agent', item_id: 'a2', text: session.last!.goal.hint, reply_id: 'a2', interrupted: false });
  clock.now = 3500;
  aai.emit({ type: 'reply.done', reply_id: 'a2', status: 'completed' });

  clock.now = 4000;
  aai.emit({ type: 'transcript.user', item_id: 'c3', text: "Yes, that's right." });
  vi.advanceTimersByTime(AUTOMATIC_REPLY_SETTLE_MS);
  clock.now = 4500;
  aai.emit({ type: 'reply.started', reply_id: 'a3' });
  aai.emit({ type: 'transcript.agent', item_id: 'a3', text: session.last!.goal.hint, reply_id: 'a3', interrupted: false });
  clock.now = 5000;
  aai.emit({ type: 'reply.done', reply_id: 'a3', status: 'completed' });

  clock.now = 5500;
  aai.emit({ type: 'transcript.user', item_id: 'c4', text: 'Yes, correct.' });
  vi.advanceTimersByTime(AUTOMATIC_REPLY_SETTLE_MS);
  clock.now = 6000;
  aai.emit({ type: 'reply.started', reply_id: 'a4' });
  aai.emit({ type: 'transcript.agent', item_id: 'a4', text: session.last!.goal.hint, reply_id: 'a4', interrupted: false });
  clock.now = 6500;
  aai.emit({ type: 'reply.done', reply_id: 'a4', status: 'completed' });

  clock.now = 7000;
  aai.emit({ type: 'transcript.user', item_id: 'c5', text: "Yes, that's right." });
  // Production default forceSpeakSettleMs=0: the CLOSE reply.create fires SYNCHRONOUSLY here,
  // in the same tick as c5's own transcript.user -- no settle window to advance past.
}

describe('GOODBYE-CUT-BY-CALLER-PRESSURE fixes (2026-09-19)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('mechanism B: audio-floor confirmation (never transcript text or reply.done.status alone)', () => {
    it("(B1) miller-patient deploy 58 replay (2026-09-19T14-17-22): attempt 3's FULL matching transcript, arriving in the SAME ms as an interrupted reply.done with only 37,920 bytes (0.79s) of audio, must NOT confirm the goodbye -- the existing close_retry chain recovers it once the caller's turn has actually ended", () => {
      vi.useFakeTimers();
      const clock = { now: 0 };
      const aai = new FakeAaiSocket();
      const sent: ServerEvent[] = [];
      const diagEvents: { kind: string; detail: unknown }[] = [];
      const session = newProductionSession('sess-b1-miller-attempt3', clock, aai, sent, diagEvents, CALL_B);
      session.start();
      driveToFreezeProductionDefaults(session, aai, clock);
      expect(session.last?.state).toBe('SEALED');
      expect(session.last?.goal.code).toBe('CLOSE');
      expect(closeReplyCreates(diagEvents)).toHaveLength(1); // attempt 1, tick_end, synchronous

      // T0 = 42020 in the bundle's own clock (CLOSE first rendered / attempt 1 reply.create
      // sent) -- every timestamp below is that bundle's own, verbatim, offset from T0.
      const T0 = 42020;

      // Attempt 1: cut after "This" -- 55,680 bytes (1.2s), interrupted. Never matches the
      // close sentence at all (no distinguishing clause, no "goodbye").
      clock.now = T0 + 12;
      aai.emit({ type: 'reply.started', reply_id: 'attempt-1' });
      clock.now = T0 + 1139;
      aai.emit({ type: 'reply.audio', data: Buffer.alloc(55_680).toString('base64') });
      aai.emit({ type: 'transcript.agent', item_id: 'x1', text: 'This', reply_id: 'attempt-1', interrupted: true });
      clock.now = T0 + 1191;
      aai.emit({ type: 'input.speech.started' });
      clock.now = T0 + 1192;
      aai.emit({ type: 'reply.done', reply_id: 'attempt-1', status: 'interrupted' });
      clock.now = T0 + 2178;
      aai.emit({ type: 'input.speech.stopped' });
      aai.emit({ type: 'transcript.user', item_id: 'c6', text: 'final figure moved this morning.' });
      expect(session.last?.goal.code).toBe('CLOSE'); // LAW 2: sealed verdict never moves
      expect(closeReplyCreates(diagEvents)).toHaveLength(1); // still inside the transcript-wait window

      vi.advanceTimersByTime(1500 + 400); // CLOSE_TRANSCRIPT_WAIT_MS + CLOSE_RETRY_MIN_GAP_MS
      expect(closeReplyCreates(diagEvents)).toHaveLength(2); // attempt 2 (close_retry)

      // Attempt 2: cut after "This transfer is frozen" -- 104,640 bytes (2.2s), interrupted.
      // Still no match (missing "and an incident is open" AND "goodbye").
      clock.now = T0 + 3099;
      aai.emit({ type: 'reply.started', reply_id: 'attempt-2' });
      clock.now = T0 + 5278;
      aai.emit({ type: 'reply.audio', data: Buffer.alloc(104_640).toString('base64') });
      aai.emit({ type: 'transcript.agent', item_id: 'x2', text: 'This transfer is frozen', reply_id: 'attempt-2', interrupted: true });
      clock.now = T0 + 5291;
      aai.emit({ type: 'input.speech.started' });
      aai.emit({ type: 'reply.done', reply_id: 'attempt-2', status: 'interrupted' });
      clock.now = T0 + 6878;
      aai.emit({ type: 'input.speech.stopped' });
      aai.emit({ type: 'transcript.user', item_id: 'c7', text: "I don't care about your process." });
      expect(closeReplyCreates(diagEvents)).toHaveLength(2);

      vi.advanceTimersByTime(1500 + 400);
      expect(closeReplyCreates(diagEvents)).toHaveLength(3); // attempt 3 (close_retry)

      // Attempt 3: THE PROVEN DEFECT. The FULL 86-char goodbye arrives in the transcript at
      // the SAME ms as an interrupted reply.done, with only 37,920 bytes (0.79s) of audio --
      // far below the ~172,000-byte floor (86 chars * 4,000 bytes/char * 50%) for this
      // sentence. The caller heard, at most, "This" of the real goodbye.
      clock.now = T0 + 7196;
      aai.emit({ type: 'reply.started', reply_id: 'attempt-3' });
      clock.now = T0 + 7981;
      aai.emit({ type: 'reply.audio', data: Buffer.alloc(37_920).toString('base64') });
      aai.emit({ type: 'transcript.agent', item_id: 'x3', text: ENGINE_CLOSE_SENTENCES.FREEZE, reply_id: 'attempt-3', interrupted: true });
      clock.now = T0 + 7986;
      aai.emit({ type: 'input.speech.started' });
      aai.emit({ type: 'reply.done', reply_id: 'attempt-3', status: 'interrupted' });

      // THE FIX: not confirmed -- no `ended` at all. The old code's `close_tail_wait` fired
      // here (audio_seconds: 0.79, waited_ms: 1500) and hung up on the caller 1.5s later,
      // having actually played them well under a second of the goodbye.
      const internals = session as unknown as { goodbyeConfirmed: boolean };
      expect(internals.goodbyeConfirmed).toBe(false);
      expect(sent.some((e) => e.type === 'ended')).toBe(false);

      // The caller finishes their sentence (bundle: input.speech.stopped + their own final
      // transcript, both at 50898 -- T0+8878).
      clock.now = T0 + 8878;
      aai.emit({ type: 'input.speech.stopped' });
      aai.emit({ type: 'transcript.user', item_id: 'c8', text: "Release the wire or you're fired." });

      // The existing close_retry chain (never touched by this fix) recovers it: the transcript
      // wait elapses with no further chunk for 'attempt-3', then the spacing gap -- by which
      // point the caller has already stopped talking (T0+8878 is well before the retry timer's
      // own fire point below), so the retry is never wrongly dropped or silently lost.
      vi.advanceTimersByTime(1500 + 400);
      expect(closeReplyCreates(diagEvents)).toHaveLength(4); // attempt 4 (close_retry) -- never lost
      expect(internals.goodbyeConfirmed).toBe(false); // still not confirmed -- nothing has said it yet
      expect(sent.some((e) => e.type === 'ended')).toBe(false);

      // Attempt 4 finally lands the FULL goodbye with REAL audio -- confirmed and ended
      // normally.
      clock.now = T0 + 15_000;
      aai.emit({ type: 'reply.started', reply_id: 'attempt-4' });
      aai.emit({ type: 'reply.audio', data: Buffer.alloc(192_000).toString('base64') });
      aai.emit({ type: 'transcript.agent', item_id: 'x4', text: ENGINE_CLOSE_SENTENCES.FREEZE, reply_id: 'attempt-4', interrupted: false });
      clock.now = T0 + 20_100;
      aai.emit({ type: 'reply.done', reply_id: 'attempt-4', status: 'completed' });
      expect(internals.goodbyeConfirmed).toBe(true);
      vi.advanceTimersByTime(1500);
      expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'agent_closed' });
      expect(closeReplyCreates(diagEvents)).toHaveLength(4); // still exactly four, for the whole call
    });

    it('(B2) corrected-critical-field deploy 58 replay (2026-09-19T14-20-58): a COMPLETED reply.done with only 81,120 bytes (a folded "One moment." + goodbye, where only the FIRST segment\'s audio was ever relayed) must NOT confirm the goodbye either -- it is scheduled a close_retry exactly like an interrupted reply would be', () => {
      vi.useFakeTimers();
      const clock = { now: 0 };
      const aai = new FakeAaiSocket();
      const sent: ServerEvent[] = [];
      const diagEvents: { kind: string; detail: unknown }[] = [];
      const session = newProductionSession('sess-b2-corrected-critical-field', clock, aai, sent, diagEvents);
      session.start();
      driveToSealedStageProductionDefaults(session, aai, clock);
      expect(session.last?.state).toBe('SEALED');
      expect(session.last?.goal.code).toBe('CLOSE');
      expect(closeReplyCreates(diagEvents)).toHaveLength(1);

      // T0 = 82885 in the bundle's own clock (CLOSE first rendered).
      const T0 = 82885;

      clock.now = T0 + 6;
      aai.emit({ type: 'reply.started', reply_id: 'folded-1' });
      clock.now = T0 + 1160;
      // The PROVEN shape: AssemblyAI folded an automatic "One moment." holding beat and the
      // real STAGE goodbye into ONE reply/transcript, but only streamed the "One moment."
      // segment's worth of audio (81,120 bytes, 1.69s) before reporting the whole thing done.
      aai.emit({ type: 'reply.audio', data: Buffer.alloc(81_120).toString('base64') });
      aai.emit({
        type: 'transcript.agent',
        item_id: 'x1',
        text: `One moment.${ENGINE_CLOSE_SENTENCES.STAGE}`,
        reply_id: 'folded-1',
        interrupted: false,
      });
      clock.now = T0 + 1689;
      aai.emit({ type: 'reply.done', reply_id: 'folded-1', status: 'completed' });

      // THE FIX: `completed` is not enough either -- 81,120 bytes is well under the
      // ~172,000-byte floor (86 chars * 4,000 bytes/char * 50%) for this sentence. The old
      // code's `close_tail_wait` fired here (audio_seconds: 1.69, waited_ms: 1500) and the
      // caller never heard the goodbye at all.
      const internals = session as unknown as { goodbyeConfirmed: boolean };
      expect(internals.goodbyeConfirmed).toBe(false);
      expect(sent.some((e) => e.type === 'ended')).toBe(false);

      // The existing close_retry chain recovers it, unchanged: CLOSE_TRANSCRIPT_WAIT_MS then
      // CLOSE_RETRY_MIN_GAP_MS, exactly as an interrupted/mismatched reply would be.
      vi.advanceTimersByTime(1500 + 400);
      expect(closeReplyCreates(diagEvents)).toHaveLength(2);
      expect(internals.goodbyeConfirmed).toBe(false);

      // The retried reply completes the goodbye properly this time (real, full audio) -- the
      // call ends normally.
      clock.now = T0 + 10_000;
      aai.emit({ type: 'reply.started', reply_id: 'folded-2' });
      aai.emit({ type: 'reply.audio', data: Buffer.alloc(192_000).toString('base64') });
      aai.emit({ type: 'transcript.agent', item_id: 'x2', text: ENGINE_CLOSE_SENTENCES.STAGE, reply_id: 'folded-2', interrupted: false });
      clock.now = T0 + 15_100;
      aai.emit({ type: 'reply.done', reply_id: 'folded-2', status: 'completed' });
      expect(internals.goodbyeConfirmed).toBe(true);
      vi.advanceTimersByTime(1500);
      expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'agent_closed' });
    });
  });

  describe('mechanism C: a CLOSE send dropped for callerSpeaking stays owed, and is delivered synchronously the instant the caller\'s turn ends', () => {
    it('(C) identity-switch deploy 58 replay (2026-09-19T14-19-30): our own CLOSE reply is cut by a barge-in, the retry is correctly dropped while the caller keeps talking, and -- unlike the live bug, where nothing recorded it as owed and an AssemblyAI automatic reply took the slot 25.6s later -- the retry now fires synchronously the instant the caller\'s turn actually ends, never losing the slot to an automatic reply', () => {
      vi.useFakeTimers();
      const clock = { now: 0 };
      const aai = new FakeAaiSocket();
      const sent: ServerEvent[] = [];
      const diagEvents: { kind: string; detail: unknown }[] = [];
      const session = newProductionSession('sess-c-identity-switch', clock, aai, sent, diagEvents, CALL_B);
      session.start();
      driveToFreezeProductionDefaults(session, aai, clock);
      expect(session.last?.state).toBe('SEALED');
      expect(session.last?.goal.code).toBe('CLOSE');
      expect(closeReplyCreates(diagEvents)).toHaveLength(1);

      // T0 = 97001 in the bundle's own clock (CLOSE first rendered).
      const T0 = 97001;

      // Our own CLOSE reply starts (ours:true, 8ms gap) and is cut after "This" -- 62,400
      // bytes -- by the caller barging in.
      clock.now = T0 + 8;
      aai.emit({ type: 'reply.started', reply_id: 'attempt-1' });
      clock.now = T0 + 1287;
      aai.emit({ type: 'reply.audio', data: Buffer.alloc(62_400).toString('base64') });
      aai.emit({ type: 'transcript.agent', item_id: 'x1', text: 'This', reply_id: 'attempt-1', interrupted: true });
      clock.now = T0 + 1297;
      aai.emit({ type: 'input.speech.started' });
      aai.emit({ type: 'reply.done', reply_id: 'attempt-1', status: 'interrupted' });

      // Simplification, stated plainly: the real bundle has the caller stop very briefly
      // (101698, transcript "Release the $84,500...") and immediately resume (103495) before
      // finally stopping for good at 107299 -- three VAD events with no bearing on the FSM
      // (LAW 2: the verdict is already sealed, so nothing the caller says between here and
      // their own final turn-end below can change it). This test collapses that into one
      // continuous "still speaking" span up to the bundle's own FINAL stop, which is the only
      // instant that actually matters for this mechanism -- `callerSpeaking` is a boolean, not
      // a VAD transcript, and this collapse changes nothing about what it is being asked to
      // prove.
      //
      // The close_retry chain (armCloseTranscriptWait -> armCloseRetryTimer) tries to re-send
      // while the caller is still (per the collapse above) mid-utterance -- correctly dropped
      // by the pre-existing `callerSpeaking` guard (fb6bef8/34cc309), same as before this fix.
      vi.advanceTimersByTime(1500 + 400); // CLOSE_TRANSCRIPT_WAIT_MS + CLOSE_RETRY_MIN_GAP_MS
      expect(closeReplyCreates(diagEvents)).toHaveLength(1); // still just attempt 1 -- the retry was dropped, not sent

      // THE FIX: the drop above recorded the goal as owed (`owedForceSpeakGoalKey`) -- the OLD
      // code left this silently unset, so nothing here would have delivered the goodbye except
      // luck (an ambient AssemblyAI automatic reply that happened to get labelled CLOSE and
      // happened to speak a real goodbye, 25.6s after CLOSE first rendered in the live bundle).
      const internals = session as unknown as { owedForceSpeakGoalKey: string | null };
      expect(internals.owedForceSpeakGoalKey).not.toBeNull();

      // The caller's turn actually ends (bundle: input.speech.stopped + their own final
      // transcript, both at 107299 -- T0+10298).
      clock.now = T0 + 10_298;
      aai.emit({ type: 'input.speech.stopped' });
      aai.emit({ type: 'transcript.user', item_id: 'c9', text: "Yes, that's right. This is Robert Miller. Release it." });

      // Not yet -- forceSpeakSettleMs (0, production default) still needs its own (fake) timer
      // tick to fire, same as the very first CLOSE send would.
      expect(closeReplyCreates(diagEvents)).toHaveLength(1);

      // THE FIX, proven: a bare 0ms advance (never AUTOMATIC_REPLY_SETTLE_MS, 150ms -- the
      // window that lost the slot to AssemblyAI's automatic reply on every PROVEN live gap,
      // 8-63ms) is enough to deliver it. No automatic/ambient reply.started was ever emitted
      // in this test at all: with this fix, a real caller's own turn-end always wins that race
      // before AssemblyAI's own automatic reply gets a chance to start.
      vi.advanceTimersByTime(0);
      const closeSends = closeReplyCreates(diagEvents);
      expect(closeSends).toHaveLength(2);
      expect((closeSends[1]!.detail as { reason: string }).reason).toBe('tick_end');

      // That reply actually lands the goodbye -- the call ends normally, fast, never anywhere
      // near the live bug's own 25.6s `goodbye_delay`.
      clock.now = T0 + 10_400;
      aai.emit({ type: 'reply.started', reply_id: 'attempt-2' });
      aai.emit({ type: 'reply.audio', data: Buffer.alloc(192_000).toString('base64') });
      aai.emit({ type: 'transcript.agent', item_id: 'x2', text: ENGINE_CLOSE_SENTENCES.FREEZE, reply_id: 'attempt-2', interrupted: false });
      clock.now = T0 + 15_500;
      aai.emit({ type: 'reply.done', reply_id: 'attempt-2', status: 'completed' });
      vi.advanceTimersByTime(1500);
      expect(sent.at(-1)).toEqual({ type: 'ended', reason: 'agent_closed' });
      expect(closeReplyCreates(diagEvents)).toHaveLength(2); // exactly two CLOSE sends for the whole call
    });
  });
});
