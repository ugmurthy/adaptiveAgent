import {
  AgentSdk,
  OrchestrationSdk,
  SwarmSdk,
  type ResolvedAgentSdkConfig,
} from '@adaptive-agent/agent-sdk';
import type { AgentRun, JsonValue as CoreJsonValue, RunResult, SwarmRunResult } from '@adaptive-agent/core';
import type {
  ChatRequest,
  JobState,
  OrchestratedRunRequest,
  RunRequest,
  ServiceError,
  ServiceJob,
  SwarmRunRequest,
} from '@adaptive-agent/service-sdk';

import type { ClaimedJob } from './postgres.js';
import { AllowlistedAgentRegistry } from './registry.js';
import { serviceResult, type ExecutionOutcome, type WorkloadExecutor } from './worker.js';
import type { JobWorkspace, WorkspaceManager } from './workspace.js';

export class AgentSdkWorkloadExecutor implements WorkloadExecutor {
  constructor(
    private readonly bootstrap: AgentSdk,
    private readonly registry: AllowlistedAgentRegistry,
    private readonly workspaces: WorkspaceManager,
    private readonly maxSubtasks = 4,
  ) {}

  async execute(claim: ClaimedJob): Promise<ExecutionOutcome> {
    const workspace = await this.workspaces.create(claim.job, { prepare: false });
    try {
      const workspaceRoot = claim.job.kind === 'run' || hasExplicitFileRefs(claim.job) ? workspace.root : workspace.artifacts;
      if (claim.command.kind !== 'execute') {
        return await this.control(claim, workspace, workspaceRoot);
      }

      const existingRuns = await this.runsBySession(claim.job.sessionId);
      if (existingRuns.length > 0) {
        if ((claim.job.kind === 'run' || hasExplicitFileRefs(claim.job)) && existingRunNeedsExecution(existingRuns, claim.job)) await this.prepareWorkspace(claim.job, workspace);
        return await this.recoverExisting(claim, existingRuns, workspaceRoot);
      }
      await this.prepareWorkspace(claim.job, workspace);
      return await this.start(claim, workspaceRoot, workspace.modelContext);
    } finally {
      await this.workspaces.close(claim.job, workspace);
    }
  }

  async close(): Promise<void> {
    await this.bootstrap.close();
  }

  private async prepareWorkspace(job: ServiceJob, workspace: JobWorkspace): Promise<void> {
    await this.workspaces.prepare?.(job, workspace);
  }

  private async start(claim: ClaimedJob, workspaceRoot: string, modelContext?: JobWorkspace['modelContext']): Promise<ExecutionOutcome> {
    const { job } = claim;
    const primarySdk = await this.createSdk(job, primaryAgentId(job), workspaceRoot);
    try {
      if (job.kind === 'run') {
        const request = job.request as RunRequest;
        return fromRun(await primarySdk.runRaw(request.goal, {
          sessionId: job.sessionId,
          input: request.input as CoreJsonValue,
          context: modelContext ? { serviceFileManifest: modelContext } : undefined,
          metadata: serviceMetadata(job),
        }), 'root');
      }
      if (job.kind === 'chat') {
        const request = job.request as ChatRequest;
        return fromRun(await primarySdk.chatRaw(request.message, {
          sessionId: job.sessionId,
          context: modelContext ? { serviceFileManifest: modelContext } : undefined,
          metadata: serviceMetadata(job),
        }), 'root');
      }
      if (job.kind === 'swarm') {
        const swarm = await this.createSwarm(job, primarySdk, workspaceRoot);
        try {
          const request = job.request as SwarmRunRequest;
          const result = await swarm.run({
            sessionId: job.sessionId,
            topLevelObjective: request.objective,
            contentParts: modelContext ? [{ type: 'text', text: modelContext }] : undefined,
            maxWorkers: this.maxSubtasks,
          });
          const runs = await this.runsBySession(job.sessionId);
          if (result.state === 'waiting') return { state: waitingState(result.decompositionResult), runs: runs.map(linkRun) };
          if (result.state === 'failed') return { state: 'failed', error: resultError(result.decompositionResult), runs: runs.map(linkRun) };
          if (!result.executionResult) throw new Error('Completed swarm did not return an execution result');
          return fromSwarm(result.executionResult, runs);
        } finally {
          await swarm.close();
        }
      }

      const request = job.request as OrchestratedRunRequest;
      const configs = await Promise.all(request.agentIds.map((id) => this.resolveConfig(job, id, workspaceRoot)));
      const orchestration = await OrchestrationSdk.create({
        requestedAgentConfig: primarySdk.config.agent,
        agentCatalog: configs.map((config) => ({ agentId: config.agent.id, agentConfig: config.agent })),
        runtime: this.bootstrap.created.runtime,
        concurrency: { maxConcurrentRunsPerSession: this.maxSubtasks },
      });
      try {
        const result = await orchestration.runRaw(request.objective, {
          sessionId: job.sessionId,
          requestedAgentId: request.orchestratorAgentId,
          context: modelContext ? { serviceFileManifest: modelContext } : undefined,
          orchestrationMetadata: serviceMetadata(job),
        });
        return {
          ...fromRun(result.finalResult, 'root'),
          runs: (await this.runsBySession(job.sessionId)).map(linkRun),
        };
      } finally {
        await orchestration.close();
      }
    } finally {
      await primarySdk.close();
    }
  }

  private async recoverExisting(claim: ClaimedJob, runs: AgentRun[], workspaceRoot: string): Promise<ExecutionOutcome> {
    if (claim.job.kind === 'swarm') {
      return this.recoverSwarm(claim.job, workspaceRoot);
    }

    const root = latestPrimaryRoot(runs, primaryAgentId(claim.job));
    if (!root) throw new Error(`Session ${claim.job.sessionId} has runs but no root run for its primary agent`);
    if (isActive(root.status) && hasLiveLease(root)) {
      return { state: 'running', deferred: true, runs: runs.map(linkRun) };
    }
    if (root.status === 'awaiting_approval' || root.status === 'clarification_requested') {
      return { state: waitingFromRuns(runs), runs: runs.map(linkRun) };
    }
    if (root.status === 'succeeded') return fromStoredRun(root, runs);

    const sdk = await this.createSdkForRun(claim.job, root, workspaceRoot);
    try {
      const recovered = await sdk.recoverRaw({ runId: root.id, strategy: 'auto' });
      if (!recovered.result) throw new Error(`Run ${root.id} is not recoverable: ${recovered.action}`);
      return {
        ...fromRun(recovered.result, 'root'),
        runs: (await this.runsBySession(claim.job.sessionId)).map(linkRun),
      };
    } finally {
      await sdk.close();
    }
  }

  private async recoverSwarm(job: ServiceJob, workspaceRoot: string): Promise<ExecutionOutcome> {
    const coordinatorSdk = await this.createSdk(job, primaryAgentId(job), workspaceRoot);
    const swarm = await this.createSwarm(job, coordinatorSdk, workspaceRoot);
    try {
      let inspection = await swarm.inspectSession(job.sessionId);
      if (inspection.state === 'active') {
        if (inspection.runs.some((run) => isActive(run.status) && hasLiveLease(run))) {
          return { state: 'running', deferred: true, runs: inspection.runs.map(linkRun) };
        }
        inspection = await swarm.recoverSession(job.sessionId);
      }
      if (inspection.state === 'active') return { state: 'running', deferred: true, runs: inspection.runs.map(linkRun) };
      if (inspection.state === 'waiting') return { state: waitingFromRuns(inspection.runs), runs: inspection.runs.map(linkRun) };
      if (inspection.state === 'ready') {
        if (!inspection.coordinatorRunId || inspection.result === undefined) throw new Error('Ready swarm has no persisted decomposition');
        const request = job.request as SwarmRunRequest;
        const prepared = await swarm.executeDecomposition({
          sessionId: job.sessionId,
          coordinatorRunId: inspection.coordinatorRunId,
          topLevelObjective: request.objective,
          decompositionOutput: inspection.result,
          maxWorkers: this.maxSubtasks,
        });
        return fromSwarm(prepared.executionResult, await this.runsBySession(job.sessionId));
      }
      if (inspection.state === 'completed') {
        return fromPersistedSwarm(inspection.result, inspection.runs);
      }
      if (inspection.state === 'not_started') {
        throw new Error(`Swarm session ${job.sessionId} disappeared during recovery`);
      }

      const retried = await swarm.retrySession(job.sessionId, { maxWorkers: this.maxSubtasks });
      return fromSwarm(retried, await this.runsBySession(job.sessionId));
    } finally {
      await swarm.close();
      await coordinatorSdk.close();
    }
  }

  private async control(claim: ClaimedJob, workspace: JobWorkspace, workspaceRoot: string): Promise<ExecutionOutcome> {
    const runs = await this.runsBySession(claim.job.sessionId);
    if (runs.length === 0 && claim.command.kind === 'retry') {
      await this.prepareWorkspace(claim.job, workspace);
      return this.start(claim, workspaceRoot, workspace.modelContext);
    }
    if (runs.length === 0) throw new Error(`No run exists for session ${claim.job.sessionId}`);

    if (claim.command.kind === 'cancel') {
      for (const run of latestActiveRoots(runs)) {
        const sdk = await this.createSdkForRun(claim.job, run, workspaceRoot);
        try {
          await sdk.interrupt(run.id);
        } finally {
          await sdk.close();
        }
      }
      return { state: 'cancelled', runs: (await this.runsBySession(claim.job.sessionId)).map(linkRun) };
    }

    if (claim.job.kind === 'swarm' && (claim.command.kind === 'retry' || claim.command.kind === 'recover')) {
      await this.prepareWorkspace(claim.job, workspace);
      return this.recoverSwarm(claim.job, workspaceRoot);
    }

    const target = controlTarget(runs, claim.job, claim.command.kind);
    if (!target) throw new Error(`No compatible run exists for ${claim.command.kind}`);
    if (isTerminal(target.status) && ['steer', 'resolve_approval', 'resolve_clarification'].includes(claim.command.kind)) {
      return fromStoredRun(target, runs);
    }

    const sdk = await this.createSdkForRun(claim.job, target, workspaceRoot);
    try {
      const payload = claim.command.payload as Record<string, unknown> | undefined;
      if (claim.command.kind === 'steer') {
        await sdk.steer(target.id, { role: 'user', message: requiredString(payload?.message, 'steer message') });
        return { state: 'running', runs: runs.map(linkRun) };
      }
      await this.prepareWorkspace(claim.job, workspace);
      let result: RunResult;
      switch (claim.command.kind) {
        case 'retry':
          result = await sdk.retryRaw(target.id);
          break;
        case 'recover': {
          const recovered = await sdk.recoverRaw({ runId: target.id, strategy: 'auto' });
          if (!recovered.result) throw new Error(`Run ${target.id} is not recoverable: ${recovered.action}`);
          result = recovered.result;
          break;
        }
        case 'resume':
          result = await sdk.resumeRaw(target.id);
          break;
        case 'continue':
          result = await sdk.continueRunRaw({ fromRunId: target.id });
          break;
        case 'resolve_approval':
          await sdk.agent.resolveApproval(target.id, payload?.approved === true);
          result = await sdk.resumeRaw(target.id);
          break;
        case 'resolve_clarification':
          result = await sdk.agent.resolveClarification(target.id, requiredString(payload?.answer, 'clarification answer'));
          break;
        default:
          throw new Error(`Unsupported command ${claim.command.kind}`);
      }

      if (claim.job.kind === 'swarm') {
        if (result.status !== 'success') return fromRun(result, 'coordinator');
        return this.recoverSwarm(claim.job, workspaceRoot);
      }
      return {
        ...fromRun(result, claim.command.kind === 'continue' ? 'continuation' : 'root'),
        runs: (await this.runsBySession(claim.job.sessionId)).map(linkRun),
      };
    } finally {
      await sdk.close();
    }
  }

  private async createSwarm(job: ServiceJob, coordinatorSdk: AgentSdk, workspaceRoot: string): Promise<SwarmSdk> {
    const request = job.request as SwarmRunRequest;
    const [workers, qualityConfig, synthesizerConfig] = await Promise.all([
      Promise.all(request.workerAgentIds.map((id) => this.resolveConfig(job, id, workspaceRoot))),
      this.resolveConfig(job, request.qualityAgentId ?? request.coordinatorAgentId, workspaceRoot),
      this.resolveConfig(job, request.synthesizerAgentId ?? request.coordinatorAgentId, workspaceRoot),
    ]);
    return SwarmSdk.create({
      coordinatorSdk,
      workerConfigs: workers,
      qualityConfig,
      synthesizerConfig,
      runtime: this.bootstrap.created.runtime,
      maxWorkers: this.maxSubtasks,
    });
  }

  private async createSdk(job: ServiceJob, agentId: string, workspaceRoot: string): Promise<AgentSdk> {
    const config = await this.resolveConfig(job, agentId, workspaceRoot);
    return AgentSdk.create({ agentConfig: config.agent, runtime: this.bootstrap.created.runtime });
  }

  private async createSdkForRun(job: ServiceJob, run: AgentRun, workspaceRoot: string): Promise<AgentSdk> {
    const agentId = typeof run.metadata?.agentId === 'string' ? run.metadata.agentId : primaryAgentId(job);
    return this.createSdk(job, agentId, workspaceRoot);
  }

  private async resolveConfig(job: ServiceJob, id: string, workspaceRoot: string): Promise<ResolvedAgentSdkConfig> {
    const profile = job.profiles.find((candidate) => candidate.agentId === id);
    if (!profile) throw new Error(`Agent ${id} is not pinned to service job ${job.id}`);
    const { config } = await this.registry.resolvePinned(profile, job.kind);
    return { ...config, agent: { ...config.agent, workspaceRoot } };
  }

  private async runsBySession(sessionId: string): Promise<AgentRun[]> {
    const list = this.bootstrap.created.runtime.runStore.listBySession;
    if (!list) throw new Error('Configured core run store does not support session adoption');
    return list.call(this.bootstrap.created.runtime.runStore, sessionId);
  }
}

function primaryAgentId(job: ServiceJob): string {
  const request = job.request as unknown as Record<string, unknown>;
  const id = request.agentId ?? request.coordinatorAgentId ?? request.orchestratorAgentId;
  if (typeof id !== 'string') throw new Error('Job has no authoritative primary agent ID');
  return id;
}

function existingRunNeedsExecution(runs: AgentRun[],job:ServiceJob):boolean {
  const root=latestPrimaryRoot(runs,primaryAgentId(job));
  return Boolean(root&&!((isActive(root.status)&&hasLiveLease(root))||root.status==='awaiting_approval'||root.status==='clarification_requested'||root.status==='succeeded'));
}

function hasExplicitFileRefs(job:ServiceJob):boolean {
  return Boolean(job.request.fileRefs?.length);
}

function serviceMetadata(job: ServiceJob): Record<string, CoreJsonValue> {
  return { service: { jobId: job.id, tenantId: job.tenantId } };
}

function fromRun(result: RunResult, role: 'root' | 'coordinator' | 'continuation'): ExecutionOutcome {
  if (result.status === 'success') {
    return { state: 'succeeded', result: serviceResult(result.output as CoreJsonValue), runs: [{ runId: result.runId, role }] };
  }
  if (result.status === 'approval_requested') return { state: 'waiting_approval', runs: [{ runId: result.runId, role }] };
  if (result.status === 'clarification_requested') return { state: 'waiting_clarification', runs: [{ runId: result.runId, role }] };
  return {
    state: 'failed',
    error: { schemaVersion: 1, code: result.code, message: result.error, retryable: true },
    runs: [{ runId: result.runId, role }],
  };
}

function fromStoredRun(run: AgentRun, allRuns: AgentRun[]): ExecutionOutcome {
  if (run.status === 'succeeded') {
    return { state: 'succeeded', result: serviceResult((run.result ?? null) as CoreJsonValue), runs: allRuns.map(linkRun) };
  }
  if (run.status === 'awaiting_approval') return { state: 'waiting_approval', runs: allRuns.map(linkRun) };
  if (run.status === 'clarification_requested') return { state: 'waiting_clarification', runs: allRuns.map(linkRun) };
  if (run.status === 'cancelled') return { state: 'cancelled', runs: allRuns.map(linkRun) };
  return {
    state: 'failed',
    error: { schemaVersion: 1, code: run.errorCode ?? 'run_failed', message: run.errorMessage ?? `Run ${run.id} failed`, retryable: true },
    runs: allRuns.map(linkRun),
  };
}

function fromSwarm(result: SwarmRunResult, runs: AgentRun[]): ExecutionOutcome {
  if (result.status === 'succeeded') {
    return { state: 'succeeded', result: serviceResult(result as unknown as CoreJsonValue), runs: runs.map(linkRun) };
  }
  return {
    state: 'failed',
    error: {
      schemaVersion: 1,
      code: result.errorCode ?? 'swarm_failed',
      message: result.errorMessage ?? 'Swarm execution failed',
      retryable: true,
    },
    runs: runs.map(linkRun),
  };
}

function fromPersistedSwarm(value: CoreJsonValue | undefined, runs: AgentRun[]): ExecutionOutcome {
  if (!isRecord(value) || (value.status !== 'succeeded' && value.status !== 'failed')) {
    throw new Error('Completed swarm has no valid persisted result');
  }
  return fromSwarm(value as unknown as SwarmRunResult, runs);
}

function latestPrimaryRoot(runs: AgentRun[], primaryId: string): AgentRun | undefined {
  const roots = runs.filter((run) => run.id === run.rootRunId);
  return [...roots]
    .filter((run) => run.metadata?.agentId === primaryId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
    ?? [...roots].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function latestActiveRoots(runs: AgentRun[]): AgentRun[] {
  return runs.filter((run) => run.id === run.rootRunId && isActive(run.status));
}

function controlTarget(runs: AgentRun[], job: ServiceJob, command: string): AgentRun | undefined {
  if (command === 'resolve_approval') return latestByStatus(runs, 'awaiting_approval');
  if (command === 'resolve_clarification') return latestByStatus(runs, 'clarification_requested');
  if (command === 'resume') {
    return latestByStatus(runs, 'awaiting_approval')
      ?? latestByStatus(runs, 'clarification_requested')
      ?? latestPrimaryRoot(runs, primaryAgentId(job));
  }
  if (command === 'steer') {
    return [...runs].filter((run) => run.id === run.rootRunId && isActive(run.status))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  }
  return latestPrimaryRoot(runs, primaryAgentId(job));
}

function latestByStatus(runs: AgentRun[], status: AgentRun['status']): AgentRun | undefined {
  return [...runs].filter((run) => run.status === status)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function isActive(status: AgentRun['status']): boolean {
  return ['queued', 'planning', 'running', 'awaiting_subagent'].includes(status);
}

function isTerminal(status: AgentRun['status']): boolean {
  return ['succeeded', 'failed', 'cancelled'].includes(status);
}

function hasLiveLease(run: AgentRun, now = new Date()): boolean {
  return Boolean(run.leaseExpiresAt && new Date(run.leaseExpiresAt).getTime() > now.getTime());
}

function waitingFromRuns(runs: AgentRun[]): 'waiting_approval' | 'waiting_clarification' {
  return runs.some((run) => run.status === 'awaiting_approval') ? 'waiting_approval' : 'waiting_clarification';
}

function waitingState(result: RunResult): 'waiting_approval' | 'waiting_clarification' {
  return result.status === 'approval_requested' ? 'waiting_approval' : 'waiting_clarification';
}

function resultError(result: RunResult): ServiceError {
  if (result.status === 'failure') return { schemaVersion: 1, code: result.code, message: result.error, retryable: true };
  return { schemaVersion: 1, code: 'swarm_decomposition_failed', message: 'Swarm decomposition did not complete', retryable: true };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value;
}

function linkRun(run: AgentRun): { runId: string; role: 'root' | 'coordinator' | 'worker' | 'quality' | 'synthesizer' | 'child' | 'continuation' } {
  const metadata = run.metadata?.orchestration as Record<string, unknown> | undefined;
  const candidate = metadata?.role;
  const role = ['coordinator', 'worker', 'quality', 'synthesizer'].includes(String(candidate))
    ? candidate as 'coordinator' | 'worker' | 'quality' | 'synthesizer'
    : run.id === run.rootRunId ? 'root' : 'child';
  return { runId: run.id, role };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
