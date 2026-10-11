import { randomUUID } from 'node:crypto';

import { assertValidExecutionContext } from './adaptive-agent.js';
import { OrchestrationOptimisticConcurrencyError } from './in-memory-orchestration-store.js';
import type {
  AgentRun,
  JsonObject,
  JsonValue,
  OrchestrationExecution,
  OrchestrationStage,
  OrchestrationStore,
  RecoverRunOptions,
  RecoverRunResult,
  RunRecoveryPlan,
  RunRequest,
  RunResult,
} from './types.js';

/*
 * Prepared orchestration execution.
 *
 * Core owns the durable state machine for an already-prepared orchestration plan: stage scheduling,
 * pause/resume, interruption, recovery (assessment, CAS claims, reconcile, restart), session/run-link
 * projections, and result reconstruction. Plan construction, routing, catalog discovery, prompts, and
 * agent-profile runner creation are host concerns supplied through narrow hooks.
 */

/** Input modality vocabulary persisted in plans and routing decisions. */
export type OrchestrationModality = 'text' | 'image' | 'file' | 'audio';

export type OrchestrationRoutingMode = 'direct' | 'orchestration';
export type OrchestrationRoutingSource = 'deterministic' | 'agent' | 'typesafe';

/** Serialized routing decision data contract. Routing policy and profile capability checks are host-owned. */
export interface OrchestrationRoutingAssignment {
  agentId: string;
  modalities: OrchestrationModality[];
  reason: string;
}

export interface OrchestrationRoutingDecision {
  mode: OrchestrationRoutingMode;
  primaryAgentId: string;
  synthesisAgentId?: string;
  assignments: OrchestrationRoutingAssignment[];
  selectedCatalogAgentIds: string[];
  reason: string;
  confidence?: number;
  source: OrchestrationRoutingSource;
}

export type OrchestrationSessionStatus = 'routing' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled';
export type OrchestrationStageKind = 'single' | 'modality_specialist' | 'parallel_specialist' | 'subject_specialist' | 'final_synthesis';
export type OrchestrationExecutionShape = 'single' | 'sequential' | 'parallel_fanout_then_synthesis';
export type OrchestrationPlanNodeStatus = 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled' | 'skipped';

export interface InputClaim {
  id: string;
  modality: OrchestrationModality;
  source: 'goal' | 'images' | 'contentParts' | 'input';
  index?: number;
  mimeType?: string;
  name?: string;
}

export interface OrchestrationInputSelector {
  claimIds?: string[];
  includeGoal?: boolean;
  includeOriginalInput?: boolean;
  includePriorOutputs?: string[];
}

export interface OrchestrationPlanNode {
  id: string;
  agentId: string;
  stage: OrchestrationStageKind;
  dependsOn: string[];
  inputSelector?: OrchestrationInputSelector;
  outputRole?: string;
  metadata?: JsonObject;
}

export interface SubjectRoutingCandidateDiagnostic {
  agentId: string;
  score: number;
  matchedSubjects: string[];
  matchedKeywords: string[];
  selected: boolean;
  requestedAgent: boolean;
}

export interface OrchestrationRoutingDiagnostics {
  subjectCandidates: SubjectRoutingCandidateDiagnostic[];
}

export interface OrchestrationPlan {
  sessionId: string;
  executionId?: string;
  requestedAgentId: string;
  catalogFingerprint: string;
  detectedModalities: OrchestrationModality[];
  detectedSubjects: string[];
  inputClaims: InputClaim[];
  executionShape: OrchestrationExecutionShape;
  nodes: OrchestrationPlanNode[];
  finalNodeId: string;
  routingReason: string;
  routingDecision: OrchestrationRoutingDecision;
  routingDiagnostics: OrchestrationRoutingDiagnostics;
}

export interface OrchestrationSessionRecord {
  id: string;
  requestedAgentId: string;
  status: OrchestrationSessionStatus;
  executionShape: OrchestrationExecutionShape;
  detectedModalities: OrchestrationModality[];
  detectedSubjects?: string[];
  routingReason: string;
  metadata?: JsonObject;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface OrchestrationSessionRunLinkRecord {
  sessionId: string;
  nodeId: string;
  runId: string;
  rootRunId: string;
  stage: OrchestrationStageKind;
  agentId: string;
  requestedAgentId: string;
  status: OrchestrationPlanNodeStatus;
  dependsOn: string[];
  upstreamRunIds?: string[];
  metadata?: JsonObject;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface OrchestrationSessionInspection {
  session: OrchestrationSessionRecord | undefined;
  links: OrchestrationSessionRunLinkRecord[];
  plan?: OrchestrationPlan;
}

export interface OrchestrationExecutionInspection {
  execution: OrchestrationExecution | null;
  stages: OrchestrationStage[];
  plan?: OrchestrationPlan;
}

export interface OrchestrationConcurrencyPolicy {
  maxConcurrentRunsPerSession?: number;
  failurePolicy?: 'fail_fast' | 'wait_for_all';
}

export interface OrchestratedRunStageResult {
  nodeId: string;
  stage: OrchestrationStageKind;
  agentId: string;
  runId: string;
  rootRunId: string;
  result: RunResult;
}

export interface OrchestratedRunResult {
  sessionId: string;
  requestedAgentId: string;
  detectedModalities: OrchestrationModality[];
  detectedSubjects: string[];
  executionShape: OrchestrationExecutionShape;
  plan: OrchestrationPlan;
  stages: OrchestratedRunStageResult[];
  finalResult: RunResult;
}

export type OrchestrationLifecycleEvent =
  | {
      type: 'orchestration.plan.created';
      sessionId: string;
      requestedAgentId: string;
      executionShape: OrchestrationExecutionShape;
      detectedModalities: OrchestrationModality[];
      detectedSubjects: string[];
      routingReason: string;
      routingDecision: OrchestrationRoutingDecision;
      catalogFingerprint: string;
      nodes: Array<Pick<OrchestrationPlanNode, 'id' | 'agentId' | 'stage' | 'dependsOn'>>;
      createdAt: string;
    }
  | {
      type: 'orchestration.session.created' | 'orchestration.session.running';
      sessionId: string;
      requestedAgentId: string;
      status: OrchestrationSessionStatus;
      executionShape: OrchestrationExecutionShape;
      detectedModalities: OrchestrationModality[];
      detectedSubjects: string[];
      routingReason: string;
      createdAt: string;
    }
  | {
      type: 'orchestration.stage.starting';
      sessionId: string;
      requestedAgentId: string;
      nodeId: string;
      agentId: string;
      stage: OrchestrationStageKind;
      dependsOn: string[];
      createdAt: string;
    }
  | {
      type: 'orchestration.stage.linked';
      sessionId: string;
      requestedAgentId: string;
      nodeId: string;
      agentId: string;
      stage: OrchestrationStageKind;
      runId: string;
      rootRunId: string;
      status: OrchestrationPlanNodeStatus;
      createdAt: string;
    }
  | {
      type: 'orchestration.session.completed';
      sessionId: string;
      requestedAgentId: string;
      status: OrchestrationSessionStatus;
      executionShape: OrchestrationExecutionShape;
      finalRunId: string;
      createdAt: string;
    };

export interface OrchestrationSessionStore {
  create(session: OrchestrationSessionRecord): Promise<OrchestrationSessionRecord>;
  get(sessionId: string): Promise<OrchestrationSessionRecord | undefined>;
  update(session: OrchestrationSessionRecord): Promise<OrchestrationSessionRecord>;
}

export interface OrchestrationSessionRunLinkStore {
  append(link: OrchestrationSessionRunLinkRecord): Promise<OrchestrationSessionRunLinkRecord>;
  update(link: OrchestrationSessionRunLinkRecord): Promise<OrchestrationSessionRunLinkRecord>;
  listBySession(sessionId: string): Promise<OrchestrationSessionRunLinkRecord[]>;
  getByRunId(runId: string): Promise<OrchestrationSessionRunLinkRecord | undefined>;
}

export interface OrchestrationRecoveryOptions {
  /** Compute run recovery plans without mutating stores or invoking any model. */
  dryRun?: boolean;
  /** Forwarded to run-level recovery; continuation recovery may require it. */
  requireApproval?: boolean;
}

export type OrchestrationRecoveryOutcome = 'planned' | 'completed' | 'failed' | 'blocked' | 'busy';

export interface OrchestrationRecoveryResult {
  executionId: string;
  sessionId: string;
  outcome: OrchestrationRecoveryOutcome;
  plans: RunRecoveryPlan[];
  actions: RecoverRunResult[];
  reason?: string;
  result?: OrchestratedRunResult;
}

/** Run inspection projection the executor needs from a stage runner. */
export interface PreparedOrchestrationRunInspection {
  run: (Pick<AgentRun, 'rootRunId'> & Partial<Pick<AgentRun, 'id' | 'status' | 'result' | 'errorCode' | 'errorMessage' | 'usage' | 'leaseOwner' | 'leaseExpiresAt'>>) | null;
}

/** Core run capabilities of a stage runner. Starting a stage run goes through the `runNode` hook. */
export interface PreparedOrchestrationRunner {
  resumeRaw?(runId: string): Promise<RunResult>;
  /** Run-level recovery plan; must not call a model. Required for `recoverExecution` to recover a stage. */
  getRecoveryPlan?(runId: string): Promise<RunRecoveryPlan>;
  /** Executes one run-level recovery (resume, retry, or continuation). Required for `recoverExecution` to recover a stage. */
  recoverRaw?(options: RecoverRunOptions): Promise<RecoverRunResult>;
  interrupt?(runId: string): Promise<void>;
  inspect(runId: string): Promise<PreparedOrchestrationRunInspection>;
}

/** Default request option shape: a run request without its goal. Hosts may supply their own options type. */
export type PreparedOrchestrationRequestOptions = Omit<RunRequest, 'goal'>;

/** The original request persisted with an execution and replayed into each stage. */
export interface PreparedOrchestrationRequest<TOptions = PreparedOrchestrationRequestOptions> {
  goal: string;
  options: TOptions;
}

export interface PreparedOrchestrationRunNodeInput<TOptions, TRunner extends PreparedOrchestrationRunner> {
  runner: TRunner;
  goal: string;
  options: TOptions;
  plan: OrchestrationPlan;
  node: OrchestrationPlanNode;
  stage: OrchestrationStage;
  /** Allocated durable run ID for this stage; the run must be started with it. */
  runId: string;
  /** Orchestration session ID (not the execution ID) the stage run belongs to. */
  sessionId: string;
  priorResults: Map<string, OrchestratedRunStageResult>;
}

export interface PreparedOrchestrationExecutorOptions<TOptions = PreparedOrchestrationRequestOptions, TRunner extends PreparedOrchestrationRunner = PreparedOrchestrationRunner> {
  /** Returns the current durable orchestration store (read on every access). */
  getStore(): OrchestrationStore;
  sessionStore?: OrchestrationSessionStore;
  sessionRunLinkStore?: OrchestrationSessionRunLinkStore;
  /** Fingerprint of the catalog this executor may resume or recover against. */
  catalogFingerprint: string;
  /** Whether an agent ID is available to run stages. */
  hasAgent(agentId: string): boolean;
  getRunner(agentId: string): Promise<TRunner>;
  /** Starts one stage run with the allocated `runId` and `sessionId`. */
  runNode(input: PreparedOrchestrationRunNodeInput<TOptions, TRunner>): Promise<RunResult>;
  /** Invoked inside the recovery guard before the execution is loaded. */
  beforeRecovery?(): Promise<void>;
  now?: () => Date;
  concurrency?: OrchestrationConcurrencyPolicy;
  onLifecycleEvent?: (event: OrchestrationLifecycleEvent) => void;
  /**
   * While an execution is `routing`/`running`, stage activity newer than this is treated as owned by a
   * live scheduler and `recoverExecution` reports `busy`. Defaults to 60 seconds.
   */
  recoveryStaleAfterMs?: number;
}

export interface PreparedOrchestrationStartInput<TOptions = PreparedOrchestrationRequestOptions> {
  /** Durable execution ID; may differ from `plan.sessionId`. */
  executionId: string;
  plan: OrchestrationPlan;
  /** In-process request used to run stages for this call. */
  request: PreparedOrchestrationRequest<TOptions>;
  /** Request persisted with the execution and used on resume/recovery. */
  persistedRequest: PreparedOrchestrationRequest<TOptions>;
  catalogFingerprint: string;
  sessionMetadata?: JsonObject;
}

interface StageRecoveryItem { stage: OrchestrationStage; plan: RunRecoveryPlan; revertStatus: OrchestrationStage['status'] }
interface StageRestartItem { stage: OrchestrationStage; freshRunId: boolean }
interface ExecutionRecoveryAssessment {
  plans: RunRecoveryPlan[];
  busy?: string;
  blocked?: string;
  reconcile: Array<{ stage: OrchestrationStage; result: RunResult }>;
  recover: StageRecoveryItem[];
  restart: StageRestartItem[];
  preserved: string[];
  stageVersions: Map<string, number>;
}

type OrchestrationStageRunPatch = Partial<Pick<OrchestrationStage, 'status' | 'upstreamRunIds' | 'runId'>>;

const DEFAULT_RECOVERY_STALE_AFTER_MS = 60_000;
const RECOVERABLE_RUN_ACTIONS = new Set<RunRecoveryPlan['action']>(['resume_same_run', 'retry_same_run', 'continue_new_run']);

/** Durable executor for an already-prepared orchestration plan. */
export class PreparedOrchestrationExecutor<TOptions = PreparedOrchestrationRequestOptions, TRunner extends PreparedOrchestrationRunner = PreparedOrchestrationRunner> {
  private readonly sessionStore: OrchestrationSessionStore;
  private readonly linkStore: OrchestrationSessionRunLinkStore;
  private readonly plans = new Map<string, OrchestrationPlan>();
  private readonly now: () => Date;
  private readonly concurrency: Required<OrchestrationConcurrencyPolicy>;
  private readonly recoveringExecutions = new Set<string>();

  constructor(private readonly options: PreparedOrchestrationExecutorOptions<TOptions, TRunner>) {
    this.sessionStore = options.sessionStore ?? new InMemoryOrchestrationSessionStore();
    this.linkStore = options.sessionRunLinkStore ?? new InMemoryOrchestrationSessionRunLinkStore();
    this.now = options.now ?? (() => new Date());
    this.concurrency = {
      maxConcurrentRunsPerSession: options.concurrency?.maxConcurrentRunsPerSession ?? 2,
      failurePolicy: options.concurrency?.failurePolicy ?? 'fail_fast',
    };
  }

  private get orchestrationStore(): OrchestrationStore {
    return this.options.getStore();
  }

  /** Persists a prepared plan as a new execution, projects its session, and runs it. */
  async start(input: PreparedOrchestrationStartInput<TOptions>): Promise<OrchestratedRunResult> {
    const { executionId, plan, request } = input;
    validatePreparedPlan(plan);
    validatePreparedRequest(request);
    validatePreparedRequest(input.persistedRequest);
    if (!nonemptyString(executionId) || executionId !== (plan.executionId ?? plan.sessionId)) invalidPreparedExecution('execution identity does not match the plan');
    if (!nonemptyString(input.catalogFingerprint) || input.catalogFingerprint !== plan.catalogFingerprint) invalidPreparedExecution('catalog fingerprint does not match the plan');
    if (request.goal !== input.persistedRequest.goal) invalidPreparedExecution('live and persisted request goals differ');
    for (const node of plan.nodes) {
      if (!this.options.hasAgent(node.agentId)) invalidPreparedExecution(`agent "${node.agentId}" for stage ${node.id} is unavailable`);
    }
    const sessionId = plan.sessionId;
    const requestedAgentId = plan.requestedAgentId;
    this.plans.set(sessionId, plan);
    this.emitLifecycle({
      type: 'orchestration.plan.created',
      sessionId,
      requestedAgentId,
      executionShape: plan.executionShape,
      detectedModalities: plan.detectedModalities,
      detectedSubjects: plan.detectedSubjects,
      routingReason: plan.routingReason,
      routingDecision: plan.routingDecision,
      catalogFingerprint: plan.catalogFingerprint,
      nodes: plan.nodes.map((node) => ({ id: node.id, agentId: node.agentId, stage: node.stage, dependsOn: node.dependsOn })),
      createdAt: this.now().toISOString(),
    });

    const durable = await this.orchestrationStore.createExecution({
      id: executionId,
      request: jsonSafe(input.persistedRequest),
      catalogFingerprint: input.catalogFingerprint,
      plan: jsonSafe(plan),
      stages: plan.nodes.map((node) => ({ runId: randomRunId(), nodeId: node.id, agentId: node.agentId, status: 'queued', dependencies: node.dependsOn, upstreamRunIds: [] })),
    });
    const createdAt = this.now().toISOString();
    let session = await this.sessionStore.create({ id: sessionId, requestedAgentId, status: 'routing', executionShape: plan.executionShape, detectedModalities: plan.detectedModalities, detectedSubjects: plan.detectedSubjects, routingReason: plan.routingReason, metadata: input.sessionMetadata, createdAt, updatedAt: createdAt });
    this.emitLifecycle({ type: 'orchestration.session.created', sessionId, requestedAgentId, status: session.status, executionShape: plan.executionShape, detectedModalities: plan.detectedModalities, detectedSubjects: plan.detectedSubjects, routingReason: plan.routingReason, createdAt: this.now().toISOString() });
    session = await this.sessionStore.update({ ...session, status: 'running', updatedAt: this.now().toISOString() });
    this.emitLifecycle({ type: 'orchestration.session.running', sessionId, requestedAgentId, status: session.status, executionShape: plan.executionShape, detectedModalities: plan.detectedModalities, detectedSubjects: plan.detectedSubjects, routingReason: plan.routingReason, createdAt: this.now().toISOString() });

    return this.continueExecution(durable, request, plan, session);
  }

  async inspectSession(sessionId: string): Promise<OrchestrationSessionInspection> {
    const durable = await this.inspectExecution(sessionId);
    const plan = durable.execution ? parsePlan(durable.execution.plan, durable.execution.catalogFingerprint) : this.plans.get(sessionId);
    return { session: await this.sessionStore.get(sessionId), links: await this.linkStore.listBySession(sessionId), plan };
  }

  async inspectExecution(executionId: string): Promise<OrchestrationExecutionInspection> {
    const execution = await this.orchestrationStore.getExecution(executionId);
    return { execution, stages: execution ? await this.orchestrationStore.listStages(executionId) : [], plan: execution ? parsePlan(execution.plan, execution.catalogFingerprint) : undefined };
  }

  async interruptExecution(executionId: string): Promise<void> {
    let execution = await this.orchestrationStore.getExecution(executionId);
    if (!execution || ['succeeded', 'failed', 'cancelled'].includes(execution.status)) return;
    execution = await this.orchestrationStore.updateExecution(executionId, { status: 'cancelled' }, execution.version);
    const active = (await this.orchestrationStore.listStages(executionId)).filter((stage) => stage.status === 'running' || stage.status === 'paused');
    await Promise.all(active.map(async (stage) => {
      await (await this.getRunner(stage.agentId)).interrupt?.(stage.runId);
      const current = (await this.orchestrationStore.listStages(executionId)).find((item) => item.nodeId === stage.nodeId);
      if (current && (current.status === 'running' || current.status === 'paused')) await this.orchestrationStore.updateStage(executionId, stage.nodeId, { status: 'cancelled' }, current.version);
    }));
  }

  async resumeExecution(executionId: string): Promise<OrchestratedRunResult> {
    const execution = await this.orchestrationStore.getExecution(executionId);
    if (!execution) throw new Error(`Orchestration execution ${executionId} not found.`);
    if (execution.catalogFingerprint !== this.options.catalogFingerprint) throw new Error(`CATALOG_CHANGED: orchestration execution ${executionId} was created with a different catalog fingerprint.`);
    if (execution.status === 'cancelled') throw new Error(`Orchestration execution ${executionId} is cancelled.`);
    return this.continueExecution(execution, parseRequest<TOptions>(execution.request), parsePlan(execution.plan, execution.catalogFingerprint));
  }

  /**
   * Recovers an unfinished orchestration execution from its saved plan without redecomposing.
   *
   * Successful independent stages are preserved. Each failed, paused, or stale stage is recovered at most
   * once through its own runner (`getRecoveryPlan` + `recoverRaw`); continuation run IDs are persisted
   * on the stage and as session run links. Downstream stages whose upstream results change are restarted
   * with fresh run IDs and recomputed input, then the saved plan continues. Cancellation, catalog drift,
   * live leases, user action, and reconciliation requirements return `blocked` or `busy` instead.
   */
  async recoverExecution(executionId: string, options: OrchestrationRecoveryOptions = {}): Promise<OrchestrationRecoveryResult> {
    // Claim the in-process guard synchronously so concurrent callers cannot both pass it.
    const alreadyRecovering = this.recoveringExecutions.has(executionId);
    const ownsGuard = !options.dryRun && !alreadyRecovering;
    if (ownsGuard) this.recoveringExecutions.add(executionId);
    try {
      await this.options.beforeRecovery?.();
      const execution = await this.orchestrationStore.getExecution(executionId);
      if (!execution) throw new Error(`Orchestration execution ${executionId} not found.`);
      const plan = parsePlan(execution.plan, execution.catalogFingerprint);
      if (alreadyRecovering) {
        return { executionId, sessionId: plan.sessionId, outcome: 'busy', plans: [], actions: [], reason: `Recovery is already in progress for orchestration execution ${executionId}.` };
      }
      return await this.recoverExecutionWithGuard(execution, plan, options);
    } finally {
      if (ownsGuard) this.recoveringExecutions.delete(executionId);
    }
  }

  private async recoverExecutionWithGuard(execution: OrchestrationExecution, plan: OrchestrationPlan, options: OrchestrationRecoveryOptions): Promise<OrchestrationRecoveryResult> {
    const executionId = execution.id;
    const report = (outcome: OrchestrationRecoveryOutcome, fields: Partial<Omit<OrchestrationRecoveryResult, 'executionId' | 'sessionId' | 'outcome'>> = {}): OrchestrationRecoveryResult =>
      ({ executionId, sessionId: plan.sessionId, outcome, plans: [], actions: [], ...fields });

    if (execution.status === 'cancelled') return report('blocked', { reason: `Orchestration execution ${executionId} is cancelled.` });
    if (execution.catalogFingerprint !== this.options.catalogFingerprint) {
      return report('blocked', { reason: `CATALOG_CHANGED: orchestration execution ${executionId} was created with a different catalog fingerprint.` });
    }
    const missingAgent = plan.nodes.find((node) => !this.options.hasAgent(node.agentId));
    if (missingAgent) return report('blocked', { reason: `CATALOG_CHANGED: agent "${missingAgent.agentId}" for stage ${missingAgent.id} is not in the catalog.` });
    parseRequest<TOptions>(execution.request);
    await this.validateExecutionStages(execution, plan);
    if (execution.status === 'succeeded') {
      return report('completed', { reason: `Orchestration execution ${executionId} already succeeded; nothing to recover.`, result: await this.completedResult(execution.id, plan) });
    }

    const assessment = await this.assessRecovery(execution, plan, await this.orchestrationStore.listStages(executionId));
    if (assessment.busy) return report('busy', { plans: assessment.plans, reason: assessment.busy });
    if (assessment.blocked) return report('blocked', { plans: assessment.plans, reason: assessment.blocked });
    const summary = describeRecovery(assessment);
    if (options.dryRun) return report('planned', { plans: assessment.plans, reason: summary });

    // Optimistic execution claim: only one recoverer/scheduler can move this version forward.
    let claimed: OrchestrationExecution;
    try {
      claimed = await this.orchestrationStore.updateExecution(executionId, { status: 'running' }, execution.version);
    } catch (error) {
      if (isOptimisticConflict(error)) return report('busy', { plans: assessment.plans, reason: `Orchestration execution ${executionId} was claimed concurrently.` });
      throw error;
    }
    // Revalidate: stages must still match what was assessed, otherwise another writer is active.
    const revalidated = await this.orchestrationStore.listStages(executionId);
    if (revalidated.length !== assessment.stageVersions.size || revalidated.some((stage) => assessment.stageVersions.get(stage.nodeId) !== stage.version)) {
      await this.releaseRecoveryClaim(executionId, execution.status, claimed.version);
      return report('busy', { plans: assessment.plans, reason: `Orchestration execution ${executionId} changed while recovery was being planned.` });
    }

    const actions: RecoverRunResult[] = [];
    try {
      const session = await this.sessionStore.get(plan.sessionId);
      const runningSession = session && session.status !== 'running'
        ? await this.sessionStore.update({ ...session, status: 'running', updatedAt: this.now().toISOString(), completedAt: undefined })
        : session;

      for (const { stage, result } of assessment.reconcile) {
        await this.finishStage(await this.requireStage(executionId, stage.nodeId), result);
      }

      const recovered: Array<{ stage: OrchestrationStage; result: RunResult }> = [];
      for (const item of assessment.recover) {
        // Stage-level CAS claim against the assessed version (bumps it even when already `running`) prevents duplicate recovery.
        const stageClaim = await this.orchestrationStore.updateStage(executionId, item.stage.nodeId, { status: 'running' }, item.stage.version);
        const runner = await this.getRunner(stageClaim.agentId);
        const node = plan.nodes.find((candidate) => candidate.id === stageClaim.nodeId)!;
        let action: RecoverRunResult;
        try {
          action = await runner.recoverRaw!({
            runId: stageClaim.runId,
            strategy: 'auto',
            ...(options.requireApproval !== undefined ? { requireApproval: options.requireApproval } : {}),
            metadata: { orchestration: { kind: 'catalog', executionId, sessionId: plan.sessionId, nodeId: node.id, stage: node.stage, recoveryOfRunId: stageClaim.runId } },
          });
        } catch (error) {
          await this.revertStageClaim(stageClaim, item.revertStatus);
          await this.releaseRecoveryClaim(executionId, execution.status);
          return report('blocked', { plans: assessment.plans, actions, reason: `Recovery of stage ${node.id} (run ${stageClaim.runId}) failed: ${errorMessage(error)}` });
        }
        actions.push(action);
        if (!action.result) {
          await this.revertStageClaim(stageClaim, item.revertStatus);
          await this.releaseRecoveryClaim(executionId, execution.status);
          return report('blocked', { plans: assessment.plans, actions, reason: `Recovery of stage ${node.id} (run ${stageClaim.runId}) returned no run result.` });
        }
        const finished = await this.persistRecoveredStage(plan, node, stageClaim, action.result);
        recovered.push({ stage: finished, result: action.result });
        if (isPaused(action.result) || (action.result.status === 'failure' && this.concurrency.failurePolicy === 'fail_fast')) break;
      }

      const paused = recovered.find(({ result }) => isPaused(result));
      if (paused) {
        await this.pauseExecution((await this.orchestrationStore.getExecution(executionId))!);
        if (runningSession) await this.sessionStore.update({ ...runningSession, status: 'paused', updatedAt: this.now().toISOString() });
        return report('blocked', {
          plans: assessment.plans,
          actions,
          reason: `Stage ${paused.stage.nodeId} (run ${paused.stage.runId}) requires user action after recovery.`,
          result: this.pausedResult(plan, await this.loadCompletedResults(executionId, plan), paused.stage.runId, paused.result),
        });
      }

      const failFastFailure = this.concurrency.failurePolicy === 'fail_fast' && recovered.some(({ result }) => result.status === 'failure');
      if (!failFastFailure) {
        for (const item of assessment.restart) {
          await this.patchStageRun(item.stage, { status: 'queued', upstreamRunIds: [], ...(item.freshRunId ? { runId: randomRunId() } : {}) }, item.stage.version);
        }
      }

      const latest = (await this.orchestrationStore.getExecution(executionId))!;
      const result = await this.continueExecution(latest, parseRequest<TOptions>(latest.request), plan, runningSession);
      const outcome: OrchestrationRecoveryOutcome = result.finalResult.status === 'success' ? 'completed' : result.finalResult.status === 'failure' ? 'failed' : 'blocked';
      return report(outcome, { plans: assessment.plans, actions, reason: outcome === 'blocked' ? 'Orchestration execution paused for user action.' : summary, result });
    } catch (error) {
      const latest = await this.orchestrationStore.getExecution(executionId);
      if (latest?.status === 'cancelled') return report('blocked', { plans: assessment.plans, actions, reason: `Orchestration execution ${executionId} was cancelled during recovery.` });
      if (isOptimisticConflict(error)) return report('busy', { plans: assessment.plans, actions, reason: `Orchestration execution ${executionId} was modified concurrently during recovery: ${errorMessage(error)}` });
      throw error;
    }
  }

  /** Read-only classification of every stage. Never calls a model or mutates stores. */
  private async assessRecovery(execution: OrchestrationExecution, plan: OrchestrationPlan, stages: OrchestrationStage[]): Promise<ExecutionRecoveryAssessment> {
    const assessment: ExecutionRecoveryAssessment = { plans: [], reconcile: [], recover: [], restart: [], preserved: [], stageVersions: new Map(stages.map((stage) => [stage.nodeId, stage.version])) };
    const byNode = new Map(stages.map((stage) => [stage.nodeId, stage]));
    const nowMs = this.now().getTime();
    const staleAfterMs = this.options.recoveryStaleAfterMs ?? DEFAULT_RECOVERY_STALE_AFTER_MS;
    const executionActive = execution.status === 'routing' || execution.status === 'running';
    const isRecent = (timestamp: string): boolean => executionActive && nowMs - Date.parse(timestamp) < staleAfterMs;
    const changed = new Set<string>();

    const planRecovery = async (stage: OrchestrationStage, revertStatus: OrchestrationStage['status']): Promise<string | undefined> => {
      const runner = await this.getRunner(stage.agentId);
      if (!runner.getRecoveryPlan || !runner.recoverRaw) return `Stage ${stage.nodeId} (agent "${stage.agentId}") runner does not support run recovery.`;
      let runPlan: RunRecoveryPlan;
      try {
        runPlan = await runner.getRecoveryPlan(stage.runId);
      } catch (error) {
        return `Stage ${stage.nodeId} (run ${stage.runId}) has no recovery plan: ${errorMessage(error)}`;
      }
      assessment.plans.push(runPlan);
      if (!runPlan.executable || !RECOVERABLE_RUN_ACTIONS.has(runPlan.action)) {
        return `Stage ${stage.nodeId} (run ${stage.runId}) cannot be recovered automatically (${runPlan.action}): ${runPlan.reason}`;
      }
      assessment.recover.push({ stage, plan: runPlan, revertStatus });
      return undefined;
    };

    for (const node of topologicalNodes(plan)) {
      const stage = byNode.get(node.id);
      if (!stage) {
        assessment.blocked ??= `Orchestration execution ${execution.id} has no durable stage for plan node ${node.id}.`;
        continue;
      }
      const upstreamChanged = node.dependsOn.some((dependency) => changed.has(dependency));
      let blocked: string | undefined;
      switch (stage.status) {
        case 'queued':
          changed.add(node.id);
          break;
        case 'succeeded':
          if (upstreamChanged) {
            assessment.restart.push({ stage, freshRunId: true });
            changed.add(node.id);
          } else {
            assessment.preserved.push(node.id);
          }
          break;
        case 'skipped':
        case 'cancelled':
          assessment.restart.push({ stage, freshRunId: true });
          changed.add(node.id);
          break;
        case 'failed':
        case 'paused': {
          changed.add(node.id);
          const runner = await this.getRunner(stage.agentId);
          const run = (await runner.inspect(stage.runId)).run;
          if (run && hasLiveLease(run, nowMs)) {
            assessment.busy ??= `Stage ${node.id} run ${stage.runId} holds a live lease.`;
            break;
          }
          if (stage.status === 'failed' && upstreamChanged) {
            // Input changes do not grant permission to bypass user action or uncertain side effects.
            if (!runner.getRecoveryPlan) {
              blocked = `Stage ${node.id} runner does not support run recovery.`;
              break;
            }
            const prior = await runner.getRecoveryPlan(stage.runId);
            if (prior.action === 'requires_user_action' || prior.action === 'requires_reconciliation') {
              assessment.plans.push(prior);
              blocked = `Stage ${node.id} (run ${stage.runId}) cannot restart automatically (${prior.action}): ${prior.reason}`;
              break;
            }
            // Its input is stale: restart with a fresh run instead of recovering the old one.
            assessment.restart.push({ stage, freshRunId: true });
            break;
          }
          blocked = await planRecovery(stage, stage.status);
          break;
        }
        case 'running': {
          const run = (await (await this.getRunner(stage.agentId)).inspect(stage.runId)).run;
          if (run && hasLiveLease(run, nowMs)) {
            assessment.busy ??= `Stage ${node.id} run ${stage.runId} holds a live lease.`;
            break;
          }
          if (isRecent(stage.updatedAt)) {
            assessment.busy ??= `Stage ${node.id} run ${stage.runId} is owned by an active scheduler.`;
            break;
          }
          changed.add(node.id);
          if (!run) {
            // The stage was claimed but its run never started: restart it with its allocated run ID.
            assessment.restart.push({ stage, freshRunId: false });
          } else if (run.status === 'succeeded') {
            assessment.reconcile.push({ stage, result: resultFromStoredRun(stage.runId, run)! });
            changed.delete(node.id);
          } else if (run.status === 'awaiting_approval' || run.status === 'clarification_requested') {
            blocked = `Stage ${node.id} run ${stage.runId} is ${run.status}; user action is required.`;
          } else {
            blocked = await planRecovery(stage, run.status === 'failed' || run.status === 'cancelled' ? 'failed' : 'running');
          }
          break;
        }
      }
      if (blocked) assessment.blocked ??= blocked;
    }
    if (!assessment.busy && executionActive) {
      // A routing/running execution with recent activity is owned by a live scheduler or another recovery
      // (recovery claims bump the execution), so do not plan duplicate continuation or finalizer work.
      const lastActivity = Math.max(Date.parse(execution.updatedAt), ...stages.map((stage) => Date.parse(stage.updatedAt)));
      if (nowMs - lastActivity < staleAfterMs) assessment.busy = `Orchestration execution ${execution.id} is ${execution.status} and recently active.`;
    }
    return assessment;
  }

  /** Persists a recovered run on its stage (including a continuation run ID) and in session run links. */
  private async persistRecoveredStage(plan: OrchestrationPlan, node: OrchestrationPlanNode, claimed: OrchestrationStage, result: RunResult): Promise<OrchestrationStage> {
    const status: OrchestrationStage['status'] = result.status === 'success' ? 'succeeded' : result.status === 'failure' ? 'failed' : 'paused';
    const runId = result.runId;
    const current = await this.requireStage(claimed.executionId, claimed.nodeId);
    const execution = await this.orchestrationStore.getExecution(claimed.executionId);
    if (execution?.status === 'cancelled' || current.status === 'cancelled') throw new Error(`Orchestration execution ${claimed.executionId} is cancelled.`);
    const finished = await this.patchStageRun(current, { status, ...(runId !== current.runId ? { runId } : {}) }, current.version);
    const runner = await this.getRunner(claimed.agentId);
    const rootRunId = (await runner.inspect(runId)).run?.rootRunId ?? runId;
    const now = this.now().toISOString();
    const existing = await this.linkStore.getByRunId(runId);
    if (existing && existing.sessionId === plan.sessionId && existing.nodeId === node.id) {
      await this.linkStore.update({ ...existing, rootRunId, status, completedAt: status === 'paused' ? existing.completedAt : now });
    } else {
      const upstreamRunIds = finished.upstreamRunIds;
      const metadata: JsonObject = { ...(node.metadata ?? {}), ...(runId !== claimed.runId ? { recoveredFromRunId: claimed.runId } : {}) };
      await this.linkStore.append({ sessionId: plan.sessionId, nodeId: node.id, runId, rootRunId, stage: node.stage, agentId: claimed.agentId, requestedAgentId: plan.requestedAgentId, status, dependsOn: node.dependsOn, upstreamRunIds, metadata, createdAt: now, startedAt: now, ...(status === 'paused' ? {} : { completedAt: now }) });
    }
    this.emitLifecycle({ type: 'orchestration.stage.linked', sessionId: plan.sessionId, requestedAgentId: plan.requestedAgentId, nodeId: node.id, agentId: claimed.agentId, stage: node.stage, runId, rootRunId, status, createdAt: now });
    return finished;
  }

  /** Updates a stage, including its run ID. Verifies stores that predate run ID patches did not drop it. */
  private async patchStageRun(stage: OrchestrationStage, patch: OrchestrationStageRunPatch, expectedVersion: number): Promise<OrchestrationStage> {
    const updated = await this.orchestrationStore.updateStage(stage.executionId, stage.nodeId, patch as Parameters<OrchestrationStore['updateStage']>[2], expectedVersion);
    if (patch.runId && updated.runId !== patch.runId) {
      throw new Error(`ORCHESTRATION_STORE_UNSUPPORTED: orchestration store did not persist run ID ${patch.runId} for stage ${stage.nodeId}.`);
    }
    return updated;
  }

  private async requireStage(executionId: string, nodeId: string): Promise<OrchestrationStage> {
    const stage = (await this.orchestrationStore.listStages(executionId)).find((item) => item.nodeId === nodeId);
    if (!stage) throw new Error(`Orchestration stage ${nodeId} not found.`);
    return stage;
  }

  private async revertStageClaim(claimed: OrchestrationStage, status: OrchestrationStage['status']): Promise<void> {
    try {
      const current = await this.requireStage(claimed.executionId, claimed.nodeId);
      if (current.version === claimed.version && current.status !== status) await this.orchestrationStore.updateStage(claimed.executionId, claimed.nodeId, { status }, current.version);
    } catch (error) {
      if (!isOptimisticConflict(error)) throw error;
    }
  }

  private async releaseRecoveryClaim(executionId: string, status: OrchestrationExecution['status'], expectedVersion?: number): Promise<void> {
    try {
      const current = await this.orchestrationStore.getExecution(executionId);
      if (!current || current.status === 'cancelled' || current.status === status) return;
      if (expectedVersion !== undefined && current.version !== expectedVersion) return;
      await this.orchestrationStore.updateExecution(executionId, { status }, current.version);
    } catch (error) {
      if (!isOptimisticConflict(error)) throw error;
    }
  }

  private async completedResult(executionId: string, plan: OrchestrationPlan): Promise<OrchestratedRunResult | undefined> {
    try {
      const results = await this.loadCompletedResults(executionId, plan);
      const finalResult = results.get(plan.finalNodeId)?.result ?? [...results.values()].at(-1)?.result;
      return finalResult ? this.result(plan, results, finalResult) : undefined;
    } catch {
      return undefined;
    }
  }

  private async continueExecution(durable: OrchestrationExecution, request: PreparedOrchestrationRequest<TOptions>, plan: OrchestrationPlan, legacySession?: OrchestrationSessionRecord): Promise<OrchestratedRunResult> {
    validatePreparedRequest(request);
    await this.validateExecutionStages(durable, plan);
    let execution = durable.status === 'routing' || durable.status === 'paused'
      ? await this.orchestrationStore.updateExecution(durable.id, { status: 'running' }, durable.version)
      : durable;
    const results = await this.loadCompletedResults(execution.id, plan);
    let failedResult = this.concurrency.failurePolicy === 'fail_fast'
      ? [...results.values()].find((stage) => stage.result.status === 'failure')?.result
      : undefined;
    while (true) {
      if (failedResult) break;
      execution = (await this.orchestrationStore.getExecution(execution.id))!;
      if (execution.status === 'cancelled') throw new Error(`Orchestration execution ${execution.id} is cancelled.`);
      const stages = await this.orchestrationStore.listStages(execution.id);
      const paused = stages.find((stage) => stage.status === 'paused');
      if (paused) {
        const runner = await this.getRunner(paused.agentId);
        if (!runner.resumeRaw) {
          await this.pauseExecution(execution);
          return this.pausedResult(plan, results, paused.runId);
        }
        const resumed = await runner.resumeRaw(paused.runId);
        await this.finishStage(paused, resumed);
        if (isPaused(resumed)) {
          await this.pauseExecution((await this.orchestrationStore.getExecution(execution.id))!);
          return this.pausedResult(plan, results, resumed.runId, resumed);
        }
        results.set(paused.nodeId, this.stageResult(plan, paused, resumed));
        if (resumed.status === 'failure' && this.concurrency.failurePolicy === 'fail_fast') {
          failedResult = resumed;
          break;
        }
        continue;
      }
      const active = stages.filter((stage) => stage.status === 'running');
      if (active.length > 0) {
        let unresolvedRunId: string | undefined;
        for (const stage of active) {
          const recovered = await this.reconcileRunningStage(stage, plan);
          if (!recovered) {
            unresolvedRunId ??= stage.runId;
            continue;
          }
          results.set(stage.nodeId, recovered);
          if (isPaused(recovered.result)) {
            await this.pauseExecution((await this.orchestrationStore.getExecution(execution.id))!);
            return this.pausedResult(plan, results, recovered.runId, recovered.result);
          }
          if (recovered.result.status === 'failure' && this.concurrency.failurePolicy === 'fail_fast') {
            failedResult ??= recovered.result;
          }
        }
        if (failedResult) break;
        if (unresolvedRunId) return this.pausedResult(plan, results, unresolvedRunId);
        continue;
      }
      const claims: OrchestrationStage[] = [];
      while (claims.length < this.concurrency.maxConcurrentRunsPerSession) {
        const claimed = await this.orchestrationStore.claimReadyStage(execution.id);
        if (!claimed) break;
        claims.push(claimed);
      }
      if (claims.length === 0) break;
      const settled = await Promise.all(claims.map((stage) => this.executeNode(request.goal, request.options, plan, plan.nodes.find((node) => node.id === stage.nodeId)!, stage, results)));
      let pausedResult: OrchestratedRunStageResult | undefined;
      for (const result of settled) {
        results.set(result.nodeId, result);
        if (isPaused(result.result)) pausedResult ??= result;
        if (result.result.status === 'failure' && this.concurrency.failurePolicy === 'fail_fast') failedResult ??= result.result;
      }
      if (failedResult) break;
      if (pausedResult) {
        await this.pauseExecution((await this.orchestrationStore.getExecution(execution.id))!);
        return this.pausedResult(plan, results, pausedResult.runId, pausedResult.result);
      }
    }
    if (failedResult) await this.stopUnfinishedStages(execution.id);
    const finalResult = failedResult ?? results.get(plan.finalNodeId)?.result ?? [...results.values()].at(-1)?.result;
    if (!finalResult) throw new Error(`Orchestration plan ${execution.id} completed without a final result.`);
    const completedStatus = finalResult.status === 'success' ? 'succeeded' : 'failed';
    execution = await this.orchestrationStore.updateExecution(execution.id, { status: completedStatus }, execution.version);
    if (legacySession) await this.sessionStore.update({ ...legacySession, status: completedStatus, updatedAt: this.now().toISOString(), completedAt: this.now().toISOString() });
    this.emitLifecycle({ type: 'orchestration.session.completed', sessionId: plan.sessionId, requestedAgentId: plan.requestedAgentId, status: completedStatus, executionShape: plan.executionShape, finalRunId: finalResult.runId, createdAt: this.now().toISOString() });
    return this.result(plan, results, finalResult);
  }

  private async executeNode(goal: string, options: TOptions, plan: OrchestrationPlan, node: OrchestrationPlanNode, stage: OrchestrationStage, priorResults: Map<string, OrchestratedRunStageResult>): Promise<OrchestratedRunStageResult> {
    this.emitLifecycle({ type: 'orchestration.stage.starting', sessionId: plan.sessionId, requestedAgentId: plan.requestedAgentId, nodeId: node.id, agentId: node.agentId, stage: node.stage, dependsOn: node.dependsOn, createdAt: this.now().toISOString() });
    const runner = await this.getRunner(node.agentId);
    const startedAt = this.now().toISOString();
    const result = await this.options.runNode({ runner, goal, options, plan, node, stage, runId: stage.runId, sessionId: plan.sessionId, priorResults });
    const rootRunId = (await runner.inspect(result.runId)).run?.rootRunId ?? result.runId;
    const completedAt = this.now().toISOString();
    const status = result.status === 'success' ? 'succeeded' : result.status === 'failure' ? 'failed' : 'paused';
    await this.finishStage(stage, result, node.dependsOn.map((dependency) => priorResults.get(dependency)?.runId).filter((runId): runId is string => Boolean(runId)));
    await this.linkStore.append({ sessionId: plan.sessionId, nodeId: node.id, runId: result.runId, rootRunId, stage: node.stage, agentId: node.agentId, requestedAgentId: plan.requestedAgentId, status, dependsOn: node.dependsOn, upstreamRunIds: node.dependsOn.map((dependency) => priorResults.get(dependency)?.runId).filter((runId): runId is string => Boolean(runId)), metadata: node.metadata, createdAt: startedAt, startedAt, completedAt });
    this.emitLifecycle({ type: 'orchestration.stage.linked', sessionId: plan.sessionId, requestedAgentId: plan.requestedAgentId, nodeId: node.id, agentId: node.agentId, stage: node.stage, runId: result.runId, rootRunId, status, createdAt: this.now().toISOString() });
    return { nodeId: node.id, stage: node.stage, agentId: node.agentId, runId: result.runId, rootRunId, result };
  }

  private async finishStage(stage: OrchestrationStage, result: RunResult, upstreamRunIds?: string[]): Promise<OrchestrationStage> {
    const execution = await this.orchestrationStore.getExecution(stage.executionId);
    const current = (await this.orchestrationStore.listStages(stage.executionId)).find((item) => item.nodeId === stage.nodeId);
    if (!execution || !current) throw new Error(`Orchestration stage ${stage.nodeId} not found.`);
    if (execution.status === 'cancelled' || current.status === 'cancelled') return current;
    return this.orchestrationStore.updateStage(stage.executionId, stage.nodeId, {
      status: result.status === 'success' ? 'succeeded' : result.status === 'failure' ? 'failed' : 'paused',
      ...(upstreamRunIds ? { upstreamRunIds } : {}),
    }, current.version);
  }

  private async reconcileRunningStage(stage: OrchestrationStage, plan: OrchestrationPlan): Promise<OrchestratedRunStageResult | undefined> {
    const runner = await this.getRunner(stage.agentId);
    const run = (await runner.inspect(stage.runId)).run;
    if (!run) {
      const request = parseRequest<TOptions>((await this.orchestrationStore.getExecution(stage.executionId))!.request);
      const node = plan.nodes.find((item) => item.id === stage.nodeId)!;
      return this.executeNode(request.goal, request.options, plan, node, stage, await this.loadCompletedResults(stage.executionId, plan));
    }
    const stored = resultFromStoredRun(stage.runId, run);
    const result = stored ?? (runner.resumeRaw ? await runner.resumeRaw(stage.runId) : undefined);
    if (!result) return undefined;
    await this.finishStage(stage, result);
    return this.stageResult(plan, stage, result);
  }

  private stageResult(plan: OrchestrationPlan, stage: OrchestrationStage, result: RunResult): OrchestratedRunStageResult {
    const node = plan.nodes.find((item) => item.id === stage.nodeId)!;
    return { nodeId: node.id, stage: node.stage, agentId: stage.agentId, runId: stage.runId, rootRunId: stage.runId, result };
  }

  private async loadCompletedResults(executionId: string, plan: OrchestrationPlan): Promise<Map<string, OrchestratedRunStageResult>> {
    const results = new Map<string, OrchestratedRunStageResult>();
    for (const stage of await this.orchestrationStore.listStages(executionId)) {
      if (stage.status !== 'succeeded' && stage.status !== 'failed') continue;
      const run = (await (await this.getRunner(stage.agentId)).inspect(stage.runId)).run;
      if (!run) throw new Error(`ORCHESTRATION_RECOVERY_REQUIRED: stage run ${stage.runId} is unavailable.`);
      const result: RunResult = stage.status === 'succeeded'
        ? { status: 'success', runId: stage.runId, output: run.result ?? null, stepsUsed: 0, usage: run.usage ?? emptyUsage() }
        : { status: 'failure', runId: stage.runId, error: run.errorMessage ?? 'Stage failed', code: (run.errorCode ?? 'MODEL_ERROR') as Extract<RunResult, { status: 'failure' }>['code'], stepsUsed: 0, usage: run.usage ?? emptyUsage() };
      results.set(stage.nodeId, this.stageResult(plan, stage, result));
    }
    return results;
  }

  private pausedResult(plan: OrchestrationPlan, results: Map<string, OrchestratedRunStageResult>, runId: string, paused?: RunResult): OrchestratedRunResult {
    const finalResult: RunResult = paused && isPaused(paused)
      ? paused
      : { status: 'clarification_requested', runId, message: 'Orchestration execution is paused.' };
    return this.result(plan, results, finalResult);
  }

  private async stopUnfinishedStages(executionId: string): Promise<void> {
    for (const stage of await this.orchestrationStore.listStages(executionId)) {
      if (stage.status === 'queued') {
        await this.orchestrationStore.updateStage(executionId, stage.nodeId, { status: 'skipped' }, stage.version);
      } else if (stage.status === 'running' || stage.status === 'paused') {
        await (await this.getRunner(stage.agentId)).interrupt?.(stage.runId);
        const current = (await this.orchestrationStore.listStages(executionId)).find((item) => item.nodeId === stage.nodeId);
        if (current && (current.status === 'running' || current.status === 'paused')) {
          await this.orchestrationStore.updateStage(executionId, stage.nodeId, { status: 'cancelled' }, current.version);
        }
      }
    }
  }

  private async pauseExecution(execution: OrchestrationExecution): Promise<void> {
    if (execution.status === 'running') await this.orchestrationStore.updateExecution(execution.id, { status: 'paused' }, execution.version);
  }

  private result(plan: OrchestrationPlan, results: Map<string, OrchestratedRunStageResult>, finalResult: RunResult): OrchestratedRunResult {
    return { sessionId: plan.sessionId, requestedAgentId: plan.requestedAgentId, detectedModalities: plan.detectedModalities, detectedSubjects: plan.detectedSubjects, executionShape: plan.executionShape, plan, stages: plan.nodes.map((node) => results.get(node.id)).filter((result): result is OrchestratedRunStageResult => Boolean(result)), finalResult };
  }

  private emitLifecycle(event: OrchestrationLifecycleEvent): void {
    this.options.onLifecycleEvent?.(event);
  }

  private async validateExecutionStages(execution: OrchestrationExecution, plan: OrchestrationPlan): Promise<void> {
    if (plan.executionId !== undefined && plan.executionId !== execution.id) invalidPreparedExecution('stored execution identity does not match the plan');
    if (plan.catalogFingerprint !== execution.catalogFingerprint) invalidPreparedExecution('stored catalog fingerprint does not match the plan');
    const stages = await this.orchestrationStore.listStages(execution.id);
    if (stages.length !== plan.nodes.length) invalidPreparedExecution('stored stages do not match the plan');
    const nodeIds = new Set<string>();
    for (const stage of stages) {
      const node = plan.nodes.find((candidate) => candidate.id === stage.nodeId);
      if (!node || nodeIds.has(stage.nodeId) || stage.executionId !== execution.id || stage.agentId !== node.agentId || !nonemptyString(stage.runId)
        || stage.dependencies.length !== node.dependsOn.length || !node.dependsOn.every((id) => stage.dependencies.includes(id))) {
        invalidPreparedExecution(`stored stage ${stage.nodeId} does not match the plan`);
      }
      nodeIds.add(stage.nodeId);
    }
  }

  private getRunner(agentId: string): Promise<TRunner> {
    return this.options.getRunner(agentId);
  }
}

/** Parses a persisted plan, upgrading legacy plans that predate stored routing decisions/fingerprints. */
function parsePlan(value: JsonValue, catalogFingerprint?: string): OrchestrationPlan {
  const plan = value as unknown as OrchestrationPlan;
  validatePreparedPlan(plan);
  if (plan.routingDecision && plan.catalogFingerprint) return plan;
  const assignments = new Map<string, OrchestrationModality[]>();
  for (const modality of plan.detectedModalities) {
    const specialist = plan.nodes.find((node) => node.inputSelector?.claimIds?.some((claimId) =>
      plan.inputClaims.find((claim) => claim.id === claimId)?.modality === modality
    ));
    const agentId = specialist?.agentId ?? plan.requestedAgentId;
    assignments.set(agentId, [...(assignments.get(agentId) ?? []), modality]);
  }
  const synthesisAgentId = plan.nodes.find((node) => node.stage === 'final_synthesis')?.agentId;
  const routingDecision: OrchestrationRoutingDecision = {
    mode: 'orchestration',
    primaryAgentId: plan.requestedAgentId,
    ...(synthesisAgentId ? { synthesisAgentId } : {}),
    assignments: [...assignments].map(([agentId, modalities]) => ({ agentId, modalities, reason: 'Recovered from a legacy orchestration plan.' })),
    selectedCatalogAgentIds: unique(plan.nodes.map((node) => node.agentId)),
    reason: plan.routingReason,
    source: 'deterministic',
  };
  return { ...plan, catalogFingerprint: catalogFingerprint ?? 'legacy', routingDecision };
}

function parseRequest<TOptions>(value: JsonValue): PreparedOrchestrationRequest<TOptions> {
  validatePreparedRequest(value as unknown as PreparedOrchestrationRequest<TOptions>);
  return value as unknown as PreparedOrchestrationRequest<TOptions>;
}

function validatePreparedRequest(request: PreparedOrchestrationRequest<unknown>): void {
  if (!request || typeof request.goal !== 'string' || !request.options || typeof request.options !== 'object' || Array.isArray(request.options)) {
    invalidPreparedExecution('request must contain a string goal and an options object');
  }
  assertValidExecutionContext((request.options as Record<string, unknown>).executionContext);
}

/** Structural execution checks only; selecting profiles and judging routing policy remain host-owned. */
function validatePreparedPlan(plan: OrchestrationPlan): void {
  if (!plan || !nonemptyString(plan.sessionId) || !nonemptyString(plan.requestedAgentId)
    || (plan.executionId !== undefined && !nonemptyString(plan.executionId))
    || !Array.isArray(plan.nodes) || plan.nodes.length === 0 || !Array.isArray(plan.inputClaims)
    || !Array.isArray(plan.detectedModalities) || plan.detectedModalities.some((modality) => !['text', 'image', 'file', 'audio'].includes(modality))
    || !Array.isArray(plan.detectedSubjects) || plan.detectedSubjects.some((subject) => typeof subject !== 'string')) {
    invalidPreparedExecution('plan identity, nodes, input claims and detected inputs are required');
  }
  const claimIds = new Set<string>();
  for (const claim of plan.inputClaims) {
    if (!claim || !nonemptyString(claim.id) || claimIds.has(claim.id) || !['text', 'image', 'file', 'audio'].includes(claim.modality)
      || !['goal', 'images', 'contentParts', 'input'].includes(claim.source)
      || (claim.index !== undefined && (!Number.isInteger(claim.index) || claim.index < 0))) invalidPreparedExecution('input claims are invalid');
    claimIds.add(claim.id);
  }
  const nodeIds = new Set<string>();
  for (const node of plan.nodes) {
    if (!node || !nonemptyString(node.id) || nodeIds.has(node.id) || !nonemptyString(node.agentId)
      || !['single', 'modality_specialist', 'parallel_specialist', 'subject_specialist', 'final_synthesis'].includes(node.stage)
      || !Array.isArray(node.dependsOn) || node.dependsOn.some((id) => !nonemptyString(id)) || new Set(node.dependsOn).size !== node.dependsOn.length) {
      invalidPreparedExecution('plan nodes require unique IDs, agents, valid stages and dependency lists');
    }
    nodeIds.add(node.id);
  }
  if (!nodeIds.has(plan.finalNodeId)) invalidPreparedExecution('final node is not in the plan');
  for (const node of plan.nodes) {
    if (node.dependsOn.some((id) => !nodeIds.has(id))) invalidPreparedExecution(`stage ${node.id} has an unknown dependency`);
    const selector = node.inputSelector;
    if (selector?.claimIds !== undefined && (!Array.isArray(selector.claimIds) || selector.claimIds.some((id) => !claimIds.has(id)))) invalidPreparedExecution(`stage ${node.id} selects an unknown input claim`);
    if (selector?.includePriorOutputs !== undefined && (!Array.isArray(selector.includePriorOutputs) || selector.includePriorOutputs.some((id) => !node.dependsOn.includes(id)))) invalidPreparedExecution(`stage ${node.id} selects a non-dependency output`);
  }
  // Validate the existing dependency graph before any durable claim or run launch.
  topologicalNodes(plan);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function invalidPreparedExecution(reason: string): never {
  throw new Error(`INVALID_PREPARED_ORCHESTRATION: ${reason}.`);
}

function jsonSafe(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function isPaused(result: RunResult): boolean {
  return result.status === 'approval_requested' || result.status === 'clarification_requested';
}

const TERMINAL_STAGE_RUN_STATUSES = new Set<string>(['succeeded', 'failed', 'cancelled', 'clarification_requested', 'replan_required']);

function hasLiveLease(run: Partial<Pick<AgentRun, 'status' | 'leaseOwner' | 'leaseExpiresAt'>>, nowMs: number): boolean {
  if (run.status && TERMINAL_STAGE_RUN_STATUSES.has(run.status)) return false;
  if (run.leaseExpiresAt) return Date.parse(run.leaseExpiresAt) > nowMs;
  return Boolean(run.leaseOwner);
}

function isOptimisticConflict(error: unknown): boolean {
  return error instanceof OrchestrationOptimisticConcurrencyError
    || (error instanceof Error && error.name === 'OrchestrationOptimisticConcurrencyError');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function topologicalNodes(plan: OrchestrationPlan): OrchestrationPlanNode[] {
  const ordered: OrchestrationPlanNode[] = [];
  const placed = new Set<string>();
  while (ordered.length < plan.nodes.length) {
    const next = plan.nodes.filter((node) => !placed.has(node.id) && node.dependsOn.every((dependency) => placed.has(dependency)));
    if (next.length === 0) throw new Error(`Orchestration plan ${plan.executionId ?? plan.sessionId} has a dependency cycle or unknown dependency.`);
    for (const node of next) {
      ordered.push(node);
      placed.add(node.id);
    }
  }
  return ordered;
}

function describeRecovery(assessment: ExecutionRecoveryAssessment): string {
  const parts = [
    assessment.recover.length > 0 ? `recover ${assessment.recover.map((item) => `${item.stage.nodeId} (${item.plan.action})`).join(', ')}` : undefined,
    assessment.reconcile.length > 0 ? `reconcile ${assessment.reconcile.map((item) => item.stage.nodeId).join(', ')}` : undefined,
    assessment.restart.length > 0 ? `restart ${assessment.restart.map((item) => item.stage.nodeId).join(', ')}` : undefined,
    assessment.preserved.length > 0 ? `preserve ${assessment.preserved.join(', ')}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? `Recovery plan: ${parts.join('; ')}.` : 'No stage requires recovery; the saved plan will be continued.';
}

function emptyUsage(): Extract<RunResult, { status: 'success' }>['usage'] {
  return { promptTokens: 0, completionTokens: 0, estimatedCostUSD: 0 };
}

function resultFromStoredRun(runId: string, run: Partial<Pick<AgentRun, 'status' | 'result' | 'errorCode' | 'errorMessage' | 'usage'>>): RunResult | undefined {
  if (run.status === 'succeeded') {
    return { status: 'success', runId, output: run.result ?? null, stepsUsed: 0, usage: run.usage ?? emptyUsage() };
  }
  if (run.status === 'failed' || run.status === 'cancelled') {
    return {
      status: 'failure',
      runId,
      error: run.errorMessage ?? (run.status === 'cancelled' ? 'Run was cancelled.' : 'Stage failed.'),
      code: (run.errorCode ?? (run.status === 'cancelled' ? 'INTERRUPTED' : 'MODEL_ERROR')) as Extract<RunResult, { status: 'failure' }>['code'],
      stepsUsed: 0,
      usage: run.usage ?? emptyUsage(),
    };
  }
  return undefined;
}

/** Process-local session projection store used when the host supplies none. */
export class InMemoryOrchestrationSessionStore implements OrchestrationSessionStore {
  private readonly sessions = new Map<string, OrchestrationSessionRecord>();
  async create(session: OrchestrationSessionRecord): Promise<OrchestrationSessionRecord> { this.sessions.set(session.id, session); return session; }
  async get(sessionId: string): Promise<OrchestrationSessionRecord | undefined> { return this.sessions.get(sessionId); }
  async update(session: OrchestrationSessionRecord): Promise<OrchestrationSessionRecord> { this.sessions.set(session.id, session); return session; }
}

/** Process-local session run-link store used when the host supplies none. */
export class InMemoryOrchestrationSessionRunLinkStore implements OrchestrationSessionRunLinkStore {
  private readonly links: OrchestrationSessionRunLinkRecord[] = [];
  async append(link: OrchestrationSessionRunLinkRecord): Promise<OrchestrationSessionRunLinkRecord> { this.links.push(link); return link; }
  async update(link: OrchestrationSessionRunLinkRecord): Promise<OrchestrationSessionRunLinkRecord> {
    const byRun = this.links.findIndex((entry) => entry.runId === link.runId);
    const index = byRun >= 0 ? byRun : this.links.findIndex((entry) => entry.sessionId === link.sessionId && entry.nodeId === link.nodeId);
    if (index >= 0) this.links[index] = link;
    return link;
  }
  async listBySession(sessionId: string): Promise<OrchestrationSessionRunLinkRecord[]> { return this.links.filter((link) => link.sessionId === sessionId); }
  async getByRunId(runId: string): Promise<OrchestrationSessionRunLinkRecord | undefined> { return this.links.find((link) => link.runId === runId); }
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function randomRunId(): string {
  return randomUUID();
}
