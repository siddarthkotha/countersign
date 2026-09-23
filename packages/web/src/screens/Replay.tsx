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
// fake audio element (jsdom implements neither a real <audio> element's network/decode
// pipeline nor a real AudioContext) -- the real risk here is never "does the browser's own
// audio clock drift" (it's not ours to test), it's "does OUR start/stop/restart orchestration
// leave the audio pointed at the wrong moment" -- e.g. a stale `startedAtWall` surviving a
// restart, or a pause that doesn't reset position so a later restart double-counts elapsed
// time. `clock` is the thin adapter over the real playback mechanism (see `webAudioClockFor`
// below); `now` defaults to `Date.now` and is overridden by the test.
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

// Debugging session 2026-09-22 (Replay screen recorded-audio bug): a real-Chrome walk of the
// deployed demo found the hidden `<audio src="/api/replay-audio/...">` element wired up below
// stuck forever at readyState 0 / networkState 2 (LOADING) -- the recording's audio track
// never played. Root-caused with evidence (event-listener instrumentation + a server request
// log) against a LOCAL server running this same route: the browser's native `<audio>` element
// never even issued the network request -- not a Range/Content-Length problem (packages/
// server/src/http.ts's `/api/replay-audio/:file` route was ALSO fixed to answer real 206
// Partial Content / Content-Length / Accept-Ranges, see http.test.ts's "replay audio" describe
// block, but reproducing against the fixed route changed nothing). The one factor common to
// every failing case -- our own endpoint, a well-known external CORS-enabled audio file, and
// even a same-origin `blob:` URL with zero network involved -- was `document.hidden`: Chromium
// suspends an `HTMLMediaElement`'s entire load/decode pipeline while its document isn't the
// visible tab, independent of preload hints or server headers. `fetch()` and the Web Audio
// API's `AudioContext.decodeAudioData` are NOT subject to that suspension (proven the same
// way) -- so this fetches the recording's bytes itself and decodes/plays them through a raw
// `AudioBufferSourceNode` instead of handing a `<audio src>` to the browser's native media
// element, which sidesteps the suspension entirely regardless of which state caused it for any
// given viewer (backgrounded tab, throttled window, or a real user's own tab-switch).

/** One `AudioContext` for the whole Replay screen (recorded playback only, not the live
 *  call's streamed PCM -- packages/web/src/audio/playback.ts's shared context is scoped to
 *  Call.tsx and not reused here). Created lazily so importing this module never constructs
 *  one under jsdom. Returns null when no `AudioContext` constructor exists at all (jsdom,
 *  packages/web/test/Replay.test.tsx's full-component render) -- same graceful-fallback rule
 *  as an autoplay-blocked `.play()` rejection: the recording is still fully usable without
 *  its audio track, never a thrown error. */
let sharedAudioContext: AudioContext | null = null;
function getAudioContext(): AudioContext | null {
  if (sharedAudioContext) return sharedAudioContext;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  sharedAudioContext = new Ctor();
  return sharedAudioContext;
}

/** Decoded buffers cached by corpus filename -- a restart (Play again after Pause) or a
 *  speed toggle back to 1x reuses the same decode instead of re-fetching/re-decoding the
 *  recording every time. One in-flight promise per file collapses concurrent callers. */
const decodedBufferCache = new Map<string, Promise<AudioBuffer>>();
function loadDecodedBuffer(ctx: AudioContext, file: string): Promise<AudioBuffer> {
  let pending = decodedBufferCache.get(file);
  if (!pending) {
    pending = fetch(`/api/replay-audio/${encodeURIComponent(file)}`)
      .then((res) => res.arrayBuffer())
      .then((bytes) => ctx.decodeAudioData(bytes));
    // A failed fetch/decode must not poison the cache for a later retry (e.g. a transient
    // network error) -- drop it so the next `startReplay` tries again from scratch.
    pending.catch(() => decodedBufferCache.delete(file));
    decodedBufferCache.set(file, pending);
  }
  return pending;
}

/** The real adapter: decodes `file`'s bytes once (cached) and plays them through a fresh
 *  `AudioBufferSourceNode` each `play()` -- a source node is single-use by design (the Web
 *  Audio API has no seek/resume on one), which is exactly the shape this screen already
 *  needs: `createAudioSync`'s `stop()` always calls `seekToStart()` too, so every real
 *  restart already begins the recording over from t=0 (see the `AudioSync.stop()` doc comment
 *  above) -- there is never a "resume this same node" case to support.
 *
 *  `generation` guards the async decode against a `stop()`/`seekToStart()` that lands before
 *  the fetch+decode promise settles (e.g. the judge switches speed away from 1x, or restarts,
 *  within the first few hundred ms) -- without it, a stale decode could start playing a
 *  recording the screen already asked to stop, audible after the fact with nothing on screen
 *  to explain it.
 *
 *  `loadBuffer` defaults to the real `loadDecodedBuffer` (every real caller below); exported
 *  and overridable so packages/web/src/screens/Replay.test.ts can drive this with a
 *  controllable fake promise and a fake `AudioContext`-shaped object (jsdom has no real
 *  `AudioContext`/`decodeAudioData` to test against) -- the risk this proves is never "does
 *  the Web Audio API decode correctly" (not ours to test), it's "does the generation guard
 *  actually stop a late-resolving decode from starting playback after a stop()/restart". */
export function webAudioClockFor(
  ctx: AudioContext,
  getFile: () => string,
  loadBuffer: (ctx: AudioContext, file: string) => Promise<AudioBuffer> = loadDecodedBuffer,
): AudioSyncClock {
  let source: AudioBufferSourceNode | null = null;
  let startedAtCtxTime: number | null = null;
  let generation = 0;

  function stopSource(): void {
    if (source) {
      try {
        source.stop();
      } catch {
        // Already stopped/ended -- fine, this is a normal race with natural playback end.
      }
      source.disconnect();
    }
    source = null;
    startedAtCtxTime = null;
  }

  return {
    play() {
      const myGeneration = ++generation;
      // Autoplay-blocked contexts start 'suspended' until a real user gesture; same
      // graceful-fallback rule as the old `<audio>.play()` rejection -- never surfaced as an
      // error, the recording is still fully usable without its audio track.
      void ctx.resume().catch(() => {});
      // Orchestrator review 2026-09-22 9:05 PM: the transcript clock starts NOW, at play();
      // the fetch + decode below can take most of a second on a cold load. Anchor to this
      // instant and start the buffer that far in, so the voices never lag the transcript by
      // the decode time (proven by Replay.test.ts's late-decode offset test).
      const playCalledAtCtxTime = ctx.currentTime;
      const file = getFile();
      loadBuffer(ctx, file)
        .then((buffer) => {
          if (myGeneration !== generation) return; // superseded by a later stop()/restart
          const offsetSeconds = Math.max(0, ctx.currentTime - playCalledAtCtxTime);
          const node = ctx.createBufferSource();
          node.buffer = buffer;
          node.connect(ctx.destination);
          node.start(0, offsetSeconds);
          source = node;
          startedAtCtxTime = playCalledAtCtxTime;
        })
        .catch(() => {
          // Fetch or decode failed -- same graceful-fallback rule as above.
        });
    },
    pause() {
      generation++; // invalidate any in-flight decode so it can't start after this pause
      stopSource();
    },
    seekToStart() {
      generation++;
      stopSource();
    },
    currentTimeMs() {
      if (startedAtCtxTime === null) return 0;
      return (ctx.currentTime - startedAtCtxTime) * 1000;
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
  // Founder ruling 2026-09-22 8:00 PM: a recording's real voices at speed 1 (AUDIO_SPEEDS
  // above), played via Web Audio (see `webAudioClockFor` above for why, not a native <audio>
  // element). `pendingAudioFileRef` names the file `webAudioClockFor`'s `play()` should
  // fetch/decode -- set immediately before every `audioSync()?.start()` call, so the closure
  // it reads from always sees the file that call is actually starting, never a stale one from
  // a previous selection. `audioSyncRef` is built lazily, once, the first time anything
  // actually needs to start or stop audio.
  const pendingAudioFileRef = useRef<string>('');
  const audioSyncRef = useRef<AudioSync | null>(null);

  function audioSync(): AudioSync | null {
    if (!audioSyncRef.current) {
      const ctx = getAudioContext();
      if (!ctx) return null;
      audioSyncRef.current = createAudioSync(webAudioClockFor(ctx, () => pendingAudioFileRef.current));
    }
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
    if (recording?.has_audio && AUDIO_SPEEDS.has(atSpeed)) {
      pendingAudioFileRef.current = file;
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
          (`has_audio`), played at speed 1 only (AUDIO_SPEEDS above) -- no visible player, no
          new button/label/layout, exactly the founder's brief ("no visual design changes");
          `startReplay`/`pausePlayback` above are the only things that ever touch it. Played
          via Web Audio (`webAudioClockFor` above), not a DOM `<audio>` element -- there is
          nothing to render here. Absent entirely from any speed-4x/20x replay and from any
          recording with no audio file -- the screen behaves exactly as it always has in both
          of those cases. */}

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
