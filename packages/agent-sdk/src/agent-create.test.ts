import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderAgentCreatePreview, runAgentCreate, type AgentCreateDraft } from './agent-create.js';
import type { AgentConfigFile } from './index.js';

describe('agent-create', () => {
  let tempDir: string;
  let agentsDir: string;
  let settingsPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-create-'));
    agentsDir = join(tempDir, 'catalog-a');
    await mkdir(agentsDir, { recursive: true });
    await mkdir(join(tempDir, 'catalog-b'), { recursive: true });
    settingsPath = join(tempDir, 'agent.settings.json');
    await writeFile(settingsPath, JSON.stringify({
      version: 1,
      agents: { dirs: ['./catalog-a', './catalog-b'] },
      runtime: { mode: 'memory' },
    }));
    await writeFile(join(agentsDir, 'default-agent.json'), JSON.stringify(generatorAgent(), null, 2));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('writes a full config in the first agents dir with inherited defaults and model overrides', async () => {
    const report = await runAgentCreate({
      cwd: tempDir,
      settingsConfigPath: settingsPath,
      generatorAgent: 'default-agent',
      brief: 'Create a TypeScript API review agent.',
      id: 'api-reviewer',
      provider: 'openrouter',
      model: 'openai/gpt-5-mini',
      yes: true,
      generateDraft: async ({ brief, generatorConfig }) => {
        expect(brief).toBe('Create a TypeScript API review agent.');
        expect(generatorConfig.agent.id).toBe('default-agent');
        return draft();
      },
    });

    expect(report.status).toBe('created');
    expect(report.prepared.path).toBe(join(agentsDir, 'api-reviewer.json'));

    const written = JSON.parse(await readFile(report.prepared.path, 'utf-8')) as AgentConfigFile;
    expect(written).toMatchObject({
      version: 1,
      id: 'api-reviewer',
      name: 'API Reviewer',
      description: 'Reviews TypeScript changes for public API regressions.',
      invocationModes: ['chat', 'run'],
      defaultInvocationMode: 'run',
      workspaceRoot: '.',
      model: {
        provider: 'openrouter',
        model: 'openai/gpt-5-mini',
        apiKeyEnv: 'OPENROUTER_API_KEY',
      },
      systemInstructions: 'Review TypeScript API changes with attention to compatibility.',
      tools: ['read_file', 'list_directory'],
      delegates: [],
      defaults: { maxSteps: 30, capture: 'summary' },
      capabilities: { subjectsPreferred: ['typescript', 'api-review'] },
      routing: { keywords: ['api', 'typescript'] },
    });
  });

  it('previews notes and recommendations and cancels without writing when confirmation is denied', async () => {
    const report = await runAgentCreate({
      cwd: tempDir,
      settingsConfigPath: settingsPath,
      brief: 'Create a docs reviewer.',
      confirm: async () => false,
      generateDraft: async () => draft({ id: 'docs-reviewer', name: 'Docs Reviewer' }),
    });

    expect(report.status).toBe('cancelled');
    await expect(readFile(join(agentsDir, 'docs-reviewer.json'), 'utf-8')).rejects.toThrow();
    const preview = renderAgentCreatePreview(report.prepared);
    expect(preview).toContain('Notes:');
    expect(preview).toContain('Recommendations:');
    expect(preview).toContain('Consider adding shell_exec only if this agent should run verification commands.');
  });

  it('refuses to overwrite an existing generated config without force', async () => {
    const targetPath = join(agentsDir, 'existing-agent.json');
    await writeFile(targetPath, '{"id":"existing-agent","kept":true}\n');

    const report = await runAgentCreate({
      cwd: tempDir,
      settingsConfigPath: settingsPath,
      brief: 'Create an existing agent.',
      yes: true,
      generateDraft: async () => draft({ id: 'existing-agent', name: 'Existing Agent' }),
    });

    expect(report.status).toBe('exists');
    expect(JSON.parse(await readFile(targetPath, 'utf-8'))).toEqual({ id: 'existing-agent', kept: true });
  });

  it('uses dry-run as a preview confirmation flow and does not write on denial', async () => {
    const report = await runAgentCreate({
      cwd: tempDir,
      settingsConfigPath: settingsPath,
      brief: 'Create a planning agent.',
      dryRun: true,
      confirm: async () => false,
      generateDraft: async () => draft({ id: 'planning-agent', name: 'Planning Agent' }),
    });

    expect(report.status).toBe('cancelled');
    expect(report.prompted).toBe(true);
    await expect(readFile(join(agentsDir, 'planning-agent.json'), 'utf-8')).rejects.toThrow();
  });

  it('writes during dry-run only after explicit confirmation', async () => {
    const report = await runAgentCreate({
      cwd: tempDir,
      settingsConfigPath: settingsPath,
      brief: 'Create a planning agent.',
      dryRun: true,
      yes: true,
      confirm: async () => true,
      generateDraft: async () => draft({ id: 'planning-agent', name: 'Planning Agent' }),
    });

    expect(report.status).toBe('created');
    expect(report.prompted).toBe(true);
    const written = JSON.parse(await readFile(join(agentsDir, 'planning-agent.json'), 'utf-8')) as AgentConfigFile;
    expect(written.id).toBe('planning-agent');
  });
});

function generatorAgent(): AgentConfigFile {
  return {
    version: 1,
    id: 'default-agent',
    name: 'Default Agent',
    invocationModes: ['chat', 'run'],
    defaultInvocationMode: 'run',
    workspaceRoot: '.',
    model: { provider: 'ollama', model: 'llama3.2' },
    systemInstructions: 'You create local agents.',
    tools: ['read_file', 'list_directory'],
    delegates: [],
    defaults: { maxSteps: 30, capture: 'summary' },
  };
}

function draft(overrides: Partial<AgentCreateDraft['agent']> = {}): AgentCreateDraft {
  return {
    agent: {
      id: 'generated-reviewer',
      name: 'API Reviewer',
      description: 'Reviews TypeScript changes for public API regressions.',
      systemInstructions: 'Review TypeScript API changes with attention to compatibility.',
      capabilities: { subjectsPreferred: ['typescript', 'api-review'] },
      routing: { keywords: ['api', 'typescript'] },
      ...overrides,
    },
    notes: ['Optimized for concise review comments.'],
    recommendations: ['Consider adding shell_exec only if this agent should run verification commands.'],
  };
}
