import { describe, it, expect } from 'vitest';
import { computeRmsAndPeak } from '../src/audio/capture';

describe('computeRmsAndPeak', () => {
  it('returns 0 RMS and 0 peak for silent buffer', () => {
    // Create a silent buffer (all zeros) - 100 PCM16 samples = 200 bytes
    const buffer = new ArrayBuffer(200);
    const view = new Uint8Array(buffer);
    // All zeros by default

    const result = computeRmsAndPeak(buffer);
    expect(result.rms).toBe(0);
    expect(result.peak).toBe(0);
  });

  it('returns RMS of 1 and peak of 1 for full-scale square wave', () => {
    // Full-scale PCM16 square wave: alternating between +32767 and -32767
    const samples = [];
    for (let i = 0; i < 100; i++) {
      samples.push(i % 2 === 0 ? 32767 : -32767);
    }
    const buffer = new ArrayBuffer(samples.length * 2);
    const view = new Int16Array(buffer);
    for (let i = 0; i < samples.length; i++) {
      view[i] = samples[i] as number;
    }

    const result = computeRmsAndPeak(buffer);
    // Full-scale square wave should have RMS ≈ 1.0 (all samples are at ±full scale)
    expect(result.rms).toBe(1);
    expect(result.peak).toBe(1);
  });

  it('returns RMS of approximately 0.3536 for half-scale sine wave', () => {
    // Sine wave at half amplitude: amplitude = 0.5 * 32768 ≈ 16384
    // RMS of a sine wave is amplitude / sqrt(2) ≈ 0.7071 * amplitude
    // So half-scale sine has RMS ≈ 0.5 / sqrt(2) ≈ 0.3536
    const samples = [];
    const amplitude = 16384; // Half of 32768
    for (let i = 0; i < 100; i++) {
      const angle = (i / 100) * 2 * Math.PI;
      samples.push(Math.round(amplitude * Math.sin(angle)));
    }
    const buffer = new ArrayBuffer(samples.length * 2);
    const view = new Int16Array(buffer);
    for (let i = 0; i < samples.length; i++) {
      view[i] = samples[i] as number;
    }

    const result = computeRmsAndPeak(buffer);
    // Half-scale sine RMS should be approximately 0.3536
    expect(result.rms).toBeCloseTo(0.3536, 2);
    // Peak should be close to 0.5
    expect(result.peak).toBeCloseTo(0.5, 2);
  });

  it('handles Uint8Array input (raw PCM bytes)', () => {
    // Create a simple test pattern with Uint8Array
    const samples = [0, 32767, -32767, 16384];
    const buffer = new ArrayBuffer(samples.length * 2);
    const view = new Int16Array(buffer);
    for (let i = 0; i < samples.length; i++) {
      view[i] = samples[i] as number;
    }

    // Convert to Uint8Array (simulate raw bytes)
    const uint8View = new Uint8Array(buffer);
    const result = computeRmsAndPeak(uint8View);

    // Should return valid RMS and peak values
    expect(result.rms).toBeGreaterThan(0);
    expect(result.peak).toBeGreaterThan(0);
    expect(result.peak).toBeLessThanOrEqual(1);
  });

  it('handles odd-length buffers gracefully (ignores incomplete sample)', () => {
    // Create a buffer with an odd number of bytes
    const buffer = new ArrayBuffer(201); // 200 bytes + 1 extra
    const view = new Uint8Array(buffer);
    // Fill with pattern
    for (let i = 0; i < 200; i += 2) {
      view[i] = 0x00;
      view[i + 1] = 0x80; // This creates samples with value 0x8000 (−32768)
    }

    const result = computeRmsAndPeak(buffer);
    // Should process the first 200 bytes, ignore the final odd byte
    expect(result.rms).toBeGreaterThan(0);
  });

  it('rounds RMS and peak to 4 decimals', () => {
    // Create a buffer with a value that would have many decimal places
    const samples = [1000, 2000, 3000];
    const buffer = new ArrayBuffer(samples.length * 2);
    const view = new Int16Array(buffer);
    for (let i = 0; i < samples.length; i++) {
      view[i] = samples[i] as number;
    }

    const result = computeRmsAndPeak(buffer);
    // Check that values are rounded to 4 decimals (max 4 digits after decimal)
    const rmsStr = result.rms.toString();
    const peakStr = result.peak.toString();
    const rmsDecimals = rmsStr.includes('.') ? rmsStr.split('.')[1]!.length : 0;
    const peakDecimals = peakStr.includes('.') ? peakStr.split('.')[1]!.length : 0;
    expect(rmsDecimals).toBeLessThanOrEqual(4);
    expect(peakDecimals).toBeLessThanOrEqual(4);
  });

  it('handles empty buffer', () => {
    const buffer = new ArrayBuffer(0);
    const result = computeRmsAndPeak(buffer);
    expect(result.rms).toBe(0);
    expect(result.peak).toBe(0);
  });

  it('handles single sample', () => {
    const buffer = new ArrayBuffer(2);
    const view = new Int16Array(buffer);
    view[0] = 16384; // Half scale
    const result = computeRmsAndPeak(buffer);
    expect(result.rms).toBeCloseTo(0.5, 2);
    expect(result.peak).toBeCloseTo(0.5, 2);
  });
});
