#!/usr/bin/env -S npx tsx
// scripts/spike/g5b-g7b.ts
// SPIKE-ONLY follow-up (coordinator request, 2026-09-23). Cap: 6 more live minutes.
// Tests the actual mechanism named in docs/plans/2026-09-22-one-brain-live-path.md §1/§4:
// per-call correlation via a random token embedded in a POST-BIND session.update's
// system_prompt, parsed by the endpoint out of messages[0].
//
// G5b: two concurrent sessions on ONE stored agent, each given a DIFFERENT token via its own
// post-bind session.update, and genuinely different caller scripts. Per-request: does
// messages[0]/any system message carry the right token, does the duplicate-request pattern
// (2 requests ~200-400ms apart per turn, PROVEN in the original spike's G5) still occur, does
// each session hear ONLY its own token-keyed line, and does the post-bind system_prompt
// REPLACE the agent's stored baseline (checked via a unique marker string) for that
// connection only, leaving the other session unaffected.
//
// G7b: three HTTP-500 injections on three different turns of ONE session, then a normal
// turn -- what's heard each time, does the SDK retry exactly once each time (x-stainless-
// retry-count header), does the session keep accepting turns after all three. Then one 5s
// stall with a role-only heartbeat delta every 1s before content -- is it spoken normally.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve as dnsResolve } from 'node:dns/promises';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ensureDirs, log, setLogFile, mintToken, createAgent, deleteAgent, randomKey, sleep, OUT_DIR } from './lib.js';
import { startEndpoint, type EndpointHandle } from './endpoint.js';
import { connectStoredAgent, streamFrames, type SpikeSession } from './wsClient.js';
import { synthesizeLine, chunkToFrames } from '../rehearse/audio.js';

const API_KEY = process.env.ASSEMBLYAI_API_KEY;
if (!API_KEY) {
  console.error('g5b-g7b.ts: ASSEMBLYAI_API_KEY not set -- source .env first');
  process.exit(1);
}
const LLM_API_KEY = randomKey('spike-g5b7b');
const BASELINE_MARKER = 'AGENT_BASELINE_MARKER_XYZ_DO_NOT_ECHO';

function genToken(): string {
  return randomBytes(8).toString('hex');
}

async function speak(session: SpikeSession, text: string, voice = 'Alex'): Promise<void> {
  const pcm = await synthesizeLine(text, voice);
  await streamFrames(session, chunkToFrames(pcm));
}

async function main(): Promise<void> {
  await ensureDirs();
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  setLogFile(`spike-g5b-g7b-${runId}.jsonl`);
  console.log(`G5b/G7b run ${runId}`);

  const port = 8950;
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
  const g5b: Record<string, unknown> = {};
  const g7b: Record<string, unknown> = {};
  try {
    const agentOpts = {
      apiKey: API_KEY,
      name: 'countersign-spike-g5b7b',
      system_prompt: `${BASELINE_MARKER}: this is the AGENT-LEVEL baseline system prompt set at creation time. It should be REPLACED, not appended to, by any post-bind session.update.`,
      greeting: 'G five b, g seven b test line. Begin.',
      voice_id: 'anna',
      llm_base_url: tunnelUrl,
      llm_model: 'countersign-spike-g5b7b',
      llm_api_key: LLM_API_KEY,
      keyterms: [] as string[],
      transcription_mode: 'max_accuracy' as const,
    };
    let id: string;
    try {
      ({ id } = await createAgent(agentOpts));
    } catch (e) {
      console.log(`createAgent failed once, retrying after 5s: ${(e as Error).message.slice(0, 150)}`);
      await sleep(5000);
      ({ id } = await createAgent(agentOpts));
    }
    agentId = id;
    console.log(`Agent: ${id}`);

    // =================================================================================
    // G5b -- two concurrent sessions, per-call tokens via post-bind session.update
    // =================================================================================
    {
      const tokenA = genToken();
      const tokenB = genToken();
      endpoint.setTokenBehavior(tokenA, { type: 'line', text: 'Token A speaking, order confirmed.' });
      endpoint.setTokenBehavior(tokenB, { type: 'line', text: 'Token B speaking, balance is ready.' });

      const [tokA, tokBTok] = await Promise.all([mintToken(API_KEY, 120), mintToken(API_KEY, 120)]);
      const [sessA, sessB] = await Promise.all([
        connectStoredAgent({ token: tokA.token, agentId: id, tag: 'g5b-a' }),
        connectStoredAgent({ token: tokBTok.token, agentId: id, tag: 'g5b-b' }),
      ]);
      // Let each greeting finish before the post-bind update + speech.
      await Promise.all([
        sessA.waitFor((e) => e.type === 'reply.done', 6000, 0).catch(() => null),
        sessB.waitFor((e) => e.type === 'reply.done', 6000, 0).catch(() => null),
      ]);

      const sinceUpdA = sessA.events.length;
      const sinceUpdB = sessB.events.length;
      sessA.send({ type: 'session.update', session: { system_prompt: `COUNTERSIGN_CALL_TOKEN:${tokenA}\nYou are session A, a wire-transfer call.` } });
      sessB.send({ type: 'session.update', session: { system_prompt: `COUNTERSIGN_CALL_TOKEN:${tokenB}\nYou are session B, an account-balance call.` } });
      const [updA, updB] = await Promise.all([
        sessA.waitFor((e) => e.type === 'session.updated' || e.type === 'session.error', 6000, sinceUpdA).catch(() => null),
        sessB.waitFor((e) => e.type === 'session.updated' || e.type === 'session.error', 6000, sinceUpdB).catch(() => null),
      ]);

      // Two genuinely DIFFERENT caller scripts, two turns each, fully concurrent.
      const scriptA = ['This is Dana calling about a wire transfer to Meridian Supply.', 'The amount is eighty four thousand five hundred dollars.'];
      const scriptB = ['Hi, I need to check my account balance please.', 'My account number ends in four seven one two.'];

      const beforeIdx = endpoint.requests.length;
      for (let turn = 0; turn < 2; turn++) {
        const sinceA = sessA.events.length;
        const sinceB = sessB.events.length;
        await Promise.all([speak(sessA, scriptA[turn]!), speak(sessB, scriptB[turn]!)]);
        await Promise.all([
          sessA.waitFor((e) => e.type === 'reply.done', 15000, sinceA).catch(() => null),
          sessB.waitFor((e) => e.type === 'reply.done', 15000, sinceB).catch(() => null),
        ]);
        await sleep(400);
      }
      await sleep(500);
      const afterIdx = endpoint.requests.length;
      const turnReqs = endpoint.requests.slice(beforeIdx, afterIdx);

      // Analysis: token correctness, duplicate pattern, cross-talk, baseline replacement.
      const tokACounts = turnReqs.filter((r) => r.tokenExtracted === tokenA).length;
      const tokBCounts = turnReqs.filter((r) => r.tokenExtracted === tokenB).length;
      const noTokenCounts = turnReqs.filter((r) => r.tokenExtracted === null).length;
      const wrongToken = turnReqs.filter((r) => r.tokenExtracted !== tokenA && r.tokenExtracted !== tokenB && r.tokenExtracted !== null).length;

      // Duplicate pattern: group by token, check for >1 request with the SAME last-user-text.
      function dupPattern(token: string) {
        const reqs = turnReqs.filter((r) => r.tokenExtracted === token);
        const byUserText = new Map<string, number>();
        for (const r of reqs) {
          const msgs = (r.body as { messages?: Array<{ role: string; content: string }> }).messages ?? [];
          const lastUser = [...msgs].reverse().find((m) => m.role === 'user')?.content ?? '';
          byUserText.set(lastUser, (byUserText.get(lastUser) ?? 0) + 1);
        }
        return { totalReqs: reqs.length, byUserText: Object.fromEntries(byUserText) };
      }
      const dupA = dupPattern(tokenA);
      const dupB = dupPattern(tokenB);

      // Baseline-marker check: does either session's request carry the agent-level baseline text?
      const anyBaselineLeak = turnReqs.some((r) => JSON.stringify(r.body).includes(BASELINE_MARKER));
      // Cross-talk in transcript.agent: did session A ever hear "Token B" text or vice versa?
      const aHeardB = sessA.events.some((e) => e.event.type === 'transcript.agent' && (e.event as { text?: string }).text?.includes('Token B'));
      const bHeardA = sessB.events.some((e) => e.event.type === 'transcript.agent' && (e.event as { text?: string }).text?.includes('Token A'));
      const aHeardOwnLine = sessA.events.some((e) => e.event.type === 'transcript.agent' && (e.event as { text?: string }).text?.includes('Token A'));
      const bHeardOwnLine = sessB.events.some((e) => e.event.type === 'transcript.agent' && (e.event as { text?: string }).text?.includes('Token B'));

      Object.assign(g5b, {
        tokenA, tokenB,
        updA: updA?.type, updB: updB?.type,
        totalTurnRequests: turnReqs.length,
        tokACounts, tokBCounts, noTokenCounts, wrongToken,
        dupA, dupB,
        anyBaselineLeak,
        aHeardB, bHeardA, aHeardOwnLine, bHeardOwnLine,
      });
      console.log('G5b:', JSON.stringify(g5b, null, 2));

      endpoint.clearTokenBehavior(tokenA);
      endpoint.clearTokenBehavior(tokenB);
      sessA.close();
      sessB.close();
    }

    // =================================================================================
    // G7b -- 3x HTTP 500 on 3 different turns of one session, then normal, then a stall
    // =================================================================================
    {
      const tokenC = genToken();
      const token = await mintToken(API_KEY, 180);
      const session = await connectStoredAgent({ token: token.token, agentId: id, tag: 'g7b' });
      await session.waitFor((e) => e.type === 'reply.done', 6000, 0).catch(() => null);
      const sinceUpd = session.events.length;
      session.send({ type: 'session.update', session: { system_prompt: `COUNTERSIGN_CALL_TOKEN:${tokenC}\nSession for G7b.` } });
      await session.waitFor((e) => e.type === 'session.updated' || e.type === 'session.error', 6000, sinceUpd).catch(() => null);

      const reps: Array<Record<string, unknown>> = [];
      for (let i = 1; i <= 3; i++) {
        const since = session.events.length;
        endpoint.push({ type: 'http500' });
        await speak(session, `This is turn number ${i}, please process it now.`);
        let sawErrorEvent = false;
        let sawReplyStarted = false;
        try {
          await Promise.race([
            session.waitFor((e) => e.type === 'session.error', 10000, since).then(() => { sawErrorEvent = true; }),
            session.waitFor((e) => e.type === 'reply.started', 10000, since).then(() => { sawReplyStarted = true; }),
          ]);
        } catch { /* neither in time */ }
        await sleep(1500);
        const reqsThisTurn = endpoint.requests.filter((r) => r.receivedAt > session.events[since]!.at);
        const retryCounts = reqsThisTurn.map((r) => r.headers['x-stainless-retry-count']);
        const doneEvt = await session.waitFor((e) => e.type === 'reply.done', 3000, since).catch(() => null);
        const agentText = [...session.events].slice(since).reverse().find((r) => r.event.type === 'transcript.agent')?.event as { text?: string } | undefined;
        reps.push({ rep: i, sawErrorEvent, sawReplyStarted, retryCounts, replyDoneStatus: (doneEvt as { status?: string } | null)?.status ?? null, agentHeard: agentText?.text ?? null });
      }
      // Normal turn after 3x 500s.
      const sinceNormal = session.events.length;
      endpoint.push({ type: 'line', text: 'Session survived three server errors.' });
      await speak(session, 'Are you still working now.');
      let normalWorked = false;
      try {
        await session.waitFor((e) => e.type === 'reply.done', 10000, sinceNormal);
        const t = [...session.events].slice(sinceNormal).reverse().find((r) => r.event.type === 'transcript.agent')?.event as { text?: string } | undefined;
        normalWorked = t?.text === 'Session survived three server errors.';
      } catch { normalWorked = false; }

      // 5s stall, heartbeat every 1s.
      const sinceStall = session.events.length;
      endpoint.push({ type: 'stall', ms: 5000, heartbeatMs: 1000, then: { type: 'line', text: 'Thanks for waiting through the stall.' } });
      await speak(session, 'This one will take a while to answer.');
      let stallSpoken = false;
      let stallStartedAt: number | null = null;
      try {
        await session.waitFor((e) => e.type === 'reply.started', 8000, sinceStall).then(() => { stallStartedAt = Date.now(); });
        await session.waitFor((e) => e.type === 'reply.done', 12000, sinceStall);
        const t = [...session.events].slice(sinceStall).reverse().find((r) => r.event.type === 'transcript.agent')?.event as { text?: string } | undefined;
        stallSpoken = t?.text === 'Thanks for waiting through the stall.';
      } catch { stallSpoken = false; }

      Object.assign(g7b, { reps, normalWorked, stallSpoken, stallStartedAt });
      console.log('G7b:', JSON.stringify(g7b, null, 2));

      const sinceEnd = session.events.length;
      session.send({ type: 'session.end' });
      await session.waitFor((e) => e.type === 'session.ended', 5000, sinceEnd).catch(() => null);
      session.close();
    }
  } finally {
    tunnelProc.kill();
    await endpoint.close();
    if (agentId) {
      const { status } = await deleteAgent(API_KEY, agentId);
      console.log(`Deleted agent ${agentId}: HTTP ${status}`);
    }
    await writeFile(join(OUT_DIR, `g5b-g7b-results-${runId}.json`), JSON.stringify({ g5b, g7b }, null, 2));
  }
}

main().catch((e) => {
  console.error('g5b-g7b.ts fatal:', e);
  process.exit(1);
});
