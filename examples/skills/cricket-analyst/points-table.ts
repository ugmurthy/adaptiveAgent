/**
 * points_table action: load curated standings, sort by points desc then nrr desc.
 */

import { loadDataset, type DataSourceOptions } from './data-source.ts';

export interface TeamStanding {
  name: string;
  code: string;
  played: number;
  wins: number;
  losses: number;
  points: number;
  nrr: number;
}

export interface PointsTable {
  tournament: string;
  asOf: string;
  teams: TeamStanding[];
}

export async function getPointsTable(options: DataSourceOptions = {}): Promise<PointsTable> {
  const raw = await loadDataset<PointsTable>('ipl-2026-points-table.json', options);

  const teams = [...raw.teams].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    return b.nrr - a.nrr;
  });

  return { tournament: raw.tournament, asOf: raw.asOf, teams };
}
