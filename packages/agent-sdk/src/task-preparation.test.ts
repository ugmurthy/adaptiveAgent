import { describe, expect, it, vi } from 'vitest';
import type { RunResult } from '@adaptive-agent/core';

import { prepareTask, validateTaskPreparationOutput, type TaskPreparationRunner } from './task-preparation.js';
import type { AgentConfigFile } from './config-types.js';

describe('task preparation', () => {
  it('runs a tool-free structured preparation request and validates the result', async () => {
    const runRaw = vi.fn(async () => ({
      status: 'success',
      runId: '11111111-1111-4111-8111-111111111111',
      output: {
        decision: 'enhance',
        preparedObjective: 'Review authentication code and report prioritized findings with evidence.',
        assumptions: ['Review means security and correctness review.'],
        clarificationQuestions: [],
        reason: 'The requested scope and deliverable were unspecified.',
      },
      stepsUsed: 1,
      usage: { promptTokens: 10, completionTokens: 10, estimatedCostUSD: 0 },
    }) as RunResult);
    const runner = { config: { agent: agent('task-preparer', []) }, runRaw } satisfies TaskPreparationRunner;

    const result = await prepareTask(runner, {
      mode: 'auto',
      originalObjective: 'review the auth code',
      targetAgent: agent('reviewer', ['read_file']),
      workspaceRoot: '/workspace',
      attachments: { images: [], files: [], audio: [] },
    });

    expect(result).toMatchObject({
      decision: 'enhance',
      preparationAgentId: 'task-preparer',
      preparationRunId: '11111111-1111-4111-8111-111111111111',
    });
    expect(runRaw).toHaveBeenCalledWith(expect.stringContaining('Enhancement mode is auto'), expect.objectContaining({
      forbiddenTools: [],
      outputSchema: expect.objectContaining({ type: 'object' }),
      input: expect.objectContaining({ originalObjective: 'review the auth code' }),
    }));
  });

  it('preserves complete objectives in auto mode', () => {
    expect(validateTaskPreparationOutput({
      decision: 'complete',
      preparedObjective: 'An unnecessary rewrite',
      assumptions: [],
      clarificationQuestions: [],
      reason: 'The task is already executable.',
    }, { mode: 'auto', originalObjective: 'Run the test suite.' })).toMatchObject({
      decision: 'complete',
      preparedObjective: 'Run the test suite.',
    });
  });

  it('turns complete into enhance in always mode and rejects empty enhancements', () => {
    expect(validateTaskPreparationOutput({
      decision: 'complete',
      preparedObjective: 'Run all tests and report any failures.',
      assumptions: [],
      clarificationQuestions: [],
      reason: 'Made the deliverable explicit.',
    }, { mode: 'always', originalObjective: 'run tests' })).toMatchObject({
      decision: 'enhance',
      preparedObjective: 'Run all tests and report any failures.',
    });
    expect(() => validateTaskPreparationOutput({
      decision: 'enhance',
      preparedObjective: '',
      assumptions: [],
      clarificationQuestions: [],
      reason: 'Missing output.',
    }, { mode: 'always', originalObjective: 'run tests' })).toThrow('did not return a prepared objective');
  });

  it('requires questions when clarification is requested', () => {
    expect(() => validateTaskPreparationOutput({
      decision: 'clarify',
      preparedObjective: '',
      assumptions: [],
      clarificationQuestions: [],
      reason: 'The requested release action is ambiguous.',
    }, { mode: 'auto', originalObjective: 'update the release' })).toThrow('without returning any questions');
  });
});

function agent(id: string, tools: string[]): AgentConfigFile {
  return {
    id,
    name: id,
    invocationModes: ['run'],
    defaultInvocationMode: 'run',
    model: { provider: 'ollama', model: 'test' },
    tools,
  };
}
