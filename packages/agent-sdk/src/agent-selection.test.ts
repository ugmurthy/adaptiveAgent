import { describe, expect, it, vi } from 'vitest';
import type { RunResult } from '@adaptive-agent/core';

import { selectAgentProfile } from './agent-selection.js';
import type { AgentSdkCatalogAgent } from './config-types.js';
import type { TaskPreparationRunner } from './task-preparation.js';

describe('agent selection', () => {
  it('asks a tool-free selector to choose only from eligible run profiles', async () => {
    const runRaw = vi.fn(async () => ({
      status: 'success',
      runId: '11111111-1111-4111-8111-111111111111',
      output: { selectedAgentId: 'researcher', reason: 'The task requires web research.' },
      stepsUsed: 1,
      usage: { promptTokens: 1, completionTokens: 1, estimatedCostUSD: 0 },
    }) as RunResult);
    const runner = { config: { agent: preparer(['read_file'], ['researcher']) }, runRaw } satisfies TaskPreparationRunner;

    const result = await selectAgentProfile(runner, {
      originalObjective: 'Research current browser APIs',
      candidates: [candidate('researcher'), candidate('task-preparer'), candidate('archived', { archived: true }), candidate('chat', { invocationModes: ['chat'] })],
      workspaceRoot: '/workspace',
      attachments: { images: [], files: [], audio: [] },
      sessionId: 'session-1',
    });

    expect(result).toEqual({
      selectedAgentId: 'researcher',
      reason: 'The task requires web research.',
      selectionAgentId: 'task-preparer',
      selectionRunId: '11111111-1111-4111-8111-111111111111',
    });
    expect(runRaw).toHaveBeenCalledWith(expect.stringContaining('Select the single best agent profile'), expect.objectContaining({
      sessionId: 'session-1',
      forbiddenTools: ['read_file', 'delegate.researcher'],
      outputSchema: expect.objectContaining({ properties: expect.objectContaining({ selectedAgentId: { enum: ['researcher'] } }) }),
      input: expect.objectContaining({ candidates: [expect.objectContaining({ id: 'researcher' })] }),
    }));
  });

  it('rejects a selected profile outside the eligible catalog', async () => {
    const runner = {
      config: { agent: preparer([]) },
      runRaw: vi.fn(async () => ({
        status: 'success', runId: 'selection-run', output: { selectedAgentId: 'invented', reason: 'No reason.' }, stepsUsed: 1,
        usage: { promptTokens: 1, completionTokens: 1, estimatedCostUSD: 0 },
      }) as RunResult),
    } satisfies TaskPreparationRunner;

    await expect(selectAgentProfile(runner, {
      originalObjective: 'Do work',
      candidates: [candidate('fallback')],
      workspaceRoot: '/workspace',
      attachments: { images: [], files: [], audio: [] },
      sessionId: 'session-1',
    })).rejects.toThrow('unknown or ineligible');
  });
});

function candidate(id: string, overrides: Partial<AgentSdkCatalogAgent> = {}): AgentSdkCatalogAgent {
  return {
    id,
    name: id,
    configPath: `/agents/${id}.json`,
    path: `/agents/${id}.json`,
    active: false,
    archived: false,
    configurationFingerprint: `${id}-fingerprint`,
    validationState: 'valid',
    invocationModes: ['run'],
    defaultInvocationMode: 'run',
    tools: [],
    delegates: [],
    ...overrides,
  };
}

function preparer(tools: string[], delegates: string[] = []) {
  return {
    id: 'task-preparer',
    name: 'Task Preparer',
    invocationModes: ['run'] as const,
    defaultInvocationMode: 'run' as const,
    model: { provider: 'ollama' as const, model: 'test' },
    tools,
    delegates,
  };
}
