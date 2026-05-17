/**
 * Monte Carlo tournament rollout.
 *
 * For each iteration: replay every remaining fixture by sampling outcomes from
 * `simulateMatch` probabilities, update a working points table, then sort to
 * derive playoff/final/winner placement. Aggregate placements across iterations
 * and divide by `iterations` to produce probabilities.
 */

import type {
  SimulateTournamentInput,
  SimulateTournamentOutput,
  TournamentTeamStanding,
  SimulationWeights,
} from './types.ts';
import { simulateMatch } from './simulate-match.ts';
import { mulberry32, seedFromDate, type Rng } from './prng.ts';

const DEFAULT_ITERATIONS = 10_000;
const DEFAULT_PLAYOFF_SLOTS = 4;

interface WorkingStanding {
  team: string;
  played: number;
  wins: number;
  points: number;
  nrr: number;
}

export function simulateTournament(input: SimulateTournamentInput): SimulateTournamentOutput {
  const iterations = input.iterations ?? DEFAULT_ITERATIONS;
  const playoffSlots = input.playoffSlots ?? DEFAULT_PLAYOFF_SLOTS;
  const seed = input.seed ?? defaultSeed();
  const rng = mulberry32(seed);

  const weights: SimulationWeights = input.weights ?? {};
  const strength = input.strength;
  const form = input.form;

  const baseStandings: WorkingStanding[] = input.pointsTable.map((t) => ({
    team: t.team,
    played: t.played,
    wins: t.wins,
    points: t.points,
    nrr: t.nrr ?? 0,
  }));

  const teams = baseStandings.map((s) => s.team);
  const playoffCount: Record<string, number> = Object.fromEntries(teams.map((t) => [t, 0]));
  const finalCount: Record<string, number> = Object.fromEntries(teams.map((t) => [t, 0]));
  const winnerCount: Record<string, number> = Object.fromEntries(teams.map((t) => [t, 0]));

  // Pre-compute match probabilities — they are deterministic given inputs and
  // do not depend on the rng, so we only sample outcomes inside the loop.
  const matchProbs = input.remainingFixtures.map((m) =>
    simulateMatch({
      action: 'simulate_match',
      home: m.home,
      away: m.away,
      venue: m.venue,
      strength,
      form,
      weights,
    }),
  );

  for (let iter = 0; iter < iterations; iter++) {
    const standings = baseStandings.map((s) => ({ ...s }));
    const standingByTeam: Record<string, WorkingStanding> = Object.fromEntries(
      standings.map((s) => [s.team, s]),
    );

    for (let i = 0; i < input.remainingFixtures.length; i++) {
      const fixture = input.remainingFixtures[i];
      const probs = matchProbs[i];
      const r = rng();

      if (r < probs.pHome) {
        applyWin(standingByTeam, fixture.home, fixture.away);
      } else if (r < probs.pHome + probs.pAway) {
        applyWin(standingByTeam, fixture.away, fixture.home);
      } else {
        applyTie(standingByTeam, fixture.home, fixture.away);
      }
    }

    standings.sort(compareStandings);

    for (let rank = 0; rank < playoffSlots && rank < standings.length; rank++) {
      playoffCount[standings[rank].team] += 1;
    }
    if (standings.length >= 1) {
      finalCount[standings[0].team] += 1;
      if (standings.length >= 2) finalCount[standings[1].team] += 1;
      winnerCount[standings[0].team] += 1;
    }
  }

  return {
    action: 'simulate_tournament',
    iterations,
    playoffProb: toProbabilities(playoffCount, iterations),
    finalProb: toProbabilities(finalCount, iterations),
    winnerProb: toProbabilities(winnerCount, iterations),
  };
}

function applyWin(
  by: Record<string, WorkingStanding>,
  winner: string,
  loser: string,
): void {
  const w = by[winner];
  const l = by[loser];
  if (!w || !l) return;
  w.played += 1;
  w.wins += 1;
  w.points += 2;
  l.played += 1;
}

function applyTie(
  by: Record<string, WorkingStanding>,
  home: string,
  away: string,
): void {
  const h = by[home];
  const a = by[away];
  if (!h || !a) return;
  h.played += 1;
  a.played += 1;
  h.points += 1;
  a.points += 1;
}

function compareStandings(a: WorkingStanding, b: WorkingStanding): number {
  if (b.points !== a.points) return b.points - a.points;
  return b.nrr - a.nrr;
}

function toProbabilities(
  counts: Record<string, number>,
  iterations: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const team of Object.keys(counts)) {
    out[team] = Math.round((counts[team] / iterations) * 10000) / 10000;
  }
  return out;
}

function defaultSeed(): number {
  const today = new Date().toISOString().slice(0, 10);
  return seedFromDate(today);
}

export type { Rng };
