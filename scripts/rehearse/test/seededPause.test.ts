// Exercises the seeded pause generator (freePlay.ts's "spec item 1b": random pauses drawn
// uniformly from [pause_min_ms, pause_max_ms], seeded by --seed for reproducibility) with no
// network and no real timers involved -- purely the arithmetic in seededPause.ts.
import { describe, expect, it } from 'vitest';
import { createSeededPauseGenerator, deriveRunSeed, DEFAULT_PAUSE_MAX_MS, DEFAULT_PAUSE_MIN_MS, mulberry32 } from '../seededPause.js';

describe('mulberry32', () => {
  it('is deterministic: the same seed always produces the same sequence', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = [a(), a(), a(), a()];
    const seqB = [b(), b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });

  it('produces a different sequence for a different seed', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect([a(), a(), a()]).not.toEqual([b(), b(), b()]);
  });

  it('always yields values in [0, 1)', () => {
    const rand = mulberry32(7);
    for (let i = 0; i < 200; i++) {
      const v = rand();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('createSeededPauseGenerator', () => {
  it('draws pauses within [minMs, maxMs] inclusive-ish (rounded)', () => {
    const gen = createSeededPauseGenerator(1, 600, 6000);
    for (let i = 0; i < 50; i++) {
      const ms = gen.next();
      expect(ms).toBeGreaterThanOrEqual(600);
      expect(ms).toBeLessThanOrEqual(6000);
      expect(Number.isInteger(ms)).toBe(true);
    }
  });

  it('uses the default 600-6000ms range when minMs/maxMs are omitted', () => {
    const gen = createSeededPauseGenerator(5);
    const ms = gen.next();
    expect(ms).toBeGreaterThanOrEqual(DEFAULT_PAUSE_MIN_MS);
    expect(ms).toBeLessThanOrEqual(DEFAULT_PAUSE_MAX_MS);
  });

  it('is fully reproducible: the same seed and range produce the exact same pause sequence', () => {
    const genA = createSeededPauseGenerator(99, 1000, 2000);
    const genB = createSeededPauseGenerator(99, 1000, 2000);
    const seqA = [genA.next(), genA.next(), genA.next()];
    const seqB = [genB.next(), genB.next(), genB.next()];
    expect(seqA).toEqual(seqB);
  });

  it('records every draw, in order, on .sequence', () => {
    const gen = createSeededPauseGenerator(3, 100, 200);
    const one = gen.next();
    const two = gen.next();
    expect(gen.sequence).toEqual([one, two]);
  });

  it('throws when minMs > maxMs', () => {
    expect(() => createSeededPauseGenerator(1, 5000, 1000)).toThrow(/minMs/);
  });

  it('a single-point range (minMs === maxMs) always returns exactly that value', () => {
    const gen = createSeededPauseGenerator(1, 3000, 3000);
    expect(gen.next()).toBe(3000);
    expect(gen.next()).toBe(3000);
  });
});

describe('deriveRunSeed', () => {
  it('is a pure, deterministic function of (baseSeed, caseIndex, runIndex)', () => {
    expect(deriveRunSeed(42, 0, 0)).toBe(deriveRunSeed(42, 0, 0));
  });

  it('gives different case indices different seeds', () => {
    expect(deriveRunSeed(42, 0, 0)).not.toBe(deriveRunSeed(42, 1, 0));
  });

  it('gives different run indices (same case) different seeds', () => {
    expect(deriveRunSeed(42, 0, 0)).not.toBe(deriveRunSeed(42, 0, 1));
  });

  it('always returns a non-negative 32-bit integer', () => {
    const seed = deriveRunSeed(4294967295, 9, 9);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(seed)).toBe(true);
  });
});
