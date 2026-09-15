import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RecentCalls from '../src/components/RecentCalls';

// Mock the clipboard API
vi.stubGlobal('navigator', {
  clipboard: {
    writeText: vi.fn().mockResolvedValue(undefined),
  },
});

describe('RecentCalls', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('renders nothing when no recent calls exist', () => {
    const { container } = render(<RecentCalls />);
    expect(container.querySelector('.recent-calls')).toBeNull();
  });

  it('renders recent calls from localStorage', async () => {
    const calls = [
      { code: 'aaaaaaaa', full_id: 'aaaaaaaa-1111-1111-1111-111111111111', ended_at: '2024-01-01T12:30:45Z', verdict: 'STAGE' },
      { code: 'bbbbbbbb', full_id: 'bbbbbbbb-2222-2222-2222-222222222222', ended_at: '2024-01-01T12:31:00Z', verdict: 'FREEZE' },
    ];
    localStorage.setItem('countersign_recent_calls', JSON.stringify(calls));

    render(<RecentCalls />);

    await waitFor(() => {
      expect(screen.getByText('Your recent calls')).toBeInTheDocument();
    });
    expect(screen.getByText('aaaaaaaa')).toBeInTheDocument();
    expect(screen.getByText('bbbbbbbb')).toBeInTheDocument();
    expect(screen.getByText('STAGE')).toBeInTheDocument();
    expect(screen.getByText('FREEZE')).toBeInTheDocument();
  });

  it('renders the privacy note', async () => {
    const calls = [
      { code: 'aaaaaaaa', full_id: 'aaaaaaaa-1111-1111-1111-111111111111', ended_at: '2024-01-01T12:30:45Z', verdict: 'STAGE' },
    ];
    localStorage.setItem('countersign_recent_calls', JSON.stringify(calls));

    render(<RecentCalls />);

    await waitFor(() => {
      expect(screen.getByText(/This list is stored on your browser and is private to it/)).toBeInTheDocument();
    });
  });

  it('renders nothing when localStorage is unavailable and throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('Storage error');
    });

    const { container } = render(<RecentCalls />);
    expect(container.querySelector('.recent-calls')).toBeNull();
  });

  // Component render tests are covered by the library tests above.
  // These tests verify the component renders without errors when localStorage has data.
});
