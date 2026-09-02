// packages/server/test/static-stream-error.test.ts
// D1 fix round 1 #4 (and its round-2 follow-up): sendFile (static.ts) used to
// `createReadStream(filePath).pipe(res)` with no 'error' listener -- an unhandled stream
// error (e.g. the file disappearing between the existsSync check and this read, a redeploy
// overwriting dist/ mid-request) is an uncaught exception that can crash the whole Node
// process. Round 1 added the 'error' listener but left a separate, unguarded
// `statSync(filePath)` running *before* it (same TOCTOU race, one line earlier) and its
// `!res.headersSent` branch was dead code, since `writeHead` always ran before the stream
// even existed. Round 2 (task-D1-rereview.md finding #4) fixed both: the stream is created
// and its 'error' handler attached before any header is written, and the file's size comes
// from `fstatSync` on the stream's own already-open file descriptor (its 'open' event)
// instead of a second `statSync(filePath)` call, closing the race rather than just
// catching it.
//
// This file proves all three surviving code paths deterministically, without depending on
// OS file-permission behavior or timing: `node:fs`'s `createReadStream` and `fstatSync` are
// mocked, for this file only (`importOriginal` passes every other export through to the
// real filesystem, which the fixture setup below relies on).
//
// (a) fstatSync throws right after a REAL, successful open() -- the residual defensive
//     catch around the new fstatSync call (round 2's replacement for round 1's vulnerable
//     freestanding statSync) -- degrades to 404, headers never sent.
// (b) createReadStream itself never gets to 'open' (e.g. ENOENT) -- 'error' fires before
//     any header goes out -- degrades to a clean 404.
// (c) createReadStream opens fine (headers get sent) but errors mid-read -- the
//     `res.destroy()` branch, not a throw.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';

type Mode = 'normal' | 'fail-open' | 'fail-fstat' | 'fail-mid-read';
let mode: Mode = 'normal';
const FAKE_FD = 999;

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      if (mode === 'fail-open') {
        // Never opens: only 'error' ever fires, exactly like a real ENOENT/EACCES on open().
        // Scheduled at construction time, NOT inside `read()` -- static.ts never consumes
        // this stream (no 'open' ever arrives, so it never gets piped/resumed), and a
        // paused Readable with no consumer never calls its own `read()`. A real fs.ReadStream
        // begins its open() call immediately on construction regardless of whether anyone's
        // consuming yet, which is the behavior this needs to match.
        const stream = new Readable({ read() {} });
        process.nextTick(() => stream.emit('error', new Error('simulated open failure')));
        return stream as unknown as ReturnType<typeof actual.createReadStream>;
      }
      if (mode === 'fail-mid-read') {
        // Opens successfully (a fake fd -- static.ts's 'open' handler only uses it to call
        // the also-mocked fstatSync below, never a real syscall), then errors once reading
        // actually starts (`.pipe()` pulling data) -- models a real file's read failing
        // partway through (disk I/O error, truncated/replaced mid-stream), which a real
        // fs.ReadStream can't be coerced into deterministically from a test.
        const stream = new Readable({
          read() {
            process.nextTick(() => stream.emit('error', new Error('simulated mid-read failure')));
          },
        });
        process.nextTick(() => stream.emit('open', FAKE_FD));
        return stream as unknown as ReturnType<typeof actual.createReadStream>;
      }
      // 'normal' and 'fail-fstat' both open the file for real -- 'fail-fstat' only fails the
      // later fstatSync call below, on a real, successfully-opened fd.
      return actual.createReadStream(...args);
    },
    fstatSync: (...args: Parameters<typeof actual.fstatSync>) => {
      const [fd] = args;
      if (mode === 'fail-mid-read' && fd === FAKE_FD) {
        return { size: 42 } as ReturnType<typeof actual.fstatSync>;
      }
      if (mode === 'fail-fstat') {
        throw new Error('simulated fstat failure');
      }
      return actual.fstatSync(...args);
    },
  };
});

const { createStaticServer } = await import('../src/static.js');

async function withFixtureServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
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
      return await fn(base);
    } finally {
      server.closeAllConnections();
      await new Promise((res) => server.close(() => res(undefined)));
    }
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

describe('static.ts -- sendFile stream/stat error handling (D1 fix round 1 #4 + round 2)', () => {
  afterEach(() => {
    mode = 'normal';
  });

  it('(a) fstatSync throwing right after a successful open degrades to 404, not a throw', async () => {
    mode = 'fail-fstat';
    await withFixtureServer(async (base) => {
      const r = await fetch(`${base}/assets/index-ABC123.js`);
      expect(r.status).toBe(404);

      // Process survival + still-serving proof: a normal request right after works fine.
      mode = 'normal';
      const rAfter = await fetch(`${base}/`);
      expect(rAfter.status).toBe(200);
      expect(await rAfter.text()).toContain('shell');
    });
  });

  it('(b) a stream that never opens (error before any header) is a clean 404, not a throw', async () => {
    mode = 'fail-open';
    await withFixtureServer(async (base) => {
      const r = await fetch(`${base}/assets/index-ABC123.js`);
      expect(r.status).toBe(404);

      mode = 'normal';
      const rAfter = await fetch(`${base}/`);
      expect(rAfter.status).toBe(200);
      expect(await rAfter.text()).toContain('shell');
    });
  });

  it('(c) a stream that errors after headers are sent destroys the response, not a throw', async () => {
    mode = 'fail-mid-read';
    await withFixtureServer(async (base) => {
      // Headers (200, the real Content-Length from the mocked fstat) go out normally; the
      // body then fails mid-stream, so the connection gets torn down rather than completing
      // -- fetch() itself may still resolve (headers already arrived) but reading the body
      // must reject, never hang and never crash the server. Not a two-arg `.then(success,
      // failure)`: the failure can come from either `fetch()` rejecting outright or from
      // `r.text()` rejecting after a response object was already handed back, and a two-arg
      // `.then` only catches the former.
      let bodyFailed = false;
      await fetch(`${base}/assets/index-ABC123.js`)
        .then((r) => r.text())
        .catch(() => {
          bodyFailed = true;
        });
      expect(bodyFailed).toBe(true);

      // The real proof: the server process is still alive and correctly serving other
      // requests right after -- nothing propagated past sendFile's error handler.
      mode = 'normal';
      const rAfter = await fetch(`${base}/`);
      expect(rAfter.status).toBe(200);
      expect(await rAfter.text()).toContain('shell');
    });
  });
});
