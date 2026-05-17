import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

import { loadSkillFromDirectory } from '../../../packages/core/src/skills/load-skill.js';
import { skillsToDelegate } from '../../../packages/core/src/skills/skill-to-delegate.js';

const SKILL_DIR = fileURLToPath(new URL('.', import.meta.url));

describe('monte-carlo skill', () => {
  it('loads via loadSkillFromDirectory and exposes the handler tool', async () => {
    const skill = await loadSkillFromDirectory(SKILL_DIR);

    expect(skill.name).toBe('monte-carlo');
    expect(skill.handler).toBe('handler.ts');
    expect(skill.handlerTools).toHaveLength(1);
    expect(skill.handlerTools![0].name).toBe('monte_carlo');
  });

  it('skillsToDelegate exposes delegate.monte-carlo', async () => {
    const skill = await loadSkillFromDirectory(SKILL_DIR);
    const [delegate] = skillsToDelegate([skill]);

    expect(delegate.name).toBe('monte-carlo');
    expect(delegate.handlerTools).toHaveLength(1);
  });
});
