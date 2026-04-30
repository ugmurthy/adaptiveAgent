/**
 * fixtures action: load all matches, partition by status into played + remaining.
 */

import { loadDataset, type DataSourceOptions } from './data-source.ts';

export interface MatchScore {
  home: number;
  away: number;
  winner: string;
}

export interface Match {
  id: string;
  date: string;
  home: string;
  away: string;
  venue: string;
  status: 'played' | 'remaining';
  score?: MatchScore;
}

interface RawFixturesFile {
  tournament: string;
  asOf: string;
  matches: Match[];
}

export interface FixturesResult {
  tournament: string;
  asOf: string;
  played: Match[];
  remaining: Match[];
}

export interface GetFixturesOptions extends DataSourceOptions {
  from?: string;
  to?: string;
}

export async function getFixtures(options: GetFixturesOptions = {}): Promise<FixturesResult> {
  const raw = await loadDataset<RawFixturesFile>('ipl-2026-fixtures.json', options);

  const filtered = raw.matches.filter((m) => {
    if (options.from && m.date < options.from) return false;
    if (options.to && m.date > options.to) return false;
    return true;
  });

  const played = filtered.filter((m) => m.status === 'played');
  const remaining = filtered.filter((m) => m.status === 'remaining');

  played.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  remaining.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return { tournament: raw.tournament, asOf: raw.asOf, played, remaining };
}
