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
import type { StartResult, DemoPersona } from '../api';
import {
  buildDiagnosticsPayload,
  markStartClick,
  recordEvent,
  recordStateEvent,
  recordTranscriptLine,
} from '../diagnostics/flightRecorder';
import { addRecentCall } from '../lib/recentCalls';

export type StartedSession = Extract<StartResult, { session_id: string }>;

export type CallProps = {
  session: StartedSession;
  persona: DemoPersona | null;
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

function endedReasonToPlainWords(reason: string, verdict?: string): string {
  // When the socket drops mid-call before a terminal verdict is reached, inform the
  // caller that nothing was staged or frozen and they can try again. Treat undefined
  // verdict (no screen state arrived yet) the same as PENDING (call not completed).
  if (reason === 'link_lost' && (verdict === 'PENDING' || verdict === undefined)) {
    return 'Connection lost. This call was not completed, and nothing was staged or frozen. Start over to try again.';
  }
  const fullSentence = FULL_ENDED_SENTENCES[reason];
  if (fullSentence) return fullSentence;
  if (reason.startsWith('aai_error')) {
    return 'The call ended: the voice service closed the session';
  }
  const words = ENDED_REASON_WORDS[reason];
  return `The call ended: ${words ?? reason.replace(/_/g, ' ')}`;
}

function personaToPlainWords(persona: DemoPersona): string {
  return persona === 'legitimate' ? 'Dana Whitfield, honest caller' : 'caller claiming to be the CEO';
}

export default function Call({ session, persona, onStartOver, onWatch }: CallProps) {
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
  // Task W9 (flight recorder): guards the diagnostics POST/beacon the same way `loggedRef`
  // guards the console line -- whichever path ends the call first (End Call, a server
  // `ended` event, unmount, or the tab actually closing) sends exactly one payload, never
  // one per path.
  const diagSentRef = useRef(false);
  const lastUnderrunRef = useRef(0);

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
    // (BRIEF/CLAUDE.md: "measured in this browser", copy-pasteable from the console; the
    // full, untruncated session_id is included -- W8 review -- so it can be pasted straight
    // into a bug report or a GET .../diagnostics lookup).
    console.info('[countersign:timings]', {
      session_id: session.session_id,
      start_to_ready_ms: timingsRef.current.startReadyMs,
      ready_to_first_audio_ms: timingsRef.current.readyFirstAudioMs,
      turn_gaps_ms: timingsRef.current.turnGapsMs,
    });
  }

  // Task W9: shared by every "the call is over" path below (End Call, a server `ended`
  // event, and -- W8 review, Important -- unmount). Pushes one final `timings` event (the
  // W8 numbers) onto the flight recorder buffer, then POSTs the whole buffer with
  // `keepalive:true` so the request has a chance to finish even if the tab is mid-navigation.
  // `diagSentRef` makes this (and `flushDiagnosticsBeacon` below) a true single-shot: whichever
  // of the several call-end paths runs first wins, every later one is a no-op.
  function flushDiagnosticsFetch() {
    if (diagSentRef.current) return;
    diagSentRef.current = true;
    recordEvent('timings', { ...timingsRef.current });
    const body = buildDiagnosticsPayload();
    // A full try/catch, not just a trailing `.catch()`: this can run from the unmount
    // cleanup effect below, at a point where a test environment (or an unusual browser) may
    // not have a `fetch` global at all -- `fetch(...)` itself can throw SYNCHRONOUSLY (before
    // ever returning a promise), which a bare `.catch()` would never see.
    try {
      void fetch(`/api/session/${session.session_id}/diagnostics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => {
        // Best-effort -- diagnostics are for founder debugging; they must never block or
        // alter the call UI, and there is no user-facing recovery for a failed POST.
      });
    } catch {
      // See the comment above -- same "never break the call over a debugging aid" reasoning.
    }
  }

  // Task W9: the pagehide/beforeunload path -- a `fetch`, even with `keepalive:true`, is not
  // guaranteed to be given the time it needs once the page is actually being torn down;
  // `navigator.sendBeacon` is the browser-native mechanism built for exactly this. Same
  // `diagSentRef` guard as `flushDiagnosticsFetch`, so a beacon fired after an ordinary End
  // Call already flushed is a no-op, not a duplicate POST.
  function flushDiagnosticsBeacon() {
    if (diagSentRef.current) return;
    diagSentRef.current = true;
    recordEvent('timings', { ...timingsRef.current });
    const body = buildDiagnosticsPayload();
    try {
      // A plain string body (sendBeacon accepts one directly) rather than wrapping it in a
      // `Blob` -- one less moving part, and jsdom's own `Blob` implementation (unlike a real
      // browser's) doesn't implement `.text()`/`.arrayBuffer()`, which would make this
      // impossible to assert against in a test without a real network request.
      navigator.sendBeacon(`/api/session/${session.session_id}/diagnostics`, body);
    } catch {
      // Best-effort -- an environment without sendBeacon (or one that throws on a bad URL)
      // must never break the page teardown it's attached to.
    }
  }

  // Task W9 / W8 review (Important): a call that ends by the caller navigating away,
  // refreshing, or closing the tab -- rather than clicking End Call, or the server sending
  // its own `ended` -- used to lose its timings silently (no console line, no diagnostics).
  // `pagehide` is the recommended, bfcache-safe event; `beforeunload` is registered too since
  // some environments only reliably fire one of the two. Both funnel into the same
  // once-only guards above, so a page that fires both still reports exactly once.
  useEffect(() => {
    function handlePageHide() {
      logTimingsOnce();
      flushDiagnosticsBeacon();
    }
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('beforeunload', handlePageHide);
    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('beforeunload', handlePageHide);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberate: mount-once, same as
    // the unmount-close effect below; `session.session_id` is stable for the life of this
    // component (a new session always means a fresh Call mount, per App.tsx).
  }, []);

  useEffect(
    () => () => {
      // W8 review (Important): unmount is itself a call-ending path (Start Over, a parent
      // screen switch, or any route other than the "End Call" button/a server `ended` event)
      // -- it must report the same way those do, not silently drop the numbers.
      // W9 review, fix round 1 (Moderate): `socket_close` must be recorded BEFORE
      // `flushDiagnosticsFetch()` snapshots the buffer -- `flushDiagnosticsFetch` serializes
      // whatever is in the ring buffer at the exact moment it runs, so recording this call's
      // own `socket_close` AFTER that snapshot (the previous order) meant the payload sent on
      // a bare unmount never contained its own close event. Matches `handleEnd()`'s order
      // (recordEvent('socket_close') before flushDiagnosticsFetch(), below).
      logTimingsOnce();
      recordEvent('socket_close');
      flushDiagnosticsFetch();
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
    diagSentRef.current = false;
    lastUnderrunRef.current = 0;
    timingsRef.current = EMPTY_TIMINGS;
    setTimings(EMPTY_TIMINGS);
    // Task W9: `markStartClick` sets the flight recorder's zero point -- every event's
    // reported `t_ms` (including this very click) is relative to THIS instant from here on.
    markStartClick();
    recordEvent('start_click');
    try {
      const audioContext = new AudioContext();
      const client = await connect(session.ws_path, audioContext);
      recordEvent('socket_open');
      client.onState((state) => {
        const now = performance.now();
        // Task W9: the status word off every state event this browser sees, throttled
        // batches included -- the ask is explicit that a throttled-away intermediate status
        // is fine to miss (only the ones that actually reach the browser are recorded).
        // W9 review, fix round 1 (Minor): the flight recorder module exports
        // `recordStateEvent` for exactly this line -- calling it directly (rather than
        // duplicating its `recordEvent('state', {status})` body here) keeps one source of
        // truth for the event's shape.
        recordStateEvent(state.agent_status);
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
          // Task W9: role, length, and text recorded. This is diagnostics (not evidence per
          // LAW 4) -- the text is recorded so live calls can be analyzed post-hoc. Evidence
          // exports stay the only artefact that proves what was said; this is a debugging-aid
          // copy with the same text, verbatim. W9 review, fix round 1 (Minor): same reasoning
          // as `recordStateEvent` above -- `recordTranscriptLine` is the one source of truth.
          for (const line of newLines) {
            recordTranscriptLine(line.speaker, line.text.length, line.text);
          }
          if (newLines.some((line) => line.speaker === 'caller')) {
            // Minor (W8 review): a turn that never got its own agent audio back (a silent,
            // tool-only turn) used to have `pendingTurnStartRef` overwritten right here with
            // no record anywhere that it happened -- not a wrong number, just a silently
            // shorter `turnGapsMs` than the number of caller turns. Recording it here makes
            // that drop visible instead of invisible.
            if (pendingTurnStartRef.current !== null) {
              recordEvent('turn_no_audio', { pending_ms: Math.round(now - pendingTurnStartRef.current) });
            }
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
        // Task W9: playback.ts now counts underruns (a chunk that arrived after the queue
        // already ran dry) -- only a NEW count is worth an event, not one per audio chunk.
        const underruns = client.playback.underrunCount?.() ?? 0;
        if (underruns > lastUnderrunRef.current) {
          recordEvent('audio_underrun', { count: underruns });
          lastUnderrunRef.current = underruns;
        }
      });
      // Task W9: a SECOND `onFlush` listener, same multicast reasoning as `onAudio` above --
      // `connect()`'s own listener still does the actual barge-in (`playback.flush()`); this
      // one only records that it happened.
      client.onFlush(() => {
        recordEvent('flush');
      });
      client.onLink((leg, state, dropped_frames) => {
        recordEvent('link', { leg, state, dropped_frames: dropped_frames ?? null });
        // The AssemblyAI session and the evidence stay put on the server through a dropped
        // link (Task R1) -- only the chip/status line move; nothing about screenState resets.
        setLinkLeg(state === 'lost' ? leg : null);
        setLink(state === 'lost' ? 'reconnecting' : 'live');
      });
      client.onEnded((reason) => {
        recordEvent('ended', { reason });
        setEndedReason(reason);
        setLink('ended');
        logTimingsOnce();
        addRecentCall(session.session_id, screenState?.verdict ?? null);
        flushDiagnosticsFetch();
      });

      // Mic level monitoring: record RMS and peak levels every 250ms (but cap at 4 events/sec).
      // Also record track settings on the first call.
      let lastLevelEventTime = 0;
      let levelEventCount = 0;
      const levelMonitorStartTime = performance.now();
      const TEN_MINUTES_MS = 10 * 60 * 1000;

      client.onLevel((tMs, rms, peak, trackSettings) => {
        const now = performance.now();

        // Record track settings on first level event (trackSettings is only provided once)
        if (trackSettings) {
          recordEvent('mic_track_settings', trackSettings);
        }

        // Cap at 4 events per second (250ms minimum between events)
        // and stop recording after 10 minutes
        if (now - lastLevelEventTime >= 250 && now - levelMonitorStartTime < TEN_MINUTES_MS) {
          recordEvent('mic_level', { rms, peak });
          lastLevelEventTime = now;
          levelEventCount++;
        }
      });

      clientRef.current = client;
      client.send({ type: 'start' });
      setLink('live');
    } catch {
      // Task W9: a failed connect (mic denied, no device, worker/socket setup threw) is
      // exactly the kind of rough call this feature exists to help debug -- record it before
      // falling through to the existing mic-failure banner.
      recordEvent('connect_failed');
      setMicError(true);
    }
  }

  function handleEnd() {
    recordEvent('end_click');
    clientRef.current?.send({ type: 'end' });
    recordEvent('socket_close');
    clientRef.current?.close();
    clientRef.current = null;
    setLink('ended');
    logTimingsOnce();
    flushDiagnosticsFetch();
    void fetch(`/api/session/${session.session_id}/end`, { method: 'POST' }).catch(() => {
      // Best-effort -- the frozen last state stays on screen either way.
    });
  }

  function handleStartOver() {
    recordEvent('socket_close');
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

      {/* Bug fix 2026-09-21: show which role card was selected in the request header strip.
          This always renders (even before a state event) so the user knows immediately which
          persona context the checkpoint is using. */}
      {persona && (
        <p>Role card: {personaToPlainWords(persona)}</p>
      )}

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

      {endedReason && (
        <>
          <p role="status">{endedReasonToPlainWords(endedReason, screenState?.verdict)}</p>
          <p>Session code: {session.session_id.slice(0, 8)}</p>
        </>
      )}

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
