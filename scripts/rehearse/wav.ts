// scripts/rehearse/wav.ts
// Writes a valid 24 kHz mono 16-bit PCM RIFF/WAVE file from raw PCM bytes -- no new dependency,
// per the task brief ("write the header yourself, no new dependency"). Standard 44-byte
// canonical header (RIFF/WAVE/fmt /data), PCM format code 1. `pcmFromWavFile` is the reverse
// (used by audioTimeline.ts's offline re-analysis command to recover PCM from a `.agent.wav`
// this module wrote) -- it walks chunks generically rather than assuming the header is exactly
// 44 bytes, but it is not a general WAV parser: it only ever needs to read back what
// `buildWavFile` itself wrote.
import { writeFile } from 'node:fs/promises';

export function buildWavFile(pcm: Buffer, sampleRate: number, numChannels = 1, bitsPerSample = 16): Buffer {
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size (PCM)
  header.writeUInt16LE(1, 20); // audio format 1 = PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export async function writeWavFile(path: string, pcm: Buffer, sampleRate: number, numChannels = 1, bitsPerSample = 16): Promise<void> {
  await writeFile(path, buildWavFile(pcm, sampleRate, numChannels, bitsPerSample));
}

export interface WavInfo {
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
  pcm: Buffer;
}

/** Walks RIFF chunks (word-aligned, per the RIFF spec) to find `fmt ` and `data` -- generic
 *  enough to survive minor header variation, but only ever exercised against a file this
 *  module's own `buildWavFile` wrote. Throws on anything that isn't a RIFF/WAVE file, or that
 *  has no `data` chunk. */
export function readWavFile(wav: Buffer): WavInfo {
  if (wav.length < 12 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('readWavFile: not a RIFF/WAVE file');
  }
  let offset = 12;
  let sampleRate: number | null = null;
  let numChannels: number | null = null;
  let bitsPerSample: number | null = null;
  let pcm: Buffer | null = null;

  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString('ascii', offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (chunkId === 'fmt ') {
      numChannels = wav.readUInt16LE(dataStart + 2);
      sampleRate = wav.readUInt32LE(dataStart + 4);
      bitsPerSample = wav.readUInt16LE(dataStart + 14);
    } else if (chunkId === 'data') {
      pcm = wav.subarray(dataStart, dataStart + chunkSize);
    }
    offset = dataStart + chunkSize + (chunkSize % 2); // chunks are word-aligned
  }

  if (pcm === null) throw new Error('readWavFile: no data chunk found');
  return {
    sampleRate: sampleRate ?? 24_000,
    numChannels: numChannels ?? 1,
    bitsPerSample: bitsPerSample ?? 16,
    pcm,
  };
}
