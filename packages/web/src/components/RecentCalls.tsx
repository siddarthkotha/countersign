// packages/web/src/components/RecentCalls.tsx
// Display a list of recent call codes on the Landing screen. Allows copying the full session id.
// Data is stored in localStorage, per-browser and private to this browser.

import { useState, useEffect } from 'react';
import type { RecentCall } from '../lib/recentCalls';
import { getRecentCalls } from '../lib/recentCalls';

export default function RecentCalls() {
  const [calls, setCalls] = useState<RecentCall[]>([]);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    const recentCalls = getRecentCalls();
    setCalls(recentCalls);
  }, []);

  async function copyToClipboard(fullId: string) {
    try {
      await navigator.clipboard.writeText(fullId);
      setCopied(fullId);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // Clipboard unavailable, silently fail
    }
  }

  if (calls.length === 0) return null;

  function formatTime(isoString: string): string {
    try {
      const date = new Date(isoString);
      return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
      return isoString;
    }
  }

  return (
    <div className="recent-calls">
      <h3>Your recent calls</h3>
      <ul>
        {calls.map((call) => (
          <li key={call.full_id}>
            <span className="call-code">{call.code}</span>
            <span className="call-time">{formatTime(call.ended_at)}</span>
            {call.verdict && <span className="call-verdict">{call.verdict}</span>}
            <button
              onClick={() => copyToClipboard(call.full_id)}
              className="copy-button"
              title={call.full_id}
              type="button"
            >
              {copied === call.full_id ? 'Copied' : 'Copy'}
            </button>
          </li>
        ))}
      </ul>
      <p className="recent-calls-note">This list is stored on your browser and is private to it.</p>
    </div>
  );
}
