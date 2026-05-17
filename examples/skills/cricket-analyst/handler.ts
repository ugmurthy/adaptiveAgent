/**
 * cricket-analyst handler — deterministic IPL data accessor.
 *
 * Dispatches on `input.action`. Each action returns structured JSON the parent
 * agent forwards verbatim. Network access is gated behind a configurable data
 * source so tests and offline runs use fixtures.
 *
 * Action surface (filled in by US-002..US-005):
 *   - points_table   → { tournament, asOf, teams: [...] }
 *   - fixtures       → { played: Match[], remaining: Match[] }
 *   - player_form    → { team, players: [...] }
 */

import type { CricketAnalystInput, CricketAnalystOutput } from './types.ts';
import type { DataSourceOptions } from './data-source.ts';
import { getPointsTable } from './points-table.ts';
import { getFixtures } from './fixtures-action.ts';
import { getPlayerForm } from './player-form.ts';

export const name = 'cricket_analyst';
export const description =
  'Return deterministic IPL data (points table, fixtures, player form) from a configurable JSON source.';

export const inputSchema = {
  type: 'object',
  required: ['action'],
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['points_table', 'fixtures', 'player_form'],
      description: 'Which deterministic data slice to fetch.',
    },
    asOf: {
      type: 'string',
      description: 'Optional ISO date for a point-in-time snapshot (default: today).',
    },
    team: {
      type: 'string',
      description: 'Optional team filter (used by player_form).',
    },
    from: {
      type: 'string',
      description: 'Optional ISO start date (used by fixtures).',
    },
    to: {
      type: 'string',
      description: 'Optional ISO end date (used by fixtures).',
    },
  },
} as const;

export const outputSchema = {
  type: 'object',
  additionalProperties: true,
} as const;

export async function execute(
  input: CricketAnalystInput,
  context: unknown,
): Promise<CricketAnalystOutput> {
  const dataOptions = resolveDataOptions(context);

  switch (input.action) {
    case 'points_table':
      return await getPointsTable(dataOptions);
    case 'fixtures':
      return await getFixtures({ ...dataOptions, from: input.from, to: input.to });
    case 'player_form':
      return await getPlayerForm({ ...dataOptions, team: input.team });
    default: {
      const exhaustive: never = input;
      throw new Error(`cricket-analyst: unknown action ${JSON.stringify(exhaustive)}`);
    }
  }
}

function resolveDataOptions(context: unknown): DataSourceOptions {
  if (context && typeof context === 'object' && 'cricketAnalyst' in context) {
    const c = (context as { cricketAnalyst?: DataSourceOptions }).cricketAnalyst;
    if (c) return c;
  }
  return {};
}
