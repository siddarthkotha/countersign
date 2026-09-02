// packages/server/test/throttle.test.ts
// Deterministic replacement for the timing assertions that used to live inline in
// browser-ws.test.ts's "throttles rapid state updates" test. That test drove a real WebSocket
// through a real ~66ms window and proved an absence (no more than one trailing flush) with a
// fixed 300ms real wait -- correct, but flaky under load (a slow CI runner can shift a
// setTimeout(flushPending, ~66ms) enough to blur the boundary the assertion depends on).
//
// `makeThrottle` (packages/server/src/ws/throttle.ts) is a pure function of an injectable
// clock/timer, so vitest fake timers can drive it exactly: `vi.advanceTimersByTime` moves the
// clock in zero wall-clock time, so "assert nothing fires inside the window" and "assert the
// trailing flush fires exactly at the window boundary, carrying the LATEST item" are both
// exact assertions, not races.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeThrottle, THROTTLE_WINDOW_MS } from '../src/ws/throttle.js';

describe('ws/throttle — makeThrottle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends the first call in a window immediately (leading edge)', () => {
    const sent: number[] = [];
    const throttled = makeThrottle<number>((n) => sent.push(n));

    throttled(1);

    expect(sent).toEqual([1]);
  });

  it('coalesces a burst within one window to exactly one send, at the window boundary, carrying the LATEST item', () => {
    const sent: number[] = [];
    const throttled = makeThrottle<number>((n) => sent.push(n));

    throttled(1); // leading edge -- sent immediately
    expect(sent).toEqual([1]);

    // A burst of further calls, all well inside the same window.
    for (let i = 2; i <= 10; i++) throttled(i);

    // Nothing extra has fired yet -- proven exactly, not raced: fake time has not moved.
    expect(sent).toEqual([1]);

    // Advance right up to (but not past) the window boundary: still nothing extra.
    vi.advanceTimersByTime(THROTTLE_WINDOW_MS - 1);
    expect(sent).toEqual([1]);

    // Cross the boundary: exactly one trailing flush, carrying the LAST item pushed (10),
    // never an intermediate one and never one send per burst call.
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([1, 10]);

    // No further sends invented out of nothing once the window is fully spent.
    vi.advanceTimersByTime(THROTTLE_WINDOW_MS * 5);
    expect(sent).toEqual([1, 10]);
  });

  it('sends immediately for each call spaced a full window apart, across many consecutive windows', () => {
    const sent: number[] = [];
    const throttled = makeThrottle<number>((n) => sent.push(n));

    // Each call lands exactly on (or after) its own window boundary -- a fresh leading-edge
    // send every time, nothing ever coalesced, no timer ever left pending.
    for (let window = 0; window < 5; window++) {
      throttled(window);
      vi.advanceTimersByTime(THROTTLE_WINDOW_MS);
    }

    expect(sent).toEqual([0, 1, 2, 3, 4]);
  });

  it('a call exactly at or after the window boundary starts a fresh leading-edge send, not a coalesced flush', () => {
    const sent: number[] = [];
    const throttled = makeThrottle<number>((n) => sent.push(n));

    throttled(1);
    expect(sent).toEqual([1]);

    vi.advanceTimersByTime(THROTTLE_WINDOW_MS);
    throttled(2);

    // Sent immediately (leading edge of the new window) -- no trailing-flush delay stacked on
    // top of the window boundary.
    expect(sent).toEqual([1, 2]);
  });

  it('a lone call with nothing after it still flushes at the window boundary', () => {
    const sent: number[] = [];
    const throttled = makeThrottle<number>((n) => sent.push(n));

    throttled(1);
    vi.advanceTimersByTime(1); // now inside the same window, not at the leading edge anymore
    throttled(2); // the only coalesced call this window

    vi.advanceTimersByTime(THROTTLE_WINDOW_MS - 1);
    expect(sent).toEqual([1, 2]);
  });

  it('a window with no calls schedules nothing (no phantom sends)', () => {
    const sent: number[] = [];
    makeThrottle<number>((n) => sent.push(n));

    vi.advanceTimersByTime(THROTTLE_WINDOW_MS * 10);

    expect(sent).toEqual([]);
  });
});
