import { describe, expect, it, vi } from 'vitest';

import type { JsonValue, RunResult } from '@adaptive-agent/core';

import type { AgentSdkCatalogAgent } from './config-types.js';
import {
  ExecutionRoutingConfidenceError,
  selectExecutionRoutingWithAgent,
  selectExecutionRoutingWithTypeSafe,
} from './adaptive-execution-routing.js';
import type { TaskPreparationRunner } from './task-preparation.js';
import type { TypeSafeAgentSelectionClient } from './typesafe-agent-selection.js';

describe('adaptive execution routing', () => {
  it('accepts a grouped multimodal decision from the agent engine without exposing paths', async () => {
    const runRaw = vi.fn(async (_goal: string, options?: { input?: JsonValue }) => success({
      mode: 'orchestration',
      primaryAgentId: 'general',
      synthesisAgentId: 'general',
      assignments: [
        { agentId: 'general', modalities: ['text'], reason: 'Synthesis' },
        { agentId: 'media', modalities: ['image', 'audio'], reason: 'Multimodal specialist' },
      ],
      reason: 'Use one media specialist.',
      confidence: 0.91,
    }));
    const runner = {
      config: { agent: { id: 'router', tools: [], delegates: [] } },
      runRaw,
    } as unknown as TaskPreparationRunner;

    const result = await selectExecutionRoutingWithAgent(runner, request([
      candidate('general', ['text']),
      candidate('media', ['text', 'image', 'audio']),
    ]), 0.8);

    expect(result.decision).toMatchObject({
      mode: 'orchestration',
      primaryAgentId: 'general',
      synthesisAgentId: 'general',
      source: 'agent',
      confidence: 0.91,
    });
    const input = runRaw.mock.calls[0]?.[1]?.input;
    expect(JSON.stringify(input)).not.toContain('/private/image.png');
    expect(JSON.stringify(input)).not.toContain('/private/audio.wav');
  });

  it('builds a validated candidate-by-modality orchestration decision from TypeSafe answers', async () => {
    const evaluate = vi.fn(async (_request: Parameters<TypeSafeAgentSelectionClient['evaluate']>[0]) => ({
      model: 'jev-test',
      answers: {
        orchestration_primary: choice('general', 0.94),
        assignment_text: choice('general', 0.93),
        candidate_0_text_relevant: noul(0.96),
        candidate_1_image_relevant: noul(0.91),
        candidate_2_audio_relevant: noul(0.92),
      },
    }));
    const client = { evaluate } satisfies TypeSafeAgentSelectionClient;

    const result = await selectExecutionRoutingWithTypeSafe(client, request([
      candidate('general', ['text']),
      candidate('image', ['text', 'image']),
      candidate('audio', ['text', 'audio']),
    ]), 'jev-test', { minimumConfidence: 0.8, minimumRelevance: 0.8 });

    expect(result.decision).toMatchObject({
      mode: 'orchestration',
      primaryAgentId: 'general',
      synthesisAgentId: 'general',
      assignments: [
        { agentId: 'general', modalities: ['text'] },
        { agentId: 'image', modalities: ['image'] },
        { agentId: 'audio', modalities: ['audio'] },
      ],
      source: 'typesafe',
      confidence: 0.91,
    });
    const evaluation = evaluate.mock.calls[0]![0];
    expect(evaluation.questions).toHaveProperty('candidate_1_image_relevant');
    expect(evaluation.questions).toHaveProperty('candidate_2_audio_relevant');
    expect(evaluation.questions).not.toHaveProperty('execution_mode');
    expect(JSON.stringify(evaluation.state)).not.toContain('/private/');
  });

  it('allows TypeSafe to choose direct execution when one profile covers every modality', async () => {
    const evaluate = vi.fn(async (_request: Parameters<TypeSafeAgentSelectionClient['evaluate']>[0]) => ({
      model: 'jev-test',
      answers: {
        execution_mode: choice('direct', 0.9),
        candidate_0_text_relevant: noul(0.95),
        candidate_0_image_relevant: noul(0.94),
        candidate_0_audio_relevant: noul(0.93),
      },
    }));

    const result = await selectExecutionRoutingWithTypeSafe({ evaluate }, request([
      candidate('multimodal', ['text', 'image', 'audio']),
      candidate('image', ['text', 'image']),
      candidate('audio', ['text', 'audio']),
    ]), 'jev-test', {
      routing: {
        modeInstructions: 'CUSTOM MODE',
        primaryInstructions: 'CUSTOM PRIMARY',
        assignmentInstructions: 'CUSTOM ASSIGNMENT',
      },
    });

    expect(result.decision).toMatchObject({
      mode: 'direct',
      primaryAgentId: 'multimodal',
      assignments: [{ agentId: 'multimodal', modalities: ['text', 'image', 'audio'] }],
    });
    const questions = evaluate.mock.calls[0]![0].questions;
    expect(questions.execution_mode).toMatchObject({ instructions: 'CUSTOM MODE' });
    expect(questions.orchestration_primary).toMatchObject({ instructions: 'CUSTOM PRIMARY' });
    expect(questions.assignment_image).toMatchObject({ instructions: 'CUSTOM ASSIGNMENT' });
  });

  it('enforces confidence and specialist limits before execution', async () => {
    const lowConfidenceRunner = {
      config: { agent: { id: 'router', tools: [], delegates: [] } },
      runRaw: async () => success({
        mode: 'direct',
        primaryAgentId: 'multimodal',
        assignments: [{ agentId: 'multimodal', modalities: ['text', 'image', 'audio'], reason: 'Direct' }],
        reason: 'Direct',
        confidence: 0.49,
      }),
    } as unknown as TaskPreparationRunner;
    await expect(selectExecutionRoutingWithAgent(lowConfidenceRunner, request([
      candidate('multimodal', ['text', 'image', 'audio']),
    ]), 0.5)).rejects.toBeInstanceOf(ExecutionRoutingConfidenceError);

    const tooManyRunner = {
      config: { agent: { id: 'router', tools: [], delegates: [] } },
      runRaw: async () => success({
        mode: 'orchestration',
        primaryAgentId: 'general',
        assignments: [
          { agentId: 'general', modalities: ['text'], reason: 'Primary' },
          { agentId: 'image', modalities: ['image'], reason: 'Image' },
          { agentId: 'audio', modalities: ['audio'], reason: 'Audio' },
        ],
        reason: 'Specialists',
        confidence: 0.9,
      }),
    } as unknown as TaskPreparationRunner;
    await expect(selectExecutionRoutingWithAgent(tooManyRunner, request([
      candidate('general', ['text']),
      candidate('image', ['text', 'image']),
      candidate('audio', ['text', 'audio']),
    ], 1))).rejects.toThrow('exceeding the configured maximum 1');
  });
});

function request(candidates: AgentSdkCatalogAgent[], maxSpecialists = 4) {
  return {
    originalObjective: 'Compare the image and audio.',
    candidates,
    workspaceRoot: '/workspace',
    attachments: {
      images: ['/private/image.png'],
      files: [],
      audio: ['/private/audio.wav'],
    },
    sessionId: 'session-1',
    maxSpecialists,
  };
}

function candidate(id: string, modalitiesSupported: Array<'text' | 'image' | 'file' | 'audio'>): AgentSdkCatalogAgent {
  return {
    id,
    name: id,
    description: `${id} description`,
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
    capabilities: { modalitiesSupported },
  };
}

function success(output: JsonValue): RunResult {
  return {
    status: 'success',
    runId: 'routing-run',
    output,
    stepsUsed: 1,
    usage: { promptTokens: 1, completionTokens: 1, estimatedCostUSD: 0 },
  };
}

function choice(value: string, confidence: number) {
  return { type: 'choice' as const, choice: value, confidence, probabilities: { [value]: 1 } };
}

function noul(value: number) {
  return { type: 'noul' as const, noul: value };
}
