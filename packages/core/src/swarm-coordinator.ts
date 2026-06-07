import { AdaptiveAgent } from './adaptive-agent.js';
import type {
  AgentRun,
  JsonValue,
  OrchestrationMetadata,
  RunResult,
  RunStatus,
  RunStore,
  SwarmExecutionRequest,
  SwarmQualityAssessment,
  SwarmRequest,
  SwarmRunResult,
  SwarmSubtask,
  SwarmSubtaskResult,
  UUID,
} from './types.js';

export interface SwarmCoordinatorOptions {
  runStore: RunStore;
  coordinatorAgent: AdaptiveAgent;
  workerAgents: Record<string, AdaptiveAgent>;
  defaultWorkerAgentId?: string;
  qualityAgent: AdaptiveAgent;
  synthesizerAgent: AdaptiveAgent;
  defaultMaxWorkers?: number;
}

export class SwarmCoordinator {
  constructor(private readonly options: SwarmCoordinatorOptions) {}

  async run(request: SwarmRequest): Promise<SwarmRunResult> {
    const sessionId = request.sessionId ?? crypto.randomUUID();
    const coordinatorResult = await this.options.coordinatorAgent.run({
      sessionId,
      goal: request.topLevelObjective,
      input: request.input,
      contentParts: request.contentParts,
      context: {
        topLevelObjective: request.topLevelObjective,
        phase: 'swarm.decompose',
        instructions: [
          'Decompose the top-level objective into independent text-only subtasks.',
          'Return structured subtasks with id, subObjective, optional input, and optional targetAgentId.',
        ],
      },
      outputSchema: createSwarmDecompositionOutputSchema(Object.keys(this.options.workerAgents)),
      metadata: {
        ...(request.metadata ?? {}),
        orchestration: {
          kind: 'swarm',
          coordinatorRunId: 'pending',
          role: 'coordinator',
        } as unknown as JsonValue,
      },
    });
    const coordinatorRunId = coordinatorResult.runId;

    if (coordinatorResult.status !== 'success') {
      return this.finalizeCoordinator({
        sessionId,
        coordinatorRunId,
        subtaskResults: [],
        status: 'failed',
        errorCode: resultErrorCode(coordinatorResult),
        errorMessage: resultErrorMessage(coordinatorResult),
      });
    }

    let subtasks: SwarmSubtask[];
    try {
      subtasks = normalizeSubtasks(coordinatorResult.output);
    } catch (error) {
      return this.finalizeCoordinator({
        sessionId,
        coordinatorRunId,
        subtaskResults: [],
        status: 'failed',
        errorCode: 'INVALID_DECOMPOSITION',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }

    return this.execute({
      sessionId,
      coordinatorRunId,
      topLevelObjective: request.topLevelObjective,
      input: request.input,
      contentParts: request.contentParts,
      maxWorkers: request.maxWorkers,
      metadata: request.metadata,
      subtasks,
    });
  }

  async execute(request: SwarmExecutionRequest): Promise<SwarmRunResult> {
    const sessionId = request.sessionId ?? crypto.randomUUID();
    const maxWorkers = Math.max(1, request.maxWorkers ?? this.options.defaultMaxWorkers ?? 4);
    const coordinatorRunId = request.coordinatorRunId ?? (await this.options.runStore.createRun({
      sessionId,
      goal: request.topLevelObjective,
      input: request.input,
      context: { topLevelObjective: request.topLevelObjective, phase: 'swarm.execute' },
      metadata: {
        ...(request.metadata ?? {}),
        orchestration: {
          kind: 'swarm',
          coordinatorRunId: 'pending',
          role: 'coordinator',
        } as unknown as JsonValue,
      },
      status: 'running',
    })).id;

    await this.patchRunMetadata(coordinatorRunId, {
      ...(request.metadata ?? {}),
      orchestration: orchestrationMetadata(coordinatorRunId, 'coordinator') as unknown as JsonValue,
    });

    const validation = validateSubtasks(request.subtasks, Object.keys(this.options.workerAgents), this.options.defaultWorkerAgentId);
    if (!validation.valid) {
      return this.finalizeCoordinator({
        sessionId,
        coordinatorRunId,
        subtaskResults: [],
        status: 'failed',
        errorCode: 'INVALID_DECOMPOSITION',
        errorMessage: validation.message,
        diagnostics: validation.diagnostics,
      });
    }

    const subtaskResults = await runWithConcurrency(request.subtasks, maxWorkers, (subtask) =>
      this.runWorker({ sessionId, coordinatorRunId, topLevelObjective: request.topLevelObjective, subtask }),
    );

    const qualityResult = await this.options.qualityAgent.run({
      sessionId,
      goal: 'Assess swarm worker outputs against the top-level objective and subtask objectives.',
      input: {
        topLevelObjective: request.topLevelObjective,
        subtasks: request.subtasks as unknown as JsonValue,
        subtaskResults: subtaskResults as unknown as JsonValue,
      },
      outputSchema: qualityOutputSchema,
      metadata: {
        orchestration: orchestrationMetadata(coordinatorRunId, 'quality') as unknown as JsonValue,
      },
    });
    const qualityRunId = qualityResult.runId;
    const qualityAssessments = qualityResult.status === 'success'
      ? normalizeQualityAssessments(qualityResult.output, qualityRunId)
      : undefined;

    const synthesizerInput = {
      topLevelObjective: request.topLevelObjective,
      subtasks: request.subtasks as unknown as JsonValue,
      subtaskResults: subtaskResults as unknown as JsonValue,
      qualityAssessments: (qualityAssessments ?? []) as unknown as JsonValue,
      ...(qualityResult.status === 'failure' ? { qualityError: qualityResult.error } : {}),
    } satisfies Record<string, JsonValue>;

    const synthesizerResult = await this.options.synthesizerAgent.run({
      sessionId,
      goal: 'Synthesize the final response for the top-level objective from worker results and quality assessments.',
      input: synthesizerInput,
      metadata: {
        orchestration: orchestrationMetadata(coordinatorRunId, 'synthesizer') as unknown as JsonValue,
      },
    });

    if (synthesizerResult.status === 'success') {
      return this.finalizeCoordinator({
        sessionId,
        coordinatorRunId,
        subtaskResults,
        qualityRunId,
        synthesizerRunId: synthesizerResult.runId,
        qualityAssessments,
        status: 'succeeded',
        output: synthesizerResult.output,
      });
    }

    return this.finalizeCoordinator({
      sessionId,
      coordinatorRunId,
      subtaskResults,
      qualityRunId,
      synthesizerRunId: synthesizerResult.runId,
      qualityAssessments,
      status: 'failed',
      errorCode: resultErrorCode(synthesizerResult),
      errorMessage: resultErrorMessage(synthesizerResult),
    });
  }

  private async runWorker(params: {
    sessionId: string;
    coordinatorRunId: UUID;
    topLevelObjective: string;
    subtask: SwarmSubtask;
  }): Promise<SwarmSubtaskResult> {
    const targetAgentId = params.subtask.targetAgentId ?? this.options.defaultWorkerAgentId;
    const workerAgent = targetAgentId ? this.options.workerAgents[targetAgentId] : undefined;
    if (!workerAgent) {
      const syntheticRunId = crypto.randomUUID();
      return {
        subtaskId: params.subtask.id,
        runId: syntheticRunId,
        rootRunId: syntheticRunId,
        status: 'failed',
        errorCode: 'TOOL_ERROR',
        errorMessage: targetAgentId
          ? `Unknown swarm worker agent ${targetAgentId}`
          : 'Swarm subtask did not specify targetAgentId and no defaultWorkerAgentId is configured',
      };
    }

    const result = await workerAgent.run({
      sessionId: params.sessionId,
      goal: params.subtask.subObjective,
      input: params.subtask.input,
      contentParts: [],
      context: {
        topLevelObjective: params.topLevelObjective,
        subtaskId: params.subtask.id,
        attachmentRefs: (params.subtask.attachmentRefs ?? []) as unknown as JsonValue,
      },
      metadata: {
        ...(params.subtask.metadata ?? {}),
        orchestration: orchestrationMetadata(params.coordinatorRunId, 'worker', params.subtask.id) as unknown as JsonValue,
      },
    });
    const run = await this.options.runStore.getRun(result.runId);
    return runResultToSubtaskResult(params.subtask.id, result, run);
  }

  private async patchRunMetadata(runId: UUID, metadata: Record<string, JsonValue>): Promise<void> {
    const run = await this.options.runStore.getRun(runId);
    if (!run) return;
    await this.options.runStore.updateRun(runId, { metadata }, run.version);
  }

  private async finalizeCoordinator(result: SwarmRunResult): Promise<SwarmRunResult> {
    const run = await this.options.runStore.getRun(result.coordinatorRunId);
    if (run) {
      await this.options.runStore.updateRun(
        result.coordinatorRunId,
        {
          status: result.status,
          result: result as unknown as JsonValue,
          errorCode: result.errorCode,
          errorMessage: result.errorMessage,
        },
        run.version,
      );
    }
    return result;
  }
}

function orchestrationMetadata(
  coordinatorRunId: UUID,
  role: OrchestrationMetadata['role'],
  subtaskId?: string,
): OrchestrationMetadata {
  return {
    kind: 'swarm',
    coordinatorRunId,
    role,
    ...(subtaskId ? { subtaskId } : {}),
  };
}

function normalizeSubtasks(output: JsonValue): SwarmSubtask[] {
  const raw = readArray(output, 'subtasks') ?? (Array.isArray(output) ? output : undefined);
  if (!raw || raw.length === 0) {
    throw new Error('Swarm decomposition produced no subtasks');
  }
  return raw.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`Swarm subtask ${index + 1} is not an object`);
    }
    const id = readString(item.id) ?? `subtask-${index + 1}`;
    const subObjective = readString(item.subObjective) ?? readString(item.goal) ?? readString(item.objective);
    if (!subObjective) {
      throw new Error(`Swarm subtask ${id} is missing subObjective`);
    }
    return {
      id,
      subObjective,
      input: isJsonValue(item.input) ? item.input : undefined,
      attachmentRefs: Array.isArray(item.attachmentRefs) ? item.attachmentRefs.filter((ref): ref is string => typeof ref === 'string' && ref.length > 0) : undefined,
      targetAgentId: readString(item.targetAgentId),
      metadata: isJsonRecord(item.metadata) ? item.metadata : undefined,
    };
  });
}

function validateSubtasks(
  subtasks: SwarmSubtask[],
  validWorkerAgentIds: string[],
  defaultWorkerAgentId: string | undefined,
): { valid: true } | { valid: false; message: string; diagnostics: JsonValue } {
  const issues: string[] = [];
  const ids = new Set<string>();
  const workerIds = new Set(validWorkerAgentIds);

  if (subtasks.length === 0) {
    issues.push('Swarm decomposition produced no subtasks');
  }

  for (let index = 0; index < subtasks.length; index += 1) {
    const subtask = subtasks[index];
    const label = subtask.id?.trim() ? subtask.id.trim() : `#${index + 1}`;
    if (!subtask.id?.trim()) {
      issues.push(`Swarm subtask ${index + 1} is missing id`);
    } else if (ids.has(subtask.id)) {
      issues.push(`Swarm subtask id "${subtask.id}" is duplicated`);
    } else {
      ids.add(subtask.id);
    }

    if (!subtask.subObjective?.trim()) {
      issues.push(`Swarm subtask ${label} is missing subObjective`);
    }

    if (!subtask.targetAgentId) {
      if (!defaultWorkerAgentId) {
        issues.push(`Swarm subtask ${label} is missing targetAgentId`);
      }
    } else if (!workerIds.has(subtask.targetAgentId)) {
      issues.push(`Swarm subtask ${label} targets unknown worker agent "${subtask.targetAgentId}"`);
    }
  }

  if (issues.length === 0) return { valid: true };
  return {
    valid: false,
    message: issues.join('; '),
    diagnostics: {
      issues,
      validWorkerAgentIds,
      defaultWorkerAgentId: defaultWorkerAgentId ?? null,
    } as JsonValue,
  };
}

function normalizeQualityAssessments(output: JsonValue, runId: UUID): SwarmQualityAssessment[] {
  const raw = readArray(output, 'assessments') ?? (Array.isArray(output) ? output : []);
  return raw.flatMap((item, index) => {
    if (!isRecord(item)) return [];
    const recommendation = readRecommendation(item.recommendation) ?? 'use';
    return [{
      subtaskId: readString(item.subtaskId) ?? `subtask-${index + 1}`,
      runId: readString(item.runId) ?? runId,
      usable: typeof item.usable === 'boolean' ? item.usable : recommendation === 'use',
      score: typeof item.score === 'number' ? item.score : undefined,
      issues: Array.isArray(item.issues) ? item.issues.filter((issue): issue is string => typeof issue === 'string') : undefined,
      recommendation,
    }];
  });
}

function runResultToSubtaskResult(subtaskId: string, result: RunResult, run: AgentRun | null): SwarmSubtaskResult {
  if (result.status === 'success') {
    return {
      subtaskId,
      runId: result.runId,
      rootRunId: run?.rootRunId ?? result.runId,
      status: 'succeeded',
      output: result.output,
    };
  }
  return {
    subtaskId,
    runId: result.runId,
    rootRunId: run?.rootRunId ?? result.runId,
    status: resultStatus(result),
    errorCode: resultErrorCode(result),
    errorMessage: resultErrorMessage(result),
  };
}

async function runWithConcurrency<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await run(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function resultStatus(result: RunResult): RunStatus {
  switch (result.status) {
    case 'success':
      return 'succeeded';
    case 'clarification_requested':
      return 'clarification_requested';
    case 'approval_requested':
      return 'awaiting_approval';
    case 'failure':
      return 'failed';
  }
}

function resultErrorCode(result: RunResult): string | undefined {
  return result.status === 'failure' ? result.code : undefined;
}

function resultErrorMessage(result: RunResult): string | undefined {
  if (result.status === 'failure') return result.error;
  if (result.status === 'clarification_requested' || result.status === 'approval_requested') return result.message;
  return undefined;
}

function readArray(value: JsonValue, key: string): JsonValue[] | undefined {
  return isRecord(value) && Array.isArray(value[key]) ? value[key] : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readRecommendation(value: unknown): SwarmQualityAssessment['recommendation'] | undefined {
  return value === 'use' || value === 'ignore' || value === 'retry' || value === 'needs_human' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonRecord(value: unknown): value is Record<string, JsonValue> {
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonRecord(value);
}

export function createSwarmDecompositionOutputSchema(workerAgentIds: string[] = []) {
  const targetAgentId = workerAgentIds.length > 0
    ? { type: 'string', enum: workerAgentIds }
    : { type: 'string' };
  return {
    type: 'object',
    required: ['subtasks'],
    additionalProperties: false,
    properties: {
      subtasks: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['id', 'subObjective'],
          additionalProperties: true,
          properties: {
            id: { type: 'string' },
            subObjective: { type: 'string' },
            input: {},
            attachmentRefs: { type: 'array', items: { type: 'string' } },
            targetAgentId,
            metadata: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
  };
}

const qualityOutputSchema = {
  type: 'object',
  required: ['assessments'],
  additionalProperties: false,
  properties: {
    assessments: {
      type: 'array',
      items: {
        type: 'object',
        required: ['subtaskId', 'usable', 'recommendation'],
        additionalProperties: true,
        properties: {
          subtaskId: { type: 'string' },
          runId: { type: 'string' },
          usable: { type: 'boolean' },
          score: { type: 'number' },
          issues: { type: 'array', items: { type: 'string' } },
          recommendation: { type: 'string', enum: ['use', 'ignore', 'retry', 'needs_human'] },
        },
      },
    },
  },
};
