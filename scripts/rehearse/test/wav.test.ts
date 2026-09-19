// scripts/rehearse/test/wav.test.ts
// Proves buildWavFile produces a valid, standard 24 kHz mono 16-bit RIFF/WAVE header, and that
// readWavFile round-trips it back to the exact PCM bytes and format fields -- no dependency,
// hand-written header, no live server or network involved.
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWavFile, readWavFile, writeWavFile } from '../wav.js';

describe('buildWavFile', () => {
  it('writes a 44-byte canonical header followed by the exact PCM bytes', () => {
    const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]); // 4 int16 samples
    const wav = buildWavFile(pcm, 24_000, 1, 16);

    expect(wav.length).toBe(44 + pcm.length);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length);
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ');
    expect(wav.readUInt32LE(16)).toBe(16);
    expect(wav.readUInt16LE(20)).toBe(1); // PCM format code
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(24_000); // sample rate
    expect(wav.readUInt32LE(28)).toBe(24_000 * 2); // byte rate (mono, 16-bit)
    expect(wav.readUInt16LE(32)).toBe(2); // block align
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    expect(wav.toString('ascii', 36, 40)).toBe('data');
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    expect(wav.subarray(44)).toEqual(pcm);
  });

  it('readWavFile recovers the exact PCM bytes and format fields buildWavFile wrote', () => {
    const pcm = Buffer.from(Array.from({ length: 200 }, (_, i) => i % 256));
    const wav = buildWavFile(pcm, 24_000, 1, 16);
    const info = readWavFile(wav);

    expect(info.sampleRate).toBe(24_000);
    expect(info.numChannels).toBe(1);
    expect(info.bitsPerSample).toBe(16);
    expect(info.pcm).toEqual(pcm);
  });

  it('readWavFile throws on a non-RIFF buffer', () => {
    expect(() => readWavFile(Buffer.from('not a wav file at all'))).toThrow();
  });

  it('writeWavFile writes a file that readWavFile can read back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rehearse-wav-'));
    const path = join(dir, 'test.wav');
    const pcm = Buffer.from([9, 9, 8, 8, 7, 7]);
    await writeWavFile(path, pcm, 24_000);

    const onDisk = await readFile(path);
    const info = readWavFile(onDisk);
    expect(info.pcm).toEqual(pcm);
    expect(info.sampleRate).toBe(24_000);
  });

  it('handles empty PCM (a call that captured zero audio bytes)', () => {
    const wav = buildWavFile(Buffer.alloc(0), 24_000, 1, 16);
    const info = readWavFile(wav);
    expect(info.pcm.length).toBe(0);
  });
});
