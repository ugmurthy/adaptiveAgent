import { AdaptiveAgent, assertValidExecutionContext } from './adaptive-agent.js';
import type {
  AgentRun,
  JsonValue,
  OrchestrationMetadata,
  RecoverRunResult,
  RunRecoveryPlan,
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

export interface SwarmRecoveryRequest {
  sessionId: string;
  /** Select a swarm when the session contains several coordinator executions. */
  coordinatorRunId?: UUID;
  /** Inspect and plan only. No run, lease, or metadata is mutated. */
  dryRun?: boolean;
  /** Explicit approval forwarded to core run recovery (for example continuation approval). Never approves pending tool calls. */
  requireApproval?: boolean;
}

export type SwarmRecoveryOutcome = 'planned' | 'completed' | 'failed' | 'blocked' | 'busy';

export interface SwarmRecoveryResult {
  sessionId: string;
  coordinatorRunId: UUID;
  outcome: SwarmRecoveryOutcome;
  /** Core recovery plans inspected for the current head run of each unfinished logical role. */
  plans: RunRecoveryPlan[];
  /** Core recovery actions executed (at most one per logical worker or finalizer). */
  actions: RecoverRunResult[];
  reason?: string;
  result?: SwarmRunResult;
  /** Fresh runs started during recovery: missing worker runs from the persisted descriptor, regenerated quality/synthesizer runs. */
  startedRunIds?: UUID[];
  /** Subtasks from the persisted descriptor that have no worker run yet. */
  missingWorkerSubtaskIds?: string[];
}

interface SwarmRecoveryContext {
  sessionId: string;
  coordinatorRunId: UUID;
  dryRun: boolean;
  requireApproval?: boolean;
  owner?: string;
  leaseHeld: boolean;
  plans: RunRecoveryPlan[];
  actions: RecoverRunResult[];
  startedRunIds: UUID[];
  missingWorkerSubtaskIds: string[];
}

interface SwarmRoleHeads {
  coordinator: AgentRun[];
  workers: Map<string, AgentRun>;
  quality?: AgentRun;
  synthesizer?: AgentRun;
}

const COORDINATOR_LEASE_TTL_MS = 10 * 60 * 1000;

export class SwarmCoordinator {
  constructor(private readonly options: SwarmCoordinatorOptions) {}

  async run(request: SwarmRequest): Promise<SwarmRunResult> {
    assertValidExecutionContext(request.executionContext);
    const sessionId = request.sessionId ?? crypto.randomUUID();
    const coordinatorResult = await this.options.coordinatorAgent.run({
      sessionId,
      goal: request.topLevelObjective,
      input: request.input,
      contentParts: request.contentParts,
      executionContext: request.executionContext,
      context: {
        topLevelObjective: request.topLevelObjective,
        phase: 'swarm.decompose',
        instructions: [
          'Decompose the top-level objective into independent text-only subtasks.',
          'Each subtask must include id, subObjective, input, attachmentRefs, and targetAgentId.',
          'Use input as a compact string or null, and use attachmentRefs [] when there is no attachment reference.',
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
      executionContext: request.executionContext,
      maxWorkers: request.maxWorkers,
      metadata: request.metadata,
      subtasks,
    });
  }

  async execute(request: SwarmExecutionRequest): Promise<SwarmRunResult> {
    assertValidExecutionContext(request.executionContext);
    const sessionId = request.sessionId ?? crypto.randomUUID();
    const maxWorkers = Math.max(1, request.maxWorkers ?? this.options.defaultMaxWorkers ?? 4);
    const coordinatorRun = request.coordinatorRunId
      ? await this.options.runStore.getRun(request.coordinatorRunId)
      : await this.options.runStore.createRun({
          sessionId,
          goal: request.topLevelObjective,
          input: request.input,
          context: { topLevelObjective: request.topLevelObjective, phase: 'swarm.execute' },
          executionContext: request.executionContext,
          metadata: {
            ...(request.metadata ?? {}),
            orchestration: {
              kind: 'swarm',
              coordinatorRunId: 'pending',
              role: 'coordinator',
            } as unknown as JsonValue,
          },
          status: 'running',
        });
    if (!coordinatorRun) {
      throw new Error(`Swarm coordinator run ${request.coordinatorRunId} does not exist`);
    }
    const coordinatorRunId = coordinatorRun.id;
    const executionContext = coordinatorRun.executionContext;

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
      this.runWorker({ sessionId, coordinatorRunId, topLevelObjective: request.topLevelObjective, executionContext, subtask }),
    );

    return this.runFinalizers({
      sessionId,
      coordinatorRunId,
      topLevelObjective: request.topLevelObjective,
      executionContext,
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
      const refreshedCoordinator = refreshedSwarmRuns.find((run) => run.id === coordinatorRunId) ?? coordinatorRun;
      const finalizersPending = !isFinalizedSwarmResult(refreshedCoordinator.result);
      const shouldRunFinalizers = failedWorkers.length > skippedWorkerRunIds.length
        || latestQuality?.status === 'failed'
        || latestSynthesizer?.status === 'failed'
        || refreshedCoordinator.status === 'failed'
        || finalizersPending;
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
        executionContext: coordinatorRun.executionContext,
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

  /**
   * General swarm session recovery.
   *
   * Selects the current head run of each unfinished logical role (following continuation and
   * supersession lineage), asks the owning agent for its core recovery plan, and executes at most
   * one core recovery per logical worker. Completed workers are preserved. Quality and synthesis
   * are recovered in place when their inputs are unchanged and regenerated when upstream worker
   * outputs changed. Never approves pending tool calls or clarifications.
   */
  async recoverSession(request: SwarmRecoveryRequest): Promise<SwarmRecoveryResult> {
    if (!this.options.runStore.listBySession) {
      throw new Error('Run store does not support session lookup; cannot recover a swarm session');
    }

    const sessionRuns = await this.options.runStore.listBySession(request.sessionId);
    if (sessionRuns.length === 0) {
      throw new Error(`Session ${request.sessionId} has no runs`);
    }
    const swarmRuns = sessionRuns.filter((run) => readOrchestrationMetadata(run) !== undefined);
    if (swarmRuns.length === 0) {
      throw new Error(`Session ${request.sessionId} is not a swarm session`);
    }
    const coordinatorRunIds = unique(swarmRuns.map((run) => logicalCoordinatorRunId(run, swarmRuns)).filter(isNonEmptyString))
      .filter((id) => !request.coordinatorRunId || id === request.coordinatorRunId);
    if (coordinatorRunIds.length !== 1) {
      throw new Error(`Session ${request.sessionId} contains ${coordinatorRunIds.length} swarm coordinator runs; recovery requires exactly one`);
    }

    const ctx: SwarmRecoveryContext = {
      sessionId: request.sessionId,
      coordinatorRunId: coordinatorRunIds[0],
      dryRun: request.dryRun === true,
      requireApproval: request.requireApproval,
      leaseHeld: false,
      plans: [],
      actions: [],
      startedRunIds: [],
      missingWorkerSubtaskIds: [],
    };

    const coordinatorRun = await this.options.runStore.getRun(ctx.coordinatorRunId);
    if (!coordinatorRun) {
      return this.recoveryResult(ctx, 'blocked', { reason: `Swarm coordinator run ${ctx.coordinatorRunId} does not exist` });
    }

    if (ctx.dryRun) {
      if (hasLiveLease(coordinatorRun, new Date())) {
        return this.recoveryResult(ctx, 'busy', { reason: leaseReason(coordinatorRun) });
      }
      return this.recoverSessionInternal(ctx);
    }

    ctx.owner = `swarm-recovery:${ctx.coordinatorRunId}:${crypto.randomUUID()}`;
    if (!(await this.acquireRecoveryLease(ctx))) {
      const current = await this.options.runStore.getRun(ctx.coordinatorRunId);
      return this.recoveryResult(ctx, 'busy', { reason: current ? leaseReason(current) : `Swarm coordinator run ${ctx.coordinatorRunId} is already leased` });
    }
    try {
      return await this.recoverSessionInternal(ctx);
    } finally {
      await this.releaseRecoveryLease(ctx);
    }
  }

  private async recoverSessionInternal(ctx: SwarmRecoveryContext): Promise<SwarmRecoveryResult> {
    const coordinatorRun = await this.options.runStore.getRun(ctx.coordinatorRunId);
    if (!coordinatorRun) {
      return this.recoveryResult(ctx, 'blocked', { reason: `Swarm coordinator run ${ctx.coordinatorRunId} does not exist` });
    }

    const descriptor = readSwarmExecutionDescriptor(coordinatorRun);
    if (!descriptor) {
      if (coordinatorRun.metadata?.swarmExecution !== undefined) {
        return this.recoveryResult(ctx, 'blocked', {
          reason: `Swarm coordinator run ${ctx.coordinatorRunId} has an unsupported or incompatible swarmExecution descriptor`,
        });
      }
      return this.recoverDecomposition(ctx, coordinatorRun);
    }
    if (descriptor.coordinatorRunId !== ctx.coordinatorRunId || descriptor.sessionId !== ctx.sessionId) {
      return this.recoveryResult(ctx, 'blocked', {
        reason: `Swarm execution descriptor identity (${descriptor.sessionId}/${descriptor.coordinatorRunId}) does not match session ${ctx.sessionId} coordinator ${ctx.coordinatorRunId}`,
      });
    }
    return this.recoverExecution(ctx, coordinatorRun, descriptor);
  }

  private async recoverDecomposition(ctx: SwarmRecoveryContext, coordinatorRun: AgentRun): Promise<SwarmRecoveryResult> {
    if (coordinatorRun.context?.phase === 'swarm.execute') {
      return this.recoveryResult(ctx, 'blocked', {
        reason: `Swarm coordinator run ${ctx.coordinatorRunId} was created for prepared execution but has no persisted descriptor; subtasks cannot be reconstructed`,
      });
    }

    const heads = await this.loadRoleHeads(ctx);
    const head = selectLineageHead(heads.coordinator) ?? coordinatorRun;
    const busy = await this.liveLeaseReason(head, new Date(), ctx.owner);
    if (busy) return this.recoveryResult(ctx, 'busy', { reason: busy });

    if (head.errorCode === 'INVALID_DECOMPOSITION') {
      return this.recoveryResult(ctx, 'blocked', {
        reason: `Swarm decomposition run ${head.id} produced an invalid decomposition; regeneration is required: ${head.errorMessage ?? 'invalid subtasks'}`,
        result: readStoredSwarmResult(coordinatorRun),
      });
    }

    if (head.status === 'succeeded') {
      return this.executeRecoveredDecomposition(ctx, coordinatorRun, head, head.result);
    }

    let plan: RunRecoveryPlan;
    try {
      plan = await this.options.coordinatorAgent.getRecoveryPlan(head.id);
    } catch (error) {
      return this.recoveryResult(ctx, 'blocked', { reason: `Cannot plan recovery for decomposition run ${head.id}: ${errorMessage(error)}` });
    }
    ctx.plans.push(plan);

    if (head.status === 'cancelled' || head.status === 'replan_required') {
      return this.recoveryResult(ctx, 'blocked', { reason: `Swarm decomposition run ${head.id} is ${head.status}; automatic recovery will not override it` });
    }
    if (!plan.executable) {
      const terminalFailure = head.status === 'failed' && plan.action === 'not_recoverable';
      return this.recoveryResult(ctx, terminalFailure ? 'failed' : 'blocked', {
        reason: plan.reason,
        result: readStoredSwarmResult(coordinatorRun),
      });
    }
    if (ctx.dryRun) {
      return this.recoveryResult(ctx, 'planned', {
        reason: `Decomposition run ${head.id} would be recovered with ${plan.action}; swarm execution would follow from its output`,
      });
    }

    // The coordinator agent acquires its own lease on the decomposition run. Never hold the
    // swarm recovery lease on that same run while it executes.
    await this.releaseRecoveryLease(ctx);
    let action: RecoverRunResult;
    try {
      action = await this.options.coordinatorAgent.recover({ runId: head.id, requireApproval: ctx.requireApproval });
    } catch (error) {
      return this.recoveryResult(ctx, 'failed', { reason: `Decomposition recovery for run ${head.id} failed: ${errorMessage(error)}` });
    }
    ctx.actions.push(action);
    if (!(await this.acquireRecoveryLease(ctx))) {
      return this.recoveryResult(ctx, 'busy', { reason: `Swarm coordinator run ${ctx.coordinatorRunId} was leased by another owner after decomposition recovery` });
    }

    const recovered = action.result;
    if (!recovered) {
      return this.recoveryResult(ctx, 'failed', { reason: `Decomposition recovery for run ${head.id} produced no result` });
    }
    if (recovered.status === 'approval_requested' || recovered.status === 'clarification_requested') {
      return this.recoveryResult(ctx, 'blocked', { reason: `Decomposition run ${recovered.runId} is waiting for user action: ${recovered.message}` });
    }
    if (recovered.status === 'failure') {
      const result = await this.finalizeCoordinator({
        sessionId: ctx.sessionId,
        coordinatorRunId: ctx.coordinatorRunId,
        subtaskResults: [],
        status: 'failed',
        errorCode: recovered.code,
        errorMessage: recovered.error,
      });
      return this.recoveryResult(ctx, 'failed', { reason: recovered.error, result });
    }

    const recoveredRun = await this.options.runStore.getRun(recovered.runId);
    if (recoveredRun && recoveredRun.id !== ctx.coordinatorRunId) {
      // A continuation copies the source orchestration metadata; bind it to the logical coordinator.
      await this.patchRunMetadata(recoveredRun.id, {
        orchestration: {
          ...(readOrchestrationMetadata(recoveredRun) ?? {}),
          ...orchestrationMetadata(ctx.coordinatorRunId, 'coordinator', undefined, this.options.coordinatorAgentId, undefined, head.id),
        } as unknown as JsonValue,
      });
    }
    const latestCoordinator = await this.options.runStore.getRun(ctx.coordinatorRunId) ?? coordinatorRun;
    return this.executeRecoveredDecomposition(ctx, latestCoordinator, recoveredRun ?? head, recovered.output);
  }

  private async executeRecoveredDecomposition(
    ctx: SwarmRecoveryContext,
    coordinatorRun: AgentRun,
    decompositionRun: AgentRun,
    output: JsonValue | undefined,
  ): Promise<SwarmRecoveryResult> {
    if (isFinalizedSwarmResult(output)) {
      return this.recoveryResult(ctx, 'blocked', {
        reason: `Swarm coordinator run ${ctx.coordinatorRunId} has a finalized result but no execution descriptor; persisted data is incompatible`,
      });
    }
    let subtasks: SwarmSubtask[];
    try {
      subtasks = normalizeSubtasks(output ?? null);
    } catch (error) {
      if (ctx.dryRun || ctx.actions.length === 0) {
        return this.recoveryResult(ctx, 'blocked', { reason: `Decomposition run ${decompositionRun.id} output is invalid; regeneration is required: ${errorMessage(error)}` });
      }
      const result = await this.finalizeCoordinator({
        sessionId: ctx.sessionId,
        coordinatorRunId: ctx.coordinatorRunId,
        subtaskResults: [],
        status: 'failed',
        errorCode: 'INVALID_DECOMPOSITION',
        errorMessage: errorMessage(error),
      });
      return this.recoveryResult(ctx, 'failed', { reason: errorMessage(error), result });
    }
    const validation = validateSubtasks(subtasks, Object.keys(this.options.workerAgents), this.options.defaultWorkerAgentId);
    if (!validation.valid) {
      return this.recoveryResult(ctx, 'blocked', { reason: `Decomposition run ${decompositionRun.id} cannot execute with configured workers: ${validation.message}` });
    }
    if (ctx.dryRun) {
      return this.recoveryResult(ctx, 'planned', {
        reason: `Decomposition run ${decompositionRun.id} completed; swarm execution of ${subtasks.length} subtask(s) would start`,
      });
    }

    const result = await this.execute({
      sessionId: ctx.sessionId,
      coordinatorRunId: ctx.coordinatorRunId,
      topLevelObjective: readTopLevelObjective(coordinatorRun),
      input: readDecompositionInput(coordinatorRun),
      executionContext: coordinatorRun.executionContext,
      subtasks,
    });
    return this.recoveryResult(ctx, outcomeForSwarmResult(result), { result, reason: result.errorMessage });
  }

  private async recoverExecution(
    ctx: SwarmRecoveryContext,
    coordinatorRun: AgentRun,
    descriptor: SwarmExecutionDescriptor,
  ): Promise<SwarmRecoveryResult> {
    let heads = await this.loadRoleHeads(ctx);
    const now = new Date();
    for (const run of [...heads.workers.values(), heads.quality, heads.synthesizer]) {
      if (!run) continue;
      const busy = await this.liveLeaseReason(run, now, ctx.owner);
      if (busy) return this.recoveryResult(ctx, 'busy', { reason: busy });
    }
    for (const run of [coordinatorRun, heads.quality, heads.synthesizer]) {
      if (run && ['cancelled', 'replan_required', 'awaiting_approval', 'clarification_requested'].includes(run.status)) {
        return this.recoveryResult(ctx, 'blocked', { reason: `Run ${run.id} is ${run.status}; automatic recovery will not override it` });
      }
    }
    for (const [run, agent] of [[heads.quality, this.options.qualityAgent], [heads.synthesizer, this.options.synthesizerAgent]] as const) {
      if (run?.status === 'failed' && agent) {
        const plan = await agent.getRecoveryPlan(run.id);
        if (plan.action === 'requires_user_action' || plan.action === 'requires_reconciliation') {
          ctx.plans.push(plan);
          return this.recoveryResult(ctx, 'blocked', { reason: plan.reason });
        }
      }
    }

    const blockers: string[] = [];
    const workItems: Array<{ subtask: SwarmSubtask; agent: AdaptiveAgent; run: AgentRun; plan: RunRecoveryPlan }> = [];
    const missing: Array<{ subtask: SwarmSubtask }> = [];
    for (const subtask of descriptor.subtasks) {
      const head = heads.workers.get(subtask.id);
      if (head?.status === 'succeeded') continue;
      const agent = this.resolveWorkerAgent(subtask);
      if (!agent) {
        blockers.push(`No configured worker agent "${subtask.targetAgentId ?? this.options.defaultWorkerAgentId ?? ''}" for subtask ${subtask.id}`);
        continue;
      }
      if (!head) {
        missing.push({ subtask });
        continue;
      }
      let plan: RunRecoveryPlan;
      try {
        plan = await agent.getRecoveryPlan(head.id);
      } catch (error) {
        blockers.push(`Cannot plan recovery for worker run ${head.id} (subtask ${subtask.id}): ${errorMessage(error)}`);
        continue;
      }
      ctx.plans.push(plan);
      if (head.status === 'cancelled' || head.status === 'replan_required') {
        blockers.push(`Worker run ${head.id} for subtask ${subtask.id} is ${head.status}; automatic recovery will not override it`);
      } else if (plan.executable) {
        workItems.push({ subtask, agent, run: head, plan });
      } else if (!(head.status === 'failed' && plan.action === 'not_recoverable')) {
        // Terminal non-recoverable failures feed finalizers as failed inputs; everything else needs a human.
        blockers.push(`Worker run ${head.id} for subtask ${subtask.id}: ${plan.reason}`);
      }
    }
    ctx.missingWorkerSubtaskIds = missing.map(({ subtask }) => subtask.id);

    if (blockers.length > 0) {
      return this.recoveryResult(ctx, 'blocked', { reason: blockers.join('; ') });
    }

    const storedResult = readStoredSwarmResult(coordinatorRun);
    if (workItems.length === 0 && missing.length === 0 && storedResult?.status === 'succeeded' && coordinatorRun.status === 'succeeded') {
      const currentResults = buildSubtaskResultsFromRuns(descriptor.subtasks, heads.workers);
      if (
        subtaskResultsFingerprint(storedResult.subtaskResults) === subtaskResultsFingerprint(currentResults)
        && storedResult.synthesizerRunId === heads.synthesizer?.id
      ) {
        return this.recoveryResult(ctx, 'completed', { reason: 'Swarm session is already completed', result: storedResult });
      }
    }

    if (workItems.length > 0 || missing.length > 0) {
      if (ctx.dryRun) {
        const parts = [
          ...workItems.map(({ subtask, run, plan }) => `worker ${subtask.id} run ${run.id}: ${plan.action}`),
          ...missing.map(({ subtask }) => `worker ${subtask.id}: start missing run`),
        ];
        return this.recoveryResult(ctx, 'planned', {
          reason: `Would recover ${parts.join('; ')}; quality and synthesis would then finish with current worker outputs`,
        });
      }

      const errors: string[] = [];
      const items: Array<{ subtask: SwarmSubtask; agent?: AdaptiveAgent; run?: AgentRun; plan?: RunRecoveryPlan }> = [...workItems, ...missing];
      await runWithConcurrency(items, Math.max(1, descriptor.maxWorkers), async (item) => {
        try {
          if (item.run && item.agent && item.plan) {
            const metadata = item.plan.action === 'continue_new_run'
              ? {
                  orchestration: orchestrationMetadata(
                    ctx.coordinatorRunId,
                    'worker',
                    item.subtask.id,
                    readOrchestrationMetadata(item.run)?.agentId ?? item.subtask.targetAgentId ?? this.options.defaultWorkerAgentId,
                    (readOrchestrationMetadata(item.run)?.attempt ?? 1) + 1,
                    item.run.id,
                  ) as unknown as JsonValue,
                }
              : undefined;
            ctx.actions.push(await item.agent.recover({ runId: item.run.id, requireApproval: ctx.requireApproval, metadata }));
          } else {
            const started = await this.runWorker({
              sessionId: ctx.sessionId,
              coordinatorRunId: ctx.coordinatorRunId,
              topLevelObjective: descriptor.topLevelObjective,
              executionContext: coordinatorRun.executionContext,
              subtask: item.subtask,
            });
            ctx.startedRunIds.push(started.runId);
          }
        } catch (error) {
          errors.push(`subtask ${item.subtask.id}${item.run ? ` run ${item.run.id}` : ''}: ${errorMessage(error)}`);
        }
      });

      if (!(await this.acquireRecoveryLease(ctx))) {
        return this.recoveryResult(ctx, 'busy', { reason: `Swarm coordinator lease for ${ctx.coordinatorRunId} was lost during worker recovery` });
      }
      if (errors.length > 0) {
        return this.recoveryResult(ctx, 'failed', { reason: `Worker recovery failed: ${errors.join('; ')}` });
      }
      heads = await this.loadRoleHeads(ctx);
    }

    const waiting: string[] = [];
    for (const subtask of descriptor.subtasks) {
      const head = heads.workers.get(subtask.id);
      if (!head) {
        waiting.push(`subtask ${subtask.id} has no worker run`);
      } else if (head.status !== 'succeeded' && head.status !== 'failed') {
        waiting.push(`worker run ${head.id} for subtask ${subtask.id} is ${head.status}`);
      }
    }
    if (waiting.length > 0) {
      return this.recoveryResult(ctx, 'blocked', { reason: `Workers are not finished: ${waiting.join('; ')}` });
    }

    const subtaskResults = buildSubtaskResultsFromRuns(descriptor.subtasks, heads.workers);
    return this.recoverFinalizers(ctx, coordinatorRun, descriptor, heads, subtaskResults);
  }

  private async recoverFinalizers(
    ctx: SwarmRecoveryContext,
    coordinatorRun: AgentRun,
    descriptor: SwarmExecutionDescriptor,
    heads: SwarmRoleHeads,
    subtaskResults: SwarmSubtaskResult[],
  ): Promise<SwarmRecoveryResult> {
    const executionContext = coordinatorRun.executionContext;
    const resultsFingerprint = subtaskResultsFingerprint(subtaskResults);
    let changed = false;

    // Quality: reuse or recover in place only when it assessed the current worker outputs.
    let qualityRunId: UUID | undefined;
    let qualityAssessments: SwarmQualityAssessment[] | undefined;
    let qualityError: string | undefined;
    const qualityHead = heads.quality;
    const qualityInputsMatch = qualityHead !== undefined
      && subtaskResultsFingerprint(readRecordField(qualityHead.input, 'subtaskResults')) === resultsFingerprint;
    let qualityResult: RunResult | undefined;
    if (qualityHead && qualityInputsMatch) {
      qualityRunId = qualityHead.id;
      if (qualityHead.status === 'succeeded') {
        qualityAssessments = normalizeQualityAssessments(qualityHead.result ?? null, qualityHead.id);
      } else {
        const plan = await this.planFinalizer(ctx, this.options.qualityAgent, qualityHead);
        if (typeof plan === 'string') return this.recoveryResult(ctx, 'blocked', { reason: plan });
        if (plan.executable) {
          if (ctx.dryRun) {
            return this.recoveryResult(ctx, 'planned', { reason: `Quality run ${qualityHead.id} would be recovered with ${plan.action}; synthesis would follow` });
          }
          const recovered = await this.recoverFinalizerRun(ctx, this.options.qualityAgent, qualityHead.id);
          if (typeof recovered === 'string') return this.recoveryResult(ctx, 'failed', { reason: recovered });
          qualityResult = recovered;
          changed = true;
        } else if (qualityHead.status === 'failed' && plan.action === 'not_recoverable') {
          qualityError = qualityHead.errorMessage ?? `Quality run ${qualityHead.id} failed`;
        } else {
          return this.recoveryResult(ctx, 'blocked', { reason: `Quality run ${qualityHead.id}: ${plan.reason}` });
        }
      }
    } else {
      if (ctx.dryRun) {
        return this.recoveryResult(ctx, 'planned', {
          reason: qualityHead
            ? `Quality run ${qualityHead.id} assessed outdated worker outputs; quality and synthesis would be regenerated`
            : 'Quality and synthesis would run with current worker outputs',
        });
      }
      qualityResult = await this.runQualityRun({
        sessionId: ctx.sessionId,
        coordinatorRunId: ctx.coordinatorRunId,
        topLevelObjective: descriptor.topLevelObjective,
        executionContext,
        subtasks: descriptor.subtasks,
        subtaskResults,
        ...(qualityHead ? { attempt: nextAttempt(qualityHead), supersedesRunId: qualityHead.id } : {}),
      });
      ctx.startedRunIds.push(qualityResult.runId);
      changed = true;
    }
    if (qualityResult) {
      qualityRunId = qualityResult.runId;
      if (qualityResult.status === 'approval_requested' || qualityResult.status === 'clarification_requested') {
        return this.recoveryResult(ctx, 'blocked', { reason: `Quality run ${qualityResult.runId} is waiting for user action: ${qualityResult.message}` });
      }
      if (qualityResult.status === 'success') {
        qualityAssessments = normalizeQualityAssessments(qualityResult.output, qualityResult.runId);
      } else {
        qualityError = qualityResult.error;
      }
    }

    // Synthesis: reuse or recover in place only when its inputs equal the current inputs.
    const synthesizerInput = buildSynthesizerInput(descriptor.topLevelObjective, descriptor.subtasks, subtaskResults, qualityAssessments, qualityError);
    const synthesizerHead = heads.synthesizer;
    const synthesizerInputsMatch = synthesizerHead !== undefined
      && synthesizerInputFingerprint(synthesizerHead.input) === synthesizerInputFingerprint(synthesizerInput);
    let synthesizerRunId: UUID | undefined;
    let synthesizerOutcome: { status: 'succeeded'; output?: JsonValue } | { status: 'failed'; errorCode?: string; errorMessage?: string };
    if (synthesizerHead && synthesizerInputsMatch) {
      synthesizerRunId = synthesizerHead.id;
      if (synthesizerHead.status === 'succeeded') {
        synthesizerOutcome = { status: 'succeeded', output: synthesizerHead.result };
      } else {
        const plan = await this.planFinalizer(ctx, this.options.synthesizerAgent, synthesizerHead);
        if (typeof plan === 'string') return this.recoveryResult(ctx, 'blocked', { reason: plan });
        if (plan.executable) {
          if (ctx.dryRun) {
            return this.recoveryResult(ctx, 'planned', { reason: `Synthesizer run ${synthesizerHead.id} would be recovered with ${plan.action}` });
          }
          const recovered = await this.recoverFinalizerRun(ctx, this.options.synthesizerAgent, synthesizerHead.id);
          if (typeof recovered === 'string') return this.recoveryResult(ctx, 'failed', { reason: recovered });
          if (recovered.status === 'approval_requested' || recovered.status === 'clarification_requested') {
            return this.recoveryResult(ctx, 'blocked', { reason: `Synthesizer run ${recovered.runId} is waiting for user action: ${recovered.message}` });
          }
          synthesizerRunId = recovered.runId;
          synthesizerOutcome = recovered.status === 'success'
            ? { status: 'succeeded', output: recovered.output }
            : { status: 'failed', errorCode: recovered.code, errorMessage: recovered.error };
          changed = true;
        } else if (synthesizerHead.status === 'failed' && plan.action === 'not_recoverable') {
          synthesizerOutcome = { status: 'failed', errorCode: synthesizerHead.errorCode, errorMessage: synthesizerHead.errorMessage };
        } else {
          return this.recoveryResult(ctx, 'blocked', { reason: `Synthesizer run ${synthesizerHead.id}: ${plan.reason}` });
        }
      }
    } else {
      if (ctx.dryRun) {
        return this.recoveryResult(ctx, 'planned', {
          reason: synthesizerHead
            ? `Synthesizer run ${synthesizerHead.id} used outdated inputs; synthesis would be regenerated`
            : 'Synthesis would run with current worker outputs and quality assessments',
        });
      }
      const regenerated = await this.runSynthesizerRun({
        sessionId: ctx.sessionId,
        coordinatorRunId: ctx.coordinatorRunId,
        executionContext,
        input: synthesizerInput,
        ...(synthesizerHead ? { attempt: nextAttempt(synthesizerHead), supersedesRunId: synthesizerHead.id } : {}),
      });
      ctx.startedRunIds.push(regenerated.runId);
      changed = true;
      if (regenerated.status === 'approval_requested' || regenerated.status === 'clarification_requested') {
        return this.recoveryResult(ctx, 'blocked', { reason: `Synthesizer run ${regenerated.runId} is waiting for user action: ${regenerated.message}` });
      }
      synthesizerRunId = regenerated.runId;
      synthesizerOutcome = regenerated.status === 'success'
        ? { status: 'succeeded', output: regenerated.output }
        : { status: 'failed', errorCode: regenerated.code, errorMessage: regenerated.error };
    }

    const finalResult: SwarmRunResult = {
      sessionId: ctx.sessionId,
      coordinatorRunId: ctx.coordinatorRunId,
      subtaskResults,
      qualityRunId,
      synthesizerRunId,
      qualityAssessments,
      ...synthesizerOutcome,
    };
    const storedResult = readStoredSwarmResult(coordinatorRun);
    const storedMatches = !changed
      && ctx.actions.length === 0
      && ctx.startedRunIds.length === 0
      && storedResult !== undefined
      && coordinatorRun.status === storedResult.status
      && storedResult.status === finalResult.status
      && storedResult.qualityRunId === finalResult.qualityRunId
      && storedResult.synthesizerRunId === finalResult.synthesizerRunId
      && subtaskResultsFingerprint(storedResult.subtaskResults) === resultsFingerprint;
    if (storedMatches) {
      return this.recoveryResult(ctx, outcomeForSwarmResult(storedResult), {
        reason: storedResult.status === 'succeeded' ? 'Swarm session is already completed' : storedResult.errorMessage ?? 'Swarm session failed and has no recoverable runs',
        result: storedResult,
      });
    }
    if (ctx.dryRun) {
      return this.recoveryResult(ctx, 'planned', { reason: 'Swarm coordinator result would be finalized from current worker and finalizer runs' });
    }
    const result = await this.finalizeCoordinator(finalResult);
    return this.recoveryResult(ctx, outcomeForSwarmResult(result), { result, reason: result.errorMessage });
  }

  private async planFinalizer(ctx: SwarmRecoveryContext, agent: AdaptiveAgent, run: AgentRun): Promise<RunRecoveryPlan | string> {
    if (run.status === 'cancelled' || run.status === 'replan_required') {
      return `${readOrchestrationMetadata(run)?.role ?? 'Finalizer'} run ${run.id} is ${run.status}; automatic recovery will not override it`;
    }
    try {
      const plan = await agent.getRecoveryPlan(run.id);
      ctx.plans.push(plan);
      return plan;
    } catch (error) {
      return `Cannot plan recovery for run ${run.id}: ${errorMessage(error)}`;
    }
  }

  private async recoverFinalizerRun(ctx: SwarmRecoveryContext, agent: AdaptiveAgent, runId: UUID): Promise<RunResult | string> {
    try {
      const action = await agent.recover({ runId, requireApproval: ctx.requireApproval });
      ctx.actions.push(action);
      if (!action.result) return `Recovery for run ${runId} produced no result`;
      if (!(await this.acquireRecoveryLease(ctx))) return `Swarm coordinator lease for ${ctx.coordinatorRunId} was lost during finalizer recovery`;
      return action.result;
    } catch (error) {
      return `Recovery for run ${runId} failed: ${errorMessage(error)}`;
    }
  }

  private async loadRoleHeads(ctx: SwarmRecoveryContext): Promise<SwarmRoleHeads> {
    const sessionRuns = await this.options.runStore.listBySession!(ctx.sessionId);
    const swarmRuns = sessionRuns.filter((run) => readOrchestrationMetadata(run) !== undefined);
    const owned = swarmRuns.filter((run) => !run.parentRunId && logicalCoordinatorRunId(run, swarmRuns) === ctx.coordinatorRunId);
    const byRole = (role: OrchestrationMetadata['role']) => owned.filter((run) => readOrchestrationMetadata(run)?.role === role);
    const workersBySubtask = new Map<string, AgentRun[]>();
    for (const run of byRole('worker')) {
      const subtaskId = readOrchestrationMetadata(run)?.subtaskId;
      if (!subtaskId) continue;
      workersBySubtask.set(subtaskId, [...(workersBySubtask.get(subtaskId) ?? []), run]);
    }
    const workers = new Map<string, AgentRun>();
    for (const [subtaskId, runs] of workersBySubtask) {
      const head = selectLineageHead(runs);
      if (head) workers.set(subtaskId, head);
    }
    return {
      coordinator: byRole('coordinator'),
      workers,
      quality: selectLineageHead(byRole('quality')),
      synthesizer: selectLineageHead(byRole('synthesizer')),
    };
  }

  private async liveLeaseReason(run: AgentRun, now: Date, ownOwner: string | undefined): Promise<string | undefined> {
    if (hasLiveLease(run, now) && run.leaseOwner !== ownOwner) return leaseReason(run);
    if (run.status === 'awaiting_subagent' && run.currentChildRunId) {
      const child = await this.options.runStore.getRun(run.currentChildRunId);
      if (child && hasLiveLease(child, now)) return leaseReason(child);
    }
    return undefined;
  }

  private async acquireRecoveryLease(ctx: SwarmRecoveryContext): Promise<boolean> {
    if (ctx.dryRun || !ctx.owner) return true;
    const acquired = await this.options.runStore.tryAcquireLease({
      runId: ctx.coordinatorRunId,
      owner: ctx.owner,
      ttlMs: COORDINATOR_LEASE_TTL_MS,
      now: new Date(),
    });
    ctx.leaseHeld = acquired;
    return acquired;
  }

  private async releaseRecoveryLease(ctx: SwarmRecoveryContext): Promise<void> {
    if (!ctx.leaseHeld || !ctx.owner) return;
    ctx.leaseHeld = false;
    try {
      await this.options.runStore.releaseLease(ctx.coordinatorRunId, ctx.owner);
    } catch {
      // Lease release is best effort; the lease expires on its own.
    }
  }

  private recoveryResult(
    ctx: SwarmRecoveryContext,
    outcome: SwarmRecoveryOutcome,
    extra: { reason?: string; result?: SwarmRunResult } = {},
  ): SwarmRecoveryResult {
    return {
      sessionId: ctx.sessionId,
      coordinatorRunId: ctx.coordinatorRunId,
      outcome,
      plans: [...ctx.plans],
      actions: [...ctx.actions],
      ...(extra.reason ? { reason: extra.reason } : {}),
      ...(extra.result ? { result: extra.result } : {}),
      ...(ctx.startedRunIds.length > 0 ? { startedRunIds: [...ctx.startedRunIds] } : {}),
      ...(ctx.missingWorkerSubtaskIds.length > 0 ? { missingWorkerSubtaskIds: [...ctx.missingWorkerSubtaskIds] } : {}),
    };
  }

  private async runFinalizers(params: {
    sessionId: string;
    coordinatorRunId: UUID;
    topLevelObjective: string;
    executionContext?: AgentRun['executionContext'];
    subtasks: SwarmSubtask[];
    subtaskResults: SwarmSubtaskResult[];
    previousQualityRunId?: UUID;
    previousSynthesizerRunId?: UUID;
  }): Promise<SwarmRunResult> {
    const qualityAttempt = params.previousQualityRunId ? 2 : undefined;

    const qualityResult = await this.runQualityRun({
      sessionId: params.sessionId,
      coordinatorRunId: params.coordinatorRunId,
      topLevelObjective: params.topLevelObjective,
      executionContext: params.executionContext,
      subtasks: params.subtasks,
      subtaskResults: params.subtaskResults,
      attempt: qualityAttempt,
      supersedesRunId: params.previousQualityRunId,
    });
    const qualityRunId = qualityResult.runId;
    const qualityAssessments = qualityResult.status === 'success'
      ? normalizeQualityAssessments(qualityResult.output, qualityRunId)
      : undefined;

    const synthesizerInput = buildSynthesizerInput(
      params.topLevelObjective,
      params.subtasks,
      params.subtaskResults,
      qualityAssessments,
      qualityResult.status === 'failure' ? qualityResult.error : undefined,
    );

    const synthesizerAttempt = params.previousSynthesizerRunId ? 2 : undefined;

    const synthesizerResult = await this.runSynthesizerRun({
      sessionId: params.sessionId,
      coordinatorRunId: params.coordinatorRunId,
      executionContext: params.executionContext,
      input: synthesizerInput,
      attempt: synthesizerAttempt,
      supersedesRunId: params.previousSynthesizerRunId,
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

  private runQualityRun(params: {
    sessionId: string;
    coordinatorRunId: UUID;
    topLevelObjective: string;
    executionContext?: AgentRun['executionContext'];
    subtasks: SwarmSubtask[];
    subtaskResults: SwarmSubtaskResult[];
    attempt?: number;
    supersedesRunId?: UUID;
  }): Promise<RunResult> {
    return this.options.qualityAgent.run({
      sessionId: params.sessionId,
      goal: 'Assess swarm worker outputs against the top-level objective and subtask objectives.',
      input: {
        topLevelObjective: params.topLevelObjective,
        subtasks: params.subtasks as unknown as JsonValue,
        subtaskResults: params.subtaskResults as unknown as JsonValue,
      },
      executionContext: params.executionContext,
      outputSchema: qualityOutputSchema,
      metadata: {
        orchestration: orchestrationMetadata(params.coordinatorRunId, 'quality', undefined, this.options.qualityAgentId, params.attempt, params.supersedesRunId) as unknown as JsonValue,
      },
    });
  }

  private runSynthesizerRun(params: {
    sessionId: string;
    coordinatorRunId: UUID;
    executionContext?: AgentRun['executionContext'];
    input: Record<string, JsonValue>;
    attempt?: number;
    supersedesRunId?: UUID;
  }): Promise<RunResult> {
    return this.options.synthesizerAgent.run({
      sessionId: params.sessionId,
      goal: 'Synthesize the final response for the top-level objective from worker results and quality assessments.',
      input: params.input,
      executionContext: params.executionContext,
      metadata: {
        orchestration: orchestrationMetadata(params.coordinatorRunId, 'synthesizer', undefined, this.options.synthesizerAgentId, params.attempt, params.supersedesRunId) as unknown as JsonValue,
      },
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
    executionContext?: AgentRun['executionContext'];
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
      executionContext: params.executionContext,
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

/**
 * Resolves the logical swarm coordinator id for a run. Decomposition runs keep
 * `coordinatorRunId: 'pending'` until execution starts, so coordinator-role runs fall back to the
 * root of their continuation/supersession lineage.
 */
function logicalCoordinatorRunId(run: AgentRun, runs: AgentRun[]): UUID | undefined {
  const metadata = readOrchestrationMetadata(run);
  if (!metadata) return undefined;
  if (metadata.coordinatorRunId !== 'pending') return metadata.coordinatorRunId;
  if (metadata.role !== 'coordinator') return undefined;
  const byId = new Map(runs.map((candidate) => [candidate.id, candidate]));
  const visited = new Set<UUID>();
  let current = run;
  while (!visited.has(current.id)) {
    visited.add(current.id);
    const sourceId = lineageSourceRunIds(current)[0];
    const source = sourceId ? byId.get(sourceId) : undefined;
    if (!source) break;
    const sourceMetadata = readOrchestrationMetadata(source);
    if (sourceMetadata && sourceMetadata.coordinatorRunId !== 'pending') return sourceMetadata.coordinatorRunId;
    current = source;
  }
  return current.id;
}

/** Runs that this run continues or supersedes. */
function lineageSourceRunIds(run: AgentRun): UUID[] {
  const ids: UUID[] = [];
  const continuationOf = run.metadata?.continuationOfRunId;
  if (isNonEmptyString(continuationOf)) ids.push(continuationOf);
  const supersedes = readOrchestrationMetadata(run)?.supersedesRunId;
  if (supersedes && !ids.includes(supersedes)) ids.push(supersedes);
  return ids;
}

/**
 * Picks the unique unsuperseded head of one logical role. Branching or cyclic histories must
 * be reconciled explicitly; recency alone does not identify the authoritative attempt.
 */
function selectLineageHead(runs: AgentRun[]): AgentRun | undefined {
  if (runs.length === 0) return undefined;
  const superseded = new Set(runs.flatMap(lineageSourceRunIds));
  const candidates = runs.filter((run) => !superseded.has(run.id));
  if (candidates.length !== 1) throw new Error('Swarm role has ambiguous continuation or supersession lineage; choose the intended execution explicitly');
  return candidates[0];
}

function hasLiveLease(run: AgentRun, now: Date): boolean {
  return Boolean(run.leaseOwner && run.leaseExpiresAt && new Date(run.leaseExpiresAt).getTime() > now.getTime());
}

function leaseReason(run: AgentRun): string {
  const role = readOrchestrationMetadata(run)?.role;
  return `Run ${run.id}${role ? ` (${role})` : ''} holds a live lease${run.leaseOwner ? ` owned by ${run.leaseOwner}` : ''}${run.leaseExpiresAt ? ` until ${run.leaseExpiresAt}` : ''}`;
}

function readStoredSwarmResult(run: AgentRun): SwarmRunResult | undefined {
  const raw = run.result;
  if (!isRecord(raw) || !isFinalizedSwarmResult(raw) || !Array.isArray(raw.subtaskResults)) return undefined;
  return raw as unknown as SwarmRunResult;
}

function outcomeForSwarmResult(result: SwarmRunResult): SwarmRecoveryOutcome {
  if (result.status === 'succeeded') return 'completed';
  if (result.status === 'failed') return 'failed';
  return 'blocked';
}

function nextAttempt(run: AgentRun): number {
  return (readOrchestrationMetadata(run)?.attempt ?? 1) + 1;
}

function readTopLevelObjective(run: AgentRun): string {
  const fromContext = run.context?.topLevelObjective;
  return isNonEmptyString(fromContext) ? fromContext : run.goal;
}

function readDecompositionInput(run: AgentRun): JsonValue | undefined {
  const input = run.input;
  // Agent SDK decomposition wraps the caller input with the worker catalog.
  if (isRecord(input) && Object.hasOwn(input, 'originalInput') && Object.hasOwn(input, 'workerCatalog')) {
    const original = input.originalInput as JsonValue;
    return original === null ? undefined : original;
  }
  return input;
}

function readRecordField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function buildSynthesizerInput(
  topLevelObjective: string,
  subtasks: SwarmSubtask[],
  subtaskResults: SwarmSubtaskResult[],
  qualityAssessments: SwarmQualityAssessment[] | undefined,
  qualityError: string | undefined,
): Record<string, JsonValue> {
  return {
    topLevelObjective,
    subtasks: subtasks as unknown as JsonValue,
    subtaskResults: subtaskResults as unknown as JsonValue,
    qualityAssessments: (qualityAssessments ?? []) as unknown as JsonValue,
    ...(qualityError !== undefined ? { qualityError } : {}),
  };
}

/** Compares worker outputs by identity, status, and output only, so representation noise does not force regeneration. */
function subtaskResultsFingerprint(value: unknown): string {
  if (!Array.isArray(value)) return 'invalid';
  return stableStringify(value.map((item) => isRecord(item)
    ? { subtaskId: item.subtaskId ?? null, runId: item.runId ?? null, status: item.status ?? null, output: item.output ?? null }
    : null));
}

function synthesizerInputFingerprint(value: unknown): string {
  if (!isRecord(value)) return 'invalid';
  return stableStringify({
    subtaskResults: subtaskResultsFingerprint(value.subtaskResults),
    qualityAssessments: value.qualityAssessments ?? [],
    qualityError: value.qualityError !== undefined,
  });
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

const STRICT_SWARM_SUBTASK_OUTPUT_KEYS = new Set(['id', 'subObjective', 'input', 'attachmentRefs', 'targetAgentId']);

function normalizeSubtasks(output: JsonValue): SwarmSubtask[] {
  const raw = readArray(output, 'subtasks') ?? (Array.isArray(output) ? output : undefined);
  if (!raw || raw.length === 0) {
    throw new Error('Swarm decomposition produced no subtasks');
  }
  return raw.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`Swarm subtask ${index + 1} is not an object`);
    }
    const unsupportedKeys = Object.keys(item).filter((key) => !STRICT_SWARM_SUBTASK_OUTPUT_KEYS.has(key));
    if (unsupportedKeys.length > 0) {
      throw new Error(`Swarm subtask ${index + 1} includes unsupported keys: ${unsupportedKeys.join(', ')}`);
    }
    const id = readString(item.id);
    if (!id) {
      throw new Error(`Swarm subtask ${index + 1} is missing id`);
    }
    const subObjective = readString(item.subObjective);
    if (!subObjective) {
      throw new Error(`Swarm subtask ${id} is missing subObjective`);
    }
    if (!Object.hasOwn(item, 'input')) {
      throw new Error(`Swarm subtask ${id} is missing input`);
    }
    if (item.input !== null && typeof item.input !== 'string') {
      throw new Error(`Swarm subtask ${id} input must be a string or null`);
    }
    if (!Array.isArray(item.attachmentRefs) || !item.attachmentRefs.every(isNonEmptyString)) {
      throw new Error(`Swarm subtask ${id} attachmentRefs must be an array of strings`);
    }
    const attachmentRefs = item.attachmentRefs.filter(isNonEmptyString);
    const targetAgentId = readString(item.targetAgentId);
    if (!targetAgentId) {
      throw new Error(`Swarm subtask ${id} is missing targetAgentId`);
    }
    return {
      id,
      subObjective,
      input: item.input,
      attachmentRefs,
      targetAgentId,
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

function isFinalizedSwarmResult(value: unknown): boolean {
  return isRecord(value) && (value.status === 'succeeded' || value.status === 'failed');
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
        items: {
          type: 'object',
          required: ['id', 'subObjective', 'input', 'attachmentRefs', 'targetAgentId'],
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            subObjective: { type: 'string' },
            input: { type: ['string', 'null'] },
            attachmentRefs: { type: 'array', items: { type: 'string' } },
            targetAgentId,
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
        required: ['subtaskId', 'runId', 'usable', 'score', 'issues', 'recommendation'],
        additionalProperties: false,
        properties: {
          subtaskId: { type: 'string' },
          runId: { type: ['string', 'null'] },
          usable: { type: 'boolean' },
          score: { type: ['number', 'null'] },
          issues: { type: 'array', items: { type: 'string' } },
          recommendation: { type: 'string', enum: ['use', 'ignore', 'retry', 'needs_human'] },
        },
      },
    },
  },
};
