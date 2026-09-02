import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { createHttpServer } from './http.js';
import { reapIdle } from './caps.js';

const cfg = loadConfig(process.env);

const { server, state } = createHttpServer(cfg, {
  fetchImpl: fetch,
  now: () => Date.now(),
  randomId: () => randomUUID(),
});

setInterval(() => {
  reapIdle(state, cfg, Date.now());
}, 5000).unref();

server.listen(cfg.port, () => {
  console.log(`countersign server listening on :${cfg.port}`);
});
