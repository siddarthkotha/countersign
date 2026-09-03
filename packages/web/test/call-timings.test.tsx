// packages/web/test/call-timings.test.tsx
// TDD for Task W8 (G5 rehearsal latency): Call.tsx must record three browser-measured
// `performance.now()` timings per call -- start (Start Call click) -> ready (first `state`
// ServerEvent), ready -> first agent audio chunk, and each turn's user-final-transcript-line
// -> first-agent-audio gap -- show them in the forensic section's "Timings" line, and log one
// `[countersign:timings]` JSON line to the console on call end. `connect` (src/ws/client.ts)
// is mocked with a fake client whose `onAudio` is MULTICAST (an array of callbacks), mirroring
// the real client.ts contract after this task's fix (Call.tsx registers a SECOND `onAudio`
// listener purely for timing, alongside `connect()`'s own playback-pushing one) -- a
// single-callback fake would silently drop one of the two and hide a real regression.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BrowserEvent, ScreenState } from '@countersign/engine';
import Call from '../src/screens/Call';
import { connect } from '../src/ws/client';

vi.mock('../src/ws/client', () => ({
  connect: vi.fn(),
  connectSocketOnly: vi.fn(),
}));

const SESSION = { session_id: 'sess-123', ws_path: '/ws/call/sess-123', cap_seconds: 180 };

function baseState(transcript: ScreenState['transcript']): ScreenState {
  return {
    session_id: SESSION.session_id,
    t_ms: 0,
    state: 'EVIDENCE',
    verdict: 'PENDING',
    reasons: [],
    request: { claimed_identity: 'Robert Miller', amount_usd: 50000, beneficiary: 'Marcus Obi', request_version: 1 },
    gates: { context: 'PASS', device: 'PASS', consistency: 'PASS' },
    transcript,
    agent_status: 'VERIFYING',
    banner: null,
    forensic: {
      evidence: [],
      ledger: [],
      challenges: { issued: [], results: {} },
      assurance: {
        identity_claimed: true,
        sso_pass_current: true,
        oob_confirmed_current: false,
        context_pass_current: true,
        no_contradictions: true,
        critical_fields_confirmed: false,
        exposure_within_limit: true,
        challenge_requirement_met: false,
        no_identity_switch: true,
        not_new_beneficiary: true,
      },
      counterfactuals: [],
      export_hash: null,
      countersign: { server_verdict: 'STAGE', recomputed: true },
    },
    simulated: true,
    link: 'live',
  };
}

function makeFakeClient() {
  let stateCb: ((state: ScreenState) => void) | null = null;
  let endedCb: ((reason: string) => void) | null = null;
  const audioCbs: (() => void)[] = [];
  const send = vi.fn<(e: BrowserEvent) => void>();
  const close = vi.fn();

  const client = {
    send,
    onState(cb: (state: ScreenState) => void) {
      stateCb = cb;
    },
    onAudio(cb: () => void) {
      audioCbs.push(cb);
    },
    onFlush() {
      // Not exercised here.
    },
    onEnded(cb: (reason: string) => void) {
      endedCb = cb;
    },
    onLink() {
      // Not exercised here.
    },
    close,
    capture: { stop: vi.fn() },
    playback: { flush: vi.fn(), push: vi.fn(), level: vi.fn(), close: vi.fn() },
  };

  return {
    client,
    emitState: (state: ScreenState) => stateCb?.(state),
    emitAudio: () => audioCbs.forEach((cb) => cb()),
    emitEnded: (reason: string) => endedCb?.(reason),
    send,
    close,
  };
}

describe('Call timings (Task W8)', () => {
  let now: number;

  beforeEach(() => {
    now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('AudioContext', class {} as unknown as typeof AudioContext);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    vi.mocked(connect).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('measures start->ready, ready->first-audio and per-turn gaps, shows them in the forensic Timings line, and logs one JSON line to the console on call end', async () => {
    const fake = makeFakeClient();
    vi.mocked(connect).mockResolvedValue(fake.client as never);
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const user = userEvent.setup();

    render(<Call session={SESSION} onStartOver={vi.fn()} onWatch={vi.fn()} />);

    // t=1000: Start Call click.
    await user.click(screen.getByRole('button', { name: 'Start Call' }));

    // t=1300: first `state` ServerEvent -- ready. Empty transcript, so no turn gap starts.
    now = 1300;
    fake.emitState(baseState([]));
    await screen.findByText(/Claimed identity:/);

    // t=1800: a new caller transcript line appears -- end of this turn's user speech.
    now = 1800;
    fake.emitState(baseState([{ id: 'u1', speaker: 'caller', text: 'This is Robert Miller.', t_ms: 500 }]));

    // t=1850: first agent audio chunk -- closes both "ready->first audio" and this turn's gap.
    now = 1850;
    fake.emitAudio();

    // t=2500: a second new caller line -- second turn starts.
    now = 2500;
    fake.emitState(
      baseState([
        { id: 'u1', speaker: 'caller', text: 'This is Robert Miller.', t_ms: 500 },
        { id: 'u2', speaker: 'caller', text: 'Wire fifty thousand to Marcus Obi.', t_ms: 2000 },
      ]),
    );

    // t=2600: second agent audio chunk -- closes the second turn's gap (first-audio already set).
    now = 2600;
    fake.emitAudio();

    // Reveal the forensic section and check the Timings line reflects all three numbers.
    await user.click(screen.getByRole('button', { name: 'Why?' }));
    const timingsLine = await screen.findByText(/start→ready 300ms/);
    expect(timingsLine).toHaveTextContent('start→ready 300ms · ready→first audio 550ms · turns 50ms, 100ms');

    // t=3000: End Call -- exactly one console line, with the same numbers.
    now = 3000;
    await user.click(screen.getByRole('button', { name: 'End Call' }));

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalledWith('[countersign:timings]', {
      session_id: SESSION.session_id,
      start_to_ready_ms: 300,
      ready_to_first_audio_ms: 550,
      turn_gaps_ms: [50, 100],
    });
  });

  it('logs exactly once even if the server also ends the call after the caller already ended it', async () => {
    const fake = makeFakeClient();
    vi.mocked(connect).mockResolvedValue(fake.client as never);
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const user = userEvent.setup();

    render(<Call session={SESSION} onStartOver={vi.fn()} onWatch={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Start Call' }));

    now = 1200;
    fake.emitState(baseState([]));

    await user.click(screen.getByRole('button', { name: 'End Call' }));
    fake.emitEnded('caller_ended');

    expect(consoleSpy).toHaveBeenCalledTimes(1);
  });

  it('omits the Timings line before any state has arrived (nothing measured yet)', async () => {
    const fake = makeFakeClient();
    vi.mocked(connect).mockResolvedValue(fake.client as never);
    render(<Call session={SESSION} onStartOver={vi.fn()} onWatch={vi.fn()} />);

    expect(screen.queryByText(/Timings \(measured in this browser\)/)).not.toBeInTheDocument();
    void fake; // keep referenced -- this test only asserts the pre-call screen.
  });
});
