import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRecentCalls, addRecentCall, clearRecentCalls, type RecentCall } from '../src/lib/recentCalls';

describe('recentCalls', () => {
  beforeEach(() => {
    // Clear localStorage before each test
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('returns empty array when no calls stored', () => {
    const calls = getRecentCalls();
    expect(calls).toEqual([]);
  });

  it('adds a recent call and retrieves it', () => {
    const fullId = '11111111-2222-2222-2222-333333333333';
    addRecentCall(fullId, 'STAGE');

    const calls = getRecentCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.code).toBe('11111111');
    expect(calls[0]?.full_id).toBe(fullId);
    expect(calls[0]?.verdict).toBe('STAGE');
  });

  it('stores multiple calls newest first', () => {
    addRecentCall('aaaaaaaa-1111-1111-1111-111111111111', 'STAGE');
    addRecentCall('bbbbbbbb-2222-2222-2222-222222222222', 'FREEZE');

    const calls = getRecentCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.code).toBe('bbbbbbbb');
    expect(calls[1]?.code).toBe('aaaaaaaa');
  });

  it('caps the list at 20 calls', () => {
    for (let i = 0; i < 25; i++) {
      addRecentCall(`id-${i}-1111-1111-1111-111111111111`, 'STAGE');
    }

    const calls = getRecentCalls();
    expect(calls).toHaveLength(20);
    // Newest calls should be first (id-24 to id-5)
    expect(calls[0]?.full_id).toContain('id-24');
    expect(calls[19]?.full_id).toContain('id-5');
  });

  it('handles null verdict', () => {
    addRecentCall('11111111-2222-2222-2222-333333333333', null);

    const calls = getRecentCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.verdict).toBeNull();
  });

  it('returns empty array when localStorage is corrupted', () => {
    localStorage.setItem('countersign_recent_calls', 'invalid json {[}');

    const calls = getRecentCalls();
    expect(calls).toEqual([]);
  });

  it('clears all recent calls', () => {
    addRecentCall('11111111-2222-2222-2222-333333333333', 'STAGE');
    clearRecentCalls();

    const calls = getRecentCalls();
    expect(calls).toEqual([]);
  });

  it('filters out malformed entries when reading', () => {
    // Manually insert a mix of valid and invalid entries
    const entries: unknown[] = [
      { code: 'aaaaaaaa', full_id: '11111111-1111-1111-1111-111111111111', ended_at: '2024-01-01T00:00:00Z', verdict: 'STAGE' },
      { code: 'bbbbbbbb', full_id: 'not-a-uuid', ended_at: 999 }, // Invalid: ended_at is not a string
      { code: 'cccccccc', full_id: '33333333-3333-3333-3333-333333333333', ended_at: '2024-01-01T00:00:00Z', verdict: null },
    ];
    localStorage.setItem('countersign_recent_calls', JSON.stringify(entries));

    const calls = getRecentCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.code).toBe('aaaaaaaa');
    expect(calls[1]?.code).toBe('cccccccc');
  });
});
