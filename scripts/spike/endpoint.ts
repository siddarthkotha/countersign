// scripts/spike/endpoint.ts
// SPIKE-ONLY. The "Thinker": an OpenAI-compatible POST /chat/completions endpoint,
// standing in for AssemblyAI's managed model per docs/round2/connect-your-own-llm.md ("set
// the `llm` field on the agent to your own OpenAI-compatible chat-completions endpoint.
// AssemblyAI calls that endpoint at runtime to generate every reply."). SSE framing copies
// AssemblyAI's own BYO demo (docs/round2/server.mjs lines ~475-486, ~1374-1464): a role-only
// first delta with content "", then content chunk(s), a final delta {} with finish_reason
// "stop", then "data: [DONE]".
//
// Every request is logged in FULL (redacted key only) to scripts/spike/logs/*.jsonl before
// any response is written, so G1's "record the full request body shape" question has
// evidence even if the response path throws.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { log, redactHeaders, nowIso } from './lib.js';

export type EndpointBehavior =
  | { type: 'line'; text: string }
  | { type: 'empty' }
  | { type: 'whitespace' }
  | { type: 'delay'; ms: number; then: EndpointBehavior }
  | { type: 'http500' }
  /** G7b: a role-only heartbeat delta ({content:''}, same shape as the BYO demo's own
   *  keep-alive, docs/round2/server.mjs:1382) written every `heartbeatMs` for `ms` total
   *  before finally writing `then`'s content. `then` must be 'line' | 'empty' | 'whitespace'
   *  (not itself 'stall'/'delay'/'http500') -- kept simple for this follow-up's one use. */
  | { type: 'stall'; ms: number; heartbeatMs: number; then: { type: 'line'; text: string } | { type: 'empty' } | { type: 'whitespace' } };

export interface EndpointRequestRecord {
  seq: number;
  receivedAt: string;
  headers: Record<string, string>;
  body: unknown;
  behaviorUsed: EndpointBehavior;
  respondedAt: string;
  firstByteAt: string | null;
  /** G5b: the `COUNTERSIGN_CALL_TOKEN:<token>` value found in any system message, if any. */
  tokenExtracted: string | null;
  /** G5b: true if `tokenExtracted` had a per-token behavior registered (routed path); false
   *  if it fell back to the global FIFO queue (either no token, or an unregistered one). */
  routedByToken: boolean;
}

export interface EndpointHandle {
  port: number;
  close: () => Promise<void>;
  /** Push one behavior onto the FIFO queue; the next incoming /chat/completions request pops
   *  it. Queue empty -> DEFAULT_BEHAVIOR (a clearly-marked fallback line) so an un-primed
   *  request never silently looks like a real test case. */
  push: (b: EndpointBehavior) => void;
  requests: EndpointRequestRecord[];
  /** Resolves the NEXT time a request is received and fully handled (after the response
   *  stream ends) -- lets the driver `await` a turn's completion instead of polling. */
  waitForNextRequest: () => Promise<EndpointRequestRecord>;
  expectedApiKey: string;
  /** G5b: sets/overwrites the CURRENT behavior for a per-call token -- mirrors the real
   *  plan's design (docs/plans/2026-09-22-one-brain-live-path.md §1): the endpoint parses
   *  the token out of `messages[0]` and renders that call's own current state, a pure
   *  lookup, never a shared queue. ANY request carrying this token (including a duplicate/
   *  speculative one, per the original spike's G5 finding) gets this SAME behavior --
   *  idempotent by construction, unlike the FIFO queue above. Takes priority over the FIFO
   *  queue when a token is found AND registered. */
  setTokenBehavior: (token: string, behavior: EndpointBehavior) => void;
  clearTokenBehavior: (token: string) => void;
}

const TOKEN_RE = /COUNTERSIGN_CALL_TOKEN:(\S+)/;

/** Scans every `system`-role message in `messages` for the token marker (matches
 *  docs/plans/2026-09-22-one-brain-live-path.md §1's `messages[0]` claim, but scans all
 *  system messages defensively in case AssemblyAI's own injected boilerplate -- PROVEN
 *  present in g1-last-request.json -- ever gets prepended ahead of ours). */
function extractToken(body: unknown): string | null {
  const messages = (body as { messages?: Array<{ role?: string; content?: string }> } | undefined)?.messages ?? [];
  for (const m of messages) {
    if (m.role === 'system' && typeof m.content === 'string') {
      const match = m.content.match(TOKEN_RE);
      if (match) return match[1] ?? null;
    }
  }
  return null;
}

const DEFAULT_BEHAVIOR: EndpointBehavior = { type: 'line', text: '[SPIKE-DEFAULT-FALLBACK unprimed request]' };

function chunk(model: string, delta: Record<string, unknown>, finish: string | null = null): string {
  return JSON.stringify({
    id: 'chatcmpl-spike',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
}

function checkAuth(req: IncomingMessage, expectedKey: string): boolean {
  const authHeader = req.headers['authorization'];
  const xApiKey = req.headers['x-api-key'];
  const bearer = typeof authHeader === 'string' ? authHeader.replace(/^Bearer\s+/i, '').trim() : '';
  const alt = typeof xApiKey === 'string' ? xApiKey.trim() : '';
  return bearer === expectedKey || alt === expectedKey;
}

function readJsonBody(req: IncomingMessage, limit = 2 * 1024 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (part: Buffer) => {
      data += part.toString('utf8');
      if (data.length > limit) {
        req.destroy();
        reject(new Error('request too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(data.length ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

export function startEndpoint(opts: { port: number; expectedApiKey: string }): Promise<EndpointHandle> {
  const queue: EndpointBehavior[] = [];
  const requests: EndpointRequestRecord[] = [];
  const tokenBehaviors = new Map<string, EndpointBehavior>();
  let seq = 0;
  let waiters: Array<(r: EndpointRequestRecord) => void> = [];

  async function respondWithBehavior(
    res: ServerResponse,
    model: string,
    behavior: EndpointBehavior,
    record: EndpointRequestRecord,
  ): Promise<void> {
    if (behavior.type === 'delay') {
      // Deliberately NO heartbeat here (unlike AssemblyAI's own BYO demo's 2s keep-alive
      // interval, docs/round2/server.mjs:1382) -- G7 wants to observe AssemblyAI's own
      // behavior under a genuinely silent, slow endpoint.
      await new Promise((r) => setTimeout(r, behavior.ms));
      return respondWithBehavior(res, model, behavior.then, record);
    }
    if (behavior.type === 'http500') {
      record.firstByteAt = nowIso();
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'spike: forced 500' } }));
      return;
    }
    if (behavior.type === 'stall') {
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
      record.firstByteAt = nowIso();
      res.write(`data: ${chunk(model, { role: 'assistant', content: '' })}\n\n`);
      const beats = Math.floor(behavior.ms / behavior.heartbeatMs);
      for (let b = 0; b < beats; b++) {
        await new Promise((r) => setTimeout(r, behavior.heartbeatMs));
        res.write(`data: ${chunk(model, { content: '' })}\n\n`);
      }
      const remaining = behavior.ms - beats * behavior.heartbeatMs;
      if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
      if (behavior.then.type === 'line') {
        for (const word of behavior.then.text.match(/\S+\s*/g) ?? []) {
          res.write(`data: ${chunk(model, { content: word })}\n\n`);
        }
      } else if (behavior.then.type === 'whitespace') {
        res.write(`data: ${chunk(model, { content: ' ' })}\n\n`);
      }
      res.write(`data: ${chunk(model, {}, 'stop')}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
    record.firstByteAt = nowIso();
    res.write(`data: ${chunk(model, { role: 'assistant', content: '' })}\n\n`);
    if (behavior.type === 'line') {
      for (const word of behavior.text.match(/\S+\s*/g) ?? []) {
        res.write(`data: ${chunk(model, { content: word })}\n\n`);
      }
    } else if (behavior.type === 'whitespace') {
      res.write(`data: ${chunk(model, { content: ' ' })}\n\n`);
    }
    // 'empty': no content chunk at all, matching docs/round2/server.mjs's "you" mode when the
    // typed text is "" -- text.match(/\S+\s*/g) is null, the word loop never runs.
    res.write(`data: ${chunk(model, {}, 'stop')}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }

  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/chat/completions') {
      void (async () => {
        const receivedAt = nowIso();
        const headers = redactHeaders(req.headers as Record<string, string | string[] | undefined>);
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (e) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: String(e) } }));
          return;
        }
        const authed = checkAuth(req, opts.expectedApiKey);
        seq += 1;
        const tokenExtracted = extractToken(body);
        const routedByToken = tokenExtracted !== null && tokenBehaviors.has(tokenExtracted);
        const behaviorUsed = routedByToken ? tokenBehaviors.get(tokenExtracted as string)! : (queue.shift() ?? DEFAULT_BEHAVIOR);
        const record: EndpointRequestRecord = {
          seq,
          receivedAt,
          headers,
          body,
          behaviorUsed,
          respondedAt: '',
          firstByteAt: null,
          tokenExtracted,
          routedByToken,
        };
        await log({ kind: 'endpoint_request', seq, receivedAt, authed, headers, body, behaviorUsed, tokenExtracted, routedByToken });
        if (!authed) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'bad api key' } }));
          record.respondedAt = nowIso();
          requests.push(record);
          await log({ kind: 'endpoint_response', seq, status: 401 });
          const w = waiters;
          waiters = [];
          w.forEach((fn) => fn(record));
          return;
        }
        const model =
          (body as { model?: string } | undefined)?.model ?? 'countersign-spike';
        try {
          await respondWithBehavior(res, model, behaviorUsed, record);
        } finally {
          record.respondedAt = nowIso();
          requests.push(record);
          await log({
            kind: 'endpoint_response',
            seq,
            behaviorUsed,
            respondedAt: record.respondedAt,
            firstByteAt: record.firstByteAt,
          });
          const w = waiters;
          waiters = [];
          w.forEach((fn) => fn(record));
        }
      })();
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(opts.port, () => {
      resolve({
        port: opts.port,
        close: () =>
          new Promise((r) => {
            server.close(() => r());
          }),
        push: (b: EndpointBehavior) => queue.push(b),
        requests,
        waitForNextRequest: () => new Promise((r) => waiters.push(r)),
        expectedApiKey: opts.expectedApiKey,
        setTokenBehavior: (token: string, b: EndpointBehavior) => tokenBehaviors.set(token, b),
        clearTokenBehavior: (token: string) => tokenBehaviors.delete(token),
      });
    });
  });
}
