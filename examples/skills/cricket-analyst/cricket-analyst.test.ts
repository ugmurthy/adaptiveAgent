import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

import { loadSkillFromDirectory } from '../../../packages/core/src/skills/load-skill.js';
import { skillToDelegate } from '../../../packages/core/src/skills/skill-to-delegate.js';

const SKILL_DIR = fileURLToPath(new URL('.', import.meta.url));

describe('cricket-analyst skill', () => {
  it('loads via loadSkillFromDirectory and exposes the handler tool', async () => {
    const skill = await loadSkillFromDirectory(SKILL_DIR);

    expect(skill.name).toBe('cricket-analyst');
    expect(skill.handler).toBe('handler.ts');
    expect(skill.handlerTools).toHaveLength(1);
    expect(skill.handlerTools![0].name).toBe('cricket_analyst');
  });

  it('converts to delegate.cricket-analyst with handler tool carried through', async () => {
    const skill = await loadSkillFromDirectory(SKILL_DIR);
    const delegate = skillToDelegate(skill);

    expect(delegate.name).toBe('cricket-analyst');
    expect(delegate.handlerTools).toHaveLength(1);
    expect(delegate.handlerTools![0].name).toBe('cricket_analyst');
  });

  it('handler dispatches each known action without throwing', async () => {
    const skill = await loadSkillFromDirectory(SKILL_DIR);
    const tool = skill.handlerTools![0];

    // points_table is implemented in US-002; the others remain stubs until US-003/US-004.
    const points = (await tool.execute({ action: 'points_table' } as any, {} as any)) as any;
    expect(points.tournament).toBe('IPL 2026');
    expect(Array.isArray(points.teams)).toBe(true);

    const fixtures = (await tool.execute({ action: 'fixtures' } as any, {} as any)) as any;
    expect(Array.isArray(fixtures.played)).toBe(true);
    expect(Array.isArray(fixtures.remaining)).toBe(true);

    const form = (await tool.execute({ action: 'player_form' } as any, {} as any)) as any;
    expect(Array.isArray(form.teams)).toBe(true);
    expect(form.teams.length).toBeGreaterThan(0);
  });
});
