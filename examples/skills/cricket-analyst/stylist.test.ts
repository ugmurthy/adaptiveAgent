import { describe, expect, it } from 'vitest';

import { styleBulletin } from './stylist.ts';

const FROZEN_INPUT = {
  date: '2026-04-28',
  pointsTable: {
    tournament: 'IPL 2026',
    teams: [
      { name: 'Rajasthan Royals',  code: 'RR',  played: 10, wins: 8, losses: 2, points: 16, nrr: 0.812 },
      { name: 'Gujarat Titans',    code: 'GT',  played: 10, wins: 2, losses: 8, points: 4,  nrr: -0.945 },
    ],
  },
  recentMatches: [
    { id: 'm1', date: '2026-04-27', home: 'RR', away: 'MI', venue: 'Jaipur',
      status: 'played' as const, score: { home: 187, away: 152, winner: 'RR' } },
  ],
  upcomingMatches: [
    { id: 'm2', date: '2026-04-29', home: 'GT', away: 'RCB', venue: 'Ahmedabad', status: 'remaining' as const },
  ],
  predictions: {
    iterations: 10000,
    playoffProb: { RR: 0.95, GT: 0.05 },
    winnerProb: { RR: 0.62, GT: 0.01 },
  },
  notes: ['Generated from frozen fixture data'],
};

describe('styleBulletin', () => {
  it('returns a non-empty HTML document', () => {
    const html = styleBulletin(FROZEN_INPUT);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('</html>');
  });

  it('includes the tournament name in the title and h1', () => {
    const html = styleBulletin(FROZEN_INPUT);
    expect(html).toContain('IPL 2026 Bulletin');
  });

  it('renders all teams from the points table', () => {
    const html = styleBulletin(FROZEN_INPUT);
    expect(html).toContain('Rajasthan Royals');
    expect(html).toContain('Gujarat Titans');
  });

  it('renders winner probabilities as percentages', () => {
    const html = styleBulletin(FROZEN_INPUT);
    expect(html).toContain('62.00%');
    expect(html).toContain('1.00%');
  });

  it('includes the AdaptiveAgent attribution and @murthyug link', () => {
    const html = styleBulletin(FROZEN_INPUT);
    expect(html).toContain('AdaptiveAgent');
    expect(html).toContain('https://twitter.com/murthyug');
  });

  it('escapes HTML-unsafe characters in team names', () => {
    const html = styleBulletin({
      ...FROZEN_INPUT,
      pointsTable: {
        tournament: 'IPL 2026',
        teams: [
          { name: '<script>alert(1)</script>', code: 'X', played: 1, wins: 1, losses: 0, points: 2, nrr: 0 },
        ],
      },
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('produces the same HTML for identical input (deterministic)', () => {
    expect(styleBulletin(FROZEN_INPUT)).toBe(styleBulletin(FROZEN_INPUT));
  });

  it('snapshot-style: stable hash of frozen output (sentinel substrings)', () => {
    const html = styleBulletin(FROZEN_INPUT);
    expect(html).toMatch(/IPL 2026 Bulletin/);
    expect(html).toMatch(/As of 2026-04-28/);
    expect(html).toMatch(/Monte Carlo Predictions/);
    expect(html).toMatch(/10,000 simulated rollouts/);
    expect(html).toMatch(/<\/html>$/);
  });
});
