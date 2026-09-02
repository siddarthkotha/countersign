// packages/server/scripts/smoke-live.ts
// Opt-in live check against the REAL AssemblyAI Voice Agent API. Never run in CI, never
// imported by a test file -- this is the founder's day-1 (and ongoing) manual check that
// the real adapter still talks to AssemblyAI, run with `npm run smoke:live` from repo root.
// Requires ASSEMBLYAI_API_KEY and the --live flag (belt-and-suspenders against an
// accidental network call from an automated context).
//
// Flow: mint a token, connect, send session.update with greeting "Countersign smoke test"
// (spoken automatically once session.ready fires -- greeting is immutable after that, so it
// has to be part of the FIRST session.update, which `connectAai` sends for us), report the
// first `reply.audio` byte count and the `reply.done` status, then end the session. Prints
// the two latencies MEASURED here (never invented -- CLAUDE.md: never write "sub-second"
// without a measured number) so the README's latency table can start from real numbers:
//   connect -> session.ready
//   session.ready -> first reply.audio
import { WebSocket } from 'ws';
import { connectAai, fetchVoices, type WsLike } from '../src/aai/session.js';
import { loadAaiEnvDefaults, type AaiSessionConfig } from '../src/aai/config.js';
import { allToolSchemas } from '../src/aai/schemas.js';

const READY_AND_AUDIO_TIMEOUT_MS = 20_000;

async function main(): Promise<void> {
  const isLive = process.argv.includes('--live');
  const apiKey = process.env.ASSEMBLYAI_API_KEY;

  if (!isLive) {
    console.error('smoke-live: refusing to connect without --live (this script must never run unattended/in CI).');
    process.exitCode = 1;
    return;
  }
  if (!apiKey) {
    console.error('smoke-live: ASSEMBLYAI_API_KEY is not set.');
    process.exitCode = 1;
    return;
  }

  const envDefaults = loadAaiEnvDefaults(process.env);
  const cfg: AaiSessionConfig = {
    assemblyai_api_key: apiKey,
    session_cap_seconds: 120,
    voice: envDefaults.voice,
    system_prompt: 'You are Countersign, running a one-off smoke test. Say only the greeting, then wait silently.',
    greeting: 'Countersign smoke test',
    tools: allToolSchemas(),
    keyterms: [],
    // exactOptionalPropertyTypes: only set the key when a model is actually configured.
    ...(envDefaults.llm_model ? { llm_model: envDefaults.llm_model } : {}),
  };

  // AMENDMENT (controller, 2026-09-02, docs/ASSEMBLYAI_AGENT_INSTRUCTIONS.md "Voices"
  // section): voice ids are exact strings and "invented or remembered values silently
  // fail" -- print the live list length and the voice this run will request before
  // spending a real connection on it. `connectAai` itself still validates/falls back
  // internally; this is just visibility for the person running the script.
  try {
    const voices = await fetchVoices(cfg, fetch);
    console.log(`voices list: ${voices.length} available; requesting voice "${cfg.voice}"`);
  } catch (err) {
    console.warn(`smoke-live: could not fetch the voices list (${String(err)}) -- requesting voice "${cfg.voice}" unvalidated.`);
  }

  const connectStartMs = Date.now();
  let readyAtMs: number | null = null;
  let firstAudioAtMs: number | null = null;
  let audioBytes = 0;
  let sawDone = false;

  try {
    const aai = await connectAai(cfg, {
      fetchImpl: fetch,
      WebSocketImpl: WebSocket as unknown as new (url: string) => WsLike,
      now: () => Date.now(),
    });
    readyAtMs = Date.now();
    console.log(`connect -> session.ready: ${readyAtMs - connectStartMs}ms`);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('smoke-live: timed out waiting for reply.done')),
        READY_AND_AUDIO_TIMEOUT_MS
      );
      aai.on((evt) => {
        if (evt.type === 'reply.audio') {
          if (firstAudioAtMs === null) {
            firstAudioAtMs = Date.now();
            console.log(`session.ready -> first reply.audio: ${firstAudioAtMs - (readyAtMs as number)}ms`);
          }
          audioBytes += Buffer.from(evt.data, 'base64').length;
        }
        if (evt.type === 'reply.done') {
          sawDone = true;
          console.log(`reply.done: status=${evt.status}, total audio bytes=${audioBytes}`);
          clearTimeout(timeout);
          resolve();
        }
        if (evt.type === 'session.error') {
          clearTimeout(timeout);
          reject(new Error(`smoke-live: session.error ${evt.code} ${evt.message}`));
        }
      });
    });

    aai.close();
  } catch (err) {
    console.error('smoke-live: FAILED --', err);
    process.exitCode = 1;
    return;
  }

  if (!sawDone) {
    console.error('smoke-live: FAILED -- never saw reply.done');
    process.exitCode = 1;
    return;
  }

  console.log('smoke-live: OK');
}

void main();
