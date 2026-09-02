// packages/server/src/ws/throttle.ts
// Extracted from browser.ts's `makeThrottledSender` so its exact timing (leading-edge send,
// trailing coalesced flush of the LATEST item, one send per window) can be unit-tested with
// vitest fake timers instead of racing real ~66ms windows against real 300ms waits under CI
// load. Behaviour is unchanged from the inline version this replaced -- only the clock/timer
// are now injectable (defaulting to the real `Date.now`/`setTimeout`/`clearTimeout`), so
// browser.ts's production behaviour is identical.

/** The clock and timer primitives a throttle needs. Defaults to the real ones; tests inject
 *  vitest's fake-timer-backed globals (`Date.now`, `setTimeout`, `clearTimeout` still work
 *  under `vi.useFakeTimers()` without any injection at all, since they're read from
 *  `globalThis` at call time below -- this interface exists so a test can also swap in an
 *  explicit fake clock if it ever needs to, without touching real global timers). */
export interface ThrottleClock {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (t: ReturnType<typeof setTimeout>) => void;
}

export const realClock: ThrottleClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
};

/** Matches config.ts's/browser.ts's documented ~66ms state-coalescing window (see browser.ts's
 *  own module comment for why 66ms: ~15fps, matching the throttled UI update rate). */
export const THROTTLE_WINDOW_MS = 66;

/** Coalesces calls to `send` to at most one per `windowMs`: the first call in a window goes
 *  out immediately (leading edge); every call arriving before the window elapses replaces a
 *  pending item and schedules exactly one trailing flush, at the window boundary, carrying
 *  only the LATEST item (earlier ones in the same window are superseded, never sent). A
 *  window with no calls at all schedules nothing. */
export function makeThrottle<T>(
  send: (item: T) => void,
  windowMs: number = THROTTLE_WINDOW_MS,
  clock: ThrottleClock = realClock,
): (item: T) => void {
  let lastSentAt = -Infinity;
  let pending: T | null = null;
  let hasPending = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function flush(): void {
    timer = null;
    if (hasPending) {
      lastSentAt = clock.now();
      const item = pending as T;
      pending = null;
      hasPending = false;
      send(item);
    }
  }

  return (item: T) => {
    const now = clock.now();
    if (now - lastSentAt >= windowMs) {
      lastSentAt = now;
      pending = null;
      hasPending = false;
      send(item);
      return;
    }
    pending = item;
    hasPending = true;
    if (!timer) {
      timer = clock.setTimeout(flush, windowMs - (now - lastSentAt));
    }
  };
}
