// packages/server/src/aai/fake.ts
// A scripted fake AssemblyAI socket. Used two ways:
//  1. Tests drive it directly with `.emit(event)` -- full control, no timers, pairs with an
//     injected clock on CallSession so t_ms in the resulting logs is deterministic.
//  2. `COUNTERSIGN_FAKE_AAI=1` dev mode (`src/index.ts`) hands one to every call session so
//     `npm run dev:server` runs the whole stack without an AssemblyAI API key. `playScript`
//     drives it from a corpus-shaped timeline in real (wall-clock) time.
// Implements the same `AaiSocket` interface the real S3 adapter will -- CallSession never
// knows which one it is holding.
import type { AaiEvent, AaiSocket } from './types.js';

export class FakeAaiSocket implements AaiSocket {
  /** Every message the session tried to send to "AssemblyAI" -- tests assert against this
   *  instead of a real network call (LAW: tests never call the live API). */
  readonly sent: object[] = [];

  private handlers: ((evt: AaiEvent) => void)[] = [];
  private closed = false;

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
}

export interface TimedAaiEvent {
  t_ms: number;
  event: AaiEvent;
}

/** Plays a timeline of events into `aai` using real setTimeout, scaled by `speed` (2 = twice
 *  as fast). Only used by dev mode -- tests use `FakeAaiSocket.emit` directly so they never
 *  depend on real timers. Returns a `stop()` to cancel any still-pending events (call on
 *  session end so a stale timer doesn't fire into a closed session). */
export function playScript(aai: FakeAaiSocket, script: TimedAaiEvent[], speed = 1): { stop: () => void } {
  const safeSpeed = Number.isFinite(speed) && speed > 0 ? speed : 1;
  const timers = script.map(({ t_ms, event }) => setTimeout(() => aai.emit(event), t_ms / safeSpeed));
  return {
    stop: () => {
      for (const t of timers) clearTimeout(t);
    },
  };
}
