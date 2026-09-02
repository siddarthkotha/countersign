// packages/web/src/screens/Replay.tsx
// The no-mic path: connects to `/ws/replay/<file>?speed=<n>` (packages/server/src/ws/browser.ts,
// `/ws/replay/:file`) and renders the exact same CallView component the live call screen
// will use (W3). No getUserMedia call anywhere in this file -- this is the "no-mic REPLAY
// mode that drives the full UI" requirement (CLAUDE.md engineering laws): a judge with no
// microphone, or one who does not want to grant mic permission, still sees the whole thing.
import { useEffect, useRef, useState } from 'react';
import type { ScreenState } from '@countersign/engine';
import CallView from '../components/CallView';
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
      <h1>Watch a recorded attack</h1>
      <p className="banner">Every system here is simulated.</p>
      <p>No microphone is used on this screen -- it replays a recorded call end to end.</p>

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
      </div>

      {ended && <p role="status">Replay ended: {ended}</p>}

      {screenState ? <CallView screen={screenState} /> : <p>Choose a recording to begin.</p>}
    </div>
  );
}
