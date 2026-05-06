import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ConfigLookupError,
  ConfigValidationError,
  loadAgentConfig,
  resolveModelConfig,
  resolveWorkspaceRoot,
  selectAgentConfigPath,
  validateAgentConfig,
} from './config.js';

describe('core-cli config', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'core-cli-config-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('validates the local agent JSON contract', () => {
    const config = validateAgentConfig(
      {
        id: 'local-agent',
        name: 'Local Agent',
        invocationModes: ['chat', 'run'],
        defaultInvocationMode: 'run',
        model: { provider: 'ollama', model: 'qwen3.5' },
        workspaceRoot: '$HOME/project',
        systemInstructions: 'You are local.',
        tools: ['read_file', 'list_directory'],
        delegates: ['researcher'],
        defaults: { maxSteps: 12, capture: 'summary' },
        metadata: { team: 'local' },
        routing: { ignored: true },
      },
      'agent.json',
    );

    expect(config.id).toBe('local-agent');
    expect(config.invocationModes).toEqual(['chat', 'run']);
    expect(config.defaults?.maxSteps).toBe(12);
    expect(config.routing).toEqual({ ignored: true });
  });

  it('reports validation issues with field paths', () => {
    expect(() => validateAgentConfig({ id: '', tools: 'read_file' }, 'bad.json')).toThrow(ConfigValidationError);
    expect(() => validateAgentConfig({ id: '', tools: 'read_file' }, 'bad.json')).toThrow('model.provider');
  });

  it('selects explicit config paths before defaults', async () => {
    const explicitPath = join(tempDir, 'custom-agent.json');
    await writeAgentConfig(explicitPath, 'custom-agent');
    await writeAgentConfig(join(tempDir, 'agent.json'), 'default-agent');

    await expect(selectAgentConfigPath({ cwd: tempDir, explicitPath })).resolves.toBe(explicitPath);
    const loaded = await loadAgentConfig({ cwd: tempDir, explicitPath });
    expect(loaded.config.id).toBe('custom-agent');
  });

  it('uses ./agent.json when no explicit or env path is set', async () => {
    const defaultPath = join(tempDir, 'agent.json');
    await writeAgentConfig(defaultPath, 'default-agent');

    await expect(selectAgentConfigPath({ cwd: tempDir, env: {} })).resolves.toBe(defaultPath);
  });

  it('formats lookup guidance for missing config errors', () => {
    const error = new ConfigLookupError(['/missing/agent.json', '/missing/default-agent.json']);
    expect(error.message).toContain('Lookup order');
    expect(error.message).toContain('Example minimal config');
  });

  it('resolves workspace roots and environment-backed model API keys', () => {
    expect(resolveWorkspaceRoot('$HOME/project')).toContain('/project');
    expect(
      resolveModelConfig({ provider: 'mesh', model: 'openai/gpt-4o', apiKeyEnv: 'MESH_API_KEY' }, { MESH_API_KEY: 'mesh-key' }),
    ).toMatchObject({ provider: 'mesh', apiKey: 'mesh-key' });
  });
});

async function writeAgentConfig(path: string, id: string): Promise<void> {
  await writeFile(
    path,
    JSON.stringify({
      id,
      name: id,
      invocationModes: ['chat', 'run'],
      defaultInvocationMode: 'run',
      model: { provider: 'ollama', model: 'qwen3.5' },
      tools: ['read_file'],
      delegates: [],
    }),
  );
}
