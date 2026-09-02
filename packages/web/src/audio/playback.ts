// packages/web/src/audio/playback.ts
// Flushable playback queue (BRIEF engineering law a: barge-in is won in the CLIENT audio
// buffer). Base64 PCM16 24 kHz chunks come in from the server; each is decoded into an
// AudioBuffer and scheduled back-to-back on one AudioContext. flush() is the barge-in
// mechanism: it synchronously stops every scheduled source and clears the queue within one
// frame, so nothing already scheduled keeps playing after a caller interrupts. This module
// computes nothing about verdicts -- it only reshapes and schedules audio.
export interface PlaybackHandle {
  /** Schedule one base64-encoded PCM16 24 kHz chunk to play after whatever is already
   *  queued. */
  push(base64: string): void;
  /** Stop every scheduled source immediately and clear the queue. This IS the barge-in
   *  mechanism: called the instant the server signals a `flush` ServerEvent. */
  flush(): void;
  /** 0..1 peak amplitude of the most recently pushed chunk, for a trace/level meter. */
  level(): number;
  close(): void;
}

const SAMPLE_RATE = 24000;

function base64ToInt16(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // Copy into a fresh, aligned buffer -- `bytes.buffer` may be offset/shared and Int16Array
  // requires an even byte length starting at an aligned offset.
  return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
}

export function createPlayback(context: AudioContext): PlaybackHandle {
  let nextStartTime = 0;
  const scheduled: AudioBufferSourceNode[] = [];
  let currentLevel = 0;

  function scheduleChunk(pcm: Int16Array): void {
    const buffer = context.createBuffer(1, pcm.length, SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) {
      const v = (pcm[i] ?? 0) / 0x8000;
      channel[i] = v;
      const abs = Math.abs(v);
      if (abs > peak) peak = abs;
    }
    currentLevel = peak;

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);

    const startAt = Math.max(context.currentTime, nextStartTime);
    source.start(startAt);
    nextStartTime = startAt + buffer.duration;
    scheduled.push(source);

    source.onended = () => {
      const idx = scheduled.indexOf(source);
      if (idx !== -1) scheduled.splice(idx, 1);
    };
  }

  return {
    push(base64: string) {
      scheduleChunk(base64ToInt16(base64));
    },
    flush() {
      const toStop = scheduled.splice(0, scheduled.length);
      for (const source of toStop) {
        source.onended = null;
        try {
          source.stop();
        } catch {
          // Already stopped/ended before flush ran -- nothing left to do.
        }
      }
      nextStartTime = context.currentTime;
      currentLevel = 0;
    },
    level() {
      return currentLevel;
    },
    close() {
      this.flush();
    },
  };
}
