// packages/server/test/late-session-ended.test.ts
// Tests for the fix: session.ended arriving after the browser has already hung up
// and ended the bundle. Verifies that billed_seconds gets set on the bundle and
// aai_session_terminated is recorded exactly once per session.

import { describe, it, expect, beforeEach } from 'vitest';
import { newDiagnosticsState, createBundle, endBundle, recordServerEvent, recordTerminationEvent } from '../src/diagnostics.js';

describe('late session.ended (session.ended after browser hangup)', () => {
  let diagnostics = newDiagnosticsState();
  const sessionId = 'session-123';
  const now = () => 1000;

  beforeEach(() => {
    diagnostics = newDiagnosticsState();
  });

  it('(a) session.ended 300ms after browser hangup: bundle.billed_seconds set and exactly one aai_session_terminated event', () => {
    // Create bundle
    const bundle = createBundle(diagnostics, sessionId, now());

    // Simulate browser hangup - end the bundle
    endBundle(diagnostics, sessionId, now() + 50, 'caller_ended');
    expect(bundle.billed_seconds).toBeUndefined();
    expect(bundle.ended_at).toBe(now() + 50);

    // Simulate late session.ended arriving 300ms after hangup
    const sessionDurationSeconds = 32.289846;
    const audioDurationSeconds = 31.5;
    recordTerminationEvent(diagnostics, sessionId, now() + 350, {
      session_duration_seconds: sessionDurationSeconds,
      audio_duration_seconds: audioDurationSeconds,
    });

    // Verify billed_seconds is set
    expect(bundle.billed_seconds).toBe(sessionDurationSeconds);

    // Verify exactly one aai_session_terminated event exists
    const terminationEvents = bundle.server_events.filter(e => e.kind === 'aai_session_terminated');
    expect(terminationEvents).toHaveLength(1);
    expect(terminationEvents[0]?.detail).toEqual({
      session_duration_seconds: sessionDurationSeconds,
      audio_duration_seconds: audioDurationSeconds,
    });
  });

  it('(b) session.ended before hangup: exactly one event and value set', () => {
    // Create bundle
    const bundle = createBundle(diagnostics, sessionId, now());

    // Record termination event BEFORE bundle is ended
    const sessionDurationSeconds = 32.289846;
    const audioDurationSeconds = 31.5;
    recordTerminationEvent(diagnostics, sessionId, now() + 50, {
      session_duration_seconds: sessionDurationSeconds,
      audio_duration_seconds: audioDurationSeconds,
    });

    // Now end the bundle (simulating browser hangup)
    endBundle(diagnostics, sessionId, now() + 100, 'caller_ended');

    // Verify billed_seconds is set
    expect(bundle.billed_seconds).toBe(sessionDurationSeconds);

    // Verify exactly one aai_session_terminated event exists
    const terminationEvents = bundle.server_events.filter(e => e.kind === 'aai_session_terminated');
    expect(terminationEvents).toHaveLength(1);
  });

  it('(c) session.ended without numeric field: no aai_session_terminated, billed_seconds stays undefined', () => {
    // Create bundle
    const bundle = createBundle(diagnostics, sessionId, now());

    // End the bundle
    endBundle(diagnostics, sessionId, now() + 50, 'caller_ended');

    // Record termination event WITHOUT numeric session_duration_seconds
    recordTerminationEvent(diagnostics, sessionId, now() + 350, {
      timestamp: 1234567890,
      type: 'session.ended',
      // no session_duration_seconds
    });

    // Verify billed_seconds is NOT set
    expect(bundle.billed_seconds).toBeUndefined();

    // Verify NO aai_session_terminated event was recorded (only aai_session_ended_raw is recorded elsewhere)
    const terminationEvents = bundle.server_events.filter(e => e.kind === 'aai_session_terminated');
    expect(terminationEvents).toHaveLength(0);
  });

  it('guards against duplicate aai_session_terminated recording', () => {
    // Create bundle
    const bundle = createBundle(diagnostics, sessionId, now());

    // Record first termination event
    recordTerminationEvent(diagnostics, sessionId, now() + 50, {
      session_duration_seconds: 32.289846,
      audio_duration_seconds: 31.5,
    });

    // Record second termination event for same session
    recordTerminationEvent(diagnostics, sessionId, now() + 100, {
      session_duration_seconds: 32.289846,
      audio_duration_seconds: 31.5,
    });

    // Verify exactly ONE aai_session_terminated event (not two)
    const terminationEvents = bundle.server_events.filter(e => e.kind === 'aai_session_terminated');
    expect(terminationEvents).toHaveLength(1);
  });
});
