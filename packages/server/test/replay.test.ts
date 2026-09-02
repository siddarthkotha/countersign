import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import WebSocket from 'ws';
import { attachWebSocketServer } from '../src/ws/browser.js';
import { newCapsState } from '../src/caps.js';
import { FakeAaiSocket } from '../src/aai/fake.js';
import { defaultCorpusDir, listCorpusFiles, loadCorpusFile } from '../src/replay.js';
import type { ServerEvent } from '@countersign/engine';

describe('replay.ts — corpus file whitelist', () => {
  it('lists real corpus file names without the .json extension', () => {
    const files = listCorpusFiles(defaultCorpusDir());
    expect(files.has('scenario-a-dana-legitimate')).toBe(true);
    expect(files.has('scenario-b-miller-fraud')).toBe(true);
  });

  it('loads a real corpus file', () => {
    const corpus = loadCorpusFile(defaultCorpusDir(), 'scenario-a-dana-legitimate');
    expect(corpus).not.toBeNull();
    expect(corpus?.call.session_id).toBe('sess-a');
  });

  it('rejects a path-traversal attempt', () => {
    expect(loadCorpusFile(defaultCorpusDir(), '../../../etc/passwd')).toBeNull();
    expect(loadCorpusFile(defaultCorpusDir(), '..')).toBeNull();
    expect(loadCorpusFile(defaultCorpusDir(), 'scenario-a-dana-legitimate/../../../etc/passwd')).toBeNull();
  });

  it('rejects an unknown file name', () => {
    expect(loadCorpusFile(defaultCorpusDir(), 'not-a-real-corpus-file')).toBeNull();
  });
});

describe('ws/browser — /ws/replay/:file', () => {
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
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return { wsBase: `ws://127.0.0.1:${addr.port}` };
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

  it('streams scenario-a at speed=50 and ends on a STAGE state with link "replay"', async () => {
    const { wsBase } = await start();
    const ws = new WebSocket(`${wsBase}/ws/replay/scenario-a-dana-legitimate?speed=50`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });

    const events = await collectUntilEnded(ws);
    const stateEvents = events.filter((e) => e.type === 'state');
    expect(stateEvents.length).toBeGreaterThan(0);

    const last = stateEvents.at(-1);
    if (last?.type === 'state') {
      expect(last.state.verdict).toBe('STAGE');
      expect(last.state.link).toBe('replay');
      expect(last.state.simulated).toBe(true);
    }

    ws.close();
  }, 10000);

  it('IMPORTANT 3 (final review): scenario-b ends with a non-null export_hash and recomputed true, same as a live run', async () => {
    const { wsBase } = await start();
    const ws = new WebSocket(`${wsBase}/ws/replay/scenario-b-miller-fraud?speed=50`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });

    const events = await collectUntilEnded(ws);
    const stateEvents = events.filter((e) => e.type === 'state');
    const last = stateEvents.at(-1);
    expect(last?.type).toBe('state');
    if (last?.type === 'state') {
      expect(last.state.verdict).toBe('FREEZE');
      expect(last.state.forensic.export_hash).not.toBeNull();
      expect(last.state.forensic.countersign).toEqual({ server_verdict: 'FREEZE', recomputed: true });
    }

    ws.close();
  }, 10000);

  it('IMPORTANT 3 (final review): scenario-a (STAGE) also ends with a non-null export_hash and recomputed true', async () => {
    const { wsBase } = await start();
    const ws = new WebSocket(`${wsBase}/ws/replay/scenario-a-dana-legitimate?speed=50`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });

    const events = await collectUntilEnded(ws);
    const stateEvents = events.filter((e) => e.type === 'state');
    const last = stateEvents.at(-1);
    expect(last?.type).toBe('state');
    if (last?.type === 'state') {
      expect(last.state.verdict).toBe('STAGE');
      expect(last.state.forensic.export_hash).not.toBeNull();
      expect(last.state.forensic.countersign).toEqual({ server_verdict: 'STAGE', recomputed: true });
    }

    ws.close();
  }, 10000);

  it('rejects a replay path containing ".." with close code 4404', async () => {
    const { wsBase } = await start();
    const ws = new WebSocket(`${wsBase}/ws/replay/..`);
    const closeCode = await new Promise<number>((resolve) => {
      ws.once('close', (code) => resolve(code));
    });
    expect(closeCode).toBe(4404);
  });

  it('rejects an unknown corpus file with close code 4404', async () => {
    const { wsBase } = await start();
    const ws = new WebSocket(`${wsBase}/ws/replay/not-a-real-corpus-file`);
    const closeCode = await new Promise<number>((resolve) => {
      ws.once('close', (code) => resolve(code));
    });
    expect(closeCode).toBe(4404);
  });
});
