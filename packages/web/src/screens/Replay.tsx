// packages/web/src/screens/Replay.tsx
// The no-mic path: connects to `/ws/replay/<file>?speed=<n>` (packages/server/src/ws/browser.ts,
// `/ws/replay/:file`) and renders the exact same CallView component the live call screen
// will use (W3). No getUserMedia call anywhere in this file -- this is the "no-mic REPLAY
// mode that drives the full UI" requirement (CLAUDE.md engineering laws): a judge with no
// microphone, or one who does not want to grant mic permission, still sees the whole thing.
import { useEffect, useRef, useState } from 'react';
import type { ScreenState } from '@countersign/engine';
import CallView from '../components/CallView';
import Masthead from '../components/Masthead';
import Footer from '../components/Footer';
import SimulatedBanner from '../components/SimulatedBanner';
import { connectSocketOnly, type CallClient } from '../ws/client';

const SPEEDS = [1, 4, 20] as const;
type Speed = (typeof SPEEDS)[number];

interface ReplayListResponse {
  files: string[];
}

export default function Replay() {
  const [files, setFiles] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [speed, setSpeed] = useState<Speed>(1);
  const [screenState, setScreenState] = useState<ScreenState | null>(null);
  const [ended, setEnded] = useState<string | null>(null);
  const clientRef = useRef<CallClient | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/replay')
      .then((res) => res.json() as Promise<ReplayListResponse>)
      .then((body) => {
        if (!cancelled) setFiles(body.files);
      })
      .catch(() => {
        if (!cancelled) setFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () => () => {
      clientRef.current?.close();
    },
    [],
  );

  function startReplay(file: string, atSpeed: Speed) {
    clientRef.current?.close();
    setScreenState(null);
    setEnded(null);
    const client = connectSocketOnly(`/ws/replay/${encodeURIComponent(file)}?speed=${atSpeed}`);
    client.onState((s) => setScreenState(s));
    client.onEnded((reason) => setEnded(reason));
    clientRef.current = client;
    setSelected(file);
  }

  return (
    <div className="replay-screen">
      {/* Task W5, fix round 2, requirement 1: Replay has no `StartedSession`, so its "id" is
          whichever of these already exists in client state -- the real server session id
          once a ScreenState has arrived, falling back to the chosen recording's filename
          (set the moment a recording is picked, before any state event) -- and omitted
          entirely before either exists. */}
      <Masthead sessionId={screenState?.session_id ?? selected} status={screenState?.agent_status ?? null} />

      <h1>Watch a recorded attack</h1>

      {/* Task W5, fix round 3, item 2: the single, always-on "simulated" banner for this
          screen -- Replay used to render this literal AND CallView's own copy at once (a
          real duplicate once a recording started); now there is exactly one source. */}
      <SimulatedBanner />

      {/* Task W5, fix round 3, item 3: recording select, speed radios and the "Replay
          ended:" status all sit on one row under the title (`.replay-controls`, styles.css);
          the no-mic note is a short muted line directly beneath, same words as before. */}
      <div className="replay-controls">
        <label htmlFor="replay-file">Recording</label>
        <select
          id="replay-file"
          value={selected ?? ''}
          onChange={(e) => {
            const file = e.target.value;
            if (file) startReplay(file, speed);
          }}
        >
          <option value="" disabled>
            Choose a recording
          </option>
          {files.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>

        <fieldset>
          <legend>Speed</legend>
          {SPEEDS.map((s) => (
            <label key={s}>
              <input
                type="radio"
                name="speed"
                value={s}
                checked={speed === s}
                onChange={() => {
                  setSpeed(s);
                  if (selected) startReplay(selected, s);
                }}
              />
              {s}×
            </label>
          ))}
        </fieldset>

        {ended && (
          <p role="status" className="replay-status">
            Replay ended: {ended}
          </p>
        )}
      </div>

      <p className="replay-note">No microphone is used on this screen -- it replays a recorded call end to end.</p>

      {screenState ? (
        // Task W5, requirement B: the forensic section defaults OPEN in Replay (the judge's
        // default path, BRIEF D4) -- everywhere else (the live call screen) it stays behind
        // the "Why?" click, unchanged.
        <CallView screen={screenState} defaultForensicOpen />
      ) : (
        <p>Choose a recording to begin.</p>
      )}

      {/* Task W5, fix round 2, requirement 3: Replay had no footer at all before this round
          -- same wording and shape as Call.tsx's, via the same shared component. */}
      <Footer exportHash={screenState?.forensic.export_hash ?? null} />
    </div>
  );
}
