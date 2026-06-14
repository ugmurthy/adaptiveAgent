import { describe, expect, it } from 'vitest';

import type { AgentConfigFile } from './index.js';
import { createSwarmRoleAgentConfig } from './swarm-role-config.js';

const coordinatorConfig: AgentConfigFile = {
  id: 'coordinator-agent',
  name: 'Coordinator Agent',
  invocationModes: ['run'],
  defaultInvocationMode: 'run',
  model: { provider: 'openrouter', model: 'openai/o4-mini' },
  systemInstructions: 'You are a coordinator. Return only JSON with subtasks and targetAgentId fields.',
  tools: ['web_search', 'write_file'],
};

describe('createSwarmRoleAgentConfig', () => {
  it('keeps derived synthesizers from inheriting coordinator-only output behavior', () => {
    const synthesizer = createSwarmRoleAgentConfig(coordinatorConfig, 'synthesizer');

    expect(synthesizer.id).toBe('coordinator-agent-synthesizer');
    expect(synthesizer.name).toBe('Coordinator Agent synthesizer');
    expect(synthesizer.tools).toEqual(['web_search', 'write_file']);
    expect(synthesizer.systemInstructions).toContain('Swarm synthesizer role');
    expect(synthesizer.systemInstructions).toContain('Do not decompose the task');
    expect(synthesizer.systemInstructions).toContain('Do not return JSON containing subtasks or targetAgentId');
    expect(synthesizer.systemInstructions).toContain('Base profile context follows');
    expect(synthesizer.systemInstructions!.indexOf('Swarm synthesizer role')).toBeLessThan(
      synthesizer.systemInstructions!.indexOf('Base profile context follows'),
    );
  });

  it('keeps derived quality agents focused on structured assessment', () => {
    const quality = createSwarmRoleAgentConfig(coordinatorConfig, 'quality');

    expect(quality.id).toBe('coordinator-agent-quality');
    expect(quality.systemInstructions).toContain('Swarm quality role');
    expect(quality.systemInstructions).toContain('Return only the structured quality assessment requested by the output schema.');
    expect(quality.systemInstructions).toContain('If it conflicts with the swarm quality role above');
  });
});
