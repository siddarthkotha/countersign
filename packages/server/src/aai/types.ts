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
  | { type: 'session.ended' }
  // S3 extension: not an AssemblyAI wire event -- the real adapter (`src/aai/session.ts`)
  // synthesizes this around its own resume-on-drop handling so the screen can show "voice
  // link lost, security state preserved" without the call layer re-deriving anything (the
  // engine's verdict is untouched; only the transport dropped). FakeAaiSocket never emits it.
  | { type: 'link'; state: 'lost' | 'restored' };
