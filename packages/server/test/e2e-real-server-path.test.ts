// packages/server/test/e2e-real-server-path.test.ts
//
// Founder ruling 2026-09-09 (item 12, "the oracle gap"): the replay corpus feeds the engine
// the context and actions RECORDED in a JSON file, so it never exercises what the LIVE
// server actually builds (the real CallContext from a persona, the server's own
// runLookupsIfNeeded three-tool auto-run, the server's own composed readback/challenge
// goals). docs/RED-TEAM-2026-09-03.md's "Why hundreds of green tests missed both" is the
// proof: two unconditional bugs (the hardcoded unverified_voip CallContext, and a readback
// value the ledger could never match) made STAGE structurally unreachable on the live demo
// for months while ~800 tests replaying the recorded corpus stayed green throughout, because
// none of them let the server build its own context/actions from scratch.
//
// This test closes that gap. It starts the REAL server (createHttpServer + attachWebSocketServer,
// the exact same construction packages/server/test/browser-ws.test.ts uses), mints a session
// through the real /api/session/start route (so the server, not the test, decides the
// session_id and builds the real CallContext from the requested persona via
// callContextForPersona/personaFor), opens a REAL browser WebSocket against /ws/call/:id, and
// then feeds the caller's lines as `transcript.user`/`transcript.agent` AAI events -- exactly
// as AssemblyAI's real socket would deliver them to the server.
//
// THE ONE FAKE: `FakeAaiSocket`, injected only via `attachWebSocketServer`'s `createAai` hook
// (the seam CallSession already reads its transcript/tool events through -- see
// packages/server/src/aai/fake.ts's own doc comment: "tests drive it directly with .emit(),
// full control, no timers" -- this is what it exists for). No other seam is faked: the
// server mints its own session id, builds its own CallContext from the persona, runs its own
// CallSession, runs its own three tool lookups the instant CONSISTENCY_CHECK/EVIDENCE is
// reached, composes its own readback/challenge goals, grades the caller's replies against its
// own ledger, and reaches its own terminal verdict -- all exactly as it would against a real
// AssemblyAI connection, just without paying for one or needing a microphone.
//
// Two cases:
//  - Case A (persona "legitimate"): the caller states Scenario A's own opening claim
//    (BRIEF/corpus/scenario-a-dana-legitimate.json's c1, verbatim), then cooperates honestly
//    with whatever the live server's own goal actually asks for next. A literal turn-for-turn
//    replay of the corpus's OWN recorded conversation cannot reach STAGE here: the corpus's
//    a1 is a direct two-field readback, but a truly incremental live call reaches CHALLENGE
//    first (rule row 4 requires one passed knowledge/trap challenge before any readback can
//    begin -- proved in packages/server/test/session.test.ts's "fully cooperative" case,
//    which this test's turn sequence mirrors exactly, this time driven through the real HTTP
//    + WS server instead of a bare CallSession). That extra round is real, correct FSM
//    behavior, not a test artifact -- it is exactly the kind of thing a fixed corpus replay
//    can't surface and a live server does. Expected: STAGE, and the sign-in (SSO) evidence
//    card reads PASS.
//  - Case B (persona "attacker"): Scenario B's own recorded conversation IS already a valid
//    incremental live transcript (its own a1 is the challenge, its own c2 fails it), so this
//    case replays scenario-b-miller-fraud.json's conversation verbatim, live, through the
//    real server. Expected: FREEZE.
//
// Fast: every AAI event is delivered synchronously (`FakeAaiSocket.emit` calls its handlers
// in-line, no timers), so the only real waiting is `pollUntil`'s short polling loop for the
// WebSocket message to arrive over the real (loopback) socket -- both cases settle in well
// under a second in practice, the same shape already used throughout browser-ws.test.ts.
import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { createHttpServer } from '../src/http.js';
import { attachWebSocketServer } from '../src/ws/browser.js';
import { FakeAaiSocket } from '../src/aai/fake.js';
import { newDiagnosticsState } from '../src/diagnostics.js';
import type { ServerConfig } from '../src/config.js';
import type { ServerEvent } from '@countersign/engine';
import scenarioB from '../../engine/corpus/scenario-b-miller-fraud.json' with { type: 'json' };

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

describe('end-to-end: real server path (no recorded corpus context/actions fed to the engine)', () => {
  let closers: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  async function start(): Promise<{ base: string; wsBase: string; aaiInstances: Map<string, FakeAaiSocket> }> {
    const diagnostics = newDiagnosticsState();
    const aaiInstances = new Map<string, FakeAaiSocket>();
    const serverCfg = cfg();

    const { server, state } = createHttpServer(serverCfg, {
      fetchImpl: globalThis.fetch,
      now: () => Date.now(),
      randomId: () => `sess-${Math.random().toString(36).slice(2)}`,
      endCall: (id, reason) => wsApi.endCall(id, reason),
      diagnostics,
    });

    const wsApi = attachWebSocketServer(server, {
      caps: state,
      now: () => Date.now(),
      // THE ONE FAKE (see file header): the transcript/tool-event seam CallSession already
      // reads through in production, just handed a synchronous fake instead of a real
      // AssemblyAI socket. The server builds everything else -- session id, CallContext,
      // CallSession, tool lookups, readback/challenge goals, verdict -- itself.
      createAai: (session_id) => {
        const aai = new FakeAaiSocket();
        aaiInstances.set(session_id, aai);
        return aai;
      },
      cfg: serverCfg,
      diagnostics,
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    return { base: `http://127.0.0.1:${addr.port}`, wsBase: `ws://127.0.0.1:${addr.port}`, aaiInstances };
  }

  function selfOriginFor(url: string): string {
    const u = new URL(url);
    return `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`;
  }

  function connectAndCollect(url: string): Promise<{ ws: WebSocket; messages: ServerEvent[] }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { origin: selfOriginFor(url) });
      const messages: ServerEvent[] = [];
      ws.on('message', (data) => messages.push(JSON.parse(data.toString()) as ServerEvent));
      ws.once('open', () => resolve({ ws, messages }));
      ws.once('error', reject);
    });
  }

  async function pollUntil(cond: () => boolean, timeoutMs = 3000, stepMs = 5): Promise<void> {
    const startedAt = Date.now();
    while (!cond()) {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`pollUntil: condition still false after ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
  }

  async function mint(base: string, persona: 'legitimate' | 'attacker'): Promise<{ session_id: string; ws_path: string }> {
    const res = await fetch(`${base}/api/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persona }),
    });
    return (await res.json()) as { session_id: string; ws_path: string };
  }

  function lastStateOf(messages: ServerEvent[]): Extract<ServerEvent, { type: 'state' }> | undefined {
    const states = messages.filter((m): m is Extract<ServerEvent, { type: 'state' }> => m.type === 'state');
    return states[states.length - 1];
  }

  it('Case A (persona legitimate): the server builds its own context/lookups/readbacks live and reaches STAGE, with the sign-in card PASS', async () => {
    const { base, wsBase, aaiInstances } = await start();
    const { session_id, ws_path } = await mint(base, 'legitimate');

    const { ws, messages } = await connectAndCollect(`${wsBase}${ws_path}`);
    ws.send(JSON.stringify({ type: 'start' }));
    await pollUntil(() => messages.some((m) => m.type === 'state'));

    const aai = aaiInstances.get(session_id)!;

    // c1: identity + the full request in one utterance -- Scenario A's own opening line,
    // word for word (docs/BRIEF.md §4 / packages/engine/corpus/scenario-a-dana-legitimate.json).
    aai.emit({
      type: 'transcript.user',
      item_id: 'c1',
      text:
        "This is Dana Whitfield, corporate treasury. I need to wire it to Meridian Supply — $84,500, account ending 4471 — moving today instead of Friday, approved in yesterday's close meeting.",
    });

    // A live, incremental call cannot skip straight to a readback the way the recorded
    // corpus's one-shot a1 does -- the server's own rule row 4 demands one passed knowledge
    // challenge first (proved directly against CallSession in session.test.ts's "fully
    // cooperative" case; reproduced here through the real HTTP+WS server). The engine plants
    // a deliberately wrong beneficiary in its own trap question; a cooperative, honest caller
    // catches it and states the true one. (`CallSession` processes each `aai.emit` call
    // synchronously -- only the browser-facing `state` sends are throttled -- so the next
    // emit can follow immediately with no wait in between.)
    aai.emit({ type: 'reply.started', reply_id: 'a1' });
    aai.emit({
      type: 'transcript.agent',
      item_id: 'a1',
      text: 'You are requesting a wire transfer of $84,500 to Northgate Partners. Is that correct?',
      reply_id: 'a1',
      interrupted: false,
    });
    aai.emit({ type: 'reply.done', reply_id: 'a1', status: 'completed' });

    aai.emit({ type: 'transcript.user', item_id: 'c2', text: "No, that's wrong. It's Meridian Supply." });

    // The challenge passed; the server now moves to CONSISTENCY_CHECK and reads back the
    // amount, then the account, then the beneficiary, running its own SSO/history/out-of-band
    // lookups the instant it first reaches that state. A cooperative caller affirms every
    // readback -- exactly as an honest live caller would, and exactly what session.test.ts's
    // equivalent direct-CallSession case proves reaches STAGE.
    const affirmTurns = ['c3', 'c4', 'c5'];
    for (let i = 0; i < affirmTurns.length; i++) {
      const replyId = `a${i + 2}`;
      aai.emit({ type: 'reply.started', reply_id: replyId });
      aai.emit({ type: 'transcript.agent', item_id: replyId, text: 'Is that correct?', reply_id: replyId, interrupted: false });
      aai.emit({ type: 'reply.done', reply_id: replyId, status: 'completed' });
      aai.emit({ type: 'transcript.user', item_id: affirmTurns[i]!, text: "Yes, that's right." });
    }

    await pollUntil(() => lastStateOf(messages)?.state.verdict === 'STAGE', 3000);

    const finalState = lastStateOf(messages)!.state;
    expect(finalState.verdict).toBe('STAGE');

    // The exact bug that hid behind 800 green tests (docs/RED-TEAM-2026-09-03.md): the
    // sign-in (SSO) evidence card must actually read PASS for a legitimate live call, built
    // from the server's own CallContext (callContextForPersona('legitimate') ->
    // registered_device/Austin, TX), not the hardcoded unverified_voip that made this
    // impossible before FIX9.
    const sso = finalState.forensic.evidence.find((e) => e.id === 'ev-sso');
    expect(sso?.status).toBe('PASS');

    ws.close();
  });

  it('Case B (persona attacker): Scenario B\'s own recorded conversation, replayed live through the real server, reaches FREEZE', async () => {
    const { base, wsBase, aaiInstances } = await start();
    const { session_id, ws_path } = await mint(base, 'attacker');

    const { ws, messages } = await connectAndCollect(`${wsBase}${ws_path}`);
    ws.send(JSON.stringify({ type: 'start' }));
    await pollUntil(() => messages.some((m) => m.type === 'state'));

    const aai = aaiInstances.get(session_id)!;
    const turns = scenarioB.conversation;

    // Scenario B's own recorded conversation IS already a valid incremental live transcript
    // (unlike Scenario A's, its own a1 IS the challenge and its own c2 fails it) -- replayed
    // here verbatim, live, letting the server build its own CallContext (attacker ->
    // unverified_voip/unknown), run its own three lookups, and reach its own verdict.
    aai.emit({ type: 'transcript.user', item_id: turns[0]!.id, text: turns[0]!.text });
    aai.emit({ type: 'reply.started', reply_id: turns[1]!.id });
    aai.emit({ type: 'transcript.agent', item_id: turns[1]!.id, text: turns[1]!.text, reply_id: turns[1]!.id, interrupted: false });
    aai.emit({ type: 'reply.done', reply_id: turns[1]!.id, status: 'completed' });

    aai.emit({ type: 'transcript.user', item_id: turns[2]!.id, text: turns[2]!.text });
    aai.emit({ type: 'reply.started', reply_id: turns[3]!.id });
    aai.emit({ type: 'transcript.agent', item_id: turns[3]!.id, text: turns[3]!.text, reply_id: turns[3]!.id, interrupted: false });
    aai.emit({ type: 'reply.done', reply_id: turns[3]!.id, status: 'completed' });

    // The amount contradiction ($1.8M -> $2.1M), bumping request_version to 2.
    aai.emit({ type: 'transcript.user', item_id: turns[4]!.id, text: turns[4]!.text });
    aai.emit({ type: 'reply.started', reply_id: turns[5]!.id });
    aai.emit({
      type: 'transcript.agent',
      item_id: turns[5]!.id,
      text: turns[5]!.text,
      reply_id: turns[5]!.id,
      interrupted: true, // the recorded barge-in
    });
    aai.emit({ type: 'reply.done', reply_id: turns[5]!.id, status: 'interrupted' });

    // The pressure line, then the agent's "one last check" -- the tick the server's own
    // lookup runner resolves check_sso_context/get_request_history/verify_out_of_band and
    // reaches a terminal FREEZE verdict, all server-computed from the attacker CallContext.
    aai.emit({ type: 'transcript.user', item_id: turns[6]!.id, text: turns[6]!.text });
    aai.emit({ type: 'reply.started', reply_id: turns[7]!.id });
    aai.emit({ type: 'transcript.agent', item_id: turns[7]!.id, text: turns[7]!.text, reply_id: turns[7]!.id, interrupted: false });
    aai.emit({ type: 'reply.done', reply_id: turns[7]!.id, status: 'completed' });

    await pollUntil(() => lastStateOf(messages)?.state.verdict === 'FREEZE', 3000);

    const finalState = lastStateOf(messages)!.state;
    expect(finalState.verdict).toBe('FREEZE');
    expect(finalState.forensic.countersign).toEqual({ server_verdict: 'FREEZE', recomputed: true });

    ws.close();
  });
});
