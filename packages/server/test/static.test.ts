// packages/server/test/static.test.ts
// Task D1: unit tests for the SPA static server -- SPA fallback, MIME types, cache headers,
// path-traversal rejection, and missing-dist behaviour (plain `dev:server`, no build run
// yet). Builds a throwaway fixture dist/ under the OS temp dir per test file, so this never
// depends on `packages/web/dist` actually being built.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStaticServer } from '../src/static.js';

function startServerFor(distDir: string): Promise<{ server: Server; base: string; close: () => Promise<void> }> {
  const staticServer = createStaticServer(distDir);
  const server = createServer((req, res) => {
    if (!staticServer.handle(req, res)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        server,
        base: `http://127.0.0.1:${addr.port}`,
        // `fetch` (undici) keeps its HTTP keep-alive socket open after each request; a plain
        // `server.close()` waits for that socket to close on its own before firing its
        // callback (multi-second undici idle timeout), so tests would hang unnecessarily.
        // `closeAllConnections` drops sockets immediately -- fine here since nothing needs a
        // graceful drain in a test.
        close: () =>
          new Promise((res) => {
            server.closeAllConnections();
            server.close(() => res());
          }),
      });
    });
  });
}

describe('static.ts -- SPA static server', () => {
  let fixtureDir: string;

  beforeAll(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'countersign-static-'));
    writeFileSync(join(fixtureDir, 'index.html'), '<!doctype html><html><body>shell</body></html>');
    mkdirSync(join(fixtureDir, 'assets'));
    writeFileSync(join(fixtureDir, 'assets', 'index-ABC123.js'), 'console.log("hi")');
    writeFileSync(join(fixtureDir, 'assets', 'index-ABC123.css'), 'body{color:red}');
    writeFileSync(join(fixtureDir, 'favicon.svg'), '<svg></svg>');
  });

  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  async function withServer<T>(distDir: string, fn: (base: string) => Promise<T>): Promise<T> {
    const started = await startServerFor(distDir);
    try {
      return await fn(started.base);
    } finally {
      await started.close();
    }
  }

  it('serves index.html at / with no-cache', async () => {
    await withServer(fixtureDir, async (base) => {
      const r = await fetch(`${base}/`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain('text/html');
      expect(r.headers.get('cache-control')).toBe('no-cache');
      expect(await r.text()).toContain('shell');
    });
  });

  it('SPA fallback: an unknown client-side route serves index.html, not a 404', async () => {
    await withServer(fixtureDir, async (base) => {
      const r = await fetch(`${base}/replay/scenario-b-miller-fraud`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain('text/html');
      expect(await r.text()).toContain('shell');
    });
  });

  it('serves a real asset with correct MIME and immutable long-cache headers', async () => {
    await withServer(fixtureDir, async (base) => {
      const rJs = await fetch(`${base}/assets/index-ABC123.js`);
      expect(rJs.status).toBe(200);
      expect(rJs.headers.get('content-type')).toContain('text/javascript');
      expect(rJs.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

      const rCss = await fetch(`${base}/assets/index-ABC123.css`);
      expect(rCss.status).toBe(200);
      expect(rCss.headers.get('content-type')).toContain('text/css');
      expect(rCss.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    });
  });

  it('serves a non-/assets/ file (e.g. favicon.svg) with the right MIME and short cache', async () => {
    await withServer(fixtureDir, async (base) => {
      const r = await fetch(`${base}/favicon.svg`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain('image/svg+xml');
      expect(r.headers.get('cache-control')).toBe('no-cache');
    });
  });

  it('rejects a raw path-traversal attempt with 404, never touching the filesystem outside dist', async () => {
    // Every real HTTP client (curl, undici/fetch) normalizes '..' out of a URL before it
    // ever reaches the wire, so a literal traversal request can only be exercised by
    // calling `handle` directly with a raw, unnormalized `req.url` -- exactly what the
    // guard in static.ts (called before any decoding) has to defend against.
    const staticServer = createStaticServer(fixtureDir);
    const fakeReq = { method: 'GET', url: '/../../../etc/passwd' } as import('node:http').IncomingMessage;
    let capturedStatus = 0;
    const fakeRes = {
      writeHead(status: number) {
        capturedStatus = status;
        return fakeRes;
      },
      end() {
        return fakeRes;
      },
    } as unknown as import('node:http').ServerResponse;
    const handled = staticServer.handle(fakeReq, fakeRes);
    expect(handled).toBe(true);
    expect(capturedStatus).toBe(404);
  });

  it('rejects an encoded traversal attempt (%2e%2e) with 404', async () => {
    const staticServer = createStaticServer(fixtureDir);
    const fakeReq = { method: 'GET', url: '/%2e%2e/%2e%2e/etc/passwd' } as import('node:http').IncomingMessage;
    let capturedStatus = 0;
    const fakeRes = {
      writeHead(status: number) {
        capturedStatus = status;
        return fakeRes;
      },
      end() {
        return fakeRes;
      },
    } as unknown as import('node:http').ServerResponse;
    const handled = staticServer.handle(fakeReq, fakeRes);
    expect(handled).toBe(true);
    expect(capturedStatus).toBe(404);
  });

  it('rejects a null-byte path with 404', async () => {
    const staticServer = createStaticServer(fixtureDir);
    const fakeReq = { method: 'GET', url: '/foo%00bar' } as import('node:http').IncomingMessage;
    let capturedStatus = 0;
    const fakeRes = {
      writeHead(status: number) {
        capturedStatus = status;
        return fakeRes;
      },
      end() {
        return fakeRes;
      },
    } as unknown as import('node:http').ServerResponse;
    const handled = staticServer.handle(fakeReq, fakeRes);
    expect(handled).toBe(true);
    expect(capturedStatus).toBe(404);
  });

  it('declines /api and /ws paths so an unmatched API route still gets the JSON 404', async () => {
    await withServer(fixtureDir, async (base) => {
      const rApi = await fetch(`${base}/api/nonexistent`);
      expect(rApi.status).toBe(404);
      const bodyApi = await rApi.json();
      expect(bodyApi).toEqual({ error: 'not found' });

      const rWs = await fetch(`${base}/ws/call/whatever`);
      expect(rWs.status).toBe(404);
      const bodyWs = await rWs.json();
      expect(bodyWs).toEqual({ error: 'not found' });
    });
  });

  it('missing dist directory: available is false and handle always declines', async () => {
    const missingDir = join(fixtureDir, 'does-not-exist');
    const staticServer = createStaticServer(missingDir);
    expect(staticServer.available).toBe(false);

    await withServer(missingDir, async (base) => {
      const r = await fetch(`${base}/`);
      expect(r.status).toBe(404);
      const body = await r.json();
      expect(body).toEqual({ error: 'not found' });
    });
  });
});
