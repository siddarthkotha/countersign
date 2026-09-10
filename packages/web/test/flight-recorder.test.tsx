// packages/web/test/flight-recorder.test.tsx
// TDD for Task W9 (flight recorder, browser half): a client event ring buffer (max 500
// entries) that captures mic check results, Start/End clicks, worker socket link events,
// transcript line arrivals (role+length only, never text -- LAW 4), the W8 timings, window
// errors, etc., and ships them to `/api/session/:id/diagnostics` on call end (fetch,
// keepalive:true) or on pagehide/beforeunload (navigator.sendBeacon). Two layers tested here:
// (1) the pure module (src/diagnostics/flightRecorder.ts) -- ring buffer cap, payload size
// cap, transcript-text exclusion; (2) Call.tsx's wiring of that module through a faked
// `connect()` client, mirroring the multicast contract established by test/call-timings.test.tsx
// (onAudio/onFlush both arrays -- a single-callback fake would silently hide a real
// regression if Call.tsx's own listener clobbered `connect()`'s).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BrowserEvent, ScreenState } from '@countersign/engine';
import Call from '../src/screens/Call';
import { connect } from '../src/ws/client';
import {
  MAX_EVENTS,
  buildDiagnosticsPayload,
  markStartClick,
  recordEvent,
  resetFlightRecorder,
} from '../src/diagnostics/flightRecorder';

vi.mock('../src/ws/client', () => ({
  connect: vi.fn(),
  connectSocketOnly: vi.fn(),
}));

const SESSION = { session_id: 'sess-w9', ws_path: '/ws/call/sess-w9', cap_seconds: 180 };

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
        at_least_one_challenge_passed: false,
        no_injection_attempt: true,
      },
      counterfactuals: [],
      export_hash: null,
      countersign: { server_verdict: 'STAGE', recomputed: true },
    },
    simulated: true,
    link: 'live',
  };
}

/** Mirrors the real client.ts contract for every multicast slot (onAudio, onFlush) Call.tsx
 *  now registers a SECOND listener on -- a single-callback fake for either would silently
 *  clobber `connect()`'s own wiring and hide a real regression, same reasoning documented in
 *  test/call-timings.test.tsx for onAudio. */
function makeFakeClient() {
  let stateCb: ((state: ScreenState) => void) | null = null;
  let endedCb: ((reason: string) => void) | null = null;
  let linkCb: ((leg: 'browser' | 'aai', state: 'lost' | 'restored', dropped_frames?: number) => void) | null = null;
  const audioCbs: (() => void)[] = [];
  const flushCbs: (() => void)[] = [];
  const send = vi.fn<(e: BrowserEvent) => void>();
  const close = vi.fn();
  const underrunCount = vi.fn().mockReturnValue(0);

  const client = {
    send,
    onState(cb: (state: ScreenState) => void) {
      stateCb = cb;
    },
    onAudio(cb: () => void) {
      audioCbs.push(cb);
    },
    onFlush(cb: () => void) {
      flushCbs.push(cb);
    },
    onEnded(cb: (reason: string) => void) {
      endedCb = cb;
    },
    onLink(cb: (leg: 'browser' | 'aai', state: 'lost' | 'restored', dropped_frames?: number) => void) {
      linkCb = cb;
    },
    close,
    capture: { stop: vi.fn() },
    playback: { flush: vi.fn(), push: vi.fn(), level: vi.fn(), close: vi.fn(), underrunCount },
  };

  return {
    client,
    emitState: (state: ScreenState) => stateCb?.(state),
    emitAudio: () => audioCbs.forEach((cb) => cb()),
    emitFlush: () => flushCbs.forEach((cb) => cb()),
    emitEnded: (reason: string) => endedCb?.(reason),
    emitLink: (leg: 'browser' | 'aai', state: 'lost' | 'restored', dropped_frames?: number) => linkCb?.(leg, state, dropped_frames),
    send,
    close,
  };
}

function lastFetchBody(fetchMock: ReturnType<typeof vi.fn>): { events: { t_ms: number; kind: string; detail?: unknown }[] } {
  const diagCall = fetchMock.mock.calls.find((call) => String(call[0]).includes('/diagnostics'));
  expect(diagCall).toBeDefined();
  return JSON.parse(diagCall![1].body as string) as { events: { t_ms: number; kind: string; detail?: unknown }[] };
}

describe('flight recorder module (src/diagnostics/flightRecorder.ts)', () => {
  beforeEach(() => {
    resetFlightRecorder();
  });

  it('ring buffer caps at 500 entries, evicting the OLDEST first', () => {
    for (let i = 0; i < 550; i++) recordEvent(`evt-${i}`);

    const body = JSON.parse(buildDiagnosticsPayload()) as { events: { kind: string }[] };
    expect(body.events).toHaveLength(MAX_EVENTS);
    // The oldest 50 were evicted -- the buffer starts at evt-50, ends at evt-549.
    expect(body.events[0]!.kind).toBe('evt-50');
    expect(body.events[body.events.length - 1]!.kind).toBe('evt-549');
  });

  it('trims the OLDEST events first, never the newest, to keep the JSON body under 64KB', () => {
    // Each entry's `detail.text` is ~2KB -- 40 of them is comfortably over 64KB before any
    // trimming, forcing buildDiagnosticsPayload to actually drop some.
    const chunk = 'x'.repeat(2000);
    for (let i = 0; i < 40; i++) recordEvent(`evt-${i}`, { text: chunk });

    const raw = buildDiagnosticsPayload();
    const bodyBytes = new TextEncoder().encode(raw).length;
    expect(bodyBytes).toBeLessThanOrEqual(64 * 1024);

    const body = JSON.parse(raw) as { events: { kind: string }[] };
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events.length).toBeLessThan(40);
    // The newest event always survives a trim.
    expect(body.events[body.events.length - 1]!.kind).toBe('evt-39');
    // The oldest event does not.
    expect(body.events.some((e) => e.kind === 'evt-0')).toBe(false);
  });

  it('reports t_ms relative to the most recent markStartClick -- negative before it, positive after', () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(1000); // pre-click event
    recordEvent('mic_check', { ok: true });
    vi.spyOn(performance, 'now').mockReturnValueOnce(1500);
    markStartClick();
    vi.spyOn(performance, 'now').mockReturnValueOnce(1800);
    recordEvent('start_click');

    const body = JSON.parse(buildDiagnosticsPayload()) as { events: { t_ms: number; kind: string }[] };
    expect(body.events[0]).toMatchObject({ kind: 'mic_check', t_ms: -500 });
    expect(body.events[1]).toMatchObject({ kind: 'start_click', t_ms: 300 });
    vi.restoreAllMocks();
  });

  it('omits `detail` from the wire shape when none was given, matching the server\'s optional field', () => {
    recordEvent('end_click');
    const body = JSON.parse(buildDiagnosticsPayload()) as { events: Record<string, unknown>[] };
    expect(body.events[0]).toEqual({ t_ms: expect.any(Number), kind: 'end_click' });
    expect('detail' in body.events[0]!).toBe(false);
  });
});

describe('Call.tsx flight recorder wiring (Task W9)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let sendBeaconMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetFlightRecorder();
    vi.mocked(connect).mockReset();
    vi.stubGlobal('AudioContext', class {} as unknown as typeof AudioContext);
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    sendBeaconMock = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: sendBeaconMock, writable: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('captures start/end clicks, socket open/close, state, transcript-line, link and flush events, and POSTs them (fetch, keepalive:true) on End Call', async () => {
    const fake = makeFakeClient();
    vi.mocked(connect).mockResolvedValue(fake.client as never);
    const user = userEvent.setup();
    render(<Call session={SESSION} onStartOver={vi.fn()} onWatch={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Start Call' }));
    fake.emitState(baseState([{ id: 'u1', speaker: 'caller', text: 'This is Robert Miller.', t_ms: 500 }]));
    fake.emitAudio();
    fake.emitFlush();
    fake.emitLink('browser', 'lost', 2);
    fake.emitLink('browser', 'restored', 2);

    await user.click(screen.getByRole('button', { name: 'End Call' }));

    const postCall = fetchMock.mock.calls.find((call) => String(call[0]) === `/api/session/${SESSION.session_id}/diagnostics`);
    expect(postCall).toBeDefined();
    const [, init] = postCall!;
    expect(init).toMatchObject({ method: 'POST', keepalive: true });

    const { events } = lastFetchBody(fetchMock);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'start_click',
        'socket_open',
        'state',
        'transcript_line',
        'link',
        'flush',
        'end_click',
        'socket_close',
        'timings',
      ]),
    );

    // The transcript-line event carries role+length only -- never the transcript text (LAW 4:
    // the server already has the verbatim line).
    const transcriptEvent = events.find((e) => e.kind === 'transcript_line')!;
    expect(transcriptEvent.detail).toEqual({ role: 'caller', length: 'This is Robert Miller.'.length });
    const raw = JSON.stringify(events);
    expect(raw).not.toContain('This is Robert Miller');

    // The link events carry the leg and the dropped_frames count.
    const linkEvents = events.filter((e) => e.kind === 'link');
    expect(linkEvents).toEqual([
      { t_ms: expect.any(Number), kind: 'link', detail: { leg: 'browser', state: 'lost', dropped_frames: 2 } },
      { t_ms: expect.any(Number), kind: 'link', detail: { leg: 'browser', state: 'restored', dropped_frames: 2 } },
    ]);

    // Ending the call a second way (unmount, via RTL's own afterEach cleanup) must not send a
    // second payload -- fetchMock's diagnostics call count is asserted once more here so any
    // regression shows up in THIS test, not silently in a later one.
    const diagCallsSoFar = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/diagnostics')).length;
    expect(diagCallsSoFar).toBe(1);
  });

  it('sends a "turn_no_audio" event instead of silently dropping a tool-only turn\'s gap (W8 review, Minor)', async () => {
    const fake = makeFakeClient();
    vi.mocked(connect).mockResolvedValue(fake.client as never);
    const user = userEvent.setup();
    render(<Call session={SESSION} onStartOver={vi.fn()} onWatch={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Start Call' }));

    // First caller line starts a turn -- no audio ever arrives for it (a silent, tool-only
    // agent turn) before a SECOND caller line starts a new one.
    fake.emitState(baseState([{ id: 'u1', speaker: 'caller', text: 'This is Robert Miller.', t_ms: 500 }]));
    fake.emitState(
      baseState([
        { id: 'u1', speaker: 'caller', text: 'This is Robert Miller.', t_ms: 500 },
        { id: 'u2', speaker: 'caller', text: 'Wire fifty thousand.', t_ms: 2000 },
      ]),
    );

    await user.click(screen.getByRole('button', { name: 'End Call' }));

    const { events } = lastFetchBody(fetchMock);
    expect(events.some((e) => e.kind === 'turn_no_audio')).toBe(true);
  });

  it('records a mic_check event (via MicCheck, rendered standalone) with role/device info, never gating on Call.tsx', async () => {
    const { default: MicCheck } = await import('../src/components/MicCheck');
    const getUserMedia = vi.fn().mockResolvedValue({
      getTracks: () => [{ stop: vi.fn(), label: 'USB Microphone' }],
      getAudioTracks: () => [{ stop: vi.fn(), label: 'USB Microphone' }],
    });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    const user = userEvent.setup();
    render(<MicCheck onResult={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Check microphone' }));
    await screen.findByText(/PASSED/);

    const body = JSON.parse(buildDiagnosticsPayload()) as { events: { kind: string; detail?: unknown }[] };
    const micEvent = body.events.find((e) => e.kind === 'mic_check');
    expect(micEvent?.detail).toEqual({ ok: true, reason: 'passed', deviceLabel: 'USB Microphone' });
  });

  it('still logs the [countersign:timings] console line, including the numbers in the diagnostics beacon, on unmount (W8 review, Important)', async () => {
    const fake = makeFakeClient();
    vi.mocked(connect).mockResolvedValue(fake.client as never);
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const user = userEvent.setup();
    const { unmount } = render(<Call session={SESSION} onStartOver={vi.fn()} onWatch={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Start Call' }));
    fake.emitState(baseState([]));

    unmount();

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalledWith('[countersign:timings]', expect.objectContaining({ session_id: SESSION.session_id }));

    const { events } = lastFetchBody(fetchMock);
    expect(events.some((e) => e.kind === 'timings')).toBe(true);
    // W9 review, fix round 1 (Moderate): `socket_close` must be recorded BEFORE the payload
    // snapshot is taken on unmount -- previously it was recorded one line AFTER the flush,
    // so a bare unmount's own socket_close never reached the server at all.
    expect(events.some((e) => e.kind === 'socket_close')).toBe(true);
  });

  it('uses navigator.sendBeacon (not fetch) on pagehide, with the same events+timings body, and only once', async () => {
    const fake = makeFakeClient();
    vi.mocked(connect).mockResolvedValue(fake.client as never);
    const user = userEvent.setup();
    render(<Call session={SESSION} onStartOver={vi.fn()} onWatch={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Start Call' }));
    fake.emitState(baseState([]));

    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });

    expect(sendBeaconMock).toHaveBeenCalledTimes(1);
    const [url, body] = sendBeaconMock.mock.calls[0]!;
    expect(url).toBe(`/api/session/${SESSION.session_id}/diagnostics`);
    const { events } = JSON.parse(body as string) as { events: { kind: string }[] };
    expect(events.some((e) => e.kind === 'timings')).toBe(true);
    expect(events.some((e) => e.kind === 'start_click')).toBe(true);

    // A second pagehide (or beforeunload right after) must not send a second beacon.
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(sendBeaconMock).toHaveBeenCalledTimes(1);

    // Nor does the diagnostics fetch endpoint get hit once the beacon already won the race.
    const diagFetchCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/diagnostics'));
    expect(diagFetchCalls).toHaveLength(0);
  });
});
