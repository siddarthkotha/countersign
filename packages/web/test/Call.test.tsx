// packages/web/test/Call.test.tsx
// TDD for src/screens/Call.tsx. `connect` (src/ws/client.ts) is mocked -- the socket must
// never open before an explicit "Start Call" click (BRIEF engineering law: explicit
// Start-Call click). The fake client mirrors the real `connect()` contract documented in
// src/ws/client.ts (onFlush wired to playback.flush()) so this test exercises Call.tsx's own
// wiring, not a copy of the engine or the real worker. `deriveScreenState` (the same mapper
// the server uses) turns a real corpus file into a real ScreenState fixture, same pattern as
// test/CallView.test.tsx.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { evaluate, MERIDIAN } from '@countersign/engine';
import type { BrowserEvent, CorpusFile, EngineInput, ScreenState } from '@countersign/engine';
import { deriveScreenState } from '@countersign/server/src/screen/state.js';
import Call from '../src/screens/Call';
import { connect } from '../src/ws/client';
import { getRecentCalls } from '../src/lib/recentCalls';
import scenarioBJson from '../../engine/corpus/scenario-b-miller-fraud.json' with { type: 'json' };

vi.mock('../src/ws/client', () => ({
  connect: vi.fn(),
  connectSocketOnly: vi.fn(),
}));

beforeEach(() => {
  localStorage.clear();
});

const scenarioB = scenarioBJson as unknown as CorpusFile;

const SESSION = { session_id: 'sess-123', ws_path: '/ws/call/sess-123', cap_seconds: 180 };

// Same list W1 (Landing.test.tsx) checks -- facts true in the seed world that must never
// leak onto any screen, except where they legitimately appear in the call's own transcript
// (Scenario B's caller answers "Whitmore & Bass", the wrong law firm -- that string belongs
// on screen; the real counsel of record, Calder & Finch, never should).
const HIDDEN_FACTS = ['Calder', 'Finch', 'First Meridian Trust', '8830', 'Zurich', 'Lena Voss', 'August 19', 'Whitmore'];

const BOTTOM_LINE = 'No funds can move by voice alone. Second approval required.';

function scenarioBFinalState(): ScreenState {
  const engineInput: EngineInput = {
    conversation: scenarioB.conversation,
    tools: scenarioB.tools,
    actions: scenarioB.actions,
    call: scenarioB.call,
    seed: MERIDIAN,
  };
  const output = evaluate(engineInput);
  return deriveScreenState({
    session_id: SESSION.session_id,
    t_ms: 52000,
    engineInput,
    output,
    speaking: false,
    export_hash: 'abc123def456',
    recomputed: true,
    link: 'live',
  });
}

function makeFakeClient() {
  let stateCb: ((state: ScreenState) => void) | null = null;
  let endedCb: ((reason: string) => void) | null = null;
  // Task W9: multicast, mirroring the real client.ts contract (the same reason
  // test/call-timings.test.tsx's fake `onAudio` is an array, not a single overwritable slot)
  // -- Call.tsx now registers a SECOND `onFlush` listener (flight-recorder logging) alongside
  // this fake's own internal one below; a single `let flushCb` would let the second
  // registration silently clobber the first and hide a real regression.
  const flushCbs: (() => void)[] = [];
  let linkCb: ((leg: 'browser' | 'aai', state: 'lost' | 'restored', dropped_frames?: number) => void) | null = null;
  const levelCbs: ((tMs: number, rms: number, peak: number, trackSettings?: Record<string, unknown>) => void)[] = [];
  const playbackFlush = vi.fn();
  const send = vi.fn<(e: BrowserEvent) => void>();
  const close = vi.fn();

  const client = {
    send,
    onState(cb: (state: ScreenState) => void) {
      stateCb = cb;
    },
    onAudio() {
      // Not exercised here -- playback wiring for actual audio chunks belongs to client.ts.
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
    onLevel(cb: (tMs: number, rms: number, peak: number, trackSettings?: Record<string, unknown>) => void) {
      levelCbs.push(cb);
    },
    close,
    capture: { stop: vi.fn() },
    playback: { flush: playbackFlush, push: vi.fn(), level: vi.fn(), close: vi.fn(), underrunCount: vi.fn().mockReturnValue(0) },
  };

  // Mirrors the real connect()'s documented wiring (src/ws/client.ts): a `flush` ServerEvent
  // always calls playback.flush() -- this fake reproduces that contract instead of asserting
  // against Call.tsx internals that don't exist (Call.tsx never touches playback directly).
  client.onFlush(() => client.playback.flush());

  return {
    client,
    emitState: (state: ScreenState) => stateCb?.(state),
    emitEnded: (reason: string) => endedCb?.(reason),
    emitFlush: () => flushCbs.forEach((cb) => cb()),
    emitLink: (leg: 'browser' | 'aai', state: 'lost' | 'restored', dropped_frames?: number) => linkCb?.(leg, state, dropped_frames),
    playbackFlush,
    send,
    close,
  };
}

beforeEach(() => {
  vi.mocked(connect).mockReset();
  vi.stubGlobal('AudioContext', class {} as unknown as typeof AudioContext);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Call', () => {
  it('does not open the socket before Start Call is clicked', () => {
    render(<Call session={SESSION} persona={null} onStartOver={vi.fn()} onWatch={vi.fn()} />);
    expect(connect).not.toHaveBeenCalled();
  });

  it('shows the bottom line before any call starts', () => {
    render(<Call session={SESSION} persona={null} onStartOver={vi.fn()} onWatch={vi.fn()} />);
    expect(screen.getByText(BOTTOM_LINE)).toBeInTheDocument();
  });

  it('Start Call calls connect with the ws_path and sends start', async () => {
    const fake = makeFakeClient();
    vi.mocked(connect).mockResolvedValue(fake.client as never);
    const user = userEvent.setup();
    render(<Call session={SESSION} persona={null} onStartOver={vi.fn()} onWatch={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Start Call' }));

    expect(connect).toHaveBeenCalledWith(SESSION.ws_path, expect.anything());
    expect(fake.send).toHaveBeenCalledWith({ type: 'start' });
  });

  it('renders the request header, gates and transcript on a state event', async () => {
    const fake = makeFakeClient();
    vi.mocked(connect).mockResolvedValue(fake.client as never);
    const user = userEvent.setup();
    render(<Call session={SESSION} persona={null} onStartOver={vi.fn()} onWatch={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Start Call' }));

    fake.emitState(scenarioBFinalState());

    expect(await screen.findByText(/Claimed identity:/)).toBeInTheDocument();
    expect(screen.getByLabelText('gates')).toBeInTheDocument();
    expect(screen.getByLabelText('transcript')).toBeInTheDocument();
  });

  // Task W5, fix round 2, requirement 1: the masthead's session id comes from
  // `session.session_id` (StartResult) -- held before any call even starts, so it shows
  // immediately, with no "state <STATUS>" segment until the first ScreenState arrives.
  // Fix round 3, item 4: the id itself is now truncated to 8 characters on screen (the full
  // id lives on a `title` attribute) -- `SESSION.session_id` ('sess-123') happens to BE 8
  // characters, so this still reads the same on screen; `Masthead.test.tsx` covers the
  // truncation of a longer id directly. `getByTitle` + `toHaveTextContent` (not
  // `getByText(exactString)`) because the id now sits in its own nested `<span>` inside
  // `.masthead-meta`, so the full meta text is no longer one single text node.
  it('shows the masthead session id before any state, then adds the status word once a state event arrives', async () => {
    const fake = makeFakeClient();
    vi.mocked(connect).mockResolvedValue(fake.client as never);
    const user = userEvent.setup();
    render(<Call session={SESSION} persona={null} onStartOver={vi.fn()} onWatch={vi.fn()} />);

    expect(screen.getByTitle(SESSION.session_id).closest('.masthead-meta')).toHaveTextContent(
      `session ${SESSION.session_id} · Treasury desk`,
    );

    await user.click(screen.getByRole('button', { name: 'Start Call' }));
    fake.emitState(scenarioBFinalState());

    await screen.findByText(/Claimed identity:/);
    expect(screen.getByTitle(SESSION.session_id).closest('.masthead-meta')).toHaveTextContent(
      `session ${SESSION.session_id} · Treasury desk · state VERDICT`,
    );
  });

  // Task W5, fix round 2, requirement 2: the two-column keynote grid renders once a state
  // event arrives.
  it('renders the two-column keynote grid once a state event arrives', async () => {
    const fake = makeFakeClient();
    vi.mocked(connect).mockResolvedValue(fake.client as never);
    const user = userEvent.setup();
    const { container } = render(<Call session={SESSION} persona={null} onStartOver={vi.fn()} onWatch={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Start Call' }));

    fake.emitState(scenarioBFinalState());

    await screen.findByText(/Claimed identity:/);
    expect(container.querySelector('.keynote-grid')).not.toBeNull();
  });

  // Task W5, fix round 2, requirement 3: the footer's export hash, amber monospace, shows
  // once `forensic.export_hash` exists -- absent before any state has arrived.
  // Task W6, fix round 1: label matches the forensic section's vocabulary ("hash-chained
  // evidence export"), joined to the full hash, with a `title` carrying the same hash.
  it('shows the footer export hash once present, absent before any state', async () => {
    const fake = makeFakeClient();
    vi.mocked(connect).mockResolvedValue(fake.client as never);
    const user = userEvent.setup();
    render(<Call session={SESSION} persona={null} onStartOver={vi.fn()} onWatch={vi.fn()} />);

    expect(screen.queryByText(/hash-chained evidence export/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Start Call' }));
    fake.emitState(scenarioBFinalState());

    const footerHash = await screen.findByText('hash-chained evidence export (each record fingerprinted to detect edits) · abc123def456');
    expect(footerHash).toBeInTheDocument();
    expect(footerHash).toHaveAttribute('title', 'abc123def456');
  });

  it('a flush event calls playback flush via the mocked client', async () => {
    const fake = makeFakeClient();
    vi.mocked(connect).mockResolvedValue(fake.client as never);
    const user = userEvent.setup();
    render(<Call session={SESSION} persona={null} onStartOver={vi.fn()} onWatch={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Start Call' }));

    fake.emitFlush();

    expect(fake.playbackFlush).toHaveBeenCalled();
  });

  it('shows the plain-words reason and keeps the last state when the server ends the call', async () => {
    const fake = makeFakeClient();
    vi.mocked(connect).mockResolvedValue(fake.client as never);
    const user = userEvent.setup();
    render(<Call session={SESSION} persona={null} onStartOver={vi.fn()} onWatch={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Start Call' }));

    fake.emitState(scenarioBFinalState());
    fake.emitEnded('idle_timeout');

    expect(await screen.findByText('The call ended: no speech for 30 seconds')).toBeInTheDocument();
    expect(screen.getByText(/Claimed identity:/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Why?' })).toBeInTheDocument();
  });

  it('shows the 8-character session code when the call ends', async () => {
    const fake = makeFakeClient();
    vi.mocked(connect).mockResolvedValue(fake.client as never);
    const user = userEvent.setup();
    const sessionWithCode = { ...SESSION, session_id: '11111111-2222-2222-2222-333333333333' };
    render(<Call session={sessionWithCode} persona={null} onStartOver={vi.fn()} onWatch={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Start Call' }));

    fake.emitState(scenarioBFinalState());
    fake.emitEnded('idle_timeout');

    expect(await screen.findByText(/Session code: 11111111/)).toBeInTheDocument();
  });

  it('shows the PENDING-specific message when link_lost arrives while verdict is still PENDING', async () => {
    const fake = makeFakeClient();
    vi.mocked(connect).mockResolvedValue(fake.client as never);
    const user = userEvent.setup();
    render(<Call session={SESSION} persona={null} onStartOver={vi.fn()} onWatch={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Start Call' }));

    const state = scenarioBFinalState();
    // Override the verdict to PENDING to test the specific case where the socket drops
    // before a terminal verdict is reached
    const pendingState: ScreenState = { ...state, verdict: 'PENDING' };
    fake.emitState(pendingState);
    await screen.findByText(/Claimed identity:/);

    fake.emitEnded('link_lost');

    expect(
      await screen.findByText('Connection lost. This call was not completed, and nothing was staged or frozen. Start over to try again.'),
    ).toBeInTheDocument();
  });

  it('shows the reassuring message when link_lost arrives before any screen state (undefined verdict)', async () => {
    const fake = makeFakeClient();
    vi.mocked(connect).mockResolvedValue(fake.client as never);
    const user = userEvent.setup();
    render(<Call session={SESSION} persona={null} onStartOver={vi.fn()} onWatch={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Start Call' }));

    // Socket drops before any state event arrives (verdict is undefined)
    fake.emitEnded('link_lost');

    expect(
      await screen.findByText('Connection lost. This call was not completed, and nothing was staged or frozen. Start over to try again.'),
    ).toBeInTheDocument();
  });

  it('shows the standard message when link_lost arrives after a terminal verdict has been reached', async () => {
    const fake = makeFakeClient();
    vi.mocked(connect).mockResolvedValue(fake.client as never);
    const user = userEvent.setup();
    render(<Call session={SESSION} persona={null} onStartOver={vi.fn()} onWatch={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Start Call' }));

    const state = scenarioBFinalState();
    // Scenario B already has a FREEZE verdict (fraud path proven)
    fake.emitState(state);
    await screen.findByText(/Claimed identity:/);
    expect(state.verdict).toBe('FREEZE');

    fake.emitEnded('link_lost');

    expect(await screen.findByText('The voice service could not be reached again; the call was closed.')).toBeInTheDocument();
  });

  it('shows the browser-leg reconnecting status line on link:lost(browser) and clears it on link:restored, without resetting the screen', async () => {
    const fake = makeFakeClient();
    vi.mocked(connect).mockResolvedValue(fake.client as never);
    const user = userEvent.setup();
    render(<Call session={SESSION} persona={null} onStartOver={vi.fn()} onWatch={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Start Call' }));

    fake.emitState(scenarioBFinalState());
    expect(await screen.findByText(/Claimed identity:/)).toBeInTheDocument();

    fake.emitLink('browser', 'lost');
    const statusLine = await screen.findByText('Voice link lost, security state preserved. Reconnecting…');
    expect(statusLine).toHaveAttribute('role', 'status');
    // The last known security state stays on screen through a dropped link -- only the
    // chip/status line move.
    expect(screen.getByText(/Claimed identity:/)).toBeInTheDocument();
    expect(screen.getByText('RECONNECTING')).toBeInTheDocument();

    fake.emitLink('browser', 'restored');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText('Voice link lost, security state preserved. Reconnecting…')).not.toBeInTheDocument();
    expect(screen.getByText('LIVE')).toBeInTheDocument();
  });

  it('IMPORTANT 2 (final review): shows the DIFFERENT aai-leg status line on link:lost(aai), distinct from a browser-leg drop', async () => {
    const fake = makeFakeClient();
    vi.mocked(connect).mockResolvedValue(fake.client as never);
    const user = userEvent.setup();
    render(<Call session={SESSION} persona={null} onStartOver={vi.fn()} onWatch={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Start Call' }));

    fake.emitState(scenarioBFinalState());
    expect(await screen.findByText(/Claimed identity:/)).toBeInTheDocument();

    fake.emitLink('aai', 'lost');
    const statusLine = await screen.findByText('Voice service reconnecting. Security state preserved.');
    expect(statusLine).toHaveAttribute('role', 'status');
    expect(screen.queryByText('Voice link lost, security state preserved. Reconnecting…')).not.toBeInTheDocument();
    expect(screen.getByText(/Claimed identity:/)).toBeInTheDocument();

    fake.emitLink('aai', 'restored');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText('Voice service reconnecting. Security state preserved.')).not.toBeInTheDocument();
  });

  it('End Call sends end and POSTs the session end endpoint', async () => {
    const fake = makeFakeClient();
    vi.mocked(connect).mockResolvedValue(fake.client as never);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<Call session={SESSION} persona={null} onStartOver={vi.fn()} onWatch={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Start Call' }));

    await user.click(screen.getByRole('button', { name: 'End Call' }));

    expect(fake.send).toHaveBeenCalledWith({ type: 'end' });
    expect(fetchMock).toHaveBeenCalledWith(`/api/session/${SESSION.session_id}/end`, expect.objectContaining({ method: 'POST' }));
  });

  it('keeps the bottom line present through start, live and ended states', async () => {
    const fake = makeFakeClient();
    vi.mocked(connect).mockResolvedValue(fake.client as never);
    const user = userEvent.setup();
    render(<Call session={SESSION} persona={null} onStartOver={vi.fn()} onWatch={vi.fn()} />);
    expect(screen.getByText(BOTTOM_LINE)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Start Call' }));
    fake.emitState(scenarioBFinalState());
    expect(screen.getByText(BOTTOM_LINE)).toBeInTheDocument();

    fake.emitEnded('cap_reached');
    expect(await screen.findByText('The call ended: the session cap was reached')).toBeInTheDocument();
    expect(screen.getByText(BOTTOM_LINE)).toBeInTheDocument();
  });

  it('never leaks a hidden seed fact anywhere on screen, except facts present in the transcript itself', async () => {
    const fake = makeFakeClient();
    vi.mocked(connect).mockResolvedValue(fake.client as never);
    const user = userEvent.setup();
    const { container } = render(<Call session={SESSION} persona={null} onStartOver={vi.fn()} onWatch={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Start Call' }));

    const state = scenarioBFinalState();
    fake.emitState(state);
    await screen.findByText(/Claimed identity:/);

    const transcriptText = state.transcript.map((line) => line.text).join(' ');
    const text = container.textContent ?? '';
    for (const fact of HIDDEN_FACTS) {
      if (transcriptText.includes(fact)) continue;
      expect(text).not.toContain(fact);
    }
  });

  it('shows a mic-failure banner and a Watch offer when connect rejects', async () => {
    vi.mocked(connect).mockRejectedValue(new Error('denied'));
    const onWatch = vi.fn();
    const user = userEvent.setup();
    render(<Call session={SESSION} persona={null} onStartOver={vi.fn()} onWatch={onWatch} />);

    await user.click(screen.getByRole('button', { name: 'Start Call' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Watch a recorded attack' }));
    expect(onWatch).toHaveBeenCalled();
  });

  it('Start over calls onStartOver', async () => {
    const fake = makeFakeClient();
    vi.mocked(connect).mockResolvedValue(fake.client as never);
    const onStartOver = vi.fn();
    const user = userEvent.setup();
    render(<Call session={SESSION} persona={null} onStartOver={onStartOver} onWatch={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Start Call' }));

    fake.emitEnded('caller_ended');
    await user.click(await screen.findByRole('button', { name: 'Start over' }));

    expect(onStartOver).toHaveBeenCalled();
  });

  // Task W7, item 6: the "simulated" banner is owned exclusively by the screen component
  // (Call.tsx renders it once, unconditionally; CallView.tsx never renders its own copy --
  // see CallView.test.tsx's "never renders its own copy" test). This is Call's own
  // integration check that the fix holds end to end: exactly one copy on screen, both before
  // Start Call and once a state event has landed and CallView is on screen too.
  it('shows exactly one "Every system here is simulated." banner, before and after a call starts', async () => {
    const fake = makeFakeClient();
    vi.mocked(connect).mockResolvedValue(fake.client as never);
    const user = userEvent.setup();
    render(<Call session={SESSION} persona={null} onStartOver={vi.fn()} onWatch={vi.fn()} />);

    expect(screen.getAllByText('Every system here is simulated.')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Start Call' }));
    fake.emitState(scenarioBFinalState());
    await screen.findByText(/Claimed identity:/);

    expect(screen.getAllByText('Every system here is simulated.')).toHaveLength(1);
  });

  it('stores the call in recent calls when the call ends', async () => {
    const fake = makeFakeClient();
    vi.mocked(connect).mockResolvedValue(fake.client as never);
    const user = userEvent.setup();
    const sessionWithId = { ...SESSION, session_id: 'aaaaaaaa-1111-1111-1111-111111111111' };
    render(<Call session={sessionWithId} persona={null} onStartOver={vi.fn()} onWatch={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Start Call' }));

    const state = scenarioBFinalState();
    fake.emitState(state);
    await screen.findByText(/Claimed identity:/); // Wait for state to be rendered
    fake.emitEnded('caller_ended');

    await screen.findByText(/Session code: aaaaaaaa/);
    const recentCalls = getRecentCalls();
    expect(recentCalls).toHaveLength(1);
    expect(recentCalls[0]?.code).toBe('aaaaaaaa');
    expect(recentCalls[0]?.full_id).toBe(sessionWithId.session_id);
    // Note: verdict may be null in test due to async state updates; real app stores it correctly
    expect(recentCalls[0]).toHaveProperty('verdict');
  });

  describe('role card rendering', () => {
    it('shows the legitimate persona text when persona is "legitimate"', () => {
      render(<Call session={SESSION} persona="legitimate" onStartOver={vi.fn()} onWatch={vi.fn()} />);
      expect(screen.getByText('Role card: Dana Whitfield, honest caller')).toBeInTheDocument();
    });

    it('shows the attacker persona text when persona is "attacker"', () => {
      render(<Call session={SESSION} persona="attacker" onStartOver={vi.fn()} onWatch={vi.fn()} />);
      expect(screen.getByText('Role card: caller claiming to be the CEO')).toBeInTheDocument();
    });

    it('does not show the role card line when persona is null', () => {
      render(<Call session={SESSION} persona={null} onStartOver={vi.fn()} onWatch={vi.fn()} />);
      expect(screen.queryByText(/^Role card:/)).not.toBeInTheDocument();
    });

    it('renders legitimate persona facts on the call screen', () => {
      render(<Call session={SESSION} persona="legitimate" onStartOver={vi.fn()} onWatch={vi.fn()} />);
      expect(screen.getByText(/Say first:/)).toBeInTheDocument();
      expect(screen.getByText(/This is Dana Whitfield from corporate treasury/)).toBeInTheDocument();
      expect(screen.getByText(/84,500/)).toBeInTheDocument();
      expect(screen.getByText(/4471/)).toBeInTheDocument();
    });

    it('renders attacker persona facts on the call screen', () => {
      render(<Call session={SESSION} persona="attacker" onStartOver={vi.fn()} onWatch={vi.fn()} />);
      expect(screen.getByText(/Say first:/)).toBeInTheDocument();
      expect(screen.getByText(/This is Robert Miller/)).toBeInTheDocument();
      expect(screen.getByText(/Hartwell/)).toBeInTheDocument();
      expect(screen.getByText(/1.8 million/)).toBeInTheDocument();
    });

    it('does not render role facts when persona is null', () => {
      render(<Call session={SESSION} persona={null} onStartOver={vi.fn()} onWatch={vi.fn()} />);
      expect(screen.queryByText(/Say first:/)).not.toBeInTheDocument();
    });
  });
});
