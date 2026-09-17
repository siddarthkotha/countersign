// packages/server/src/aai/fake.ts
// A fake AssemblyAI socket for tests and dev mode. Used two ways:
//  1. Tests drive it directly with `.emit(event)` -- full control, no timers, pairs with an
//     injected clock on CallSession so t_ms in the resulting logs is deterministic.
//  2. `COUNTERSIGN_FAKE_AAI=1` dev mode (`src/index.ts`) hands one to every call session so
//     `npm run dev:server` runs the whole stack without an AssemblyAI API key.
// Implements the same `AaiSocket` interface the real S3 adapter will -- CallSession never
// knows which one it is holding.
import type { AaiEvent, AaiSocket } from './types.js';

export class FakeAaiSocket implements AaiSocket {
  /** Every message the session tried to send to "AssemblyAI" -- tests assert against this
   *  instead of a real network call (LAW: tests never call the live API). */
  readonly sent: object[] = [];

  private handlers: ((evt: AaiEvent) => void)[] = [];
  private closed = false;
  /** aai-observability lane (2026-09-16, item 4): mirrors `RealAaiSocket`'s own subscriber
   *  lists (aai/session.ts) so a test can drive `CallSession`'s `aai_unhandled_message` /
   *  `aai_transcript_deltas` diagnostics through the exact same `AaiSocket` interface a real
   *  call uses, without a real AssemblyAI connection (LAW: tests never call the live API). */
  private unhandledHandlers: ((type: string, detail: string) => void)[] = [];
  private agentDeltaHandlers: ((reply_id: string, delta: string) => void)[] = [];

  send(msg: object): void {
    if (this.closed) return;
    this.sent.push(msg);
  }

  on(handler: (evt: AaiEvent) => void): void {
    this.handlers.push(handler);
  }

  close(): void {
    this.closed = true;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Test/dev-mode entry point: deliver one event to every registered handler, synchronously,
   *  unless the socket has been closed (mirrors a real socket going silent after close()). */
  emit(evt: AaiEvent): void {
    if (this.closed) return;
    for (const handler of this.handlers) handler(evt);
  }

  /** Wiring-level counterpart to `RealAaiSocket.debugForceDrop` (aai/session.ts) -- this
   *  fake has no resume-on-drop logic to exercise (that only exists in the real adapter), so
   *  it just records that the drop reached this far, for ws/browser.ts's own `dropAai` test
   *  to assert against (the real resume path itself is proven in aai-session.test.ts, against
   *  `RealAaiSocket`, never here). */
  debugDropCount = 0;
  debugForceDrop(): boolean {
    if (this.closed) return false;
    this.debugDropCount += 1;
    return true;
  }

  /** aai-observability lane (2026-09-16, item 4): see `AaiSocket.onUnhandledMessage`'s doc
   *  comment in `types.ts`. */
  onUnhandledMessage(handler: (type: string, detail: string) => void): void {
    this.unhandledHandlers.push(handler);
  }

  /** aai-observability lane (2026-09-16, item 4): see `AaiSocket.onAgentTranscriptDelta`'s
   *  doc comment in `types.ts`. */
  onAgentTranscriptDelta(handler: (reply_id: string, delta: string) => void): void {
    this.agentDeltaHandlers.push(handler);
  }

  /** Test entry point mirroring `emit()` above, for a server message this fake's `AaiEvent`
   *  union has no shape for at all (aai/session.ts's `mapServerEvent` default branch) --
   *  lets a test drive `CallSession`'s `aai_unhandled_message` diagnostics with no real
   *  AssemblyAI connection. */
  emitUnhandledMessage(type: string, detail: string): void {
    if (this.closed) return;
    for (const h of this.unhandledHandlers) h(type, detail);
  }

  /** Test entry point for a `transcript.agent.delta` chunk -- see `emitUnhandledMessage`'s
   *  own doc comment for why deltas get their own dedicated entry point (matching the real
   *  adapter's own split). */
  emitAgentDelta(reply_id: string, delta: string): void {
    if (this.closed) return;
    for (const h of this.agentDeltaHandlers) h(reply_id, delta);
  }
}
