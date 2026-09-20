import { describe, expect, it } from 'vitest';

import type { AgentConfigFile, SupportedModality } from './config-types.js';
import {
  buildDeterministicExecutionRoutingDecision,
  validateExecutionRoutingDecision,
  type ExecutionRoutingCatalogEntry,
} from './execution-routing.js';

describe('execution routing', () => {
  it('assigns image and audio to separate specialists', () => {
    const decision = decide([
      agent('requested', ['text']),
      agent('image-agent', ['text', 'image'], ['image']),
      agent('audio-agent', ['text', 'audio'], ['audio']),
    ], ['text', 'image', 'audio']);

    expect(decision.primaryAgentId).toBe('requested');
    expect(decision.synthesisAgentId).toBe('requested');
    expect(decision.assignments).toEqual([
      expect.objectContaining({ agentId: 'requested', modalities: ['text'] }),
      expect.objectContaining({ agentId: 'image-agent', modalities: ['image'] }),
      expect.objectContaining({ agentId: 'audio-agent', modalities: ['audio'] }),
    ]);
  });

  it('groups image and audio assigned to one multimodal specialist', () => {
    const decision = decide([
      agent('requested', ['text']),
      agent('media-agent', ['text', 'image', 'audio'], ['image', 'audio']),
    ], ['text', 'image', 'audio']);

    expect(decision.assignments).toEqual([
      expect.objectContaining({ agentId: 'requested', modalities: ['text'] }),
      expect.objectContaining({ agentId: 'media-agent', modalities: ['image', 'audio'] }),
    ]);
  });

  it('keeps the requested agent fixed when it handles all modalities without a specialist advantage', () => {
    const decision = decide([
      agent('requested', ['text', 'image', 'audio'], ['image', 'audio']),
      agent('media-agent', ['text', 'image', 'audio']),
    ], ['text', 'image', 'audio']);

    expect(decision.mode).toBe('orchestration');
    expect(decision.primaryAgentId).toBe('requested');
    expect(decision.synthesisAgentId).toBeUndefined();
    expect(decision.assignments).toEqual([
      expect.objectContaining({ agentId: 'requested', modalities: ['text', 'image', 'audio'] }),
    ]);
  });

  it('fails before execution when no catalog agent supports a modality', () => {
    expect(() => decide([agent('requested', ['text'])], ['text', 'audio']))
      .toThrow('No agent supports required modality "audio"');
  });

  it('breaks equally scored specialist ties by agent id', () => {
    const decision = decide([
      agent('requested', ['text']),
      agent('zeta', ['text', 'image'], ['image']),
      agent('alpha', ['text', 'image'], ['image']),
    ], ['text', 'image']);

    expect(decision.assignments).toContainEqual(expect.objectContaining({ agentId: 'alpha', modalities: ['image'] }));
  });

  it('rejects unknown IDs and unsupported proposed assignments at the engine-neutral boundary', () => {
    const catalog = catalogFor([agent('requested', ['text']), agent('image-agent', ['text', 'image'])]);
    expect(() => validateExecutionRoutingDecision({
      mode: 'orchestration',
      primaryAgentId: 'requested',
      assignments: [{ agentId: 'invented', modalities: ['image'], reason: 'proposal' }],
      selectedCatalogAgentIds: ['requested', 'invented'],
      reason: 'proposal',
      source: 'typesafe',
    }, ['image'], catalog)).toThrow('unknown agent "invented"');
    expect(() => validateExecutionRoutingDecision({
      mode: 'orchestration',
      primaryAgentId: 'requested',
      assignments: [{ agentId: 'requested', modalities: ['image'], reason: 'proposal' }],
      selectedCatalogAgentIds: ['requested'],
      reason: 'proposal',
      source: 'agent',
    }, ['image'], catalog)).toThrow('does not support assigned modality "image"');
  });
});

function decide(entries: AgentConfigFile[], detectedModalities: SupportedModality[]) {
  return buildDeterministicExecutionRoutingDecision({
    requestedAgentId: 'requested',
    detectedModalities,
    catalog: catalogFor(entries),
    forceOrchestration: true,
    synthesize: true,
  });
}

function catalogFor(entries: AgentConfigFile[]): Map<string, ExecutionRoutingCatalogEntry> {
  return new Map(entries.map((entry) => [entry.id, { agentId: entry.id, agentConfig: entry }]));
}

function agent(
  id: string,
  modalitiesSupported: SupportedModality[],
  modalitiesPreferred: SupportedModality[] = [],
): AgentConfigFile {
  return {
    id,
    name: id,
    invocationModes: ['run'],
    defaultInvocationMode: 'run',
    model: { provider: 'ollama', model: 'qwen3.5' },
    tools: [],
    capabilities: {
      modalitiesSupported,
      modalitiesPreferred,
      modalityRoles: Object.fromEntries(modalitiesPreferred.map((modality) => [modality, 'analyze'])),
    },
  };
}
