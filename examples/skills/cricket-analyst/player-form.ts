/**
 * player_form action: per-team last-5 aggregates with explicit nulls preserved.
 *
 * Returns one entry per team. When `team` is supplied, only that team is
 * returned. Missing stats are surfaced as `null` rather than omitted, so
 * downstream weighting code never has to distinguish absent-vs-zero.
 */

import { loadDataset, type DataSourceOptions } from './data-source.ts';

export type PlayerRole = 'batter' | 'batter-wk' | 'bowler' | 'all-rounder';

export interface PlayerLast5 {
  runs: number | null;
  wickets: number | null;
  sr: number | null;
  econ: number | null;
}

export interface PlayerForm {
  name: string;
  role: PlayerRole;
  last5: PlayerLast5;
}

export interface TeamPlayerForm {
  team: string;
  players: PlayerForm[];
}

export interface PlayerFormResult {
  tournament: string;
  asOf: string;
  teams: TeamPlayerForm[];
}

interface RawPlayerFormFile {
  tournament: string;
  asOf: string;
  teams: Record<string, PlayerForm[]>;
}

export interface GetPlayerFormOptions extends DataSourceOptions {
  team?: string;
}

export async function getPlayerForm(options: GetPlayerFormOptions = {}): Promise<PlayerFormResult> {
  const raw = await loadDataset<RawPlayerFormFile>('ipl-2026-player-form.json', options);

  const teamCodes = options.team ? [options.team] : Object.keys(raw.teams).sort();

  const teams: TeamPlayerForm[] = teamCodes
    .filter((code) => raw.teams[code] !== undefined)
    .map((code) => ({
      team: code,
      players: raw.teams[code].map(normalizePlayer),
    }));

  return { tournament: raw.tournament, asOf: raw.asOf, teams };
}

function normalizePlayer(p: PlayerForm): PlayerForm {
  return {
    name: p.name,
    role: p.role,
    last5: {
      runs: p.last5?.runs ?? null,
      wickets: p.last5?.wickets ?? null,
      sr: p.last5?.sr ?? null,
      econ: p.last5?.econ ?? null,
    },
  };
}
