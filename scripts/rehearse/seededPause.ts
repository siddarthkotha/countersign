// scripts/rehearse/seededPause.ts
// Free-play addition (2026-09-14, founder's definition of done: a judge speaking in their
// own words, with real pauses, must be understood). Free-play mode inserts a random pause
// before each improvised caller line instead of a fixed pause_ms -- but "random" would make a
// failing run impossible to reproduce, so every pause is drawn from a seeded PRNG
// (mulberry32, a small, dependency-free, deterministic generator -- this is a test harness,
// BRIEF LAW 5, not product code, so a tiny hand-rolled PRNG is the right amount of machinery)
// instead of Math.random(). Given the same seed, the same scenario, and the same number of
// turns, the exact sequence of pauses is reproducible -- the report records both the seed and
// the sequence it produced (report.ts's free-play section) so a run can be replayed by eye
// even though the LLM caller's own WORDS will still vary run to run.
//
// This file is pure and has no network/filesystem dependency at all.

/** A small, fast, deterministic PRNG (mulberry32) seeded by a single 32-bit integer -- good
 *  enough statistical quality for "vary the pause a human tester would take", not intended
 *  for anything cryptographic. Returns a function that yields floats in [0, 1) on each call,
 *  advancing its own internal state -- the same `seed` always produces the same infinite
 *  sequence of outputs in the same order. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DEFAULT_PAUSE_MIN_MS = 600;
export const DEFAULT_PAUSE_MAX_MS = 6000;

export interface SeededPauseGenerator {
  /** Draws the next pause (ms, rounded to the nearest whole ms) from the uniform range
   *  [minMs, maxMs], appending it to `sequence` as a side effect -- call order is significant
   *  and is exactly what makes a run reproducible from its seed. */
  next(): number;
  /** Every pause drawn so far, in draw order -- what the report's "pause sequence" line
   *  prints verbatim. Never mutated except by `next()` appending. */
  readonly sequence: number[];
}

/** Builds one free-play run's pause generator. `minMs`/`maxMs` default to
 *  DEFAULT_PAUSE_MIN_MS/DEFAULT_PAUSE_MAX_MS (the harness-wide default per the founder's
 *  spec) -- a scenario's own `free_play.pause_min_ms`/`pause_max_ms` (types.ts) override
 *  these per call site, not here. Throws if minMs > maxMs (a scenario authoring mistake --
 *  same "fail loud on a bad range" discipline scenario.ts's own validation uses, not
 *  something a caller should have to defend against silently). */
export function createSeededPauseGenerator(
  seed: number,
  minMs: number = DEFAULT_PAUSE_MIN_MS,
  maxMs: number = DEFAULT_PAUSE_MAX_MS,
): SeededPauseGenerator {
  if (minMs > maxMs) {
    throw new Error(`createSeededPauseGenerator: minMs (${minMs}) must be <= maxMs (${maxMs})`);
  }
  const rand = mulberry32(seed);
  const sequence: number[] = [];
  return {
    next(): number {
      const ms = Math.round(minMs + rand() * (maxMs - minMs));
      sequence.push(ms);
      return ms;
    },
    sequence,
  };
}

/** Derives a fresh, still-deterministic seed for one (case, run) pair from a single base
 *  seed -- used by simFreeplay.ts so `--seed 42 --runs 3` gives every one of the 30 live
 *  calls (10 judge cases x 3 runs) its OWN distinct, reproducible pause sequence instead of
 *  all 30 replaying the identical sequence of pauses. Pure arithmetic, not another PRNG draw,
 *  so it stays trivially reproducible by hand from the three inputs. */
export function deriveRunSeed(baseSeed: number, caseIndex: number, runIndex: number): number {
  return (baseSeed + caseIndex * 1009 + runIndex * 7919) >>> 0;
}
