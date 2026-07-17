import type {
  AgentRun,
  JsonValue,
  ModelContentPart,
  RunResult,
  SwarmRetryResult,
  SwarmRunResult,
  SwarmSubtask,
} from '@adaptive-agent/core';

import {
  AgentSdk,
  createAgentSdk,
  loadAgentSdkConfig,
  type AgentSdkOptions,
  type ResolvedAgentSdkConfig,
} from './index.js';
import { createSwarmRoleAgentConfig } from './swarm-role-config.js';
import { buildSwarmCoordinator, parseSwarmSubtasks, runSwarmDecomposition, validateSdkDecomposition } from './swarm-runner.js';

export type SwarmLifecyclePhase = 'initialization' | 'decomposition' | 'execution' | 'retry';
export type SwarmLifecycleState = 'started' | 'completed' | 'waiting' | 'failed';
export interface SwarmLifecycleEvent {
  phase: SwarmLifecyclePhase;
  state: SwarmLifecycleState;
  timestamp: string;
  sessionId?: string;
  coordinatorRunId?: string;
  error?: string;
}

export interface SwarmSdkOptions extends AgentSdkOptions {
  coordinatorSdk?: AgentSdk;
  coordinatorConfig?: ResolvedAgentSdkConfig;
  coordinatorConfigPath?: string;
  workerConfigs?: ResolvedAgentSdkConfig[];
  workerConfigPaths?: string[];
  qualityConfig?: ResolvedAgentSdkConfig;
  qualityConfigPath?: string;
  synthesizerConfig?: ResolvedAgentSdkConfig;
  synthesizerConfigPath?: string;
  maxWorkers?: number;
  lifecycleListener?: (event: SwarmLifecycleEvent) => void;
  idFactory?: () => string;
}

export interface ResolvedSwarmSdkConfig {
  coordinator: ResolvedAgentSdkConfig;
  workers: ResolvedAgentSdkConfig[];
  quality: ResolvedAgentSdkConfig;
  synthesizer: ResolvedAgentSdkConfig;
  workerIds: string[];
  defaultsUsed: { qualityAgent: 'explicit' | 'coordinator_with_quality_instructions'; synthesizerAgent: 'explicit' | 'coordinator_with_synthesis_instructions' };
}

export interface SwarmRunRequest {
  topLevelObjective: string;
  sessionId?: string;
  input?: JsonValue;
  contentParts?: ModelContentPart[];
  maxWorkers?: number;
}

export type SwarmSdkRunResult = {
  sessionId: string;
  coordinatorRunId: string;
  decompositionResult: RunResult;
  workerIds: string[];
  subtasks: SwarmSubtask[];
  defaultsUsed: ResolvedSwarmSdkConfig['defaultsUsed'];
} & ({ state: 'completed'; executionResult: SwarmRunResult } | { state: 'waiting' | 'failed'; executionResult?: undefined });

export interface SwarmPreparedExecutionRequest {
  sessionId: string;
  coordinatorRunId: string;
  topLevelObjective: string;
  decompositionOutput: JsonValue;
  input?: JsonValue;
  contentParts?: ModelContentPart[];
  maxWorkers?: number;
}

export interface SwarmPreparedExecutionResult {
  subtasks: SwarmSubtask[];
  executionResult: SwarmRunResult;
}

export interface SwarmSessionInspection {
  sessionId: string;
  state: 'not_started' | 'active' | 'waiting' | 'ready' | 'failed' | 'completed';
  retryable: boolean;
  coordinatorRunId?: string;
  phase?: 'decomposition' | 'workers' | 'quality' | 'synthesis';
  runs: AgentRun[];
  result?: JsonValue;
}

export class SwarmSdk {
  readonly coordinatorSdk: AgentSdk;
  readonly config: ResolvedSwarmSdkConfig;
  private closed = false;

  private constructor(
    coordinatorSdk: AgentSdk,
    config: ResolvedSwarmSdkConfig,
    private readonly workerSdks: AgentSdk[],
    private readonly qualitySdk: AgentSdk,
    private readonly synthesizerSdk: AgentSdk,
    private readonly ownsCoordinator: boolean,
    private readonly options: SwarmSdkOptions,
  ) { this.coordinatorSdk = coordinatorSdk; this.config = config; }

  static async resolveConfig(options: SwarmSdkOptions): Promise<ResolvedSwarmSdkConfig> {
    const base = sdkOptions(options);
    const coordinator = options.coordinatorConfig ?? options.coordinatorSdk?.config ?? await loadAgentSdkConfig({ ...base, agentConfigPath: options.coordinatorConfigPath ?? options.agentConfigPath });
    const workers = options.workerConfigs ?? await Promise.all((options.workerConfigPaths ?? []).map((agentConfigPath) => loadAgentSdkConfig({ ...base, agentConfigPath })));
    if (workers.length === 0) throw new Error('Swarm SDK requires at least one worker agent');
    const workerIds = workers.map(({ agent }) => agent.id);
    const duplicate = workerIds.find((id, index) => workerIds.indexOf(id) !== index);
    if (duplicate) throw new Error(`swarm worker catalog contains duplicate agent id: ${duplicate}`);
    const quality = options.qualityConfig ?? (options.qualityConfigPath
      ? await loadAgentSdkConfig({ ...base, agentConfigPath: options.qualityConfigPath })
      : await loadAgentSdkConfig({ ...base, agentConfig: createSwarmRoleAgentConfig(coordinator.agent, 'quality') }));
    const synthesizer = options.synthesizerConfig ?? (options.synthesizerConfigPath
      ? await loadAgentSdkConfig({ ...base, agentConfigPath: options.synthesizerConfigPath })
      : await loadAgentSdkConfig({ ...base, agentConfig: createSwarmRoleAgentConfig(coordinator.agent, 'synthesizer') }));
    return { coordinator, workers, quality, synthesizer, workerIds, defaultsUsed: {
      qualityAgent: options.qualityConfig || options.qualityConfigPath ? 'explicit' : 'coordinator_with_quality_instructions',
      synthesizerAgent: options.synthesizerConfig || options.synthesizerConfigPath ? 'explicit' : 'coordinator_with_synthesis_instructions',
    } };
  }

  static async create(options: SwarmSdkOptions): Promise<SwarmSdk> {
    options.lifecycleListener?.({
      phase: 'initialization',
      state: 'started',
      timestamp: (options.clock?.() ?? new Date()).toISOString(),
    });
    const config = await this.resolveConfig(options);
    let coordinator = options.coordinatorSdk;
    const children: AgentSdk[] = [];
    try {
      coordinator ??= await createAgentSdk({ ...sdkOptions(options), agentConfig: config.coordinator.agent });
      const shared = coordinator.created.runtime;
      for (const resolved of config.workers) children.push(await createAgentSdk({ ...sdkOptions(options), agentConfig: resolved.agent, runtime: shared }));
      const quality = await createAgentSdk({ ...sdkOptions(options), agentConfig: config.quality.agent, runtime: shared }); children.push(quality);
      const synthesizer = await createAgentSdk({ ...sdkOptions(options), agentConfig: config.synthesizer.agent, runtime: shared }); children.push(synthesizer);
      const sdk = new SwarmSdk(coordinator, config, children.slice(0, config.workers.length), quality, synthesizer, !options.coordinatorSdk, options);
      sdk.emit('initialization', 'completed');
      return sdk;
    } catch (error) {
      await Promise.allSettled(children.map((sdk) => sdk.close()));
      if (!options.coordinatorSdk) await coordinator?.close();
      throw error;
    }
  }

  async run(request: SwarmRunRequest): Promise<SwarmSdkRunResult> {
    const sessionId = request.sessionId ?? this.options.idFactory?.() ?? crypto.randomUUID();
    this.emit('decomposition', 'started', sessionId);
    let decompositionResult: RunResult;
    try {
      decompositionResult = await runSwarmDecomposition({ coordinatorSdk: this.coordinatorSdk, sessionId, topLevelObjective: request.topLevelObjective, inputJson: request.input, workerAgents: this.config.workers.map((c) => c.agent), workerIds: this.config.workerIds, contentParts: request.contentParts });
    } catch (error) { this.emit('decomposition', 'failed', sessionId, undefined, error); throw error; }
    const common = { sessionId, coordinatorRunId: decompositionResult.runId, decompositionResult, workerIds: this.config.workerIds, subtasks: [] as SwarmSubtask[], defaultsUsed: this.config.defaultsUsed };
    if (decompositionResult.status !== 'success') {
      const waiting = decompositionResult.status === 'approval_requested' || decompositionResult.status === 'clarification_requested';
      this.emit('decomposition', waiting ? 'waiting' : 'failed', sessionId, decompositionResult.runId);
      return { ...common, state: waiting ? 'waiting' : 'failed' };
    }
    let prepared: SwarmPreparedExecutionResult;
    try {
      prepared = await this.executeDecomposition({
        sessionId,
        coordinatorRunId: decompositionResult.runId,
        topLevelObjective: request.topLevelObjective,
        decompositionOutput: decompositionResult.output,
        input: request.input,
        contentParts: request.contentParts,
        maxWorkers: request.maxWorkers,
      });
    }
    catch (error) { this.emit('decomposition', 'failed', sessionId, decompositionResult.runId, error); throw error; }
    return { ...common, subtasks: prepared.subtasks, state: 'completed', executionResult: prepared.executionResult };
  }

  async executeDecomposition(request: SwarmPreparedExecutionRequest): Promise<SwarmPreparedExecutionResult> {
    const subtasks = parseSwarmSubtasks(request.decompositionOutput);
    validateSdkDecomposition(subtasks, this.config.workerIds);
    this.emit('decomposition', 'completed', request.sessionId, request.coordinatorRunId);
    this.emit('execution', 'started', request.sessionId, request.coordinatorRunId);
    try {
      const executionResult = await this.coordinator().execute({
        sessionId: request.sessionId,
        coordinatorRunId: request.coordinatorRunId,
        topLevelObjective: request.topLevelObjective,
        input: request.input,
        contentParts: request.contentParts?.length ? request.contentParts : undefined,
        maxWorkers: request.maxWorkers,
        metadata: { defaultsUsed: this.config.defaultsUsed },
        subtasks,
      });
      this.emit('execution', executionResult.status === 'succeeded' ? 'completed' : 'failed', request.sessionId, request.coordinatorRunId);
      return { subtasks, executionResult };
    } catch (error) {
      this.emit('execution', 'failed', request.sessionId, request.coordinatorRunId, error);
      throw error;
    }
  }

  async inspectSession(sessionId: string): Promise<SwarmSessionInspection> {
    const list = this.coordinatorSdk.created.runtime.runStore.listBySession;
    if (!list) throw new Error('Run store does not support session lookup');
    const runs = (await list.call(this.coordinatorSdk.created.runtime.runStore, sessionId)).filter(isSwarmRun);
    if (!runs.length) return { sessionId, state: 'not_started', retryable: false, runs };
    const coordinator = runs.find((r) => readRole(r) === 'coordinator');
    const currentRuns = latestLogicalRuns(runs);
    const active = currentRuns.some((run) => ['queued', 'planning', 'awaiting_subagent', 'running'].includes(run.status));
    const waiting = currentRuns.some((run) => ['awaiting_approval', 'clarification_requested'].includes(run.status));
    const failed = currentRuns.some((run) => ['failed', 'interrupted', 'replan_required', 'cancelled'].includes(run.status));
    const phase = inferPhase(runs);
    const hasExecutionDescriptor = Boolean(coordinator && isRecord(coordinator.metadata?.swarmExecution));
    const finalizersPending = hasExecutionDescriptor && !isFinalizedSwarmResult(coordinator?.result);
    const ready = coordinator?.status === 'succeeded' && !hasExecutionDescriptor;
    const retryableFailure = failed || finalizersPending;
    const state = waiting ? 'waiting' : active ? 'active' : ready ? 'ready' : retryableFailure ? 'failed' : 'completed';
    return { sessionId, state, retryable: retryableFailure && !active && !waiting, coordinatorRunId: coordinator?.id, phase, runs, ...((state === 'completed' || state === 'ready') && coordinator?.result !== undefined ? { result: coordinator.result } : {}) };
  }

  async retrySession(sessionId: string, options: { dryRun?: boolean; maxWorkers?: number; allowPartial?: boolean } = {}): Promise<SwarmRetryResult> {
    this.emit('retry', 'started', sessionId);
    try { const result = await this.coordinator().retrySession({ sessionId, ...options }); this.emit('retry', result.status === 'succeeded' ? 'completed' : 'failed', sessionId, result.coordinatorRunId); return result; }
    catch (error) { this.emit('retry', 'failed', sessionId, undefined, error); throw error; }
  }

  async recoverSession(sessionId: string, now = new Date()): Promise<SwarmSessionInspection> {
    const inspection = await this.inspectSession(sessionId);
    for (const run of inspection.runs.filter((candidate) => isActiveRun(candidate) && !hasLiveLease(candidate, now))) {
      const sdk = this.sdkForRun(run);
      if (!sdk) throw new Error(`No configured swarm agent can recover run ${run.id}`);
      await sdk.recoverRaw({ runId: run.id, strategy: 'auto' });
    }
    return this.inspectSession(sessionId);
  }

  async close(): Promise<void> {
    if (this.closed) return; this.closed = true;
    await Promise.allSettled([...this.workerSdks, this.qualitySdk, this.synthesizerSdk].map((sdk) => sdk.close()));
    if (this.ownsCoordinator) await this.coordinatorSdk.close();
  }

  private coordinator() { return buildSwarmCoordinator({ coordinatorSdk: this.coordinatorSdk, workerSdks: this.workerSdks, qualitySdk: this.qualitySdk, synthesizerSdk: this.synthesizerSdk, defaultMaxWorkers: this.options.maxWorkers }); }
  private sdkForRun(run: AgentRun): AgentSdk | undefined {
    const role = readRole(run);
    if (role === 'coordinator') return this.coordinatorSdk;
    if (role === 'quality') return this.qualitySdk;
    if (role === 'synthesizer') return this.synthesizerSdk;
    const agentId = orchestration(run)?.agentId;
    return typeof agentId === 'string'
      ? this.workerSdks.find((sdk) => sdk.config.agent.id === agentId)
      : undefined;
  }
  private emit(phase: SwarmLifecyclePhase, state: SwarmLifecycleState, sessionId?: string, coordinatorRunId?: string, error?: unknown) { this.options.lifecycleListener?.({ phase, state, timestamp: (this.options.clock?.() ?? new Date()).toISOString(), sessionId, coordinatorRunId, ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}) }); }
}

export async function createSwarmSdk(options: SwarmSdkOptions): Promise<SwarmSdk> { return SwarmSdk.create(options); }

function sdkOptions(options: SwarmSdkOptions): AgentSdkOptions {
  const { coordinatorSdk: _a, coordinatorConfig: _b, coordinatorConfigPath: _c, workerConfigs: _d, workerConfigPaths: _e, qualityConfig: _f, qualityConfigPath: _g, synthesizerConfig: _h, synthesizerConfigPath: _i, maxWorkers: _j, lifecycleListener: _k, idFactory: _l, ...base } = options;
  return base;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isFinalizedSwarmResult(value: unknown): boolean { return isRecord(value) && (value.status === 'succeeded' || value.status === 'failed'); }
function orchestration(run: AgentRun): Record<string, unknown> | undefined { const value = run.metadata?.orchestration; return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function isSwarmRun(run: AgentRun): boolean { return orchestration(run)?.kind === 'swarm'; }
function readRole(run: AgentRun): string | undefined { const value = orchestration(run)?.role; return typeof value === 'string' ? value : undefined; }
function latestLogicalRuns(runs: AgentRun[]): AgentRun[] {
  const latest = new Map<string, AgentRun>();
  for (const run of [...runs].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))) {
    const metadata = orchestration(run);
    const role = readRole(run) ?? 'unknown';
    const subtaskId = typeof metadata?.subtaskId === 'string' ? metadata.subtaskId : '';
    latest.set(`${role}:${subtaskId}`, run);
  }
  return [...latest.values()];
}
function isActiveRun(run: AgentRun): boolean { return ['queued', 'planning', 'awaiting_subagent', 'running'].includes(run.status); }
function hasLiveLease(run: AgentRun, now: Date): boolean { return Boolean(run.leaseExpiresAt && new Date(run.leaseExpiresAt).getTime() > now.getTime()); }
function inferPhase(runs: AgentRun[]): SwarmSessionInspection['phase'] { return runs.some((r) => readRole(r) === 'synthesizer') ? 'synthesis' : runs.some((r) => readRole(r) === 'quality') ? 'quality' : runs.some((r) => readRole(r) === 'worker') ? 'workers' : 'decomposition'; }
