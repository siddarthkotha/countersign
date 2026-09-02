// packages/web/src/ws/client.ts
// Main-thread wrapper around the Web Worker that owns the socket (worker.ts). Nothing here
// touches the worker's postMessage protocol directly outside this file: CallView/Replay get
// typed callbacks instead. `connect` also wires the plumbing a live call needs: capture ->
// send audio, playback <- audio frames, flush -> playback.flush() (the barge-in mechanism,
// BRIEF engineering law a). This file computes nothing about verdicts; it only relays.
import type { BrowserEvent, ScreenState, ServerEvent } from '@countersign/engine';
import { startCapture, type CaptureHandle } from '../audio/capture';
import { createPlayback, type PlaybackHandle } from '../audio/playback';
import type { LinkPost } from './worker';

export interface CallClient {
  send(e: BrowserEvent): void;
  onState(cb: (state: ScreenState) => void): void;
  onAudio(cb: (base64: string) => void): void;
  onFlush(cb: () => void): void;
  onEnded(cb: (reason: string) => void): void;
  /** Task R1: the browser<->server link dropped or was re-established while the call itself
   *  kept running server-side. Never fires for a legitimate call end -- that's `onEnded`.
   *  IMPORTANT 2 (final review): `leg` says WHICH transport dropped -- `'browser'` (this
   *  client's own WebSocket to our server, detected by src/ws/worker.ts's own reconnect
   *  logic) or `'aai'` (server<->AssemblyAI, merely forwarded through unchanged). The two
   *  used to be indistinguishable on screen; Call.tsx now shows a different status line for
   *  each. */
  onLink(cb: (leg: 'browser' | 'aai', state: 'lost' | 'restored') => void): void;
  close(): void;
}

export type WorkerFactory = () => Worker;

const defaultWorkerFactory: WorkerFactory = () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

/** Bare `postMessage`/`onmessage` wrapper -- no audio wiring, no capture/playback. `connect`
 *  (below) is what CallView/Replay actually use; this is exported for Replay, which has no
 *  microphone to capture and drives playback/transcript purely from received ServerEvents. */
export function connectSocketOnly(ws_path: string, workerFactory: WorkerFactory = defaultWorkerFactory): CallClient {
  const worker = workerFactory();

  let stateCb: ((state: ScreenState) => void) | null = null;
  let audioCb: ((data: string) => void) | null = null;
  let flushCb: (() => void) | null = null;
  let endedCb: ((reason: string) => void) | null = null;
  let linkCb: ((leg: 'browser' | 'aai', state: 'lost' | 'restored') => void) | null = null;

  // IMPORTANT 2 (final review): the worker posts either an ordinary `ServerEvent` (relayed
  // verbatim from the server -- a `link` one carries `leg:'aai'` for an AAI-transport drop)
  // or its own `LinkPost` (worker.ts's own browser<->server socket dropping, always
  // `leg:'browser'`) -- both are `{type:'link', state, leg, ...}` shaped, so one check covers
  // either origin.
  worker.onmessage = (event: MessageEvent<ServerEvent | LinkPost>) => {
    const msg = event.data;
    if (msg.type === 'state') stateCb?.(msg.state);
    else if (msg.type === 'audio') audioCb?.(msg.data);
    else if (msg.type === 'flush') flushCb?.();
    else if (msg.type === 'ended') endedCb?.(msg.reason);
    else if (msg.type === 'link') linkCb?.(msg.leg, msg.state);
  };

  worker.postMessage({ type: '__connect', ws_path });

  return {
    send(e: BrowserEvent) {
      worker.postMessage(e);
    },
    onState(cb) {
      stateCb = cb;
    },
    onAudio(cb) {
      audioCb = cb;
    },
    onFlush(cb) {
      flushCb = cb;
    },
    onEnded(cb) {
      endedCb = cb;
    },
    onLink(cb) {
      linkCb = cb;
    },
    close() {
      worker.postMessage({ type: 'end' } satisfies BrowserEvent);
      worker.terminate();
    },
  };
}

/** The live-call wiring: mic capture -> send audio; received audio -> playback; flush ->
 *  playback.flush(). Requires a real AudioContext (never constructed under jsdom -- W3
 *  wires this into the live call screen and is the only caller that needs it). */
export async function connect(
  ws_path: string,
  audioContext: AudioContext,
  workerFactory: WorkerFactory = defaultWorkerFactory,
): Promise<CallClient & { capture: CaptureHandle; playback: PlaybackHandle }> {
  const client = connectSocketOnly(ws_path, workerFactory);
  const playback = createPlayback(audioContext);

  client.onAudio((data) => playback.push(data));
  client.onFlush(() => playback.flush());

  const capture = await startCapture((base64) => {
    client.send({ type: 'audio', data: base64 });
  });

  return {
    ...client,
    capture,
    playback,
    close() {
      capture.stop();
      playback.close();
      client.close();
    },
  };
}
