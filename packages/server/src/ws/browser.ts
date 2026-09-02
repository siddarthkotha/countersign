// packages/server/src/ws/browser.ts
// The browser protocol: `/ws/call/:id` (only ids `createHttpServer`'s /api/session/start
// actually minted -- an unrecognized id gets a clean 4404 close, never a live session) and
// `/ws/replay/:file` (a corpus file streamed as the same ServerEvent shape, no AAI, no
// audio, no caps session). Reuses the http.ts server for the WebSocket upgrade and the
// CapsState it returned, per the plan ("the server is the only authority" -- this file owns
// no state of its own beyond per-connection throttling).
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { MERIDIAN, mockToolResult } from '@countersign/engine';
import type { BrowserEvent, CallContext, SeedConfig, ServerEvent } from '@countersign/engine';
import { endSession, touch, type CapsState } from '../caps.js';
import type { AaiSocket } from '../aai/types.js';
import { CallSession } from '../call/session.js';
import { defaultCorpusDir, loadCorpusFile, runReplay } from '../replay.js';

const STATE_THROTTLE_MS = 66;

export interface BrowserWsDeps {
  caps: CapsState;
  now: () => number;
  /** Creates the AAI connection for one call session. index.ts supplies a `FakeAaiSocket`
   *  factory under `COUNTERSIGN_FAKE_AAI=1`; the real adapter (S3) plugs in here too. */
  createAai: (session_id: string) => AaiSocket;
  seed?: SeedConfig;
  corpusDir?: string;
  /** How to build the (currently fixed, simulated) telephony context for a call. Scenario
   *  selection (Dana vs. "Robert Miller") is a later task's concern -- S2 just needs
   *  somewhere honest to put a default rather than inventing one inline. */
  buildCallContext?: (session_id: string) => CallContext;
}

function defaultCallContext(session_id: string): CallContext {
  return { session_id, origin_kind: 'unverified_voip', origin_geo: 'unknown' };
}

function safeSend(ws: WebSocket, msg: object): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

/** Coalesces `state` ServerEvents to at most one send per STATE_THROTTLE_MS: a burst of
 *  rapid state changes results in one send carrying the latest state, not one send per
 *  change. Every other ServerEvent type (audio, flush, ended) is timing-sensitive and
 *  always sent immediately. */
function makeThrottledSender(ws: WebSocket): (e: ServerEvent) => void {
  let lastStateSentAt = -Infinity;
  let pendingState: ServerEvent | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function flushPending(): void {
    timer = null;
    if (pendingState) {
      lastStateSentAt = Date.now();
      safeSend(ws, pendingState);
      pendingState = null;
    }
  }

  return (e: ServerEvent) => {
    if (e.type !== 'state') {
      safeSend(ws, e);
      return;
    }
    const now = Date.now();
    if (now - lastStateSentAt >= STATE_THROTTLE_MS) {
      lastStateSentAt = now;
      pendingState = null;
      safeSend(ws, e);
      return;
    }
    pendingState = e;
    if (!timer) {
      timer = setTimeout(flushPending, STATE_THROTTLE_MS - (now - lastStateSentAt));
    }
  };
}

function handleCallSocket(ws: WebSocket, session_id: string, deps: BrowserWsDeps): void {
  if (!deps.caps.active.has(session_id)) {
    ws.close(4404, 'unknown session');
    return;
  }

  const seed = deps.seed ?? MERIDIAN;
  const call = (deps.buildCallContext ?? defaultCallContext)(session_id);
  const send = makeThrottledSender(ws);

  let aai: AaiSocket;
  try {
    aai = deps.createAai(session_id);
  } catch {
    ws.close(4500, 'aai unavailable');
    return;
  }

  const session = new CallSession({
    session_id,
    seed,
    call,
    aai,
    now: deps.now,
    onServerEvent: send,
    mock: mockToolResult,
  });

  ws.on('message', (data) => {
    touch(deps.caps, session_id, deps.now());
    let msg: BrowserEvent;
    try {
      msg = JSON.parse(data.toString()) as BrowserEvent;
    } catch {
      return;
    }
    session.handleBrowser(msg);
  });

  ws.on('close', () => {
    session.end('browser_closed');
    endSession(deps.caps, session_id);
  });
}

function handleReplaySocket(ws: WebSocket, file: string, speedParam: string | null, deps: BrowserWsDeps): void {
  const corpusDir = deps.corpusDir ?? defaultCorpusDir();
  const corpus = loadCorpusFile(corpusDir, file);
  if (!corpus) {
    ws.close(4404, 'unknown replay file');
    return;
  }

  const parsedSpeed = speedParam ? Number(speedParam) : 1;
  const speed = Number.isFinite(parsedSpeed) && parsedSpeed > 0 ? parsedSpeed : 1;

  runReplay(corpus, {
    session_id: `replay-${file}`,
    speed,
    send: (e) => safeSend(ws, e),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  })
    .then(() => safeSend(ws, { type: 'ended', reason: 'replay_complete' }))
    .catch(() => {
      // A replay that errors mid-stream still leaves the socket open with whatever state
      // it already sent; there is no live call underneath it to tear down.
    });
}

export function attachWebSocketServer(server: Server, deps: BrowserWsDeps): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://internal');
    const callMatch = /^\/ws\/call\/([^/]+)$/.exec(url.pathname);
    const replayMatch = /^\/ws\/replay\/([^/]+)$/.exec(url.pathname);

    if (callMatch) {
      const id = decodeURIComponent(callMatch[1]!);
      wss.handleUpgrade(req, socket, head, (ws) => handleCallSocket(ws, id, deps));
      return;
    }
    if (replayMatch) {
      const file = decodeURIComponent(replayMatch[1]!);
      const speed = url.searchParams.get('speed');
      wss.handleUpgrade(req, socket, head, (ws) => handleReplaySocket(ws, file, speed, deps));
      return;
    }

    // Anything else -- including a path a leading ".." collapsed entirely out of the URL's
    // normalized pathname (e.g. "/ws/replay/.." -> "/ws/") -- gets a real WS handshake
    // followed by a clean 4404 close, rather than a raw socket.destroy(): a consistent,
    // testable rejection instead of one whose shape depends on how far URL normalization
    // happened to collapse a given traversal attempt.
    wss.handleUpgrade(req, socket, head, (ws) => ws.close(4404, 'not found'));
  });
}
