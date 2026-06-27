import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentSettingsValidationError, inspectAgentSdkResolution, loadAgentSdkConfig } from './index.js';

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

    const config = await loadAgentSdkConfig({ cwd: tempDir, env: { ADAPTIVE_AGENT_HOME: join(tempDir, 'home') } });

    expect(config.runtime.requestedMode).toBe('postgres');
    expect(config.runtime.mode).toBe('memory');
    expect(config.workspaceRoot).toBe(tempDir);
    expect(config.shellCwd).toBe(tempDir);
    expect(config.interaction.approvalMode).toBe('auto');
    expect(config.agents.dirs).toEqual([join(tempDir, 'agents'), join(process.env.HOME ?? '', '.adaptiveAgent', 'agents')]);
    expect(config.skills.dirs).toEqual([join(tempDir, 'skills'), join(process.env.HOME ?? '', '.adaptiveAgent', 'skills')]);
  });

  it('resolves an agent filename from settings agents dirs', async () => {
    await mkdir(join(tempDir, 'catalog'));
    await writeAgentConfig(join(tempDir, 'catalog', 'researcher.json'), 'researcher');
    await writeFile(join(tempDir, 'agent.settings.json'), JSON.stringify({ agents: { dirs: ['./catalog'] } }));

    const config = await loadAgentSdkConfig({ cwd: tempDir, agentConfigPath: 'researcher', env: {} });

    expect(config.agent.id).toBe('researcher');
    expect(config.agents.dirs).toEqual([join(tempDir, 'catalog')]);
  });

  it('rejects ambiguous agent filenames from settings agents dirs', async () => {
    await mkdir(join(tempDir, 'catalog-a'));
    await mkdir(join(tempDir, 'catalog-b'));
    await writeAgentConfig(join(tempDir, 'catalog-a', 'worker.json'), 'worker-a');
    await writeAgentConfig(join(tempDir, 'catalog-b', 'worker.json'), 'worker-b');
    await writeFile(join(tempDir, 'agent.settings.json'), JSON.stringify({ agents: { dirs: ['./catalog-a', './catalog-b'] } }));

    await expect(loadAgentSdkConfig({ cwd: tempDir, agentConfigPath: 'worker', env: {} })).rejects.toThrow('Ambiguous agent config "worker"');
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

  it('loads ground truth calendar policy from settings', async () => {
    await writeAgentConfig(join(tempDir, 'agent.json'));
    await writeFile(
      join(tempDir, 'agent.settings.json'),
      JSON.stringify({
        groundTruth: {
          timezone: 'Asia/Kolkata',
          locale: 'en-IN',
          weekStartsOn: 'monday',
          fiscalYearStartMonth: 4,
          fiscalQuarterNaming: 'endYear',
          businessDays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
        },
      }),
    );

    const config = await loadAgentSdkConfig({ cwd: tempDir, env: {} });

    expect(config.groundTruth).toMatchObject({
      enabled: true,
      timezone: 'Asia/Kolkata',
      locale: 'en-IN',
      weekStartsOn: 'monday',
      fiscalYearStartMonth: 4,
      fiscalQuarterNaming: 'endYear',
    });
  });

  it('rejects invalid fiscal year start month', async () => {
    await writeAgentConfig(join(tempDir, 'agent.json'));
    await writeFile(join(tempDir, 'agent.settings.json'), JSON.stringify({ groundTruth: { fiscalYearStartMonth: 13 } }));

    await expect(loadAgentSdkConfig({ cwd: tempDir, env: {} })).rejects.toThrow(AgentSettingsValidationError);
  });

  it('inspects resolved tools without creating a runtime bundle', async () => {
    await writeAgentConfig(join(tempDir, 'agent.json'));

    const inspection = await inspectAgentSdkResolution({ cwd: tempDir, env: {} });

    expect(inspection.config.agent.id).toBe('agent');
    expect(inspection.tools.map((tool) => tool.name)).toEqual(['read_file']);
    expect(inspection.registeredToolNames).toContain('read_file');
    expect(inspection.registeredToolNames).toContain('search_files');
    expect(inspection.registeredToolNames).toContain('edit_file');
    expect(inspection.delegates).toEqual([]);
  });
});

async function writeAgentConfig(path: string, id = 'agent'): Promise<void> {
  await writeFile(
    path,
    JSON.stringify({
      id,
      name: id,
      invocationModes: ['chat', 'run'],
      defaultInvocationMode: 'chat',
      model: { provider: 'ollama', model: 'qwen3.5' },
      tools: ['read_file'],
    }),
  );
}
