import type { CreatedAdaptiveAgent, DelegateDefinition, ToolDefinition } from './core.js';
import { describe, expect, it, vi } from 'vitest';

import type { AgentConfig, LoadedConfig } from './config.js';
import { createAgentRegistry } from './agent-registry.js';
import { createModuleRegistry } from './registries.js';

function createTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: 'object', additionalProperties: true },
    execute: async () => ({ ok: true }),
  };
}

function createDelegate(name: string): DelegateDefinition {
  return {
    name,
    description: `${name} delegate`,
    allowedTools: [],
  };
}

function createAgentConfig(): LoadedConfig<AgentConfig> {
  return {
    path: '/tmp/support-agent.json',
    config: {
      id: 'support-agent',
      name: 'Support Agent',
      invocationModes: ['chat', 'run'],
      defaultInvocationMode: 'chat',
      model: {
        provider: 'ollama',
        model: 'qwen3.5',
      },
      tools: ['read_file'],
      delegates: ['researcher'],
      routing: {
        allowedChannels: ['webchat'],
      },
    },
  };
}

function createCreatedAgent(agentId: string): CreatedAdaptiveAgent {
  return {
    agent: { id: agentId } as never,
    runtime: {
      runStore: {} as never,
      eventStore: {} as never,
      snapshotStore: {} as never,
      planStore: undefined,
    },
  };
}

describe('AgentRegistry', () => {
  it('loads metadata without instantiating agents and caches materialized agents by id', async () => {
    const agentFactory = vi.fn((entry) => createCreatedAgent(entry.definition.agentId));
    const registry = createAgentRegistry({
      agents: [createAgentConfig()],
      moduleRegistry: createModuleRegistry({
        tools: [createTool('read_file')],
        delegates: [createDelegate('researcher')],
      }),
      agentFactory,
    });

    expect(agentFactory).not.toHaveBeenCalled();
    expect(registry.listAgentIds()).toEqual(['support-agent']);
    expect(registry.getMetadata('support-agent')).toEqual({
      agentId: 'support-agent',
      name: 'Support Agent',
      invocationModes: ['chat', 'run'],
      defaultInvocationMode: 'chat',
      routing: {
        allowedChannels: ['webchat'],
      },
    });
    expect(agentFactory).not.toHaveBeenCalled();

    const firstMaterializedAgent = await registry.getAgent('support-agent');
    const secondMaterializedAgent = await registry.getAgent('support-agent');

    expect(firstMaterializedAgent).toBe(secondMaterializedAgent);
    expect(agentFactory).toHaveBeenCalledTimes(1);
    expect(registry.getDefinition('support-agent')).toMatchObject({
      agentId: 'support-agent',
      toolNames: ['read_file'],
      delegateNames: ['researcher'],
    });
  });

  it('surfaces unknown agent ids with loaded agent context', () => {
    const registry = createAgentRegistry({
      agents: [createAgentConfig()],
      moduleRegistry: createModuleRegistry({
        tools: [createTool('read_file')],
        delegates: [createDelegate('researcher')],
      }),
    });

    expect(() => registry.getMetadata('missing-agent')).toThrowError(
      'Unknown agent id "missing-agent". Loaded agents: support-agent.',
    );
  });
});
