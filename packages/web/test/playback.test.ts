// packages/web/test/playback.test.ts
// TDD for src/audio/playback.ts: barge-in is won in the client audio buffer (BRIEF
// engineering law a) -- flush() must synchronously stop every scheduled source and clear
// the queue, so nothing already scheduled keeps playing. A fake AudioContext stands in for
// the real one (jsdom has no Web Audio implementation).
import { describe, expect, it } from 'vitest';
import { createPlayback } from '../src/audio/playback';

class FakeAudioBufferSourceNode {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  stopped = false;
  started = false;
  connect(): void {
    // no-op: the fake has no real audio graph to wire up.
  }
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
}

class FakeAudioContext {
  currentTime = 0;
  destination = {};
  sources: FakeAudioBufferSourceNode[] = [];

  createBuffer(_channels: number, length: number, sampleRate: number) {
    const data = new Float32Array(length);
    return {
      duration: length / sampleRate,
      getChannelData: () => data,
    };
  }

  createBufferSource(): FakeAudioBufferSourceNode {
    const node = new FakeAudioBufferSourceNode();
    this.sources.push(node);
    return node;
  }
}

function base64OfSilence(samples: number): string {
  const pcm = new Int16Array(samples);
  const bytes = new Uint8Array(pcm.buffer);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function makeContext(): { ctx: AudioContext; fake: FakeAudioContext } {
  const fake = new FakeAudioContext();
  return { ctx: fake as unknown as AudioContext, fake };
}

describe('playback', () => {
  it('schedules pushed chunks as started sources', () => {
    const { ctx, fake } = makeContext();
    const playback = createPlayback(ctx);

    playback.push(base64OfSilence(480));
    playback.push(base64OfSilence(480));
    playback.push(base64OfSilence(480));

    expect(fake.sources).toHaveLength(3);
    for (const s of fake.sources) expect(s.started).toBe(true);
  });

  it('flush stops every scheduled source and clears the queue within one frame', () => {
    const { ctx, fake } = makeContext();
    const playback = createPlayback(ctx);

    playback.push(base64OfSilence(480));
    playback.push(base64OfSilence(480));
    playback.push(base64OfSilence(480));

    playback.flush();

    for (const s of fake.sources) expect(s.stopped).toBe(true);

    // A push after flush schedules a fresh source rather than resuming a stale queue --
    // proof the queue was actually cleared, not merely stopped in place.
    playback.push(base64OfSilence(480));
    expect(fake.sources).toHaveLength(4);
    expect(fake.sources[3]!.stopped).toBe(false);
  });

  it('flush is safe to call with nothing scheduled', () => {
    const { ctx } = makeContext();
    const playback = createPlayback(ctx);
    expect(() => playback.flush()).not.toThrow();
  });

  it('level() reflects the peak of the most recently pushed chunk and resets to 0 on flush', () => {
    const { ctx } = makeContext();
    const playback = createPlayback(ctx);

    const pcm = new Int16Array(480).fill(0x4000); // half-scale positive samples
    const bytes = new Uint8Array(pcm.buffer);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    playback.push(btoa(binary));

    expect(playback.level()).toBeGreaterThan(0);
    expect(playback.level()).toBeLessThanOrEqual(1);

    playback.flush();
    expect(playback.level()).toBe(0);
  });
});
