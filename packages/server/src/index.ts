import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { loadConfig } from './config.js';
import { createHttpServer } from './http.js';
import { createStaticServer } from './static.js';
import { reapIdle, markLiveCallsUnavailable, recordMintSuccess } from './caps.js';
import { newDiagnosticsState, recordServerEvent, recordTerminationEvent } from './diagnostics.js';
import { attachWebSocketServer } from './ws/browser.js';
import { FakeAaiSocket } from './aai/fake.js';
import type { AaiEvent, AaiSocket } from './aai/types.js';
import { connectAai, type WsLike } from './aai/session.js';
import { loadAaiEnvDefaults, LIVE_SESSION_TOOLS, DEFAULT_GREETING, type AaiSessionConfig } from './aai/config.js';
import { classifyMintFailure, isCreditsExhaustedError } from './live_calls.js';

// Task D1: packages/server/src/index.ts -> packages/web/dist (siblings under packages/),
// whether this file is running as source (tsx, packages/server/src/index.ts) or as the
// compiled build (packages/server/dist/index.js) -- both sit one directory under
// packages/server/, so '../../web/dist' resolves the same from either location.
const webDistDir = join(dirname(fileURLToPath(import.meta.url)), '../../web/dist');

// D1 fix round 1 #6: `npm run start:server` runs this compiled file through `tsx`
// (root package.json), not plain `node`, even though `build:server` already compiled it --
// that's not a leftover, it's required. `@countersign/engine`'s package.json exports a
// TypeScript source file (`./src/index.ts`) whose own internal relative imports omit file
// extensions (valid under this repo's "bundler" module resolution, but Node's native ESM
// loader has no bundler-style extension inference and throws ERR_MODULE_NOT_FOUND on it).
// `tsx` resolves that correctly, plain `node` does not -- verified live, both ways. Fixing
// packages/engine's imports is out of D1's scope (server-only task). The real fix, a week-2
// item: compile packages/engine too (its own tsconfig.build.json -> dist/, explicit .js
// extensions on the emitted relative imports) and point its package.json `exports` at the
// compiled output -- then `start:server` can run under plain `node` and `tsx` moves back to
// devDependencies. See docs/DEPLOY.md's "how it runs" note and task-D1-review.md finding #6.

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
// Same forward-reference shape as `endCallImpl` above, for the same circular-dependency
// reason -- the rehearsal-harness debug hook (COUNTERSIGN_DEBUG_HOOKS=1 only).
let dropAaiImpl: ((session_id: string) => boolean) | null = null;

// Flight recorder (founder's ask, 2026-09-02): ONE DiagnosticsState for the process's whole
// life, shared between http.ts's GET/POST .../diagnostics routes and ws/browser.ts's own
// writes into it -- same pattern as `state` (CapsState) just below.
const diagnostics = newDiagnosticsState();

const { server, state } = createHttpServer(cfg, {
  fetchImpl: fetch,
  now: () => Date.now(),
  randomId: () => randomUUID(),
  endCall: (id, reason) => (endCallImpl ? endCallImpl(id, reason) : false),
  dropAai: (id) => (dropAaiImpl ? dropAaiImpl(id) : false),
  // Mounted as the LAST fallback inside http.ts, after every API/WS route -- `available` is
  // false (so this never activates) unless `npm run build:web` has actually produced
  // packages/web/dist, which keeps plain `dev:server` (no build) working exactly as before.
  staticServer: createStaticServer(webDistDir),
  diagnostics,
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

// Founder ruling 2026-09-11: the agent speaks FIRST on every call via AssemblyAI's
// connect-time `greeting` field (aai/config.ts's DEFAULT_GREETING, set below in `aaiCfg`) --
// so this initial system prompt no longer tells the model to wait silently for an opening
// line that never comes from it; it tells the model the greeting already happened and the
// caller is expected to speak next. This prompt is only ever live for the brief window
// before the engine's first `evaluate()` tick replaces it with a goal-driven system_prompt
// (call/session.ts) -- it is never what actually decides when the model speaks.
const DEFAULT_INITIAL_PROMPT =
  'You are Countersign, a calm verification voice for the Meridian Dynamics treasury desk. ' +
  'You have already greeted the caller. Wait for them to state their request.';

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
        // Review fix (2026-09-11, CRITICAL finding): a successful connect breaks the
        // mint_error failure streak (caps.ts) -- otherwise sporadic failures separated by
        // real successes could still eventually accumulate toward the latch threshold.
        recordMintSuccess(state);
        this.real = real;
        real.on((evt) => this.emit(evt));
        for (const msg of this.queued) real.send(msg);
        this.queued = [];
      })
      .catch((err: unknown) => {
        console.error('countersign: AssemblyAI connect failed:', err);
        // Reviewer finding (2026-09-11, abuse-caps "credits-exhausted replay mode"): this
        // catch is the one place a real token-mint/connect failure is observed -- classify
        // it (live_calls.ts) and latch the result into caps state (caps.ts) so /health and
        // /api/session/start start reporting `live_calls.available: false` on the NEXT
        // request, instead of every future caller silently hitting this same failure one
        // at a time with no on-page explanation. `markLiveCallsUnavailable` itself decides
        // whether a `mint_error` classification actually latches yet (a streak+cool-down
        // gate, review fix 2026-09-11) -- `credits_exhausted` still latches immediately.
        markLiveCallsUnavailable(
          state,
          isCreditsExhaustedError(classifyMintFailure(err)) ? 'credits_exhausted' : 'mint_error',
          Date.now()
        );
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

function createAai(session_id: string): AaiSocket {
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
    // Bug fix (2026-09-03, founder-observed live run): the voice model is offered NO tool
    // schema, ever -- see fsm.ts's `allowedTools` and aai/config.ts's `LIVE_SESSION_TOOLS`
    // doc comments for the incident this closes (advertising the lookup tools' schemas
    // taught the model the `identity_id` field name, and it started asking the caller for
    // it). The server still runs every lookup and terminal action itself
    // (call/session.ts's runLookupsIfNeeded/runTerminalActionsIfNeeded) -- nothing here
    // changes what the server can do, only what it ever offers the model.
    tools: LIVE_SESSION_TOOLS,
    // Founder ruling 2026-09-11: the agent speaks first -- set once here, at the FIRST
    // connect only. `connectAai`'s resume path (aai/session.ts's `handleUnexpectedClose`)
    // never calls `buildInitialSessionUpdate` again on a drop -- it sends a bare
    // `{type:'session.resume', session_id}` on the new socket, so this greeting can never
    // be resent (and AssemblyAI would reject a resend as `immutable_field` if it were).
    greeting: DEFAULT_GREETING,
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
    // Flight recorder bug fix (2026-09-03): the one place a real connect is awaited --
    // records "AAI connected/ready" with the elapsed ms since this connect started, the
    // fact the live-call bundle previously had no way to show at all (see aai/session.ts's
    // `onReady` doc comment).
    onReady: (ms, greeting_configured) =>
      recordServerEvent(diagnostics, session_id, Date.now(), 'aai_ready', {
        ms_since_connect_start: ms,
        // Founder ruling 2026-09-11: proves in the raw bundle whether this call's connect
        // actually asked AssemblyAI to speak first.
        greeting_configured,
      }),
    // Defect 2 fix (2026-09-15): when close() times out waiting for AssemblyAI's own
    // session.ended Termination event, record aai_terminate_timeout so a bundle shows
    // the billing message never came back in time (see aai/session.ts's `onCloseTimeout`
    // doc comment for the reasoning).
    onCloseTimeout: () =>
      recordServerEvent(diagnostics, session_id, Date.now(), 'aai_terminate_timeout', {}),
    // Defect 2 fix (2026-09-15): every time a raw session.ended arrives, record its
    // top-level keys and numeric fields (no transcript text, no audio), so a bundle proves
    // what AssemblyAI sent for billing -- or that it sent nothing (aai_terminate_timeout
    // fired instead). Also, when the message carries numeric session_duration_seconds,
    // record aai_session_terminated with the billing fields and set billed_seconds on the
    // bundle, so a late-arriving message (after the browser hung up and ended the bundle)
    // still lands in the diagnostics.
    onSessionEnded: (msg) => {
      const detail: Record<string, unknown> = { keys: Object.keys(msg) };
      // Extract numeric fields (session_duration_seconds, audio_duration_seconds, timestamp)
      for (const key of Object.keys(msg)) {
        if (typeof msg[key] === 'number') {
          detail[key] = msg[key];
        }
      }
      recordServerEvent(diagnostics, session_id, Date.now(), 'aai_session_ended_raw', detail);
      // If this message carries billing data, record it as aai_session_terminated and set billed_seconds
      recordTerminationEvent(diagnostics, session_id, Date.now(), msg);
    },
  });

  return new PendingAaiSocket(connecting);
}

const { endCall, dropAai } = attachWebSocketServer(server, {
  caps: state,
  now: () => Date.now(),
  createAai,
  // Origin fix round 1: the WS upgrade handler's own origin gate (ws/browser.ts) needs the
  // same allowlist + proxy-trust bit http.ts's CORS already uses -- same `cfg`, not a copy.
  cfg,
  diagnostics,
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
dropAaiImpl = dropAai;

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
if (cfg.debug_hooks_enabled) {
  console.warn('countersign: COUNTERSIGN_DEBUG_HOOKS=1 -- POST /api/session/:id/debug/drop-aai is live. NEVER set this in production.');
}

// Task D1: bind 0.0.0.0 explicitly -- Render (and most PaaS hosts) route inbound traffic to
// the container's external interface, not just loopback, so an implicit default host is the
// wrong thing to rely on for the always-on deploy target.
server.listen(cfg.port, '0.0.0.0', () => {
  console.log(`countersign server listening on :${cfg.port}`);
});
