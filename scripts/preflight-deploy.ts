// scripts/preflight-deploy.ts
// Task D1: the local stand-in for "does the deploy actually work" -- builds the web SPA and
// the compiled server exactly the way `render.yaml`'s build step will (`npm run build:web`
// && `npm run build:server`), boots the compiled server on a spare local port with a fake
// AssemblyAI socket (no ASSEMBLYAI_API_KEY / network calls -- this never touches the live
// API, see CLAUDE.md's ban on running scripts/smoke-live.ts outside a founder-present
// session), hits /health and / the same way Render's health check and a judge's first click
// would, and exits 0 only if both come back clean. Exits 1 (with the build/server output) on
// any failure -- run before every real deploy, and safe to run in CI.
//
// `npm run preflight:deploy`
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const HEALTH_TIMEOUT_MS = 15_000;
const HEALTH_POLL_MS = 200;

function log(msg: string): void {
  console.log(`preflight-deploy: ${msg}`);
}

function runBuildStep(script: string): void {
  log(`running "npm run ${script}"...`);
  const result = spawnSync('npm', ['run', script], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`"npm run ${script}" failed (exit ${String(result.status)})`);
  }
  log(`"npm run ${script}" OK`);
}

/** Binds an ephemeral port, reads back what the OS actually assigned, then frees it -- the
 *  same "ask the OS, then hand the number to the real listener" trick http.test.ts uses
 *  (`server.listen(0, ...)`), just done once up front so this script and the child process
 *  agree on which port to use. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      if (addr === null || typeof addr === 'string') {
        probe.close();
        reject(new Error('could not determine a free port'));
        return;
      }
      const { port } = addr;
      probe.close(() => resolve(port));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(base: string, deadline: number): Promise<Record<string, unknown>> {
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) {
        return (await res.json()) as Record<string, unknown>;
      }
      lastError = new Error(`/health returned ${String(res.status)}`);
    } catch (err) {
      lastError = err;
    }
    await sleep(HEALTH_POLL_MS);
  }
  throw new Error(`/health never came up in time: ${String(lastError)}`);
}

async function main(): Promise<void> {
  runBuildStep('build:web');
  runBuildStep('build:server');

  const port = await findFreePort();
  const base = `http://127.0.0.1:${String(port)}`;
  log(`starting compiled server on ${base} (COUNTERSIGN_FAKE_AAI=1 -- no live AssemblyAI connection, no API key needed)...`);

  const child = spawn('npx', ['tsx', join(repoRoot, 'packages/server/dist/index.js')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      COUNTERSIGN_FAKE_AAI: '1',
      COUNTERSIGN_ALLOWED_ORIGINS: base,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverOutput = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    serverOutput += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    serverOutput += chunk.toString();
  });

  let exitedEarly: number | null = null;
  child.once('exit', (code) => {
    exitedEarly = code;
  });

  try {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    const health = await waitForHealth(base, deadline);
    if (exitedEarly !== null) {
      throw new Error(`server process exited early (code ${String(exitedEarly)}) before /health was reachable`);
    }
    if (health.ok !== true) {
      throw new Error(`/health responded but ok !== true: ${JSON.stringify(health)}`);
    }
    log(`/health OK: ${JSON.stringify(health)}`);

    const indexRes = await fetch(`${base}/`);
    if (!indexRes.ok) {
      throw new Error(`GET / returned ${String(indexRes.status)} -- static SPA serving is not wired up`);
    }
    const contentType = indexRes.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html')) {
      throw new Error(`GET / returned content-type "${contentType}", expected text/html`);
    }
    log(`GET / OK (${contentType})`);

    log('PASS -- build + compiled server + static serving all verified locally.');
  } finally {
    child.kill();
    if (serverOutput.trim().length > 0) {
      log('server output during this run:');
      console.log(serverOutput);
    }
  }
}

main().catch((err: unknown) => {
  console.error(`preflight-deploy: FAIL -- ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
