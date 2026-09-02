// packages/web/src/audio/capture.worklet.ts
// AudioWorkletProcessor 'countersign-capture': runs on the audio render thread (off the
// main/React thread by construction -- this is a worklet, not even the same thread as the
// Web Worker that owns the socket). Downsamples whatever native sample rate the browser's
// AudioContext is running at (commonly 48000 Hz) to the wire format AssemblyAI expects --
// 24000 Hz mono PCM16 -- and posts one 20 ms frame (480 samples = 960 bytes) at a time to
// the main thread via `port.postMessage`. This file computes NOTHING about verdicts: it
// only reshapes audio.
//
// Loaded via `audioContext.audioWorklet.addModule(new URL('./capture.worklet.ts',
// import.meta.url))` from capture.ts -- see that file's header comment for why this works
// under Vite without a separate build step.

const TARGET_SAMPLE_RATE = 24000;
const FRAME_MS = 20;
const FRAME_SAMPLES = (TARGET_SAMPLE_RATE * FRAME_MS) / 1000; // 480

function floatToInt16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
}

class CaptureProcessor extends AudioWorkletProcessor {
  private readonly ratio: number;
  private carry = 0; // fractional source-sample position carried between process() calls
  private readonly pending: number[] = []; // buffered Int16 samples at the target rate

  constructor() {
    super();
    // `sampleRate` is a global provided by the AudioWorkletGlobalScope -- the context's
    // native rate, not the target rate.
    this.ratio = sampleRate / TARGET_SAMPLE_RATE;
  }

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (!channel || channel.length === 0) return true;

    // Nearest-neighbour downsample: walk the target-rate timeline in source-rate steps.
    // Good enough for behavioural-verification speech audio; a proper anti-aliasing
    // filter is out of scope (BRIEF LAW 5 -- no acoustic processing beyond what the wire
    // format requires).
    let pos = this.carry;
    while (pos < channel.length) {
      const idx = Math.min(channel.length - 1, Math.round(pos));
      this.pending.push(floatToInt16(channel[idx] ?? 0));
      pos += this.ratio;
    }
    this.carry = pos - channel.length;

    while (this.pending.length >= FRAME_SAMPLES) {
      const frameSamples = this.pending.splice(0, FRAME_SAMPLES);
      const pcm = new Int16Array(frameSamples);
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }

    return true;
  }
}

registerProcessor('countersign-capture', CaptureProcessor);
