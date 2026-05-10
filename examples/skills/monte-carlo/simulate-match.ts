/**
 * Bradley-Terry style single-match probability function.
 *
 * Given a home and away team, optional team strength scores, optional recent
 * form factors, and optional weights, return win/lose/tie probabilities. The
 * function is purely deterministic — no random sampling — so the same inputs
 * always produce the same output.
 */

import type { SimulateMatchInput, SimulateMatchOutput, SimulationWeights } from './types.ts';

const DEFAULT_WEIGHTS: Required<SimulationWeights> = {
  strength: 1.0,
  form: 0.4,
  home: 0.15,
};

const TIE_PROB = 0.02;

export function simulateMatch(input: SimulateMatchInput): SimulateMatchOutput {
  const w: Required<SimulationWeights> = {
    strength: input.weights?.strength ?? DEFAULT_WEIGHTS.strength,
    form: input.weights?.form ?? DEFAULT_WEIGHTS.form,
    home: input.weights?.home ?? DEFAULT_WEIGHTS.home,
  };

  const strengthHome = input.strength?.[input.home] ?? 0;
  const strengthAway = input.strength?.[input.away] ?? 0;
  const formHome = input.form?.[input.home] ?? 0;
  const formAway = input.form?.[input.away] ?? 0;

  const sHome = w.strength * strengthHome + w.home + w.form * formHome;
  const sAway = w.strength * strengthAway + w.form * formAway;

  const rawHome = sigmoid(sHome - sAway);
  const pHome = round4(rawHome * (1 - TIE_PROB));
  const pAway = round4((1 - rawHome) * (1 - TIE_PROB));
  const pTie = round4(TIE_PROB);

  return {
    action: 'simulate_match',
    home: input.home,
    away: input.away,
    pHome,
    pAway,
    pTie,
  };
}

function sigmoid(x: number): number {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
