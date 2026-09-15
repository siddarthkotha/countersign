// packages/web/src/lib/recentCalls.ts
// Per-browser memory of recent call codes: session id prefix (8 chars), full id, timestamp, verdict.
// Stored in localStorage, newest first, capped at 20. Every operation is wrapped in try/catch.

export interface RecentCall {
  code: string; // First 8 characters of session_id
  full_id: string; // Full UUID
  ended_at: string; // ISO 8601 timestamp
  verdict: string | null; // Terminal verdict ('STAGE', 'FREEZE', 'ESCALATE', 'NO_ACTION') or null
}

const STORAGE_KEY = 'countersign_recent_calls';
const MAX_RECENT_CALLS = 20;

export function getRecentCalls(): RecentCall[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored) as unknown;
    if (!Array.isArray(parsed)) return [];
    // Basic type check: ensure each entry looks like a RecentCall
    return parsed.filter(
      (item): item is RecentCall =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Record<string, unknown>).code === 'string' &&
        typeof (item as Record<string, unknown>).full_id === 'string' &&
        typeof (item as Record<string, unknown>).ended_at === 'string' &&
        ((item as Record<string, unknown>).verdict === null || typeof (item as Record<string, unknown>).verdict === 'string'),
    );
  } catch {
    // localStorage unavailable or corrupted
    return [];
  }
}

export function addRecentCall(fullId: string, verdict: string | null): void {
  try {
    const calls = getRecentCalls();
    const newCall: RecentCall = {
      code: fullId.slice(0, 8),
      full_id: fullId,
      ended_at: new Date().toISOString(),
      verdict,
    };
    const updated = [newCall, ...calls].slice(0, MAX_RECENT_CALLS);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // localStorage unavailable, silently fail (don't break the app)
  }
}

export function clearRecentCalls(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage unavailable, silently fail
  }
}
