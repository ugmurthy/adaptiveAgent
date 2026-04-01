import type { AgentDefaults, JsonSchema, ModelAdapter } from '../types.js';

export interface SkillDefinition {
  /** Stable skill name, e.g. `"researcher"`. Used as the delegate profile name. */
  name: string;
  /** Short description surfaced to the planner as the delegate tool description. */
  description: string;
  /** Full instructions injected into the child run's system prompt. */
  instructions: string;
  /** Subset of host tool names this skill is allowed to use. */
  allowedTools: string[];
  /** Optional trigger phrases for skill matching. */
  triggers?: string[];
  /** Optional model override for this skill's child runs. */
  model?: ModelAdapter;
  /** Optional agent default overrides for this skill's child runs. */
  defaults?: Partial<AgentDefaults>;
  /** Optional structured input schema for the skill. */
  inputSchema?: JsonSchema;
  /** Optional structured output schema for the skill. */
  outputSchema?: JsonSchema;
}
