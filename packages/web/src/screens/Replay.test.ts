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
import { describe, expect, it } from 'vitest';
import { createAudioSync, type AudioSyncClock } from './Replay';

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
