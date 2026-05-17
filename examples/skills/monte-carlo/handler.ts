/**
 * monte-carlo handler — deterministic match and tournament simulator.
 *
 * Dispatches on `input.action`. Filled in across US-007..US-009.
 */

import type { MonteCarloInput, MonteCarloOutput } from './types.ts';
import { simulateMatch } from './simulate-match.ts';
import { simulateTournament } from './simulate-tournament.ts';

export const name = 'monte_carlo';
export const description =
  'Run deterministic Monte Carlo simulations for single matches and full tournament rollouts. Never simulate outcomes via tokens — call this handler.';

export const inputSchema = {
  type: 'object',
  required: ['action'],
  additionalProperties: true,
  properties: {
    action: {
      type: 'string',
      enum: ['simulate_match', 'simulate_tournament'],
    },
  },
} as const;

export const outputSchema = {
  type: 'object',
  additionalProperties: true,
} as const;

export async function execute(
  input: MonteCarloInput,
  _context: unknown,
): Promise<MonteCarloOutput> {
  switch (input.action) {
    case 'simulate_match':
      return simulateMatch(input);
    case 'simulate_tournament':
      return simulateTournament(input);
    default: {
      const exhaustive: never = input;
      throw new Error(`monte-carlo: unknown action ${JSON.stringify(exhaustive)}`);
    }
  }
}
