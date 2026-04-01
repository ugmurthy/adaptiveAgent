import type { DelegateDefinition } from '../types.js';
import type { SkillDefinition } from './types.js';

/**
 * Convert a `SkillDefinition` into a `DelegateDefinition` so the existing
 * `DelegationExecutor` synthetic-tool machinery handles it.
 *
 * The skill's `instructions` are stored in the delegate's `instructions`
 * field and will be injected into the child run's system prompt.
 */
export function skillToDelegate(skill: SkillDefinition): DelegateDefinition {
  return {
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    allowedTools: skill.allowedTools,
    model: skill.model,
    defaults: skill.defaults,
  };
}

/**
 * Convert multiple skills to delegate definitions.
 */
export function skillsToDelegate(skills: SkillDefinition[]): DelegateDefinition[] {
  return skills.map(skillToDelegate);
}
