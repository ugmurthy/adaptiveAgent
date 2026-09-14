import type { JsonSchema, JsonValue, RunResult } from '@adaptive-agent/core';

import type { AgentSdkCatalogAgent } from './config-types.js';
import type { TaskPreparationAttachmentSummary, TaskPreparationRunner } from './task-preparation.js';

export interface AgentSelectionResult {
  selectedAgentId: string;
  reason: string;
  selectionAgentId: string;
  selectionRunId: string;
}

export interface SelectAgentRequest {
  originalObjective: string;
  candidates: AgentSdkCatalogAgent[];
  workspaceRoot: string;
  attachments: TaskPreparationAttachmentSummary;
  sessionId: string;
}

export async function selectAgentProfile(
  runner: TaskPreparationRunner,
  request: SelectAgentRequest,
): Promise<AgentSelectionResult> {
  const candidates = request.candidates.filter((candidate) =>
    !candidate.archived
    && candidate.validationState === 'valid'
    && candidate.id !== runner.config.agent.id
    && candidate.invocationModes.includes('run'),
  );
  if (candidates.length === 0) throw new Error('Auto agent selection requires at least one valid active run profile.');

  const ids = candidates.map((candidate) => candidate.id);
  const outputSchema: JsonSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['selectedAgentId', 'reason'],
    properties: {
      selectedAgentId: { enum: ids },
      reason: { type: 'string', minLength: 1 },
    },
  };
  const result = await runner.runRaw(buildAgentSelectionGoal(), {
    sessionId: request.sessionId,
    input: {
      originalObjective: request.originalObjective,
      workspaceRoot: request.workspaceRoot,
      attachments: request.attachments as unknown as JsonValue,
      candidates: candidates.map(safeCandidateSummary) as unknown as JsonValue,
    },
    outputSchema,
    forbiddenTools: [...new Set([
      ...runner.config.agent.tools,
      ...(runner.config.agent.delegates ?? []).map((name) => `delegate.${name}`),
    ])],
    metadata: {
      command: 'agent-selection',
      role: 'agent-selector',
      candidateAgentIds: ids,
      agentSelection: {
        role: 'selector',
        originalObjective: request.originalObjective,
        candidateAgentIds: ids,
        workspaceRoot: request.workspaceRoot,
        attachments: request.attachments as unknown as JsonValue,
      },
    },
  });
  if (result.status !== 'success') throw new Error(formatSelectionFailure(result));
  if (!isRecord(result.output)) throw new Error('Agent selector returned a non-object result.');
  const selectedAgentId = result.output.selectedAgentId;
  if (typeof selectedAgentId !== 'string' || !ids.includes(selectedAgentId)) {
    throw new Error('Agent selector returned an unknown or ineligible selectedAgentId.');
  }
  const reason = result.output.reason;
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('Agent selector returned an empty reason.');
  return {
    selectedAgentId,
    reason: reason.trim(),
    selectionAgentId: runner.config.agent.id,
    selectionRunId: result.runId,
  };
}

function buildAgentSelectionGoal(): string {
  return [
    'Select the single best agent profile for the supplied objective.',
    'Return only the object required by outputSchema.',
    'Choose selectedAgentId only from the supplied candidates.',
    'Use profile descriptions, invocation modes, capabilities, tools, and delegates to match the task.',
    'Do not invent profiles, change the objective, or propose an execution strategy.',
    'Explain the decisive profile match briefly in reason.',
  ].join('\n');
}

function safeCandidateSummary(candidate: AgentSdkCatalogAgent): Record<string, JsonValue> {
  return {
    id: candidate.id,
    name: candidate.name,
    description: candidate.description ?? '',
    invocationModes: candidate.invocationModes,
    defaultInvocationMode: candidate.defaultInvocationMode,
    tools: candidate.tools,
    delegates: candidate.delegates,
    capabilities: (candidate.capabilities ?? {}) as JsonValue,
  };
}

function formatSelectionFailure(result: Exclude<RunResult, { status: 'success' }>): string {
  if (result.status === 'failure') return `Agent selection failed: ${result.code} ${result.error}`;
  return `Agent selection stopped with status ${result.status}: ${result.message}`;
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
