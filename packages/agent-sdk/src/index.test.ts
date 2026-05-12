import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentSettingsValidationError, loadAgentSdkConfig } from './index.js';

describe('agent-sdk config resolution', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-sdk-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('loads agent.json and falls back from default postgres to memory without DATABASE_URL', async () => {
    await writeAgentConfig(join(tempDir, 'agent.json'));

    const config = await loadAgentSdkConfig({ cwd: tempDir, env: {} });

    expect(config.runtime.requestedMode).toBe('postgres');
    expect(config.runtime.mode).toBe('memory');
    expect(config.workspaceRoot).toBe(tempDir);
    expect(config.shellCwd).toBe(tempDir);
    expect(config.interaction.approvalMode).toBe('auto');
    expect(config.skills.dirs).toEqual([join(tempDir, 'skills'), join(process.env.HOME ?? '', '.adaptiveAgent', 'skills')]);
  });

  it('uses settings provider/model only as fallbacks', async () => {
    await writeFile(
      join(tempDir, 'agent.json'),
      JSON.stringify({
        id: 'agent',
        name: 'Agent',
        invocationModes: ['run'],
        defaultInvocationMode: 'run',
        model: { provider: 'ollama', model: 'qwen3.5' },
        tools: ['read_file'],
      }),
    );
    await writeFile(
      join(tempDir, 'agent.settings.json'),
      JSON.stringify({ model: { overrideProvider: 'openrouter', overrideModel: 'openai/gpt-5-mini' } }),
    );

    const config = await loadAgentSdkConfig({ cwd: tempDir, env: {} });

    expect(config.model.provider).toBe('ollama');
    expect(config.model.model).toBe('qwen3.5');
  });

  it('fails explicit postgres without DATABASE_URL', async () => {
    await writeAgentConfig(join(tempDir, 'agent.json'));
    await writeFile(join(tempDir, 'agent.settings.json'), JSON.stringify({ runtime: { mode: 'postgres' } }));

    await expect(loadAgentSdkConfig({ cwd: tempDir, env: {} })).rejects.toThrow(AgentSettingsValidationError);
  });
});

async function writeAgentConfig(path: string): Promise<void> {
  await writeFile(
    path,
    JSON.stringify({
      id: 'agent',
      name: 'Agent',
      invocationModes: ['chat', 'run'],
      defaultInvocationMode: 'chat',
      model: { provider: 'ollama', model: 'qwen3.5' },
      tools: ['read_file'],
    }),
  );
}
