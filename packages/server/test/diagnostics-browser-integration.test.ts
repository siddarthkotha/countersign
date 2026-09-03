// packages/server/test/diagnostics-browser-integration.test.ts
// Task W9 review, fix round 1, item 3 ("smallest test to add"): today the "the browser's
// flight recorder payload shape matches what the server accepts" fact is true only by
// inspection/agreement between two independently-implemented lanes (web's
// packages/web/src/diagnostics/flightRecorder.ts, server's packages/server/src/diagnostics.ts)
// -- packages/server/test/diagnostics.test.ts builds its POST bodies by hand, and no test
// anywhere sends a REAL browser-built payload to a REAL server. This file closes that gap: it
// imports the real, unmodified web module (safe under plain Node/vitest -- no jsdom needed;
// `registerGlobalErrorListeners` in that module guards on `typeof window === 'undefined'` and
// no-ops here) and posts its real output to a real, unmodified `createHttpServer` instance --
// the same server-spin-up pattern `packages/server/test/diagnostics.test.ts`'s own `start()`/
// `startAndAttach()` helpers use. Read-only with respect to `packages/server/src`: nothing in
// this file edits server source, only exercises it.
import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import {
  buildDiagnosticsPayload,
  markStartClick,
  recordEvent,
  resetFlightRecorder,
  MAX_EVENTS,
} from '@countersign/web/src/diagnostics/flightRecorder.js';
import { createHttpServer } from '../src/http.js';
import { attachWebSocketServer } from '../src/ws/browser.js';
import { newDiagnosticsState, MAX_CLIENT_EVENTS_PER_REQUEST, MAX_CLIENT_BODY_BYTES } from '../src/diagnostics.js';
import { FakeAaiSocket } from '../src/aai/fake.js';
import type { ServerConfig } from '../src/config.js';

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

let closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  resetFlightRecorder();
});

// Mirrors packages/server/test/diagnostics.test.ts's own `start()` helper exactly (same
// server-spin-up pattern used throughout this package's HTTP-level tests) -- `state` (caps)
// comes straight off `createHttpServer`'s own return value, not hand-built, since its shape
// is internal to the server package.
async function start(): Promise<{ base: string; wsBase: string }> {
  const diagnostics = newDiagnosticsState();
  const serverCfg = cfg();
  let counter = 0;
  const ids = ['aaaaaaaa-2222-2222-2222-222222222222'];

  const { server, state } = createHttpServer(serverCfg, {
    fetchImpl: globalThis.fetch,
    now: () => Date.now(),
    randomId: () => ids[counter++] ?? `id-${counter}`,
    endCall: (id, reason) => wsApi.endCall(id, reason),
    diagnostics,
  });

  const wsApi = attachWebSocketServer(server, {
    caps: state,
    now: () => Date.now(),
    createAai: () => new FakeAaiSocket(),
    cfg: serverCfg,
    diagnostics,
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { base: `http://127.0.0.1:${addr.port}`, wsBase: `ws://127.0.0.1:${addr.port}` };
}

function selfOriginFor(wsBase: string): string {
  return wsBase.replace(/^ws:/, 'http:');
}

async function pollUntil(cond: () => boolean, timeoutMs = 3000, stepMs = 5): Promise<void> {
  const startedAt = Date.now();
  while (!cond()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`pollUntil: condition still false after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/** Same "bundle only exists once the call actually attaches" reasoning as
 *  diagnostics.test.ts's own `startAndAttach()`. */
async function startAndAttach(): Promise<{ base: string; session_id: string; ws: WebSocket }> {
  const { base, wsBase } = await start();
  const startRes = await fetch(`${base}/api/session/start`, { method: 'POST' });
  const { session_id, ws_path } = (await startRes.json()) as { session_id: string; ws_path: string };
  const ws = new WebSocket(`${wsBase}${ws_path}`, { origin: selfOriginFor(wsBase) });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ type: 'start' }));
  await pollUntil(() => true, 50); // let the attach (createBundle) land
  return { base, session_id, ws };
}

describe('a real browser-built flight-recorder payload against the real server', () => {
  it('is accepted (200, {ok:true, accepted:N}) and echoes back unchanged on GET', async () => {
    resetFlightRecorder();
    markStartClick();
    // The real kinds Call.tsx/MicCheck.tsx actually emit (packages/web/src/screens/Call.tsx,
    // packages/web/src/components/MicCheck.tsx) -- not a hand-picked shape, the module's own
    // real recording functions.
    recordEvent('mic_check', { ok: true, reason: 'passed', deviceLabel: 'USB Microphone' });
    recordEvent('start_click');
    recordEvent('socket_open');
    recordEvent('state', { status: 'VERIFYING' });
    recordEvent('transcript_line', { role: 'caller', length: 23 });
    recordEvent('link', { leg: 'browser', state: 'lost', dropped_frames: 2 });
    recordEvent('link', { leg: 'browser', state: 'restored', dropped_frames: 2 });
    recordEvent('flush');
    recordEvent('end_click');
    recordEvent('socket_close');
    recordEvent('timings', { startReadyMs: 300, readyFirstAudioMs: 550, turnGapsMs: [50, 100] });

    const body = buildDiagnosticsPayload();
    const { base, session_id, ws } = await startAndAttach();

    const res = await fetch(`${base}/api/session/${session_id}/diagnostics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    expect(res.status).toBe(200);
    const resBody = (await res.json()) as { ok: boolean; accepted: number };
    expect(resBody).toEqual({ ok: true, accepted: 11 });

    const getRes = await fetch(`${base}/api/session/${session_id}/diagnostics`);
    expect(getRes.status).toBe(200);
    const bundle = (await getRes.json()) as { client_events: { t_ms: number; kind: string; detail: unknown }[] };
    const kinds = bundle.client_events.map((e) => e.kind);
    expect(kinds).toEqual([
      'mic_check',
      'start_click',
      'socket_open',
      'state',
      'transcript_line',
      'link',
      'link',
      'flush',
      'end_click',
      'socket_close',
      'timings',
    ]);

    // Round-trip spot checks -- specific `detail` values survive the server's own
    // parse/validate/store/serialize cycle unchanged, byte-for-byte on the structured fields.
    const restoredLink = bundle.client_events.find((e) => e.kind === 'link' && (e.detail as { state: string }).state === 'restored');
    expect(restoredLink?.detail).toEqual({ leg: 'browser', state: 'restored', dropped_frames: 2 });
    const timingsEvent = bundle.client_events.find((e) => e.kind === 'timings');
    expect(timingsEvent?.detail).toEqual({ startReadyMs: 300, readyFirstAudioMs: 550, turnGapsMs: [50, 100] });
    const micEvent = bundle.client_events.find((e) => e.kind === 'mic_check');
    expect(micEvent?.detail).toEqual({ ok: true, reason: 'passed', deviceLabel: 'USB Microphone' });

    ws.close();
  });

  it('trims a 600-event client-side buffer to the server\'s own request cap (500) before ever sending, well under 64KB, and the real server accepts the whole thing', async () => {
    resetFlightRecorder();
    markStartClick();
    for (let i = 0; i < 600; i++) recordEvent('state', { status: `TICK_${i}` });

    // The client-side ring buffer's own cap matches the server's per-request cap EXACTLY --
    // the point of this assertion is to catch future drift between the two independently
    // maintained constants, not just that trimming happens at all.
    expect(MAX_EVENTS).toBe(MAX_CLIENT_EVENTS_PER_REQUEST);

    const body = buildDiagnosticsPayload();
    const bodyBytes = new TextEncoder().encode(body).length;
    const parsed = JSON.parse(body) as { events: { kind: string }[] };
    expect(parsed.events).toHaveLength(MAX_CLIENT_EVENTS_PER_REQUEST);
    expect(bodyBytes).toBeLessThanOrEqual(MAX_CLIENT_BODY_BYTES);
    // The ring buffer evicts OLDEST first -- the newest 500 of the 600 pushed survive.
    expect(parsed.events[0]!.kind).toBe('state');
    expect(parsed.events[parsed.events.length - 1]!.kind).toBe('state');

    const { base, session_id, ws } = await startAndAttach();
    const res = await fetch(`${base}/api/session/${session_id}/diagnostics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    // Not 400 (shape), not 413 (per-request or session-cumulative budget) -- the client-side
    // cap already matches the server's, so a full buffer is accepted whole in one POST.
    expect(res.status).toBe(200);
    const resBody = (await res.json()) as { ok: boolean; accepted: number };
    expect(resBody).toEqual({ ok: true, accepted: MAX_CLIENT_EVENTS_PER_REQUEST });

    ws.close();
  });
});
