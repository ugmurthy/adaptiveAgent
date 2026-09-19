import { TypeSafeClient } from '@typesafe-ai/sdk';
import type { JsonValue } from '@adaptive-agent/core';

import {
  attachmentModalities,
  eligibleAgentSelectionCandidates,
  safeCandidateSummary,
  type AgentSelectionResult,
  type SelectAgentRequest,
} from './agent-selection.js';
import type { TypeSafeAgentSelectionPolicyConfig } from './config-types.js';
import { readJson, resolvePath } from './sdk-utils.js';

const DEFAULT_POLICY: Required<TypeSafeAgentSelectionPolicyConfig> = {
  relevance: {
    instructions: 'Is the referenced candidate agent a strong match for the objective and every requested attachment modality?',
    criteria: {
      true: 'The profile has the capabilities and tools needed to complete the objective and handle every attachment type.',
      false: 'The profile is mismatched, lacks a required capability, or another specialist is clearly more appropriate.',
    },
  },
  selection: {
    instructions: 'Which candidate agent is the single best profile for completing the objective with the supplied attachment types?',
    candidateCriteria: 'Prefer the narrowest capable specialist. Consider profile description, capabilities, tools, and delegates.',
  },
  minimumRelevance: 0.5,
  minimumConfidence: 0.5,
};

interface TypeSafeAnswerBase {
  type: string;
}

interface TypeSafeNoulAnswer extends TypeSafeAnswerBase {
  type: 'noul';
  noul: number;
}

interface TypeSafeChoiceAnswer extends TypeSafeAnswerBase {
  type: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface TypeSafeAgentSelectionResponse {
  model: string;
  answers: Record<string, TypeSafeNoulAnswer | TypeSafeChoiceAnswer>;
}

export interface TypeSafeAgentSelectionClient {
  evaluate(request: {
    model: string;
    state: JsonValue;
    questions: Record<string, JsonValue>;
  }): Promise<TypeSafeAgentSelectionResponse>;
}

export interface CreateTypeSafeAgentSelectionClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export function createTypeSafeAgentSelectionClient(
  options: CreateTypeSafeAgentSelectionClientOptions,
): TypeSafeAgentSelectionClient {
  const client = new TypeSafeClient({
    apiKey: options.apiKey,
    ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
    ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
  });
  return {
    async evaluate(request) {
      return await client.systemOne(request as unknown as Parameters<TypeSafeClient['systemOne']>[0]) as TypeSafeAgentSelectionResponse;
    },
  };
}

export async function loadTypeSafeAgentSelectionPolicy(
  cwd: string,
  policyPath: string | undefined,
  inline: TypeSafeAgentSelectionPolicyConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TypeSafeAgentSelectionPolicyConfig> {
  const supplied = policyPath
    ? await readJson(resolvePath(cwd, policyPath, env))
    : inline;
  return normalizePolicy(supplied);
}

export async function selectAgentProfileWithTypeSafe(
  client: TypeSafeAgentSelectionClient,
  request: SelectAgentRequest,
  model: string,
  policyInput?: TypeSafeAgentSelectionPolicyConfig,
): Promise<AgentSelectionResult> {
  const candidates = eligibleAgentSelectionCandidates(request);
  if (candidates.length === 0) {
    const modalities = attachmentModalities(request.attachments);
    throw new Error(`Auto agent selection found no valid run profile supporting attachment modalities: ${modalities.join(', ') || 'text'}.`);
  }

  const policy = normalizePolicy(policyInput);
  const candidateSummaries = candidates.map(safeCandidateSummary);
  const questions: Record<string, JsonValue> = {};
  candidates.forEach((candidate, index) => {
    questions[`candidate_${index}_relevant`] = {
      type: 'noul',
      instructions: {
        question: policy.relevance.instructions ?? null,
        objective: '`objective`',
        attachmentTypes: '`attachments.types`',
        candidate: `\`candidates[${index}]\``,
      },
      criteria: policy.relevance.criteria ?? null,
    };
  });
  if (candidates.length > 1) {
    questions.selection = {
      type: 'choice',
      instructions: policy.selection.instructions ?? null,
      criteria: Object.fromEntries(candidates.map((candidate, index) => [
        candidate.id,
        {
          profile: candidateSummaries[index],
          ...(policy.selection.candidateCriteria === undefined
            ? {}
            : { guidance: policy.selection.candidateCriteria }),
        },
      ])),
    };
  }

  const response = await client.evaluate({
    model,
    state: {
      objective: request.originalObjective,
      attachments: {
        types: attachmentModalities(request.attachments),
        counts: {
          images: request.attachments.images.length,
          files: request.attachments.files.length,
          audio: request.attachments.audio.length,
        },
      },
      candidates: candidateSummaries,
    },
    questions,
  });
  const selection = response.answers.selection;
  if (candidates.length > 1 && (!selection || selection.type !== 'choice')) {
    throw new Error('TypeSafe agent selector returned an invalid selection answer.');
  }
  const selectedAgentId = candidates.length === 1
    ? candidates[0].id
    : (selection as TypeSafeChoiceAnswer).choice;
  const confidence = candidates.length === 1 ? 1 : (selection as TypeSafeChoiceAnswer).confidence;
  const probabilities = candidates.length === 1
    ? { [selectedAgentId]: 1 }
    : (selection as TypeSafeChoiceAnswer).probabilities;
  const selectedIndex = candidates.findIndex((candidate) => candidate.id === selectedAgentId);
  if (selectedIndex < 0) throw new Error('TypeSafe agent selector returned an unknown or ineligible agent id.');
  const relevanceAnswer = response.answers[`candidate_${selectedIndex}_relevant`];
  if (!relevanceAnswer || relevanceAnswer.type !== 'noul') {
    throw new Error('TypeSafe agent selector returned an invalid relevance answer for the selected agent.');
  }
  if (!isProbability(confidence) || !isProbability(relevanceAnswer.noul)) {
    throw new Error('TypeSafe agent selector returned confidence or relevance outside the range 0 to 1.');
  }
  if (confidence < policy.minimumConfidence) {
    throw new Error(`TypeSafe agent selection confidence ${confidence.toFixed(3)} is below the configured minimum ${policy.minimumConfidence.toFixed(3)}.`);
  }
  if (relevanceAnswer.noul < policy.minimumRelevance) {
    throw new Error(`TypeSafe relevance ${relevanceAnswer.noul.toFixed(3)} for agent "${selectedAgentId}" is below the configured minimum ${policy.minimumRelevance.toFixed(3)}.`);
  }

  return {
    selectedAgentId,
    reason: `TypeSafe selected "${selectedAgentId}" with confidence ${confidence.toFixed(3)} and relevance ${relevanceAnswer.noul.toFixed(3)}.`,
    selectionAgentId: `typesafe:${response.model}`,
    selectionModel: response.model,
    confidence,
    relevance: relevanceAnswer.noul,
    probabilities,
  };
}

function normalizePolicy(input: unknown): Required<TypeSafeAgentSelectionPolicyConfig> {
  if (input !== undefined && !isRecord(input)) {
    throw new Error('TypeSafe agent selection policy must be a JSON object.');
  }
  const supplied = input as TypeSafeAgentSelectionPolicyConfig | undefined;
  if (supplied?.relevance !== undefined && !isRecord(supplied.relevance)) {
    throw new Error('TypeSafe agent selection policy relevance must be an object.');
  }
  if (supplied?.relevance?.criteria !== undefined && !isRecord(supplied.relevance.criteria)) {
    throw new Error('TypeSafe agent selection policy relevance.criteria must be an object.');
  }
  if (supplied?.selection !== undefined && !isRecord(supplied.selection)) {
    throw new Error('TypeSafe agent selection policy selection must be an object.');
  }
  const policy = {
    relevance: {
      ...DEFAULT_POLICY.relevance,
      ...(supplied?.relevance ?? {}),
      criteria: {
        ...DEFAULT_POLICY.relevance.criteria,
        ...(supplied?.relevance?.criteria ?? {}),
      },
    },
    selection: {
      ...DEFAULT_POLICY.selection,
      ...(supplied?.selection ?? {}),
    },
    minimumRelevance: supplied?.minimumRelevance ?? DEFAULT_POLICY.minimumRelevance,
    minimumConfidence: supplied?.minimumConfidence ?? DEFAULT_POLICY.minimumConfidence,
  };
  if (!isProbability(policy.minimumRelevance) || !isProbability(policy.minimumConfidence)) {
    throw new Error('TypeSafe agent selection thresholds must be numbers between 0 and 1.');
  }
  return policy;
}

function isProbability(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
