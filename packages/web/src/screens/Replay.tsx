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

// Founder ruling 2026-09-22 8:00 PM: a recorded call's real audio plays alongside its text
// replay, but ONLY at speed 1. Decision (no visible control for this -- see the two open
// questions in the build report): DISABLE audio entirely at 4x/20x rather than mute-and-
// fast-play it. A muted, fast-forwarded audio element buys a judge nothing (they can't hear
// it), costs a full extra network fetch + decode, and `HTMLMediaElement.playbackRate` is
// unreliable much past 4x in real browsers (audible artifacts or silent clamping depending
// on engine) -- so 20x would either sound wrong if unmuted by accident or do pointless work
// muted. Disabling is also the simplest correct behavior: no rate math, nothing to keep in
// sync once the visual replay is already running many times faster than real time.
const AUDIO_SPEEDS: ReadonlySet<Speed> = new Set([1]);

// Exported so packages/web/src/screens/Replay.test.ts can drive this with a FAKE clock and a
// fake audio element (jsdom's real <audio> never advances currentTime or lets .play()
// resolve) -- the real risk here is never "does the browser's own audio clock drift" (it's
// not ours to test), it's "does OUR start/stop/restart orchestration leave the audio element
// pointed at the wrong moment" -- e.g. a stale `startedAtWall` surviving a restart, or a
// pause that doesn't reset position so a later restart double-counts elapsed time. `clock`
// is the thin adapter over a real `<audio>` element (see `audioClockFor` below); `now`
// defaults to `Date.now` and is overridden by the test.
export interface AudioSyncClock {
  play(): void;
  pause(): void;
  seekToStart(): void;
  currentTimeMs(): number;
}

export interface AudioSync {
  /** Seeks to 0 and starts playing, anchoring drift measurement to this instant. */
  start(): void;
  /** Pauses and seeks back to 0 -- every restart begins the recording over from its start,
   *  same as the WS replay client itself (Replay has no mid-call resume, see `startReplay`
   *  below), so there is never a "resume from where it paused" position to preserve. */
  stop(): void;
  /** How far `clock`'s own reported position has drifted from where `start()` + elapsed
   *  wall time says it should be, in ms (positive = audio is ahead). Null before any
   *  `start()`, or after `stop()`. */
  driftMs(): number | null;
}

export function createAudioSync(clock: AudioSyncClock, now: () => number = () => Date.now()): AudioSync {
  let startedAtWall: number | null = null;

  return {
    start() {
      clock.seekToStart();
      clock.play();
      startedAtWall = now();
    },
    stop() {
      clock.pause();
      clock.seekToStart();
      startedAtWall = null;
    },
    driftMs() {
      if (startedAtWall === null) return null;
      const expectedMs = now() - startedAtWall;
      return clock.currentTimeMs() - expectedMs;
    },
  };
}

/** The real adapter: wraps an `HTMLAudioElement` as an `AudioSyncClock`. `.play()`'s promise
 *  rejection (autoplay blocked, or the browser hasn't fetched enough to start yet) is
 *  swallowed the same way `startReplay`'s own WS-connect fallback already swallows a blocked
 *  automatic start below -- never surfaced as an error, the recording is still fully usable
 *  without its audio track. */
function audioClockFor(el: HTMLAudioElement): AudioSyncClock {
  return {
    play() {
      void el.play().catch(() => {});
    },
    pause() {
      el.pause();
    },
    seekToStart() {
      el.currentTime = 0;
    },
    currentTimeMs() {
      return el.currentTime * 1000;
    },
  };
}

// Judge review finding (2026-09-04), defect 2: one entry per corpus recording, with a plain-
// English `label` (the corpus file's own `title`, added server-side in http.ts's
// `/api/replay` -- never invented on this side) instead of the raw filename, and
// `recommended` marking the flagship attack scenario the submission draft points a judge to
// first. `file` is still the bare value the WS route expects, same as `files` always was.
interface ReplayRecording {
  file: string;
  label: string;
  recommended: boolean;
  // Founder ruling 2026-09-22 8:00 PM: whether GET /api/replay-audio/<file> has a real
  // recording behind it (http.ts's `listReplayAudioFiles` whitelist). False for every
  // synthetic-script corpus entry and for any recorded one before its .ogg is committed --
  // those always replay exactly as before, text-only, no different from today.
  has_audio: boolean;
}

interface ReplayListResponse {
  files: string[];
  recordings?: ReplayRecording[];
}

// A response with no `recordings` (an older server) still lists every file -- the filename
// itself, same as this screen showed before this fix -- rather than an empty dropdown.
function toRecordings(body: ReplayListResponse): ReplayRecording[] {
  if (body.recordings) return body.recordings;
  return body.files.map((file) => ({ file, label: file, recommended: false, has_audio: false }));
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
  // Founder ruling 10 (2026-09-09): whether a replay stream is actively being consumed right
  // now. Drives the Play/Pause control below -- always a plain word, never a colour, per the
  // founder's colour-blind accessibility rule.
  const [isPlaying, setIsPlaying] = useState(false);
  // Track if playback has ever been started so we can label the button "Play from start"
  // when paused, clarifying that resuming mid-call is not supported.
  const [hasPlayedBefore, setHasPlayedBefore] = useState(false);
  const clientRef = useRef<CallClient | null>(null);
  // Founder ruling 2026-09-22 8:00 PM: the hidden <audio> element carrying a recording's
  // real voices at speed 1 (AUDIO_SPEEDS above). `audioSyncRef` wraps it lazily -- the
  // element doesn't exist yet on the render that creates `audioRef`, so the sync object is
  // built the first time something actually needs to start or stop audio.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioSyncRef = useRef<AudioSync | null>(null);

  function audioSync(): AudioSync | null {
    if (!audioRef.current) return null;
    if (!audioSyncRef.current) audioSyncRef.current = createAudioSync(audioClockFor(audioRef.current));
    return audioSyncRef.current;
  }

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
      audioSync()?.stop();
    },
    [],
  );

  function startReplay(file: string, atSpeed: Speed) {
    clientRef.current?.close();
    audioSync()?.stop();
    setScreenState(null);
    setEnded(null);

    // Founder ruling 2026-09-22 8:00 PM: audio only ever plays at speed 1, for a recording
    // that actually has one (AUDIO_SPEEDS above). Started in the same tick as the WS
    // connect below so the audio track's own t=0 (the moment AssemblyAI began recording)
    // lines up with the replay clock's own t=0 -- both are "the instant this call began".
    const recording = recordings.find((r) => r.file === file);
    if (recording?.has_audio && AUDIO_SPEEDS.has(atSpeed) && audioRef.current) {
      audioRef.current.src = `/api/replay-audio/${encodeURIComponent(file)}`;
      audioRef.current.load();
      audioSync()?.start();
    }

    try {
      const client = connectSocketOnly(`/ws/replay/${encodeURIComponent(file)}?speed=${atSpeed}`);
      client.onState((s) => setScreenState(s));
      client.onEnded((reason) => {
        setEnded(reason);
        setIsPlaying(false);
        audioSync()?.stop();
      });
      clientRef.current = client;
      setSelected(file);
      setIsPlaying(true);
      setHasPlayedBefore(true);
    } catch {
      // Founder ruling 10 (2026-09-09): if the browser refuses the automatic start (or the
      // connection itself fails), the recording still ends up selected -- so the judge sees
      // what's queued up -- and the Play control below lets them start it with one click.
      // Never surfaced as an error, same graceful-fallback rule as the mic check.
      clientRef.current = null;
      audioSync()?.stop();
      setSelected(file);
      setIsPlaying(false);
    }
  }

  // Founder ruling 10 (2026-09-09): a judge with three minutes should never have to hunt for
  // a play button. The instant the recording list is ready, with nothing chosen yet, the
  // flagship attack scenario (the corpus's own `recommended` flag, falling back to the first
  // recording if the server ever omits it) auto-selects and starts playing.
  useEffect(() => {
    if (listState !== 'ready' || selected !== null || recordings.length === 0) return;
    const flagship = recordings.find((r) => r.recommended) ?? recordings[0]!;
    startReplay(flagship.file, speed);
    // `selected` is in the dependency list below so this effect re-checks its own guard
    // whenever a recording gets chosen (auto or manual) -- but the guard above means it only
    // ever actually starts a replay once, the moment the list first becomes ready with
    // nothing chosen yet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listState, recordings, selected]);

  function pausePlayback() {
    clientRef.current?.close();
    clientRef.current = null;
    audioSync()?.stop();
    setIsPlaying(false);
  }

  function resumePlayback() {
    if (selected) startReplay(selected, speed);
  }

  return (
    <div className="replay-screen">
      {/* Task W5, fix round 2, requirement 1: Replay has no `StartedSession`, so its "id" is
          whichever of these already exists in client state -- the real server session id
          once a ScreenState has arrived, falling back to the chosen recording's filename
          (set the moment a recording is picked, before any state event) -- and omitted
          entirely before either exists. */}
      <Masthead sessionId={screenState?.session_id ?? selected} status={screenState?.agent_status ?? null} />

      {/* Founder ruling 2026-09-22 8:00 PM: the recording's real audio, when it has one
          (`has_audio`), played at speed 1 only (AUDIO_SPEEDS above). No `controls` attribute
          -- this is not a visible player, no new button/label/layout, exactly the founder's
          brief ("no visual design changes"); `startReplay`/`pausePlayback` above are the
          only things that ever touch it. Absent entirely from any speed-4x/20x replay and
          from any recording with no audio file -- the screen behaves exactly as it always
          has in both of those cases. */}
      <audio ref={audioRef} style={{ display: 'none' }} preload="auto" />

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
                ? 'Could not load recordings. Reload the page to try again'
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

        {/* Founder ruling 10 (2026-09-09): one obvious, plain-worded control -- never a
            colour-only state (the founder is colour blind) -- for the auto-started playback.
            Only shown once a recording is selected (auto or manual); "Play" also covers the
            fallback case where the automatic start was blocked by the browser. When paused after
            having played before, label clarifies that resuming mid-call is not supported. */}
        {selected && (
          <button type="button" onClick={isPlaying ? pausePlayback : resumePlayback} aria-pressed={isPlaying}>
            {isPlaying ? 'Pause' : (hasPlayedBefore ? 'Play from start' : 'Play')}
          </button>
        )}

        {ended && (
          <p role="status" className="replay-status">
            Replay ended: {ended}
          </p>
        )}
      </div>

      {selected && !isPlaying && hasPlayedBefore && (
        <p className="replay-resume-note">Resuming mid-call is not supported yet.</p>
      )}

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
