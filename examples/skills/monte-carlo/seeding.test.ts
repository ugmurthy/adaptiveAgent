import { describe, expect, it } from 'vitest';

import { simulateMatch } from './simulate-match.ts';
import { simulateTournament } from './simulate-tournament.ts';
import { mulberry32, seedFromDate } from './prng.ts';

const TEAMS = ['A', 'B', 'C', 'D'];
const STANDINGS = TEAMS.map((team, i) => ({
  team,
  played: 5,
  wins: 4 - i,
  points: (4 - i) * 2,
  nrr: (4 - i) * 0.05,
}));
const FIXTURES = [
  { id: 'f1', home: 'A', away: 'B' },
  { id: 'f2', home: 'C', away: 'D' },
  { id: 'f3', home: 'A', away: 'C' },
  { id: 'f4', home: 'B', away: 'D' },
];

describe('mulberry32', () => {
  it('produces the same stream for the same seed', () => {
    const r1 = mulberry32(123);
    const r2 = mulberry32(123);
    for (let i = 0; i < 100; i++) {
      expect(r1()).toBe(r2());
    }
  });

  it('produces different streams for different seeds', () => {
    const r1 = mulberry32(1);
    const r2 = mulberry32(2);
    let differs = false;
    for (let i = 0; i < 10; i++) {
      if (r1() !== r2()) {
        differs = true;
        break;
      }
    }
    expect(differs).toBe(true);
  });
});

describe('seedFromDate', () => {
  it('is deterministic for the same date', () => {
    expect(seedFromDate('2026-04-30')).toBe(seedFromDate('2026-04-30'));
  });

  it('differs across different dates', () => {
    expect(seedFromDate('2026-04-30')).not.toBe(seedFromDate('2026-05-01'));
  });
});

describe('reproducibility across actions', () => {
  it('simulateMatch is intrinsically deterministic (no randomness)', () => {
    const args = {
      action: 'simulate_match' as const,
      home: 'A',
      away: 'B',
      strength: { A: 0.5, B: -0.2 },
      form: { A: 0.3, B: 0.0 },
    };
    const r1 = simulateMatch(args);
    const r2 = simulateMatch(args);
    expect(r1).toEqual(r2);
  });

  it('simulateTournament with the same seed yields bit-identical output', () => {
    const args = {
      action: 'simulate_tournament' as const,
      pointsTable: STANDINGS,
      remainingFixtures: FIXTURES,
      iterations: 500,
      seed: 7777,
    };
    const r1 = simulateTournament(args);
    const r2 = simulateTournament(args);
    expect(r1).toEqual(r2);
  });

  it('simulateTournament with different seeds yields different output', () => {
    const a = simulateTournament({
      action: 'simulate_tournament',
      pointsTable: STANDINGS,
      remainingFixtures: FIXTURES,
      iterations: 500,
      seed: 1,
    });
    const b = simulateTournament({
      action: 'simulate_tournament',
      pointsTable: STANDINGS,
      remainingFixtures: FIXTURES,
      iterations: 500,
      seed: 2,
    });
    expect(a).not.toEqual(b);
  });

  it('default seed is derived from the current date so two runs on the same day match', () => {
    // We cannot freeze Date.now() here without mocking, so instead we assert
    // that omitting the seed twice in quick succession (same calendar day)
    // gives identical output for a small iteration count.
    const args = {
      action: 'simulate_tournament' as const,
      pointsTable: STANDINGS,
      remainingFixtures: FIXTURES,
      iterations: 200,
    };
    const r1 = simulateTournament(args);
    const r2 = simulateTournament(args);
    expect(r1).toEqual(r2);
  });
});
