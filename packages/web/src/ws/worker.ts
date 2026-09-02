// packages/web/src/ws/worker.ts
// The WebSocket lives here, in a dedicated Web Worker, off the React thread (BRIEF
// engineering law h). Forwards `BrowserEvent`s posted from the main thread to the socket
// immediately; `state` `ServerEvent`s coming back are coalesced to at most one postMessage
// per STATE_THROTTLE_MS (~15 fps) -- a client-side belt-and-suspenders on top of the
// server's own throttle (packages/server/src/ws/browser.ts, same 66 ms window) -- while
// `audio`/`flush`/`ended` are posted to the main thread the instant they arrive, since those
// are timing-sensitive (flush is how barge-in is won, BRIEF law a).
//
// Task R1 (browser reconnect): an unexpected socket close (the wifi blip, not an explicit
// `end`) does NOT end the call from the browser's point of view -- the AssemblyAI session
// and the evidence are still alive on the server (packages/server/src/ws/browser.ts's own
// grace window). `createConnection` retries the same `ws_path` with backoff
// (`RECONNECT_BACKOFF_MS`, ~7.5s total, well inside the server's default 20s grace),
// emitting `link:'lost'` the moment the drop is detected and `link:'restored'` the moment a
// retry succeeds; exhausting every retry emits `ended` with reason `link_lost` instead of
// looping forever. Audio capture (client.ts/capture.ts) is never told to stop during this --
// frames posted here while the socket is down are simply dropped, same as before this task,
// since there is nowhere for them to go.
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

/** The subset of the real `WebSocket` interface `createConnection` needs -- lets tests drive
 *  it with a plain object instead of a real socket/Worker context, same reason
 *  `createStateThrottle` above is exported standalone. */
export interface MinimalWebSocket {
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  readyState: number;
  send(data: string): void;
  close(): void;
}

export type WebSocketFactory = (url: string) => MinimalWebSocket;

/** ~7.5s total across four retries -- comfortably inside the server's default 20s browser
 *  grace window (COUNTERSIGN_BROWSER_GRACE_MS, packages/server/src/config.ts). */
export const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 4000];

/** Fix round 1: the `link` message posted from worker to main thread carries how many audio
 *  frames were dropped (capture kept running, nowhere to send them) during this down cycle
 *  -- a worker->main-thread-only detail, not part of the wire protocol between browser and
 *  server, so it's additive here rather than on the shared `ServerEvent` type. `dropped_frames`
 *  resets to 0 the moment a `restored` carries the count for its cycle. */
export type LinkPost = { type: 'link'; state: 'lost' | 'restored'; dropped_frames: number };

export interface ConnectionHandle {
  /** Forwards a BrowserEvent to the live socket; silently dropped while the link is down --
   *  there is nowhere for it to go (capture itself never stops running). */
  send(msg: object): void;
  /** The caller is ending the call on purpose (`{type:'end'}`, or the socket close that
   *  follows it) -- no reconnect should be attempted once the socket this closes. */
  markIntentionalClose(): void;
}

/** Owns one call's socket lifecycle, including reconnect-with-backoff on an unexpected drop.
 *  Pulled out of the dedicated-worker-scope block below (same reason `createStateThrottle`
 *  is standalone) so tests can drive it with a fake `WebSocketFactory` and fake timers
 *  instead of a real Worker/socket context. */
export function createConnection(
  ws_path: string,
  post: Poster,
  wsFactory: WebSocketFactory,
  backoffMs: number[] = RECONNECT_BACKOFF_MS,
): ConnectionHandle {
  let socket: MinimalWebSocket | null = null;
  let intentionalClose = false;
  let attempt = 0;
  let droppedFrames = 0;
  const throttledPost = createStateThrottle(post);

  function open(): void {
    const s = wsFactory(ws_path);
    socket = s;
    s.onmessage = (ev: { data: string }) => {
      const parsed = JSON.parse(ev.data) as ServerEvent;
      // The server ending the call legitimately (idle timeout, cap reached, an AAI error, a
      // completed replay, ...) is not a dropped link -- the socket closing right after this
      // is expected, not something to retry.
      if (parsed.type === 'ended') intentionalClose = true;
      throttledPost(parsed);
    };
    s.onopen = () => {
      if (attempt > 0) {
        const restored: LinkPost = { type: 'link', state: 'restored', dropped_frames: droppedFrames };
        post(restored);
        droppedFrames = 0;
      }
      attempt = 0;
    };
    s.onclose = () => {
      socket = null;
      if (intentionalClose) return;
      if (attempt === 0) {
        const lost: LinkPost = { type: 'link', state: 'lost', dropped_frames: droppedFrames };
        post(lost);
      }
      retry();
    };
  }

  function retry(): void {
    if (attempt >= backoffMs.length) {
      post({ type: 'ended', reason: 'link_lost' });
      return;
    }
    const delay = backoffMs[attempt]!;
    attempt += 1;
    setTimeout(open, delay);
  }

  open();

  return {
    send(msg: object) {
      if (socket && socket.readyState === 1 /* OPEN -- avoids depending on a global WebSocket in this otherwise-portable function */) {
        socket.send(JSON.stringify(msg));
        return;
      }
      // Capture keeps running while the link is down (this task never tells it to stop) --
      // an audio frame posted here has nowhere to go and is counted, not silently vanished.
      if ((msg as { type?: unknown }).type === 'audio') droppedFrames += 1;
    },
    markIntentionalClose() {
      intentionalClose = true;
      socket?.close();
    },
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
  let connection: ConnectionHandle | null = null;
  const post: Poster = (e) => self.postMessage(e);
  const wsFactory: WebSocketFactory = (url) => new WebSocket(url) as unknown as MinimalWebSocket;

  self.onmessage = (event: MessageEvent<ConnectMessage | BrowserEvent>) => {
    const msg = event.data;

    if (isConnectMessage(msg)) {
      connection = createConnection(msg.ws_path, post, wsFactory);
      return;
    }

    if (msg.type === 'end') connection?.markIntentionalClose();

    // A BrowserEvent posted before the socket finishes opening -- or while a reconnect is
    // in progress -- is silently dropped here (no queue): W3 (live call screen) is
    // responsible for not starting capture until `connect()`'s socket is open, and capture
    // itself never stops just because the link did (frames posted while it's down have
    // nowhere to go).
    connection?.send(msg);
  };
}
