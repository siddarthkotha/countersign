// packages/server/test/persona-diagnostics.test.ts
// PROVEN tonight (founder's report): a live legitimate-scenario call on the deployed site
// behaved exactly as if it had been minted with the attacker persona (sign-in check failed
// by design, STAGE unreachable), even though the harness sent {"persona":"legitimate"} at
// mint. Every code path from the POST body to callContextForPersona reads correctly in
// review AND in the existing e2e tests (see personas.test.ts, http.test.ts), so the
// remaining question is what the DEPLOYED server actually resolved -- and the flight
// recorder (diagnostics.ts) didn't record it. This file is the fix's own test: it proves
// two facts land in the SAME bundle a live call already produces, readable over the same
// GET .../diagnostics route the rehearsal harness and a founder debugging a live call both
// already use:
//   1. 'session_minted' (recorded at POST /api/session/start, before any WS attach exists)
//      carries what the server actually resolved the persona to, whether the request body
//      named one at all, and how many bytes it sent -- never the raw body itself.
//   2. 'call_context' (recorded at WS attach, where defaultCallContext is actually built)
//      carries the synthetic telemetry (origin_kind/origin_geo) that persona resolved to.
// Same server-spin-up pattern as diagnostics.test.ts's own start()/startAndAttach() helpers.
import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { newDiagnosticsState } from '../src/diagnostics.js';
import { createHttpServer } from '../src/http.js';
import { attachWebSocketServer } from '../src/ws/browser.js';
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
});

async function start(): Promise<{ base: string; wsBase: string }> {
  const diagnostics = newDiagnosticsState();
  const serverCfg = cfg();
  let counter = 0;
  const ids = ['aaaaaaaa-3333-3333-3333-333333333333'];

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

async function mintAndAttach(base: string, wsBase: string, body?: string): Promise<{ session_id: string; ws: WebSocket }> {
  const startRes = await fetch(`${base}/api/session/start`, {
    method: 'POST',
    ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body } : {}),
  });
  const { session_id, ws_path } = (await startRes.json()) as { session_id: string; ws_path: string };
  const ws = new WebSocket(`${wsBase}${ws_path}`, { origin: selfOriginFor(wsBase) });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ type: 'start' }));
  await pollUntil(() => true, 50); // let the attach (createBundle) land
  return { session_id, ws };
}

interface DiagBundleShape {
  server_events: { t_ms: number; kind: string; detail: unknown }[];
}

function findEvent(bundle: DiagBundleShape, kind: string): unknown {
  return bundle.server_events.find((e) => e.kind === kind)?.detail;
}

describe('flight recorder records what the server actually resolved a mint to', () => {
  it('a mint with {"persona":"legitimate"} resolves to legitimate and registered_device telemetry', async () => {
    const { base, wsBase } = await start();
    const { session_id, ws } = await mintAndAttach(base, wsBase, JSON.stringify({ persona: 'legitimate' }));

    const bundleRes = await fetch(`${base}/api/session/${session_id}/diagnostics`);
    expect(bundleRes.status).toBe(200);
    const bundle = (await bundleRes.json()) as DiagBundleShape;

    const minted = findEvent(bundle, 'session_minted') as
      | { persona_resolved: string; persona_input_present: boolean; body_bytes: number }
      | undefined;
    expect(minted).toBeDefined();
    expect(minted?.persona_resolved).toBe('legitimate');
    expect(minted?.persona_input_present).toBe(true);
    expect(minted?.body_bytes).toBeGreaterThan(0);

    const callContext = findEvent(bundle, 'call_context') as
      | { persona: string; origin_kind: string; origin_geo: string }
      | undefined;
    expect(callContext).toBeDefined();
    expect(callContext?.persona).toBe('legitimate');
    expect(callContext?.origin_kind).toBe('registered_device');
    expect(callContext?.origin_geo).toBe('Austin, TX');

    ws.close();
  });

  it('a mint with no body resolves to the safe default (attacker) and unverified_voip telemetry', async () => {
    const { base, wsBase } = await start();
    const { session_id, ws } = await mintAndAttach(base, wsBase);

    const bundleRes = await fetch(`${base}/api/session/${session_id}/diagnostics`);
    expect(bundleRes.status).toBe(200);
    const bundle = (await bundleRes.json()) as DiagBundleShape;

    const minted = findEvent(bundle, 'session_minted') as
      | { persona_resolved: string; persona_input_present: boolean; body_bytes: number }
      | undefined;
    expect(minted).toBeDefined();
    expect(minted?.persona_resolved).toBe('attacker');
    expect(minted?.persona_input_present).toBe(false);
    expect(minted?.body_bytes).toBe(0);

    const callContext = findEvent(bundle, 'call_context') as
      | { persona: string; origin_kind: string; origin_geo: string }
      | undefined;
    expect(callContext).toBeDefined();
    expect(callContext?.persona).toBe('attacker');
    expect(callContext?.origin_kind).toBe('unverified_voip');
    expect(callContext?.origin_geo).toBe('unknown');

    ws.close();
  });
});
