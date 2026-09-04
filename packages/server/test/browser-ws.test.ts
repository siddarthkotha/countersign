import { describe, it, expect, afterEach } from 'vitest';
import { connect as netConnect, type AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import WebSocket from 'ws';
import { createHttpServer } from '../src/http.js';
import { attachWebSocketServer } from '../src/ws/browser.js';
import { FakeAaiSocket } from '../src/aai/fake.js';
import { newDiagnosticsState, type DiagnosticsState } from '../src/diagnostics.js';
import type { CapsState } from '../src/caps.js';
import type { ServerConfig } from '../src/config.js';
import type { ServerEvent } from '@countersign/engine';
// Bug fix (2026-09-04) end-to-end test: Scenario A is BRIEF's own "fully cooperative call"
// (every critical field read back and affirmed) -- reused here to drive a LIVE session
// through the real HTTP + WS stack, not just the engine in isolation.
import scenarioA from '../../engine/corpus/scenario-a-dana-legitimate.json' with { type: 'json' };

function cfg(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    port: 0,
    assemblyai_api_key: 'secret-key',
    session_cap_seconds: 300,
    max_concurrent: 4,
    idle_timeout_ms: 30000,
    daily_session_cap: 40,
    mint_rate_per_minute: 100,
    kill_switch: false,
    allowed_origins: ['http://localhost:5173'],
    trust_proxy: false,
    browser_grace_ms: 20000,
    ...overrides,
  };
}

describe('ws/browser — /ws/call/:id', () => {
  let closers: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  async function start(
    opts: { browser_grace_ms?: number; session_cap_seconds?: number; allowed_origins?: string[]; trust_proxy?: boolean } = {}
  ): Promise<{
    base: string;
    wsBase: string;
    state: CapsState;
    diagnostics: DiagnosticsState;
    aaiInstances: Map<string, FakeAaiSocket>;
    endCall: (session_id: string, reason: string) => boolean;
  }> {
    const ids = ['id-1', 'id-2', 'id-3'];
    let counter = 0;
    const aaiInstances = new Map<string, FakeAaiSocket>();
    const diagnostics = newDiagnosticsState();

    // Origin fix round 1: one shared ServerConfig for both createHttpServer (CORS) and
    // attachWebSocketServer (the WS upgrade's own origin gate) -- same object http.ts and
    // ws/browser.ts both read through origin.ts, not two independently-built configs that
    // could drift apart.
    const serverCfg = cfg({
      ...(opts.allowed_origins !== undefined ? { allowed_origins: opts.allowed_origins } : {}),
      ...(opts.trust_proxy !== undefined ? { trust_proxy: opts.trust_proxy } : {}),
    });

    const { server, state } = createHttpServer(serverCfg, {
      fetchImpl: globalThis.fetch,
      now: () => Date.now(),
      randomId: () => ids[counter++] ?? `id-${counter}`,
      // These tests exercise `endCall` directly (returned by `attachWebSocketServer` below,
      // captured into `wsApi` after both are constructed) rather than through http.ts's
      // routes -- http.test.ts already covers the http.ts side of the CRITICAL 1 wiring.
      endCall: (id, reason) => wsApi.endCall(id, reason),
      diagnostics,
    });

    const wsApi = attachWebSocketServer(server, {
      caps: state,
      now: () => Date.now(),
      createAai: (session_id) => {
        const aai = new FakeAaiSocket();
        aaiInstances.set(session_id, aai);
        return aai;
      },
      cfg: serverCfg,
      diagnostics,
      ...(opts.browser_grace_ms !== undefined ? { browser_grace_ms: opts.browser_grace_ms } : {}),
      ...(opts.session_cap_seconds !== undefined ? { session_cap_seconds: opts.session_cap_seconds } : {}),
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    return {
      base: `http://127.0.0.1:${addr.port}`,
      wsBase: `ws://127.0.0.1:${addr.port}`,
      state,
      diagnostics,
      aaiInstances,
      endCall: wsApi.endCall,
    };
  }

  /** The `Origin` header a real browser on the same host+port as `url` would send on a WS
   *  upgrade -- these tests' server never sets COUNTERSIGN_TRUST_PROXY, so its own origin is
   *  always its plain `http://<host>` (never `wss:`/`https:` here, this is a loopback test
   *  server with no TLS). Used as the DEFAULT origin for `connect`/`connectAndCollect` so
   *  every existing same-origin test keeps working unchanged; the dedicated origin-check
   *  tests below pass a different `origin` explicitly. */
  function selfOriginFor(url: string): string {
    const u = new URL(url);
    return `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`;
  }

  function connect(url: string, origin: string | null = selfOriginFor(url)): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, origin !== null ? { origin } : undefined);
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });
  }

  function collectMessages(ws: WebSocket): ServerEvent[] {
    const out: ServerEvent[] = [];
    ws.on('message', (data) => out.push(JSON.parse(data.toString()) as ServerEvent));
    return out;
  }

  /** Finding 5 (final review): replaces a fixed `setTimeout(resolve, N)` guess with an actual
   *  wait on the condition the test cares about -- a real socket/timer integration test still
   *  needs SOME real wait (there is no fake-timer story for a live `ws`/`http` server), but a
   *  fixed guess is either too short (flaky under load) or wastefully long; polling converges
   *  the instant the condition is true and only times out (loudly, not silently) if it never
   *  is. Never shorter than the real thing it's waiting on -- `stepMs` is a poll interval, not
   *  a substitute deadline. */
  async function pollUntil(cond: () => boolean, timeoutMs = 3000, stepMs = 5): Promise<void> {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`pollUntil: condition still false after ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
  }

  /** Attaches the message collector in the SAME tick as the socket is constructed, before
   *  `open` fires -- a reattach can have the server writing its replay (link:restored, the
   *  latest state, buffered audio) the instant the connection completes, so collecting only
   *  starts from `await connect()`'s resolution (like the other tests here, which never race
   *  because the server has nothing to say until they send `start`) would lose it. */
  function connectAndCollect(
    url: string,
    origin: string | null = selfOriginFor(url)
  ): Promise<{ ws: WebSocket; messages: ServerEvent[] }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, origin !== null ? { origin } : undefined);
      const messages: ServerEvent[] = [];
      ws.on('message', (data) => messages.push(JSON.parse(data.toString()) as ServerEvent));
      ws.once('open', () => resolve({ ws, messages }));
      ws.once('error', reject);
    });
  }

  it('closes with 4404 for an id nobody started', async () => {
    const { wsBase } = await start();
    const ws = await connect(`${wsBase}/ws/call/nonexistent-id`);
    const closeCode = await new Promise<number>((resolve) => {
      ws.once('close', (code) => resolve(code));
    });
    expect(closeCode).toBe(4404);
  });

  it('a started session accepts the connection and sends state after {type:"start"}', async () => {
    const { base, wsBase, aaiInstances } = await start();
    const startRes = await fetch(`${base}/api/session/start`, { method: 'POST' });
    const { session_id, ws_path } = (await startRes.json()) as { session_id: string; ws_path: string };
    expect(ws_path).toBe(`/ws/call/${session_id}`);

    const ws = await connect(`${wsBase}${ws_path}`);
    const messages = collectMessages(ws);
    ws.send(JSON.stringify({ type: 'start' }));

    await pollUntil(() => messages.some((m) => m.type === 'state'));

    expect(aaiInstances.has(session_id)).toBe(true);
    expect(messages.some((m) => m.type === 'state')).toBe(true);
    const stateMsg = messages.find((m) => m.type === 'state');
    if (stateMsg?.type === 'state') {
      expect(stateMsg.state.session_id).toBe(session_id);
      expect(stateMsg.state.link).toBe('live');
    }

    ws.close();
  });

  it('throttles rapid state updates to fewer sends than updates (exact per-window timing is unit-tested in throttle.test.ts with fake timers)', async () => {
    // The EXACT throttle timing (leading-edge send, one trailing coalesced flush at the
    // window boundary, latest-state-wins) is proven deterministically in
    // packages/server/test/throttle.test.ts against the pure `makeThrottle` function using
    // vitest fake timers -- no real clock involved, so no flakiness under load. This test
    // stays a real socket/timer integration test, but only asserts the timing-INSENSITIVE
    // fact that end-to-end wiring (browser.ts's `makeThrottledSender` actually calls into the
    // throttle for `state` events): a burst of state-changing updates produces strictly fewer
    // `state` sends than updates, never one send per update. That is true for ANY throttle
    // window that fires more slowly than the burst, so it can't flake on timing the way an
    // exact upper/lower bound over a fixed real wait could.
    const { base, wsBase, aaiInstances } = await start();
    const startRes = await fetch(`${base}/api/session/start`, { method: 'POST' });
    const { session_id, ws_path } = (await startRes.json()) as { session_id: string; ws_path: string };

    const { ws, messages } = await connectAndCollect(`${wsBase}${ws_path}`);
    ws.send(JSON.stringify({ type: 'start' }));
    await pollUntil(() => messages.some((m) => m.type === 'state'));

    const aai = aaiInstances.get(session_id)!;
    const stateCountBeforeBurst = messages.filter((m) => m.type === 'state').length;
    const burstSize = 10;
    // Fire a burst of user transcripts well within one 66ms throttle window -- each one
    // changes the conversation log and would otherwise trigger its own `state` send.
    for (let i = 0; i < burstSize; i++) {
      aai.emit({ type: 'transcript.user', item_id: `burst-${i}`, text: `hello ${i}` });
    }

    try {
      // Give the throttle's trailing flush (and the socket) time to deliver whatever it's
      // going to send -- generous on purpose (this is a "let it settle" wait, not a
      // boundary-proving one, so being longer than strictly necessary costs nothing).
      await new Promise((resolve) => setTimeout(resolve, 300));

      const stateEventsAfterBurst = messages.filter((m) => m.type === 'state').length - stateCountBeforeBurst;
      // Never one send per burst event -- strictly fewer sends than updates. (The exact
      // bound of "at most 2" lives in throttle.test.ts, proven with fake timers.)
      expect(stateEventsAfterBurst).toBeLessThan(burstSize);
      expect(stateEventsAfterBurst).toBeGreaterThanOrEqual(1);
    } finally {
      // Finding 5 (final review): cleanup runs even if the assertion above throws -- an
      // uncleaned socket left open after a failed assertion is what turned one flaky
      // assertion into a cascading 10s `afterEach` hook timeout on the NEXT test too.
      ws.close();
    }
  });

  it('keeps the caps slot (and the session alive) during the grace window after the browser socket closes', async () => {
    const { base, wsBase, state } = await start({ browser_grace_ms: 500 });
    const startRes = await fetch(`${base}/api/session/start`, { method: 'POST' });
    const { session_id, ws_path } = (await startRes.json()) as { session_id: string; ws_path: string };
    expect(state.active.has(session_id)).toBe(true);

    const ws = await connect(`${wsBase}${ws_path}`);
    ws.close();
    // No externally observable condition distinguishes "the server has processed this
    // socket's close (and entered the grace window)" from "still attached" -- `state.active`
    // reads true in both, and this is a real TCP socket close (not a synthetic/fake one), so
    // there is no synchronous or microtask-level signal to poll on either. A short real wait
    // for the close to propagate is the only option here (same tradeoff as the reattach test
    // below); 50ms is comfortably within the 500ms grace window while still giving the close
    // time to land.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Well within the 500ms grace window: the slot is still taken -- a browser drop does not
    // end the call (the AssemblyAI session and the evidence live on the server).
    expect(state.active.has(session_id)).toBe(true);
  });

  it('ends the session and frees the caps slot once the grace window expires with no reattach', async () => {
    const { base, wsBase, state } = await start({ browser_grace_ms: 150 });
    const startRes = await fetch(`${base}/api/session/start`, { method: 'POST' });
    const { session_id, ws_path } = (await startRes.json()) as { session_id: string; ws_path: string };

    const ws = await connect(`${wsBase}${ws_path}`);
    ws.close();
    await pollUntil(() => !state.active.has(session_id));

    expect(state.active.has(session_id)).toBe(false);
  });

  it('a reattach within the grace window receives link:restored then the latest state, and the call keeps running', async () => {
    const { base, wsBase, state, aaiInstances } = await start({ browser_grace_ms: 2000 });
    const startRes = await fetch(`${base}/api/session/start`, { method: 'POST' });
    const { session_id, ws_path } = (await startRes.json()) as { session_id: string; ws_path: string };

    const { ws: ws1, messages: messages1 } = await connectAndCollect(`${wsBase}${ws_path}`);
    ws1.send(JSON.stringify({ type: 'start' }));
    await pollUntil(() => messages1.some((m) => m.type === 'state'));
    ws1.close();
    // No externally observable condition distinguishes "the server has processed this
    // socket's close (and entered the grace window)" from "still attached" -- `state.active`
    // reads true in both. A short real wait for the close to propagate is the only option
    // here (same as before this fix); 40ms is generous for a same-machine loopback close.
    await new Promise((resolve) => setTimeout(resolve, 40));

    // Still within grace: slot held, session alive.
    expect(state.active.has(session_id)).toBe(true);

    const { ws: ws2, messages } = await connectAndCollect(`${wsBase}${ws_path}`);
    await pollUntil(() => messages.some((m) => m.type === 'state'));

    expect(messages[0]).toEqual({ type: 'link', state: 'restored', leg: 'browser' });
    const stateMsg = messages.find((m) => m.type === 'state');
    expect(stateMsg?.type).toBe('state');
    if (stateMsg?.type === 'state') expect(stateMsg.state.session_id).toBe(session_id);

    // The same underlying call session (and its AAI socket) is still the one that was
    // started before the drop -- a reattach never spins up a second AssemblyAI connection.
    expect(aaiInstances.size).toBe(1);

    // Live events keep flowing to the reattached socket.
    const aai = aaiInstances.get(session_id)!;
    const stateCountBefore = messages.filter((m) => m.type === 'state').length;
    aai.emit({ type: 'transcript.user', item_id: 'after-reattach', text: 'hello again' });
    await pollUntil(() => messages.filter((m) => m.type === 'state').length > stateCountBefore);
    expect(messages.some((m) => m.type === 'state')).toBe(true);

    ws2.close();
  });

  it('refuses a second concurrent attach for the same id with 4409 while the first is still live', async () => {
    const { base, wsBase } = await start();
    const startRes = await fetch(`${base}/api/session/start`, { method: 'POST' });
    const { ws_path } = (await startRes.json()) as { session_id: string; ws_path: string };

    const ws1 = await connect(`${wsBase}${ws_path}`);
    const ws2 = new WebSocket(`${wsBase}${ws_path}`, { origin: selfOriginFor(wsBase) });
    const closeCode = await new Promise<number>((resolve) => {
      ws2.once('close', (code) => resolve(code));
    });

    expect(closeCode).toBe(4409);
    ws1.close();
  });

  it('CRITICAL 1 (final review): endCall ends a LIVE call -- the browser gets `ended`, its socket closes, and the caps slot frees', async () => {
    const { base, wsBase, state, endCall } = await start();
    const startRes = await fetch(`${base}/api/session/start`, { method: 'POST' });
    const { session_id, ws_path } = (await startRes.json()) as { session_id: string; ws_path: string };

    const { ws, messages } = await connectAndCollect(`${wsBase}${ws_path}`);
    ws.send(JSON.stringify({ type: 'start' }));
    await pollUntil(() => messages.some((m) => m.type === 'state'));

    const closeCode = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));

    // Simulates what index.ts's idle reaper does with `reapIdle`'s returned ids -- this is
    // the exact bug CRITICAL 1 fixed: previously only `CapsState` was touched, and the live
    // `CallSession` (and its AAI socket, and the attached browser socket) kept right on
    // running past the reason it was supposed to end for.
    const ended = endCall(session_id, 'idle_timeout');
    expect(ended).toBe(true);

    await pollUntil(() => messages.some((m) => m.type === 'ended'));
    expect(messages.find((m) => m.type === 'ended')).toEqual({ type: 'ended', reason: 'idle_timeout' });
    // The browser socket itself is closed by `endCall`, not left dangling for the client to
    // notice on its own.
    await closeCode;
    expect(state.active.has(session_id)).toBe(false);

    // A second call is a no-op, not an error -- the call already ended.
    expect(endCall(session_id, 'idle_timeout')).toBe(false);
  });

  it('CRITICAL 1 (final review): endCall on an id that only ever held a caps reservation (never attached a socket) still frees the slot', async () => {
    const { base, state, endCall } = await start();
    const startRes = await fetch(`${base}/api/session/start`, { method: 'POST' });
    const { session_id } = (await startRes.json()) as { session_id: string; ws_path: string };
    expect(state.active.has(session_id)).toBe(true);

    expect(endCall(session_id, 'reset')).toBe(true);
    expect(state.active.has(session_id)).toBe(false);

    // Unknown id entirely: no-op, not an error.
    expect(endCall('never-existed', 'reset')).toBe(false);
  });

  it('CRITICAL 1 (final review): the per-call cap timer ends a live call with reason cap_reached once its total time is up', async () => {
    // 60ms cap -- short enough for a fast real-timer test, long enough to reliably outlast
    // the initial connect/start handshake above it.
    const { base, wsBase, state } = await start({ session_cap_seconds: 0.06 });
    const startRes = await fetch(`${base}/api/session/start`, { method: 'POST' });
    const { session_id, ws_path } = (await startRes.json()) as { session_id: string; ws_path: string };

    const { ws, messages } = await connectAndCollect(`${wsBase}${ws_path}`);
    ws.send(JSON.stringify({ type: 'start' }));

    await pollUntil(() => messages.some((m) => m.type === 'ended'));
    expect(messages.find((m) => m.type === 'ended')).toEqual({ type: 'ended', reason: 'cap_reached' });
    expect(state.active.has(session_id)).toBe(false);
  });

  it('IMPORTANT 2 (final review): an AAI-leg link event forwards to the browser tagged leg:"aai" (distinct from a browser-leg reattach\'s leg:"browser")', async () => {
    const { base, wsBase, aaiInstances } = await start({ browser_grace_ms: 2000 });
    const startRes = await fetch(`${base}/api/session/start`, { method: 'POST' });
    const { session_id, ws_path } = (await startRes.json()) as { session_id: string; ws_path: string };

    const { ws, messages } = await connectAndCollect(`${wsBase}${ws_path}`);
    ws.send(JSON.stringify({ type: 'start' }));
    await pollUntil(() => messages.some((m) => m.type === 'state'));

    const aai = aaiInstances.get(session_id)!;
    aai.emit({ type: 'link', state: 'lost', attempt: 1 });
    await pollUntil(() => messages.some((m) => m.type === 'link'));

    expect(messages.find((m) => m.type === 'link')).toEqual({ type: 'link', state: 'lost', leg: 'aai' });

    ws.close();
  });

  // CRITICAL (task-origin-review.md): the WS upgrade path's own origin gate, tested at the
  // raw TCP level rather than through the `ws` client library -- the requirement is
  // specifically that a disallowed origin gets a raw `HTTP/1.1 403 Forbidden` response and
  // the socket destroyed BEFORE any WS handshake completes (never a normal WS close frame,
  // which is what closing post-handshake would send instead). A hand-rolled HTTP/1.1 upgrade
  // request is the only way to observe that exact byte-level behaviour and to send NO Origin
  // header at all (the `ws` client library always sends one when `options.origin` is set, and
  // never a way to omit `Host`/other required headers while still testing this precisely).
  function rawUpgradeRequest(wsBase: string, path: string, origin: string | undefined): Promise<string> {
    return new Promise((resolve, reject) => {
      const u = new URL(`${wsBase}${path}`.replace(/^wss?:/, 'http:'));
      const socket = netConnect(Number(u.port), u.hostname, () => {
        const headers = [
          `Host: ${u.host}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          ...(origin !== undefined ? [`Origin: ${origin}`] : []),
        ].join('\r\n');
        socket.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\n${headers}\r\n\r\n`);
      });
      let raw = '';
      socket.on('data', (chunk) => {
        raw += chunk.toString('utf8');
      });
      socket.once('close', () => resolve(raw));
      socket.once('error', reject);
      // A same-origin/allowed request completes the WS handshake and then just sits there
      // (no close code the server will send unprompted) -- destroy it after a short window so
      // this promise still resolves with whatever response line it got.
      setTimeout(() => socket.destroy(), 200);
    });
  }

  it('CRITICAL: a same-origin WS upgrade request completes the handshake (HTTP/1.1 101)', async () => {
    const { wsBase } = await start();
    const raw = await rawUpgradeRequest(wsBase, '/ws/call/nonexistent-id', selfOriginFor(wsBase));
    expect(raw.split('\r\n')[0]).toBe('HTTP/1.1 101 Switching Protocols');
  });

  it('CRITICAL: a foreign-origin WS upgrade request gets a raw 403 and the socket is destroyed, never a WS handshake', async () => {
    const { wsBase } = await start();
    const raw = await rawUpgradeRequest(wsBase, '/ws/call/nonexistent-id', 'http://evil.example');
    expect(raw.split('\r\n')[0]).toBe('HTTP/1.1 403 Forbidden');
    expect(raw).not.toContain('101 Switching Protocols');
  });

  it('CRITICAL: a WS upgrade request with a configured extra origin succeeds (HTTP/1.1 101)', async () => {
    const { wsBase } = await start({ allowed_origins: ['https://extra.example'] });
    const raw = await rawUpgradeRequest(wsBase, '/ws/call/nonexistent-id', 'https://extra.example');
    expect(raw.split('\r\n')[0]).toBe('HTTP/1.1 101 Switching Protocols');
  });

  it('CRITICAL: a WS upgrade request with NO Origin header at all is denied with a raw 403 (browsers always send one)', async () => {
    const { wsBase } = await start();
    const raw = await rawUpgradeRequest(wsBase, '/ws/call/nonexistent-id', undefined);
    expect(raw.split('\r\n')[0]).toBe('HTTP/1.1 403 Forbidden');
  });

  it('CRITICAL: the origin gate also covers /ws/replay, not just /ws/call', async () => {
    const { wsBase } = await start();
    const raw = await rawUpgradeRequest(wsBase, '/ws/replay/scenario-a-dana-legitimate?speed=50', 'http://evil.example');
    expect(raw.split('\r\n')[0]).toBe('HTTP/1.1 403 Forbidden');
  });

  // Bug fix (2026-09-04): end-to-end proof of the fix's consequence. Before this fix, the
  // live `defaultCallContext` was hardcoded to `unverified_voip`/`unknown` for every call, so
  // `evidenceFromTools.ssoEvidence` failed always -- STAGE was structurally unreachable no
  // matter how a caller behaved. This drives Scenario A's own conversation (BRIEF's "fully
  // cooperative call": every critical field read back and affirmed) through the REAL
  // /api/session/start -> /ws/call/:id -> CallSession chain, once per persona, and checks
  // only the SSO evidence card -- not the overall verdict. Reaching a full STAGE verdict here
  // also depends on the readback-confirmation bug another lane is fixing concurrently in
  // packages/engine; that is out of scope for this test on purpose.
  it('BUG FIX: persona flows end to end -- legitimate is SSO PASS, attacker is SSO FAIL for the SAME cooperative call', async () => {
    const { base, wsBase, aaiInstances } = await start();

    async function ssoStatusFor(persona: 'legitimate' | 'attacker'): Promise<string> {
      const startRes = await fetch(`${base}/api/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ persona }),
      });
      const { session_id, ws_path } = (await startRes.json()) as { session_id: string; ws_path: string };

      const { ws, messages } = await connectAndCollect(`${wsBase}${ws_path}`);
      ws.send(JSON.stringify({ type: 'start' }));
      await pollUntil(() => messages.some((m) => m.type === 'state'));

      const aai = aaiInstances.get(session_id)!;
      const turns = scenarioA.conversation;

      // c1 (claim: identity + amount + account + beneficiary) -> a1 (readback amount+
      // account) -> c2 (confirm) -> a2 (readback account) -> c3 (confirm) -> a3 (readback
      // beneficiary) -> c4 (confirm) reaches EVIDENCE the instant c4 lands, which
      // auto-runs check_sso_context/get_request_history/verify_out_of_band server-side
      // (session.ts's `runLookupsIfNeeded`) -- no model tool.call needed, same as the
      // recorded corpus's own tools log.
      aai.emit({ type: 'transcript.user', item_id: turns[0]!.id, text: turns[0]!.text });
      aai.emit({ type: 'reply.started', reply_id: turns[1]!.id });
      aai.emit({ type: 'transcript.agent', item_id: turns[1]!.id, text: turns[1]!.text, reply_id: turns[1]!.id, interrupted: false });
      aai.emit({ type: 'reply.done', reply_id: turns[1]!.id, status: 'completed' });
      aai.emit({ type: 'transcript.user', item_id: turns[2]!.id, text: turns[2]!.text });
      aai.emit({ type: 'reply.started', reply_id: turns[3]!.id });
      aai.emit({ type: 'transcript.agent', item_id: turns[3]!.id, text: turns[3]!.text, reply_id: turns[3]!.id, interrupted: false });
      aai.emit({ type: 'reply.done', reply_id: turns[3]!.id, status: 'completed' });
      aai.emit({ type: 'transcript.user', item_id: turns[4]!.id, text: turns[4]!.text });
      aai.emit({ type: 'reply.started', reply_id: turns[5]!.id });
      aai.emit({ type: 'transcript.agent', item_id: turns[5]!.id, text: turns[5]!.text, reply_id: turns[5]!.id, interrupted: false });
      aai.emit({ type: 'reply.done', reply_id: turns[5]!.id, status: 'completed' });
      aai.emit({ type: 'transcript.user', item_id: turns[6]!.id, text: turns[6]!.text });

      function lastState(): Extract<ServerEvent, { type: 'state' }> | undefined {
        const stateEvents = messages.filter((m): m is Extract<ServerEvent, { type: 'state' }> => m.type === 'state');
        return stateEvents[stateEvents.length - 1];
      }

      await pollUntil(() => lastState()?.state.forensic.evidence.some((e) => e.id === 'ev-sso') ?? false);

      const sso = lastState()!.state.forensic.evidence.find((e) => e.id === 'ev-sso')!;
      ws.close();
      return sso.status;
    }

    expect(await ssoStatusFor('legitimate')).toBe('PASS');
    expect(await ssoStatusFor('attacker')).toBe('FAIL');
  });
});
