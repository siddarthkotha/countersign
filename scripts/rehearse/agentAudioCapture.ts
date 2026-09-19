// scripts/rehearse/agentAudioCapture.ts
// Captures every agent audio frame the rehearsal harness receives over the WebSocket into an
// in-memory PCM buffer plus a frame index (arrival time -> byte range) -- closes the gap named
// on the board 2026-09-19 (GAP: THE HARNESS RECORDS TRANSCRIPTS, NOT AUDIO): today's report for
// scripts/rehearse/reports/2026-09-19T14-00-06-miller-patient.diagnostics.json shows one
// goodbye reply (resp_831571c5) spanning 45909 to 63174 ms with reply.audio.summary total_bytes
// 831,840 (17.3s of audio) while its transcript is the 86-character close line (about 7.5s of
// speech) -- and nobody could say whether the caller heard ten seconds of a stale line that was
// never transcribed or ten seconds of silence, because the harness caller reacts to transcripts,
// not audio, so it cannot tell either.
//
// Server relays AssemblyAI's agent audio as 24 kHz mono PCM16, base64-encoded, one ServerEvent
// per frame -- PROVEN: packages/engine/src/types.ts:520 (`{type:'audio', data: string}`) and
// packages/server/src/call/session.ts's `OUTPUT_AUDIO_BYTES_PER_SECOND = 48_000` (24000 Hz * 2
// bytes/sample * 1 channel, which is exactly `AGENT_AUDIO_BYTES_PER_SECOND` below).
//
// This module only accumulates and indexes those bytes -- it computes no verdict and asserts
// nothing about detection (LAW 1). It is disclosed test-harness code only
// (docs/REHEARSAL-HARNESS.md), same discipline audio.ts documents for the caller-synthesis side.

export const AGENT_AUDIO_SAMPLE_RATE = 24_000;
/** PROVEN: packages/server/src/call/session.ts's `OUTPUT_AUDIO_BYTES_PER_SECOND`. 24 kHz mono
 *  16-bit PCM = 24000 * 2 bytes/sample * 1 channel. */
export const AGENT_AUDIO_BYTES_PER_SECOND = AGENT_AUDIO_SAMPLE_RATE * 2;

/** Default cap: 20 MB, per the task's own bound ("a 3-minute call is under 9 MB; cap at 20 MB
 *  and note truncation"). At AGENT_AUDIO_BYTES_PER_SECOND (48,000 B/s) this is ~7.3 minutes of
 *  continuous agent audio -- generously past any single rehearsal scenario's `max_wall_ms`. */
export const DEFAULT_MAX_CAPTURE_BYTES = 20 * 1024 * 1024;

/** One received agent audio frame: its harness-clock arrival time (`t_ms`, the SAME base as
 *  every other `t_ms` this harness records -- `performance.now() - client.startedAt`, per
 *  wsClient.ts's own message handler) and where its bytes live in the capture's concatenated
 *  PCM buffer. */
export interface AgentAudioFrame {
  t_ms: number;
  byte_offset: number;
  byte_length: number;
}

export interface AgentAudioCaptureSnapshot {
  /** Concatenated raw PCM16LE mono 24 kHz bytes, in arrival order, truncated at the capture's
   *  byte cap -- see `truncated`. */
  pcm: Buffer;
  frames: AgentAudioFrame[];
  /** True once the byte cap was hit and further frames were dropped (both from `pcm` and from
   *  `frames`) -- `total_bytes_received` still counts everything that arrived, capped or not,
   *  so a report can say plainly how much was thrown away. */
  truncated: boolean;
  total_bytes_received: number;
}

export interface AgentAudioCapture {
  /** Records one received frame's raw bytes at the given harness-clock `t_ms`. A no-op (for
   *  `pcm`/`frames`) once the byte cap has been reached -- `total_bytes_received` keeps
   *  counting regardless, so truncation is provable, not silent. */
  push(t_ms: number, bytes: Buffer): void;
  snapshot(): AgentAudioCaptureSnapshot;
}

export function createAgentAudioCapture(maxBytes: number = DEFAULT_MAX_CAPTURE_BYTES): AgentAudioCapture {
  const chunks: Buffer[] = [];
  const frames: AgentAudioFrame[] = [];
  let bytesStored = 0;
  let totalBytesReceived = 0;
  let truncated = false;

  return {
    push(t_ms: number, bytes: Buffer): void {
      totalBytesReceived += bytes.length;
      if (truncated) return;
      if (bytesStored + bytes.length > maxBytes) {
        truncated = true;
        return;
      }
      frames.push({ t_ms, byte_offset: bytesStored, byte_length: bytes.length });
      chunks.push(bytes);
      bytesStored += bytes.length;
    },
    snapshot(): AgentAudioCaptureSnapshot {
      return {
        pcm: Buffer.concat(chunks, bytesStored),
        frames: [...frames],
        truncated,
        total_bytes_received: totalBytesReceived,
      };
    },
  };
}
