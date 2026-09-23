import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';
import { attachWebSocketServer } from '../src/ws/browser.js';
import { newCapsState } from '../src/caps.js';
import { newDiagnosticsState } from '../src/diagnostics.js';
import { FakeAaiSocket } from '../src/aai/fake.js';
import { defaultCorpusDir, listCorpusFiles, listReplayAudioFiles, loadCorpusFile, loadReplayAudioPath } from '../src/replay.js';
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

// Founder ruling 2026-09-22 8:00 PM: the replay audio whitelist (packages/server/
// replay-audio/, TRACKED -- the founder commits the real .ogg files himself). A temp
// directory stands in so this proves the real filesystem behaviour (present, absent,
// mismatched extension, name not in the corpus) without depending on which .ogg files
// happen to be committed at test time.
describe('replay.ts — audio whitelist', () => {
  let audioDir: string;

  afterEach(() => {
    if (audioDir) rmSync(audioDir, { recursive: true, force: true });
  });

  it('lists only corpus names that have a matching .ogg file on disk', () => {
    audioDir = mkdtempSync(join(tmpdir(), 'countersign-replay-audio-'));
    writeFileSync(join(audioDir, 'recorded-stage.ogg'), 'fake-ogg-bytes');
    // Wrong extension -- never listed even though the corpus file exists.
    writeFileSync(join(audioDir, 'recorded-freeze.wav'), 'fake-wav-bytes');
    // Real-looking name but not an actual corpus file -- never listed.
    writeFileSync(join(audioDir, 'not-a-real-corpus-file.ogg'), 'fake-ogg-bytes');

    const files = listReplayAudioFiles(defaultCorpusDir(), audioDir);
    expect(files.has('recorded-stage')).toBe(true);
    expect(files.has('recorded-freeze')).toBe(false);
    expect(files.has('not-a-real-corpus-file')).toBe(false);
  });

  it('returns an empty set, never throws, when the audio directory does not exist', () => {
    const files = listReplayAudioFiles(defaultCorpusDir(), join(tmpdir(), 'countersign-replay-audio-does-not-exist'));
    expect(files.size).toBe(0);
  });

  it('resolves a real audio path only for a whitelisted name', () => {
    audioDir = mkdtempSync(join(tmpdir(), 'countersign-replay-audio-'));
    writeFileSync(join(audioDir, 'recorded-stage.ogg'), 'fake-ogg-bytes');

    const path = loadReplayAudioPath(defaultCorpusDir(), audioDir, 'recorded-stage');
    expect(path).toBe(join(audioDir, 'recorded-stage.ogg'));

    expect(loadReplayAudioPath(defaultCorpusDir(), audioDir, 'recorded-freeze')).toBeNull();
    expect(loadReplayAudioPath(defaultCorpusDir(), audioDir, '../../../etc/passwd')).toBeNull();
    expect(loadReplayAudioPath(defaultCorpusDir(), audioDir, '..')).toBeNull();
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
      diagnostics: newDiagnosticsState(),
      // Origin fix round 1: attachWebSocketServer's upgrade handler now gates on Origin
      // before it even looks at the path -- this replay-only test server never sets
      // COUNTERSIGN_TRUST_PROXY, and no custom allowlist matters here, only same-origin.
      cfg: { allowed_origins: [], trust_proxy: false },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return { wsBase: `ws://127.0.0.1:${addr.port}` };
  }

  /** Same-origin `Origin` header for a WS connection to this test's own server -- see
   *  browser-ws.test.ts's identical helper for the full reasoning (no TLS/proxy trust in
   *  this test server, so it's always plain `http://<host>`). */
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

  it('streams scenario-a at speed=50 and ends on a STAGE state with link "replay"', async () => {
    const { wsBase } = await start();
    const ws = new WebSocket(`${wsBase}/ws/replay/scenario-a-dana-legitimate?speed=50`, { origin: selfOriginFor(wsBase) });
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
    const ws = new WebSocket(`${wsBase}/ws/replay/scenario-b-miller-fraud?speed=50`, { origin: selfOriginFor(wsBase) });
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
    const ws = new WebSocket(`${wsBase}/ws/replay/scenario-a-dana-legitimate?speed=50`, { origin: selfOriginFor(wsBase) });
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
    const ws = new WebSocket(`${wsBase}/ws/replay/..`, { origin: selfOriginFor(wsBase) });
    const closeCode = await new Promise<number>((resolve) => {
      ws.once('close', (code) => resolve(code));
    });
    expect(closeCode).toBe(4404);
  });

  // Review finding 2026-09-22 8:21 PM: a malformed percent-escape used to throw inside the
  // 'upgrade' listener (uncaught: process exit). It must close 4404 and the server must live on.
  it('a malformed percent-escape on /ws/replay/ or /ws/call/ closes 4404 and the server keeps serving', async () => {
    const { wsBase } = await start();
    for (const path of ['/ws/replay/%zz', '/ws/call/%', '/ws/replay/%E0%A4%A']) {
      const ws = new WebSocket(`${wsBase}${path}`, { origin: selfOriginFor(wsBase) });
      const closeCode = await new Promise<number>((resolve) => {
        ws.once('close', (code) => resolve(code));
        ws.once('error', () => resolve(-1));
      });
      expect(closeCode).toBe(4404);
    }
    const ok = new WebSocket(`${wsBase}/ws/replay/..`, { origin: selfOriginFor(wsBase) });
    const stillServing = await new Promise<number>((resolve) => {
      ok.once('close', (code) => resolve(code));
      ok.once('error', () => resolve(-1));
    });
    expect(stillServing).toBe(4404);
  });

  it('rejects an unknown corpus file with close code 4404', async () => {
    const { wsBase } = await start();
    const ws = new WebSocket(`${wsBase}/ws/replay/not-a-real-corpus-file`, { origin: selfOriginFor(wsBase) });
    const closeCode = await new Promise<number>((resolve) => {
      ws.once('close', (code) => resolve(code));
    });
    expect(closeCode).toBe(4404);
  });
});
