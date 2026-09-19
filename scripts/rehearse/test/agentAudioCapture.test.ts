// scripts/rehearse/test/agentAudioCapture.test.ts
// Proves the in-memory PCM capture: frames are indexed in arrival order with correct byte
// ranges, the byte cap truncates (both the stored PCM/frames AND leaves total_bytes_received
// counting everything that actually arrived), and a fresh capture starts empty. No network, no
// live server -- synthetic frames only.
import { describe, expect, it } from 'vitest';
import { createAgentAudioCapture, DEFAULT_MAX_CAPTURE_BYTES } from '../agentAudioCapture.js';

describe('createAgentAudioCapture', () => {
  it('starts with an empty snapshot', () => {
    const cap = createAgentAudioCapture();
    const snap = cap.snapshot();
    expect(snap.pcm.length).toBe(0);
    expect(snap.frames).toEqual([]);
    expect(snap.truncated).toBe(false);
    expect(snap.total_bytes_received).toBe(0);
  });

  it('indexes frames in arrival order with correct t_ms and byte offsets', () => {
    const cap = createAgentAudioCapture();
    const a = Buffer.from([1, 2, 3, 4]);
    const b = Buffer.from([5, 6]);
    const c = Buffer.from([7, 8, 9]);
    cap.push(0, a);
    cap.push(20, b);
    cap.push(40, c);

    const snap = cap.snapshot();
    expect(snap.frames).toEqual([
      { t_ms: 0, byte_offset: 0, byte_length: 4 },
      { t_ms: 20, byte_offset: 4, byte_length: 2 },
      { t_ms: 40, byte_offset: 6, byte_length: 3 },
    ]);
    expect(snap.pcm).toEqual(Buffer.concat([a, b, c]));
    expect(snap.truncated).toBe(false);
    expect(snap.total_bytes_received).toBe(9);
  });

  it('truncates once the byte cap is reached: later frames are dropped from pcm/frames but total_bytes_received keeps counting', () => {
    const cap = createAgentAudioCapture(10); // tiny cap for the test
    cap.push(0, Buffer.alloc(6, 1));
    cap.push(20, Buffer.alloc(6, 2)); // would push bytesStored to 12 > 10 -- dropped
    cap.push(40, Buffer.alloc(4, 3)); // still dropped, capture already truncated

    const snap = cap.snapshot();
    expect(snap.frames).toEqual([{ t_ms: 0, byte_offset: 0, byte_length: 6 }]);
    expect(snap.pcm.length).toBe(6);
    expect(snap.truncated).toBe(true);
    expect(snap.total_bytes_received).toBe(16); // 6 + 6 + 4, everything that "arrived"
  });

  it('a frame that exactly fills the remaining cap is kept, not dropped', () => {
    const cap = createAgentAudioCapture(10);
    cap.push(0, Buffer.alloc(6, 1));
    cap.push(20, Buffer.alloc(4, 2)); // exactly fills to 10 -- kept
    cap.push(40, Buffer.alloc(1, 3)); // now dropped

    const snap = cap.snapshot();
    expect(snap.frames.length).toBe(2);
    expect(snap.pcm.length).toBe(10);
    expect(snap.truncated).toBe(true);
    expect(snap.total_bytes_received).toBe(11);
  });

  it('DEFAULT_MAX_CAPTURE_BYTES is 20 MB, matching the task brief cap', () => {
    expect(DEFAULT_MAX_CAPTURE_BYTES).toBe(20 * 1024 * 1024);
  });
});
