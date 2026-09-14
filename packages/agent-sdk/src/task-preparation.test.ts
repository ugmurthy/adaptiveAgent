import { describe, expect, it, vi } from 'vitest';
import type { AgentRun, RunResult } from '@adaptive-agent/core';

import { prepareTask, restoreTaskPreparation, validateTaskPreparationOutput, type TaskPreparationRunner } from './task-preparation.js';
import type { AgentConfigFile } from './config-types.js';

describe('task preparation', () => {
  it('runs a tool-free structured preparation request and validates the result', async () => {
    const runRaw = vi.fn(async () => ({
      status: 'success',
      runId: '11111111-1111-4111-8111-111111111111',
      output: {
        title: 'Review Authentication Code',
        name: 'review-authentication-code',
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
      sessionId: 'session-1',
    });

    expect(result).toMatchObject({
      originalObjective: 'review the auth code',
      title: 'Review Authentication Code',
      name: 'review-authentication-code',
      decision: 'enhance',
      preparationAgentId: 'task-preparer',
      preparationRunId: '11111111-1111-4111-8111-111111111111',
    });
    expect(runRaw).toHaveBeenCalledWith(expect.stringContaining('Enhancement mode is auto'), expect.objectContaining({
      sessionId: 'session-1',
      forbiddenTools: [],
      outputSchema: expect.objectContaining({
        type: 'object',
        required: expect.arrayContaining(['title', 'name']),
        properties: expect.objectContaining({ title: expect.any(Object), name: expect.any(Object) }),
      }),
      input: expect.objectContaining({ originalObjective: 'review the auth code' }),
      metadata: expect.objectContaining({
        taskPreparation: expect.objectContaining({ originalObjective: 'review the auth code' }),
      }),
    }));
  });

  it('restores and validates a successful persisted preparation', () => {
    const run = {
      id: '11111111-1111-4111-8111-111111111111',
      status: 'succeeded',
      input: {
        originalObjective: 'review the auth code',
        workspaceRoot: '/workspace',
        attachments: { images: [], files: [], audio: [] },
      },
      result: {
        title: 'Review Authentication Code',
        name: 'review-authentication-code',
        decision: 'enhance',
        preparedObjective: 'Review authentication code and report prioritized findings.',
        assumptions: [],
        clarificationQuestions: [],
        reason: 'Made the deliverable explicit.',
      },
      metadata: {
        agentId: 'task-preparer',
        command: 'task-preparation',
        role: 'task-preparer',
        targetAgentId: 'reviewer',
        preparationMode: 'auto',
      },
    } as unknown as AgentRun;

    expect(restoreTaskPreparation(run, {
      targetAgentId: 'reviewer',
      workspaceRoot: '/workspace',
      attachments: { images: [], files: [], audio: [] },
    })).toMatchObject({
      originalObjective: 'review the auth code',
      title: 'Review Authentication Code',
      name: 'review-authentication-code',
      decision: 'enhance',
      preparationAgentId: 'task-preparer',
      preparationRunId: run.id,
    });
    expect(() => restoreTaskPreparation(run, {
      targetAgentId: 'another-agent',
      workspaceRoot: '/workspace',
      attachments: { images: [], files: [], audio: [] },
    })).toThrow('targets agent');
  });

  it('keeps preparations stored before title and name reusable', () => {
    const run = {
      id: '11111111-1111-4111-8111-111111111111',
      status: 'succeeded',
      input: {
        originalObjective: 'review the auth code',
        workspaceRoot: '/workspace',
        attachments: { images: [], files: [], audio: [] },
      },
      result: {
        decision: 'enhance',
        preparedObjective: 'Review authentication code and report prioritized findings.',
        assumptions: [],
        clarificationQuestions: [],
        reason: 'Made the deliverable explicit.',
      },
      metadata: {
        agentId: 'task-preparer',
        command: 'task-preparation',
        role: 'task-preparer',
        targetAgentId: 'reviewer',
        preparationMode: 'auto',
      },
    } as unknown as AgentRun;

    expect(restoreTaskPreparation(run, {
      targetAgentId: 'reviewer',
      workspaceRoot: '/workspace',
      attachments: { images: [], files: [], audio: [] },
    })).toMatchObject({ title: 'review the auth code', name: 'task-11111111' });
  });

  it('preserves complete objectives in auto mode', () => {
    expect(validateTaskPreparationOutput({
      title: 'Run Test Suite',
      name: 'run-test-suite',
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
      title: 'Run Test Suite',
      name: 'run-test-suite',
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
      title: 'Run Test Suite',
      name: 'run-test-suite',
      decision: 'enhance',
      preparedObjective: '',
      assumptions: [],
      clarificationQuestions: [],
      reason: 'Missing output.',
    }, { mode: 'always', originalObjective: 'run tests' })).toThrow('did not return a prepared objective');
  });

  it('requires questions when clarification is requested', () => {
    expect(() => validateTaskPreparationOutput({
      title: 'Deploy Application',
      name: 'deploy-application',
      decision: 'clarify',
      preparedObjective: '',
      assumptions: [],
      clarificationQuestions: [],
      reason: 'The requested release action is ambiguous.',
    }, { mode: 'auto', originalObjective: 'update the release' })).toThrow('without returning any questions');
  });

  it('requires a concise title and kebab-case name', () => {
    const output = {
      title: 'Run Test Suite',
      name: 'run-test-suite',
      decision: 'complete',
      preparedObjective: 'Run the test suite.',
      assumptions: [],
      clarificationQuestions: [],
      reason: 'The task is already executable.',
    };

    expect(validateTaskPreparationOutput(output, { mode: 'auto', originalObjective: 'Run the test suite.' }))
      .toMatchObject({ title: 'Run Test Suite', name: 'run-test-suite' });
    expect(() => validateTaskPreparationOutput(
      { ...output, name: 'Run Test Suite' },
      { mode: 'auto', originalObjective: 'Run the test suite.' },
    )).toThrow('invalid name');
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
