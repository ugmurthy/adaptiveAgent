import type { AgentRun, RunStatus, RunStore, UsageSummary, UUID } from './types.js';

const TERMINAL_RUN_STATUSES = new Set<RunStatus>([
  'succeeded',
  'failed',
  'clarification_requested',
  'replan_required',
  'cancelled',
]);

function cloneRun(run: AgentRun): AgentRun {
  return structuredClone(run);
}

function emptyUsage(): UsageSummary {
  return {
    promptTokens: 0,
    completionTokens: 0,
    estimatedCostUSD: 0,
  };
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

function toIsoString(date: Date): string {
  return date.toISOString();
}

export class OptimisticConcurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OptimisticConcurrencyError';
  }
}

export class InMemoryRunStore implements RunStore {
  private readonly runs = new Map<UUID, AgentRun>();
  private readonly childRunIdsByParent = new Map<UUID, UUID[]>();

  async createRun(run: Parameters<RunStore['createRun']>[0]): Promise<AgentRun> {
    const id = run.id ?? crypto.randomUUID();

    if (this.runs.has(id)) {
      throw new Error(`Run ${id} already exists`);
    }

    const parent = run.parentRunId ? this.runs.get(run.parentRunId) : undefined;
    if (run.parentRunId && !parent) {
      throw new Error(`Parent run ${run.parentRunId} does not exist`);
    }

    if ((run.parentStepId || run.delegateName) && !run.parentRunId) {
      throw new Error('parentStepId and delegateName require parentRunId');
    }

    const rootRunId = run.rootRunId ?? parent?.rootRunId ?? id;
    if (rootRunId !== id && !this.runs.has(rootRunId)) {
      throw new Error(`Root run ${rootRunId} does not exist`);
    }

    const delegationDepth = run.delegationDepth ?? (parent ? parent.delegationDepth + 1 : 0);
    if (delegationDepth < 0) {
      throw new Error('delegationDepth must be >= 0');
    }

    if (run.currentChildRunId && !this.runs.has(run.currentChildRunId)) {
      throw new Error(`Current child run ${run.currentChildRunId} does not exist`);
    }

    const now = new Date();
    const storedRun: AgentRun = {
      id,
      rootRunId,
      parentRunId: run.parentRunId,
      parentStepId: run.parentStepId,
      delegateName: run.delegateName,
      delegationDepth,
      currentChildRunId: run.currentChildRunId,
      goal: run.goal,
      input: run.input,
      context: run.context,
      status: run.status,
      version: 0,
      usage: emptyUsage(),
      metadata: run.metadata,
      createdAt: toIsoString(now),
      updatedAt: toIsoString(now),
      completedAt: isTerminalRunStatus(run.status) ? toIsoString(now) : undefined,
    };

    this.runs.set(id, storedRun);
    if (run.parentRunId) {
      const children = this.childRunIdsByParent.get(run.parentRunId) ?? [];
      children.push(id);
      this.childRunIdsByParent.set(run.parentRunId, children);
    }

    return cloneRun(storedRun);
  }

  async getRun(runId: UUID): Promise<AgentRun | null> {
    const run = this.runs.get(runId);
    return run ? cloneRun(run) : null;
  }

  async updateRun(runId: UUID, patch: Partial<AgentRun>, expectedVersion?: number): Promise<AgentRun> {
    const current = this.runs.get(runId);
    if (!current) {
      throw new Error(`Run ${runId} does not exist`);
    }

    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new OptimisticConcurrencyError(
        `Run ${runId} version mismatch: expected ${expectedVersion}, got ${current.version}`,
      );
    }

    if (patch.id && patch.id !== runId) {
      throw new Error('Run IDs are immutable');
    }

    if (patch.rootRunId && patch.rootRunId !== current.rootRunId) {
      throw new Error('rootRunId is immutable');
    }

    if (patch.parentRunId && patch.parentRunId !== current.parentRunId) {
      throw new Error('parentRunId is immutable');
    }

    if (patch.parentStepId && patch.parentStepId !== current.parentStepId) {
      throw new Error('parentStepId is immutable');
    }

    if (patch.delegateName && patch.delegateName !== current.delegateName) {
      throw new Error('delegateName is immutable');
    }

    if (patch.delegationDepth !== undefined && patch.delegationDepth !== current.delegationDepth) {
      throw new Error('delegationDepth is immutable');
    }

    if (patch.currentChildRunId && !this.runs.has(patch.currentChildRunId)) {
      throw new Error(`Current child run ${patch.currentChildRunId} does not exist`);
    }

    const now = new Date();
    const nextStatus = patch.status ?? current.status;
    const completedAtWasPatched = Object.prototype.hasOwnProperty.call(patch, 'completedAt');
    const patchedCompletedAt = (patch as { completedAt?: string | null }).completedAt;
    const nextRun: AgentRun = {
      ...current,
      ...patch,
      version: current.version + 1,
      updatedAt: toIsoString(now),
      completedAt: completedAtWasPatched
        ? (patchedCompletedAt ?? undefined)
        : current.completedAt ?? (isTerminalRunStatus(nextStatus) ? toIsoString(now) : undefined),
    };

    this.runs.set(runId, nextRun);
    return cloneRun(nextRun);
  }

  async tryAcquireLease(params: {
    runId: UUID;
    owner: string;
    ttlMs: number;
    now: Date;
  }): Promise<boolean> {
    const current = this.runs.get(params.runId);
    if (!current) {
      throw new Error(`Run ${params.runId} does not exist`);
    }

    const leaseExpired =
      !current.leaseExpiresAt || new Date(current.leaseExpiresAt).getTime() <= params.now.getTime();
    const sameOwner = current.leaseOwner === params.owner;
    if (!leaseExpired && !sameOwner) {
      return false;
    }

    await this.updateRun(
      params.runId,
      {
        leaseOwner: params.owner,
        leaseExpiresAt: toIsoString(new Date(params.now.getTime() + params.ttlMs)),
        heartbeatAt: toIsoString(params.now),
      },
      current.version,
    );

    return true;
  }

  async heartbeatLease(params: {
    runId: UUID;
    owner: string;
    ttlMs: number;
    now: Date;
  }): Promise<void> {
    const current = this.runs.get(params.runId);
    if (!current) {
      throw new Error(`Run ${params.runId} does not exist`);
    }

    if (current.leaseOwner !== params.owner) {
      throw new Error(`Run ${params.runId} lease is not owned by ${params.owner}`);
    }

    await this.updateRun(
      params.runId,
      {
        leaseExpiresAt: toIsoString(new Date(params.now.getTime() + params.ttlMs)),
        heartbeatAt: toIsoString(params.now),
      },
      current.version,
    );
  }

  async releaseLease(runId: UUID, owner: string): Promise<void> {
    const current = this.runs.get(runId);
    if (!current) {
      throw new Error(`Run ${runId} does not exist`);
    }

    if (current.leaseOwner && current.leaseOwner !== owner) {
      throw new Error(`Run ${runId} lease is not owned by ${owner}`);
    }

    await this.updateRun(
      runId,
      {
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        heartbeatAt: undefined,
      },
      current.version,
    );
  }

  async listChildren(parentRunId: UUID): Promise<AgentRun[]> {
    const childIds = this.childRunIdsByParent.get(parentRunId) ?? [];
    return childIds
      .map((childId) => this.runs.get(childId))
      .filter((run): run is AgentRun => Boolean(run))
      .map(cloneRun);
  }

  async listRunsByRoot(rootRunId: UUID): Promise<AgentRun[]> {
    return Array.from(this.runs.values())
      .filter((run) => run.rootRunId === rootRunId)
      .map(cloneRun);
  }
}
