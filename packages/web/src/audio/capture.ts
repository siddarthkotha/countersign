// packages/web/src/audio/capture.ts
// Microphone capture: getUserMedia with echoCancellation/noiseSuppression/autoGainControl
// all on (BRIEF), an AudioContext driving the `countersign-capture` AudioWorkletProcessor
// (capture.worklet.ts), and a callback fed one base64-encoded 20 ms PCM16 24 kHz frame at a
// time -- the wire format `BrowserEvent` `{type:'audio', data}` expects. This file computes
// nothing about verdicts; it only captures and reshapes audio.
//
// The worklet module is loaded via the `?worker&url` import suffix (the brief's second
// option), NOT the bare `new URL('./capture.worklet.ts', import.meta.url)` pattern. Checked
// against Vite's own source (node_modules/vite/dist/node/chunks/config.js): the
// `new URL(..., import.meta.url)` auto-detection Vite applies for `new Worker(...)` is
// matched by a regex that requires the literal text `new Worker(` or `new SharedWorker(`
// immediately before it (`workerImportMetaUrlRE`) -- a bare `new URL(...)` handed to
// `audioWorklet.addModule()` is NOT caught by that plugin and would ship as raw,
// un-transpiled TypeScript in production (broken at runtime). The `?worker&url` suffix
// below goes through a different code path (`webWorkerPlugin`'s `workerOrSharedWorkerRE`
// handling) that really does run the referenced file through Vite/Rollup's full build --
// TS included -- and, because of the trailing `&url`, resolves to a plain URL string
// instead of constructing a `Worker`, which is exactly what `addModule()` needs. Verified
// by inspecting a real `npm run build:web` output: `capture.worklet.ts` appears as its own
// hashed chunk under `dist/assets/`, not inlined into the main bundle.
import captureWorkletUrl from './capture.worklet.ts?worker&url';

/** Compute RMS and peak level from PCM16 audio data (signed 16-bit integers in little-endian).
 *  Pure function suitable for unit testing without a real AudioContext.
 *  @param pcm16Buffer - ArrayBuffer or TypedArray containing PCM16 samples (2 bytes per sample)
 *  @returns { rms, peak } where rms and peak are in the range [0, 1], normalized by full-scale
 *           amplitude (32768 for 16-bit signed). Rounded to 4 decimals.
 */
export function computeRmsAndPeak(pcm16Buffer: ArrayBuffer | Uint8Array): { rms: number; peak: number } {
  // Convert to Uint8Array if needed
  const bytes = pcm16Buffer instanceof ArrayBuffer ? new Uint8Array(pcm16Buffer) : pcm16Buffer;

  // Read as PCM16 (little-endian), two bytes per sample
  const samples: number[] = [];
  for (let i = 0; i < bytes.length - 1; i += 2) {
    const low = bytes[i] ?? 0;
    const high = (bytes[i + 1] ?? 0) << 8;
    // Combine into signed 16-bit integer (using bitwise OR to handle sign extension)
    let sample = (high | low) as unknown as number;
    // JavaScript bitwise operations treat numbers as 32-bit, so convert back to signed 16-bit
    if (sample > 32767) sample -= 65536;
    samples.push(sample);
  }

  if (samples.length === 0) {
    return { rms: 0, peak: 0 };
  }

  // Normalize to [-1, 1] range (16-bit full scale is ±32768)
  const normalized = samples.map((s) => s / 32768);

  // Compute RMS
  const sumSquares = normalized.reduce((sum, s) => sum + s * s, 0);
  const rms = Math.sqrt(sumSquares / normalized.length);

  // Compute peak (maximum absolute value)
  const peak = Math.max(...normalized.map(Math.abs));

  // Round to 4 decimals
  return {
    rms: Math.round(rms * 10000) / 10000,
    peak: Math.round(peak * 10000) / 10000,
  };
}

export interface CaptureHandle {
  stop(): void;
}

export type MicLevelCallback = (
  tMs: number,
  rms: number,
  peak: number,
  trackSettings?: { echoCancellation?: boolean; noiseSuppression?: boolean; autoGainControl?: boolean; sampleRate?: number },
) => void;

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] ?? 0);
  return btoa(binary);
}

export async function startCapture(
  onFrame: (base64: string) => void,
  onLevel?: MicLevelCallback,
): Promise<CaptureHandle> {
  // https://www.assemblyai.com/docs/voice-agents/voice-agent-api/browser-integration
  // "Ask for the microphone with echoCancellation on and noiseSuppression off" (2026-09-21)
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true },
  });

  // Capture track settings to pass to onLevel callback on first call
  let trackSettings: { echoCancellation?: boolean; noiseSuppression?: boolean; autoGainControl?: boolean; sampleRate?: number } | undefined;
  const track = stream.getAudioTracks()[0];
  if (track && track.getSettings) {
    const settings = track.getSettings();
    trackSettings = {};
    if (settings.echoCancellation !== undefined) trackSettings.echoCancellation = settings.echoCancellation;
    if (settings.noiseSuppression !== undefined) trackSettings.noiseSuppression = settings.noiseSuppression;
    if (settings.autoGainControl !== undefined) trackSettings.autoGainControl = settings.autoGainControl;
    if (settings.sampleRate !== undefined) trackSettings.sampleRate = settings.sampleRate;
  }

  const audioContext = new AudioContext();
  await audioContext.audioWorklet.addModule(captureWorkletUrl);

  const source = audioContext.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(audioContext, 'countersign-capture');

  // Accumulate PCM samples for level calculation every 250 ms
  const levelIntervalMs = 250;
  const sampleRateHz = audioContext.sampleRate; // typically 48000
  const samplesPerInterval = Math.round((sampleRateHz / 1000) * levelIntervalMs); // e.g., 12000
  let sampleBuffer: number[] = [];
  let lastLevelCheckTime = Date.now();
  let levelCalled = false;

  node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
    onFrame(bufferToBase64(event.data));

    // If onLevel callback is registered, accumulate samples and compute levels
    if (onLevel) {
      const pcmData = event.data;
      const bytes = new Uint8Array(pcmData);

      // Extract samples from PCM16 data (2 bytes per sample, little-endian)
      for (let i = 0; i < bytes.length - 1; i += 2) {
        const low = bytes[i] ?? 0;
        const high = (bytes[i + 1] ?? 0) << 8;
        let sample = (high | low) as unknown as number;
        if (sample > 32767) sample -= 65536;
        sampleBuffer.push(sample);
      }

      // Check if enough time has passed to compute level
      const now = Date.now();
      if (now - lastLevelCheckTime >= levelIntervalMs) {
        if (sampleBuffer.length > 0) {
          // Compute RMS and peak from accumulated samples
          const normalized = sampleBuffer.map((s) => s / 32768);
          const sumSquares = normalized.reduce((sum, s) => sum + s * s, 0);
          const rms = Math.sqrt(sumSquares / normalized.length);
          const peak = Math.max(...normalized.map(Math.abs));

          const rmsRounded = Math.round(rms * 10000) / 10000;
          const peakRounded = Math.round(peak * 10000) / 10000;

          // t_ms is relative to when onFrame first ran (we use Date.now() as proxy)
          const tMs = now - lastLevelCheckTime;
          // Pass trackSettings on first call only
          if (!levelCalled) {
            onLevel(tMs, rmsRounded, peakRounded, trackSettings);
            levelCalled = true;
          } else {
            onLevel(tMs, rmsRounded, peakRounded);
          }
        }

        sampleBuffer = [];
        lastLevelCheckTime = now;
      }
    }
  };
  source.connect(node);

  return {
    stop() {
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      void audioContext.close();
    },
  };
}
