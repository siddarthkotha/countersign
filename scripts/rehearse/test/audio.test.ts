// Real synthesis + conversion of ONE short clip via macOS `say` and `ffmpeg` -- no network,
// matches task instructions ("PCM conversion of one short clip via `say`"). Skips itself
// (rather than failing) on a machine without `say`/`ffmpeg` on PATH, since this harness is
// explicitly a macOS-only tool (CLAUDE.md/task brief: "Founder machine: macOS with
// /usr/bin/say, /usr/bin/afconvert, /usr/local/bin/ffmpeg available").
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { chunkToFrames, frameDurationMs, FRAME_BYTES, FRAME_MS, FRAME_SAMPLES, SAMPLE_RATE, synthesizeLine } from '../audio.js';

const execFileAsync = promisify(execFile);

let toolsAvailable = true;

beforeAll(async () => {
  try {
    await execFileAsync('say', ['-v', '?']);
    await execFileAsync('ffmpeg', ['-version']);
  } catch {
    toolsAvailable = false;
  }
});

describe('audio: frame constants', () => {
  it('matches the wire format packages/web/src/audio/capture.worklet.ts produces', () => {
    expect(SAMPLE_RATE).toBe(24000);
    expect(FRAME_MS).toBe(20);
    expect(FRAME_SAMPLES).toBe(480);
    expect(FRAME_BYTES).toBe(960);
  });

  it('frameDurationMs is frames * 20ms', () => {
    expect(frameDurationMs(0)).toBe(0);
    expect(frameDurationMs(1)).toBe(20);
    expect(frameDurationMs(50)).toBe(1000);
  });
});

describe('audio: chunkToFrames', () => {
  it('splits an exact multiple of FRAME_BYTES into whole frames with no padding', () => {
    const pcm = Buffer.alloc(FRAME_BYTES * 3, 7);
    const frames = chunkToFrames(pcm);
    expect(frames).toHaveLength(3);
    for (const f of frames) expect(f.length).toBe(FRAME_BYTES);
  });

  it('zero-pads a short final frame to a full frame instead of dropping it', () => {
    const pcm = Buffer.alloc(FRAME_BYTES + 100, 9);
    const frames = chunkToFrames(pcm);
    expect(frames).toHaveLength(2);
    expect(frames[0]!.length).toBe(FRAME_BYTES);
    expect(frames[1]!.length).toBe(FRAME_BYTES);
    // the first 100 bytes of the padded frame are the real tail; the rest is silence (0).
    expect(frames[1]!.subarray(0, 100).every((b) => b === 9)).toBe(true);
    expect(frames[1]!.subarray(100).every((b) => b === 0)).toBe(true);
  });

  it('an empty buffer produces no frames', () => {
    expect(chunkToFrames(Buffer.alloc(0))).toHaveLength(0);
  });
});

describe('audio: real say -> ffmpeg synthesis (one short clip, no network)', () => {
  it('produces cacheable raw PCM16LE mono 24kHz bytes for a short line', async () => {
    if (!toolsAvailable) {
      console.warn('audio.test: `say`/`ffmpeg` not found on PATH -- skipping real synthesis test (macOS-only harness).');
      return;
    }
    const text = 'rehearsal harness self test';
    const pcm = await synthesizeLine(text, 'Samantha');
    expect(pcm.length).toBeGreaterThan(0);
    // 16-bit samples -> an even byte count.
    expect(pcm.length % 2).toBe(0);

    const frames = chunkToFrames(pcm);
    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) expect(f.length).toBe(FRAME_BYTES);

    // Calling again for the SAME (voice, text) must hit the cache and return identical bytes
    // without re-invoking `say` a second time (this only proves identical output, not that
    // the process wasn't re-run, but the cache file's existence is exercised either way).
    const pcmAgain = await synthesizeLine(text, 'Samantha');
    expect(Buffer.compare(pcm, pcmAgain)).toBe(0);
  }, 30000);
});
