// packages/web/test/worker-reconnect.test.ts
// TDD for the reconnect-with-backoff logic in src/ws/worker.ts. `createConnection` is pulled
// out of the dedicated-worker-scope block (same reason `createStateThrottle` is standalone,
// test/worker-throttle.test.ts) so it can be driven here with a fake `WebSocketFactory` and
// fake timers instead of a real Worker/socket context.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnection, RECONNECT_BACKOFF_MS, type MinimalWebSocket, type WebSocketFactory } from '../src/ws/worker';
import type { ServerEvent } from '@countersign/engine';

/** A scripted fake socket: each `wsFactory(url)` call consumes the next entry in `script`
 *  ('open' -- calls onopen on the next microtask/timer tick; 'fail' -- calls onclose without
 *  ever calling onopen, simulating a drop/refused connection). Extra calls beyond the script
 *  keep behaving like the last scripted entry, so a test doesn't have to enumerate every
 *  attempt up to exhaustion. */
function makeScriptedFactory(script: ('open' | 'fail')[]): { factory: WebSocketFactory; sockets: MinimalWebSocket[] } {
  let i = 0;
  const sockets: MinimalWebSocket[] = [];
  const factory: WebSocketFactory = () => {
    const outcome = script[Math.min(i, script.length - 1)]!;
    i += 1;
    const sock: MinimalWebSocket = {
      onopen: null,
      onclose: null,
      onmessage: null,
      readyState: outcome === 'open' ? 1 : 0,
      send: vi.fn(),
      close: vi.fn(() => {
        sock.onclose?.();
      }),
    };
    sockets.push(sock);
    // Real WebSockets never call onopen/onclose synchronously inside the constructor --
    // schedule on a macrotask so fake-timer advances (which is how the test drives retry
    // delays) also drive these.
    setTimeout(() => {
      if (outcome === 'open') sock.onopen?.();
      else sock.onclose?.();
    }, 0);
    return sock;
  };
  return { factory, sockets };
}

describe('createConnection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A retry timer that lands exactly on `ms` schedules its OWN 0ms follow-up when it fires
   *  (the scripted factory's onopen/onclose tick) -- landing exactly on the boundary of a
   *  `vi.advanceTimersByTimeAsync(ms)` call leaves that follow-up unrun. The 1ms of slack
   *  clears it without any risk of also reaching the NEXT retry's much larger delay
   *  (minimum 500ms away). */
  async function advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms + 1);
  }

  it('a clean initial connect posts nothing extra (no link event) once open', async () => {
    const { factory } = makeScriptedFactory(['open']);
    const posted: ServerEvent[] = [];
    createConnection('/ws/call/x', (e) => posted.push(e), factory);

    await vi.advanceTimersByTimeAsync(0);

    expect(posted).toEqual([]);
  });

  it('retries with the documented backoff and emits link:lost then link:restored (fails twice, then succeeds)', async () => {
    const { factory, sockets } = makeScriptedFactory(['fail', 'fail', 'open']);
    const posted: ServerEvent[] = [];
    createConnection('/ws/call/x', (e) => posted.push(e), factory);

    // Initial attempt fails.
    await advance(0);
    expect(posted).toEqual([{ type: 'link', state: 'lost', dropped_frames: 0 }]);
    expect(sockets).toHaveLength(1);

    // First retry, after RECONNECT_BACKOFF_MS[0] -- also fails.
    await advance(RECONNECT_BACKOFF_MS[0]!);
    expect(sockets).toHaveLength(2);
    // Still just the one 'lost' -- a already-known-down link doesn't re-announce itself.
    expect(posted).toEqual([{ type: 'link', state: 'lost', dropped_frames: 0 }]);

    // Second retry, after RECONNECT_BACKOFF_MS[1] -- succeeds.
    await advance(RECONNECT_BACKOFF_MS[1]!);
    expect(sockets).toHaveLength(3);
    expect(posted).toEqual([
      { type: 'link', state: 'lost', dropped_frames: 0 },
      { type: 'link', state: 'restored', dropped_frames: 0 },
    ]);
  });

  it('counts audio frames dropped while the link is down and carries the count on link:restored, then resets', async () => {
    const { factory, sockets } = makeScriptedFactory(['fail', 'open']);
    const posted: ServerEvent[] = [];
    const conn = createConnection('/ws/call/x', (e) => posted.push(e), factory);

    // Initial attempt fails -- link is down now.
    await advance(0);
    expect(posted).toEqual([{ type: 'link', state: 'lost', dropped_frames: 0 }]);

    // Capture keeps running: two audio frames posted while there is nowhere for them to go.
    conn.send({ type: 'audio', data: 'frame-1' });
    conn.send({ type: 'audio', data: 'frame-2' });
    expect(sockets[0]!.send).not.toHaveBeenCalled();

    // The retry succeeds -- link:restored carries exactly how many frames were lost.
    await advance(RECONNECT_BACKOFF_MS[0]!);
    expect(posted).toEqual([
      { type: 'link', state: 'lost', dropped_frames: 0 },
      { type: 'link', state: 'restored', dropped_frames: 2 },
    ]);

    // The counter reset with the restore: a frame sent now (link is up) is delivered, not
    // counted as dropped.
    conn.send({ type: 'audio', data: 'frame-3' });
    expect(sockets[1]!.send).toHaveBeenCalledWith(JSON.stringify({ type: 'audio', data: 'frame-3' }));
  });

  it('exhausting every retry attempt emits ended with reason link_lost, never looping forever', async () => {
    const { factory, sockets } = makeScriptedFactory(['fail', 'fail', 'fail', 'fail', 'fail']);
    const posted: ServerEvent[] = [];
    createConnection('/ws/call/x', (e) => posted.push(e), factory);

    let elapsed = 0;
    for (const delay of [0, ...RECONNECT_BACKOFF_MS]) {
      await advance(delay);
      elapsed += delay;
    }

    // Initial attempt + 4 retries = 5 sockets total, matching "max 4 attempts".
    expect(sockets).toHaveLength(1 + RECONNECT_BACKOFF_MS.length);
    expect(posted).toEqual([
      { type: 'link', state: 'lost', dropped_frames: 0 },
      { type: 'ended', reason: 'link_lost' },
    ]);
    // ~7.5s total, comfortably inside the server's default 20s browser grace window.
    expect(elapsed).toBeLessThan(20000);

    // No further sockets are opened after exhaustion.
    const countAfterExhaustion = sockets.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(sockets).toHaveLength(countAfterExhaustion);
  });

  it('forwards a message posted through the connection to the live socket, JSON-encoded', async () => {
    const { factory, sockets } = makeScriptedFactory(['open']);
    const conn = createConnection('/ws/call/x', () => {}, factory);
    await vi.advanceTimersByTimeAsync(0);

    conn.send({ type: 'audio', data: 'AAAA' });

    expect(sockets[0]!.send).toHaveBeenCalledWith(JSON.stringify({ type: 'audio', data: 'AAAA' }));
  });

  it('drops a message silently while the link is down (nowhere for it to go)', async () => {
    const { factory, sockets } = makeScriptedFactory(['fail', 'open']);
    const conn = createConnection('/ws/call/x', () => {}, factory);
    await vi.advanceTimersByTimeAsync(0); // initial attempt fails -- link is down now

    conn.send({ type: 'audio', data: 'dropped' });

    expect(sockets[0]!.send).not.toHaveBeenCalled();
  });

  it('markIntentionalClose stops retrying once the socket it closes actually closes', async () => {
    const { factory, sockets } = makeScriptedFactory(['open']);
    const posted: ServerEvent[] = [];
    const conn = createConnection('/ws/call/x', (e) => posted.push(e), factory);
    await vi.advanceTimersByTimeAsync(0);

    conn.markIntentionalClose();

    expect(sockets[0]!.close).toHaveBeenCalled();
    // No reconnect attempted, and no 'lost'/'ended(link_lost)' noise for an intentional end.
    await vi.advanceTimersByTimeAsync(60000);
    expect(sockets).toHaveLength(1);
    expect(posted).toEqual([]);
  });

  it('an `ended` ServerEvent from the server marks the connection intentional -- the socket close that follows never triggers a reconnect', async () => {
    const { factory, sockets } = makeScriptedFactory(['open']);
    const posted: ServerEvent[] = [];
    createConnection('/ws/call/x', (e) => posted.push(e), factory);
    await vi.advanceTimersByTimeAsync(0);

    sockets[0]!.onmessage?.({ data: JSON.stringify({ type: 'ended', reason: 'idle_timeout' }) });
    sockets[0]!.onclose?.();

    await vi.advanceTimersByTimeAsync(60000);
    expect(sockets).toHaveLength(1);
    expect(posted).toEqual([{ type: 'ended', reason: 'idle_timeout' }]);
  });
});
