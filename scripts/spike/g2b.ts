#!/usr/bin/env -S npx tsx
// scripts/spike/g2b.ts
// SPIKE-ONLY follow-up to G2 (coordinator request, 2026-09-23). Cap: 5 more live minutes.
// Question: is the ~4s of reply.audio that streams after an EMPTY /chat/completions
// completion actually silence, and does it block/delay the caller's next turn?
//
// Method: capture every reply.audio chunk verbatim (session.events already retains the full
// base64 -- only the JSONL LOG redacts it, per wsClient.ts's own doc comment), decode to raw
// PCM16 mono 24kHz, write a .wav per turn, compute RMS per 100ms window. One control (a
// normal canned line) establishes the noise floor from ITS OWN pauses. For overlap timing,
// each empty-completion rep starts a second caller utterance the INSTANT reply.started fires
// for the empty reply (not waiting for reply.done), so input.speech.started's timestamp vs.
// reply.done's timestamp directly answers "does it block the next turn" (a negative delta
// means the next turn was accepted BEFORE the empty reply even finished).
import { createServer as createNetTest } from 'node:net';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve as dnsResolve } from 'node:dns/promises';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDirs, log, setLogFile, mintToken, createAgent, deleteAgent, randomKey, sleep, OUT_DIR } from './lib.js';
import { startEndpoint, type EndpointHandle } from './endpoint.js';
import { connectStoredAgent, streamFrames, type SpikeSession } from './wsClient.js';
import { synthesizeLine, chunkToFrames } from '../rehearse/audio.js';

const API_KEY = process.env.ASSEMBLYAI_API_KEY;
if (!API_KEY) {
  console.error('g2b.ts: ASSEMBLYAI_API_KEY not set -- source .env first');
  process.exit(1);
}
const SAMPLE_RATE = 24000; // docs/round2: "default audio/pcm at 24 kHz", both input and output
const LLM_API_KEY = randomKey('spike-g2b');

function pcmToWav(pcm: Buffer, sampleRate = SAMPLE_RATE, channels = 1, bitsPerSample = 16): Buffer {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** RMS per 100ms window, as a fraction of full-scale int16 (0..1). */
function rmsWindows(pcm: Buffer, sampleRate = SAMPLE_RATE, windowMs = 100): number[] {
  const samplesPerWindow = Math.floor((sampleRate * windowMs) / 1000);
  const bytesPerWindow = samplesPerWindow * 2;
  const out: number[] = [];
  for (let off = 0; off + 1 < pcm.length; off += bytesPerWindow) {
    const end = Math.min(off + bytesPerWindow, pcm.length - (pcm.length % 2));
    let sumSq = 0;
    let n = 0;
    for (let i = off; i + 1 < end; i += 2) {
      const s = pcm.readInt16LE(i) / 32768;
      sumSq += s * s;
      n++;
    }
    if (n > 0) out.push(Math.sqrt(sumSq / n));
  }
  return out;
}

async function speak(session: SpikeSession, text: string): Promise<void> {
  const pcm = await synthesizeLine(text, 'Alex');
  await streamFrames(session, chunkToFrames(pcm));
}

/** Collects every reply.audio 'data' field between two event indices (inclusive start,
 *  exclusive of anything after the boundary index), decoded and concatenated. */
function collectAudio(session: SpikeSession, fromIdx: number, toIdx: number): Buffer {
  const parts: Buffer[] = [];
  for (let i = fromIdx; i < toIdx; i++) {
    const e = session.events[i]?.event;
    if (e?.type === 'reply.audio' && typeof e.data === 'string') {
      parts.push(Buffer.from(e.data, 'base64'));
    }
  }
  return Buffer.concat(parts);
}

async function main(): Promise<void> {
  await ensureDirs();
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  setLogFile(`spike-g2b-${runId}.jsonl`);
  console.log(`G2b run ${runId}`);

  const port = 8940;
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
  for (let i = 0; i < 20; i++) {
    try { await dnsResolve(host); break; } catch { await sleep(1000); }
  }
  await sleep(1500);

  let agentId: string | null = null;
  const results: Array<Record<string, unknown>> = [];
  try {
    const agentOpts = {
      apiKey: API_KEY,
      name: 'countersign-spike-g2b',
      system_prompt: 'SPIKE G2b: audio-silence follow-up. Endpoint returns scripted text only.',
      greeting: 'G two b audio test. Begin.',
      voice_id: 'anna',
      llm_base_url: tunnelUrl,
      llm_model: 'countersign-spike-g2b',
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

    const token = await mintToken(API_KEY, 300);
    const session = await connectStoredAgent({ token: token.token, agentId: id, tag: 'g2b' });
    await session.waitFor((e) => e.type === 'reply.done', 6000, 0).catch(() => null);

    // ---- CONTROL: one normal canned line, capture audio, establish noise floor ----
    {
      const since = session.events.length;
      endpoint.push({ type: 'line', text: 'This is the control line for audio analysis testing purposes.' });
      await speak(session, 'Please answer the control question now.');
      await session.waitFor((e) => e.type === 'reply.started', 10000, since).catch(() => null);
      const doneEvt = await session.waitFor((e) => e.type === 'reply.done', 10000, since).catch(() => null);
      const doneIdx = session.events.findIndex((r, idx) => idx >= since && r.event === doneEvt);
      const pcm = collectAudio(session, since, doneIdx >= 0 ? doneIdx : session.events.length);
      await writeFile(join(OUT_DIR, 'g2b-control.wav'), pcmToWav(pcm));
      const windows = rmsWindows(pcm);
      const sorted = [...windows].sort((a, b) => a - b);
      const noiseFloor = sorted.length ? sorted[Math.floor(sorted.length * 0.1)] : 0; // 10th percentile = quietest parts (pauses)
      const maxRms = windows.length ? Math.max(...windows) : 0;
      results.push({ rep: 'control', durationMs: (pcm.length / 2 / SAMPLE_RATE) * 1000, windows: windows.length, maxRms, noiseFloorP10: noiseFloor });
      console.log(`control: ${pcm.length} bytes (~${(pcm.length / 2 / SAMPLE_RATE).toFixed(2)}s), maxRms=${maxRms.toFixed(4)}, noiseFloorP10=${noiseFloor?.toFixed(4)}`);
    }

    // ---- 5x empty completion: capture audio + overlap-timing + transcription-during ----
    for (let i = 1; i <= 5; i++) {
      const since = session.events.length;
      endpoint.push({ type: 'empty' });
      await speak(session, `Testing empty reply number ${i} for gate two b.`);
      await session.waitFor((e) => e.type === 'transcript.user', 12000, since).catch(() => null);
      const startedEvt = await session.waitFor((e) => e.type === 'reply.started', 10000, since).catch(() => null);
      const startedAt = Date.now();
      // Immediately (no wait) start a SECOND caller utterance, overlapping whatever audio
      // is still streaming for the empty reply -- tests both blocking and transcription.
      const overlapText = `Overlap check number ${i}.`;
      const overlapSince = session.events.length;
      endpoint.push({ type: 'line', text: `Acknowledged overlap ${i}.` });
      const speakPromise = speak(session, overlapText);
      const [doneEvt, speechStartedEvt] = await Promise.all([
        session.waitFor((e) => e.type === 'reply.done', 12000, since).catch(() => null),
        session.waitFor((e) => e.type === 'input.speech.started', 12000, overlapSince).catch(() => null),
      ]);
      await speakPromise;
      const overlapUserEvt = await session.waitFor((e) => e.type === 'transcript.user', 12000, overlapSince).catch(() => null);
      await sleep(500);

      const doneIdx = session.events.findIndex((r, idx) => idx >= since && r.event === doneEvt);
      const pcm = collectAudio(session, since, doneIdx >= 0 ? doneIdx : session.events.length);
      await writeFile(join(OUT_DIR, `g2b-empty-${i}.wav`), pcmToWav(pcm));
      const windows = rmsWindows(pcm);
      const maxRms = windows.length ? Math.max(...windows) : 0;

      // Find timestamps directly off the logged events (session.events stores {at, event}).
      const doneRec = doneIdx >= 0 ? session.events[doneIdx] : undefined;
      const startedIdx = startedEvt ? session.events.findIndex((r, idx) => idx >= since && r.event === startedEvt) : -1;
      const startedRec = startedIdx >= 0 ? session.events[startedIdx] : undefined;
      const speechStartedRec = speechStartedEvt
        ? session.events.find((r) => r.event === speechStartedEvt)
        : undefined;
      const doneMs = doneRec ? new Date(doneRec.at).getTime() : null;
      const speechStartedMs = speechStartedRec ? new Date(speechStartedRec.at).getTime() : null;
      const deltaMs = doneMs !== null && speechStartedMs !== null ? speechStartedMs - doneMs : null;

      const overlapHeardText = (overlapUserEvt as { text?: string } | null)?.text ?? null;
      const overlapMatches = overlapHeardText?.toLowerCase().replace(/[.?]/g, '').trim() === overlapText.toLowerCase().replace(/[.?]/g, '').trim();

      results.push({
        rep: i,
        replyDoneStatus: (doneEvt as { status?: string } | null)?.status ?? null,
        pcmBytes: pcm.length,
        durationMs: (pcm.length / 2 / SAMPLE_RATE) * 1000,
        maxRms,
        speechStartedToReplyDoneDeltaMs: deltaMs, // negative = accepted BEFORE empty reply finished
        overlapHeardText,
        overlapMatches,
      });
      console.log(`empty ${i}: ${pcm.length} bytes (~${(pcm.length / 2 / SAMPLE_RATE).toFixed(2)}s), maxRms=${maxRms.toFixed(4)}, doneStatus=${(doneEvt as { status?: string } | null)?.status}, input.speech.started - reply.done = ${deltaMs}ms, overlap heard="${overlapHeardText}" match=${overlapMatches}`);
      await log({ kind: 'g2b_rep', rep: i, ...results[results.length - 1] });
    }

    session.close();
  } finally {
    tunnelProc.kill();
    await endpoint.close();
    if (agentId) {
      const { status } = await deleteAgent(API_KEY, agentId);
      console.log(`Deleted agent ${agentId}: HTTP ${status}`);
    }
    await writeFile(join(OUT_DIR, `g2b-results-${runId}.json`), JSON.stringify(results, null, 2));
    console.log('\n=== G2b RESULTS ===');
    console.log(JSON.stringify(results, null, 2));
  }
}

main().catch((e) => {
  console.error('g2b.ts fatal:', e);
  process.exit(1);
});
