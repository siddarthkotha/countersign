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

// Judge review finding (2026-09-04), defect 2: one entry per corpus recording, with a plain-
// English `label` (the corpus file's own `title`, added server-side in http.ts's
// `/api/replay` -- never invented on this side) instead of the raw filename, and
// `recommended` marking the flagship attack scenario the submission draft points a judge to
// first. `file` is still the bare value the WS route expects, same as `files` always was.
interface ReplayRecording {
  file: string;
  label: string;
  recommended: boolean;
}

interface ReplayListResponse {
  files: string[];
  recordings?: ReplayRecording[];
}

// A response with no `recordings` (an older server) still lists every file -- the filename
// itself, same as this screen showed before this fix -- rather than an empty dropdown.
function toRecordings(body: ReplayListResponse): ReplayRecording[] {
  if (body.recordings) return body.recordings;
  return body.files.map((file) => ({ file, label: file, recommended: false }));
}

// Judge review finding (2026-09-04), defect 1: the recording list used to be fetched with no
// loading state at all, so the dropdown silently sat empty while the request was in flight,
// and silently stayed empty forever if it failed -- a judge had no way to tell "still
// loading" from "broken". Tracked separately from `recordings` itself so a failed refetch
// can't be confused with "zero recordings exist".
type ListState = 'loading' | 'ready' | 'error';

export default function Replay() {
  const [recordings, setRecordings] = useState<ReplayRecording[]>([]);
  const [listState, setListState] = useState<ListState>('loading');
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
        if (cancelled) return;
        setRecordings(toRecordings(body));
        setListState('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setRecordings([]);
        setListState('error');
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
          {/* Judge review finding (2026-09-04), defect 1: this placeholder option is the
              existing element that carries the list's own loading/error status -- reused
              rather than adding a new one -- so a judge who opens the dropdown mid-fetch, or
              after a failed one, reads "still loading" or "broken, here's what to do" instead
              of a silently empty list. */}
          <option value="" disabled>
            {listState === 'loading'
              ? 'Loading recordings…'
              : listState === 'error'
                ? 'Could not load recordings — reload the page to try again'
                : 'Choose a recording'}
          </option>
          {/* Judge review finding (2026-09-04), defect 2: option text is now the recording's
              plain-English label (the flagship's is prefixed "Recommended:" and sorted first
              by the server), not the raw corpus filename. */}
          {recordings.map((r) => (
            <option key={r.file} value={r.file}>
              {r.label}
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
