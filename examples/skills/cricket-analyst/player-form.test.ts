import { describe, expect, it } from 'vitest';

import { getPlayerForm } from './player-form.ts';

describe('getPlayerForm', () => {
  it('returns all 10 teams when no team filter is supplied', async () => {
    const result = await getPlayerForm();
    expect(result.teams).toHaveLength(10);
    const codes = result.teams.map((t) => t.team).sort();
    expect(codes).toEqual(['CSK', 'DC', 'GT', 'KKR', 'LSG', 'MI', 'PBKS', 'RCB', 'RR', 'SRH']);
  });

  it('filters to a single team when team is supplied', async () => {
    const result = await getPlayerForm({ team: 'RR' });
    expect(result.teams).toHaveLength(1);
    expect(result.teams[0].team).toBe('RR');
    expect(result.teams[0].players.length).toBeGreaterThan(0);
  });

  it('returns empty teams array for an unknown team filter', async () => {
    const result = await getPlayerForm({ team: 'XXX' });
    expect(result.teams).toEqual([]);
  });

  it('preserves null fields rather than omitting them', async () => {
    const result = await getPlayerForm({ team: 'RR' });
    const boult = result.teams[0].players.find((p) => p.name === 'Trent Boult');
    expect(boult).toBeDefined();
    // Bowler-only stats: runs and sr should be null, not undefined or missing
    expect(boult!.last5.runs).toBeNull();
    expect(boult!.last5.sr).toBeNull();
    expect(boult!.last5.wickets).toBe(9);
    expect(boult!.last5.econ).toBe(7.92);
  });

  it('preserves nulls for fully-missing player rows (RCB Siraj)', async () => {
    const result = await getPlayerForm({ team: 'RCB' });
    const siraj = result.teams[0].players.find((p) => p.name === 'Mohammed Siraj');
    expect(siraj).toBeDefined();
    expect(siraj!.last5.runs).toBeNull();
    expect(siraj!.last5.wickets).toBeNull();
    expect(siraj!.last5.sr).toBeNull();
    expect(siraj!.last5.econ).toBeNull();
  });

  it('groups players under their team code', async () => {
    const result = await getPlayerForm();
    for (const team of result.teams) {
      expect(typeof team.team).toBe('string');
      expect(Array.isArray(team.players)).toBe(true);
      expect(team.players.length).toBeGreaterThan(0);
    }
  });
});
