/**
 * Public type surface for the monte-carlo skill handler.
 */

export interface SimulateMatchInput {
  action: 'simulate_match';
  home: string;
  away: string;
  venue?: string;
  /** Optional per-team form factor in [-1, 1]; positive favors the team. */
  form?: Record<string, number>;
  /** Optional team strength scores (defaults to a balanced baseline). */
  strength?: Record<string, number>;
  weights?: SimulationWeights;
  seed?: number;
}

export interface SimulationWeights {
  /** How much team strength contributes (default 1.0). */
  strength?: number;
  /** How much recent form contributes (default 0.4). */
  form?: number;
  /** Home-venue advantage (default 0.15). */
  home?: number;
}

export interface SimulateMatchOutput {
  action: 'simulate_match';
  home: string;
  away: string;
  pHome: number;
  pAway: number;
  pTie: number;
}

export interface TournamentTeamStanding {
  team: string;
  played: number;
  wins: number;
  points: number;
  nrr?: number;
}

export interface TournamentMatch {
  id: string;
  home: string;
  away: string;
  venue?: string;
}

export interface SimulateTournamentInput {
  action: 'simulate_tournament';
  pointsTable: TournamentTeamStanding[];
  remainingFixtures: TournamentMatch[];
  iterations?: number;
  /** Optional team strength scores (defaults to a balanced baseline). */
  strength?: Record<string, number>;
  form?: Record<string, number>;
  weights?: SimulationWeights;
  /** Number of teams that qualify for playoffs. Default 4. */
  playoffSlots?: number;
  seed?: number;
}

export interface SimulateTournamentOutput {
  action: 'simulate_tournament';
  iterations: number;
  playoffProb: Record<string, number>;
  finalProb: Record<string, number>;
  winnerProb: Record<string, number>;
}

export type MonteCarloInput = SimulateMatchInput | SimulateTournamentInput;
export type MonteCarloOutput =
  | SimulateMatchOutput
  | SimulateTournamentOutput
  | { action: MonteCarloInput['action']; status: 'stub'; message: string };
