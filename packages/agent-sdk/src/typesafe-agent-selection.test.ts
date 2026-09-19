import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentSdkCatalogAgent, TypeSafeAgentSelectionPolicyConfig } from './config-types.js';
import {
  loadTypeSafeAgentSelectionPolicy,
  selectAgentProfileWithTypeSafe,
  type TypeSafeAgentSelectionClient,
} from './typesafe-agent-selection.js';

describe('TypeSafe agent selection', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('asks configurable relevance and choice questions over the prompt and attachment types', async () => {
    const evaluate = vi.fn(async (request) => ({
      model: 'jev-1.13.0',
      answers: {
        candidate_0_relevant: { type: 'noul' as const, noul: 0.24 },
        candidate_1_relevant: { type: 'noul' as const, noul: 0.93 },
        selection: {
          type: 'choice' as const,
          choice: 'vision',
          confidence: 0.87,
          probabilities: { general: 0.13, vision: 0.87 },
        },
      },
    }));
    const client = { evaluate } satisfies TypeSafeAgentSelectionClient;
    const policy: TypeSafeAgentSelectionPolicyConfig = {
      relevance: {
        instructions: { question: 'Can this profile inspect the supplied artifact?' },
        criteria: { true: 'It can inspect it directly.', false: 'It cannot inspect it.' },
      },
      selection: {
        instructions: ['Select the best artifact specialist.'],
        candidateCriteria: { priority: 'Prefer direct image analysis.' },
      },
      minimumConfidence: 0.8,
      minimumRelevance: 0.9,
    };

    const result = await selectAgentProfileWithTypeSafe(client, {
      originalObjective: 'Explain the architecture shown in this diagram.',
      candidates: [
        candidate('general', ['text', 'image']),
        candidate('vision', ['text', 'image'], 'Analyzes diagrams and screenshots.'),
        candidate('text-only', ['text']),
      ],
      workspaceRoot: '/workspace',
      attachments: { images: ['/private/diagram.png'], files: [], audio: [] },
      sessionId: 'session-1',
    }, 'jev-1.13.0', policy);

    expect(result).toMatchObject({
      selectedAgentId: 'vision',
      selectionAgentId: 'typesafe:jev-1.13.0',
      selectionModel: 'jev-1.13.0',
      confidence: 0.87,
      relevance: 0.93,
      probabilities: { general: 0.13, vision: 0.87 },
    });
    expect(evaluate).toHaveBeenCalledOnce();
    const request = evaluate.mock.calls[0][0];
    expect(request.state).toMatchObject({
      objective: 'Explain the architecture shown in this diagram.',
      attachments: { types: ['image'], counts: { images: 1, files: 0, audio: 0 } },
      candidates: [{ id: 'general' }, { id: 'vision' }],
    });
    expect(JSON.stringify(request.state)).not.toContain('/private/diagram.png');
    expect(request.questions).toMatchObject({
      candidate_0_relevant: {
        type: 'noul',
        instructions: { question: { question: 'Can this profile inspect the supplied artifact?' } },
      },
      selection: {
        type: 'choice',
        instructions: ['Select the best artifact specialist.'],
        criteria: {
          general: { guidance: { priority: 'Prefer direct image analysis.' } },
          vision: { guidance: { priority: 'Prefer direct image analysis.' } },
        },
      },
    });
    expect(request.questions).not.toHaveProperty('candidate_2_relevant');
  });

  it('rejects an uncertain choice at the configured confidence boundary', async () => {
    const client: TypeSafeAgentSelectionClient = {
      async evaluate() {
        return {
          model: 'jev-1.13.0',
          answers: {
            candidate_0_relevant: { type: 'noul', noul: 0.9 },
            candidate_1_relevant: { type: 'noul', noul: 0.9 },
            selection: {
              type: 'choice',
              choice: 'researcher',
              confidence: 0.69,
              probabilities: { researcher: 0.51, coder: 0.49 },
            },
          },
        };
      },
    };

    await expect(selectAgentProfileWithTypeSafe(client, request(), 'jev-1.13.0', {
      minimumConfidence: 0.7,
    })).rejects.toThrow('confidence 0.690 is below the configured minimum 0.700');
  });

  it('still checks relevance when attachment filtering leaves one candidate', async () => {
    const evaluate = vi.fn(async () => ({
      model: 'jev-1.13.0',
      answers: { candidate_0_relevant: { type: 'noul' as const, noul: 0.4 } },
    }));

    await expect(selectAgentProfileWithTypeSafe({ evaluate }, {
      originalObjective: 'Transcribe and analyze this recording.',
      candidates: [candidate('text-only'), candidate('audio', ['text', 'audio'])],
      workspaceRoot: '/workspace',
      attachments: { images: [], files: [], audio: ['recording.mp3'] },
      sessionId: 'session-1',
    }, 'jev-1.13.0', { minimumRelevance: 0.7 })).rejects.toThrow(
      'relevance 0.400 for agent "audio" is below the configured minimum 0.700',
    );
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({
      questions: {
        candidate_0_relevant: expect.objectContaining({ type: 'noul' }),
      },
    }));
  });

  it('loads a standalone policy file so questions can be tuned without code changes', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'typesafe-selection-policy-'));
    await writeFile(join(tempDir, 'routing-policy.json'), JSON.stringify({
      relevance: { instructions: 'Does this profile fit?' },
      selection: { instructions: 'Choose the best profile.' },
      minimumConfidence: 0.73,
      minimumRelevance: 0.66,
    }));

    await expect(loadTypeSafeAgentSelectionPolicy(tempDir, './routing-policy.json', undefined)).resolves.toMatchObject({
      relevance: { instructions: 'Does this profile fit?' },
      selection: { instructions: 'Choose the best profile.' },
      minimumConfidence: 0.73,
      minimumRelevance: 0.66,
    });
  });
});

function request() {
  return {
    originalObjective: 'Research and implement the change.',
    candidates: [candidate('researcher'), candidate('coder')],
    workspaceRoot: '/workspace',
    attachments: { images: [], files: [], audio: [] },
    sessionId: 'session-1',
  };
}

function candidate(
  id: string,
  modalitiesSupported: Array<'text' | 'image' | 'file' | 'audio'> = ['text'],
  description = id,
): AgentSdkCatalogAgent {
  return {
    id,
    name: id,
    description,
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
