import type { OrchestratedRunResult, OrchestrationRecoveryResult } from './prepared-orchestration.js';
import type { SwarmRecoveryResult } from './swarm-coordinator.js';
import type { AgentRun, OrchestrationExecution, RecoverRunOptions, RecoverRunResult, RunRecoveryPlan, RunResult, RuntimeStores, SwarmRunResult } from './types.js';

export interface SessionRecoveryTarget {
  kind: 'run' | 'swarm' | 'orchestration';
  id: string;
  status: string;
  runIds: string[];
  /** Original run identity, used to detect branching continuation histories. */
  lineageRootRunId?: string;
}

/** Resolve logical executions, not every historical attempt or delegate child. Read-only. */
export async function getSessionRecoveryTargets(stores: RuntimeStores, sessionId: string): Promise<SessionRecoveryTarget[]> {
  if (!stores.runStore.listBySession) throw new Error('Run store does not support session lookup');
  const runs = await stores.runStore.listBySession(sessionId, { order: 'asc' });
  const executions = await stores.orchestrationStore?.listBySession(sessionId) ?? [];
  const targets: SessionRecoveryTarget[] = [];
  const covered = new Set<string>();
  for (const execution of executions) {
    const stages = await stores.orchestrationStore!.listStages(execution.id);
    const runIds = stages.map((stage) => stage.runId);
    for (const id of runIds) covered.add(id);
    targets.push({ kind: 'orchestration', id: execution.id, status: execution.status, runIds });
  }

  const superseded = new Set<string>();
  const continuationSources = new Map<string, string>();
  for (const run of runs) {
    const source = await stores.continuationStore?.getByContinuationRun(run.id);
    const sourceId = source?.sourceRunId ?? run.metadata?.continuationOfRunId;
    if (typeof sourceId === 'string') {
      superseded.add(sourceId);
      continuationSources.set(run.id, sourceId);
    }
  }
  const swarm = new Map<string, AgentRun[]>();
  for (const run of runs) {
    const metadata = run.metadata?.orchestration;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) continue;
    if (metadata.kind === 'catalog' && typeof metadata.executionId === 'string') {
      covered.add(run.id);
      if (!targets.some((target) => target.id === metadata.executionId && target.kind === 'orchestration')) {
        targets.push({ kind: 'orchestration', id: metadata.executionId, status: 'unknown', runIds: [run.id] });
      }
    }
    if (metadata.kind === 'swarm') {
      let id = metadata.coordinatorRunId;
      if (id === 'pending' && metadata.role === 'coordinator') {
        id = run.id;
        let source = run.metadata?.continuationOfRunId;
        const visited = new Set<string>();
        while (typeof source === 'string' && !visited.has(source)) {
          visited.add(source);
          id = source;
          source = runs.find((candidate) => candidate.id === source)?.metadata?.continuationOfRunId;
        }
      }
      if (typeof id !== 'string' || !id || id === 'pending') continue;
      const group = swarm.get(id) ?? [];
      group.push(run);
      swarm.set(id, group);
      covered.add(run.id);
    }
  }
  for (const [id, group] of swarm) {
    const coordinator = runs.find((run) => run.id === id);
    // A partial synthesis may have succeeded while a worker still needs recovery.
    const unfinished = group.some((run) => !superseded.has(run.id) && run.status !== 'succeeded'
      && !group.some((next) => {
        const metadata = next.metadata?.orchestration;
        return metadata && typeof metadata === 'object' && !Array.isArray(metadata) && metadata.supersedesRunId === run.id;
      }));
    targets.push({ kind: 'swarm', id, status: unfinished ? 'unfinished' : coordinator?.status ?? 'unknown', runIds: group.map((run) => run.id) });
  }
  for (const run of runs) {
    if (run.parentRunId || covered.has(run.id) || superseded.has(run.id)) continue;
    let rootId = run.id;
    const visited = new Set<string>();
    while (continuationSources.has(rootId) && !visited.has(rootId)) {
      visited.add(rootId);
      rootId = continuationSources.get(rootId)!;
    }
    targets.push({ kind: 'run', id: run.id, status: run.status, runIds: [run.id],
      ...(rootId !== run.id ? { lineageRootRunId: rootId } : {}),
    });
  }
  return targets.sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
}

export interface RecoverSessionOptions {
  sessionId: string;
  runId?: never;
  /** Disambiguate multiple orchestrated executions within a conversation. */
  executionId?: string;
  /** Disambiguate multiple swarms within a conversation. */
  coordinatorRunId?: string;
  dryRun?: boolean;
  /** Explicit continuation consent; never resolves pending tool approvals. */
  requireApproval?: boolean;
}

export interface RecoverSessionResult {
  sessionId: string;
  outcome: 'planned' | 'completed' | 'failed' | 'blocked' | 'busy' | 'ambiguous' | 'not_found';
  target?: SessionRecoveryTarget;
  candidates?: SessionRecoveryTarget[];
  reason?: string;
  plans: RunRecoveryPlan[];
  actions: RecoverRunResult[];
  result?: RunResult | SwarmRunResult | OrchestratedRunResult;
  startedRunIds?: string[];
}

/** Prepared run capabilities; resolving profiles and checking historical configuration are host-owned. */
export interface SessionRecoveryRun {
  resumeRaw(runId: string): Promise<RunResult>;
  getRecoveryPlan(runId: string): Promise<RunRecoveryPlan>;
  recoverRaw(options: RecoverRunOptions): Promise<RecoverRunResult>;
}

export interface SessionRecoveryHandlers {
  resolveRun(run: AgentRun): Promise<SessionRecoveryRun>;
  recoverSwarm(target: SessionRecoveryTarget, runs: AgentRun[], options: RecoverSessionOptions): Promise<SwarmRecoveryResult>;
  recoverOrchestration(execution: OrchestrationExecution, target: SessionRecoveryTarget, runs: AgentRun[], options: RecoverSessionOptions): Promise<OrchestrationRecoveryResult>;
}

/** Selects and recovers one logical execution without choosing or loading an agent profile. */
export async function recoverPreparedSession(stores: RuntimeStores, options: RecoverSessionOptions, handlers: SessionRecoveryHandlers): Promise<RecoverSessionResult> {
  if (!options.sessionId?.trim() || options.runId !== undefined || (options.executionId && options.coordinatorRunId)) {
    throw new Error('Recovery requires exactly one runId or sessionId, and at most one execution selector');
  }
  const report = (outcome: RecoverSessionResult['outcome'], fields: Partial<RecoverSessionResult> = {}): RecoverSessionResult =>
    ({ sessionId: options.sessionId, outcome, plans: [], actions: [], ...fields });
  const targets = await getSessionRecoveryTargets(stores, options.sessionId);
  if (!options.executionId && !options.coordinatorRunId) {
    const roots = new Set<string>();
    for (const target of targets.filter((candidate) => candidate.kind === 'run')) {
      const rootId = target.lineageRootRunId ?? target.id;
      if (roots.has(rootId)) return report('ambiguous', {
        reason: 'A run has multiple continuation branches; choose the intended run explicitly',
        candidates: targets.filter((candidate) => candidate.kind === 'run' && (candidate.lineageRootRunId ?? candidate.id) === rootId),
      });
      roots.add(rootId);
    }
  }
  const selected = options.executionId
    ? targets.filter((target) => target.kind === 'orchestration' && target.id === options.executionId)
    : options.coordinatorRunId
      ? targets.filter((target) => target.kind === 'swarm' && target.id === options.coordinatorRunId)
      : targets.filter((target) => target.status !== 'succeeded');
  if (selected.length === 0) {
    if (options.executionId || options.coordinatorRunId || targets.length === 0) {
      return report('not_found', { reason: 'No matching execution exists in this session', candidates: targets });
    }
    if (targets.length !== 1) return report('completed', { reason: 'All executions in the session have completed', candidates: targets });
    selected.push(targets[0]!);
  }
  if (selected.length > 1) return report('ambiguous', { reason: 'Several independent executions need recovery; choose a run, execution, or coordinator', candidates: selected });
  const target = selected[0]!;
  const runs = await stores.runStore.listBySession!(options.sessionId, { order: 'asc' });
  try {
    if (target.kind === 'run') {
      const run = runs.find((candidate) => candidate.id === target.id)!;
      const owner = await handlers.resolveRun(run);
      if (run.status === 'succeeded') {
        return report('completed', { target, result: await owner.resumeRaw(run.id), reason: 'Run already succeeded; no execution was started' });
      }
      const active = runs.find((candidate) => candidate.rootRunId === run.rootRunId && candidate.leaseExpiresAt && Date.parse(candidate.leaseExpiresAt) > Date.now());
      if (active) return report('busy', { target, reason: `Run ${active.id} holds a live execution lease` });
      const plan = await owner.getRecoveryPlan(run.id);
      if (!plan.executable) return report('blocked', { target, plans: [plan], reason: plan.reason });
      if (options.dryRun) return report('planned', { target, plans: [plan], reason: plan.reason });
      const action = await owner.recoverRaw({ runId: run.id, requireApproval: options.requireApproval });
      return report(action.result?.status === 'success' ? 'completed' : action.result?.status === 'failure' ? 'failed' : 'blocked', {
        target, plans: [plan], actions: [action], result: action.result,
      });
    }
    if (target.kind === 'swarm') {
      const recovered = await handlers.recoverSwarm(target, runs, options);
      return report(recovered.outcome, { ...recovered, target });
    }
    const execution = await stores.orchestrationStore?.getExecution(target.id);
    if (!execution) return report('blocked', { target, reason: 'The durable orchestration execution is missing' });
    const recovered = await handlers.recoverOrchestration(execution, target, runs, options);
    return report(recovered.outcome, { ...recovered, target });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return report(/active execution|acquire lease|already leased|live lease/.test(reason) ? 'busy' : 'blocked', { target, reason });
  }
}
