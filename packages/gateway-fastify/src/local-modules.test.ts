import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { AgentConfig } from './config.js';
import { createLocalModuleRegistry } from './local-modules.js';

describe('createLocalModuleRegistry', () => {
  it('registers built-in tools and bundled delegates for local startup', async () => {
    const registry = await createLocalModuleRegistry({
      workspaceRoot: process.cwd(),
      requiredDelegateNames: ['code-executor', 'researcher'],
      skillDirectories: [fileURLToPath(new URL('../../../examples/skills', import.meta.url))],
    });
    const agentConfig: AgentConfig = {
      id: 'default-agent',
      name: 'Default Agent',
      invocationModes: ['chat', 'run'],
      defaultInvocationMode: 'chat',
      model: {
        provider: 'mesh',
        model: 'qwen/qwen3.5-27b',
      },
      tools: ['read_file', 'list_directory', 'write_file', 'shell_exec', 'web_search', 'read_web_page'],
      delegates: ['code-executor', 'researcher'],
    };

    const resolvedModules = registry.resolveAgentModules(agentConfig);

    expect(registry.listToolNames()).toEqual([
      'list_directory',
      'read_file',
      'read_web_page',
      'shell_exec',
      'web_search',
      'write_file',
    ]);
    expect(registry.listDelegateNames()).toEqual(['code-executor', 'researcher']);
    expect(resolvedModules.tools.map((tool) => tool.name)).toEqual([
      'read_file',
      'list_directory',
      'write_file',
      'shell_exec',
      'web_search',
      'read_web_page',
    ]);
    expect(resolvedModules.delegates.map((delegate) => delegate.name)).toEqual(['code-executor', 'researcher']);
  });
});
