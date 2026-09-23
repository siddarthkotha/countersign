// packages/web/src/screens/Replay.test.ts
// Founder ruling 2026-09-22 8:00 PM (recorded audio in Replay, real voices): "Start/stop/
// restart must keep audio and timeline aligned (drift under 150 ms over the call; measure it
// in a test with a fake clock if you can)." This tests `createAudioSync` (exported from
// Replay.tsx) in isolation, with a FAKE clock and a FAKE `AudioSyncClock` standing in for a
// real `<audio>` element -- jsdom's own <audio> never advances `currentTime` or lets `.play()`
// resolve, so a real-DOM test could never actually observe drift. The risk this proves is
// never "does a browser's own audio clock drift" (out of our control, not our bug to catch);
// it's "does OUR start/stop/restart orchestration itself introduce or accumulate drift" --
// e.g. a stale start time surviving a restart, or a pause that leaves a nonzero offset a later
// restart then compounds.
import { describe, expect, it, vi } from 'vitest';
import { createAudioSync, webAudioClockFor, type AudioSyncClock } from './Replay';

/** An idealized fake `<audio>` element: `currentTime` tracks `getNow()` exactly while
 *  "playing", frozen while paused -- i.e. zero drift of its own, so any drift the test
 *  observes comes only from how `createAudioSync` sequences play/pause/seek, not from this
 *  fake pretending to be an imperfect media clock. `startLatencyMs` models the realistic gap
 *  between calling `.play()` and the browser actually starting to produce audio frames (buffer
 *  fill / autoplay negotiation) -- currentTime stays frozen at 0 for that long after `play()`
 *  before it starts advancing, the one place a real browser's own timing could differ from
 *  ours calling `now()` the instant we ask it to start. */
function makeFakeAudioClock(getNow: () => number, startLatencyMs = 0): AudioSyncClock {
  let playing = false;
  let playRequestedAtWall: number | null = null;
  let frozenAtMs = 0;

  return {
    play() {
      if (playing) return;
      playing = true;
      playRequestedAtWall = getNow();
    },
    pause() {
      if (!playing) return;
      frozenAtMs = currentTimeMsWhilePlaying();
      playing = false;
      playRequestedAtWall = null;
    },
    seekToStart() {
      frozenAtMs = 0;
      playRequestedAtWall = playing ? getNow() : null;
    },
    currentTimeMs() {
      return playing ? currentTimeMsWhilePlaying() : frozenAtMs;
    },
  };

  function currentTimeMsWhilePlaying(): number {
    if (playRequestedAtWall === null) return frozenAtMs;
    const sincePlayCalled = getNow() - playRequestedAtWall;
    return frozenAtMs + Math.max(0, sincePlayCalled - startLatencyMs);
  }
}

const DRIFT_BUDGET_MS = 150;

describe('createAudioSync (Replay.tsx) -- drift over a call, with a fake clock', () => {
  it('stays under the 150 ms budget across a ~75 s call with zero media-start latency', () => {
    let now = 0;
    const clock = makeFakeAudioClock(() => now);
    const sync = createAudioSync(clock, () => now);

    sync.start();
    for (const checkpointMs of [0, 1000, 10000, 30000, 60000, 74000]) {
      now = checkpointMs;
      expect(Math.abs(sync.driftMs()!)).toBeLessThan(DRIFT_BUDGET_MS);
    }
  });

  it('stays under the 150 ms budget with a realistic ~80 ms media-start latency', () => {
    let now = 0;
    const clock = makeFakeAudioClock(() => now, 80);
    const sync = createAudioSync(clock, () => now);

    sync.start();
    for (const checkpointMs of [0, 200, 5000, 40000, 74000]) {
      now = checkpointMs;
      expect(Math.abs(sync.driftMs()!)).toBeLessThan(DRIFT_BUDGET_MS);
    }
  });

  it('driftMs() is null before the first start() and after stop()', () => {
    let now = 0;
    const clock = makeFakeAudioClock(() => now);
    const sync = createAudioSync(clock, () => now);

    expect(sync.driftMs()).toBeNull();

    sync.start();
    now = 5000;
    expect(sync.driftMs()).not.toBeNull();

    sync.stop();
    expect(sync.driftMs()).toBeNull();
  });

  it('a restart after a long pause begins from zero drift again -- no accumulated offset', () => {
    let now = 0;
    const clock = makeFakeAudioClock(() => now);
    const sync = createAudioSync(clock, () => now);

    sync.start();
    now = 20000;
    expect(Math.abs(sync.driftMs()!)).toBeLessThan(DRIFT_BUDGET_MS);

    sync.stop();
    // The judge leaves the tab paused for a long time -- must not leak into the next start.
    now = 500000;

    sync.start();
    // Restarting always begins the recording over from its own t=0 (Replay has no mid-call
    // resume) -- drift right after restart must be tiny, not ~480000ms of stale offset.
    expect(Math.abs(sync.driftMs()!)).toBeLessThan(DRIFT_BUDGET_MS);

    now += 74000;
    expect(Math.abs(sync.driftMs()!)).toBeLessThan(DRIFT_BUDGET_MS);
  });

  it('seeks to 0 and pauses on stop() (so a later restart is never mid-call)', () => {
    let now = 0;
    const clock = makeFakeAudioClock(() => now);
    const sync = createAudioSync(clock, () => now);

    sync.start();
    now = 30000;
    sync.stop();

    expect(clock.currentTimeMs()).toBe(0);
  });
});

// Debugging session 2026-09-22 (Replay screen recorded-audio bug): the hidden <audio
// src="..."> element this screen used to hand a recording's URL to never played -- root-
// caused (see Replay.tsx's `webAudioClockFor` doc comment) to Chromium suspending an
// `HTMLMediaElement`'s entire load/decode pipeline while its document isn't the visible tab,
// proven independent of the server's Range/Content-Length support (packages/server/test/
// http.test.ts's "replay audio" describe block fixes and tests that separately). The fix
// fetches+decodes the recording itself and plays it through a raw `AudioBufferSourceNode`,
// which isn't subject to that suspension. These tests exercise `webAudioClockFor`'s own
// orchestration -- the `generation` guard on the async decode -- with a FAKE `AudioContext`-
// shaped object and a controllable buffer-load promise; jsdom has no real `AudioContext` or
// `decodeAudioData` to test against, and the browser's own decode correctness isn't ours to
// prove (same reasoning `makeFakeAudioClock` above already documents for `createAudioSync`).
describe('webAudioClockFor (Replay.tsx) -- the async-decode race, with a fake AudioContext', () => {
  interface FakeSourceNode {
    buffer: unknown;
    started: boolean;
    stopped: boolean;
    disconnected: boolean;
    connect: (dest: unknown) => void;
    start: (when: number) => void;
    stop: () => void;
    disconnect: () => void;
  }

  function makeFakeAudioContext(getNowMs: () => number): { ctx: AudioContext; sources: FakeSourceNode[] } {
    const sources: FakeSourceNode[] = [];
    const ctx = {
      get currentTime() {
        return getNowMs() / 1000;
      },
      destination: {},
      resume: () => Promise.resolve(),
      createBufferSource: () => {
        const node: FakeSourceNode = {
          buffer: null,
          started: false,
          stopped: false,
          disconnected: false,
          connect: () => {},
          start: () => {
            node.started = true;
          },
          stop: () => {
            node.stopped = true;
          },
          disconnect: () => {
            node.disconnected = true;
          },
        };
        sources.push(node);
        return node;
      },
    };
    return { ctx: ctx as unknown as AudioContext, sources };
  }

  /** A `loadBuffer` stand-in whose promise the test resolves/rejects on its own schedule,
   *  instead of a real fetch+decode settling whenever the network/CPU gets to it. */
  function makeControllableLoader(): {
    loadBuffer: (ctx: AudioContext, file: string) => Promise<AudioBuffer>;
    resolve: () => void;
    reject: () => void;
    callCount: () => number;
  } {
    let resolveFn: (buf: AudioBuffer) => void = () => {};
    let rejectFn: (err: unknown) => void = () => {};
    let callCount = 0;
    const loadBuffer = () => {
      callCount++;
      return new Promise<AudioBuffer>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });
    };
    return {
      loadBuffer,
      resolve: () => resolveFn({} as AudioBuffer),
      reject: () => rejectFn(new Error('decode failed')),
      callCount: () => callCount,
    };
  }

  it('play() starts a source once the buffer decode resolves', async () => {
    let now = 0;
    const { ctx, sources } = makeFakeAudioContext(() => now);
    const { loadBuffer, resolve } = makeControllableLoader();
    const clock = webAudioClockFor(ctx, () => 'recorded-freeze', loadBuffer);

    clock.play();
    expect(sources).toHaveLength(0); // nothing starts before the decode resolves

    resolve();
    await vi.waitFor(() => expect(sources).toHaveLength(1));
    expect(sources[0]!.started).toBe(true);

    now = 3000;
    expect(clock.currentTimeMs()).toBeCloseTo(3000, 0);
  });

  // Orchestrator review 2026-09-22 9:05 PM: the transcript clock starts at play(); a fetch +
  // decode that takes 900 ms must not start the audio 900 ms behind it. The source has to
  // start 0.9 s INTO the buffer, and the clock must report the full time since play().
  it('a decode that resolves late starts the buffer at the elapsed offset, so audio never lags the transcript', async () => {
    let now = 0;
    const { ctx, sources } = makeFakeAudioContext(() => now);
    const offsets: number[] = [];
    const origCreate = ctx.createBufferSource.bind(ctx);
    (ctx as unknown as { createBufferSource: () => unknown }).createBufferSource = () => {
      const node = origCreate() as unknown as FakeSourceNode;
      node.start = (_when: number, offset?: number) => {
        node.started = true;
        offsets.push(offset ?? 0);
      };
      return node;
    };
    const { loadBuffer, resolve } = makeControllableLoader();
    const clock = webAudioClockFor(ctx, () => 'recorded-freeze', loadBuffer);

    clock.play();
    now = 900; // the decode takes 900 ms
    resolve();
    await vi.waitFor(() => expect(sources).toHaveLength(1));
    expect(offsets[0]).toBeCloseTo(0.9, 3);
    expect(clock.currentTimeMs()).toBeCloseTo(900, 0);
    now = 5900;
    expect(clock.currentTimeMs()).toBeCloseTo(5900, 0);
  });

  it('a pause() before the decode resolves stops the source from ever starting (the generation guard)', async () => {
    let now = 0;
    const { ctx, sources } = makeFakeAudioContext(() => now);
    const { loadBuffer, resolve } = makeControllableLoader();
    const clock = webAudioClockFor(ctx, () => 'recorded-freeze', loadBuffer);

    clock.play();
    clock.pause(); // lands before the decode below ever resolves
    resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(sources).toHaveLength(0); // the stale decode must never create/start a node
    expect(clock.currentTimeMs()).toBe(0);
  });

  it('a seekToStart() (restart) before the decode resolves also blocks the stale decode', async () => {
    let now = 0;
    const { ctx, sources } = makeFakeAudioContext(() => now);
    const { loadBuffer, resolve } = makeControllableLoader();
    const clock = webAudioClockFor(ctx, () => 'recorded-freeze', loadBuffer);

    clock.play();
    clock.seekToStart();
    resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(sources).toHaveLength(0);
  });

  it('seekToStart() while a source is already playing stops and discards it', async () => {
    let now = 0;
    const { ctx, sources } = makeFakeAudioContext(() => now);
    const { loadBuffer, resolve } = makeControllableLoader();
    const clock = webAudioClockFor(ctx, () => 'recorded-freeze', loadBuffer);

    clock.play();
    resolve();
    await vi.waitFor(() => expect(sources).toHaveLength(1));

    now = 5000;
    clock.seekToStart();

    expect(sources[0]!.stopped).toBe(true);
    expect(sources[0]!.disconnected).toBe(true);
    expect(clock.currentTimeMs()).toBe(0);
  });

  it('a decode that rejects (fetch/decode failure) never starts a source -- swallowed, not thrown', async () => {
    const { ctx, sources } = makeFakeAudioContext(() => 0);
    const { loadBuffer, reject } = makeControllableLoader();
    const clock = webAudioClockFor(ctx, () => 'recorded-freeze', loadBuffer);

    expect(() => clock.play()).not.toThrow();
    reject();
    await Promise.resolve();
    await Promise.resolve();

    expect(sources).toHaveLength(0);
  });
});
