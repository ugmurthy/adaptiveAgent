import { describe, expect, it, vi } from 'vitest';

import type { JsonValue, RunResult } from '@adaptive-agent/core';

import type { AgentSdkCatalogAgent } from './config-types.js';
import {
  ExecutionRoutingConfidenceError,
  selectExecutionRoutingWithAgent,
  selectExecutionRoutingWithTypeSafe,
  selectStagedExecutionRoutingWithTypeSafe,
} from './adaptive-execution-routing.js';
import { executionRoutingMetadata } from './run-decision.js';
import type { TaskPreparationRunner } from './task-preparation.js';
import type { TypeSafeAgentSelectionClient, TypeSafeAgentSelectionResponse } from './typesafe-agent-selection.js';

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
    expect(executionRoutingMetadata(result)).not.toHaveProperty('relevance');
    const input = runRaw.mock.calls[0]?.[1]?.input;
    expect(JSON.stringify(input)).not.toContain('/private/image.png');
    expect(JSON.stringify(input)).not.toContain('/private/audio.wav');
  });

  it('builds a validated candidate-by-modality orchestration decision from TypeSafe answers', async () => {
    const evaluate = vi.fn(async (_request: Parameters<TypeSafeAgentSelectionClient['evaluate']>[0]) => ({
      model: 'jev-test',
      usage: { input_tokens: 71, output_tokens: 9 },
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
    expect(executionRoutingMetadata(result)).toMatchObject({
      relevance: 0.91,
      confidence: 0.91,
      routingModel: 'jev-test',
      typesafe: { usage: { inputTokens: 71, outputTokens: 9 } },
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
      usage: { input_tokens: 71, output_tokens: 9 },
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

    expect(result.usage).toEqual({ inputTokens: 71, outputTokens: 9 });
    expect(executionRoutingMetadata(result)).toMatchObject({ confidence: 0.9, relevance: 0.93 });
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

  it('asks for mode before direct whole-task selection and never asks assignment questions', async () => {
    const requests: Array<Parameters<TypeSafeAgentSelectionClient['evaluate']>[0]> = [];
    const client: TypeSafeAgentSelectionClient = { async evaluate(input): Promise<TypeSafeAgentSelectionResponse> {
      requests.push(input);
      return requests.length === 1
        ? { model: 'jev-test', usage: { input_tokens: 20, output_tokens: 2 }, answers: { execution_mode: choice('direct', 0.85) } }
        : { model: 'jev-test', usage: { input_tokens: 30, output_tokens: 3 }, answers: {
          candidate_0_relevant: noul(0.92), selection: choice('general', 0.9),
        } };
    } };
    const result = await selectStagedExecutionRoutingWithTypeSafe(client, request([
      candidate('general', ['text', 'image', 'audio']),
      candidate('image', ['text', 'image']),
    ]), 'jev-test');
    expect(requests.map((input) => Object.keys(input.questions))).toEqual([
      ['execution_mode'], ['candidate_0_relevant'],
    ]);
    expect(result.decision).toMatchObject({ mode: 'direct', primaryAgentId: 'general', confidence: 0.85 });
    expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 5 });
    expect(result.stages.map((stage) => stage.name)).toEqual(['mode', 'selection']);
  });

  it('asks only orchestration branch questions and assigns a distinct specialist', async () => {
    const requests: Array<Parameters<TypeSafeAgentSelectionClient['evaluate']>[0]> = [];
    const client: TypeSafeAgentSelectionClient = { async evaluate(input): Promise<TypeSafeAgentSelectionResponse> {
      requests.push(input);
      return requests.length === 1
        ? { model: 'jev-test', answers: { execution_mode: choice('orchestration', 0.88) } }
        : { model: 'jev-test', answers: {
          orchestration_primary: choice('general', 0.91),
          assignment_text: choice('general', 0.93),
          assignment_image: choice('image', 0.94),
          assignment_audio: choice('audio', 0.92),
          candidate_0_text_relevant: noul(0.95),
          candidate_0_primary_relevant: noul(0.96),
          candidate_1_image_relevant: noul(0.94),
          candidate_2_audio_relevant: noul(0.92),
        } };
    } };
    const result = await selectStagedExecutionRoutingWithTypeSafe(client, request([
      candidate('general', ['text', 'image', 'audio']),
      candidate('image', ['image']), candidate('audio', ['audio']),
    ]), 'jev-test');
    expect(Object.keys(requests[0]!.questions)).toEqual(['execution_mode']);
    expect(requests[1]!.questions).not.toHaveProperty('direct_primary');
    expect(requests[1]!.questions).not.toHaveProperty('execution_mode');
    expect(requests[1]!.questions).toHaveProperty('assignment_image');
    expect(requests[1]!.questions.assignment_image).toMatchObject({ criteria: { image: { profile: '`candidates[1]`' } } });
    expect(JSON.stringify(requests[1]!.questions)).not.toContain('image description');
    expect(result.decision).toMatchObject({ mode: 'orchestration', primaryAgentId: 'general', confidence: 0.88,
      assignments: [{ agentId: 'general', modalities: ['text'] }, { agentId: 'image', modalities: ['image'] }, { agentId: 'audio', modalities: ['audio'] }] });
  });

  it('uses lower-ranked probabilities to respect the specialist budget', async () => {
    const client: TypeSafeAgentSelectionClient = { async evaluate(): Promise<TypeSafeAgentSelectionResponse> {
      return { model: 'jev-test', answers: {
        assignment_text: choice('general', 0.95),
        assignment_image: { type: 'choice', choice: 'image', confidence: 0.6,
          probabilities: { image: 0.6, media: 0.4 } },
        assignment_audio: { type: 'choice', choice: 'audio', confidence: 0.6,
          probabilities: { audio: 0.6, media: 0.4 } },
        candidate_0_text_relevant: noul(0.95), candidate_0_primary_relevant: noul(0.96),
        candidate_1_image_relevant: noul(0.9), candidate_2_audio_relevant: noul(0.9),
        candidate_3_image_relevant: noul(0.88), candidate_3_audio_relevant: noul(0.87),
      } };
    } };
    const result = await selectStagedExecutionRoutingWithTypeSafe(client, request([
      candidate('general', ['text']), candidate('image', ['image']),
      candidate('audio', ['audio']), candidate('media', ['image', 'audio']),
    ], 1), 'jev-test');
    expect(result.decision.assignments).toEqual([
      expect.objectContaining({ agentId: 'general', modalities: ['text'] }),
      expect.objectContaining({ agentId: 'media', modalities: ['image', 'audio'] }),
    ]);
    expect(result.decision.confidence).toBe(0.4);
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
