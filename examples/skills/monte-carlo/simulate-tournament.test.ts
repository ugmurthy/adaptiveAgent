import { describe, expect, it } from 'vitest';

import { simulateTournament } from './simulate-tournament.ts';
import type { SimulateTournamentInput, TournamentTeamStanding, TournamentMatch } from './types.ts';

const TEAMS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

function makeStandings(): TournamentTeamStanding[] {
  return TEAMS.map((team, i) => ({
    team,
    played: 6,
    wins: 8 - i,
    points: (8 - i) * 2,
    nrr: (8 - i) * 0.05,
  }));
}

function makeFixtures(count: number): TournamentMatch[] {
  const out: TournamentMatch[] = [];
  for (let i = 0; i < count; i++) {
    const home = TEAMS[i % TEAMS.length];
    const away = TEAMS[(i + 1) % TEAMS.length];
    out.push({ id: `m${i}`, home, away });
  }
  return out;
}

describe('simulateTournament', () => {
  it('returns probabilities in [0,1] across all aggregates', () => {
    const result = simulateTournament({
      action: 'simulate_tournament',
      pointsTable: makeStandings(),
      remainingFixtures: makeFixtures(20),
      iterations: 1000,
      seed: 42,
    });

    for (const team of TEAMS) {
      for (const map of [result.playoffProb, result.finalProb, result.winnerProb]) {
        expect(map[team]).toBeGreaterThanOrEqual(0);
        expect(map[team]).toBeLessThanOrEqual(1);
      }
    }
  });

  it('winnerProb sums to 1.0 within rounding tolerance', () => {
    const result = simulateTournament({
      action: 'simulate_tournament',
      pointsTable: makeStandings(),
      remainingFixtures: makeFixtures(20),
      iterations: 1000,
      seed: 42,
    });
    const total = Object.values(result.winnerProb).reduce((a, b) => a + b, 0);
    expect(Math.abs(total - 1)).toBeLessThan(0.01);
  });

  it('finalProb sums to ~2.0 (top-2 each iteration)', () => {
    const result = simulateTournament({
      action: 'simulate_tournament',
      pointsTable: makeStandings(),
      remainingFixtures: makeFixtures(20),
      iterations: 1000,
      seed: 42,
    });
    const total = Object.values(result.finalProb).reduce((a, b) => a + b, 0);
    expect(Math.abs(total - 2)).toBeLessThan(0.01);
  });

  it('playoffProb sums to ~playoffSlots', () => {
    const result = simulateTournament({
      action: 'simulate_tournament',
      pointsTable: makeStandings(),
      remainingFixtures: makeFixtures(20),
      iterations: 1000,
      playoffSlots: 4,
      seed: 42,
    });
    const total = Object.values(result.playoffProb).reduce((a, b) => a + b, 0);
    expect(Math.abs(total - 4)).toBeLessThan(0.02);
  });

  it('teams ahead in the starting points table win more often', () => {
    const result = simulateTournament({
      action: 'simulate_tournament',
      pointsTable: makeStandings(),
      remainingFixtures: makeFixtures(20),
      iterations: 2000,
      seed: 42,
    });
    expect(result.winnerProb['A']).toBeGreaterThan(result.winnerProb['H']);
    expect(result.playoffProb['A']).toBeGreaterThan(result.playoffProb['H']);
  });

  it('reports the iteration count back', () => {
    const result = simulateTournament({
      action: 'simulate_tournament',
      pointsTable: makeStandings(),
      remainingFixtures: makeFixtures(20),
      iterations: 500,
      seed: 1,
    });
    expect(result.iterations).toBe(500);
  });

  it('completes 10000 iterations on an 8-team / 30-fixture remainder under 2 seconds', () => {
    const start = Date.now();
    simulateTournament({
      action: 'simulate_tournament',
      pointsTable: makeStandings(),
      remainingFixtures: makeFixtures(30),
      iterations: 10_000,
      seed: 42,
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
  });
});
