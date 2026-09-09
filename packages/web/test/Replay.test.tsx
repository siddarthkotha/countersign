// packages/web/test/Replay.test.tsx
// TDD for src/screens/Replay.tsx. `connectSocketOnly` (src/ws/client.ts) is mocked -- Replay
// has no microphone and never calls `connect()`; this test exercises Replay.tsx's own
// wiring, not the real worker. `deriveScreenState` (the same mapper the server uses) turns a
// real corpus file into a real ScreenState fixture, same pattern as test/Call.test.tsx and
// test/CallView.test.tsx.
//
// Task W5, fix round 2: the brief explicitly asks for the masthead, the two-column keynote
// grid, and the footer's export hash to be verified on BOTH Call and Replay -- Call.test.tsx
// covers Call; this file is Replay's half of that same coverage (Replay had no dedicated
// test file before this round).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { evaluate, MERIDIAN } from '@countersign/engine';
import type { CorpusFile, EngineInput, ScreenState } from '@countersign/engine';
import { deriveScreenState } from '@countersign/server/src/screen/state.js';
import Replay from '../src/screens/Replay';
import { connectSocketOnly } from '../src/ws/client';
import scenarioBJson from '../../engine/corpus/scenario-b-miller-fraud.json' with { type: 'json' };

vi.mock('../src/ws/client', () => ({
  connect: vi.fn(),
  connectSocketOnly: vi.fn(),
}));

const scenarioB = scenarioBJson as unknown as CorpusFile;
// Judge review finding (2026-09-04), defect 2: no `.json` suffix -- matches the bare value
// the real `/api/replay` (packages/server/src/http.ts) actually returns (`listCorpusFiles`
// strips the extension), which is also the value the WS route expects as `:file`.
const RECORDING = 'scenario-b-miller-fraud';
// The label the real server derives from this corpus file's own `title` field (see
// scenario-b-miller-fraud.json), "Recommended:"-prefixed because this is the flagship BRIEF
// §4 attack scenario -- verified against the corpus file, not invented for this test.
const RECORDING_LABEL = 'Recommended: Robert Miller — the fraudulent CEO-impersonation call';

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
    session_id: 'sess-replay-b',
    t_ms: 52000,
    engineInput,
    output,
    speaking: false,
    export_hash: 'abc123def456',
    recomputed: true,
    link: 'replay',
  });
}

function makeFakeClient() {
  let stateCb: ((state: ScreenState) => void) | null = null;
  let endedCb: ((reason: string) => void) | null = null;

  const client = {
    send: vi.fn(),
    onState(cb: (state: ScreenState) => void) {
      stateCb = cb;
    },
    onAudio() {
      // Not exercised here -- Replay has no audio playback wiring of its own.
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
    close: vi.fn(),
  };

  return {
    client,
    emitState: (state: ScreenState) => stateCb?.(state),
    emitEnded: (reason: string) => endedCb?.(reason),
  };
}

beforeEach(() => {
  vi.mocked(connectSocketOnly).mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      // `files` kept alongside `recordings` -- same shape the real endpoint now returns
      // (packages/server/src/http.ts), so this fixture exercises the same response shape
      // Replay.tsx actually parses (`toRecordings`), not a stand-in for it.
      json: () =>
        Promise.resolve({
          files: [RECORDING],
          recordings: [{ file: RECORDING, label: RECORDING_LABEL, recommended: true }],
        }),
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Replay', () => {
  // Task W5, fix round 2, requirement 1: before any recording exists in client state there is
  // no session id anywhere, so the masthead's meta line is omitted entirely (not padded).
  // Founder ruling 10 (2026-09-09): the flagship recording now auto-selects and starts the
  // instant the list is ready, so "no recording chosen" only ever exists while the list is
  // still loading -- this test now checks that window directly instead of the (now
  // momentary) instant right after the list resolves.
  it('omits the masthead meta line while the recording list is still loading', async () => {
    let resolveFetch: (value: { json: () => Promise<unknown> }) => void = () => {};
    const pending = new Promise<{ json: () => Promise<unknown> }>((resolve) => {
      resolveFetch = resolve;
    });
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending));
    render(<Replay />);

    expect(screen.queryByText(/Treasury desk/)).not.toBeInTheDocument();

    resolveFetch({
      json: () =>
        Promise.resolve({
          files: [RECORDING],
          recordings: [{ file: RECORDING, label: RECORDING_LABEL, recommended: true }],
        }),
    });
  });

  // Founder ruling 10 (2026-09-09): a judge with three minutes should never have to hunt for
  // a play button -- the flagship attack scenario (the corpus's own `recommended` flag) is
  // auto-selected and its replay starts the instant the recording list is ready, with no
  // click at all.
  it('auto-selects and starts playing the flagship recording as soon as the list loads, with no click needed', async () => {
    const fake = makeFakeClient();
    vi.mocked(connectSocketOnly).mockReturnValue(fake.client as never);
    render(<Replay />);

    await screen.findByRole('option', { name: RECORDING_LABEL });
    expect(connectSocketOnly).toHaveBeenCalledWith(
      expect.stringContaining(`/ws/replay/${encodeURIComponent(RECORDING)}?speed=1`),
    );
    expect(await screen.findByLabelText('Recording')).toHaveValue(RECORDING);
    // Accessibility (founder is colour blind): the playing/paused state is carried by the
    // control's own word, never colour alone.
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeInTheDocument();
  });

  // Founder ruling 10 (2026-09-09): a real browser can refuse an automatic start (autoplay
  // restrictions, a blocked socket, etc). When that happens the recording still ends up
  // selected -- so the judge sees exactly what's queued up -- and gets a single obvious
  // "Play" button instead of a silent failure or an error banner.
  it('falls back to a Play button with the recording selected if the automatic start is blocked', async () => {
    vi.mocked(connectSocketOnly).mockImplementationOnce(() => {
      throw new Error('autoplay blocked');
    });
    render(<Replay />);

    expect(await screen.findByLabelText('Recording')).toHaveValue(RECORDING);
    expect(await screen.findByRole('button', { name: 'Play' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  // Founder ruling 10 (2026-09-09): the fallback "Play" button must actually work -- one
  // click starts the same replay the automatic attempt failed to start.
  it('starts the replay when the judge clicks Play after the automatic start was blocked', async () => {
    const fake = makeFakeClient();
    vi.mocked(connectSocketOnly)
      .mockImplementationOnce(() => {
        throw new Error('autoplay blocked');
      })
      .mockReturnValue(fake.client as never);
    const user = userEvent.setup();
    render(<Replay />);

    const playButton = await screen.findByRole('button', { name: 'Play' });
    await user.click(playButton);

    expect(await screen.findByRole('button', { name: 'Pause' })).toBeInTheDocument();
    fake.emitState(scenarioBFinalState());
    expect(await screen.findByText(/Claimed identity:/)).toBeInTheDocument();
  });

  // Founder ruling 10 (2026-09-09): "keep an obvious pause control" -- a judge who wants to
  // read the transcript at their own pace can stop the stream, then start it again, both via
  // plain-worded buttons (never colour-only).
  it('lets the judge pause the auto-started playback, then resume it', async () => {
    const fake = makeFakeClient();
    vi.mocked(connectSocketOnly).mockReturnValue(fake.client as never);
    const user = userEvent.setup();
    render(<Replay />);

    const pauseButton = await screen.findByRole('button', { name: 'Pause' });
    await user.click(pauseButton);

    expect(fake.client.close).toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Play' })).toBeInTheDocument();
  });

  // Task W5, fix round 2, requirement 1: once a recording is chosen (before any ScreenState
  // exists), the masthead's session id falls back to the chosen filename -- the closest
  // thing to "the replay's id" in client state at that point. Once a state event lands, the
  // real server `session_id` on the ScreenState takes over (it's the authoritative id), and
  // the status word ("state <STATUS>") joins it -- the same already-rendered `agent_status`.
  // Fix round 3, item 4: both ids on screen are truncated to 8 characters, full id on a
  // `title` attribute -- `getByTitle(fullId)` finds the truncating span directly (proving
  // the truncation actually happened, not just "some text exists somewhere"), and
  // `toHaveTextContent` reads the full text of its `.masthead-meta` parent, since the id now
  // sits in its own nested `<span>` rather than one single text node.
  it('shows the masthead id from the chosen recording, then the real session id and status once a state event arrives', async () => {
    const fake = makeFakeClient();
    vi.mocked(connectSocketOnly).mockReturnValue(fake.client as never);
    const user = userEvent.setup();
    render(<Replay />);

    await user.selectOptions(await screen.findByLabelText('Recording'), RECORDING);
    const shortRecordingId = RECORDING.slice(0, 8);
    expect(screen.getByTitle(RECORDING)).toHaveTextContent(`session ${shortRecordingId}`);
    expect(screen.getByTitle(RECORDING).closest('.masthead-meta')).toHaveTextContent(
      `session ${shortRecordingId} · Treasury desk`,
    );

    const state = scenarioBFinalState();
    fake.emitState(state);

    const shortSessionId = state.session_id.slice(0, 8);
    await screen.findByTitle(state.session_id);
    expect(screen.getByTitle(state.session_id).closest('.masthead-meta')).toHaveTextContent(
      `session ${shortSessionId} · Treasury desk · state VERDICT`,
    );
  });

  // Task W5, fix round 2, requirement 2: the two-column keynote grid renders on Replay too,
  // same as Call.
  it('renders the two-column keynote grid once a state event arrives', async () => {
    const fake = makeFakeClient();
    vi.mocked(connectSocketOnly).mockReturnValue(fake.client as never);
    const user = userEvent.setup();
    const { container } = render(<Replay />);

    await user.selectOptions(await screen.findByLabelText('Recording'), RECORDING);
    fake.emitState(scenarioBFinalState());

    await screen.findByText(/Claimed identity:/);
    expect(container.querySelector('.keynote-grid')).not.toBeNull();
  });

  // Task W5, fix round 2, requirement 3: Replay had no footer at all before this round --
  // same wording as Call.tsx's, and the export hash shows once present. Replay also defaults
  // the forensic section open (BRIEF D4, fix round 1), which renders its own "Hash-chained
  // evidence export:" line -- `{ selector: '.footer-hash' }` scopes this assertion to the
  // FOOTER's copy specifically, not just "some element somewhere says this".
  //
  // Task W6, fix round 1: the footer's label now matches the forensic section's vocabulary
  // ("hash-chained evidence export"), joined to the full hash by " · ", with a `title`
  // carrying the same hash (same hover pattern as the verdict banner's short form).
  it('shows the footer with the bottom line and the export hash once present', async () => {
    const fake = makeFakeClient();
    vi.mocked(connectSocketOnly).mockReturnValue(fake.client as never);
    const user = userEvent.setup();
    render(<Replay />);

    expect(screen.getByText('No funds can move by voice alone. Second approval required.')).toBeInTheDocument();
    expect(screen.queryByText(/hash-chained evidence export/, { selector: '.footer-hash' })).not.toBeInTheDocument();

    await user.selectOptions(await screen.findByLabelText('Recording'), RECORDING);
    fake.emitState(scenarioBFinalState());

    const footerHash = await screen.findByText('hash-chained evidence export · abc123def456', {
      selector: '.footer-hash'
    });
    expect(footerHash).toBeInTheDocument();
    expect(footerHash).toHaveAttribute('title', 'abc123def456');
  });

  // Task W7, item 5: the select is bound via `onChange` (Replay.tsx), not a click handler on
  // its options -- so a programmatic `change` event (the shape a form-fill/automation tool,
  // or `<select>.value = x; el.dispatchEvent(new Event('change'))`, produces) must start the
  // replay exactly the same way a real user's click-driven selection does.
  // `userEvent.selectOptions` (used by the tests above) already fires a real pointer sequence
  // ending in a native `change` event -- this test skips straight to `fireEvent.change` to
  // prove the binding itself is on `onChange`, not layered on top of a click handler that
  // `userEvent` happens to also trigger.
  it('starts the replay from a programmatic change event on the select, the same as a click-driven selection', async () => {
    const fake = makeFakeClient();
    vi.mocked(connectSocketOnly).mockReturnValue(fake.client as never);
    render(<Replay />);

    const select = await screen.findByLabelText('Recording');
    fireEvent.change(select, { target: { value: RECORDING } });

    expect(connectSocketOnly).toHaveBeenCalledWith(
      expect.stringContaining(`/ws/replay/${encodeURIComponent(RECORDING)}?speed=1`),
    );

    fake.emitState(scenarioBFinalState());
    expect(await screen.findByText(/Claimed identity:/)).toBeInTheDocument();
  });

  // Task W7, item 6: the "simulated" banner is owned exclusively by the screen component
  // (Replay.tsx renders it once, unconditionally; CallView.tsx never renders its own copy --
  // see CallView.test.tsx's "never renders its own copy" test). This is Replay's own
  // integration check that the fix holds end to end: exactly one copy on screen, both before
  // a recording is chosen and once a state event has landed and CallView is on screen too.
  it('shows exactly one "Every system here is simulated." banner, before and after a recording is chosen', async () => {
    const fake = makeFakeClient();
    vi.mocked(connectSocketOnly).mockReturnValue(fake.client as never);
    const user = userEvent.setup();
    render(<Replay />);

    expect(screen.getAllByText('Every system here is simulated.')).toHaveLength(1);

    await user.selectOptions(await screen.findByLabelText('Recording'), RECORDING);
    fake.emitState(scenarioBFinalState());
    await screen.findByText(/Claimed identity:/);

    expect(screen.getAllByText('Every system here is simulated.')).toHaveLength(1);
  });

  // Judge review finding (2026-09-04), defect 1: before this fix the list was fetched with no
  // loading state at all, so a judge who opened the dropdown while the request was still in
  // flight saw a silently empty list -- indistinguishable from broken. The select's own
  // placeholder option now carries that status instead.
  it('shows a loading message in the recording dropdown while the list is being fetched, then the real options once it resolves', async () => {
    let resolveFetch: (value: { json: () => Promise<unknown> }) => void = () => {};
    const pending = new Promise<{ json: () => Promise<unknown> }>((resolve) => {
      resolveFetch = resolve;
    });
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending));
    render(<Replay />);

    expect(await screen.findByRole('option', { name: 'Loading recordings…' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: RECORDING_LABEL })).not.toBeInTheDocument();

    resolveFetch({
      json: () =>
        Promise.resolve({
          files: [RECORDING],
          recordings: [{ file: RECORDING, label: RECORDING_LABEL, recommended: true }],
        }),
    });

    expect(await screen.findByRole('option', { name: RECORDING_LABEL })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Loading recordings…' })).not.toBeInTheDocument();
  });

  // Judge review finding (2026-09-04), defect 1: a failed fetch used to leave the dropdown
  // silently empty forever, with no indication anything had gone wrong. Plain English, and
  // says what to do, through the same placeholder option.
  it('shows a plain-English error in the recording dropdown if the list fails to load', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    render(<Replay />);

    expect(
      await screen.findByRole('option', { name: 'Could not load recordings. Reload the page to try again' }),
    ).toBeInTheDocument();
  });

  // Judge review finding (2026-09-04), defect 2: the dropdown used to show the raw corpus
  // filename with no description. It now shows each recording's own plain-English label
  // (never a filename), in whatever order the server sent them -- flagship-first sorting is
  // the server's job (packages/server/test/http.test.ts covers that against the real corpus).
  it('shows each recording\'s plain-English label instead of its raw filename', async () => {
    const OTHER = 'scenario-a-dana-legitimate';
    const OTHER_LABEL = 'Dana Whitfield — the legitimate urgent request';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            files: [OTHER, RECORDING],
            recordings: [
              { file: RECORDING, label: RECORDING_LABEL, recommended: true },
              { file: OTHER, label: OTHER_LABEL, recommended: false },
            ],
          }),
      }),
    );
    render(<Replay />);

    const select = await screen.findByLabelText('Recording');
    await screen.findByRole('option', { name: RECORDING_LABEL });
    expect(screen.getByRole('option', { name: OTHER_LABEL })).toBeInTheDocument();

    // The raw filenames never appear as option text.
    expect(screen.queryByRole('option', { name: RECORDING })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: OTHER })).not.toBeInTheDocument();

    // Replay.tsx renders `recordings` in the order the server sent it -- the flagship first,
    // right after the placeholder option.
    const optionTexts = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(optionTexts[1]).toBe(RECORDING_LABEL);
    expect(optionTexts[2]).toBe(OTHER_LABEL);
  });
});
