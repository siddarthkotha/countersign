import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { loadConfig } from './config.js';
import { createHttpServer } from './http.js';
import { createStaticServer } from './static.js';
import { reapIdle } from './caps.js';
import { attachWebSocketServer } from './ws/browser.js';
import { FakeAaiSocket } from './aai/fake.js';
import type { AaiEvent, AaiSocket } from './aai/types.js';
import { connectAai, type WsLike } from './aai/session.js';
import { loadAaiEnvDefaults, type AaiSessionConfig } from './aai/config.js';
import { allToolSchemas } from './aai/schemas.js';

// Task D1: packages/server/src/index.ts -> packages/web/dist (siblings under packages/),
// whether this file is running as source (tsx, packages/server/src/index.ts) or as the
// compiled build (packages/server/dist/index.js) -- both sit one directory under
// packages/server/, so '../../web/dist' resolves the same from either location.
const webDistDir = join(dirname(fileURLToPath(import.meta.url)), '../../web/dist');

const useFakeAai = process.env.COUNTERSIGN_FAKE_AAI === '1';

const loadedCfg = loadConfig(process.env);
// `canStartSession` (caps.ts, S1) gates /api/session/start on a real ASSEMBLYAI_API_KEY --
// correct for the live path, but it would also block the fake-AAI dev path from ever
// starting a session (nothing here ever mints a real token or dials AssemblyAI in fake
// mode, so no real key is needed). A dev-only placeholder satisfies that gate without
// touching the gate's own logic or affecting a real deployment, where COUNTERSIGN_FAKE_AAI
// is never set.
const cfg = useFakeAai && !loadedCfg.assemblyai_api_key
  ? { ...loadedCfg, assemblyai_api_key: 'fake-aai-dev-mode' }
  : loadedCfg;

// CRITICAL 1 (final review): http.ts's `/end`/`/reset` need `attachWebSocketServer`'s own
// `endCall`, but `attachWebSocketServer` needs the `server` object `createHttpServer`
// returns -- a real circular dependency. This holder breaks it: `createHttpServer` gets a
// deps-level `endCall` that just forwards to whatever `endCallImpl` currently is (still null
// during the brief window before `attachWebSocketServer` runs below, which only matters if
// an HTTP request somehow arrived before that -- impossible here, since nothing calls
// `server.listen` until after both are wired).
let endCallImpl: ((session_id: string, reason: string) => boolean) | null = null;

const { server, state } = createHttpServer(cfg, {
  fetchImpl: fetch,
  now: () => Date.now(),
  randomId: () => randomUUID(),
  endCall: (id, reason) => (endCallImpl ? endCallImpl(id, reason) : false),
  // Mounted as the LAST fallback inside http.ts, after every API/WS route -- `available` is
  // false (so this never activates) unless `npm run build:web` has actually produced
  // packages/web/dist, which keeps plain `dev:server` (no build) working exactly as before.
  staticServer: createStaticServer(webDistDir),
});

// COUNTERSIGN_FAKE_AAI=1 (founder ruling, Task S2): every call session gets a scripted
// FakeAaiSocket instead of a real AssemblyAI connection, so `npm run dev:server` runs the
// whole stack (session start, caps, the WebSocket protocol, the engine on every event) with
// no ASSEMBLYAI_API_KEY set. It plays no script by itself -- it only answers what
// call/session.ts sends it (an initial session.update) -- driving one with real audio/tool
// events is a manual dev step.
//
// The real adapter (src/aai/session.ts, Task S3) plugs into this same `createAai` factory.
// `attachWebSocketServer` calls `createAai` synchronously and expects an `AaiSocket` back
// immediately (S2's design -- FakeAaiSocket is synchronous), but a real connection needs an
// async round trip (mint a token, open the socket, wait for session.ready). `PendingAaiSocket`
// below bridges that gap: it returns a real AaiSocket synchronously, queues anything sent to
// it before the real connection is ready, and forwards events once it is -- `call/session.ts`
// never has to know a real connect was still in flight underneath it.
let fakeFallbackWarned = false;

const DEFAULT_INITIAL_PROMPT =
  'You are Countersign, a calm verification voice for the Meridian Dynamics treasury desk. ' +
  'Wait for the caller to state their request.';

class PendingAaiSocket implements AaiSocket {
  private handlers: ((evt: AaiEvent) => void)[] = [];
  private queued: object[] = [];
  private real: AaiSocket | null = null;
  private closedBeforeReady = false;

  constructor(connecting: Promise<AaiSocket>) {
    connecting
      .then((real) => {
        if (this.closedBeforeReady) {
          real.close();
          return;
        }
        this.real = real;
        real.on((evt) => this.emit(evt));
        for (const msg of this.queued) real.send(msg);
        this.queued = [];
      })
      .catch((err: unknown) => {
        console.error('countersign: AssemblyAI connect failed:', err);
        this.emit({ type: 'session.error', code: 'connect_failed', message: String(err) });
      });
  }

  private emit(evt: AaiEvent): void {
    for (const h of this.handlers) h(evt);
  }

  send(msg: object): void {
    if (this.real) this.real.send(msg);
    else this.queued.push(msg);
  }

  on(handler: (evt: AaiEvent) => void): void {
    this.handlers.push(handler);
  }

  close(): void {
    if (this.real) this.real.close();
    else this.closedBeforeReady = true;
  }
}

function createAai(_session_id: string): AaiSocket {
  if (useFakeAai) return new FakeAaiSocket();

  if (!cfg.assemblyai_api_key) {
    if (!fakeFallbackWarned) {
      fakeFallbackWarned = true;
      console.warn(
        'countersign: no ASSEMBLYAI_API_KEY configured -- falling back to the fake AssemblyAI socket for this ' +
          'session. Set ASSEMBLYAI_API_KEY (or COUNTERSIGN_FAKE_AAI=1) for a real call.'
      );
    }
    return new FakeAaiSocket();
  }

  const envDefaults = loadAaiEnvDefaults(process.env);
  const aaiCfg: AaiSessionConfig = {
    assemblyai_api_key: cfg.assemblyai_api_key,
    session_cap_seconds: cfg.session_cap_seconds,
    voice: envDefaults.voice,
    system_prompt: DEFAULT_INITIAL_PROMPT,
    tools: allToolSchemas(),
    keyterms: [],
    // exactOptionalPropertyTypes: only set the key at all when a model was actually
    // configured -- envDefaults.llm_model is `string | undefined`, and assigning
    // `undefined` explicitly to an optional prop is a different (rejected) thing from
    // omitting it.
    ...(envDefaults.llm_model ? { llm_model: envDefaults.llm_model } : {}),
  };

  const connecting = connectAai(aaiCfg, {
    fetchImpl: fetch,
    WebSocketImpl: WebSocket as unknown as new (url: string) => WsLike,
    now: () => Date.now(),
  });

  return new PendingAaiSocket(connecting);
}

const { endCall } = attachWebSocketServer(server, {
  caps: state,
  now: () => Date.now(),
  createAai,
  // Task R1 fix round 1: without this, a dropped browser socket always got the deps-level
  // default (ws/browser.ts's DEFAULT_BROWSER_GRACE_MS) regardless of what an operator set
  // for COUNTERSIGN_BROWSER_GRACE_MS -- the env var parsed into `cfg` but was never actually
  // read anywhere.
  browser_grace_ms: cfg.browser_grace_ms,
  // CRITICAL 1 (final review): same class of bug as browser_grace_ms above -- the per-call
  // cap timer needs the real configured cap, not ws/browser.ts's own deps-level default.
  session_cap_seconds: cfg.session_cap_seconds,
});
endCallImpl = endCall;

// CRITICAL 1 (final review): `reapIdle`'s returned ids used to be discarded here -- the idle
// reaper freed the CAPS slot (inside `reapIdle` itself) but never actually ended the live
// call it belonged to, so an AssemblyAI socket (and its meter) could keep running past its
// own idle timeout. Now every id it returns gets a real `endCall`.
setInterval(() => {
  const idle = reapIdle(state, cfg, Date.now());
  for (const id of idle) endCall(id, 'idle_timeout');
}, 5000).unref();

if (useFakeAai) {
  console.log('COUNTERSIGN_FAKE_AAI=1 -- call sessions use a scripted fake AssemblyAI socket, no API key required');
}

// Task D1: bind 0.0.0.0 explicitly -- Render (and most PaaS hosts) route inbound traffic to
// the container's external interface, not just loopback, so an implicit default host is the
// wrong thing to rely on for the always-on deploy target.
server.listen(cfg.port, '0.0.0.0', () => {
  console.log(`countersign server listening on :${cfg.port}`);
});
