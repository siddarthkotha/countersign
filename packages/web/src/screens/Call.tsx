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
  const clientRef = useRef<CallClient | null>(null);

  useEffect(
    () => () => {
      clientRef.current?.close();
    },
    [],
  );

  async function handleStart() {
    setMicError(false);
    try {
      const audioContext = new AudioContext();
      const client = await connect(session.ws_path, audioContext);
      client.onState((state) => setScreenState(state));
      client.onEnded((reason) => {
        setEndedReason(reason);
        setLink('ended');
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
        <CallView screen={screenState} />
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
