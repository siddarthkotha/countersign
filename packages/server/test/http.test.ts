import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHttpServer } from '../src/http.js';
import { createStaticServer } from '../src/static.js';
import { newDiagnosticsState, type DiagnosticsState, type DiagnosticBundle } from '../src/diagnostics.js';
import { markLiveCallsUnavailable, type CapsState } from '../src/caps.js';
import type { ServerConfig } from '../src/config.js';

interface StartResponseBody {
  session_id: string;
  ws_path: string;
  cap_seconds: number;
}

function cfg(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    port: 0,
    assemblyai_api_key: 'secret-key',
    session_cap_seconds: 300,
    max_concurrent: 2,
    idle_timeout_ms: 30000,
    daily_session_cap: 40,
    mint_rate_per_minute: 100,
    kill_switch: false,
    allowed_origins: ['http://localhost:5173'],
    trust_proxy: false,
    browser_grace_ms: 20000,
    ...overrides,
  };
}

describe('http server', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close) {
      await close();
      close = undefined;
    }
  });

  function start(
    cfgOverrides: Partial<ServerConfig> = {},
    dropAaiImpl?: (session_id: string) => boolean,
  ): Promise<{
    server: Server;
    state: CapsState;
    diagnostics: DiagnosticsState;
    base: string;
  }> {
    let counter = 0;
    const clock = 1000;
    const ids = [
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
      '33333333-3333-3333-3333-333333333333',
      '44444444-4444-4444-4444-444444444444',
    ];
    // These http.test.ts cases never open a `/ws/call/:id` socket -- there is no live
    // `CallSession` here, only the caps reservation `/api/session/start` made. A minimal
    // `endCall` stub (free the caps slot if it's active) exercises exactly what http.ts's
    // `/end`/`/reset` routes actually need from it (CRITICAL 1, final review); `ws/browser.
    // test.ts` covers the real `endCall` -- ending a live call, not just a reservation.
    let stateRef: CapsState;
    const diagnostics = newDiagnosticsState();
    const { server, state } = createHttpServer(cfg(cfgOverrides), {
      fetchImpl: globalThis.fetch,
      now: () => clock,
      randomId: () => ids[counter++] ?? `99999999-9999-9999-9999-99999999999${counter}`,
      endCall: (id) => {
        if (stateRef.active.has(id)) {
          stateRef.active.delete(id);
          return true;
        }
        return false;
      },
      // Rehearsal-harness debug hook: omitted (undefined) by every existing test here, same
      // as production behavior when COUNTERSIGN_DEBUG_HOOKS is unset -- only the dedicated
      // debug-hook describe block below supplies a stub.
      ...(dropAaiImpl ? { dropAai: dropAaiImpl } : {}),
      diagnostics,
    });
    stateRef = state;
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        close = () => new Promise((res) => server.close(() => res()));
        resolve({ server, state, diagnostics, base: `http://127.0.0.1:${addr.port}` });
      });
    });
  }

  it('start then start then session_in_use, reset frees a slot', async () => {
    const { base } = await start();

    const r1 = await fetch(`${base}/api/session/start`, { method: 'POST' });
    expect(r1.status).toBe(200);
    const b1 = await r1.json();
    expect(b1).toEqual({
      session_id: '11111111-1111-1111-1111-111111111111',
      ws_path: '/ws/call/11111111-1111-1111-1111-111111111111',
      cap_seconds: 300,
      live_calls: { available: true, reason: null },
    });

    const r2 = await fetch(`${base}/api/session/start`, { method: 'POST' });
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as StartResponseBody;
    expect(b2.session_id).toBe('22222222-2222-2222-2222-222222222222');

    const r3 = await fetch(`${base}/api/session/start`, { method: 'POST' });
    expect(r3.status).toBe(429);
    const b3 = await r3.json();
    expect(b3).toEqual({
      replay_only: true,
      reason: 'session_in_use',
      live_calls: { available: true, reason: null },
    });

    const rReset = await fetch(`${base}/api/session/11111111-1111-1111-1111-111111111111/reset`, {
      method: 'POST',
    });
    expect(rReset.status).toBe(204);

    const r4 = await fetch(`${base}/api/session/start`, { method: 'POST' });
    expect(r4.status).toBe(200);
    const b4 = (await r4.json()) as StartResponseBody;
    expect(b4.session_id).toBe('33333333-3333-3333-3333-333333333333');
  });

  it('garbage session id returns 404', async () => {
    const { base } = await start();
    const r = await fetch(`${base}/api/session/not-a-uuid/reset`, { method: 'POST' });
    expect(r.status).toBe(404);
    const body = await r.json();
    expect(body).toEqual({ error: 'not_found' });
  });

  it('well-formed but unknown session id returns 404', async () => {
    const { base } = await start();
    const r = await fetch(`${base}/api/session/99999999-9999-9999-9999-999999999999/end`, {
      method: 'POST',
    });
    expect(r.status).toBe(404);
    const body = await r.json();
    expect(body).toEqual({ error: 'not_found' });
  });

  it('active session id returns 204 and frees the slot', async () => {
    const { base } = await start({ max_concurrent: 1 });
    const r1 = await fetch(`${base}/api/session/start`, { method: 'POST' });
    const b1 = (await r1.json()) as StartResponseBody;
    const rReset = await fetch(`${base}/api/session/${b1.session_id}/reset`, { method: 'POST' });
    expect(rReset.status).toBe(204);
    const r2 = await fetch(`${base}/api/session/start`, { method: 'POST' });
    expect(r2.status).toBe(200);
  });

  it('health shape', async () => {
    const { base } = await start();
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toEqual({
      ok: true,
      active: 0,
      killed: false,
      has_key: true,
      live_calls: { available: true, reason: null },
    });
  });

  // Reviewer finding (2026-09-11): "credits-exhausted replay mode" is a submission
  // requirement (CLAUDE.md abuse caps) with nothing implementing it under that name --
  // `live_calls` is the fix, shared by /health above and /api/session/start here.
  it('health reports credits_exhausted when COUNTERSIGN_LIVE_DISABLED=credits is forced', async () => {
    const { base } = await start({ live_disabled: 'credits' });
    const r = await fetch(`${base}/health`);
    const body = (await r.json()) as { live_calls: { available: boolean; reason: string | null } };
    expect(body.live_calls).toEqual({ available: false, reason: 'credits_exhausted' });
  });

  it('session start includes live_calls on the success response', async () => {
    const { base } = await start();
    const r = await fetch(`${base}/api/session/start`, { method: 'POST' });
    const body = (await r.json()) as { live_calls: { available: boolean; reason: string | null } };
    expect(body.live_calls).toEqual({ available: true, reason: null });
  });

  it('session start refuses with credits_exhausted (503) and includes live_calls when forced', async () => {
    const { base } = await start({ live_disabled: 'credits' });
    const r = await fetch(`${base}/api/session/start`, { method: 'POST' });
    expect(r.status).toBe(503);
    const body = (await r.json()) as { replay_only: true; reason: string; live_calls: { available: boolean } };
    expect(body).toEqual({
      replay_only: true,
      reason: 'credits_exhausted',
      live_calls: { available: false, reason: 'credits_exhausted' },
    });
  });

  it('version reports the deployed commit (null in local dev)', async () => {
    const { base } = await start();
    const r = await fetch(`${base}/version`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { commit: string | null };
    expect(body).toHaveProperty('commit');
    // RENDER_GIT_COMMIT is unset under the test, so the running process reports null here.
    expect(body.commit).toBe(process.env.RENDER_GIT_COMMIT ?? null);
  });

  it('unknown path returns 404', async () => {
    const { base } = await start();
    const r = await fetch(`${base}/nope`);
    expect(r.status).toBe(404);
    const body = await r.json();
    expect(body).toHaveProperty('error');
  });

  it('CORS: echoes an allowed origin, omits the header for a disallowed origin', async () => {
    const { base } = await start();

    const rAllowed = await fetch(`${base}/api/session/start`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(rAllowed.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');

    const rDisallowed = await fetch(`${base}/api/session/start`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://evil.example' },
    });
    expect(rDisallowed.headers.get('access-control-allow-origin')).toBeNull();
  });

  // Same-origin fix (2026-09-02): the deployed Render URL never matched render.yaml's
  // guessed COUNTERSIGN_ALLOWED_ORIGINS (the `countersign` name slug belongs to an unrelated
  // product, so Render appended a suffix) -- http.ts now recognizes a request's OWN origin
  // automatically instead of relying on that guess.
  it('CORS: allows this server\'s own origin via the plain Host header, with no allowlist entry for it', async () => {
    const { base } = await start();
    // `base` is this test server's real address (http://127.0.0.1:<port>) -- fetch sends
    // that same value as the Host header, so it IS this request's own origin, and it is
    // deliberately absent from cfg()'s allowed_origins (['http://localhost:5173']).
    const r = await fetch(`${base}/api/session/start`, {
      method: 'OPTIONS',
      headers: { Origin: base },
    });
    expect(r.headers.get('access-control-allow-origin')).toBe(base);
  });

  it('CORS: allows this server\'s own origin via X-Forwarded-Proto/X-Forwarded-Host when COUNTERSIGN_TRUST_PROXY is on (how Render presents it)', async () => {
    const { base } = await start({ trust_proxy: true });
    const r = await fetch(`${base}/api/session/start`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://countersign-abc123.onrender.com',
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'countersign-abc123.onrender.com',
      },
    });
    expect(r.headers.get('access-control-allow-origin')).toBe('https://countersign-abc123.onrender.com');
  });

  it('CORS: a foreign origin is still denied even when X-Forwarded headers are present and trusted', async () => {
    const { base } = await start({ trust_proxy: true });
    const r = await fetch(`${base}/api/session/start`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://evil.example',
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'countersign-abc123.onrender.com',
      },
    });
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });

  // Requirement (task-origin-fix1-brief.md #2): X-Forwarded-* is only ever honoured when
  // COUNTERSIGN_TRUST_PROXY=1 -- without it (the default everywhere except render.yaml), a
  // direct caller can't lie about its own origin by forging a forwarded header.
  it('CORS: X-Forwarded-Proto/X-Forwarded-Host are ignored when COUNTERSIGN_TRUST_PROXY is off (the default)', async () => {
    const { base } = await start({ trust_proxy: false });

    // The forged forwarded host is NOT trusted, so it must not be treated as same-origin.
    const rForged = await fetch(`${base}/api/session/start`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://countersign-abc123.onrender.com',
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'countersign-abc123.onrender.com',
      },
    });
    expect(rForged.headers.get('access-control-allow-origin')).toBeNull();

    // The server's REAL own origin (plain Host header) still works, forwarded headers or not.
    const rReal = await fetch(`${base}/api/session/start`, {
      method: 'OPTIONS',
      headers: {
        Origin: base,
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'countersign-abc123.onrender.com',
      },
    });
    expect(rReal.headers.get('access-control-allow-origin')).toBe(base);
  });

  // Requirement (task-origin-fix1-brief.md #5, exact case): a Render-shaped deployed hostname,
  // trusted forwarded headers, matching a browser Origin with no port.
  it('CORS: Host countersign-bf8q.onrender.com + trusted X-Forwarded-Proto https matches Origin https://countersign-bf8q.onrender.com', async () => {
    const { base } = await start({ trust_proxy: true });
    const r = await fetch(`${base}/api/session/start`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://countersign-bf8q.onrender.com',
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'countersign-bf8q.onrender.com',
      },
    });
    expect(r.headers.get('access-control-allow-origin')).toBe('https://countersign-bf8q.onrender.com');
  });

  // Requirement (task-origin-fix1-brief.md #5): a Host header that spells out the scheme's
  // default port explicitly (":443" for https) must still match a browser Origin, which never
  // includes a default port.
  it('CORS: Host with explicit :443 matches an Origin with no port, when trusted', async () => {
    const { base } = await start({ trust_proxy: true });
    const r = await fetch(`${base}/api/session/start`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://countersign-bf8q.onrender.com',
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'countersign-bf8q.onrender.com:443',
      },
    });
    expect(r.headers.get('access-control-allow-origin')).toBe('https://countersign-bf8q.onrender.com');
  });

  // Minor finding (task-origin-review.md): comparison is case-insensitive, so a mixed-case
  // forwarded Host still recognizes the same origin a lowercase browser Origin sends.
  it('CORS: a mixed-case forwarded Host still matches a lowercase Origin, when trusted', async () => {
    const { base } = await start({ trust_proxy: true });
    const r = await fetch(`${base}/api/session/start`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://countersign-bf8q.onrender.com',
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'Countersign-Bf8Q.Onrender.com',
      },
    });
    expect(r.headers.get('access-control-allow-origin')).toBe('https://countersign-bf8q.onrender.com');
  });

  // Minor finding (task-origin-review.md): a configured allowlist entry with a trailing slash
  // still matches a browser Origin, which never carries one.
  it('CORS: a configured allowlist entry with a trailing slash still matches', async () => {
    const { base } = await start({ allowed_origins: ['https://extra.example/'] });
    const r = await fetch(`${base}/api/session/start`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://extra.example' },
    });
    expect(r.headers.get('access-control-allow-origin')).toBe('https://extra.example');
  });

  it('CORS: a configured extra origin is still allowed alongside same-origin', async () => {
    const { base } = await start({ allowed_origins: ['https://extra.example'] });

    const rExtra = await fetch(`${base}/api/session/start`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://extra.example' },
    });
    expect(rExtra.headers.get('access-control-allow-origin')).toBe('https://extra.example');

    const rSelf = await fetch(`${base}/api/session/start`, {
      method: 'OPTIONS',
      headers: { Origin: base },
    });
    expect(rSelf.headers.get('access-control-allow-origin')).toBe(base);
  });

  it('CORS: an empty allowed_origins config (render.yaml\'s production value) allows only same-origin', async () => {
    const { base } = await start({ allowed_origins: [] });

    const rSelf = await fetch(`${base}/api/session/start`, {
      method: 'OPTIONS',
      headers: { Origin: base },
    });
    expect(rSelf.headers.get('access-control-allow-origin')).toBe(base);

    // The old dev default (localhost:5173) is no longer configured, so it's no longer
    // allowed either -- an empty env means no EXTRA origins, never "allow all".
    const rDevDefault = await fetch(`${base}/api/session/start`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(rDevDefault.headers.get('access-control-allow-origin')).toBeNull();

    const rForeign = await fetch(`${base}/api/session/start`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://evil.example' },
    });
    expect(rForeign.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('kill switch returns 503 replay_only', async () => {
    const { base } = await start({ kill_switch: true });
    const r = await fetch(`${base}/api/session/start`, { method: 'POST' });
    expect(r.status).toBe(503);
    const body = await r.json();
    expect(body).toEqual({
      replay_only: true,
      reason: 'kill_switch',
      live_calls: { available: false, reason: 'kill_switch' },
    });
  });

  it('no api key returns 503 replay_only', async () => {
    const { base } = await start({ assemblyai_api_key: null });
    const r = await fetch(`${base}/api/session/start`, { method: 'POST' });
    expect(r.status).toBe(503);
    const body = await r.json();
    // no_api_key is a transient/config condition, not one of live_calls's four reasons --
    // live_calls itself still reports available (see caps.ts's `computeLiveCallsStatus`
    // doc comment for why session_in_use/mint_rate/no_api_key are deliberately excluded).
    expect(body).toEqual({
      replay_only: true,
      reason: 'no_api_key',
      live_calls: { available: true, reason: null },
    });
  });

  it('end frees a concurrency slot', async () => {
    const { base } = await start({ max_concurrent: 1 });
    const r1 = await fetch(`${base}/api/session/start`, { method: 'POST' });
    const b1 = (await r1.json()) as StartResponseBody;
    const rEnd = await fetch(`${base}/api/session/${b1.session_id}/end`, { method: 'POST' });
    expect(rEnd.status).toBe(204);
    const r2 = await fetch(`${base}/api/session/start`, { method: 'POST' });
    expect(r2.status).toBe(200);
  });

  // Judge review finding (2026-09-04), defect 2: docs/SUBMISSION-DRAFT.md tells a judge to
  // click Replay first and expect "a full recorded interrogation" -- the flagship
  // scenario-b-miller-fraud attack -- but the dropdown used to be 18 bare filenames in
  // alphabetical order (flagship 14th), no descriptions. This runs against the REAL corpus
  // directory (same as replay.test.ts) -- not a fixture -- so it catches a real corpus file
  // missing a usable `title` the same way a judge's actual dropdown would.
  it('/api/replay keeps the original bare file list and adds a labeled recording per file, flagship first and marked recommended', async () => {
    const { base } = await start();
    const r = await fetch(`${base}/api/replay`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      files: string[];
      recordings: Array<{ file: string; label: string; recommended: boolean }>;
    };

    // Backward compatible: `files` is exactly what this route always returned -- bare corpus
    // names (no `.json`), alphabetically sorted.
    expect(body.files).toEqual([...body.files].sort());
    expect(body.files.every((f) => !f.endsWith('.json'))).toBe(true);
    expect(body.files).toContain('scenario-b-miller-fraud');
    expect(body.files.length).toBeGreaterThanOrEqual(18);

    // New: one `recordings` entry per file in `files`, same values, nothing dropped or added.
    expect(body.recordings.map((rec) => rec.file).sort()).toEqual([...body.files].sort());

    // The flagship sorts first and is the only one marked recommended -- an honest label
    // (its own corpus file's `title`, prefixed) rather than the raw filename. It carries no
    // audio file (nothing under packages/server/replay-audio/ names it), so `has_audio` is
    // false here regardless of whether this checkout has any recorded .ogg files at all.
    expect(body.recordings[0]).toEqual({
      file: 'scenario-b-miller-fraud',
      label: 'Recommended: Robert Miller: the fraudulent CEO-impersonation call',
      recommended: true,
      has_audio: false,
    });
    expect(body.recordings.filter((rec) => rec.recommended)).toHaveLength(1);

    // Every recording gets a non-empty label that is never just the raw filename.
    for (const rec of body.recordings) {
      expect(rec.label.length).toBeGreaterThan(0);
      expect(rec.label).not.toBe(rec.file);
    }
  });

  // Founder ruling 2026-09-22 8:00 PM: `has_audio` is a real filesystem check against
  // packages/server/replay-audio/ (TRACKED -- the founder commits the real .ogg files
  // himself; local dev checkouts, including this one, may or may not have them on disk at
  // test time). This deliberately never asserts on whether that directory is empty or
  // populated right now (replay.test.ts's "audio whitelist" describe block already proves
  // the whitelist logic itself against a controlled temp directory) -- it only asserts
  // things true in EITHER state: a synthetic-script corpus file (never recorded, never
  // gets a .ogg) always reads has_audio: false, and every 404 path (unknown name, path
  // traversal) 404s cleanly rather than throwing.
  describe('replay audio (packages/server/replay-audio/, founder ruling 2026-09-22)', () => {
    it('a synthetic-script recording always reads has_audio: false, and unknown/traversal names 404 cleanly', async () => {
      const { base } = await start();

      const r = await fetch(`${base}/api/replay`);
      const body = (await r.json()) as { recordings: Array<{ file: string; has_audio: boolean }> };
      const flagship = body.recordings.find((rec) => rec.file === 'scenario-b-miller-fraud');
      expect(flagship?.has_audio).toBe(false);

      const rFlagship = await fetch(`${base}/api/replay-audio/scenario-b-miller-fraud`);
      expect(rFlagship.status).toBe(404);

      const rTraversal = await fetch(`${base}/api/replay-audio/${encodeURIComponent('../../../etc/passwd')}`);
      expect(rTraversal.status).toBe(404);

      const rUnknown = await fetch(`${base}/api/replay-audio/not-a-real-corpus-file`);
      expect(rUnknown.status).toBe(404);
    });

    // Review finding (2026-09-22 8:21 PM, BLOCKING): a malformed percent-escape made
    // decodeURIComponent throw inside the unawaited request handler, which crashed the whole
    // process (live calls included). It must be a plain 404, and the server must keep serving.
    it('a malformed percent-escape 404s and the server keeps serving', async () => {
      const { base } = await start();
      for (const bad of ['%', '%zz', 'recorded-stage%E0%A4%A']) {
        const r = await fetch(`${base}/api/replay-audio/${bad}`);
        expect(r.status).toBe(404);
      }
      const after = await fetch(`${base}/api/replay`);
      expect(after.status).toBe(200);
    });
  });

  // Bug fix (2026-09-04): the live CallContext used to be hardcoded to `unverified_voip`/
  // `unknown` for EVERY call (packages/server/src/ws/browser.ts's old `defaultCallContext`),
  // which made the SSO check fail always, which made STAGE structurally unreachable. The
  // browser may now NAME a demo persona; the server alone maps that name to the simulated
  // telemetry (packages/server/src/personas.ts). These tests cover the POST route's half of
  // that fix: strict allowlisting, safe fallback, and that origin_kind/origin_geo posted by
  // a client are never read at all.
  describe('POST /api/session/start -- demo persona', () => {
    it('a legitimate persona is stored against the minted session id', async () => {
      const { base, state } = await start();
      const r = await fetch(`${base}/api/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ persona: 'legitimate' }),
      });
      expect(r.status).toBe(200);
      const { session_id } = (await r.json()) as StartResponseBody;
      expect(state.active.get(session_id)?.persona).toBe('legitimate');
    });

    it('an attacker persona is stored against the minted session id', async () => {
      const { base, state } = await start();
      const r = await fetch(`${base}/api/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ persona: 'attacker' }),
      });
      expect(r.status).toBe(200);
      const { session_id } = (await r.json()) as StartResponseBody;
      expect(state.active.get(session_id)?.persona).toBe('attacker');
    });

    it('an absent body (the pre-existing client) still succeeds and falls back to attacker', async () => {
      const { base, state } = await start();
      const r = await fetch(`${base}/api/session/start`, { method: 'POST' });
      expect(r.status).toBe(200);
      const { session_id } = (await r.json()) as StartResponseBody;
      expect(state.active.get(session_id)?.persona).toBe('attacker');
    });

    it('an unknown persona name falls back to attacker, never the permissive persona', async () => {
      const { base, state } = await start();
      const r = await fetch(`${base}/api/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ persona: 'ceo-override' }),
      });
      expect(r.status).toBe(200);
      const { session_id } = (await r.json()) as StartResponseBody;
      expect(state.active.get(session_id)?.persona).toBe('attacker');
    });

    it('a body that is not valid JSON does not crash the route -- rejected with the existing error shape', async () => {
      const { base } = await start();
      const r = await fetch(`${base}/api/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'this is not json{{{',
      });
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: 'bad_request' });
    });

    it('a browser cannot influence origin telemetry: origin_kind/origin_geo in the body have no effect', async () => {
      const { base, state } = await start();
      const r = await fetch(`${base}/api/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // No persona named -- if origin_kind/origin_geo had any effect at all, this forged
        // body (shaped exactly like the legitimate persona's telemetry) would flip the
        // result away from the safe default.
        body: JSON.stringify({ origin_kind: 'registered_device', origin_geo: 'Austin, TX' }),
      });
      expect(r.status).toBe(200);
      const { session_id } = (await r.json()) as StartResponseBody;
      expect(state.active.get(session_id)?.persona).toBe('attacker');
    });

    it('does not add a persona field to the success response body (public shape unchanged)', async () => {
      const { base } = await start();
      const r = await fetch(`${base}/api/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ persona: 'legitimate' }),
      });
      const body = (await r.json()) as Record<string, unknown>;
      expect(body).not.toHaveProperty('persona');
    });
  });

  // Review fix (2026-09-11, part c): there was no runtime path at all to clear a latched
  // live_override (state.killed is likewise never set by any existing route, only read --
  // the kill switch is a redeploy-only env var). Guarded the same way: nothing happens
  // unless an operator has explicitly set COUNTERSIGN_ADMIN_TOKEN.
  describe('POST /api/admin/live-calls/reset', () => {
    it('404s when no admin token is configured (disabled by default, same as the kill switch needing its own env var)', async () => {
      const { base } = await start();
      const r = await fetch(`${base}/api/admin/live-calls/reset`, { method: 'POST' });
      expect(r.status).toBe(404);
    });

    it('401s with a configured token but a missing or wrong Authorization header', async () => {
      const { base } = await start({ admin_token: 'secret-admin-token' });
      const rMissing = await fetch(`${base}/api/admin/live-calls/reset`, { method: 'POST' });
      expect(rMissing.status).toBe(401);

      const rWrong = await fetch(`${base}/api/admin/live-calls/reset`, {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong-token' },
      });
      expect(rWrong.status).toBe(401);
    });

    it('clears a latched live_override and returns 204 with the correct bearer token', async () => {
      const { base, state } = await start({ admin_token: 'secret-admin-token' });
      markLiveCallsUnavailable(state, 'credits_exhausted', 1000);

      const before = await fetch(`${base}/health`);
      expect(((await before.json()) as { live_calls: { available: boolean } }).live_calls.available).toBe(false);

      const r = await fetch(`${base}/api/admin/live-calls/reset`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret-admin-token' },
      });
      expect(r.status).toBe(204);

      const after = await fetch(`${base}/health`);
      const afterBody = (await after.json()) as { live_calls: { available: boolean; reason: string | null } };
      expect(afterBody.live_calls).toEqual({ available: true, reason: null });
    });
  });

  // Rehearsal-harness debug hook (judge-sim finding 2026-09-11, docs/JUDGE-SIM-2026-09-11.md
  // addendum: zero AssemblyAI socket drops occurred across three live bundles -- the real
  // session.resume path had never actually been exercised on a live call). Same "route
  // completely absent, not just unauthorized" shape as /api/admin/live-calls/reset above:
  // nothing happens unless an operator has explicitly set COUNTERSIGN_DEBUG_HOOKS=1, and
  // production never sets it.
  describe('POST /api/session/:id/debug/drop-aai', () => {
    const UUID = '11111111-1111-1111-1111-111111111111';

    it('404s when debug hooks are not enabled (the default -- disabled even with a wired dropAai)', async () => {
      const { base } = await start({ debug_hooks_enabled: false }, () => true);
      const r = await fetch(`${base}/api/session/${UUID}/debug/drop-aai`, { method: 'POST' });
      expect(r.status).toBe(404);
    });

    it('404s when enabled but no dropAai was wired (defensive -- should never happen in production)', async () => {
      const { base } = await start({ debug_hooks_enabled: true });
      const r = await fetch(`${base}/api/session/${UUID}/debug/drop-aai`, { method: 'POST' });
      expect(r.status).toBe(404);
    });

    it('404s for a malformed session id even when enabled', async () => {
      const { base } = await start({ debug_hooks_enabled: true }, () => true);
      const r = await fetch(`${base}/api/session/not-a-uuid/debug/drop-aai`, { method: 'POST' });
      expect(r.status).toBe(404);
    });

    it('404s when the wired dropAai reports nothing was live to drop', async () => {
      const { base } = await start({ debug_hooks_enabled: true }, () => false);
      const r = await fetch(`${base}/api/session/${UUID}/debug/drop-aai`, { method: 'POST' });
      expect(r.status).toBe(404);
    });

    it('204s and calls the wired dropAai with the session id when enabled and the drop succeeds', async () => {
      const calls: string[] = [];
      const { base } = await start({ debug_hooks_enabled: true }, (id) => {
        calls.push(id);
        return true;
      });
      const r = await fetch(`${base}/api/session/${UUID}/debug/drop-aai`, { method: 'POST' });
      expect(r.status).toBe(204);
      expect(calls).toEqual([UUID]);
    });
  });

  it('POST /api/session/:prefix/diagnostics with 8-char prefix returns 404 (no prefix writes)', async () => {
    const { base, diagnostics } = await start();
    const fullId = '11111111-1111-1111-1111-111111111111';

    // Create a bundle
    const bundle = {
      session_id: fullId,
      started_at: 1000,
      ended_at: null,
      end_reason: null,
      deployed_commit: null,
      server_events: [],
      client_events: [],
      client_bytes: 0,
      client_post_times: [],
    } as DiagnosticBundle;
    diagnostics.bundles.set(fullId, bundle);

    // POST with exact UUID works
    const rExact = await fetch(`${base}/api/session/${fullId}/diagnostics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [{ t_ms: 1, kind: 'test' }] }),
    });
    expect(rExact.status).toBe(200);
    expect(bundle.client_events).toHaveLength(1);

    // POST with 8-char prefix returns 404 (no write allowed)
    const rPrefix = await fetch(`${base}/api/session/${fullId.slice(0, 8)}/diagnostics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [{ t_ms: 2, kind: 'test2' }] }),
    });
    expect(rPrefix.status).toBe(404);
    // Bundle should still have only 1 event (no write occurred)
    expect(bundle.client_events).toHaveLength(1);
  });

  it('GET /api/session/:prefix/diagnostics with ambiguous prefix returns 409 without count', async () => {
    const { base, diagnostics } = await start();

    // Create two bundles with same prefix
    const id1 = '11111111-1111-1111-1111-111111111111';
    const id2 = '11111111-2222-2222-2222-222222222222';
    diagnostics.bundles.set(id1, { session_id: id1, started_at: 1000 } as DiagnosticBundle);
    diagnostics.bundles.set(id2, { session_id: id2, started_at: 2000 } as DiagnosticBundle);

    const r = await fetch(`${base}/api/session/11111111/diagnostics`);
    expect(r.status).toBe(409);
    const body = await r.json();
    expect(body).toEqual({ error: 'ambiguous' });
    // Ensure no count is returned
    expect(body).not.toHaveProperty('matches');
  });

  it('admin routes handle token comparison safely (different length, no crash)', async () => {
    const { base } = await start({ admin_token: 'secret-token' });

    // Wrong token with different length should return 401, not crash
    const r = await fetch(`${base}/api/admin/sessions`, {
      headers: { Authorization: 'Bearer x' },
    });
    expect(r.status).toBe(401);
    const body = await r.json();
    expect(body).toEqual({ error: 'unauthorized' });
  });

  it('?limit parameter clamps: rejects negative/zero/non-integer, caps at 200', async () => {
    const adminToken = 'secret-token';
    const { base, diagnostics } = await start({ admin_token: adminToken });

    // Add one bundle so we have something to return
    const bundle: DiagnosticBundle = {
      session_id: '11111111-1111-1111-1111-111111111111',
      started_at: 1000,
      ended_at: null,
      end_reason: null,
      deployed_commit: null,
      server_events: [],
      client_events: [],
      client_bytes: 0,
      client_post_times: [],
    };
    diagnostics.bundles.set(bundle.session_id, bundle);

    // Negative defaults to 50
    const rNeg = await fetch(`${base}/api/admin/sessions?limit=-5`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(rNeg.status).toBe(200);
    const bodyNeg = (await rNeg.json()) as { sessions: unknown[] };
    expect(bodyNeg.sessions).toHaveLength(1);

    // Above 200 caps at 200
    const r999 = await fetch(`${base}/api/admin/sessions?limit=999`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(r999.status).toBe(200);
    const body999 = (await r999.json()) as { sessions: unknown[] };
    expect(body999.sessions).toHaveLength(1);
  });

  it('GET /api/admin/sessions returns 404 when COUNTERSIGN_ADMIN_TOKEN is unset', async () => {
    const { base } = await start();
    const r = await fetch(`${base}/api/admin/sessions`);
    expect(r.status).toBe(404);
    const body = await r.json();
    expect(body).toEqual({ error: 'not_found' });
  });

  it('GET /api/admin/sessions returns 401 when token is wrong', async () => {
    const { base } = await start({ admin_token: 'secret-token' });
    const r = await fetch(`${base}/api/admin/sessions`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(r.status).toBe(401);
    const body = await r.json();
    expect(body).toEqual({ error: 'unauthorized' });
  });

  it('GET /api/admin/sessions returns sessions metadata with correct token', async () => {
    const adminToken = 'secret-token';
    const { base, diagnostics } = await start({ admin_token: adminToken });

    // Manually add some bundles to diagnostics state
    const bundle1 = {
      session_id: '11111111-1111-1111-1111-111111111111',
      started_at: 1000,
      ended_at: 2000,
      end_reason: 'caller_ended',
      deployed_commit: null,
      server_events: [
        { t_ms: 0, kind: 'session_minted', detail: { persona_resolved: 'legitimate' } },
        { t_ms: 500, kind: 'evaluate', detail: { verdict: 'STAGE', state: 'EVIDENCE' } },
      ],
      client_events: [],
      client_bytes: 0,
      client_post_times: [],
      billed_seconds: 30,
    };
    const bundle2 = {
      session_id: '22222222-2222-2222-2222-222222222222',
      started_at: 3000,
      ended_at: null,
      end_reason: null,
      deployed_commit: null,
      server_events: [
        { t_ms: 0, kind: 'session_minted', detail: { persona_resolved: 'attacker' } },
      ],
      client_events: [],
      client_bytes: 0,
      client_post_times: [],
    } as DiagnosticBundle;
    diagnostics.bundles.set(bundle1.session_id, bundle1);
    diagnostics.bundles.set(bundle2.session_id, bundle2);
    diagnostics.order = [bundle1.session_id, bundle2.session_id];

    const r = await fetch(`${base}/api/admin/sessions`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { sessions: unknown[] };
    expect(body.sessions).toHaveLength(2);
    // Newest first
    expect(body.sessions[0]).toEqual({
      session_id: '22222222-2222-2222-2222-222222222222',
      started_at: 3000,
      ended_at: null,
      end_reason: null,
      verdict: null,
      persona: 'attacker',
      billed_seconds: null,
    });
    expect(body.sessions[1]).toEqual({
      session_id: '11111111-1111-1111-1111-111111111111',
      started_at: 1000,
      ended_at: 2000,
      end_reason: 'caller_ended',
      verdict: 'STAGE',
      persona: 'legitimate',
      billed_seconds: 30,
    });
  });

  it('GET /api/admin/sessions respects limit parameter', async () => {
    const adminToken = 'secret-token';
    const { base, diagnostics } = await start({ admin_token: adminToken });

    // Add 5 bundles
    for (let i = 0; i < 5; i++) {
      const bundle = {
        session_id: `${i}1111111-1111-1111-1111-111111111111`,
        started_at: 1000 + i * 100,
        ended_at: null,
        end_reason: null,
        deployed_commit: null,
        server_events: [],
        client_events: [],
        client_bytes: 0,
        client_post_times: [],
      };
      diagnostics.bundles.set(bundle.session_id, bundle);
      diagnostics.order.push(bundle.session_id);
    }

    const r = await fetch(`${base}/api/admin/sessions?limit=2`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { sessions: unknown[] };
    expect(body.sessions).toHaveLength(2);
  });
});

// D1 fix round 1 #1: the static-server mount (http.ts) used to gate on `req.method ===
// 'GET'` only, so a HEAD request fell through to the generic JSON 404 even though
// static.ts's `handle` always supported HEAD -- invisible to every other test in this file
// (none of them ever configure a `staticServer`) and to static.test.ts (it exercises
// `staticServer.handle` directly, bypassing http.ts's mount entirely). This suite builds the
// REAL `createHttpServer` with a real `staticServer`, which is the only way to catch a
// regression in the mount's own method gate rather than in static.ts's internal one.
describe('http server -- static mount (D1 fix round 1 #1)', () => {
  let close: (() => Promise<void>) | undefined;
  let fixtureDir: string;

  afterEach(async () => {
    if (close) {
      await close();
      close = undefined;
    }
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  });

  async function startWithStatic(): Promise<{ base: string }> {
    fixtureDir = mkdtempSync(join(tmpdir(), 'countersign-http-static-'));
    writeFileSync(join(fixtureDir, 'index.html'), '<!doctype html><html><body>shell</body></html>');

    const { server } = createHttpServer(cfg(), {
      fetchImpl: globalThis.fetch,
      now: () => 1000,
      randomId: () => '11111111-1111-1111-1111-111111111111',
      endCall: () => false,
      staticServer: createStaticServer(fixtureDir),
      diagnostics: newDiagnosticsState(),
    });
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        close = () =>
          new Promise((res) => {
            server.closeAllConnections();
            server.close(() => res());
          });
        resolve({ base: `http://127.0.0.1:${addr.port}` });
      });
    });
  }

  it('GET / reaches the static server and serves index.html', async () => {
    const { base } = await startWithStatic();
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('shell');
  });

  it('HEAD / reaches the static server too -- not the JSON 404 (the actual bug found)', async () => {
    const { base } = await startWithStatic();
    const r = await fetch(`${base}/`, { method: 'HEAD' });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    expect(await r.text()).toBe('');
  });

  it('unmatched /api path still gets the JSON 404, HEAD included', async () => {
    const { base } = await startWithStatic();
    const rGet = await fetch(`${base}/api/nonexistent`);
    expect(rGet.status).toBe(404);
    expect(await rGet.json()).toEqual({ error: 'not found' });

    const rHead = await fetch(`${base}/api/nonexistent`, { method: 'HEAD' });
    expect(rHead.status).toBe(404);
  });
});
