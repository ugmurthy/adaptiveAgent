/**
 * Deterministic bulletin pipeline.
 *
 * Runs the full bulletin sequence — points table → fixtures → tournament
 * simulation → HTML render — without any LLM in the loop. This is what the
 * agent's planner would orchestrate via delegate calls; exposing it as a
 * standalone function lets tests verify pipeline correctness end-to-end without
 * a live model.
 */

import { getPointsTable } from './points-table.ts';
import { getFixtures } from './fixtures-action.ts';
import { simulateTournament } from '../monte-carlo/simulate-tournament.ts';
import { styleBulletin, type StyleBulletinInput } from './stylist.ts';
import type { DataSourceOptions } from './data-source.ts';

export interface RunBulletinOptions extends DataSourceOptions {
  date: string;
  iterations?: number;
  seed?: number;
}

export interface BulletinResult {
  structured: StyleBulletinInput & {
    predictions: StyleBulletinInput['predictions'] & { finalProb: Record<string, number> };
  };
  html: string;
}

export async function runBulletinPipeline(options: RunBulletinOptions): Promise<BulletinResult> {
  const dataOpts: DataSourceOptions = {
    dataSource: options.dataSource,
    allowNetwork: options.allowNetwork,
    baseUrl: options.baseUrl,
    fetchImpl: options.fetchImpl,
  };

  const pointsTable = await getPointsTable(dataOpts);
  const fixtures = await getFixtures(dataOpts);

  const standings = pointsTable.teams.map((t) => ({
    team: t.code,
    played: t.played,
    wins: t.wins,
    points: t.points,
    nrr: t.nrr,
  }));

  const remaining = fixtures.remaining.map((m) => ({
    id: m.id,
    home: m.home,
    away: m.away,
    venue: m.venue,
  }));

  const sim = simulateTournament({
    action: 'simulate_tournament',
    pointsTable: standings,
    remainingFixtures: remaining,
    iterations: options.iterations ?? 10_000,
    seed: options.seed,
  });

  const structured = {
    date: options.date,
    pointsTable: { tournament: pointsTable.tournament, teams: pointsTable.teams },
    recentMatches: fixtures.played,
    upcomingMatches: fixtures.remaining,
    predictions: {
      iterations: sim.iterations,
      playoffProb: sim.playoffProb,
      winnerProb: sim.winnerProb,
      finalProb: sim.finalProb,
    },
    notes: ['Generated from deterministic cricket-analyst + monte-carlo skills'],
  };

  return {
    structured,
    html: styleBulletin(structured),
  };
}
