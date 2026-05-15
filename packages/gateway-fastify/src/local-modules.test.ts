import { fileURLToPath } from 'node:url';

import { afterEach } from 'vitest';
import { describe, expect, it } from 'vitest';

import type { AgentConfig } from './config.js';
import { createLocalModuleRegistry } from './local-modules.js';

describe('createLocalModuleRegistry', () => {
  const originalSkillDirs = process.env.ADAPTIVE_AGENT_GATEWAY_SKILL_DIRS;

  afterEach(() => {
    if (originalSkillDirs === undefined) {
      delete process.env.ADAPTIVE_AGENT_GATEWAY_SKILL_DIRS;
    } else {
      process.env.ADAPTIVE_AGENT_GATEWAY_SKILL_DIRS = originalSkillDirs;
    }
  });

  it('registers built-in tools and bundled delegates for local startup', async () => {
    const registry = await createLocalModuleRegistry({
      workspaceRoot: process.cwd(),
      requiredDelegateNames: ['mcp-echo'],
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
      delegates: ['mcp-echo'],
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
    expect(registry.listDelegateNames()).toEqual(['mcp-echo']);
    expect(resolvedModules.tools.map((tool) => tool.name)).toEqual([
      'read_file',
      'list_directory',
      'write_file',
      'shell_exec',
      'web_search',
      'read_web_page',
    ]);
    expect(resolvedModules.delegates.map((delegate) => delegate.name)).toEqual(['mcp-echo']);
  });

  it('discovers installed handler-backed delegates when no filter is provided', async () => {
    const registry = await createLocalModuleRegistry({
      workspaceRoot: process.cwd(),
      skillDirectories: [fileURLToPath(new URL('../../../examples/skills', import.meta.url))],
    });

    expect(registry.listDelegateNames()).toContain('mcp-echo');
  });

  it('loads additional skill directories from ADAPTIVE_AGENT_GATEWAY_SKILL_DIRS', async () => {
    process.env.ADAPTIVE_AGENT_GATEWAY_SKILL_DIRS = fileURLToPath(
      new URL('../../../examples/skills', import.meta.url),
    );

    const registry = await createLocalModuleRegistry({
      workspaceRoot: process.cwd(),
    });

    expect(registry.listDelegateNames()).toContain('file-converter');
    expect(registry.listDelegateNames()).toContain('mcp-echo');
  });
});
