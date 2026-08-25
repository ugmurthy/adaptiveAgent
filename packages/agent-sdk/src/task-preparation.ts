import type { JsonObject, JsonSchema, JsonValue, RunResult } from '@adaptive-agent/core';

import type { AgentConfigFile, AgentSdkRunOptions, TaskPreparationMode } from './config-types.js';

export type TaskPreparationDecision = 'complete' | 'enhance' | 'clarify' | 'invalid';

export interface TaskPreparationResult {
  decision: TaskPreparationDecision;
  preparedObjective: string;
  assumptions: string[];
  clarificationQuestions: string[];
  reason: string;
  preparationAgentId: string;
  preparationRunId: string;
}

export interface TaskPreparationAttachmentSummary {
  images: string[];
  files: string[];
  audio: string[];
}

export interface PrepareTaskRequest {
  mode: Exclude<TaskPreparationMode, 'never'>;
  originalObjective: string;
  targetAgent: AgentConfigFile;
  workspaceRoot: string;
  attachments: TaskPreparationAttachmentSummary;
  clarificationAnswers?: Record<string, string>;
}

export interface TaskPreparationRunner {
  config: { agent: AgentConfigFile };
  runRaw(goal: string, options?: AgentSdkRunOptions): Promise<RunResult>;
}

export const TASK_PREPARATION_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'preparedObjective', 'assumptions', 'clarificationQuestions', 'reason'],
  properties: {
    decision: { enum: ['complete', 'enhance', 'clarify', 'invalid'] },
    preparedObjective: { type: 'string' },
    assumptions: { type: 'array', items: { type: 'string' } },
    clarificationQuestions: { type: 'array', items: { type: 'string' } },
    reason: { type: 'string', minLength: 1 },
  },
};

export async function prepareTask(runner: TaskPreparationRunner, request: PrepareTaskRequest): Promise<TaskPreparationResult> {
  const result = await runner.runRaw(buildTaskPreparationGoal(request.mode), {
    input: {
      originalObjective: request.originalObjective,
      targetAgent: targetAgentSummary(request.targetAgent),
      workspaceRoot: request.workspaceRoot,
      attachments: request.attachments as unknown as JsonValue,
      ...(request.clarificationAnswers ? { clarificationAnswers: request.clarificationAnswers as unknown as JsonValue } : {}),
    },
    outputSchema: TASK_PREPARATION_OUTPUT_SCHEMA,
    forbiddenTools: runner.config.agent.tools,
    metadata: {
      command: 'task-preparation',
      role: 'task-preparer',
      targetAgentId: request.targetAgent.id,
      preparationMode: request.mode,
    },
  });
  if (result.status !== 'success') {
    throw new Error(formatTaskPreparationFailure(result));
  }
  return {
    ...validateTaskPreparationOutput(result.output, request),
    preparationAgentId: runner.config.agent.id,
    preparationRunId: result.runId,
  };
}

export function validateTaskPreparationOutput(output: JsonValue, request: Pick<PrepareTaskRequest, 'mode' | 'originalObjective'>): Omit<TaskPreparationResult, 'preparationAgentId' | 'preparationRunId'> {
  if (!isRecord(output)) throw new Error('Task preparer returned a non-object result.');
  const decision = output.decision;
  if (decision !== 'complete' && decision !== 'enhance' && decision !== 'clarify' && decision !== 'invalid') {
    throw new Error('Task preparer returned an invalid decision.');
  }
  const preparedObjective = readString(output.preparedObjective, 'preparedObjective');
  const assumptions = readStringArray(output.assumptions, 'assumptions');
  const clarificationQuestions = readStringArray(output.clarificationQuestions, 'clarificationQuestions');
  const reason = readString(output.reason, 'reason').trim();
  if (!reason) throw new Error('Task preparer returned an empty reason.');
  const normalizedDecision = request.mode === 'always' && decision === 'complete' ? 'enhance' : decision;
  if (normalizedDecision === 'enhance' && !preparedObjective.trim()) {
    throw new Error('Task preparer did not return a prepared objective.');
  }
  if (decision === 'clarify' && clarificationQuestions.length === 0) {
    throw new Error('Task preparer requested clarification without returning any questions.');
  }
  return {
    decision: normalizedDecision,
    preparedObjective: normalizedDecision === 'complete' ? request.originalObjective : preparedObjective.trim(),
    assumptions,
    clarificationQuestions,
    reason,
  };
}

function buildTaskPreparationGoal(mode: Exclude<TaskPreparationMode, 'never'>): string {
  return [
    'Prepare the supplied original objective for the resolved target agent.',
    'Return only the object required by outputSchema.',
    mode === 'always'
      ? 'Enhancement mode is always: return enhance with a useful preparedObjective unless essential missing information requires clarify or the request is invalid.'
      : 'Enhancement mode is auto: return complete when the original objective is already executable; otherwise return enhance, clarify, or invalid.',
    'Preserve explicit user intent and constraints. Add execution detail and completion criteria without inventing facts or permissions.',
    'Use assumptions for conservative inferences. Use clarify only when different answers would materially change the outcome.',
    'Never change the target agent, tools, model, runtime policy, approval requirements, or execution strategy.',
    'For complete, repeat the original objective in preparedObjective. For clarify or invalid, preparedObjective may be empty.',
  ].join('\n');
}

function targetAgentSummary(agent: AgentConfigFile): JsonObject {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description ?? '',
    invocationModes: agent.invocationModes,
    tools: agent.tools,
    delegates: agent.delegates ?? [],
    capabilities: (agent.capabilities ?? {}) as JsonValue,
  };
}

function formatTaskPreparationFailure(result: Exclude<RunResult, { status: 'success' }>): string {
  if (result.status === 'failure') return `Task preparation failed: ${result.code} ${result.error}`;
  return `Task preparation stopped with status ${result.status}: ${result.message}`;
}

function isRecord(value: JsonValue): value is JsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readString(value: JsonValue | undefined, name: string): string {
  if (typeof value !== 'string') throw new Error(`Task preparer returned an invalid ${name}.`);
  return value;
}

function readStringArray(value: JsonValue | undefined, name: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error(`Task preparer returned an invalid ${name}.`);
  }
  return value.map((entry) => entry.trim()).filter(Boolean);
}
