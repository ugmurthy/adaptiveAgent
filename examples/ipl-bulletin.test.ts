import { describe, expect, it } from 'vitest';

import { loadBulletinSkills, buildGoal } from './ipl-bulletin.ts';
import type { ModelAdapter, ModelRequest, ModelResponse } from '../packages/core/src/types.js';

function makeStubModel(): ModelAdapter {
  let turn = 0;
  return {
    provider: 'stub',
    model: 'stub-1',
    capabilities: { toolCalling: true, jsonOutput: true, streaming: false, usage: false },
    async generate(_request: ModelRequest): Promise<ModelResponse> {
      turn++;
      if (turn === 1) {
        return {
          finishReason: 'stop',
          text: '<html><body>stub bulletin</body></html>',
        };
      }
      return { finishReason: 'stop', text: 'done' };
    },
  };
}

describe('ipl-bulletin', () => {
  it('loadBulletinSkills returns both cricket-analyst and monte-carlo', async () => {
    const skills = await loadBulletinSkills();
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(['cricket-analyst', 'monte-carlo']);
  });

  it('each loaded skill exposes its handler tool', async () => {
    const skills = await loadBulletinSkills();
    for (const s of skills) {
      expect(s.handlerTools?.length).toBeGreaterThan(0);
    }
  });

  it('the cricket-analyst handler returns the points table', async () => {
    const skills = await loadBulletinSkills();
    const ca = skills.find((s) => s.name === 'cricket-analyst')!;
    const tool = ca.handlerTools![0];
    const out = (await tool.execute({ action: 'points_table' } as any, {} as any)) as any;
    expect(out.tournament).toBe('IPL 2026');
    expect(Array.isArray(out.teams)).toBe(true);
    expect(out.teams.length).toBe(10);
  });

  it('the monte-carlo handler runs a tournament simulation', async () => {
    const skills = await loadBulletinSkills();
    const mc = skills.find((s) => s.name === 'monte-carlo')!;
    const tool = mc.handlerTools![0];
    const out = (await tool.execute({
      action: 'simulate_tournament',
      pointsTable: [
        { team: 'A', played: 1, wins: 1, points: 2, nrr: 0.5 },
        { team: 'B', played: 1, wins: 0, points: 0, nrr: -0.5 },
      ],
      remainingFixtures: [{ id: 'm1', home: 'A', away: 'B' }],
      iterations: 50,
      seed: 1,
    } as any, {} as any)) as any;
    expect(out.iterations).toBe(50);
    expect(out.winnerProb).toBeDefined();
    const sum = (out.winnerProb.A as number) + (out.winnerProb.B as number);
    expect(Math.abs(sum - 1)).toBeLessThan(0.01);
  });

  it('buildGoal mentions both delegates and the no-network clause when set', () => {
    const goalOnline = buildGoal('2026-04-28', false);
    expect(goalOnline).toContain('delegate.cricket-analyst');
    expect(goalOnline).toContain('delegate.monte-carlo');
    expect(goalOnline).not.toContain('--no-network is in effect');

    const goalOffline = buildGoal('2026-04-28', true);
    expect(goalOffline).toContain('--no-network is in effect');
  });

  it('a stub model adapter satisfies the minimum ModelAdapter interface', () => {
    const stub = makeStubModel();
    expect(stub.provider).toBe('stub');
    expect(typeof stub.generate).toBe('function');
  });
});
