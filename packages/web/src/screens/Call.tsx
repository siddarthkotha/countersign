// packages/web/src/screens/Call.tsx
// Structure only -- no look (W5 picks the visual language, per the design law in the W2
// brief). The live-call screen: App.tsx hands this the StartResult from `/api/session/start`
// (already fetched by Landing) but the socket and the microphone are NOT opened here on
// mount -- only `connect()` (src/ws/client.ts) does that, and it is called for the first time
// inside `handleStart`, which only ever runs from the Start Call button's onClick (BRIEF
// engineering law: explicit Start-Call click; the socket opens only then). This component
// computes NOTHING about verdicts -- every word that isn't a fixed constant (the bottom line,
// the plain-words ended reasons) is a field read straight off the ScreenState the server
// sends down; CallView.tsx (landed W2) is what actually renders that state.
import { useEffect, useRef, useState } from 'react';
import type { ScreenState } from '@countersign/engine';
import CallView from '../components/CallView';
import CallControls, { type LinkState } from '../components/CallControls';
import SimulatedBanner from '../components/SimulatedBanner';
import Masthead from '../components/Masthead';
import Footer from '../components/Footer';
import { connect, type CallClient } from '../ws/client';
import type { StartResult } from '../api';

export type StartedSession = Extract<StartResult, { session_id: string }>;

export type CallProps = {
  session: StartedSession;
  onStartOver: () => void;
  onWatch: () => void;
};

// Task W8 (G5 rehearsal latency): three browser-measured timings, all via `performance.now()`
// -- start (the Start Call click) -> ready (the first `state` ServerEvent the server sends
// back, the earliest "the call/link is up" signal that exists on the wire today -- there is
// no separate `ready` message), ready -> first agent audio chunk, and per agent turn the gap
// from the transcript growing a new caller line (end of that turn's user speech, as this
// browser first saw it) to the next agent audio chunk. These are UI-only rehearsal telemetry
// -- nothing here is added to `ScreenState`/the wire protocol, and nothing here is a verdict
// or evidence; CallView.tsx renders them as plain browser-measured numbers, not proof of
// anything server-side.
export type CallTimings = {
  startReadyMs: number | null;
  readyFirstAudioMs: number | null;
  turnGapsMs: number[];
};

const EMPTY_TIMINGS: CallTimings = { startReadyMs: null, readyFirstAudioMs: null, turnGapsMs: [] };

// Reasons the server is known to send today (packages/server/src/call/session.ts) plus the
// Amendment 2 reasons (idle disconnect, session cap) that surface once the server side of
// that behaviour lands. Unknown reasons still get a plain-words fallback -- never a raw code
// on screen.
const ENDED_REASON_WORDS: Record<string, string> = {
  idle_timeout: 'no speech for 30 seconds',
  cap_reached: 'the session cap was reached',
  error: 'the voice service closed the session',
  aai_ended: 'the voice service closed the session',
  caller_ended: 'the call was ended',
  replay_complete: 'the recording finished',
};

// MINOR (final review): `browser_gone`/`link_lost` are the two reasons that only ever fire
// AFTER this client's own reconnect attempts (src/ws/worker.ts) already exhausted first
// (Task R1's grace window on `browser_gone`; the AAI-leg's bounded resume on `link_lost`) --
// full, standalone sentences (not `ENDED_REASON_WORDS` fragments) say WHICH side gave up,
// since "the connection could not be restored" used to read identically for either.
const FULL_ENDED_SENTENCES: Record<string, string> = {
  browser_gone: 'Your browser stayed disconnected too long; the call was closed.',
  link_lost: 'The voice service could not be reached again; the call was closed.',
};

function endedReasonToPlainWords(reason: string): string {
  const fullSentence = FULL_ENDED_SENTENCES[reason];
  if (fullSentence) return fullSentence;
  if (reason.startsWith('aai_error')) {
    return 'The call ended: the voice service closed the session';
  }
  const words = ENDED_REASON_WORDS[reason];
  return `The call ended: ${words ?? reason.replace(/_/g, ' ')}`;
}

export default function Call({ session, onStartOver, onWatch }: CallProps) {
  const [link, setLink] = useState<LinkState>('idle');
  // IMPORTANT 2 (final review): which transport dropped -- 'browser' or 'aai' -- so the
  // status line can say WHICH side is reconnecting instead of one message covering both.
  // Meaningless once `link !== 'reconnecting'`; only read while rendering that line.
  const [linkLeg, setLinkLeg] = useState<'browser' | 'aai' | null>(null);
  const [screenState, setScreenState] = useState<ScreenState | null>(null);
  const [endedReason, setEndedReason] = useState<string | null>(null);
  const [micError, setMicError] = useState(false);
  const [timings, setTimings] = useState<CallTimings>(EMPTY_TIMINGS);
  const clientRef = useRef<CallClient | null>(null);

  // Task W8: the raw clock -- kept in a ref (not state) so the async ServerEvent callbacks
  // below always read the CURRENT call's numbers, never a stale render's closure, and so a
  // value already computed (e.g. `readyAt`) is never overwritten by a later, later-arriving
  // event of the same kind. `transcriptLenRef`/`pendingTurnStartRt` track, respectively, how
  // many transcript lines this call has already seen (to spot a newly-appended one) and the
  // `performance.now()` at which the most recent NEW caller line appeared, cleared the moment
  // that turn's first agent audio chunk closes the gap.
  const clockRef = useRef<{ startAt: number | null; readyAt: number | null; firstAudioAt: number | null }>({
    startAt: null,
    readyAt: null,
    firstAudioAt: null,
  });
  const transcriptLenRef = useRef(0);
  const pendingTurnStartRef = useRef<number | null>(null);
  const loggedRef = useRef(false);

  // Task W8: one JSON line per call, on end (whichever path ends it first -- the caller's own
  // "End Call" click in `handleEnd`, or the server ending the call, e.g. idle timeout --
  // `loggedRef` keeps this to exactly one line per call). Read straight off `timingsRef` -- a
  // handler running inside `handleEnd` cannot rely on the `timings` state closure, since a
  // `setTimings` call from the same tick as `handleEnd` may not have re-rendered yet.
  const timingsRef = useRef<CallTimings>(EMPTY_TIMINGS);

  function logTimingsOnce() {
    if (loggedRef.current) return;
    loggedRef.current = true;
    // eslint-disable-next-line no-console -- deliberate: this IS the founder-facing output
    // (BRIEF/CLAUDE.md: "measured in this browser", copy-pasteable from the console).
    console.info('[countersign:timings]', {
      session_id: session.session_id,
      start_to_ready_ms: timingsRef.current.startReadyMs,
      ready_to_first_audio_ms: timingsRef.current.readyFirstAudioMs,
      turn_gaps_ms: timingsRef.current.turnGapsMs,
    });
  }

  useEffect(
    () => () => {
      clientRef.current?.close();
    },
    [],
  );

  async function handleStart() {
    setMicError(false);
    // Task W8: captured before `await connect(...)` -- `connect()` itself does the mic-
    // permission prompt and Web Audio setup, which is real elapsed time the founder's
    // rehearsal latency should include, same as the Start Call click a stranger actually felt.
    const startAt = performance.now();
    clockRef.current = { startAt, readyAt: null, firstAudioAt: null };
    transcriptLenRef.current = 0;
    pendingTurnStartRef.current = null;
    loggedRef.current = false;
    timingsRef.current = EMPTY_TIMINGS;
    setTimings(EMPTY_TIMINGS);
    try {
      const audioContext = new AudioContext();
      const client = await connect(session.ws_path, audioContext);
      client.onState((state) => {
        const now = performance.now();
        // The first `state` ServerEvent back from the server is the earliest signal on the
        // wire today that the call/link is up -- there is no separate `ready` message.
        if (clockRef.current.readyAt === null) {
          clockRef.current.readyAt = now;
          const startReadyMs = clockRef.current.startAt === null ? null : now - clockRef.current.startAt;
          timingsRef.current = { ...timingsRef.current, startReadyMs };
          setTimings(timingsRef.current);
        }
        // A newly-appended caller transcript line is the end of that turn's user speech, as
        // this browser first saw it -- `pendingTurnStartRef` closes against the next agent
        // audio chunk, below.
        const prevLen = transcriptLenRef.current;
        if (state.transcript.length > prevLen) {
          const newLines = state.transcript.slice(prevLen);
          transcriptLenRef.current = state.transcript.length;
          if (newLines.some((line) => line.speaker === 'caller')) {
            pendingTurnStartRef.current = now;
          }
        }
        setScreenState(state);
      });
      // Task W8: a SECOND `onAudio` listener alongside `connect()`'s own (client.ts now
      // multicasts, so this never touches the playback wiring) -- purely for timing, never
      // touches the audio itself.
      client.onAudio(() => {
        const now = performance.now();
        if (clockRef.current.firstAudioAt === null) {
          clockRef.current.firstAudioAt = now;
          const readyFirstAudioMs = clockRef.current.readyAt === null ? null : now - clockRef.current.readyAt;
          timingsRef.current = { ...timingsRef.current, readyFirstAudioMs };
          setTimings(timingsRef.current);
        }
        if (pendingTurnStartRef.current !== null) {
          const gap = now - pendingTurnStartRef.current;
          pendingTurnStartRef.current = null;
          timingsRef.current = { ...timingsRef.current, turnGapsMs: [...timingsRef.current.turnGapsMs, gap] };
          setTimings(timingsRef.current);
        }
      });
      client.onEnded((reason) => {
        setEndedReason(reason);
        setLink('ended');
        logTimingsOnce();
      });
      client.onLink((leg, state) => {
        // The AssemblyAI session and the evidence stay put on the server through a dropped
        // link (Task R1) -- only the chip/status line move; nothing about screenState resets.
        setLinkLeg(state === 'lost' ? leg : null);
        setLink(state === 'lost' ? 'reconnecting' : 'live');
      });
      clientRef.current = client;
      client.send({ type: 'start' });
      setLink('live');
    } catch {
      setMicError(true);
    }
  }

  function handleEnd() {
    clientRef.current?.send({ type: 'end' });
    clientRef.current?.close();
    clientRef.current = null;
    setLink('ended');
    logTimingsOnce();
    void fetch(`/api/session/${session.session_id}/end`, { method: 'POST' }).catch(() => {
      // Best-effort -- the frozen last state stays on screen either way.
    });
  }

  function handleStartOver() {
    clientRef.current?.close();
    clientRef.current = null;
    onStartOver();
  }

  return (
    <div className="call-screen">
      {/* Task W5, fix round 2, requirement 1: session id is `session.session_id` (held from
          `StartResult`, before any call even starts -- never waits on a ScreenState). Status
          is the same `agent_status` word CallView already renders once a state event has
          arrived; omitted, not padded, until then. */}
      <Masthead sessionId={session.session_id} status={screenState?.agent_status ?? null} />

      {/* Task W5, fix round 3, item 2: unconditional now -- CallView no longer renders its
          own copy once a state arrives, so this is the single, always-on source for the
          whole screen (previously the source moved from here to CallView.tsx at the exact
          moment a call started; same "always on" guarantee, one component now, not two). */}
      <SimulatedBanner />

      <CallControls
        link={link}
        capSeconds={session.cap_seconds}
        onStart={handleStart}
        onEnd={handleEnd}
        onStartOver={handleStartOver}
      />

      {micError && (
        <div>
          <p className="banner" role="alert">
            The microphone could not be reached. Use &apos;Watch a recorded attack&apos; instead.
          </p>
          <button type="button" onClick={onWatch}>
            Watch a recorded attack
          </button>
        </div>
      )}

      {/* IMPORTANT 2 (final review): which side is reconnecting used to be indistinguishable
         -- 'browser' (this client's own connection to our server) reads differently from
         'aai' (our server's connection to the voice service, merely relayed) on purpose. */}
      {link === 'reconnecting' && linkLeg === 'aai' && (
        <p role="status">Voice service reconnecting. Security state preserved.</p>
      )}
      {link === 'reconnecting' && linkLeg !== 'aai' && (
        <p role="status">Voice link lost, security state preserved. Reconnecting…</p>
      )}

      {endedReason && <p role="status">{endedReasonToPlainWords(endedReason)}</p>}

      {screenState ? (
        <CallView screen={screenState} timings={timings} />
      ) : (
        <p>Click Start Call to begin.</p>
      )}

      {/* Task W5, fix round 2, requirement 3: same wording as before this round, now shared
          with Replay.tsx via one component; the export hash (right side, amber monospace)
          is new -- shown once `forensic.export_hash` exists, omitted before that. */}
      <Footer exportHash={screenState?.forensic.export_hash ?? null} />
    </div>
  );
}
