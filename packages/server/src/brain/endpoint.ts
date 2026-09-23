// packages/server/src/brain/endpoint.ts
// ONE-BRAIN LIVE PATH (2026-09-22, docs/plans/2026-09-22-one-brain-live-path.md §1, Lane C).
// POST /api/brain/chat/completions -- the OpenAI-compatible chat-completions endpoint
// AssemblyAI's stored agent calls as its OWN LLM (Lane D wires the agent to point here). This
// module NEVER runs `evaluate()` and NEVER computes a verdict (LAW 3; plan §3's "never-cross-
// this-line" invariant) -- it is a thin, stateless RENDERER of whatever `PhrasingGoal` the WS
// server's own engine run (`call/session.ts`'s `applyEvaluate`) already computed, reached
// through Lane B's token registry (`./registry.ts`). SSE framing matches AssemblyAI's own BYO
// demo and this repo's own spike (scripts/spike/endpoint.ts) -- role-only first delta, content
// delta(s), a final `{}`/`finish_reason:'stop'` delta, then `data: [DONE]` -- with one
// deliberate difference from the spike: the whole line goes out as ONE content delta, never
// split word-by-word (the spike's word-splitting only ever existed to exercise AssemblyAI's
// own chunk handling; nothing about the framing requires it).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readBodyLimited } from '../http.js';
import { extractCallToken, type BrainCallRegistry, type BrainChatMessage } from './registry.js';

/** This endpoint only ever receives a short OpenAI-style chat-completions request (a handful
 *  of short messages plus our own token marker) -- never a large upload. 256 KB is generous
 *  headroom over anything AssemblyAI's own BYO demo has been observed to send while cheap to
 *  buffer in full before parsing (plan §1's own sizing). */
const BRAIN_BODY_MAX_BYTES = 256 * 1024;

/** Plan §1: "Bound: 1500ms, with a role-only heartbeat delta written to the SSE stream once
 *  per second while waiting... On timeout: empty completion... never exceed ~2s total." (The
 *  timeout behavior actually implemented below renders `nextSpokenLine()`, not an empty
 *  completion -- see the comment at its call site for why; ~2s total still holds: 1500ms wait
 *  + body-read/JSON-parse/render, all sub-millisecond in practice.) */
const CALLER_WAIT_TIMEOUT_MS = 1500;
const HEARTBEAT_INTERVAL_MS = 1000;

export interface BrainEndpointDeps {
  registry: BrainCallRegistry;
  apiKey: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Constant-time credential check, `Authorization: Bearer <key>` or `x-api-key: <key>`,
 *  mirroring http.ts's own `isBearerTokenValid` (length check first -- `timingSafeEqual`
 *  itself throws on mismatched-length buffers -- then `timingSafeEqual`, never a plain `===`
 *  on caller-supplied bytes). Kept local rather than imported: the `x-api-key` header carries
 *  no `Bearer ` prefix to strip, and http.ts's own admin-route auth has never needed that
 *  second header shape. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function isBrainAuthValid(req: IncomingMessage, apiKey: string): boolean {
  const authHeader = req.headers['authorization'];
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    if (constantTimeEqual(authHeader.slice('Bearer '.length), apiKey)) return true;
  }
  const apiKeyHeader = req.headers['x-api-key'];
  if (typeof apiKeyHeader === 'string' && constantTimeEqual(apiKeyHeader, apiKey)) return true;
  return false;
}

/** Defensive sanitizer: reads only `role`/`content` as strings off whatever JSON the request
 *  body parsed to, same "narrowest shape that works" reasoning as registry.ts's own
 *  `BrainChatMessage`. A missing/non-array `messages`, or an entry whose `role`/`content`
 *  isn't a string, degrades to `''`/`[]` rather than throwing -- this endpoint must never
 *  throw on a malformed-but-JSON-parseable body (only genuinely unparseable JSON gets the 400
 *  in the handler below). */
function toBrainMessages(parsedBody: unknown): BrainChatMessage[] {
  const raw = (parsedBody as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(raw)) return [];
  return raw.map((entry: unknown): BrainChatMessage => {
    const m = entry as { role?: unknown; content?: unknown } | null;
    return {
      role: typeof m?.role === 'string' ? m.role : '',
      content: typeof m?.content === 'string' ? m.content : '',
    };
  });
}

function chunkPayload(model: string, delta: Record<string, unknown>, finish: string | null = null): string {
  return JSON.stringify({
    id: 'chatcmpl-brain',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
}

function writeDelta(res: ServerResponse, model: string, delta: Record<string, unknown>, finish: string | null = null): void {
  res.write(`data: ${chunkPayload(model, delta, finish)}\n\n`);
}

/** POST /api/brain/chat/completions -- mounted in http.ts only when both a `BrainCallRegistry`
 *  and an API key are configured (http.ts itself answers 404 otherwise, same "route completely
 *  absent" shape as the admin routes). Never throws: every path below runs inside a try/catch
 *  so an internal failure ends the response (500 if headers are still unsent, otherwise just
 *  `res.end()`) rather than taking the process down -- recall the malformed-escape crash found
 *  the same night this plan was written (http.ts's replay-audio route hit the identical lesson:
 *  an unhandled throw in an unawaited handler takes the whole process with it). */
export async function handleBrainChatCompletions(req: IncomingMessage, res: ServerResponse, deps: BrainEndpointDeps): Promise<void> {
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let aborted = false;
  const onClose = (): void => {
    aborted = true;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  };

  try {
    if (!isBrainAuthValid(req, deps.apiKey)) {
      sendJson(res, 401, { error: { message: 'unauthorized' } });
      return;
    }

    const bodyResult = await readBodyLimited(req, BRAIN_BODY_MAX_BYTES);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: { message: bodyResult.reason === 'timeout' ? 'request_timeout' : 'payload_too_large' } });
      return;
    }
    let parsedBody: unknown;
    try {
      const trimmed = bodyResult.body.trim();
      parsedBody = trimmed.length > 0 ? JSON.parse(trimmed) : {};
    } catch {
      sendJson(res, 400, { error: { message: 'malformed_json' } });
      return;
    }

    const messages = toBrainMessages(parsedBody);
    const modelField = (parsedBody as { model?: unknown } | null)?.model;
    const model = typeof modelField === 'string' ? modelField : 'countersign-brain';
    const token = extractCallToken(messages);
    const session = token !== null ? deps.registry.get(token) : undefined;

    // Headers + the role-only first delta go out IMMEDIATELY, before anything below is known
    // to matter (plan §1: "Write headers and the role-only first delta IMMEDIATELY"). No
    // Content-Length -- the body is streamed and its final length isn't known up front.
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    writeDelta(res, model, { role: 'assistant', content: '' });

    if (!session) {
      // Unknown/expired token -> an EMPTY completion, never an error (plan §1). Covers the
      // bootstrap race too: the caller's first utterance could in principle complete before
      // the post-bind session.update carrying the token lands; the session's own idle-nudge
      // recovers it on the next tick, not this endpoint.
      writeDelta(res, model, {}, 'stop');
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.on('close', onClose);
    const last = messages.length > 0 ? messages[messages.length - 1] : undefined;

    if (last !== undefined && last.role === 'user') {
      // The ordering race (plan §1): wait, bounded, for the WS server's OWN transcript.user
      // handling to fold this exact text into the conversation log and re-run the engine for
      // it -- never guess. A role-only heartbeat delta every ~1000ms keeps the SSE connection
      // visibly alive while waiting (tighter than the 2s keep-alive AssemblyAI's own BYO demo
      // uses, since G7-delay only proved AssemblyAI tolerates up to 2.5s with NO heartbeat).
      heartbeatTimer = setInterval(() => {
        if (aborted || res.writableEnded) return;
        writeDelta(res, model, { content: '' });
      }, HEARTBEAT_INTERVAL_MS);
      heartbeatTimer.unref?.();
      const caughtUp = await session.awaitCallerUtterance(last.content, CALLER_WAIT_TIMEOUT_MS);
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
      // Review finding 2026-09-22 9:26 PM (BLOCKING), plan §1 and §9 risk 1: on a timeout the
      // session has NOT processed this caller turn, so its current goal is still the PREVIOUS
      // one and rendering it would re-ask the question the caller just answered (the
      // repeated-question defect the founder quit a demo over). Say nothing instead: an
      // empty completion, never a stale line. (The orchestrator's lane brief had asked for
      // the stale render; that brief was wrong.)
      if (!caughtUp) {
        if (aborted || res.writableEnded) return;
        writeDelta(res, model, {}, 'stop');
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
    }
    // else: a non-user (most commonly trailing system, the `reply.create` nudge) or absent
    // last message -- render immediately, no wait (plan §1: "there is no new caller utterance
    // to wait for").

    if (aborted || res.writableEnded) return; // client disconnected -- nothing left to write

    const line = session.nextSpokenLine();
    if (line !== null && line.length > 0) writeDelta(res, model, { content: line });
    writeDelta(res, model, {}, 'stop');
    res.write('data: [DONE]\n\n');
    res.end();
  } catch {
    try {
      if (!res.headersSent) sendJson(res, 500, { error: { message: 'internal_error' } });
      else if (!res.writableEnded) res.end();
    } catch {
      /* nothing further can be done for this response */
    }
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    res.removeListener('close', onClose);
  }
}
