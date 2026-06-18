import {
  SwarmCoordinator,
  createSwarmDecompositionOutputSchema,
  type JsonValue,
  type ModelContentPart,
  type RunResult,
  type SwarmSubtask,
} from '@adaptive-agent/core';

import type { AgentConfigFile, AgentSdk } from './index.js';

const STRICT_SWARM_SUBTASK_OUTPUT_KEYS = new Set(['id', 'subObjective', 'input', 'attachmentRefs', 'targetAgentId']);

const SWARM_DECOMPOSITION_INSTRUCTIONS = [
  'Decompose the top-level objective into independent subtasks.',
  'Each subtask targetAgentId must exactly match one id from validWorkerAgentIds.',
  'Each subtask must include id, subObjective, input, attachmentRefs, and targetAgentId.',
  'Use input as a compact string or null, and use attachmentRefs [] when there is no attachment reference.',
  'Return only structured subtasks; do not invent worker ids.',
] as const;

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseSwarmSubtasks(output: JsonValue): SwarmSubtask[] {
  const raw = isRecordValue(output) && Array.isArray(output.subtasks)
    ? output.subtasks
    : Array.isArray(output) ? output : undefined;
  if (!raw || raw.length === 0) throw new Error('Coordinator produced no subtasks');
  return raw.map((item, index) => {
    if (!isRecordValue(item)) throw new Error(`Coordinator subtask ${index + 1} is not an object`);
    const unsupportedKeys = Object.keys(item).filter((key) => !STRICT_SWARM_SUBTASK_OUTPUT_KEYS.has(key));
    if (unsupportedKeys.length > 0) throw new Error(`Coordinator subtask ${index + 1} includes unsupported keys: ${unsupportedKeys.join(', ')}`);
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const subObjective = typeof item.subObjective === 'string' ? item.subObjective.trim() : '';
    if (!id) throw new Error(`Coordinator subtask ${index + 1} is missing id`);
    if (!subObjective) throw new Error(`Coordinator subtask ${id} is missing subObjective`);
    if (!Object.hasOwn(item, 'input')) throw new Error(`Coordinator subtask ${id} is missing input`);
    if (item.input !== null && typeof item.input !== 'string') throw new Error(`Coordinator subtask ${id} input must be a string or null`);
    if (!Array.isArray(item.attachmentRefs) || !item.attachmentRefs.every((ref) => typeof ref === 'string' && ref.length > 0)) {
      throw new Error(`Coordinator subtask ${id} attachmentRefs must be an array of strings`);
    }
    const attachmentRefs = item.attachmentRefs.filter((ref): ref is string => typeof ref === 'string' && ref.length > 0);
    if (typeof item.targetAgentId !== 'string' || item.targetAgentId.length === 0) throw new Error(`Coordinator subtask ${id} is missing targetAgentId`);
    return {
      id,
      subObjective,
      input: item.input,
      attachmentRefs,
      targetAgentId: item.targetAgentId,
    };
  });
}

export function validateSdkDecomposition(subtasks: SwarmSubtask[], validWorkerIds: string[]): void {
  const ids = new Set<string>();
  const validWorkers = new Set(validWorkerIds);
  const issues: string[] = [];
  for (const subtask of subtasks) {
    if (ids.has(subtask.id)) issues.push(`duplicate subtask id: ${subtask.id}`);
    ids.add(subtask.id);
    if (!subtask.targetAgentId) issues.push(`subtask ${subtask.id} is missing targetAgentId`);
    else if (!validWorkers.has(subtask.targetAgentId)) issues.push(`subtask ${subtask.id} targets unknown worker agent: ${subtask.targetAgentId}`);
  }
  if (issues.length > 0) throw new Error(`Invalid swarm decomposition: ${issues.join('; ')}. Valid worker ids: ${validWorkerIds.join(', ')}`);
}

function buildSwarmWorkerCatalog(workerAgents: readonly AgentConfigFile[]): JsonValue {
  return workerAgents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    description: agent.description ?? '',
    capabilities: (agent.capabilities ?? {}) as JsonValue,
  })) as unknown as JsonValue;
}

export interface SwarmDecompositionArgs {
  coordinatorSdk: AgentSdk;
  sessionId: string;
  topLevelObjective: string;
  inputJson: JsonValue | undefined;
  workerAgents: readonly AgentConfigFile[];
  workerIds: string[];
  contentParts?: ModelContentPart[];
}

export async function runSwarmDecomposition(args: SwarmDecompositionArgs): Promise<RunResult> {
  const contentParts = args.contentParts && args.contentParts.length > 0 ? args.contentParts : undefined;
  return args.coordinatorSdk.runRaw(args.topLevelObjective, {
    sessionId: args.sessionId,
    input: {
      originalInput: args.inputJson ?? null,
      workerCatalog: buildSwarmWorkerCatalog(args.workerAgents),
    },
    ...(contentParts ? { contentParts } : {}),
    context: {
      phase: 'swarm.decompose',
      topLevelObjective: args.topLevelObjective,
      validWorkerAgentIds: args.workerIds as unknown as JsonValue,
      instructions: [...SWARM_DECOMPOSITION_INSTRUCTIONS],
    },
    outputSchema: createSwarmDecompositionOutputSchema(args.workerIds),
    metadata: { orchestration: { kind: 'swarm', coordinatorRunId: 'pending', role: 'coordinator' } as unknown as JsonValue },
  });
}

export interface SwarmCoordinatorBuildArgs {
  coordinatorSdk: AgentSdk;
  workerSdks: readonly AgentSdk[];
  qualitySdk: AgentSdk;
  synthesizerSdk: AgentSdk;
  defaultMaxWorkers?: number;
}

export function buildSwarmCoordinator(args: SwarmCoordinatorBuildArgs): SwarmCoordinator {
  return new SwarmCoordinator({
    runStore: args.coordinatorSdk.created.runtime.runStore,
    coordinatorAgent: args.coordinatorSdk.agent,
    coordinatorAgentId: args.coordinatorSdk.config.agent.id,
    workerAgents: Object.fromEntries(args.workerSdks.map((sdk) => [sdk.config.agent.id, sdk.agent])),
    qualityAgent: args.qualitySdk.agent,
    qualityAgentId: args.qualitySdk.config.agent.id,
    synthesizerAgent: args.synthesizerSdk.agent,
    synthesizerAgentId: args.synthesizerSdk.config.agent.id,
    defaultMaxWorkers: args.defaultMaxWorkers,
  });
}
