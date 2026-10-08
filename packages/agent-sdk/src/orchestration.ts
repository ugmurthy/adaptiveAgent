import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import {
  InMemoryOrchestrationStore,
  OrchestrationOptimisticConcurrencyError,
  type AgentRun,
  type JsonObject,
  type JsonValue,
  type OrchestrationExecution,
  type OrchestrationStage,
  type OrchestrationStore,
  type RecoverRunOptions,
  type RecoverRunResult,
  type RunRecoveryPlan,
  type RunResult,
} from '@adaptive-agent/core';

import { AgentSdk, type AgentConfigFile, type AgentSdkOptions, type AgentSdkRunOptions, type SupportedModality } from './index.js';
import { resolveAgentSdkConfigWithSources } from './config-resolve.js';
import { validateAgent } from './config-validate.js';
import {
  buildDeterministicExecutionRoutingDecision,
  supportedModalities,
  validateExecutionRoutingDecision,
  type ExecutionRoutingDecision,
} from './execution-routing.js';
import { adaptiveAgentHome, expandStrings, readJson, resolveAgentConfigByName, resolveAgentDirs, resolvePath, pathExists } from './sdk-utils.js';
import type { AgentSettingsFile } from './config-types.js';
import { discoverCatalogAgentInventory } from './tool-registry.js';

export type OrchestrationSessionStatus = 'routing' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled';
export type OrchestrationStageKind = 'single' | 'modality_specialist' | 'parallel_specialist' | 'subject_specialist' | 'final_synthesis';
export type OrchestrationExecutionShape = 'single' | 'sequential' | 'parallel_fanout_then_synthesis';
export type OrchestrationPlanNodeStatus = 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled' | 'skipped';

export interface InputClaim {
  id: string;
  modality: SupportedModality;
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
  detectedModalities: SupportedModality[];
  detectedSubjects: string[];
  inputClaims: InputClaim[];
  executionShape: OrchestrationExecutionShape;
  nodes: OrchestrationPlanNode[];
  finalNodeId: string;
  routingReason: string;
  routingDecision: ExecutionRoutingDecision;
  routingDiagnostics: OrchestrationRoutingDiagnostics;
}

export interface OrchestrationSessionRecord {
  id: string;
  requestedAgentId: string;
  status: OrchestrationSessionStatus;
  executionShape: OrchestrationExecutionShape;
  detectedModalities: SupportedModality[];
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

export interface AgentCatalogEntry {
  agentId: string;
  configPath?: string;
  agentConfig: AgentConfigFile;
}

export interface OrchestrationSessionInspection {
  session: OrchestrationSessionRecord | undefined;
  links: OrchestrationSessionRunLinkRecord[];
  plan?: OrchestrationPlan;
}

export interface OrchestrationConcurrencyPolicy {
  maxConcurrentRunsPerSession?: number;
  failurePolicy?: 'fail_fast' | 'wait_for_all';
}

export interface OrchestratedRunOptions extends AgentSdkRunOptions {
  executionId?: string;
  requestedAgentId?: string;
  sessionId?: string;
  catalogFingerprint?: string;
  routingDecision?: ExecutionRoutingDecision;
  finalizeWithRequestedAgent?: boolean;
  orchestrationMetadata?: JsonObject;
}

export interface OrchestratedExecutionOptions extends Omit<OrchestratedRunOptions, 'executionId' | 'sessionId' | 'requestedAgentId' | 'catalogFingerprint'> {
  executionId: string;
  requestedAgentId: string;
  catalogFingerprint?: string;
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
  detectedModalities: SupportedModality[];
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
      detectedModalities: SupportedModality[];
      detectedSubjects: string[];
      routingReason: string;
      routingDecision: ExecutionRoutingDecision;
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
      detectedModalities: SupportedModality[];
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

export interface OrchestrationSdkOptions extends AgentSdkOptions {
  requestedAgentConfig?: AgentConfigFile;
  requestedAgentConfigPath?: string;
  agentCatalog?: AgentCatalogEntry[];
  agentCatalogPaths?: string[];
  includeDiscoveredAgents?: boolean;
  sessionStore?: OrchestrationSessionStore;
  sessionRunLinkStore?: OrchestrationSessionRunLinkStore;
  orchestrationStore?: OrchestrationStore;
  catalogFingerprint?: string;
  sessionIdFactory?: () => string;
  now?: () => Date;
  concurrency?: OrchestrationConcurrencyPolicy;
  agentRunnerFactory?: (agentId: string, agentConfig: AgentConfigFile, options: AgentSdkOptions) => Promise<OrchestrationAgentRunner>;
  orchestrationListener?: (event: OrchestrationLifecycleEvent) => void;
  /**
   * While an execution is `routing`/`running`, stage activity newer than this is treated as owned by a
   * live scheduler and `recoverExecution` reports `busy`. Defaults to 60 seconds.
   */
  recoveryStaleAfterMs?: number;
}

export interface OrchestrationAgentRunner {
  runRaw(goal: string, options?: AgentSdkRunOptions): Promise<RunResult>;
  resumeRaw?(runId: string): Promise<RunResult>;
  /** Run-level recovery plan; must not call a model. Required for `recoverExecution` to recover a stage. */
  getRecoveryPlan?(runId: string): Promise<RunRecoveryPlan>;
  /** Executes one run-level recovery (resume, retry, or continuation). Required for `recoverExecution` to recover a stage. */
  recoverRaw?(options: RecoverRunOptions): Promise<RecoverRunResult>;
  interrupt?(runId: string): Promise<void>;
  inspect(runId: string): Promise<{ run: (Pick<AgentRun, 'rootRunId'> & Partial<Pick<AgentRun, 'id' | 'status' | 'result' | 'errorCode' | 'errorMessage' | 'usage' | 'leaseOwner' | 'leaseExpiresAt'>>) | null }>;
  close?(): Promise<void>;
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

export class OrchestrationSdk {
  private readonly catalog = new Map<string, AgentCatalogEntry>();
  private readonly runners = new Map<string, OrchestrationAgentRunner>();
  private readonly sessionStore: OrchestrationSessionStore;
  private readonly linkStore: OrchestrationSessionRunLinkStore;
  private readonly plans = new Map<string, OrchestrationPlan>();
  private readonly sessionIdFactory: () => string;
  private readonly now: () => Date;
  private readonly concurrency: Required<OrchestrationConcurrencyPolicy>;
  private readonly defaultRequestedAgentId: string;
  private orchestrationStore: OrchestrationStore;
  private readonly catalogFingerprint: string;
  private readonly recoveringExecutions = new Set<string>();

  private constructor(private readonly options: OrchestrationSdkOptions, entries: AgentCatalogEntry[]) {
    for (const entry of entries) {
      if (this.catalog.has(entry.agentId)) throw new Error(`Duplicate agent catalog entry "${entry.agentId}"`);
      this.catalog.set(entry.agentId, entry);
    }
    this.defaultRequestedAgentId = options.requestedAgentConfig?.id ?? options.agentConfig?.id ?? entries[0]?.agentId;
    if (!this.defaultRequestedAgentId) throw new Error('Orchestration SDK requires a requested agent config or non-empty agent catalog.');
    this.sessionStore = options.sessionStore ?? new InMemoryOrchestrationSessionStore();
    this.linkStore = options.sessionRunLinkStore ?? new InMemoryOrchestrationSessionRunLinkStore();
    this.sessionIdFactory = options.sessionIdFactory ?? randomSessionId;
    this.now = options.now ?? (() => new Date());
    this.concurrency = {
      maxConcurrentRunsPerSession: options.concurrency?.maxConcurrentRunsPerSession ?? 2,
      failurePolicy: options.concurrency?.failurePolicy ?? 'fail_fast',
    };
    this.orchestrationStore = options.orchestrationStore ?? new InMemoryOrchestrationStore();
    this.catalogFingerprint = options.catalogFingerprint ?? fingerprintCatalog(entries);
  }

  static async create(options: OrchestrationSdkOptions = {}): Promise<OrchestrationSdk> {
    return new OrchestrationSdk(options, await buildCatalog(options));
  }

  async run(goal: string, options: OrchestratedRunOptions = {}): Promise<OrchestratedRunResult> {
    return this.execute(goal, options);
  }

  async runRaw(goal: string, options: OrchestratedRunOptions = {}): Promise<OrchestratedRunResult> {
    return this.execute(goal, options);
  }

  async inspectSession(sessionId: string): Promise<OrchestrationSessionInspection> {
    const durable = await this.inspectExecution(sessionId);
    const plan = durable.execution ? parsePlan(durable.execution.plan, durable.execution.catalogFingerprint) : this.plans.get(sessionId);
    return { session: await this.sessionStore.get(sessionId), links: await this.linkStore.listBySession(sessionId), plan };
  }

  async inspectExecution(executionId: string): Promise<{ execution: OrchestrationExecution | null; stages: OrchestrationStage[]; plan?: OrchestrationPlan }> {
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
    if (execution.catalogFingerprint !== this.catalogFingerprint) throw new Error(`CATALOG_CHANGED: orchestration execution ${executionId} was created with a different catalog fingerprint.`);
    if (execution.status === 'cancelled') throw new Error(`Orchestration execution ${executionId} is cancelled.`);
    return this.continueExecution(execution, parseRequest(execution.request), parsePlan(execution.plan, execution.catalogFingerprint));
  }

  /**
   * Recovers an unfinished orchestration execution from its saved plan without redecomposing.
   *
   * Successful independent stages are preserved. Each failed, paused, or stale stage is recovered at most
   * once through its own agent runner (`getRecoveryPlan` + `recoverRaw`); continuation run IDs are persisted
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
      await this.adoptRequestedRuntimeStore();
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

  async close(): Promise<void> {
    await Promise.all([...this.runners.values()].map((runner) => runner.close?.()));
    this.runners.clear();
  }

  private async adoptRequestedRuntimeStore(): Promise<void> {
    if (this.options.orchestrationStore || this.options.agentRunnerFactory) return;
    const requestedRunner = await this.getRunner(this.defaultRequestedAgentId);
    if (requestedRunner instanceof AgentSdk) this.orchestrationStore = requestedRunner.created.runtime.orchestrationStore;
  }

  private async recoverExecutionWithGuard(execution: OrchestrationExecution, plan: OrchestrationPlan, options: OrchestrationRecoveryOptions): Promise<OrchestrationRecoveryResult> {
    const executionId = execution.id;
    const report = (outcome: OrchestrationRecoveryOutcome, fields: Partial<Omit<OrchestrationRecoveryResult, 'executionId' | 'sessionId' | 'outcome'>> = {}): OrchestrationRecoveryResult =>
      ({ executionId, sessionId: plan.sessionId, outcome, plans: [], actions: [], ...fields });

    if (execution.status === 'cancelled') return report('blocked', { reason: `Orchestration execution ${executionId} is cancelled.` });
    if (execution.catalogFingerprint !== this.catalogFingerprint) {
      return report('blocked', { reason: `CATALOG_CHANGED: orchestration execution ${executionId} was created with a different catalog fingerprint.` });
    }
    const missingAgent = plan.nodes.find((node) => !this.catalog.has(node.agentId));
    if (missingAgent) return report('blocked', { reason: `CATALOG_CHANGED: agent "${missingAgent.agentId}" for stage ${missingAgent.id} is not in the catalog.` });
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
          await this.patchStageRun(item.stage, { status: 'queued', upstreamRunIds: [], ...(item.freshRunId ? { runId: randomSessionId() } : {}) }, item.stage.version);
        }
      }

      const latest = (await this.orchestrationStore.getExecution(executionId))!;
      const result = await this.continueExecution(latest, parseRequest(latest.request), plan, runningSession);
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

  private async execute(goal: string, options: OrchestratedRunOptions): Promise<OrchestratedRunResult> {
    if (options.contextRefs && options.contextRefs.length > 0) {
      throw new Error('Context refs are not supported for orchestration until stage propagation semantics are defined.');
    }
    const executionId = options.executionId ?? options.sessionId ?? this.sessionIdFactory();
    const sessionId = options.sessionId ?? executionId;
    const requestedAgentId = options.requestedAgentId ?? this.defaultRequestedAgentId;
    if (!this.options.orchestrationStore && !this.options.agentRunnerFactory) {
      const requestedRunner = await this.getRunner(requestedAgentId);
      if (requestedRunner instanceof AgentSdk) this.orchestrationStore = requestedRunner.created.runtime.orchestrationStore;
    }
    const fingerprint = options.catalogFingerprint ?? this.catalogFingerprint;
    const plan = buildOrchestrationPlan({ sessionId, requestedAgentId, goal, options, catalog: this.catalog, catalogFingerprint: fingerprint, routingDecision: options.routingDecision, finalizeWithRequestedAgent: options.finalizeWithRequestedAgent ?? true });
    if (executionId !== sessionId) plan.executionId = executionId;
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

    const request = jsonSafe({ goal, options: stripOrchestrationOptions(options) });
    const durable = await this.orchestrationStore.createExecution({
      id: executionId,
      request,
      catalogFingerprint: fingerprint,
      plan: jsonSafe(plan),
      stages: plan.nodes.map((node) => ({ runId: randomSessionId(), nodeId: node.id, agentId: node.agentId, status: 'queued', dependencies: node.dependsOn, upstreamRunIds: [] })),
    });
    const createdAt = this.now().toISOString();
    let session = await this.sessionStore.create({ id: sessionId, requestedAgentId, status: 'routing', executionShape: plan.executionShape, detectedModalities: plan.detectedModalities, detectedSubjects: plan.detectedSubjects, routingReason: plan.routingReason, metadata: options.orchestrationMetadata, createdAt, updatedAt: createdAt });
    this.emitLifecycle({ type: 'orchestration.session.created', sessionId, requestedAgentId, status: session.status, executionShape: plan.executionShape, detectedModalities: plan.detectedModalities, detectedSubjects: plan.detectedSubjects, routingReason: plan.routingReason, createdAt: this.now().toISOString() });
    session = await this.sessionStore.update({ ...session, status: 'running', updatedAt: this.now().toISOString() });
    this.emitLifecycle({ type: 'orchestration.session.running', sessionId, requestedAgentId, status: session.status, executionShape: plan.executionShape, detectedModalities: plan.detectedModalities, detectedSubjects: plan.detectedSubjects, routingReason: plan.routingReason, createdAt: this.now().toISOString() });

    return this.continueExecution(durable, { goal, options }, plan, session);
  }

  private async continueExecution(durable: OrchestrationExecution, request: StoredRequest, plan: OrchestrationPlan, legacySession?: OrchestrationSessionRecord): Promise<OrchestratedRunResult> {
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

  private async executeNode(goal: string, options: OrchestratedRunOptions, plan: OrchestrationPlan, node: OrchestrationPlanNode, stage: OrchestrationStage, priorResults: Map<string, OrchestratedRunStageResult>): Promise<OrchestratedRunStageResult> {
    this.emitLifecycle({ type: 'orchestration.stage.starting', sessionId: plan.sessionId, requestedAgentId: plan.requestedAgentId, nodeId: node.id, agentId: node.agentId, stage: node.stage, dependsOn: node.dependsOn, createdAt: this.now().toISOString() });
    const runner = await this.getRunner(node.agentId);
    const startedAt = this.now().toISOString();
    const runGoal = buildNodeGoal(goal, node);
    const runOptions = buildNodeOptions(options, plan, node, priorResults, supportedModalities(this.catalog.get(node.agentId)!.agentConfig));
    const result = await runner.runRaw(runGoal, { ...runOptions, runId: stage.runId, sessionId: plan.sessionId });
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
      const request = parseRequest((await this.orchestrationStore.getExecution(stage.executionId))!.request);
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
    this.options.orchestrationListener?.(event);
  }

  private async getRunner(agentId: string): Promise<OrchestrationAgentRunner> {
    const cached = this.runners.get(agentId);
    if (cached) return cached;
    const entry = this.catalog.get(agentId);
    if (!entry) throw new Error(`Unknown orchestration agent "${agentId}"`);
    const runner = this.options.agentRunnerFactory
      ? await this.options.agentRunnerFactory(agentId, entry.agentConfig, this.options)
      : await AgentSdk.create({ ...this.options, agentConfig: entry.agentConfig, agentConfigPath: entry.configPath, runtime: [...this.runners.values()][0] instanceof AgentSdk ? ([...this.runners.values()][0] as AgentSdk).created.runtime : this.options.runtime });
    this.runners.set(agentId, runner);
    return runner;
  }
}

export async function createOrchestrationSdk(options: OrchestrationSdkOptions = {}): Promise<OrchestrationSdk> {
  return OrchestrationSdk.create(options);
}

export function detectInputClaims(goal: string, options: AgentSdkRunOptions): InputClaim[] {
  const claims: InputClaim[] = [{ id: 'goal', modality: 'text', source: 'goal', index: 0 }];
  options.images?.forEach((image, index) => claims.push({ id: `images.${index}`, modality: 'image', source: 'images', index, name: image.name }));
  options.contentParts?.forEach((part, index) => {
    if (part.type === 'text' && part.text.trim()) claims.push({ id: `contentParts.${index}`, modality: 'text', source: 'contentParts', index });
    if (part.type === 'image') claims.push({ id: `contentParts.${index}`, modality: 'image', source: 'contentParts', index, name: part.image.name });
    if (part.type === 'file') claims.push({ id: `contentParts.${index}`, modality: 'file', source: 'contentParts', index, mimeType: part.file.mimeType, name: part.file.name });
    if (part.type === 'audio') claims.push({ id: `contentParts.${index}`, modality: 'audio', source: 'contentParts', index, mimeType: part.audio.mimeType, name: part.audio.name });
  });
  if (options.input && typeof options.input === 'object' && !Array.isArray(options.input)) {
    for (const modality of ['image', 'file', 'audio'] as const) {
      if (modality in options.input) claims.push({ id: `input.${modality}`, modality, source: 'input' });
    }
  }
  return claims;
}

export function buildOrchestrationPlan(params: { sessionId: string; requestedAgentId: string; goal: string; options: AgentSdkRunOptions; catalog: Map<string, AgentCatalogEntry>; catalogFingerprint?: string; routingDecision?: ExecutionRoutingDecision; finalizeWithRequestedAgent: boolean }): OrchestrationPlan {
  const requested = params.catalog.get(params.requestedAgentId);
  if (!requested) throw new Error(`Unknown requested agent "${params.requestedAgentId}"`);
  const inputClaims = detectInputClaims(params.goal, params.options);
  const detectedModalities = unique(inputClaims.map((claim) => claim.modality));
  if (params.routingDecision?.mode === 'direct') throw new Error('Direct execution routing cannot be launched as an orchestration plan.');
  if (params.routingDecision && params.routingDecision.primaryAgentId !== params.requestedAgentId) {
    throw new Error(`Execution routing primary agent "${params.routingDecision.primaryAgentId}" does not match requested agent "${params.requestedAgentId}".`);
  }
  const baseDecision = params.routingDecision ?? buildDeterministicExecutionRoutingDecision({
      requestedAgentId: params.requestedAgentId,
      detectedModalities,
      catalog: params.catalog,
      forceOrchestration: true,
      synthesize: params.finalizeWithRequestedAgent,
    });
  validateExecutionRoutingDecision(baseDecision, detectedModalities, params.catalog);
  const subjectRouting: { selected?: { entry: AgentCatalogEntry; matchedSubjects: string[] }; candidates: SubjectRoutingCandidateDiagnostic[] } = params.routingDecision
    ? { candidates: [] as SubjectRoutingCandidateDiagnostic[] }
    : chooseSubjectSpecialist(params.catalog, params.goal, params.requestedAgentId);
  const subjectSpecialist = subjectRouting.selected;
  const detectedSubjects = subjectSpecialist?.matchedSubjects ?? [];
  const routingDiagnostics = { subjectCandidates: subjectRouting.candidates };
  const modalityAssignments = baseDecision.assignments.filter((assignment) => assignment.agentId !== params.requestedAgentId);
  const hasSpecialists = modalityAssignments.length > 0 || Boolean(subjectSpecialist);
  const routingReason = params.routingDecision
    ? params.routingDecision.reason
    : hasSpecialists
    ? buildRoutingReason(params.requestedAgentId, modalityAssignments.flatMap((assignment) => assignment.modalities), detectedSubjects, params.finalizeWithRequestedAgent)
    : baseDecision.reason;
  const routingDecision: ExecutionRoutingDecision = {
    ...baseDecision,
    ...(params.finalizeWithRequestedAgent && hasSpecialists && !baseDecision.synthesisAgentId ? { synthesisAgentId: params.requestedAgentId } : {}),
    selectedCatalogAgentIds: unique([
      ...baseDecision.selectedCatalogAgentIds,
      ...(subjectSpecialist ? [subjectSpecialist.entry.agentId] : []),
    ]),
    reason: routingReason,
  };
  validateExecutionRoutingDecision(routingDecision, detectedModalities, params.catalog);
  const catalogFingerprint = params.catalogFingerprint ?? fingerprintCatalog([...params.catalog.values()]);
  if (!hasSpecialists) {
    return { sessionId: params.sessionId, requestedAgentId: params.requestedAgentId, catalogFingerprint, detectedModalities, detectedSubjects, inputClaims, executionShape: 'single', nodes: [{ id: 'requested', agentId: params.requestedAgentId, stage: 'single', dependsOn: [], inputSelector: { includeGoal: true, includeOriginalInput: true } }], finalNodeId: 'requested', routingReason, routingDecision, routingDiagnostics };
  }

  const specialistNodes: OrchestrationPlanNode[] = modalityAssignments.map((assignment) => {
    const slug = assignment.modalities.join('_');
    return {
      id: `${slug}_specialist`,
      agentId: assignment.agentId,
      stage: modalityAssignments.length === 1 ? 'modality_specialist' as const : 'parallel_specialist' as const,
      dependsOn: [],
      inputSelector: { includeGoal: true, claimIds: inputClaims.filter((claim) => assignment.modalities.includes(claim.modality)).map((claim) => claim.id) },
      outputRole: `${slug}_analysis`,
      metadata: { assignedModalities: assignment.modalities },
    };
  });
  if (subjectSpecialist) {
    const existing = specialistNodes.find((node) => node.agentId === subjectSpecialist.entry.agentId);
    if (existing) {
      existing.metadata = { ...(existing.metadata ?? {}), matchedSubjects: subjectSpecialist.matchedSubjects };
    } else {
      specialistNodes.push({ id: `subject_${slugify(subjectSpecialist.matchedSubjects[0] ?? subjectSpecialist.entry.agentId)}_specialist`, agentId: subjectSpecialist.entry.agentId, stage: 'subject_specialist', dependsOn: [], inputSelector: { includeGoal: true }, outputRole: `${subjectSpecialist.matchedSubjects.join('_') || 'subject'}_analysis`, metadata: { matchedSubjects: subjectSpecialist.matchedSubjects } });
    }
  }
  if (!params.finalizeWithRequestedAgent) {
    const first = specialistNodes[0]!;
    return { sessionId: params.sessionId, requestedAgentId: params.requestedAgentId, catalogFingerprint, detectedModalities, detectedSubjects, inputClaims, executionShape: specialistNodes.length === 1 ? 'single' : 'parallel_fanout_then_synthesis', nodes: specialistNodes, finalNodeId: first.id, routingReason, routingDecision, routingDiagnostics };
  }
  const finalNode = { id: 'final_synthesis', agentId: routingDecision.synthesisAgentId ?? params.requestedAgentId, stage: 'final_synthesis' as const, dependsOn: specialistNodes.map((node) => node.id), inputSelector: { includeGoal: true, includeOriginalInput: true, includePriorOutputs: specialistNodes.map((node) => node.id) } };
  return { sessionId: params.sessionId, requestedAgentId: params.requestedAgentId, catalogFingerprint, detectedModalities, detectedSubjects, inputClaims, executionShape: specialistNodes.length === 1 ? 'sequential' : 'parallel_fanout_then_synthesis', nodes: [...specialistNodes, finalNode], finalNodeId: finalNode.id, routingReason, routingDecision, routingDiagnostics };
}

function buildNodeOptions(options: OrchestratedRunOptions, plan: OrchestrationPlan, node: OrchestrationPlanNode, priorResults: Map<string, OrchestratedRunStageResult>, requestedModalities: SupportedModality[]): AgentSdkRunOptions {
  const priorOutputs = Object.fromEntries((node.inputSelector?.includePriorOutputs ?? node.dependsOn).map((id) => {
    const result = priorResults.get(id)?.result;
    return [id, resultToJson(result)];
  }));
  const orchestration = { kind: 'catalog', executionId: plan.executionId ?? plan.sessionId, sessionId: plan.sessionId, requestedAgentId: plan.requestedAgentId, selectedAgentId: node.agentId, selectedCatalogAgentIds: plan.routingDecision.selectedCatalogAgentIds, modalityAssignments: plan.routingDecision.assignments as unknown as JsonValue, routingSource: plan.routingDecision.source, catalogFingerprint: plan.catalogFingerprint, executionShape: plan.executionShape, stage: node.stage, nodeId: node.id, dependsOn: node.dependsOn, detectedModalities: plan.detectedModalities, routingReason: plan.routingReason } satisfies JsonObject;
  if (node.stage === 'final_synthesis') {
    const raw = selectSynthesisAttachments(options, requestedModalities);
    return { ...raw, input: { originalInput: filterInputModalities(options.input, new Set(requestedModalities)) ?? null, upstreamResults: priorOutputs }, context: { ...(options.context ?? {}), sessionId: plan.sessionId, orchestration }, executionContext: options.executionContext, inferenceTier: options.inferenceTier, outputSchema: options.outputSchema, metadata: { ...(options.metadata ?? {}), orchestration } };
  }
  return { ...selectNodeInputs(options, plan, node), context: { ...(options.context ?? {}), sessionId: plan.sessionId, orchestration }, executionContext: options.executionContext, inferenceTier: options.inferenceTier, outputSchema: options.outputSchema, metadata: { ...(options.metadata ?? {}), orchestration } };
}

function selectNodeInputs(options: OrchestratedRunOptions, plan: OrchestrationPlan, node: OrchestrationPlanNode): AgentSdkRunOptions {
  if (node.inputSelector?.includeOriginalInput) return options;
  const claimIds = new Set(node.inputSelector?.claimIds ?? []);
  const selectedClaims = plan.inputClaims.filter((claim) => claimIds.has(claim.id));
  return {
    ...selectStructuredInput(options, selectedClaims),
    ...selectImages(options, selectedClaims),
    ...selectContentParts(options, selectedClaims),
  };
}

function selectStructuredInput(options: OrchestratedRunOptions, claims: InputClaim[]): Pick<AgentSdkRunOptions, 'input'> {
  if (!options.input || typeof options.input !== 'object' || Array.isArray(options.input)) return {};
  const selectedModalities = new Set(claims
    .filter((claim) => claim.source === 'input')
    .map((claim) => claim.modality));
  if (selectedModalities.size === 0) return {};
  return { input: filterInputModalities(options.input, selectedModalities) };
}

function filterInputModalities(input: JsonValue | undefined, supported: Set<SupportedModality>): JsonValue | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const modalityKeys = new Set<SupportedModality>(['image', 'file', 'audio']);
  return Object.fromEntries(Object.entries(input).filter(([key]) =>
    !modalityKeys.has(key as SupportedModality) || supported.has(key as SupportedModality)
  ));
}

function selectImages(options: OrchestratedRunOptions, claims: InputClaim[]): Pick<AgentSdkRunOptions, 'images'> {
  const images = claims
    .filter((claim) => claim.source === 'images' && claim.index !== undefined)
    .map((claim) => options.images?.[claim.index!])
    .filter((image): image is NonNullable<AgentSdkRunOptions['images']>[number] => Boolean(image));
  return images.length > 0 ? { images } : {};
}

function selectContentParts(options: OrchestratedRunOptions, claims: InputClaim[]): Pick<AgentSdkRunOptions, 'contentParts'> {
  const contentParts = claims
    .filter((claim) => claim.source === 'contentParts' && claim.index !== undefined)
    .map((claim) => options.contentParts?.[claim.index!])
    .filter((part): part is NonNullable<AgentSdkRunOptions['contentParts']>[number] => Boolean(part));
  return contentParts.length > 0 ? { contentParts } : {};
}

function selectSynthesisAttachments(options: OrchestratedRunOptions, supported: SupportedModality[]): Pick<AgentSdkRunOptions, 'images' | 'contentParts'> {
  const images = supported.includes('image') ? options.images : undefined;
  const contentParts = options.contentParts?.filter((part) => (part.type === 'file' && supported.includes('file')) || (part.type === 'image' && supported.includes('image')) || (part.type === 'audio' && supported.includes('audio')) || part.type === 'text');
  return { ...(images?.length ? { images } : {}), ...(contentParts?.length ? { contentParts } : {}) };
}

function resultToJson(result: RunResult | undefined): JsonValue {
  if (!result) return null;
  if (result.status === 'success') return result.output;
  if (result.status === 'failure') return { status: result.status, runId: result.runId, error: result.error, code: result.code };
  return { status: result.status, runId: result.runId, message: result.message };
}

function buildNodeGoal(originalGoal: string, node: OrchestrationPlanNode): string {
  if (node.stage === 'final_synthesis') return buildSynthesisGoal(originalGoal);
  if (node.stage !== 'modality_specialist' && node.stage !== 'parallel_specialist') return originalGoal;
  const assignedModalities = node.metadata?.assignedModalities;
  if (!Array.isArray(assignedModalities) || assignedModalities.length === 0 || assignedModalities.some((modality) => typeof modality !== 'string')) return originalGoal;
  return [
    'Complete only the part of the original user request assigned to this specialist node.',
    `Assigned modalities: ${assignedModalities.join(', ')}.`,
    'Use the supplied inputs for those modalities now. Do not request inputs for other modalities; other specialists handle them.',
    'Return your findings for use in the final response.',
    '',
    `Original user request: ${originalGoal}`,
  ].join('\n');
}

function buildSynthesisGoal(originalGoal: string): string {
  return ['Complete the original user request using the specialist result(s) already produced.', 'Do not assume access to raw attachments unless they are included explicitly.', '', `Original user request: ${originalGoal}`].join('\n');
}

function chooseSubjectSpecialist(catalog: Map<string, AgentCatalogEntry>, goal: string, requestedAgentId: string): { selected?: { entry: AgentCatalogEntry; matchedSubjects: string[] }; candidates: SubjectRoutingCandidateDiagnostic[] } {
  const scored = [...catalog.values()].map((entry) => ({ entry, ...subjectScore(entry, goal) }));
  const requestedScore = scored.find((candidate) => candidate.entry.agentId === requestedAgentId)?.score ?? 0;
  const selected = scored
    .filter((candidate) => candidate.entry.agentId !== requestedAgentId)
    .filter((candidate) => candidate.score > 0 && candidate.score > requestedScore)
    .sort((left, right) => right.score - left.score || left.entry.agentId.localeCompare(right.entry.agentId))[0];
  return {
    selected: selected ? { entry: selected.entry, matchedSubjects: selected.matchedSubjects } : undefined,
    candidates: scored.map((candidate) => ({
      agentId: candidate.entry.agentId,
      score: candidate.score,
      matchedSubjects: candidate.matchedSubjects,
      matchedKeywords: candidate.matchedKeywords,
      selected: candidate.entry.agentId === selected?.entry.agentId,
      requestedAgent: candidate.entry.agentId === requestedAgentId,
    })),
  };
}

function subjectScore(entry: AgentCatalogEntry, goal: string): { score: number; matchedSubjects: string[]; matchedKeywords: string[] } {
  const preferredSubjects = entry.agentConfig.capabilities?.subjectsPreferred ?? [];
  const keywords = routingKeywords(entry.agentConfig.routing);
  const matchedSubjects = unique(preferredSubjects.filter((subject) => containsPhrase(goal, subject)));
  const matchedKeywords = unique(keywords.filter((keyword) => containsPhrase(goal, keyword)));
  return { score: matchedSubjects.length * 4 + matchedKeywords.length * 2, matchedSubjects: matchedSubjects.length > 0 ? matchedSubjects : matchedKeywords, matchedKeywords };
}

function routingKeywords(routing: JsonObject | undefined): string[] {
  const keywords = routing?.keywords;
  return Array.isArray(keywords) ? keywords.filter((keyword): keyword is string => typeof keyword === 'string' && keyword.trim().length > 0) : [];
}

function containsPhrase(text: string, phrase: string): boolean {
  return normalizeSearchText(text).includes(normalizeSearchText(phrase));
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function slugify(value: string): string {
  return normalizeSearchText(value).replace(/\s+/g, '_') || 'subject';
}

function buildRoutingReason(requestedAgentId: string, modalities: SupportedModality[], subjects: string[], synthesize: boolean): string {
  const parts = [
    modalities.length > 0 ? `modalities (${modalities.join(', ')})` : undefined,
    subjects.length > 0 ? `subjects (${subjects.join(', ')})` : undefined,
  ].filter((part): part is string => Boolean(part));
  return synthesize
    ? `Routed ${parts.join(' and ')} to specialist agent(s), then synthesized with requested agent "${requestedAgentId}".`
    : `Routed ${parts.join(' and ')} to specialist agent(s) without requested-agent synthesis.`;
}

async function buildCatalog(options: OrchestrationSdkOptions): Promise<AgentCatalogEntry[]> {
  const entries = new Map<string, AgentCatalogEntry>();
  const cwd = options.cwd ?? process.cwd();
  const env = { ...(options.env ?? process.env), ...(options.settingsConfig?.env ?? {}) };
  const agentDirs = await resolveCatalogAgentDirs(options, cwd, env);
  if (options.includeDiscoveredAgents) {
    const resolved = await resolveAgentSdkConfigWithSources(options);
    const inventory = await discoverCatalogAgentInventory(resolved.config, resolved.agentPath, options);
    for (const candidate of inventory.agents) {
      if (candidate.archived || candidate.validationState !== 'valid' || !candidate.invocationModes.includes('run')) continue;
      const agentConfig = validateAgent(expandStrings(await readJson(candidate.configPath), env), candidate.configPath);
      entries.set(candidate.id, { agentId: candidate.id, configPath: candidate.configPath, agentConfig });
    }
  }
  for (const entry of options.agentCatalog ?? []) entries.set(entry.agentId, entry);
  for (const pathOrName of options.agentCatalogPaths ?? []) {
    const configPath = await resolveAgentConfigByName(pathOrName, agentDirs) ?? resolvePath(cwd, pathOrName);
    const agentConfig = validateAgent(expandStrings(await readJson(configPath), env), configPath);
    entries.set(agentConfig.id, { agentId: agentConfig.id, configPath, agentConfig });
  }
  const requestedConfig = options.requestedAgentConfig ?? options.agentConfig;
  if (requestedConfig) entries.set(requestedConfig.id, { agentId: requestedConfig.id, configPath: options.requestedAgentConfigPath ?? options.agentConfigPath, agentConfig: requestedConfig });
  return [...entries.values()];
}

async function resolveCatalogAgentDirs(options: OrchestrationSdkOptions, cwd: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  let settings = options.settingsConfig;
  if (!settings) {
    const settingsPath = await findSettingsPath(options, cwd, env);
    settings = settingsPath ? await readJson(settingsPath) as AgentSettingsFile : undefined;
  }
  if (settings?.env) Object.assign(env, settings.env);
  return resolveAgentDirs(cwd, options.settingsOverrides?.agents?.dirs ?? settings?.agents?.dirs, env);
}

async function findSettingsPath(options: OrchestrationSdkOptions, cwd: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const candidates = [
    options.settingsConfigPath,
    env.ADAPTIVE_AGENT_SETTINGS,
    resolve(cwd, 'agent.settings.json'),
    resolve(adaptiveAgentHome(env), 'agent.settings.json'),
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    const path = resolvePath(cwd, candidate);
    if (await pathExists(path)) return path;
  }
  return undefined;
}

interface StoredRequest { goal: string; options: OrchestratedRunOptions }

function parsePlan(value: JsonValue, catalogFingerprint?: string): OrchestrationPlan {
  const plan = value as unknown as OrchestrationPlan;
  if (plan.routingDecision && plan.catalogFingerprint) return plan;
  const assignments = new Map<string, SupportedModality[]>();
  for (const modality of plan.detectedModalities) {
    const specialist = plan.nodes.find((node) => node.inputSelector?.claimIds?.some((claimId) =>
      plan.inputClaims.find((claim) => claim.id === claimId)?.modality === modality
    ));
    const agentId = specialist?.agentId ?? plan.requestedAgentId;
    assignments.set(agentId, [...(assignments.get(agentId) ?? []), modality]);
  }
  const synthesisAgentId = plan.nodes.find((node) => node.stage === 'final_synthesis')?.agentId;
  const routingDecision: ExecutionRoutingDecision = {
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

function parseRequest(value: JsonValue): StoredRequest {
  return value as unknown as StoredRequest;
}

function jsonSafe(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function stripOrchestrationOptions(options: OrchestratedRunOptions): OrchestratedRunOptions {
  const copy = { ...options };
  delete copy.executionId;
  delete copy.sessionId;
  delete copy.requestedAgentId;
  delete copy.catalogFingerprint;
  delete copy.routingDecision;
  return copy;
}

function fingerprintCatalog(entries: AgentCatalogEntry[]): string {
  const exactCatalog = entries
    .map((entry) => ({
      agentId: entry.agentId,
      configPath: entry.configPath ?? null,
      agentConfig: {
        ...entry.agentConfig,
        model: { ...entry.agentConfig.model, apiKey: undefined },
      },
    }))
    .sort((left, right) => left.agentId.localeCompare(right.agentId));
  return createHash('sha256').update(stableJson(exactCatalog)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
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

class InMemoryOrchestrationSessionStore implements OrchestrationSessionStore {
  private readonly sessions = new Map<string, OrchestrationSessionRecord>();
  async create(session: OrchestrationSessionRecord): Promise<OrchestrationSessionRecord> { this.sessions.set(session.id, session); return session; }
  async get(sessionId: string): Promise<OrchestrationSessionRecord | undefined> { return this.sessions.get(sessionId); }
  async update(session: OrchestrationSessionRecord): Promise<OrchestrationSessionRecord> { this.sessions.set(session.id, session); return session; }
}

class InMemoryOrchestrationSessionRunLinkStore implements OrchestrationSessionRunLinkStore {
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

function randomSessionId(): string {
  return randomUUID();
}
