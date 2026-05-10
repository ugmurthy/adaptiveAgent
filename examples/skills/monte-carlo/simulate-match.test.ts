import { describe, expect, it } from 'vitest';

import { simulateMatch } from './simulate-match.ts';

describe('simulateMatch', () => {
  it('returns probabilities in [0,1] that sum to 1', () => {
    const r = simulateMatch({ action: 'simulate_match', home: 'A', away: 'B' });
    expect(r.pHome).toBeGreaterThanOrEqual(0);
    expect(r.pHome).toBeLessThanOrEqual(1);
    expect(r.pAway).toBeGreaterThanOrEqual(0);
    expect(r.pAway).toBeLessThanOrEqual(1);
    expect(r.pTie).toBeGreaterThanOrEqual(0);
    expect(r.pTie).toBeLessThanOrEqual(1);
    expect(Math.abs(r.pHome + r.pAway + r.pTie - 1)).toBeLessThan(1e-3);
  });

  it('with no inputs and zero home advantage, both sides are equal', () => {
    const r = simulateMatch({
      action: 'simulate_match',
      home: 'A',
      away: 'B',
      weights: { home: 0 },
    });
    expect(r.pHome).toBeCloseTo(r.pAway, 4);
  });

  it('default home advantage favors the home side', () => {
    const r = simulateMatch({ action: 'simulate_match', home: 'A', away: 'B' });
    expect(r.pHome).toBeGreaterThan(r.pAway);
  });

  it('symmetry: with home advantage zeroed, swapping home/away inverts probabilities', () => {
    const strength = { A: 1.2, B: -0.3 };
    const form = { A: 0.4, B: -0.1 };
    const a = simulateMatch({
      action: 'simulate_match',
      home: 'A',
      away: 'B',
      strength,
      form,
      weights: { home: 0 },
    });
    const b = simulateMatch({
      action: 'simulate_match',
      home: 'B',
      away: 'A',
      strength,
      form,
      weights: { home: 0 },
    });
    expect(a.pHome).toBeCloseTo(b.pAway, 4);
    expect(a.pAway).toBeCloseTo(b.pHome, 4);
  });

  it('higher strength yields higher win probability (weight sensitivity)', () => {
    const baseline = simulateMatch({
      action: 'simulate_match',
      home: 'A',
      away: 'B',
      strength: { A: 0, B: 0 },
      weights: { home: 0 },
    });
    const stronger = simulateMatch({
      action: 'simulate_match',
      home: 'A',
      away: 'B',
      strength: { A: 1.5, B: 0 },
      weights: { home: 0 },
    });
    expect(stronger.pHome).toBeGreaterThan(baseline.pHome);
  });

  it('positive form lifts the team probability', () => {
    const baseline = simulateMatch({
      action: 'simulate_match',
      home: 'A',
      away: 'B',
      weights: { home: 0 },
    });
    const inForm = simulateMatch({
      action: 'simulate_match',
      home: 'A',
      away: 'B',
      form: { A: 1.0, B: 0 },
      weights: { home: 0 },
    });
    expect(inForm.pHome).toBeGreaterThan(baseline.pHome);
  });

  it('is deterministic across repeated calls (no randomness)', () => {
    const args = {
      action: 'simulate_match' as const,
      home: 'A',
      away: 'B',
      strength: { A: 0.7, B: -0.2 },
      form: { A: 0.3, B: -0.5 },
    };
    const r1 = simulateMatch(args);
    const r2 = simulateMatch(args);
    expect(r1).toEqual(r2);
  });
});
