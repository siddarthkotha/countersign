// packages/server/src/aai/types.ts
// The interface between a call session and AssemblyAI's Voice Agent WebSocket, and the
// event shapes it produces (docs/aai-docs-check-2026-09-01.md §d). `src/aai/fake.ts`
// implements `AaiSocket` for tests and for `COUNTERSIGN_FAKE_AAI=1` dev mode; the real
// adapter (`src/aai/session.ts`, connecting to wss://agents.assemblyai.com/v1/ws) is S3.
// Kept out of `@countersign/engine` on purpose: this is AssemblyAI's wire protocol, not
// engine vocabulary -- the engine never sees an AaiEvent.

/** What `call/session.ts` needs from a live (or fake) AssemblyAI connection. */
export interface AaiSocket {
  send(msg: object): void;
  on(handler: (evt: AaiEvent) => void): void;
  close(): void;
  /** Round 3 (S3 re-review): counts server messages this adapter never modeled (see the
   *  `default` branch of `mapServerEvent` in `session.ts`) -- optional so `FakeAaiSocket`
   *  (which never has unmodeled events, since tests only ever emit shapes it knows) need
   *  not implement it. */
  stats?(): { unknown_events: number };
  /** Rehearsal-harness debug hook (item: judge-sim finding 2026-09-11, "zero AssemblyAI
   *  socket drops occurred" -- session.resume was never exercised live). Forces the SAME
   *  unexpected-close path a real network drop takes (`RealAaiSocket.handleUnexpectedClose`
   *  in `session.ts`), so the real bounded resume-on-drop logic actually runs, instead of
   *  faking a `link`/`session.resume` event that would prove nothing about the real code
   *  path. Only ever reachable server-side via an env-guarded debug route
   *  (`COUNTERSIGN_DEBUG_HOOKS=1`, see `http.ts`) -- never wired to anything a caller can
   *  reach in production. Returns false if there is nothing live to drop (already closed).
   *  Optional: `FakeAaiSocket` (dev mode / most tests) has no resume logic to exercise, so
   *  it need not implement this. */
  debugForceDrop?(): boolean;
  /** aai-observability lane (2026-09-16, dead-transcript investigation finding 1 continued):
   *  registers a handler fired once for every server message this adapter's own
   *  `mapServerEvent` (session.ts) does not model at all (the `default` branch) -- EXCEPT
   *  `transcript.*.delta`, which never reaches this channel at all (see
   *  `onAgentTranscriptDelta` below for why that one high-frequency type gets its own
   *  dedicated, aggregated channel instead of firing here per chunk -- without that split
   *  this channel would flood on every reply). Carries the raw message `type` and a
   *  <=200-char slice of its JSON, so `CallSession` -- the only place with the per-reply
   *  state to correlate this against -- can record a rate-limited `aai_unhandled_message`
   *  diagnostic instead of the previous silent `stats().unknown_events` bump alone.
   *  `PendingAaiSocket` (index.ts) relays this the same way it already relays `on()`, so a
   *  handler registered before the real connection resolves still receives everything the
   *  real adapter emits once it exists. Optional: `FakeAaiSocket` implements it for tests
   *  (item 4 of this lane's task); any `AaiSocket` that doesn't need to drive this test path
   *  need not. */
  onUnhandledMessage?(handler: (type: string, detail: string) => void): void;
  /** aai-observability lane (2026-09-16), item 3: registers a handler fired once per
   *  `transcript.agent.delta` chunk (docs/aai-docs-check-2026-09-01.md line 85, PROVEN
   *  fields: `reply_id`, `item_id`, `delta`, `start_ms`, `end_ms`) -- the unmodelled event
   *  type the dead-transcript investigation's own open question is about: did the words for
   *  a reply that never produced a final `transcript.agent` at least show up as deltas?
   *  Deliberately a SEPARATE channel from `onUnhandledMessage` above (not a `type ===
   *  'transcript.agent.delta'` case a caller has to filter out of that one) for two reasons:
   *  (1) deltas are the highest-frequency unmodelled message by far (one per streamed
   *  chunk, not one per reply), so folding them into the same rate-limited log there would
   *  either flood it or starve the rarer types of their own budget; (2) the caller needs
   *  structured `(reply_id, delta)` fields, not a re-parse of a 200-char-truncated JSON
   *  string that may have cut the delta text off mid-chunk. `CallSession` aggregates these
   *  per reply id itself (count, total length, last <=120 chars) -- this adapter tracks
   *  none of that bookkeeping, only relays. Optional, same reasoning as
   *  `onUnhandledMessage`. */
  onAgentTranscriptDelta?(handler: (reply_id: string, delta: string) => void): void;
}

/** Client -> AssemblyAI message that asks the agent to generate a reply right now, without
 *  waiting for the caller to speak first. Documented at
 *  https://www.assemblyai.com/docs/voice-agents/voice-agent-api/api-spec/voice-agent-websocket
 *  (fetched 2026-09-13): `type: "reply.create"`, optional `instructions` -- "Optional
 *  one-shot instructions the agent uses to compose this reply. Does not modify
 *  `system_prompt`." The docs are silent on whether it is safe to send while a reply is
 *  already in progress (between `reply.started` and `reply.done`) -- `call/session.ts`
 *  never does that: it defers sending until the in-flight reply's own `reply.done`, then
 *  only if the goal that reply was phrased under differs from the goal that needs saying. */
export interface ReplyCreateMessage {
  type: 'reply.create';
  instructions?: string;
}

/** Server <- AssemblyAI events actually used by S2 (a strict subset of the full events
 *  reference -- session.updated, transcript.*.delta, session.resume are not needed by the
 *  server-authoritative logs and are left out rather than modeled and ignored). */
export type AaiEvent =
  | { type: 'session.ready'; session_id: string }
  | { type: 'transcript.user'; item_id: string; text: string }
  | { type: 'transcript.agent'; item_id: string; text: string; reply_id: string; interrupted: boolean }
  | { type: 'reply.started'; reply_id: string }
  | { type: 'reply.audio'; data: string }
  | { type: 'reply.done'; reply_id: string; status: 'completed' | 'interrupted' | string }
  | { type: 'input.speech.started' }
  | { type: 'input.speech.stopped' }
  | { type: 'tool.call'; call_id: string; name: string; arguments: Record<string, unknown> }
  | { type: 'session.error'; code: string; message: string }
  // `reason` is a round-3 (S3 re-review) addition, additive/optional: the real adapter
  // (`session.ts`) sets it to 'link_lost' when its own bounded resume-on-drop gives up
  // (attempts exhausted, the 30s window passed, or nothing to resume against). A real
  // AssemblyAI-originated `session.ended` (mapped in `mapServerEvent`) never sets it --
  // `call/session.ts` falls back to its existing 'aai_ended' reason in that case.
  // session_duration_seconds and audio_duration_seconds are PROVEN from AssemblyAI's
  // events-reference docs (https://www.assemblyai.com/docs/voice-agents/voice-agent-api/events-reference):
  // the server sends them in the Termination event (session.ended type) and are used for billing.
  | { type: 'session.ended'; reason?: string; session_duration_seconds?: number; audio_duration_seconds?: number }
  // S3 extension: not an AssemblyAI wire event -- the real adapter (`src/aai/session.ts`)
  // synthesizes this around its own resume-on-drop handling so the screen can show "voice
  // link lost, security state preserved" without the call layer re-deriving anything (the
  // engine's verdict is untouched; only the transport dropped). FakeAaiSocket never emits it.
  // `attempt` is the 1-indexed resume attempt this event belongs to -- resume is bounded
  // (MAX_RESUME_ATTEMPTS in session.ts), so this also tells a viewer how close to giving up
  // the call is.
  | { type: 'link'; state: 'lost' | 'restored'; attempt: number };
