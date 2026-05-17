import { describe, expect, it } from 'vitest';

import { getFixtures } from './fixtures-action.ts';

describe('getFixtures', () => {
  it('partitions matches by status into played and remaining', async () => {
    const result = await getFixtures();

    expect(result.played.length).toBeGreaterThan(0);
    expect(result.remaining.length).toBeGreaterThan(0);

    for (const m of result.played) {
      expect(m.status).toBe('played');
      expect(m.score).toBeDefined();
    }
    for (const m of result.remaining) {
      expect(m.status).toBe('remaining');
      expect(m.score).toBeUndefined();
    }
  });

  it('partitions strictly by status (not date) — a future-dated played match would still be in played', async () => {
    const injected = {
      tournament: 'X',
      asOf: '2026-04-28',
      matches: [
        { id: 'a', date: '2099-01-01', home: 'A', away: 'B', venue: 'V', status: 'played', score: { home: 1, away: 0, winner: 'A' } },
        { id: 'b', date: '2020-01-01', home: 'A', away: 'B', venue: 'V', status: 'remaining' },
      ],
    };

    const result = await getFixtures({
      dataSource: { 'ipl-2026-fixtures.json': injected },
    });

    expect(result.played).toHaveLength(1);
    expect(result.played[0].id).toBe('a');
    expect(result.remaining).toHaveLength(1);
    expect(result.remaining[0].id).toBe('b');
  });

  it('returns matches sorted by date within each bucket', async () => {
    const result = await getFixtures();

    for (let i = 1; i < result.played.length; i++) {
      expect(result.played[i - 1].date <= result.played[i].date).toBe(true);
    }
    for (let i = 1; i < result.remaining.length; i++) {
      expect(result.remaining[i - 1].date <= result.remaining[i].date).toBe(true);
    }
  });

  it('respects from and to date filters', async () => {
    const result = await getFixtures({ from: '2026-04-26', to: '2026-04-30' });
    const all = [...result.played, ...result.remaining];
    expect(all.length).toBeGreaterThan(0);
    for (const m of all) {
      expect(m.date >= '2026-04-26').toBe(true);
      expect(m.date <= '2026-04-30').toBe(true);
    }
  });

  it('played matches carry a score with a winner', async () => {
    const result = await getFixtures();
    for (const m of result.played) {
      expect(m.score).toBeDefined();
      expect(typeof m.score!.winner).toBe('string');
      expect([m.home, m.away]).toContain(m.score!.winner);
    }
  });
});
