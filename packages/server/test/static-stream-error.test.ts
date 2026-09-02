// packages/server/test/static-stream-error.test.ts
// D1 fix round 1 #4: sendFile (static.ts) used to `createReadStream(filePath).pipe(res)`
// with no 'error' listener -- an unhandled stream error (e.g. the file disappearing between
// the existsSync check and this read, a redeploy overwriting dist/ mid-request) is an
// uncaught exception that can crash the whole Node process. This test proves the fix without
// depending on OS file-permission behavior (which varies by platform/CI user, e.g. root):
// `node:fs`'s `createReadStream` is mocked, for this file only, to return a stream that
// always emits an 'error' event -- deterministic, and exercises the exact code path a real
// disappearing-file race would hit. Every other `node:fs` export passes through unmocked
// (`importOriginal`), so the SPA fixture setup below still uses the real filesystem.
import { describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';

// Fails exactly the FIRST createReadStream call, then delegates to the real implementation
// for every call after -- models one file disappearing once (a single request's worth of
// bad luck), not every read forever, so the test's own "server still serves the next request
// correctly" check exercises a REAL read (real index.html bytes), not another mocked failure.
let failNextStream = true;

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      if (!failNextStream) return actual.createReadStream(...args);
      failNextStream = false;
      const stream = new Readable({
        read() {
          // Real fs open()/read() errors surface asynchronously (after any synchronous
          // writeHead the caller already did), never on the same tick -- process.nextTick
          // reproduces that ordering instead of erroring before the caller can even attach
          // the 'error' listener.
          process.nextTick(() => stream.emit('error', new Error('simulated read failure')));
        },
      });
      return stream as unknown as ReturnType<typeof actual.createReadStream>;
    },
  };
});

const { createStaticServer } = await import('../src/static.js');

describe('static.ts -- sendFile stream error handling (D1 fix round 1 #4)', () => {
  it('a stream error does not crash the process and the server keeps serving other requests', async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'countersign-static-streamerr-'));
    try {
      writeFileSync(join(fixtureDir, 'index.html'), '<!doctype html><html><body>shell</body></html>');
      mkdirSync(join(fixtureDir, 'assets'));
      writeFileSync(join(fixtureDir, 'assets', 'index-ABC123.js'), 'console.log("hi")');

      const staticServer = createStaticServer(fixtureDir);
      const server: Server = createServer((req, res) => {
        if (!staticServer.handle(req, res)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
        }
      });

      const base = await new Promise<string>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address() as AddressInfo;
          resolve(`http://127.0.0.1:${addr.port}`);
        });
      });

      try {
        // The mocked stream always errors -- this request must not throw inside the server
        // (an uncaught exception here would crash the whole test-runner process, not just
        // fail an assertion), whatever shape the client sees it as (a network error from the
        // destroyed connection is expected and fine).
        // Two-step, not a two-arg `.then(success, failure)`: the failure could come from
        // `fetch()` itself rejecting (no response ever arrived) OR from `r.text()` rejecting
        // (a response with headers "sent" -- i.e. queued, Node only actually flushes them on
        // the first body write -- but whose body stream then errors) -- a two-arg `.then`
        // only catches the former, letting the latter escape uncaught through this `await`.
        await fetch(`${base}/assets/index-ABC123.js`)
          .then((r) => r.text())
          .catch(() => undefined);

        // The real proof: the server process is still alive and correctly serving other
        // requests right after the stream error -- nothing propagated past sendFile.
        const rAfter = await fetch(`${base}/`);
        expect(rAfter.status).toBe(200);
        expect(await rAfter.text()).toContain('shell');
      } finally {
        server.closeAllConnections();
        await new Promise((res) => server.close(() => res(undefined)));
      }
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
