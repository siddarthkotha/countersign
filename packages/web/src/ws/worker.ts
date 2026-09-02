// packages/web/src/ws/worker.ts
// The WebSocket lives here, in a dedicated Web Worker, off the React thread (BRIEF
// engineering law h). Forwards `BrowserEvent`s posted from the main thread to the socket
// immediately; `state` `ServerEvent`s coming back are coalesced to at most one postMessage
// per STATE_THROTTLE_MS (~15 fps) -- a client-side belt-and-suspenders on top of the
// server's own throttle (packages/server/src/ws/browser.ts, same 66 ms window) -- while
// `audio`/`flush`/`ended` are posted to the main thread the instant they arrive, since those
// are timing-sensitive (flush is how barge-in is won, BRIEF law a).
//
// Entry point: instantiated by client.ts via
// `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`. The main
// thread kicks off the connection with a `{ type: '__connect', ws_path }` message (this is
// not a `BrowserEvent` -- it never reaches the socket); every other posted message is a
// `BrowserEvent` and is forwarded to the socket verbatim.
import type { BrowserEvent, ServerEvent } from '@countersign/engine';

export const STATE_THROTTLE_MS = 66;

export type Poster = (e: ServerEvent) => void;

/** Pure, timer-driven throttle -- exported standalone so tests can drive it with fake
 *  timers without needing a real Worker/WebSocket context. Mirrors the server's
 *  `makeThrottledSender` exactly: only `state` events coalesce; everything else posts
 *  immediately. */
export function createStateThrottle(post: Poster, intervalMs: number = STATE_THROTTLE_MS): Poster {
  let lastSentAt = -Infinity;
  let pending: ServerEvent | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function flushPending(): void {
    timer = null;
    if (pending) {
      lastSentAt = Date.now();
      post(pending);
      pending = null;
    }
  }

  return (e: ServerEvent) => {
    if (e.type !== 'state') {
      post(e);
      return;
    }
    const now = Date.now();
    if (now - lastSentAt >= intervalMs) {
      lastSentAt = now;
      pending = null;
      post(e);
      return;
    }
    pending = e;
    if (!timer) {
      timer = setTimeout(flushPending, intervalMs - (now - lastSentAt));
    }
  };
}

type ConnectMessage = { type: '__connect'; ws_path: string };

function isConnectMessage(msg: unknown): msg is ConnectMessage {
  return typeof msg === 'object' && msg !== null && (msg as { type?: unknown }).type === '__connect';
}

// Only wires up a real socket when actually running inside a dedicated Worker (this module
// is also imported directly by tests, under jsdom, purely for `createStateThrottle` --
// jsdom always defines `window`, which a real dedicated Worker global scope never has).
function isDedicatedWorkerScope(): boolean {
  return (
    typeof window === 'undefined' &&
    typeof self !== 'undefined' &&
    typeof (self as unknown as { postMessage?: unknown }).postMessage === 'function'
  );
}

if (isDedicatedWorkerScope()) {
  let socket: WebSocket | null = null;
  const post: Poster = (e) => self.postMessage(e);
  const throttledPost = createStateThrottle(post);

  self.onmessage = (event: MessageEvent<ConnectMessage | BrowserEvent>) => {
    const msg = event.data;

    if (isConnectMessage(msg)) {
      socket = new WebSocket(msg.ws_path);
      socket.onmessage = (ev: MessageEvent<string>) => {
        const parsed = JSON.parse(ev.data) as ServerEvent;
        throttledPost(parsed);
      };
      socket.onclose = () => {
        throttledPost({ type: 'ended', reason: 'socket_closed' });
      };
      return;
    }

    // A BrowserEvent posted before the socket finishes opening is silently dropped here
    // (no queue) -- W3 (live call screen) is responsible for not starting capture until
    // `connect()`'s socket is open, or for buffering frames itself if that ordering can't
    // be guaranteed.
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  };
}
