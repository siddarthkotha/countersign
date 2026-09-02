// packages/server/src/static.ts
// Serves the built React SPA (packages/web/dist) from the same process/port as the API and
// WebSocket routes (Task D1 -- one always-on container, no separate static host). Mounted as
// the LAST fallback in http.ts's request handler: any GET/HEAD that didn't match an /api or
// /ws route either serves a real file out of dist/, or -- for an unknown client-side route
// like /replay -- falls back to index.html so the SPA's own router can handle it. `/api` and
// `/ws` paths are never touched here, even if unmatched upstream: they get the API's plain
// JSON 404, not an HTML page.
//
// Path safety: any raw or decoded path containing `..` or a null byte is rejected with 404
// before it ever reaches the filesystem, and the resolved path is re-checked (both lexically
// and via `realpathSync`, so a symlink planted inside dist can't point somewhere else) to
// fall inside `distRoot` -- belt and suspenders against traversal.
import { createReadStream, existsSync, fstatSync, realpathSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

const MIME_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

export interface StaticServer {
  /** Resolved, absolute dist directory this instance serves from. */
  readonly distRoot: string;
  /** Whether `distRoot` exists on disk -- false in plain `dev:server` (no build has run
   *  yet), in which case `handle` always returns false and the caller's own 404 applies. */
  readonly available: boolean;
  /** Attempts to serve `req` as a static asset or the SPA fallback. Returns true if it wrote
   *  a response (caller must not write anything else), false if it declined (caller falls
   *  through to its own 404 -- happens for methods other than GET/HEAD, /api and /ws paths,
   *  and when `available` is false). */
  handle(req: IncomingMessage, res: ServerResponse): boolean;
}

function contentTypeFor(filePath: string): string {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function cacheControlFor(urlPath: string, servedIndexFallback: boolean): string {
  // "immutable" below is the literal HTTP Cache-Control token, never a claim about the
  // engine or its evidence (LAW 4's vocabulary rule is about "sealed"/"cryptographically
  // guaranteed" evidence language, not this unrelated HTTP header keyword).
  if (!servedIndexFallback && urlPath.startsWith('/assets/')) {
    return 'public, max-age=31536000, immutable';
  }
  return 'no-cache';
}

function sendNotFound(res: ServerResponse, method: string | undefined): void {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  // HEAD: headers only, no body (D1 fix round 1 #1) -- same status/headers a GET of the same
  // URL would have gotten, just zero bytes written.
  res.end(method === 'HEAD' ? undefined : 'not found');
}

function sendFile(res: ServerResponse, filePath: string, cacheControl: string, method: string | undefined): void {
  // D1 fix round 2: round 1 still opened a TOCTOU window -- it read `statSync(filePath)`
  // (a fresh, unguarded, synchronous fs call) *before* creating the stream or writing any
  // header, in the exact same "file disappears between handle()'s existsSync check and this
  // call" race the original finding described; that throw was uncaught and could crash the
  // process. Fixed by reordering: create the stream and attach its 'error' handler FIRST
  // (before any header goes out, so the `!res.headersSent` branch below is finally reachable
  // rather than dead code), and get the size from `fstatSync` on the stream's own open file
  // descriptor (its 'open' event) instead of a second `statSync(filePath)` call -- fstat on
  // an already-open fd can't be invalidated by the file disappearing afterward (POSIX keeps
  // an open fd's inode alive even once its directory entry is removed), so there is no
  // remaining stat-time race at all, not just a caught one.
  const stream = createReadStream(filePath);

  stream.on('error', () => {
    if (!res.headersSent) {
      sendNotFound(res, method);
    } else {
      res.destroy();
    }
  });

  stream.on('open', (fd: number) => {
    let size: number;
    try {
      size = fstatSync(fd).size;
    } catch {
      // Vanishingly unlikely with an already-open fd, but every synchronous fs call in this
      // file degrades instead of throwing -- no exception here should be different.
      if (!res.headersSent) sendNotFound(res, method);
      else res.destroy();
      stream.destroy();
      return;
    }

    res.writeHead(200, {
      'Content-Type': contentTypeFor(filePath),
      'Content-Length': size,
      'Cache-Control': cacheControl,
    });

    if (method === 'HEAD') {
      // Headers only, no body -- close the fd without reading/piping any data.
      res.end();
      stream.destroy();
      return;
    }

    stream.pipe(res);
  });
}

/** Decodes and safety-checks a raw URL path (query string already stripped by the caller),
 *  returning the absolute file path inside `root` it maps to, or null if the path is unsafe
 *  or escapes `root`. Purely lexical -- `handle` below additionally re-checks the final,
 *  existing file's `realpathSync` against `root`'s, so a symlink inside dist that points
 *  outside it still can't be served (D1 fix round 1 #3). */
function resolveSafe(root: string, rawPath: string): string | null {
  // D1 fix round 1 #2: the null-byte check used to compare against a literal raw NUL typed
  // directly into the source, which renders as an invisible space in most editors/diffs/git
  // tooling -- functionally correct but a landmine for anyone who can't see what's really
  // there. The '\0' escape is the same byte, spelled so it can be read, grepped, and survives
  // any tool that normalizes whitespace/control characters.
  if (rawPath.includes('\0') || rawPath.includes('..')) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('..')) return null;

  const rel = decoded.replace(/^\/+/, '');
  const full = resolve(root, rel);
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

export function createStaticServer(distDir: string): StaticServer {
  const root = resolve(distDir);
  const available = existsSync(root) && statSync(root).isDirectory();
  const indexPath = join(root, 'index.html');
  // Resolved once at startup, not per-request: `root` is a build-time constant
  // (packages/web/dist), not something a request can influence, so there's no TOCTOU risk in
  // caching this. Falls back to the lexical `root` when it doesn't exist yet -- `available`
  // is already false in that case, so `handle` never gets far enough to use this.
  const realRoot = available ? realpathSync(root) : root;

  return {
    distRoot: root,
    available,
    handle(req, res) {
      if (!available) return false;
      const method = req.method;
      // D1 fix round 1 #1: HEAD must reach the same handling GET does -- it used to be
      // gated out one level up in http.ts before it ever got here, even though this function
      // already supported it.
      if (method !== 'GET' && method !== 'HEAD') return false;

      const rawPath = (req.url ?? '/').split('?')[0] ?? '/';
      if (rawPath.startsWith('/api') || rawPath.startsWith('/ws')) return false;

      const target = resolveSafe(root, rawPath === '/' ? '/index.html' : rawPath);
      if (target === null) {
        sendNotFound(res, method);
        return true;
      }

      let servedIndexFallback = false;
      let filePath = target;
      try {
        const stat = statSync(filePath);
        if (stat.isDirectory()) {
          filePath = join(filePath, 'index.html');
          servedIndexFallback = true;
        }
      } catch {
        // No exact file on disk: this is a client-side route (e.g. /replay) that the SPA's
        // own router owns, not a real 404 -- serve index.html so React Router can take it.
        filePath = indexPath;
        servedIndexFallback = true;
      }

      if (!existsSync(filePath)) {
        sendNotFound(res, method);
        return true;
      }

      // D1 fix round 1 #3: the lexical containment check in `resolveSafe` can't see through
      // a symlink -- a path that lexically resolves inside `root` but is actually a symlink
      // pointing elsewhere would still pass it. `realpathSync` follows any symlinks and gives
      // the true target; reject if that true target isn't inside `realRoot`.
      let realFile: string;
      try {
        realFile = realpathSync(filePath);
      } catch {
        sendNotFound(res, method);
        return true;
      }
      if (realFile !== realRoot && !realFile.startsWith(realRoot + sep)) {
        sendNotFound(res, method);
        return true;
      }

      sendFile(res, filePath, cacheControlFor(rawPath, servedIndexFallback), method);
      return true;
    },
  };
}
