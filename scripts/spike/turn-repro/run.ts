// scripts/spike/turn-repro/run.ts
//
// SONNET-JUSTIFIED spike (2026-09-25): reproduces, WITHOUT the founder, the defect where
// AssemblyAI's voice agent ends the caller's FIRST turn while the caller is still talking --
// PROVEN from scripts/rehearse/reports/founder-2026-09-25/ (Dana: turn cut at 10.40s while
// caller stayed loud to 11.9s; CEO: cut at 12.31s while caller stayed loud to 14.4s -- both
// numbers computed from AssemblyAI's own *.aai-timeline.json against started_at_unix_ms).
//
// Standalone script. Does NOT import packages/server code (LANE-FILES restricts writes to
// scripts/spike/turn-repro/**, and this keeps the spike decoupled from product code), but
// mirrors packages/server/src/aai/session.ts's real wire behavior: mint token -> open socket
// -> session.update -> wait session.ready -> stream input.audio -> read events -> session.end.
//
// LAW 1 (no detection claims): this script never classifies a voice as synthetic/human. It
// only measures WHEN AssemblyAI's own turn-detection decided a turn ended, against recorded
// ground truth of when the caller (a human, the founder) was still audibly talking.
//
// Never prints or writes the API key. Load it with: set -a; . ./.env; set +a
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIPS_DIR = resolve(__dirname, 'clips');
const RESULTS_DIR = resolve(__dirname, 'results');
if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });

const TOKEN_URL = 'https://agents.assemblyai.com/v1/token';
const WS_URL = 'wss://agents.assemblyai.com/v1/ws';
const SESSIONS_URL = 'https://agents.assemblyai.com/v1/sessions';
const SAMPLE_RATE = 24000;
const BYTES_PER_SAMPLE = 2; // s16le
const CHUNK_MS = 40;
const CHUNK_BYTES = Math.round((SAMPLE_RATE * BYTES_PER_SAMPLE * CHUNK_MS) / 1000); // 1920
const READY_TIMEOUT_MS = 15_000;
const POST_STOP_LINGER_MS = 2_000; // end session ~2s after first input.speech.stopped
const POST_CLIP_LINGER_MS = 3_000; // or clip end + 3s if speech.stopped never fires
const CLOSE_WAIT_MS = 3_000; // wait for session.ended (billing) after sending session.end

const apiKey = process.env.ASSEMBLYAI_API_KEY;
if (!apiKey) {
  console.error('ASSEMBLYAI_API_KEY not set. Run: set -a; . ./.env; set +a');
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Turn-detection config presets. Doc quotes (fetched 2026-09-25 by a haiku errand agent,
// https://www.assemblyai.com/docs/voice-agents/voice-agent-api/turn-detection-and-interruptions):
//   vad_threshold: "Speech detection sensitivity (0.0 to 1.0). Lower is more sensitive."
//   min_silence / max_silence: "Left unset, the agent paces this adaptively." ...
//     "Setting min_silence or max_silence turns off the adaptive pacing and entity-aware
//     waiting described above for the rest of the session."
//   "With no turn_detection config, the agent adapts to each speaker's pace and
//     automatically slows down to capture values your tools need."
// DEFAULT_VAD_THRESHOLD = 0.5 is already PROVEN in packages/server/src/aai/config.ts
// (docs re-check dated 2026-09-18/19, same page, same wording).
// voice_focus / voice_focus_threshold / continuous_partials: NOT mentioned on that page at
// all (the errand agent's fetch found nothing under those names) -- per task instructions
// ("include voice_focus only if the docs say it affects speech detection") these are
// EXCLUDED from the matrix; this is itself a finding, not an omission.
export interface TurnDetectionPreset {
  name: string;
  turnDetection: Record<string, unknown> | null; // null = omit the key entirely
}

export const PRESETS: Record<string, TurnDetectionPreset> = {
  baseline: { name: 'baseline (no turn_detection key)', turnDetection: null },
  vad_030: { name: 'vad_threshold=0.3', turnDetection: { vad_threshold: 0.3 } },
  vad_020: { name: 'vad_threshold=0.2', turnDetection: { vad_threshold: 0.2 } },
  min_silence_1500: { name: 'min_silence=1500 (disables adaptive pacing per docs)', turnDetection: { min_silence: 1500 } },
};

// ---------------------------------------------------------------------------
// Clip metadata. offsetSec = where this clip starts in the ORIGINAL recording (t=0 there is
// started_at_unix_ms). turnStartRelMs/continuationEndRelMs are relative to the CLIP start
// (ms), derived from the PROVEN evidence in the task brief:
//   Dana: turn 8.8s -> AAI-ended 10.40s; caller stayed loud (1600-2700 RMS) to 11.9s.
//     Clip = [8.3s, 15.0s) of the original -> turnStart 500ms, continuationEnd 3600ms.
//   CEO: turn 7.0s -> AAI-ended 12.31s; caller loud continuously to 14.4s.
//     Clip = [6.5s, 17.0s) of the original -> turnStart 500ms, continuationEnd 7900ms.
//   Dana clean continuation turn (from the SAME recording, timeline-proven 15.8s -> 29.7s,
//     a turn AssemblyAI's own timeline shows ending appropriately -- the agent's next reply
//     responds to the whole utterance including the amount and account number):
//     clip = [15.8s, 31.7s) (29.7 + 2s of trailing silence) -> naturalEnd 13900ms.
export interface ClipMeta {
  key: string;
  label: string;
  file: string;
  offsetSec: number;
  turnStartRelMs: number;
  continuationEndRelMs: number | null; // null = no CUT/WHOLE classification (clean-turn check)
  naturalEndRelMs?: number; // only for the clean-turn check
}

export const CLIPS: Record<string, ClipMeta> = {
  dana: {
    key: 'dana',
    label: 'Dana turn 1 (PROVEN cut live: 10.40s, loud to 11.9s)',
    file: resolve(CLIPS_DIR, 'dana-turn1.pcm'),
    offsetSec: 8.3,
    turnStartRelMs: 500,
    continuationEndRelMs: 3600,
  },
  ceo: {
    key: 'ceo',
    label: 'CEO turn 1 (PROVEN cut live: 12.31s, loud to 14.4s)',
    file: resolve(CLIPS_DIR, 'ceo-turn1.pcm'),
    offsetSec: 6.5,
    turnStartRelMs: 500,
    continuationEndRelMs: 7900,
  },
  'dana-clean': {
    key: 'dana-clean',
    label: 'Dana continuation turn (PROVEN clean end live: 29.7s)',
    file: resolve(CLIPS_DIR, 'dana-clean.pcm'),
    offsetSec: 15.8,
    turnStartRelMs: 0,
    continuationEndRelMs: null,
    naturalEndRelMs: 13900,
  },
  // Coordinator add-on (2026-09-25), stage A: the founder's RESTATED long turn, which in the
  // live calls was the SECOND turn (after adaptation, per the docs' adaptive-pacing
  // description) and was NOT cut -- PROVEN end times: Dana 29.7s, CEO 29.6s (same
  // *.aai-timeline.json). Here it is streamed as the FIRST (and only) caller turn of a FRESH
  // session, isolating "first turn, no adaptation yet" from "this utterance's own content".
  // continuationEndRelMs is set to the PROVEN natural end of the utterance (not a
  // known-still-talking point, since these turns were never cut live) -- so classification
  // here means: CUT = speech.stopped fired meaningfully before the utterance's own true end
  // (first-turn/no-adaptation reproduces even on an utterance that was never cut live); WHOLE
  // = it did not.
  'dana-restated': {
    key: 'dana-restated',
    label: 'Dana restated turn as FRESH first turn (PROVEN not cut live, ended 29.7s)',
    file: resolve(CLIPS_DIR, 'dana-restated.pcm'),
    offsetSec: 15.3,
    turnStartRelMs: 500,
    continuationEndRelMs: 14400, // 29.7s - 15.3s
  },
  'ceo-restated': {
    key: 'ceo-restated',
    label: 'CEO restated turn as FRESH first turn (PROVEN not cut live, ended 29.6s)',
    file: resolve(CLIPS_DIR, 'ceo-restated.pcm'),
    offsetSec: 17.2,
    turnStartRelMs: 500,
    continuationEndRelMs: 12400, // 29.6s - 17.2s
  },
  // Coordinator follow-up (2026-09-25, warm-up hypothesis): "Dana Whitfield, corporate
  // treasury." only, ending right before "I need" -- boundary PROVEN via ffmpeg
  // silencedetect on the original recording (noise=-32dB, d=0.08s): a silence window
  // 17.03s-17.31s in this recording's own timeline, i.e. right after "treasury." and before
  // "I need to wire it..." begins. Clip cut at 17.15s (mid-pause, before "I need" starts).
  // Never independently classified CUT/WHOLE -- it's a deliberately short first turn, used
  // only to see whether ANY completed prior turn changes what happens to the long turn that
  // follows.
  'dana-warmup': {
    key: 'dana-warmup',
    label: 'Dana warm-up turn: "Dana Whitfield, corporate treasury." only',
    file: resolve(CLIPS_DIR, 'dana-warmup.pcm'),
    offsetSec: 15.3,
    turnStartRelMs: 0,
    continuationEndRelMs: null,
  },
};

// ---------------------------------------------------------------------------
export interface RunResult {
  ts: string;
  clip: string;
  config: string;
  runIndex: number;
  events: { tMs: number; type: string; detail?: string }[];
  firstSpeechStartedMs: number | null;
  firstSpeechStoppedMs: number | null;
  firstTranscriptText: string | null;
  classification: 'CUT' | 'WHOLE' | 'NO_STOP_EVENT' | 'N/A';
  sessionDurationSecondsFromServer: number | null;
  wallClockSessionMs: number;
  error: string | null;
  errorClass: 'none' | 'auth' | 'rate_limit' | 'server' | 'other';
}

async function mintToken(capSeconds: number): Promise<string> {
  const url = new URL(TOKEN_URL);
  url.searchParams.set('expires_in_seconds', '60');
  url.searchParams.set('max_session_duration_seconds', String(capSeconds));
  const res = await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw Object.assign(new Error(`token mint failed: ${res.status} ${body.slice(0, 200)}`), { httpStatus: res.status });
  }
  const json = (await res.json()) as { token: string };
  return json.token;
}

function classifyError(status: number | undefined): RunResult['errorClass'] {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status !== undefined && status >= 500) return 'server';
  return 'other';
}

async function runOneSession(clip: ClipMeta, preset: TurnDetectionPreset, runIndex: number): Promise<RunResult> {
  const events: RunResult['events'] = [];
  let firstSpeechStartedMs: number | null = null;
  let firstSpeechStoppedMs: number | null = null;
  let firstTranscriptText: string | null = null;
  let sessionDurationSecondsFromServer: number | null = null;
  const wallStart = Date.now();

  const capSeconds = 60; // generous per-session cap; clips are all under 20s + linger

  let token: string;
  try {
    token = await mintToken(capSeconds);
  } catch (err) {
    const status = (err as { httpStatus?: number }).httpStatus;
    return {
      ts: new Date().toISOString(),
      clip: clip.key,
      config: preset.name,
      runIndex,
      events,
      firstSpeechStartedMs,
      firstSpeechStoppedMs,
      firstTranscriptText,
      classification: 'N/A',
      sessionDurationSecondsFromServer,
      wallClockSessionMs: Date.now() - wallStart,
      error: String(err),
      errorClass: classifyError(status),
    };
  }

  return new Promise<RunResult>((resolvePromise) => {
    const ws = new WebSocket(`${WS_URL}?token=${token}`);
    let t0: number | null = null; // ms timestamp of first audio chunk sent
    let closed = false;
    let streaming = false;
    let sessionEndSent = false;

    const finish = (error: string | null, errorClass: RunResult['errorClass'] = 'none') => {
      if (closed) return;
      closed = true;
      const classification: RunResult['classification'] =
        clip.continuationEndRelMs === null
          ? 'N/A'
          : firstSpeechStoppedMs === null
            ? 'NO_STOP_EVENT'
            : firstSpeechStoppedMs < clip.continuationEndRelMs
              ? 'CUT'
              : 'WHOLE';
      resolvePromise({
        ts: new Date().toISOString(),
        clip: clip.key,
        config: preset.name,
        runIndex,
        events,
        firstSpeechStartedMs,
        firstSpeechStoppedMs,
        firstTranscriptText,
        classification,
        sessionDurationSecondsFromServer,
        wallClockSessionMs: Date.now() - wallStart,
        error,
        errorClass,
      });
    };

    const readyTimer = setTimeout(() => {
      try { ws.terminate(); } catch { /* ignore */ }
      finish('timed out waiting for session.ready');
    }, READY_TIMEOUT_MS);

    function log(type: string, detail?: string) {
      const tMs = t0 === null ? -1 : Date.now() - t0;
      events.push({ tMs, type, detail });
      console.log(`  [t=${tMs >= 0 ? tMs : 'pre'}ms] ${type}${detail ? ' ' + detail : ''}`);
    }

    async function streamClip() {
      streaming = true;
      const pcm = readFileSync(clip.file);
      const totalChunks = Math.ceil(pcm.length / CHUNK_BYTES);
      t0 = Date.now();
      log('audio.stream.start', `bytes=${pcm.length} chunks=${totalChunks}`);
      const scheduleStart = t0;
      for (let i = 0; i < totalChunks; i++) {
        if (closed) return;
        const chunk = pcm.subarray(i * CHUNK_BYTES, Math.min((i + 1) * CHUNK_BYTES, pcm.length));
        const b64 = chunk.toString('base64');
        try {
          ws.send(JSON.stringify({ type: 'input.audio', audio: b64 }));
        } catch {
          return; // socket gone
        }
        const targetTime = scheduleStart + (i + 1) * CHUNK_MS;
        const waitMs = targetTime - Date.now();
        if (waitMs > 0) await sleep(waitMs);
      }
      log('audio.stream.end');
      // Linger logic: if speech.stopped already fired, the stop-linger timer (set in the
      // message handler below) owns ending the session. If it never fires, end at clip end
      // + POST_CLIP_LINGER_MS.
      if (firstSpeechStoppedMs === null) {
        await sleep(POST_CLIP_LINGER_MS);
        if (!closed) endSession();
      }
    }

    function endSession() {
      if (sessionEndSent || closed) return;
      sessionEndSent = true;
      try {
        ws.send(JSON.stringify({ type: 'session.end' }));
      } catch {
        finish(null);
        return;
      }
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        finish(null);
      }, CLOSE_WAIT_MS);
      (ws as unknown as { __endTimer?: NodeJS.Timeout }).__endTimer = timer;
    }

    ws.on('open', () => {
      const input: Record<string, unknown> = {
        format: { encoding: 'audio/pcm', sample_rate: SAMPLE_RATE },
        keyterms: ['Meridian Supply', 'Northgate Partners', 'Marcus Obi', 'Dana Whitfield', 'Robert Miller', 'Hartwell', 'Whitmore & Bass', 'Calder & Finch'],
        transcription_mode: 'max_accuracy',
      };
      if (preset.turnDetection) input.turn_detection = preset.turnDetection;
      const sessionUpdate = {
        type: 'session.update',
        session: {
          system_prompt: 'You are a neutral test line for an audio pipeline check. Keep replies to one short sentence.',
          input,
          output: { voice: 'anna', format: { encoding: 'audio/pcm', sample_rate: SAMPLE_RATE } },
          tools: [],
        },
      };
      ws.send(JSON.stringify(sessionUpdate));
    });

    ws.on('message', (data: WebSocket.RawData) => {
      let msg: Record<string, unknown> | null = null;
      try {
        msg = JSON.parse(typeof data === 'string' ? data : data.toString());
      } catch {
        return;
      }
      if (!msg) return;
      const type = String(msg.type ?? 'unknown');

      if (type === 'session.ready') {
        clearTimeout(readyTimer);
        log('session.ready');
        void streamClip();
        return;
      }
      if (type === 'session.error') {
        clearTimeout(readyTimer);
        log('session.error', JSON.stringify(msg).slice(0, 200));
        try { ws.close(); } catch { /* ignore */ }
        finish(`session.error: ${String(msg.code)} ${String(msg.message)}`, 'other');
        return;
      }
      if (type === 'input.speech.started') {
        if (firstSpeechStartedMs === null && t0 !== null) firstSpeechStartedMs = Date.now() - t0;
        log('input.speech.started');
        return;
      }
      if (type === 'input.speech.stopped') {
        const isFirst = firstSpeechStoppedMs === null;
        if (isFirst && t0 !== null) firstSpeechStoppedMs = Date.now() - t0;
        log('input.speech.stopped', isFirst ? '(first)' : '');
        if (isFirst) {
          setTimeout(() => {
            if (!closed) endSession();
          }, POST_STOP_LINGER_MS);
        }
        return;
      }
      if (type === 'transcript.user') {
        const text = String(msg.text ?? '');
        if (firstTranscriptText === null) firstTranscriptText = text;
        log('transcript.user', JSON.stringify(text));
        return;
      }
      if (type === 'session.ended') {
        if (typeof msg.session_duration_seconds === 'number') {
          sessionDurationSecondsFromServer = msg.session_duration_seconds;
        }
        log('session.ended', JSON.stringify({
          session_duration_seconds: msg.session_duration_seconds,
          audio_duration_seconds: msg.audio_duration_seconds,
        }));
        const timer = (ws as unknown as { __endTimer?: NodeJS.Timeout }).__endTimer;
        if (timer) clearTimeout(timer);
        try { ws.close(); } catch { /* ignore */ }
        finish(null);
        return;
      }
      if (type === 'transcript.agent' || type === 'reply.started' || type === 'reply.done' || type === 'session.updated' || type === 'transcript.user.delta' || type === 'transcript.agent.delta') {
        // Routine/known types -- log compactly, not full detail.
        log(type);
        return;
      }
      // Anything else: log the raw type so the report can note unmodeled events too.
      log(type, JSON.stringify(msg).slice(0, 150));
    });

    ws.on('close', (code: number, reason: Buffer) => {
      if (!closed) {
        log('ws.close', `code=${code} reason=${reason?.toString().slice(0, 100)}`);
        finish(streaming ? null : 'socket closed before session.ready');
      }
    });

    ws.on('error', (err: Error) => {
      const status = (err as unknown as { message?: string }).message?.includes('429') ? 429 : undefined;
      log('ws.error', String(err));
      finish(String(err), classifyError(status));
    });
  });
}

// ---------------------------------------------------------------------------
async function fetchTotalLiveSeconds(): Promise<{ seconds: number | null; note: string }> {
  try {
    const res = await fetch(`${SESSIONS_URL}?limit=50`, { method: 'GET', headers: { Authorization: apiKey! } });
    if (!res.ok) {
      return { seconds: null, note: `sessions endpoint returned ${res.status}` };
    }
    const json = (await res.json()) as { sessions?: { duration_seconds?: number; created_at?: string }[] };
    const sessions = json.sessions ?? [];
    // Sum only sessions created during this script's run (best-effort: caller filters by time).
    const total = sessions.reduce((acc, s) => acc + (typeof s.duration_seconds === 'number' ? s.duration_seconds : 0), 0);
    return { seconds: total, note: `summed ${sessions.length} sessions from /v1/sessions (may include sessions outside this run -- see script's own wall-clock sum for a tighter estimate)` };
  } catch (err) {
    return { seconds: null, note: `fetch failed: ${String(err)}` };
  }
}

// ---------------------------------------------------------------------------
interface Budget {
  maxSessions: number;
  maxLiveSeconds: number;
  sessionsRun: number;
  wallSecondsUsed: number;
}

function budgetExceeded(b: Budget): boolean {
  return b.sessionsRun >= b.maxSessions || b.wallSecondsUsed >= b.maxLiveSeconds;
}

async function runAndRecord(
  clipKey: string,
  presetKey: string,
  runIndex: number,
  budget: Budget,
  results: RunResult[]
): Promise<RunResult> {
  const clip = CLIPS[clipKey]!;
  const preset = PRESETS[presetKey]!;
  console.log(`\n=== RUN ${budget.sessionsRun + 1}: clip=${clip.key} config=${preset.name} run#${runIndex} ===`);
  const result = await runOneSession(clip, preset, runIndex);
  budget.sessionsRun += 1;
  budget.wallSecondsUsed += result.wallClockSessionMs / 1000;
  results.push(result);
  const line = `RESULT clip=${result.clip} config=${result.config} run=${result.runIndex} ` +
    `speech.started=${result.firstSpeechStartedMs ?? 'none'}ms speech.stopped=${result.firstSpeechStoppedMs ?? 'none'}ms ` +
    `transcript=${JSON.stringify(result.firstTranscriptText)} classification=${result.classification} ` +
    `error=${result.error ?? 'none'}`;
  console.log(line);
  writeFileSync(resolve(RESULTS_DIR, 'results.json'), JSON.stringify(results, null, 2));
  return result;
}

async function main() {
  const results: RunResult[] = [];
  const budget: Budget = { maxSessions: 24, maxLiveSeconds: 8 * 60, sessionsRun: 0, wallSecondsUsed: 0 };

  console.log('STAGE 1: reproduction (baseline, no turn_detection key)');
  const stage1: RunResult[] = [];
  for (let i = 1; i <= 3; i++) {
    if (budgetExceeded(budget)) break;
    const r = await runAndRecord('dana', 'baseline', i, budget, results);
    stage1.push(r);
    if (r.errorClass === 'auth' || r.errorClass === 'rate_limit' || r.errorClass === 'server') {
      console.error(`STOPPING: ${r.errorClass} error on dana run ${i}: ${r.error}`);
      return finalize(results, budget, 'stopped early on auth/rate-limit/server error');
    }
  }
  for (let i = 1; i <= 2; i++) {
    if (budgetExceeded(budget)) break;
    const r = await runAndRecord('ceo', 'baseline', i, budget, results);
    stage1.push(r);
    if (r.errorClass === 'auth' || r.errorClass === 'rate_limit' || r.errorClass === 'server') {
      console.error(`STOPPING: ${r.errorClass} error on ceo run ${i}: ${r.error}`);
      return finalize(results, budget, 'stopped early on auth/rate-limit/server error');
    }
  }

  const danaCuts = stage1.filter((r) => r.clip === 'dana' && r.classification === 'CUT').length;
  const ceoCuts = stage1.filter((r) => r.clip === 'ceo' && r.classification === 'CUT').length;
  const anyCut = danaCuts > 0 || ceoCuts > 0;

  console.log(`\nStage 1 done. Dana CUTs: ${danaCuts}/3. CEO CUTs: ${ceoCuts}/2. Reproduced offline: ${anyCut}`);

  // Coordinator add-on, stage A (2026-09-25): runs regardless of stage 1's outcome -- tests
  // "first turn, no adaptation yet" against the RESTATED long turn, which was never cut live
  // (it was the 2nd turn there). 2 runs per clip, baseline config, fresh session each run.
  console.log('\nSTAGE A: adaptation-vs-utterance (restated turn as FRESH first turn, baseline config)');
  const stageA: RunResult[] = [];
  for (const clipKey of ['dana-restated', 'ceo-restated']) {
    for (let i = 1; i <= 2; i++) {
      if (budgetExceeded(budget)) break;
      const r = await runAndRecord(clipKey, 'baseline', i, budget, results);
      stageA.push(r);
      if (r.errorClass === 'auth' || r.errorClass === 'rate_limit' || r.errorClass === 'server') {
        console.error(`STOPPING: ${r.errorClass} error on ${clipKey} run ${i}: ${r.error}`);
        return finalize(results, budget, 'stopped early on auth/rate-limit/server error');
      }
    }
  }
  const danaRestatedCuts = stageA.filter((r) => r.clip === 'dana-restated' && r.classification === 'CUT').length;
  const ceoRestatedCuts = stageA.filter((r) => r.clip === 'ceo-restated' && r.classification === 'CUT').length;
  console.log(`Stage A done. dana-restated CUTs: ${danaRestatedCuts}/2. ceo-restated CUTs: ${ceoRestatedCuts}/2.`);

  if (!anyCut) {
    console.log('\nNOT REPRODUCIBLE OFFLINE (opening utterance): neither clip ever CUT in 5 baseline runs. Stopping the A/B matrix per instructions (stage A above still ran and is reported).');
    return finalize(results, budget, 'not reproducible offline on the opening utterance -- stopped stage 2/3 after stage 1 + stage A');
  }

  console.log(`\nReproduced. Dana CUTs: ${danaCuts}/3. CEO CUTs: ${ceoCuts}/2.`);
  const primaryClip = danaCuts >= ceoCuts ? 'dana' : 'ceo';
  const secondaryClip = primaryClip === 'dana' ? 'ceo' : 'dana';
  console.log(`Primary clip for stage 2: ${primaryClip} (most reliable repro).`);

  console.log('\nSTAGE 2: A/B turn_detection configs');
  const stage2Configs = ['vad_030', 'vad_020', 'min_silence_1500'];
  const configCutCounts: Record<string, { cuts: number; total: number }> = {};
  for (const presetKey of stage2Configs) {
    configCutCounts[presetKey] = { cuts: 0, total: 0 };
    for (let i = 1; i <= 2; i++) {
      if (budgetExceeded(budget)) break;
      const r = await runAndRecord(primaryClip, presetKey, i, budget, results);
      configCutCounts[presetKey]!.total += 1;
      if (r.classification === 'CUT') configCutCounts[presetKey]!.cuts += 1;
      if (r.errorClass === 'auth' || r.errorClass === 'rate_limit' || r.errorClass === 'server') {
        console.error(`STOPPING: ${r.errorClass} error on ${presetKey} run ${i}: ${r.error}`);
        return finalize(results, budget, 'stopped early on auth/rate-limit/server error');
      }
    }
    if (budgetExceeded(budget)) break;
  }

  // Pick "best" = fewest CUTs (ties broken by config list order: vad_030 > vad_020 > min_silence_1500,
  // preferring the config that keeps adaptive pacing, per the docs' own warning about
  // min_silence/max_silence disabling it).
  let bestPreset = stage2Configs[0]!;
  let bestCutRate = Infinity;
  for (const presetKey of stage2Configs) {
    const c = configCutCounts[presetKey];
    if (!c || c.total === 0) continue;
    const rate = c.cuts / c.total;
    if (rate < bestCutRate) {
      bestCutRate = rate;
      bestPreset = presetKey;
    }
  }
  console.log(`\nBest config so far: ${bestPreset} (cut rate ${bestCutRate === Infinity ? 'n/a' : bestCutRate})`);

  if (!budgetExceeded(budget)) {
    console.log(`Running best config (${bestPreset}) once on secondary clip (${secondaryClip})`);
    await runAndRecord(secondaryClip, bestPreset, 1, budget, results);
  }

  console.log('\nSTAGE 3: clean-turn check (best config, dana-clean clip)');
  if (!budgetExceeded(budget)) {
    const r = await runAndRecord('dana-clean', bestPreset, 1, budget, results);
    const naturalEnd = CLIPS['dana-clean']!.naturalEndRelMs!;
    if (r.firstSpeechStoppedMs !== null) {
      console.log(`Clean-turn stop latency: speech.stopped fired at ${r.firstSpeechStoppedMs}ms vs natural end ~${naturalEnd}ms (delta ${r.firstSpeechStoppedMs - naturalEnd}ms).`);
    } else {
      console.log('Clean-turn check: speech.stopped never fired within the clip + linger window.');
    }
  }

  return finalize(results, budget, 'completed full matrix');
}

async function finalize(results: RunResult[], budget: Budget, note: string) {
  writeFileSync(resolve(RESULTS_DIR, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`\n=== DONE: ${note} ===`);
  console.log(`Sessions run: ${budget.sessionsRun}. Wall-clock seconds used (script-side estimate): ${budget.wallSecondsUsed.toFixed(1)}s.`);
  const serverSum = results.reduce((acc, r) => acc + (r.sessionDurationSecondsFromServer ?? 0), 0);
  const serverCount = results.filter((r) => r.sessionDurationSecondsFromServer !== null).length;
  console.log(`Sum of session_duration_seconds from AssemblyAI's own session.ended events: ${serverSum.toFixed(1)}s (${serverCount}/${results.length} sessions reported this field).`);
  const totalFromApi = await fetchTotalLiveSeconds();
  console.log(`GET /v1/sessions cross-check: ${totalFromApi.seconds ?? 'unavailable'} (${totalFromApi.note})`);
  console.log(`Estimated cost at $4.50/hour: $${((serverSum || budget.wallSecondsUsed) / 3600 * 4.5).toFixed(2)} (ESTIMATE, from ${serverCount === results.length ? 'server-reported' : 'wall-clock fallback where server field was missing'} seconds).`);
}

// Follow-up (2026-09-25, after stage 1 + stage A): stage 1's original two clips (dana turn1,
// ceo turn1) did NOT reproduce a cut in 5 baseline runs, but stage A's dana-restated clip DID
// (2/2 CUT, as a fresh session's first turn) -- a more reliable repro signal than anything in
// stage 1. This mode skips straight to the A/B config matrix against a caller-specified
// primary clip, appending to the SAME results.json rather than starting a fresh file, so the
// whole spike's evidence stays in one place.
async function stage2Followup(primaryClipKey: string, secondaryClipKey: string) {
  const resultsPath = resolve(RESULTS_DIR, 'results.json');
  const results: RunResult[] = existsSync(resultsPath) ? (JSON.parse(readFileSync(resultsPath, 'utf-8')) as RunResult[]) : [];
  const budget: Budget = { maxSessions: 24, maxLiveSeconds: 8 * 60, sessionsRun: 0, wallSecondsUsed: 0 };
  // Budget already spent by prior invocations of this process (stage 1 + stage A = 9
  // sessions, ~92s server-reported) counts against the SAME caps -- charge it here so this
  // follow-up process doesn't independently re-allow the full 24/480s.
  const priorSessions = results.length;
  const priorSeconds = results.reduce((acc, r) => acc + (r.sessionDurationSecondsFromServer ?? r.wallClockSessionMs / 1000), 0);
  budget.sessionsRun = priorSessions;
  budget.wallSecondsUsed = priorSeconds;
  console.log(`Resuming budget: ${priorSessions} sessions / ${priorSeconds.toFixed(1)}s already spent.`);

  console.log(`\nSTAGE 2 (follow-up): A/B turn_detection configs against primary clip=${primaryClipKey}`);
  const stage2Configs = ['vad_030', 'vad_020', 'min_silence_1500'];
  const configCutCounts: Record<string, { cuts: number; total: number }> = {};
  for (const presetKey of stage2Configs) {
    configCutCounts[presetKey] = { cuts: 0, total: 0 };
    for (let i = 1; i <= 3; i++) {
      if (budgetExceeded(budget)) break;
      const r = await runAndRecord(primaryClipKey, presetKey, i, budget, results);
      configCutCounts[presetKey]!.total += 1;
      if (r.classification === 'CUT') configCutCounts[presetKey]!.cuts += 1;
      if (r.errorClass === 'auth' || r.errorClass === 'rate_limit' || r.errorClass === 'server') {
        console.error(`STOPPING: ${r.errorClass} error on ${presetKey} run ${i}: ${r.error}`);
        return finalize(results, budget, 'stopped early on auth/rate-limit/server error (follow-up)');
      }
    }
    if (budgetExceeded(budget)) break;
  }

  let bestPreset = stage2Configs[0]!;
  let bestCutRate = Infinity;
  for (const presetKey of stage2Configs) {
    const c = configCutCounts[presetKey];
    if (!c || c.total === 0) continue;
    const rate = c.cuts / c.total;
    if (rate < bestCutRate) {
      bestCutRate = rate;
      bestPreset = presetKey;
    }
  }
  console.log(`\nBest config: ${bestPreset} (cut rate ${bestCutRate === Infinity ? 'n/a' : bestCutRate})`);
  console.log(JSON.stringify(configCutCounts, null, 2));

  if (!budgetExceeded(budget)) {
    console.log(`Running best config (${bestPreset}) once on secondary clip (${secondaryClipKey})`);
    await runAndRecord(secondaryClipKey, bestPreset, 1, budget, results);
  }

  console.log('\nSTAGE 3: clean-turn check (best config, dana-clean clip)');
  if (!budgetExceeded(budget)) {
    const r = await runAndRecord('dana-clean', bestPreset, 1, budget, results);
    const naturalEnd = CLIPS['dana-clean']!.naturalEndRelMs!;
    if (r.firstSpeechStoppedMs !== null) {
      console.log(`Clean-turn stop latency: speech.stopped fired at ${r.firstSpeechStoppedMs}ms vs natural end ~${naturalEnd}ms (delta ${r.firstSpeechStoppedMs - naturalEnd}ms).`);
    } else {
      console.log('Clean-turn check: speech.stopped never fired within the clip + linger window.');
    }
  }

  return finalize(results, budget, 'completed follow-up A/B matrix');
}

// ---------------------------------------------------------------------------
// Coordinator follow-up (2026-09-25): "does one short first turn warm up the session so a
// long turn right after it isn't cut?" Two turns in the SAME session/socket: turn 1 = the
// short 'dana-warmup' clip; turn 2 = the full 'dana-restated' clip (the one PROVEN CUT 11/11
// as a fresh session's first turn, across baseline/vad_030/vad_020/min_silence_1500). New,
// separate budget per the coordinator's message: at most 10 sessions, 3 live minutes (180s).
export interface WarmupResult {
  ts: string;
  runIndex: number;
  turn1SpeechStartedMs: number | null;
  turn1SpeechStoppedMs: number | null;
  turn1Transcript: string | null;
  turn1ReplyDone: boolean;
  turn2SpeechStartedMs: number | null;
  turn2SpeechStoppedMs: number | null;
  turn2Transcript: string | null;
  turn2Classification: 'CUT' | 'WHOLE' | 'NO_STOP_EVENT';
  sessionDurationSecondsFromServer: number | null;
  wallClockSessionMs: number;
  error: string | null;
  errorClass: RunResult['errorClass'];
}

async function runWarmupSession(runIndex: number): Promise<WarmupResult> {
  const warmupClip = CLIPS['dana-warmup']!;
  const mainClip = CLIPS['dana-restated']!;
  const wallStart = Date.now();
  let sessionDurationSecondsFromServer: number | null = null;

  let token: string;
  try {
    token = await mintToken(60);
  } catch (err) {
    const status = (err as { httpStatus?: number }).httpStatus;
    return {
      ts: new Date().toISOString(), runIndex,
      turn1SpeechStartedMs: null, turn1SpeechStoppedMs: null, turn1Transcript: null, turn1ReplyDone: false,
      turn2SpeechStartedMs: null, turn2SpeechStoppedMs: null, turn2Transcript: null, turn2Classification: 'NO_STOP_EVENT',
      sessionDurationSecondsFromServer, wallClockSessionMs: Date.now() - wallStart,
      error: String(err), errorClass: classifyError(status),
    };
  }

  return new Promise<WarmupResult>((resolvePromise) => {
    const ws = new WebSocket(`${WS_URL}?token=${token}`);
    let phase: 'turn1' | 'waiting' | 'turn2' = 'turn1';
    let t0: number | null = null;
    let closed = false;
    let sessionEndSent = false;
    let waitTimer: NodeJS.Timeout | null = null;

    let turn1SpeechStartedMs: number | null = null;
    let turn1SpeechStoppedMs: number | null = null;
    let turn1Transcript: string | null = null;
    let turn1ReplyDone = false;
    let turn2SpeechStartedMs: number | null = null;
    let turn2SpeechStoppedMs: number | null = null;
    let turn2Transcript: string | null = null;

    const readyTimer = setTimeout(() => {
      try { ws.terminate(); } catch { /* ignore */ }
      finish('timed out waiting for session.ready');
    }, READY_TIMEOUT_MS);

    function log(type: string, detail?: string) {
      const tMs = t0 === null ? -1 : Date.now() - t0;
      console.log(`  [${phase} t=${tMs >= 0 ? tMs : 'pre'}ms] ${type}${detail ? ' ' + detail : ''}`);
    }

    function finish(error: string | null, errorClass: RunResult['errorClass'] = 'none') {
      if (closed) return;
      closed = true;
      const classification: WarmupResult['turn2Classification'] =
        turn2SpeechStoppedMs === null
          ? 'NO_STOP_EVENT'
          : turn2SpeechStoppedMs < (mainClip.continuationEndRelMs ?? Infinity)
            ? 'CUT'
            : 'WHOLE';
      resolvePromise({
        ts: new Date().toISOString(), runIndex,
        turn1SpeechStartedMs, turn1SpeechStoppedMs, turn1Transcript, turn1ReplyDone,
        turn2SpeechStartedMs, turn2SpeechStoppedMs, turn2Transcript, turn2Classification: classification,
        sessionDurationSecondsFromServer, wallClockSessionMs: Date.now() - wallStart,
        error, errorClass,
      });
    }

    async function streamClip(file: string, onDone?: () => void) {
      const pcm = readFileSync(file);
      const totalChunks = Math.ceil(pcm.length / CHUNK_BYTES);
      t0 = Date.now();
      const scheduleStart = t0;
      for (let i = 0; i < totalChunks; i++) {
        if (closed) return;
        const chunk = pcm.subarray(i * CHUNK_BYTES, Math.min((i + 1) * CHUNK_BYTES, pcm.length));
        try {
          ws.send(JSON.stringify({ type: 'input.audio', audio: chunk.toString('base64') }));
        } catch {
          return;
        }
        const targetTime = scheduleStart + (i + 1) * CHUNK_MS;
        const waitMs = targetTime - Date.now();
        if (waitMs > 0) await sleep(waitMs);
      }
      log('audio.stream.end');
      onDone?.();
    }

    function beginTurn2() {
      if (closed || phase === 'turn2') return;
      phase = 'turn2';
      log('turn2.begin');
      void streamClip(mainClip.file, async () => {
        // If speech.stopped for turn 2 never fires, end at clip end + POST_CLIP_LINGER_MS.
        await sleep(POST_CLIP_LINGER_MS);
        if (!closed && turn2SpeechStoppedMs === null) endSession();
      });
    }

    function endSession() {
      if (sessionEndSent || closed) return;
      sessionEndSent = true;
      try {
        ws.send(JSON.stringify({ type: 'session.end' }));
      } catch {
        finish(null);
        return;
      }
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        finish(null);
      }, CLOSE_WAIT_MS);
      (ws as unknown as { __endTimer?: NodeJS.Timeout }).__endTimer = timer;
    }

    ws.on('open', () => {
      const input: Record<string, unknown> = {
        format: { encoding: 'audio/pcm', sample_rate: SAMPLE_RATE },
        keyterms: ['Meridian Supply', 'Northgate Partners', 'Marcus Obi', 'Dana Whitfield', 'Robert Miller', 'Hartwell', 'Whitmore & Bass', 'Calder & Finch'], // live BRAIN_KEYTERMS, packages/server/src/aai/config.ts
        transcription_mode: 'max_accuracy',
        // baseline: no turn_detection key at all -- matches the live config's mode ('omit')
      };
      ws.send(JSON.stringify({
        type: 'session.update',
        session: {
          system_prompt: 'You are a neutral test line for an audio pipeline check. Keep replies to one short sentence.',
          input,
          output: { voice: 'anna', format: { encoding: 'audio/pcm', sample_rate: SAMPLE_RATE } },
          tools: [],
        },
      }));
    });

    ws.on('message', (data: WebSocket.RawData) => {
      let msg: Record<string, unknown> | null = null;
      try {
        msg = JSON.parse(typeof data === 'string' ? data : data.toString());
      } catch {
        return;
      }
      if (!msg) return;
      const type = String(msg.type ?? 'unknown');

      if (type === 'session.ready') {
        clearTimeout(readyTimer);
        log('session.ready');
        phase = 'turn1';
        void streamClip(warmupClip.file);
        return;
      }
      if (type === 'session.error') {
        clearTimeout(readyTimer);
        log('session.error', JSON.stringify(msg).slice(0, 200));
        try { ws.close(); } catch { /* ignore */ }
        finish(`session.error: ${String(msg.code)} ${String(msg.message)}`, 'other');
        return;
      }
      if (type === 'input.speech.started') {
        if (phase === 'turn1' && turn1SpeechStartedMs === null && t0 !== null) turn1SpeechStartedMs = Date.now() - t0;
        if (phase === 'turn2' && turn2SpeechStartedMs === null && t0 !== null) turn2SpeechStartedMs = Date.now() - t0;
        log('input.speech.started');
        return;
      }
      if (type === 'input.speech.stopped') {
        if (phase === 'turn1' && turn1SpeechStoppedMs === null) {
          turn1SpeechStoppedMs = t0 !== null ? Date.now() - t0 : null;
          log('input.speech.stopped (turn1)');
          // Wait for the agent's reply to finish (reply.done), or 3s, whichever first.
          phase = 'waiting';
          waitTimer = setTimeout(() => {
            waitTimer = null;
            beginTurn2();
          }, 3000);
        } else if (phase === 'turn2' && turn2SpeechStoppedMs === null) {
          turn2SpeechStoppedMs = t0 !== null ? Date.now() - t0 : null;
          log('input.speech.stopped (turn2, first)');
          setTimeout(() => {
            if (!closed) endSession();
          }, POST_STOP_LINGER_MS);
        }
        return;
      }
      if (type === 'transcript.user') {
        const text = String(msg.text ?? '');
        if (phase === 'turn1' || phase === 'waiting') { if (turn1Transcript === null) turn1Transcript = text; }
        else if (phase === 'turn2') { if (turn2Transcript === null) turn2Transcript = text; }
        log('transcript.user', JSON.stringify(text));
        return;
      }
      if (type === 'reply.done') {
        if (phase === 'waiting') {
          turn1ReplyDone = true;
          log('reply.done (turn1)');
          if (waitTimer) {
            clearTimeout(waitTimer);
            waitTimer = null;
          }
          beginTurn2();
        }
        return;
      }
      if (type === 'session.ended') {
        if (typeof msg.session_duration_seconds === 'number') sessionDurationSecondsFromServer = msg.session_duration_seconds;
        log('session.ended', JSON.stringify({ session_duration_seconds: msg.session_duration_seconds }));
        const timer = (ws as unknown as { __endTimer?: NodeJS.Timeout }).__endTimer;
        if (timer) clearTimeout(timer);
        try { ws.close(); } catch { /* ignore */ }
        finish(null);
        return;
      }
      // routine/unmodelled types: ignore quietly (transcript.agent, reply.started,
      // reply.audio, session.updated, *.delta) -- this experiment only cares about the
      // fields above.
    });

    ws.on('close', (code: number, reason: Buffer) => {
      if (!closed) {
        log('ws.close', `code=${code} reason=${reason?.toString().slice(0, 100)}`);
        finish('socket closed unexpectedly');
      }
    });

    ws.on('error', (err: Error) => {
      log('ws.error', String(err));
      finish(String(err), classifyError(undefined));
    });
  });
}

async function runWarmupExperiment() {
  console.log('WARM-UP EXPERIMENT (coordinator follow-up 2026-09-25): does a short first turn warm up adaptation before the long turn 11/11 CUT before?');
  console.log('Caps for this experiment: <=10 sessions, <=180s live time.');
  const warmupResults: WarmupResult[] = [];
  const controlResults: RunResult[] = [];
  let sessionsRun = 0;
  let secondsUsed = 0;
  const maxSessions = 10;
  const maxSeconds = 180;

  console.log('\n=== DESIGN: 2-turn sessions (warm-up turn, then the long turn) x3 ===');
  for (let i = 1; i <= 3; i++) {
    if (sessionsRun >= maxSessions || secondsUsed >= maxSeconds) break;
    console.log(`\n--- warmup-design run ${i} ---`);
    const r = await runWarmupSession(i);
    sessionsRun += 1;
    secondsUsed += r.sessionDurationSecondsFromServer ?? r.wallClockSessionMs / 1000;
    warmupResults.push(r);
    console.log(`RESULT design run=${i} turn1.stopped=${r.turn1SpeechStoppedMs ?? 'none'}ms turn1.transcript=${JSON.stringify(r.turn1Transcript)} turn1.replyDone=${r.turn1ReplyDone} | turn2.stopped=${r.turn2SpeechStoppedMs ?? 'none'}ms turn2.transcript=${JSON.stringify(r.turn2Transcript)} turn2.classification=${r.turn2Classification} error=${r.error ?? 'none'}`);
    writeFileSync(resolve(RESULTS_DIR, 'warmup-results.json'), JSON.stringify({ design: warmupResults, control: controlResults }, null, 2));
    if (r.errorClass === 'auth' || r.errorClass === 'rate_limit' || r.errorClass === 'server') {
      console.error(`STOPPING: ${r.errorClass} error: ${r.error}`);
      return reportWarmup(warmupResults, controlResults, sessionsRun, secondsUsed, 'stopped early on error');
    }
  }

  console.log('\n=== CONTROL: dana-restated alone as first turn, WITH keyterms (x2) ===');
  const controlBudget: Budget = { maxSessions: 999, maxLiveSeconds: 999999, sessionsRun: 0, wallSecondsUsed: 0 };
  for (let i = 1; i <= 2; i++) {
    if (sessionsRun >= maxSessions || secondsUsed >= maxSeconds) break;
    console.log(`\n--- control run ${i} ---`);
    const r = await runOneSession(CLIPS['dana-restated']!, PRESETS.baseline!, i);
    sessionsRun += 1;
    secondsUsed += r.sessionDurationSecondsFromServer ?? r.wallClockSessionMs / 1000;
    controlResults.push(r);
    controlBudget.sessionsRun += 1;
    console.log(`RESULT control run=${i} speech.stopped=${r.firstSpeechStoppedMs ?? 'none'}ms transcript=${JSON.stringify(r.firstTranscriptText)} classification=${r.classification} error=${r.error ?? 'none'}`);
    writeFileSync(resolve(RESULTS_DIR, 'warmup-results.json'), JSON.stringify({ design: warmupResults, control: controlResults }, null, 2));
    if (r.errorClass === 'auth' || r.errorClass === 'rate_limit' || r.errorClass === 'server') {
      console.error(`STOPPING: ${r.errorClass} error: ${r.error}`);
      break;
    }
  }

  return reportWarmup(warmupResults, controlResults, sessionsRun, secondsUsed, 'completed');
}

function reportWarmup(design: WarmupResult[], control: RunResult[], sessionsRun: number, secondsUsed: number, note: string) {
  writeFileSync(resolve(RESULTS_DIR, 'warmup-results.json'), JSON.stringify({ design, control }, null, 2));
  const designCuts = design.filter((r) => r.turn2Classification === 'CUT').length;
  const designWhole = design.filter((r) => r.turn2Classification === 'WHOLE').length;
  const controlCuts = control.filter((r) => r.classification === 'CUT').length;
  console.log(`\n=== DONE (${note}) ===`);
  console.log(`Design (warm-up then long turn): turn2 CUT ${designCuts}/${design.length}, WHOLE ${designWhole}/${design.length}.`);
  console.log(`Control (long turn alone, with keyterms): CUT ${controlCuts}/${control.length}.`);
  console.log(`Sessions run: ${sessionsRun}. PROVEN seconds used (server-reported where available): ${secondsUsed.toFixed(1)}s.`);
  console.log(`Estimated cost at $4.50/hour: $${(secondsUsed / 3600 * 4.5).toFixed(2)}`);
}

async function smokeTest() {
  console.log('SMOKE TEST: one session, dana clip, baseline config -- verifying the wire protocol before spending the full matrix budget.');
  const results: RunResult[] = [];
  const budget: Budget = { maxSessions: 24, maxLiveSeconds: 8 * 60, sessionsRun: 0, wallSecondsUsed: 0 };
  const r = await runAndRecord('dana', 'baseline', 0, budget, results);
  writeFileSync(resolve(RESULTS_DIR, 'smoke-result.json'), JSON.stringify(r, null, 2));
  if (r.error) {
    console.error(`SMOKE TEST FAILED: ${r.error}`);
    process.exit(1);
  }
  console.log('SMOKE TEST OK.');
}

if (process.env.SPIKE_SMOKE_ONLY === '1') {
  smokeTest().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  });
} else if (process.env.SPIKE_STAGE2_CLIP) {
  stage2Followup(process.env.SPIKE_STAGE2_CLIP, process.env.SPIKE_STAGE2_SECONDARY ?? 'dana').catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  });
} else if (process.env.SPIKE_WARMUP === '1') {
  runWarmupExperiment().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  });
} else {
  main().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  });
}
