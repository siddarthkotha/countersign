// packages/server/test/replay-recorded.test.ts
// PANEL-2026-09-22-LIVE-RELIABILITY.md: "the replay must carry audio, clearly labeled as a
// recorded call, driven by the real engine." packages/engine/corpus/recorded-*.json are three
// REAL founder calls against the deployed agent (not synthetic scripts) -- see each file's own
// `description` for the exact AssemblyAI-timeline/diagnostics-bundle derivation and measured
// clock offset. corpus.test.ts already proves each one reproduces its verdict through a single
// evaluate() call over the whole conversation/tools/actions at once; THIS file proves the same
// three files reproduce their verdict through the INCREMENTAL, timed path (`/ws/replay/:file` ->
// replay.ts's runReplay() -> the same evaluate()/deriveScreenState()/runOwedTerminalActions()
// sequence a live call and the Replay screen actually use) -- same shape as the existing
// scenario-a/scenario-b assertions in replay.test.ts, just pointed at the three recorded files.
import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import WebSocket from 'ws';
import { attachWebSocketServer } from '../src/ws/browser.js';
import { newCapsState } from '../src/caps.js';
import { newDiagnosticsState } from '../src/diagnostics.js';
import { FakeAaiSocket } from '../src/aai/fake.js';
import type { ServerEvent, Verdict } from '@countersign/engine';

describe('recorded-*.json — real founder calls replay to their verdict through runReplay()', () => {
  let closers: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  async function start(): Promise<{ wsBase: string }> {
    const server: Server = createServer();
    attachWebSocketServer(server, {
      caps: newCapsState(),
      now: () => Date.now(),
      createAai: () => new FakeAaiSocket(),
      diagnostics: newDiagnosticsState(),
      cfg: { allowed_origins: [], trust_proxy: false },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return { wsBase: `ws://127.0.0.1:${addr.port}` };
  }

  function selfOriginFor(wsBase: string): string {
    return wsBase.replace(/^ws:/, 'http:');
  }

  function collectUntilEnded(ws: WebSocket): Promise<ServerEvent[]> {
    const out: ServerEvent[] = [];
    return new Promise((resolve) => {
      ws.on('message', (data) => {
        const evt = JSON.parse(data.toString()) as ServerEvent;
        out.push(evt);
        if (evt.type === 'ended') resolve(out);
      });
    });
  }

  async function replayVerdict(file: string): Promise<{ verdict: Verdict; exportHash: string | null }> {
    const { wsBase } = await start();
    const ws = new WebSocket(`${wsBase}/ws/replay/${file}?speed=50`, { origin: selfOriginFor(wsBase) });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const events = await collectUntilEnded(ws);
    const stateEvents = events.filter((e) => e.type === 'state');
    expect(stateEvents.length).toBeGreaterThan(0);
    const last = stateEvents.at(-1);
    expect(last?.type).toBe('state');
    ws.close();
    if (last?.type !== 'state') throw new Error('unreachable');
    return { verdict: last.state.verdict, exportHash: last.state.forensic.export_hash };
  }

  it('recorded-stage.json (record 8f7fa2f2, 2026-09-22 founder call) replays to STAGE', async () => {
    const { verdict, exportHash } = await replayVerdict('recorded-stage');
    expect(verdict).toBe('STAGE');
    expect(exportHash).not.toBeNull();
  }, 10000);

  it('recorded-escalate.json (record b674e6e8, 2026-09-21 founder call) replays to ESCALATE', async () => {
    const { verdict, exportHash } = await replayVerdict('recorded-escalate');
    expect(verdict).toBe('ESCALATE');
    expect(exportHash).not.toBeNull();
  }, 10000);

  it('recorded-freeze.json (record cce6200f, 2026-09-22 founder call) replays to FREEZE', async () => {
    const { verdict, exportHash } = await replayVerdict('recorded-freeze');
    expect(verdict).toBe('FREEZE');
    expect(exportHash).not.toBeNull();
  }, 10000);
});
