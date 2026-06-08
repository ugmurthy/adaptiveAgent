import { AdaptiveAgent } from './adaptive-agent.js';
import type {
  AgentRun,
  JsonValue,
  OrchestrationMetadata,
  RunResult,
  RunStatus,
  RunStore,
  SwarmExecutionDescriptor,
  SwarmExecutionRequest,
  SwarmQualityAssessment,
  SwarmRequest,
  SwarmRetryRequest,
  SwarmRetryResult,
  SwarmRunResult,
  SwarmSubtask,
  SwarmSubtaskResult,
  UUID,
} from './types.js';

export interface SwarmCoordinatorOptions {
  runStore: RunStore;
  coordinatorAgent: AdaptiveAgent;
  workerAgents: Record<string, AdaptiveAgent>;
  coordinatorAgentId?: string;
  defaultWorkerAgentId?: string;
  qualityAgent: AdaptiveAgent;
  qualityAgentId?: string;
  synthesizerAgent: AdaptiveAgent;
  synthesizerAgentId?: string;
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

    const descriptor = this.createExecutionDescriptor({
      sessionId,
      coordinatorRunId,
      topLevelObjective: request.topLevelObjective,
      input: request.input,
      contentParts: request.contentParts,
      maxWorkers,
      subtasks: request.subtasks,
    });
    await this.patchRunMetadata(coordinatorRunId, {
      swarmExecution: descriptor as unknown as JsonValue,
    });

    const subtaskResults = await runWithConcurrency(request.subtasks, maxWorkers, (subtask) =>
      this.runWorker({ sessionId, coordinatorRunId, topLevelObjective: request.topLevelObjective, subtask }),
    );

    return this.runFinalizers({
      sessionId,
      coordinatorRunId,
      topLevelObjective: request.topLevelObjective,
      subtasks: request.subtasks,
      subtaskResults,
    });
  }

  async retrySession(request: SwarmRetryRequest): Promise<SwarmRetryResult> {
    if (!this.options.runStore.listBySession) {
      throw new Error('Run store does not support session lookup; cannot retry a swarm session');
    }

    const sessionRuns = await this.options.runStore.listBySession(request.sessionId);
    if (sessionRuns.length === 0) {
      throw new Error(`Session ${request.sessionId} has no runs`);
    }

    const swarmRuns = sessionRuns.filter((run) => readOrchestrationMetadata(run)?.kind === 'swarm');
    if (swarmRuns.length === 0) {
      throw new Error(`Session ${request.sessionId} is not a swarm session`);
    }

    const coordinatorRunIds = unique(swarmRuns.map((run) => readOrchestrationMetadata(run)?.coordinatorRunId).filter(isNonEmptyString));
    if (coordinatorRunIds.length !== 1) {
      throw new Error(`Session ${request.sessionId} contains ${coordinatorRunIds.length} swarm coordinator runs; retry requires exactly one`);
    }

    const coordinatorRunId = coordinatorRunIds[0];
    const coordinatorRun = swarmRuns.find((run) => run.id === coordinatorRunId) ?? await this.options.runStore.getRun(coordinatorRunId);
    if (!coordinatorRun) {
      throw new Error(`Swarm coordinator run ${coordinatorRunId} does not exist`);
    }

    const activeRun = swarmRuns.find((run) => isActiveRunStatus(run.status));
    if (activeRun) {
      throw new Error(`Cannot retry swarm session ${request.sessionId}; run ${activeRun.id} is ${activeRun.status}`);
    }

    const descriptor = readSwarmExecutionDescriptor(coordinatorRun);
    if (!descriptor) {
      throw new Error(`Swarm coordinator run ${coordinatorRunId} has no persisted swarmExecution descriptor; retry the failed run directly with --run-id`);
    }

    await this.acquireCoordinatorLease(coordinatorRunId);
    try {
      const refreshedRuns = await this.options.runStore.listBySession(request.sessionId);
      const refreshedSwarmRuns = refreshedRuns.filter((run) => readOrchestrationMetadata(run)?.coordinatorRunId === coordinatorRunId);
      const refreshedActiveRun = refreshedSwarmRuns.find((run) => isActiveRunStatus(run.status));
      if (refreshedActiveRun) {
        throw new Error(`Cannot retry swarm session ${request.sessionId}; run ${refreshedActiveRun.id} is ${refreshedActiveRun.status}`);
      }

      const latestWorkerRuns = latestWorkerRunBySubtask(refreshedSwarmRuns);
      const failedWorkers = descriptor.subtasks.flatMap((subtask) => {
        const run = latestWorkerRuns.get(subtask.id);
        return run?.status === 'failed' ? [{ subtask, run }] : [];
      });

      const skippedWorkerRunIds: SwarmRetryResult['skippedWorkerRunIds'] = [];
      for (const { subtask, run } of failedWorkers) {
        const workerAgent = this.resolveWorkerAgent(subtask);
        if (!workerAgent) {
          skippedWorkerRunIds.push({ runId: run.id, reason: `No configured worker agent for subtask ${subtask.id}` });
          continue;
        }

        const retryability = await workerAgent.getRetryability(run.id);
        if (!retryability.retryable) {
          skippedWorkerRunIds.push({ runId: run.id, reason: retryability.reason ?? `Run ${run.id} is not retryable` });
        }
      }

      if (skippedWorkerRunIds.length > 0 && !request.allowPartial) {
        throw new Error(`Swarm session ${request.sessionId} has non-retryable worker runs: ${skippedWorkerRunIds.map((entry) => `${entry.runId}: ${entry.reason}`).join('; ')}`);
      }

      const latestQuality = latestRunByRole(refreshedSwarmRuns, 'quality');
      const latestSynthesizer = latestRunByRole(refreshedSwarmRuns, 'synthesizer');
      const shouldRunFinalizers = failedWorkers.length > skippedWorkerRunIds.length
        || latestQuality?.status === 'failed'
        || latestSynthesizer?.status === 'failed'
        || coordinatorRun.status === 'failed';
      if (!shouldRunFinalizers) {
        throw new Error(`Swarm session ${request.sessionId} has no failed worker, quality, or synthesizer runs to retry`);
      }

      if (request.dryRun) {
        return {
          sessionId: request.sessionId,
          coordinatorRunId,
          retriedWorkerRunIds: [],
          skippedWorkerRunIds,
          qualityRunId: latestQuality?.id,
          synthesizerRunId: latestSynthesizer?.id,
          status: coordinatorRun.status,
          output: coordinatorRun.result,
          subtaskResults: buildSubtaskResultsFromRuns(descriptor.subtasks, latestWorkerRuns),
        };
      }

      const retriedWorkerRunIds: UUID[] = [];
      const retryableFailedWorkers = failedWorkers.filter(({ run }) => !skippedWorkerRunIds.some((entry) => entry.runId === run.id));
      const maxWorkers = Math.max(1, request.maxWorkers ?? descriptor.maxWorkers ?? this.options.defaultMaxWorkers ?? 4);
      await runWithConcurrency(retryableFailedWorkers, maxWorkers, async ({ subtask, run }) => {
        const workerAgent = this.resolveWorkerAgent(subtask);
        if (!workerAgent) return;
        await workerAgent.retry(run.id);
        retriedWorkerRunIds.push(run.id);
      });

      const afterRetryRuns = await this.options.runStore.listBySession(request.sessionId);
      const afterRetrySwarmRuns = afterRetryRuns.filter((run) => readOrchestrationMetadata(run)?.coordinatorRunId === coordinatorRunId);
      const afterRetryWorkerRuns = latestWorkerRunBySubtask(afterRetrySwarmRuns);
      const subtaskResults = buildSubtaskResultsFromRuns(descriptor.subtasks, afterRetryWorkerRuns);
      const remainingFailedWorker = subtaskResults.find((result) => result.status === 'failed');
      if (remainingFailedWorker && !request.allowPartial) {
        await this.finalizeCoordinator({
          sessionId: request.sessionId,
          coordinatorRunId,
          subtaskResults,
          status: 'failed',
          errorCode: remainingFailedWorker.errorCode,
          errorMessage: remainingFailedWorker.errorMessage,
        });
        return {
          sessionId: request.sessionId,
          coordinatorRunId,
          retriedWorkerRunIds,
          skippedWorkerRunIds,
          status: 'failed',
          errorCode: remainingFailedWorker.errorCode,
          errorMessage: remainingFailedWorker.errorMessage,
          subtaskResults,
        };
      }

      const finalResult = await this.runFinalizers({
        sessionId: request.sessionId,
        coordinatorRunId,
        topLevelObjective: descriptor.topLevelObjective,
        subtasks: descriptor.subtasks,
        subtaskResults,
        previousQualityRunId: latestQuality?.id,
        previousSynthesizerRunId: latestSynthesizer?.id,
      });

      return {
        sessionId: request.sessionId,
        coordinatorRunId,
        retriedWorkerRunIds,
        skippedWorkerRunIds,
        qualityRunId: finalResult.qualityRunId,
        synthesizerRunId: finalResult.synthesizerRunId,
        status: finalResult.status,
        output: finalResult.output,
        errorCode: finalResult.errorCode,
        errorMessage: finalResult.errorMessage,
        subtaskResults: finalResult.subtaskResults,
        qualityAssessments: finalResult.qualityAssessments,
      };
    } finally {
      await this.options.runStore.releaseLease(coordinatorRunId, coordinatorLeaseOwner(coordinatorRunId));
    }
  }

  private async runFinalizers(params: {
    sessionId: string;
    coordinatorRunId: UUID;
    topLevelObjective: string;
    subtasks: SwarmSubtask[];
    subtaskResults: SwarmSubtaskResult[];
    previousQualityRunId?: UUID;
    previousSynthesizerRunId?: UUID;
  }): Promise<SwarmRunResult> {
    const qualityAttempt = params.previousQualityRunId ? 2 : undefined;

    const qualityResult = await this.options.qualityAgent.run({
      sessionId: params.sessionId,
      goal: 'Assess swarm worker outputs against the top-level objective and subtask objectives.',
      input: {
        topLevelObjective: params.topLevelObjective,
        subtasks: params.subtasks as unknown as JsonValue,
        subtaskResults: params.subtaskResults as unknown as JsonValue,
      },
      outputSchema: qualityOutputSchema,
      metadata: {
        orchestration: orchestrationMetadata(params.coordinatorRunId, 'quality', undefined, this.options.qualityAgentId, qualityAttempt, params.previousQualityRunId) as unknown as JsonValue,
      },
    });
    const qualityRunId = qualityResult.runId;
    const qualityAssessments = qualityResult.status === 'success'
      ? normalizeQualityAssessments(qualityResult.output, qualityRunId)
      : undefined;

    const synthesizerInput = {
      topLevelObjective: params.topLevelObjective,
      subtasks: params.subtasks as unknown as JsonValue,
      subtaskResults: params.subtaskResults as unknown as JsonValue,
      qualityAssessments: (qualityAssessments ?? []) as unknown as JsonValue,
      ...(qualityResult.status === 'failure' ? { qualityError: qualityResult.error } : {}),
    } satisfies Record<string, JsonValue>;

    const synthesizerAttempt = params.previousSynthesizerRunId ? 2 : undefined;

    const synthesizerResult = await this.options.synthesizerAgent.run({
      sessionId: params.sessionId,
      goal: 'Synthesize the final response for the top-level objective from worker results and quality assessments.',
      input: synthesizerInput,
      metadata: {
        orchestration: orchestrationMetadata(params.coordinatorRunId, 'synthesizer', undefined, this.options.synthesizerAgentId, synthesizerAttempt, params.previousSynthesizerRunId) as unknown as JsonValue,
      },
    });

    if (synthesizerResult.status === 'success') {
      return this.finalizeCoordinator({
        sessionId: params.sessionId,
        coordinatorRunId: params.coordinatorRunId,
        subtaskResults: params.subtaskResults,
        qualityRunId,
        synthesizerRunId: synthesizerResult.runId,
        qualityAssessments,
        status: 'succeeded',
        output: synthesizerResult.output,
      });
    }

    return this.finalizeCoordinator({
      sessionId: params.sessionId,
      coordinatorRunId: params.coordinatorRunId,
      subtaskResults: params.subtaskResults,
      qualityRunId,
      synthesizerRunId: synthesizerResult.runId,
      qualityAssessments,
      status: 'failed',
      errorCode: resultErrorCode(synthesizerResult),
      errorMessage: resultErrorMessage(synthesizerResult),
    });
  }

  private createExecutionDescriptor(params: {
    sessionId: string;
    coordinatorRunId: UUID;
    topLevelObjective: string;
    input?: JsonValue;
    contentParts?: SwarmExecutionDescriptor['contentParts'];
    maxWorkers: number;
    subtasks: SwarmSubtask[];
  }): SwarmExecutionDescriptor {
    return {
      schemaVersion: 1,
      sessionId: params.sessionId,
      coordinatorRunId: params.coordinatorRunId,
      topLevelObjective: params.topLevelObjective,
      ...(params.input === undefined ? {} : { input: params.input }),
      ...(params.contentParts === undefined ? {} : { contentParts: params.contentParts }),
      maxWorkers: params.maxWorkers,
      subtasks: params.subtasks,
      agents: {
        ...(this.options.coordinatorAgentId ? { coordinatorAgentId: this.options.coordinatorAgentId } : {}),
        workerAgentIds: Object.fromEntries(params.subtasks.map((subtask) => [subtask.id, subtask.targetAgentId ?? this.options.defaultWorkerAgentId ?? ''])),
        ...(this.options.qualityAgentId ? { qualityAgentId: this.options.qualityAgentId } : {}),
        ...(this.options.synthesizerAgentId ? { synthesizerAgentId: this.options.synthesizerAgentId } : {}),
      },
    };
  }

  private resolveWorkerAgent(subtask: SwarmSubtask): AdaptiveAgent | undefined {
    const targetAgentId = subtask.targetAgentId ?? this.options.defaultWorkerAgentId;
    return targetAgentId ? this.options.workerAgents[targetAgentId] : undefined;
  }

  private async acquireCoordinatorLease(coordinatorRunId: UUID): Promise<void> {
    const acquired = await this.options.runStore.tryAcquireLease({
      runId: coordinatorRunId,
      owner: coordinatorLeaseOwner(coordinatorRunId),
      ttlMs: 10 * 60 * 1000,
      now: new Date(),
    });
    if (!acquired) {
      throw new Error(`Swarm coordinator run ${coordinatorRunId} is already leased`);
    }
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
        orchestration: orchestrationMetadata(params.coordinatorRunId, 'worker', params.subtask.id, targetAgentId) as unknown as JsonValue,
      },
    });
    const run = await this.options.runStore.getRun(result.runId);
    return runResultToSubtaskResult(params.subtask.id, result, run);
  }

  private async patchRunMetadata(runId: UUID, metadata: Record<string, JsonValue>): Promise<void> {
    const run = await this.options.runStore.getRun(runId);
    if (!run) return;
    await this.options.runStore.updateRun(runId, { metadata: { ...(run.metadata ?? {}), ...metadata } }, run.version);
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
  agentId?: string,
  attempt?: number,
  supersedesRunId?: UUID,
): OrchestrationMetadata {
  return {
    kind: 'swarm',
    coordinatorRunId,
    role,
    ...(subtaskId ? { subtaskId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(attempt ? { attempt } : {}),
    ...(supersedesRunId ? { supersedesRunId } : {}),
  };
}

function readOrchestrationMetadata(run: AgentRun): OrchestrationMetadata | undefined {
  const raw = run.metadata?.orchestration;
  if (!isRecord(raw)) return undefined;
  if (raw.kind !== 'swarm') return undefined;
  if (!isNonEmptyString(raw.coordinatorRunId)) return undefined;
  if (raw.role !== 'coordinator' && raw.role !== 'worker' && raw.role !== 'quality' && raw.role !== 'synthesizer') return undefined;
  return {
    kind: 'swarm',
    coordinatorRunId: raw.coordinatorRunId,
    role: raw.role,
    ...(isNonEmptyString(raw.subtaskId) ? { subtaskId: raw.subtaskId } : {}),
    ...(isNonEmptyString(raw.agentId) ? { agentId: raw.agentId } : {}),
    ...(typeof raw.attempt === 'number' ? { attempt: raw.attempt } : {}),
    ...(isNonEmptyString(raw.supersedesRunId) ? { supersedesRunId: raw.supersedesRunId } : {}),
  };
}

function readSwarmExecutionDescriptor(run: AgentRun): SwarmExecutionDescriptor | undefined {
  const raw = run.metadata?.swarmExecution;
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== 1) return undefined;
  if (!isNonEmptyString(raw.sessionId) || !isNonEmptyString(raw.coordinatorRunId) || !isNonEmptyString(raw.topLevelObjective)) return undefined;
  if (!Array.isArray(raw.subtasks)) return undefined;
  const subtasks = raw.subtasks.filter(isSwarmSubtask);
  if (subtasks.length !== raw.subtasks.length) return undefined;
  const agents = isRecord(raw.agents) ? raw.agents : {};
  const workerAgentIds = isRecord(agents.workerAgentIds)
    ? Object.fromEntries(Object.entries(agents.workerAgentIds).filter((entry): entry is [string, string] => isNonEmptyString(entry[0]) && isNonEmptyString(entry[1])))
    : {};
  return {
    schemaVersion: 1,
    sessionId: raw.sessionId,
    coordinatorRunId: raw.coordinatorRunId,
    topLevelObjective: raw.topLevelObjective,
    ...(isJsonValue(raw.input) ? { input: raw.input } : {}),
    ...(Array.isArray(raw.contentParts) ? { contentParts: raw.contentParts as SwarmExecutionDescriptor['contentParts'] } : {}),
    maxWorkers: typeof raw.maxWorkers === 'number' && Number.isFinite(raw.maxWorkers) && raw.maxWorkers > 0 ? raw.maxWorkers : 4,
    subtasks,
    agents: {
      ...(isNonEmptyString(agents.coordinatorAgentId) ? { coordinatorAgentId: agents.coordinatorAgentId } : {}),
      workerAgentIds,
      ...(isNonEmptyString(agents.qualityAgentId) ? { qualityAgentId: agents.qualityAgentId } : {}),
      ...(isNonEmptyString(agents.synthesizerAgentId) ? { synthesizerAgentId: agents.synthesizerAgentId } : {}),
    },
  };
}

function isSwarmSubtask(value: unknown): value is SwarmSubtask {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.id)
    && isNonEmptyString(value.subObjective)
    && (value.input === undefined || isJsonValue(value.input))
    && (value.attachmentRefs === undefined || (Array.isArray(value.attachmentRefs) && value.attachmentRefs.every(isNonEmptyString)))
    && (value.targetAgentId === undefined || isNonEmptyString(value.targetAgentId))
    && (value.metadata === undefined || isJsonRecord(value.metadata));
}

function isActiveRunStatus(status: RunStatus): boolean {
  return status === 'queued'
    || status === 'planning'
    || status === 'running'
    || status === 'awaiting_approval'
    || status === 'awaiting_subagent'
    || status === 'interrupted'
    || status === 'clarification_requested';
}

function latestWorkerRunBySubtask(runs: AgentRun[]): Map<string, AgentRun> {
  const result = new Map<string, AgentRun>();
  for (const run of [...runs].sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
    const metadata = readOrchestrationMetadata(run);
    if (metadata?.role === 'worker' && metadata.subtaskId) {
      result.set(metadata.subtaskId, run);
    }
  }
  return result;
}

function latestRunByRole(runs: AgentRun[], role: OrchestrationMetadata['role']): AgentRun | undefined {
  return runs
    .filter((run) => readOrchestrationMetadata(run)?.role === role)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

function buildSubtaskResultsFromRuns(subtasks: SwarmSubtask[], runsBySubtask: Map<string, AgentRun>): SwarmSubtaskResult[] {
  return subtasks.map((subtask) => {
    const run = runsBySubtask.get(subtask.id);
    if (!run) {
      const syntheticRunId = crypto.randomUUID();
      return {
        subtaskId: subtask.id,
        runId: syntheticRunId,
        rootRunId: syntheticRunId,
        status: 'failed',
        errorCode: 'TOOL_ERROR',
        errorMessage: `No worker run found for subtask ${subtask.id}`,
      };
    }

    return runToSubtaskResult(subtask.id, run);
  });
}

function runToSubtaskResult(subtaskId: string, run: AgentRun): SwarmSubtaskResult {
  if (run.status === 'succeeded') {
    return {
      subtaskId,
      runId: run.id,
      rootRunId: run.rootRunId,
      status: 'succeeded',
      output: run.result,
    };
  }
  return {
    subtaskId,
    runId: run.id,
    rootRunId: run.rootRunId,
    status: run.status,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
  };
}

function coordinatorLeaseOwner(coordinatorRunId: UUID): string {
  return `swarm-retry:${coordinatorRunId}`;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
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
