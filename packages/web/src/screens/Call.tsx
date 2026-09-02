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

function endedReasonToPlainWords(reason: string): string {
  if (reason.startsWith('aai_error')) {
    return 'The call ended: the voice service closed the session';
  }
  const words = ENDED_REASON_WORDS[reason];
  return `The call ended: ${words ?? reason.replace(/_/g, ' ')}`;
}

export default function Call({ session, onStartOver, onWatch }: CallProps) {
  const [link, setLink] = useState<LinkState>('idle');
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
      {!screenState && <SimulatedBanner />}

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

      {endedReason && <p role="status">{endedReasonToPlainWords(endedReason)}</p>}

      {screenState ? (
        <CallView screen={screenState} />
      ) : (
        <p>Click Start Call to begin.</p>
      )}

      <p className="bottom-line">No funds can move by voice alone. Second approval required.</p>
    </div>
  );
}
