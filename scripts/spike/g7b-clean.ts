#!/usr/bin/env -S npx tsx
// scripts/spike/g7b-clean.ts
// SPIKE-ONLY corrective re-run of G7b. The first g5b-g7b.ts run's G7b portion matched
// reply.done GENERICALLY (type-only) within a since-index window, which let a slow-arriving
// PREVIOUS turn's reply.done (rep2's, ~386ms outside that rep's own too-short wait window)
// get mis-attributed to the NEXT rep and cascade into false results for rep3/normal/stall
// (root-caused via scripts/spike/logs/spike-g5b-g7b-*.jsonl raw analysis, not rerun blind).
// Fix: match reply.done by its OWN reply_id, captured from that turn's reply.started -- a
// precise boundary the events-reference doc guarantees (`reply.done.reply_id`).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve as dnsResolve } from 'node:dns/promises';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ensureDirs, log, setLogFile, mintToken, createAgent, deleteAgent, randomKey, sleep, OUT_DIR } from './lib.js';
import { startEndpoint } from './endpoint.js';
import { connectStoredAgent, streamFrames, type SpikeSession } from './wsClient.js';
import { synthesizeLine, chunkToFrames } from '../rehearse/audio.js';

const API_KEY = process.env.ASSEMBLYAI_API_KEY;
if (!API_KEY) { console.error('no ASSEMBLYAI_API_KEY'); process.exit(1); }
const LLM_API_KEY = randomKey('spike-g7bclean');

async function speak(session: SpikeSession, text: string): Promise<void> {
  const pcm = await synthesizeLine(text, 'Alex');
  await streamFrames(session, chunkToFrames(pcm));
}

/** Waits for reply.started (capturing its reply_id), THEN waits for the reply.done carrying
 *  that EXACT reply_id -- immune to the generic-type mis-attribution bug above. */
async function waitOneReply(session: SpikeSession, since: number, startedTimeoutMs = 12000, doneTimeoutMs = 15000) {
  const started = await session.waitFor((e) => e.type === 'reply.started', startedTimeoutMs, since).catch(() => null);
  const replyId = (started as { reply_id?: string } | null)?.reply_id ?? null;
  if (!replyId) return { started, done: null, agentText: null as string | null };
  const done = await session
    .waitFor((e) => e.type === 'reply.done' && (e as { reply_id?: string }).reply_id === replyId, doneTimeoutMs, since)
    .catch(() => null);
  const agentEvt = session.events.find((r) => r.event.type === 'transcript.agent' && (r.event as { reply_id?: string }).reply_id === replyId);
  return { started, done, agentText: (agentEvt?.event as { text?: string } | undefined)?.text ?? null };
}

async function main(): Promise<void> {
  await ensureDirs();
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  setLogFile(`spike-g7b-clean-${runId}.jsonl`);
  console.log(`G7b-clean run ${runId}`);

  const port = 8955;
  const endpoint = await startEndpoint({ port, expectedApiKey: LLM_API_KEY });
  const tunnelProc = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  const tunnelUrl = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('cloudflared: no URL after 25s')), 25000);
    const onData = (d: Buffer) => {
      buf += d.toString('utf8');
      const m = buf.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (m) { clearTimeout(t); resolve(m[0]); }
    };
    tunnelProc.stdout.on('data', onData);
    tunnelProc.stderr.on('data', onData);
    tunnelProc.on('exit', (c) => { clearTimeout(t); reject(new Error(`cloudflared exited ${c}: ${buf.slice(-1000)}`)); });
  });
  console.log(`Tunnel: ${tunnelUrl}`);
  const host = new URL(tunnelUrl).hostname;
  for (let i = 0; i < 20; i++) { try { await dnsResolve(host); break; } catch { await sleep(1000); } }
  await sleep(1500);

  let agentId: string | null = null;
  const results: Record<string, unknown> = {};
  try {
    const agentOpts = {
      apiKey: API_KEY,
      name: 'countersign-spike-g7bclean',
      system_prompt: 'SPIKE G7b-clean.',
      greeting: 'G seven b clean test. Begin.',
      voice_id: 'anna',
      llm_base_url: tunnelUrl,
      llm_model: 'countersign-spike-g7bclean',
      llm_api_key: LLM_API_KEY,
      keyterms: [] as string[],
      transcription_mode: 'max_accuracy' as const,
    };
    let id: string;
    try { ({ id } = await createAgent(agentOpts)); }
    catch (e) { console.log(`createAgent retry: ${(e as Error).message.slice(0,150)}`); await sleep(5000); ({ id } = await createAgent(agentOpts)); }
    agentId = id;
    console.log(`Agent: ${id}`);

    const token = await mintToken(API_KEY, 180);
    const session = await connectStoredAgent({ token: token.token, agentId: id, tag: 'g7bc' });
    await waitOneReply(session, 0, 6000, 8000); // consume greeting cleanly

    const reps: Array<Record<string, unknown>> = [];
    for (let i = 1; i <= 3; i++) {
      const since = session.events.length;
      endpoint.push({ type: 'http500' });
      await speak(session, `This is turn number ${i}, please process it now.`);
      const r = await waitOneReply(session, since, 12000, 15000);
      const doneStatus = (r.done as { status?: string } | null)?.status ?? null;
      const reqsThisTurn = endpoint.requests.filter((req) => req.receivedAt > session.events[since]!.at);
      const retryCounts = reqsThisTurn.map((req) => req.headers['x-stainless-retry-count']);
      reps.push({ rep: i, replyDoneStatus: doneStatus, agentHeard: r.agentText, retryCounts, numRequests: reqsThisTurn.length });
      console.log(`rep ${i}:`, JSON.stringify(reps[reps.length - 1]));
      await sleep(300);
    }

    const sinceNormal = session.events.length;
    endpoint.push({ type: 'line', text: 'Session survived three server errors.' });
    await speak(session, 'Are you still working now.');
    const normal = await waitOneReply(session, sinceNormal, 12000, 15000);
    const normalWorked = normal.agentText === 'Session survived three server errors.';
    results['normal'] = { status: (normal.done as { status?: string } | null)?.status, agentHeard: normal.agentText, normalWorked };
    console.log('normal:', JSON.stringify(results['normal']));

    const sinceStall = session.events.length;
    endpoint.push({ type: 'stall', ms: 5000, heartbeatMs: 1000, then: { type: 'line', text: 'Thanks for waiting through the stall.' } });
    const t0 = Date.now();
    await speak(session, 'This one will take a while to answer.');
    const stall = await waitOneReply(session, sinceStall, 10000, 15000);
    const stallSpoken = stall.agentText === 'Thanks for waiting through the stall.';
    const doneAt = stall.done ? new Date(session.events.find((r) => r.event === stall.done)!.at).getTime() : null;
    results['stall'] = { status: (stall.done as { status?: string } | null)?.status, agentHeard: stall.agentText, stallSpoken, totalMsFromSpeakStart: doneAt ? doneAt - t0 : null };
    console.log('stall:', JSON.stringify(results['stall']));

    results['reps'] = reps;

    const sinceEnd = session.events.length;
    session.send({ type: 'session.end' });
    await session.waitFor((e) => e.type === 'session.ended', 5000, sinceEnd).catch(() => null);
    session.close();
  } finally {
    tunnelProc.kill();
    await endpoint.close();
    if (agentId) {
      const { status } = await deleteAgent(API_KEY, agentId);
      console.log(`Deleted agent ${agentId}: HTTP ${status}`);
    }
    await writeFile(join(OUT_DIR, `g7b-clean-results-${runId}.json`), JSON.stringify(results, null, 2));
  }
}
main().catch((e) => { console.error('g7b-clean fatal:', e); process.exit(1); });
