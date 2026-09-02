import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { createHttpServer } from './http.js';
import { reapIdle } from './caps.js';
import { attachWebSocketServer } from './ws/browser.js';
import { FakeAaiSocket } from './aai/fake.js';
import type { AaiSocket } from './aai/types.js';

const useFakeAai = process.env.COUNTERSIGN_FAKE_AAI === '1';

const loadedCfg = loadConfig(process.env);
// `canStartSession` (caps.ts, S1) gates /api/session/start on a real ASSEMBLYAI_API_KEY --
// correct for the live path, but it would also block the fake-AAI dev path from ever
// starting a session (nothing here ever mints a real token or dials AssemblyAI in fake
// mode, so no real key is needed). A dev-only placeholder satisfies that gate without
// touching the gate's own logic or affecting a real deployment, where COUNTERSIGN_FAKE_AAI
// is never set.
const cfg = useFakeAai && !loadedCfg.assemblyai_api_key
  ? { ...loadedCfg, assemblyai_api_key: 'fake-aai-dev-mode' }
  : loadedCfg;

const { server, state } = createHttpServer(cfg, {
  fetchImpl: fetch,
  now: () => Date.now(),
  randomId: () => randomUUID(),
});

setInterval(() => {
  reapIdle(state, cfg, Date.now());
}, 5000).unref();

// COUNTERSIGN_FAKE_AAI=1 (founder ruling, Task S2): every call session gets a scripted
// FakeAaiSocket instead of a real AssemblyAI connection, so `npm run dev:server` runs the
// whole stack (session start, caps, the WebSocket protocol, the engine on every event) with
// no ASSEMBLYAI_API_KEY set. It plays no script by itself -- it only answers what
// call/session.ts sends it (an initial session.update) -- driving one with real audio/tool
// events is a manual dev step (or S3's real adapter) until a task actually needs it
// automated. The real adapter (src/aai/session.ts) lands in S3 and plugs into this same
// `createAai` factory.
function createAai(_session_id: string): AaiSocket {
  if (useFakeAai) return new FakeAaiSocket();
  throw new Error('real AssemblyAI adapter not wired yet (Task S3) -- set COUNTERSIGN_FAKE_AAI=1 for dev mode');
}

attachWebSocketServer(server, {
  caps: state,
  now: () => Date.now(),
  createAai,
});

if (useFakeAai) {
  console.log('COUNTERSIGN_FAKE_AAI=1 -- call sessions use a scripted fake AssemblyAI socket, no API key required');
}

server.listen(cfg.port, () => {
  console.log(`countersign server listening on :${cfg.port}`);
});
