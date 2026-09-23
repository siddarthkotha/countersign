// packages/server/test/brain/endpoint.test.ts
// ONE-BRAIN LIVE PATH (2026-09-22, docs/plans/2026-09-22-one-brain-live-path.md §1/§6, Lane C).
// REAL fetch against a REAL createHttpServer, driving a REAL CallSession through the FakeAaiSocket
// pattern proven in packages/server/test/session-endpoint-mode.test.ts (LAW: never a copy, never
// the live API). Covers packages/server/src/brain/endpoint.ts's SSE framing, auth, body limits,
// the ordering-race wait/heartbeat/timeout, and token routing (plan §6 items 1, 3, 4, 5, 7, 8; the
// wait/heartbeat/timeout behavior of item 2; token-routing coverage of item 6; idempotency of
// item 5's twin, item 5 in this lane's own brief).
import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { MERIDIAN, mockToolResult } from '@countersign/engine';
import type { CallContext, ServerEvent } from '@countersign/engine';
import { createHttpServer } from '../../src/http.js';
import { newDiagnosticsState } from '../../src/diagnostics.js';
import type { ServerConfig } from '../../src/config.js';
import { CallSession } from '../../src/call/session.js';
import { FakeAaiSocket } from '../../src/aai/fake.js';
import { BrainCallRegistry, generateCallToken, formatCallTokenMarker } from '../../src/brain/registry.js';
import recordedStage from '../../../engine/corpus/recorded-stage.json' with { type: 'json' };
import recordedFreeze from '../../../engine/corpus/recorded-freeze.json' with { type: 'json' };

const BRAIN_API_KEY = 'test-brain-api-key';
const ENDPOINT_PATH = '/api/brain/chat/completions';

function cfg(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    port: 0,
    assemblyai_api_key: 'secret-key',
    session_cap_seconds: 300,
    max_concurrent: 2,
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

describe('POST /api/brain/chat/completions', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close) {
      await close();
      close = undefined;
    }
  });

  function start(opts: { brainRegistry?: BrainCallRegistry; brainApiKey?: string } = {}): Promise<{ server: Server; base: string }> {
    const diagnostics = newDiagnosticsState();
    const { server } = createHttpServer(cfg(), {
      fetchImpl: globalThis.fetch,
      now: () => 1000,
      randomId: () => '11111111-1111-1111-1111-111111111111',
      endCall: () => false,
      diagnostics,
      ...(opts.brainRegistry !== undefined ? { brainRegistry: opts.brainRegistry } : {}),
      ...(opts.brainApiKey !== undefined ? { brainApiKey: opts.brainApiKey } : {}),
    });
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        close = () => new Promise((res) => server.close(() => res()));
        resolve({ server, base: `http://127.0.0.1:${addr.port}` });
      });
    });
  }

  /** Real CallSession + FakeAaiSocket, same construction shape as session-endpoint-mode.test.ts
   *  and brain/registry.test.ts -- never a mock/copy of CallSession (LAW). */
  function newSession(call: CallContext, clock: { now: number }, aai: FakeAaiSocket): CallSession {
    const sent: ServerEvent[] = [];
    return new CallSession({
      session_id: call.session_id,
      seed: MERIDIAN,
      call,
      aai,
      now: () => clock.now,
      onServerEvent: (e) => sent.push(e),
      mock: mockToolResult,
      brainMode: 'endpoint',
    });
  }

  interface CorpusLine {
    id: string;
    speaker: string;
    text: string;
  }

  function callerLinesOf(corpus: { conversation: CorpusLine[] }): CorpusLine[] {
    return corpus.conversation.filter((u) => u.speaker === 'caller');
  }

  /** Drives exactly `count` caller lines through `session`, echoing each rendered
   *  `nextSpokenLine()` back as that reply's own `transcript.agent` -- the same drive pattern
   *  session-endpoint-mode.test.ts already proves matches the real one-brain design (the
   *  endpoint would have returned this line and AssemblyAI would have spoken it verbatim). This
   *  is what lets `challenge_issued`/`readback_issued` actions log correctly for the NEXT
   *  driven line to be read as an answer/confirmation, same as a real call. */
  function driveCallerLines(session: CallSession, aai: FakeAaiSocket, clock: { now: number }, lines: CorpusLine[], count: number): void {
    let replyCounter = 0;
    for (let i = 0; i < count; i++) {
      const line = lines[i]!;
      clock.now += 3000;
      aai.emit({ type: 'transcript.user', item_id: line.id, text: line.text });
      const spoken = session.nextSpokenLine();
      if (spoken !== null) {
        replyCounter += 1;
        const replyId = `drive-reply-${replyCounter}`;
        clock.now += 500;
        aai.emit({ type: 'reply.started', reply_id: replyId });
        aai.emit({ type: 'transcript.agent', item_id: `${replyId}-t`, text: spoken, reply_id: replyId, interrupted: false });
        aai.emit({ type: 'reply.done', reply_id: replyId, status: 'completed' });
      }
    }
  }

  interface SseChunk {
    delta: Record<string, unknown>;
    finish_reason: string | null;
  }

  function parseSse(text: string): { chunks: SseChunk[]; done: boolean } {
    const chunks: SseChunk[] = [];
    let done = false;
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice('data:'.length).trim();
      if (payload === '[DONE]') {
        done = true;
        continue;
      }
      if (payload.length === 0) continue;
      const parsed = JSON.parse(payload) as { choices: [{ delta: Record<string, unknown>; finish_reason: string | null }] };
      chunks.push({ delta: parsed.choices[0].delta, finish_reason: parsed.choices[0].finish_reason });
    }
    return { chunks, done };
  }

  function contentOf(chunks: SseChunk[]): string {
    return chunks.map((c) => (typeof c.delta.content === 'string' ? c.delta.content : '')).join('');
  }

  function chatRequest(base: string, messages: Array<{ role: string; content: string }>, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${base}${ENDPOINT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${BRAIN_API_KEY}`, ...headers },
      body: JSON.stringify({ model: 'countersign-brain-test', messages }),
    });
  }

  it('answers 404 when neither brainRegistry nor brainApiKey is configured (route completely absent)', async () => {
    const { base } = await start();
    const res = await fetch(`${base}${ENDPOINT_PATH}`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
  });

  it('answers 404 when the registry is configured but the API key is not', async () => {
    const { base } = await start({ brainRegistry: new BrainCallRegistry() });
    const res = await fetch(`${base}${ENDPOINT_PATH}`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
  });

  it('401s on a missing Authorization header', async () => {
    const { base } = await start({ brainRegistry: new BrainCallRegistry(), brainApiKey: BRAIN_API_KEY });
    const res = await fetch(`${base}${ENDPOINT_PATH}`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });

  it('401s on a wrong bearer token', async () => {
    const { base } = await start({ brainRegistry: new BrainCallRegistry(), brainApiKey: BRAIN_API_KEY });
    const res = await fetch(`${base}${ENDPOINT_PATH}`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-key' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('accepts x-api-key as an alternative to the Authorization bearer header', async () => {
    const { base } = await start({ brainRegistry: new BrainCallRegistry(), brainApiKey: BRAIN_API_KEY });
    const res = await fetch(`${base}${ENDPOINT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': BRAIN_API_KEY },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    expect(res.status).toBe(200);
  });

  it('400s on malformed JSON', async () => {
    const { base } = await start({ brainRegistry: new BrainCallRegistry(), brainApiKey: BRAIN_API_KEY });
    const res = await fetch(`${base}${ENDPOINT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${BRAIN_API_KEY}` },
      body: '{not valid json',
    });
    expect(res.status).toBe(400);
  });

  it('unknown/expired token -> exact empty-completion SSE framing', async () => {
    const { base } = await start({ brainRegistry: new BrainCallRegistry(), brainApiKey: BRAIN_API_KEY });
    const bogusMarker = formatCallTokenMarker('a'.repeat(64));
    const res = await chatRequest(base, [{ role: 'system', content: bogusMarker }]);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const { chunks, done } = parseSse(await res.text());
    expect(done).toBe(true);
    expect(chunks).toEqual([
      { delta: { role: 'assistant', content: '' }, finish_reason: null },
      { delta: {}, finish_reason: 'stop' },
    ]);
  });

  it('known token, last user message already processed -> exact nextSpokenLine text in one content delta', async () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const call = recordedStage.call as CallContext;
    const session = newSession(call, clock, aai);
    session.start();
    const callerLines = callerLinesOf(recordedStage);
    driveCallerLines(session, aai, clock, callerLines, 1); // process c1

    const registry = new BrainCallRegistry();
    const token = generateCallToken();
    registry.register(token, session);
    const { base } = await start({ brainRegistry: registry, brainApiKey: BRAIN_API_KEY });

    const expectedLine = session.nextSpokenLine(); // read-only, safe to call again for the expectation
    expect(expectedLine).not.toBeNull();

    const res = await chatRequest(base, [
      { role: 'system', content: formatCallTokenMarker(token) },
      { role: 'user', content: callerLines[0]!.text },
    ]);
    expect(res.status).toBe(200);
    const { chunks, done } = parseSse(await res.text());
    expect(done).toBe(true);
    expect(chunks).toEqual([
      { delta: { role: 'assistant', content: '' }, finish_reason: null },
      { delta: { content: expectedLine }, finish_reason: null },
      { delta: {}, finish_reason: 'stop' },
    ]);
  });

  it('last user message dispatched partway through the wait window -> waits, at least one heartbeat, renders the right line', async () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const call = recordedStage.call as CallContext;
    const session = newSession(call, clock, aai);
    session.start();
    const callerLines = callerLinesOf(recordedStage);
    driveCallerLines(session, aai, clock, callerLines, 1); // process c1 only -- c2 not yet uttered

    const registry = new BrainCallRegistry();
    const token = generateCallToken();
    registry.register(token, session);
    const { base } = await start({ brainRegistry: registry, brainApiKey: BRAIN_API_KEY });

    const c2 = callerLines[1]!;
    // Dispatched at 1200ms: past the first ~1000ms heartbeat tick, comfortably inside the
    // 1500ms wait bound -- proves both "at least one heartbeat fires" and "resolves before
    // timeout, not via it".
    const dispatchTimer = setTimeout(() => {
      aai.emit({ type: 'transcript.user', item_id: c2.id, text: c2.text });
    }, 1200);

    const startedAt = Date.now();
    const res = await chatRequest(base, [
      { role: 'system', content: formatCallTokenMarker(token) },
      { role: 'user', content: c2.text },
    ]);
    expect(res.status).toBe(200);
    // `fetch()` itself resolves as soon as RESPONSE HEADERS arrive (this handler writes headers
    // + the role-only first delta immediately, before the wait even begins) -- the wait/
    // heartbeat/timeout all happen while the BODY streams, so elapsed time must be measured
    // across `res.text()` (full body), not the `fetch()` call alone.
    const bodyText = await res.text();
    const elapsedMs = Date.now() - startedAt;
    clearTimeout(dispatchTimer);

    expect(elapsedMs).toBeGreaterThanOrEqual(1000); // did not resolve before the dispatch at 1200ms
    expect(elapsedMs).toBeLessThan(1500); // resolved from the dispatch, not the 1500ms timeout
    const expectedLine = session.nextSpokenLine(); // reflects c2 having been folded in by the dispatch above
    const { chunks, done } = parseSse(bodyText);
    expect(done).toBe(true);
    expect(chunks[0]).toEqual({ delta: { role: 'assistant', content: '' }, finish_reason: null });
    expect(chunks[chunks.length - 1]).toEqual({ delta: {}, finish_reason: 'stop' });
    const heartbeatCount = chunks.filter((c) => Object.keys(c.delta).length === 1 && c.delta.content === '').length;
    expect(heartbeatCount).toBeGreaterThanOrEqual(1);
    expect(contentOf(chunks)).toBe(expectedLine);
  }, 5000);

  it('last user message never dispatched -> times out within ~2s with an EMPTY completion, never the stale previous question', async () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const call = recordedStage.call as CallContext;
    const session = newSession(call, clock, aai);
    session.start();
    const callerLines = callerLinesOf(recordedStage);
    driveCallerLines(session, aai, clock, callerLines, 1); // process c1 only

    const registry = new BrainCallRegistry();
    const token = generateCallToken();
    registry.register(token, session);
    const { base } = await start({ brainRegistry: registry, brainApiKey: BRAIN_API_KEY });

    const expectedLine = session.nextSpokenLine(); // c2 is never dispatched, so this never changes
    const startedAt = Date.now();
    const res = await chatRequest(base, [
      { role: 'system', content: formatCallTokenMarker(token) },
      { role: 'user', content: callerLines[1]!.text }, // c2 -- deliberately never emitted on aai
    ]);
    expect(res.status).toBe(200);
    // See the previous test's own comment: elapsed time must be measured across the full body
    // (`res.text()`), since `fetch()` itself resolves as soon as headers arrive, well before
    // the 1500ms wait/timeout plays out.
    const bodyText = await res.text();
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(1450); // resolved via the 1500ms timeout, not early
    expect(elapsedMs).toBeLessThan(2000); // plan §1/§9: never exceed ~2s total
    const { chunks, done } = parseSse(bodyText);
    expect(done).toBe(true);
    // Review finding 2026-09-22 9:26 PM (BLOCKING): the session never processed c2, so its
    // goal is still c1's; rendering it would re-ask the question the caller just answered.
    // Plan §1/§9: say nothing on timeout.
    expect(expectedLine).not.toBeNull(); // there WAS a stale line available to (wrongly) speak
    expect(contentOf(chunks)).toBe('');
  }, 5000);

  it('trailing system message (reply.create nudge) -> immediate render, no wait', async () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const call = recordedStage.call as CallContext;
    const session = newSession(call, clock, aai);
    session.start();
    const callerLines = callerLinesOf(recordedStage);
    driveCallerLines(session, aai, clock, callerLines, 1);

    const registry = new BrainCallRegistry();
    const token = generateCallToken();
    registry.register(token, session);
    const { base } = await start({ brainRegistry: registry, brainApiKey: BRAIN_API_KEY });

    const expectedLine = session.nextSpokenLine();
    const startedAt = Date.now();
    const res = await chatRequest(base, [
      { role: 'system', content: formatCallTokenMarker(token) },
      { role: 'user', content: callerLines[0]!.text },
      { role: 'assistant', content: expectedLine ?? '' },
      { role: 'system', content: 'Please continue the conversation now.' },
    ]);
    const elapsedMs = Date.now() - startedAt;

    expect(res.status).toBe(200);
    expect(elapsedMs).toBeLessThan(500); // no wait -- rendered immediately
    const { chunks, done } = parseSse(await res.text());
    expect(done).toBe(true);
    expect(contentOf(chunks)).toBe(expectedLine);
  });

  it('two different tokens, concurrent requests -> each gets its own session line, no cross-talk', async () => {
    const clockA = { now: 0 };
    const aaiA = new FakeAaiSocket();
    const sessionA = newSession(recordedStage.call as CallContext, clockA, aaiA);
    sessionA.start();
    driveCallerLines(sessionA, aaiA, clockA, callerLinesOf(recordedStage), 1);

    const clockB = { now: 0 };
    const aaiB = new FakeAaiSocket();
    const sessionB = newSession(recordedFreeze.call as CallContext, clockB, aaiB);
    sessionB.start();
    driveCallerLines(sessionB, aaiB, clockB, callerLinesOf(recordedFreeze), 1);

    const registry = new BrainCallRegistry();
    const tokenA = generateCallToken();
    const tokenB = generateCallToken();
    registry.register(tokenA, sessionA);
    registry.register(tokenB, sessionB);
    const { base } = await start({ brainRegistry: registry, brainApiKey: BRAIN_API_KEY });

    const expectedA = sessionA.nextSpokenLine();
    const expectedB = sessionB.nextSpokenLine();
    expect(expectedA).not.toBeNull();
    expect(expectedB).not.toBeNull();
    expect(expectedA).not.toBe(expectedB); // different call, different identity -- real engine output, not asserted-away

    const [resA, resB] = await Promise.all([
      chatRequest(base, [
        { role: 'system', content: formatCallTokenMarker(tokenA) },
        { role: 'user', content: callerLinesOf(recordedStage)[0]!.text },
      ]),
      chatRequest(base, [
        { role: 'system', content: formatCallTokenMarker(tokenB) },
        { role: 'user', content: callerLinesOf(recordedFreeze)[0]!.text },
      ]),
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    const contentA = contentOf(parseSse(await resA.text()).chunks);
    const contentB = contentOf(parseSse(await resB.text()).chunks);
    expect(contentA).toBe(expectedA);
    expect(contentB).toBe(expectedB);
    expect(contentA).not.toBe(contentB);
  });

  it('duplicate identical requests return identical lines (idempotent by construction)', async () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const call = recordedStage.call as CallContext;
    const session = newSession(call, clock, aai);
    session.start();
    const callerLines = callerLinesOf(recordedStage);
    driveCallerLines(session, aai, clock, callerLines, 1);

    const registry = new BrainCallRegistry();
    const token = generateCallToken();
    registry.register(token, session);
    const { base } = await start({ brainRegistry: registry, brainApiKey: BRAIN_API_KEY });

    const messages = [
      { role: 'system', content: formatCallTokenMarker(token) },
      { role: 'user', content: callerLines[0]!.text },
    ];
    const first = contentOf(parseSse(await (await chatRequest(base, messages)).text()).chunks);
    const second = contentOf(parseSse(await (await chatRequest(base, messages)).text()).chunks);
    expect(first).not.toBe('');
    expect(first).toBe(second);
  });

  it('client abort mid-wait: no unhandled rejection, no timer leak, session still usable after', async () => {
    const clock = { now: 0 };
    const aai = new FakeAaiSocket();
    const call = recordedStage.call as CallContext;
    const session = newSession(call, clock, aai);
    session.start();
    const callerLines = callerLinesOf(recordedStage);
    driveCallerLines(session, aai, clock, callerLines, 1); // process c1 only -- c2 never dispatched

    const registry = new BrainCallRegistry();
    const token = generateCallToken();
    registry.register(token, session);
    const { base } = await start({ brainRegistry: registry, brainApiKey: BRAIN_API_KEY });

    let unhandled: unknown = null;
    const onUnhandled = (err: unknown): void => {
      unhandled = err;
    };
    process.on('unhandledRejection', onUnhandled);

    const controller = new AbortController();
    // `chatRequest` has no `signal` param -- inlined here (same request shape) so the abort
    // signal can be wired in directly. NOTE: `fetch()` itself resolves as soon as response
    // HEADERS arrive (this handler writes headers + the role-only first delta immediately,
    // before the wait even begins) -- aborting after that point doesn't reject the `fetch()`
    // promise, only the in-flight BODY read, so the assertion below is against `.text()`, not
    // the bare `fetch()` promise.
    const controlledRequest = fetch(`${base}${ENDPOINT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${BRAIN_API_KEY}` },
      body: JSON.stringify({
        model: 'countersign-brain-test',
        messages: [
          { role: 'system', content: formatCallTokenMarker(token) },
          { role: 'user', content: callerLines[1]!.text },
        ],
      }),
      signal: controller.signal,
    });
    const bodyTextPromise = controlledRequest.then((r) => r.text());

    await new Promise((r) => setTimeout(r, 150));
    controller.abort();
    await expect(bodyTextPromise).rejects.toBeTruthy();

    // Give any pending timers/microtasks (the heartbeat interval, the aborted awaitCallerUtterance
    // promise) a chance to settle before checking for an unhandled rejection.
    await new Promise((r) => setTimeout(r, 100));
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toBeNull();

    // The session itself is untouched by the abort (the endpoint never mutates session state) --
    // a fresh, already-processed request against the SAME token still renders correctly.
    const expectedLine = session.nextSpokenLine();
    const followUp = await chatRequest(base, [
      { role: 'system', content: formatCallTokenMarker(token) },
      { role: 'user', content: callerLines[0]!.text },
    ]);
    expect(followUp.status).toBe(200);
    expect(contentOf(parseSse(await followUp.text()).chunks)).toBe(expectedLine);
  });
});
