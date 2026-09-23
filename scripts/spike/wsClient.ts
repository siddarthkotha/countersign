// scripts/spike/wsClient.ts
// SPIKE-ONLY. Minimal WS wrapper around AssemblyAI's Voice Agent socket using Node's native
// global WebSocket (stable since Node 22; this repo runs Node 24). Deliberately standalone
// (not importing packages/server/src/aai/session.ts) per the spike's file-isolation rule --
// but the connect shape (wss://agents.assemblyai.com/v1/ws?token=<token>) is PROVEN from that
// file (openSocket(), line ~153: `new WebSocketImpl(\`${WS_URL}?token=${token}\`)`), and the
// agent_id-bind shape is PROVEN from docs/round2/deploy.txt ("Send one session.update with
// the agent_id and nothing else ... { "type":"session.update","session":{"agent_id":"..."} }").
import { log, nowIso } from './lib.js';

const WS_URL = 'wss://agents.assemblyai.com/v1/ws';

export interface AaiWireEvent {
  type: string;
  [k: string]: unknown;
}

export interface SpikeSession {
  ws: WebSocket;
  sessionId: string | null;
  events: Array<{ at: string; event: AaiWireEvent }>;
  send: (msg: Record<string, unknown>) => void;
  sendAudioFrame: (base64Pcm: string) => void;
  /** `sinceIndex` (default 0): only considers events at this index in `session.events` or
   *  later -- both for an already-arrived match AND future ones. Without this, a predicate
   *  like `e.type === 'reply.done'` can resolve INSTANTLY against a stale event from an
   *  earlier turn (e.g. the connect-time greeting's own reply.done) instead of the new
   *  turn's event -- exactly the bug this spike hit on its first live G1 run (2026-09-22,
   *  scripts/spike/logs/spike-2026-09-23T00-58-36-707Z.jsonl: G1's waitFor(reply.done)
   *  resolved against the greeting's INTERRUPTED reply.done, not the canned-line reply).
   *  Callers should snapshot `session.events.length` right before triggering a turn and
   *  pass it here. */
  waitFor: (predicate: (e: AaiWireEvent) => boolean, timeoutMs?: number, sinceIndex?: number) => Promise<AaiWireEvent>;
  close: () => void;
  closed: Promise<{ code: number; reason: string }>;
  tag: string;
}

/** Connects, sends the FIRST session.update binding `agent_id` (mutually exclusive with
 *  inline fields per the docs quoted above), and resolves once `session.ready` arrives.
 *  `tag` is just a label for this spike's own logs (e.g. "main", "g5-a", "g5-b") -- not
 *  anything sent on the wire. */
export async function connectStoredAgent(opts: {
  token: string;
  agentId: string;
  tag: string;
  readyTimeoutMs?: number;
}): Promise<SpikeSession> {
  const ws = new WebSocket(`${WS_URL}?token=${opts.token}`);
  const events: Array<{ at: string; event: AaiWireEvent }> = [];
  const waiters: Array<{ predicate: (e: AaiWireEvent) => boolean; resolve: (e: AaiWireEvent) => void; timer: ReturnType<typeof setTimeout>; sinceIndex: number }> = [];
  let closedResolve!: (v: { code: number; reason: string }) => void;
  const closed = new Promise<{ code: number; reason: string }>((r) => (closedResolve = r));

  ws.addEventListener('message', (ev: MessageEvent) => {
    let parsed: AaiWireEvent | null = null;
    try {
      parsed = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
    } catch {
      return;
    }
    if (!parsed) return;
    const rec = { at: nowIso(), event: parsed };
    events.push(rec);
    // Don't log full reply.audio payloads (base64 audio bytes) verbatim -- record length only,
    // everything else logs in full (this is not a secret, just noise-control for the jsonl).
    const toLog =
      parsed.type === 'reply.audio' && typeof parsed.data === 'string'
        ? { ...parsed, data: `(base64 pcm, ${(parsed.data as string).length} chars)` }
        : parsed;
    void log({ kind: 'ws_event', tag: opts.tag, event: toLog });
    const thisIndex = events.length - 1;
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (thisIndex >= waiters[i].sinceIndex && waiters[i].predicate(parsed)) {
        clearTimeout(waiters[i].timer);
        waiters[i].resolve(parsed);
        waiters.splice(i, 1);
      }
    }
  });
  ws.addEventListener('close', (ev: CloseEvent) => {
    void log({ kind: 'ws_close', tag: opts.tag, code: ev.code, reason: ev.reason });
    closedResolve({ code: ev.code, reason: ev.reason });
  });
  ws.addEventListener('error', (ev: Event) => {
    void log({ kind: 'ws_error', tag: opts.tag, message: String(ev) });
  });

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`connectStoredAgent[${opts.tag}]: open timeout`)), 8000);
    ws.addEventListener('open', () => {
      clearTimeout(t);
      resolve();
    });
    ws.addEventListener('error', () => {
      clearTimeout(t);
      reject(new Error(`connectStoredAgent[${opts.tag}]: open error`));
    });
  });

  function send(msg: Record<string, unknown>): void {
    void log({ kind: 'ws_send', tag: opts.tag, msg });
    ws.send(JSON.stringify(msg));
  }

  function waitFor(predicate: (e: AaiWireEvent) => boolean, timeoutMs = 15000, sinceIndex = 0): Promise<AaiWireEvent> {
    // Check history first, but ONLY from sinceIndex forward -- an event before that index is
    // stale (a prior turn's event, e.g. the connect-time greeting's reply.done) and must
    // never satisfy a wait for the CURRENT turn's event. See the doc comment on
    // SpikeSession.waitFor above for why this matters.
    const already = events.slice(sinceIndex).find((r) => predicate(r.event));
    if (already) return Promise.resolve(already.event);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error(`connectStoredAgent[${opts.tag}]: waitFor timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      waiters.push({ predicate, resolve, timer, sinceIndex });
    });
  }

  const initialUpdate = { type: 'session.update', session: { agent_id: opts.agentId } };
  send(initialUpdate);

  const ready = await waitFor((e) => e.type === 'session.ready' || e.type === 'session.error', opts.readyTimeoutMs ?? 15000);
  if (ready.type === 'session.error') {
    throw new Error(`connectStoredAgent[${opts.tag}]: session.error before ready: ${JSON.stringify(ready)}`);
  }
  const sessionId = (ready.session_id as string) ?? null;

  return {
    ws,
    sessionId,
    events,
    send,
    sendAudioFrame: (base64Pcm: string) => {
      ws.send(JSON.stringify({ type: 'input.audio', audio: base64Pcm }));
    },
    waitFor,
    close: () => {
      try {
        ws.close();
      } catch {
        // already closed
      }
    },
    closed,
    tag: opts.tag,
  };
}

/** Streams pre-chunked 20ms PCM16 frames at (approximately) real time -- same cadence the
 *  real browser worklet uses (scripts/rehearse/audio.ts, FRAME_MS = 20). */
export async function streamFrames(session: SpikeSession, frames: Buffer[]): Promise<void> {
  for (const frame of frames) {
    session.sendAudioFrame(frame.toString('base64'));
    await new Promise((r) => setTimeout(r, 20));
  }
}
