/**
 * mulberry32 — small, fast, deterministic 32-bit PRNG.
 *
 * Same seed always produces the same stream. Used by simulate_tournament and
 * exposed for reproducible tests.
 */

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let state = seed | 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Derive a deterministic seed from a date string (YYYY-MM-DD).
 * Used so two runs on the same calendar date produce identical bulletins.
 */
export function seedFromDate(date: string): number {
  let h = 2166136261;
  for (let i = 0; i < date.length; i++) {
    h ^= date.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
