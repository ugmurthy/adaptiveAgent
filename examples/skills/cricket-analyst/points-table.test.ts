import { describe, expect, it } from 'vitest';

import { getPointsTable } from './points-table.ts';

describe('getPointsTable', () => {
  it('loads the bundled fixture and returns the expected shape', async () => {
    const table = await getPointsTable();

    expect(table.tournament).toBe('IPL 2026');
    expect(table.asOf).toBe('2026-04-28');
    expect(table.teams).toHaveLength(10);

    const first = table.teams[0];
    expect(first).toHaveProperty('name');
    expect(first).toHaveProperty('code');
    expect(first).toHaveProperty('played');
    expect(first).toHaveProperty('wins');
    expect(first).toHaveProperty('losses');
    expect(first).toHaveProperty('points');
    expect(first).toHaveProperty('nrr');
  });

  it('sorts teams by points desc, then nrr desc', async () => {
    const table = await getPointsTable();

    for (let i = 1; i < table.teams.length; i++) {
      const prev = table.teams[i - 1];
      const curr = table.teams[i];
      expect(prev.points).toBeGreaterThanOrEqual(curr.points);
      if (prev.points === curr.points) {
        expect(prev.nrr).toBeGreaterThanOrEqual(curr.nrr);
      }
    }

    expect(table.teams[0].code).toBe('RR');
    expect(table.teams[table.teams.length - 1].code).toBe('GT');
  });

  it('breaks points ties by NRR (SRH 12pts/0.207 sits below CSK 12pts/0.453)', async () => {
    const table = await getPointsTable();
    const csk = table.teams.findIndex((t) => t.code === 'CSK');
    const srh = table.teams.findIndex((t) => t.code === 'SRH');
    expect(csk).toBeLessThan(srh);
  });

  it('respects an injected dataSource override (env-free)', async () => {
    const injected = {
      tournament: 'IPL 2026',
      asOf: '2026-04-30',
      teams: [
        { name: 'A', code: 'A', played: 1, wins: 1, losses: 0, points: 2, nrr: 0.5 },
        { name: 'B', code: 'B', played: 1, wins: 0, losses: 1, points: 0, nrr: -0.5 },
      ],
    };

    const table = await getPointsTable({
      dataSource: { 'ipl-2026-points-table.json': injected },
    });

    expect(table.asOf).toBe('2026-04-30');
    expect(table.teams[0].code).toBe('A');
  });
});
