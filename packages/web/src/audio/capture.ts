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

export interface CaptureHandle {
  stop(): void;
}

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] ?? 0);
  return btoa(binary);
}

export async function startCapture(onFrame: (base64: string) => void): Promise<CaptureHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });

  const audioContext = new AudioContext();
  await audioContext.audioWorklet.addModule(captureWorkletUrl);

  const source = audioContext.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(audioContext, 'countersign-capture');
  node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
    onFrame(bufferToBase64(event.data));
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
