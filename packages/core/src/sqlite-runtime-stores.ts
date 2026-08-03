import { Database } from 'bun:sqlite';

import { runSqliteRuntimeMigrations } from './sqlite-runtime-migrations.js';
import type {
  AgentEvent,
  AgentRun,
  ContinuationStore,
  EventSink,
  EventStore,
  JsonValue,
  PlanArtifact,
  PlanExecution,
  PlanExecutionStatus,
  PlanStore,
  RecoveryScanReason,
  RunContinuation,
  RunSnapshot,
  RunStatus,
  RunStore,
  RuntimeRecoveryCandidate,
  RuntimeDeletionPreview,
  RuntimeDeletionTarget,
  RuntimeMaintenanceStore,
  RuntimeStores,
  RuntimeTransactionStore,
  SnapshotStore,
  ToolExecutionRecord,
  ToolExecutionStore,
  UsageSummary,
  UUID,
} from './types.js';

const TERMINAL_RUN_STATUSES = new Set<RunStatus>([
  'succeeded',
  'failed',
  'clarification_requested',
  'replan_required',
  'cancelled',
]);

const TERMINAL_PLAN_EXECUTION_STATUSES = new Set<PlanExecutionStatus>([
  'succeeded',
  'failed',
  'replan_required',
  'cancelled',
]);

const DELETABLE_RUN_STATUSES = new Set<RunStatus>([
  'interrupted',
  'succeeded',
  'failed',
  'clarification_requested',
  'replan_required',
  'cancelled',
]);

interface RecordRow {
  record_json: string;
}

interface EventRow {
  id: string;
  run_id: string;
  plan_execution_id: string | null;
  seq: number;
  step_id: string | null;
  tool_call_id: string | null;
  event_type: string;
  schema_version: number;
  payload_json: string;
  created_at: string;
}

interface StoreExecutor {
  run<T>(operation: () => T | Promise<T>): Promise<T>;
}

class SerializedStoreExecutor implements StoreExecutor {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  run<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('SQLite runtime is closed'));
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  close(operation: () => void): Promise<void> {
    if (this.closed) return this.tail;
    this.closed = true;
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

const DIRECT_EXECUTOR: StoreExecutor = {
  async run<T>(operation: () => T | Promise<T>): Promise<T> {
    return operation();
  },
};

export class SqliteOptimisticConcurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqliteOptimisticConcurrencyError';
  }
}

export interface SqliteRuntimeOptions {
  busyTimeoutMs?: number;
  migrate?: boolean;
}

export interface OpenSqliteRuntimeOptions extends SqliteRuntimeOptions {
  path: string;
}

export class SqliteRunStore implements RunStore {
  constructor(
    private readonly database: Database,
    private readonly executor: StoreExecutor = DIRECT_EXECUTOR,
  ) {}

  createRun(run: Parameters<RunStore['createRun']>[0]): Promise<AgentRun> {
    return this.executor.run(() => {
      const id = run.id ?? crypto.randomUUID();
      if (this.readRun(id)) throw new Error(`Run ${id} already exists`);

      const parent = run.parentRunId ? this.readRun(run.parentRunId) : null;
      if (run.parentRunId && !parent) {
        throw new Error(`Parent run ${run.parentRunId} does not exist`);
      }
      if ((run.parentStepId || run.delegateName) && !run.parentRunId) {
        throw new Error('parentStepId and delegateName require parentRunId');
      }

      const rootRunId = run.rootRunId ?? parent?.rootRunId ?? id;
      if (rootRunId !== id && !this.readRun(rootRunId)) {
        throw new Error(`Root run ${rootRunId} does not exist`);
      }
      const delegationDepth = run.delegationDepth ?? (parent ? parent.delegationDepth + 1 : 0);
      if (delegationDepth < 0) throw new Error('delegationDepth must be >= 0');
      if (run.currentChildRunId && !this.readRun(run.currentChildRunId)) {
        throw new Error(`Current child run ${run.currentChildRunId} does not exist`);
      }

      const now = new Date().toISOString();
      const storedRun: AgentRun = {
        id,
        sessionId: parent?.sessionId ?? run.sessionId,
        rootRunId,
        parentRunId: run.parentRunId,
        parentStepId: run.parentStepId,
        delegateName: run.delegateName,
        delegationDepth,
        currentChildRunId: run.currentChildRunId,
        goal: run.goal,
        input: run.input,
        context: run.context,
        executionContext: structuredClone(parent ? parent.executionContext : run.executionContext),
        modelProvider: run.modelProvider,
        modelName: run.modelName,
        modelParameters: run.modelParameters,
        status: run.status,
        version: 0,
        usage: emptyUsage(),
        metadata: run.metadata,
        createdAt: now,
        updatedAt: now,
        completedAt: isTerminalRunStatus(run.status) ? now : undefined,
      };

      this.database.run(`
        insert into agent_runs (
          id, session_id, root_run_id, parent_run_id, current_child_run_id,
          status, lease_owner, lease_expires_at, heartbeat_at, version,
          created_at, updated_at, record_json
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, runBindings(storedRun));
      return clone(storedRun);
    });
  }

  getRun(runId: UUID): Promise<AgentRun | null> {
    return this.executor.run(() => cloneNullable(this.readRun(runId)));
  }

  listBySession(
    sessionId: string,
    options: { limit?: number; offset?: number; order?: 'asc' | 'desc' } = {},
  ): Promise<AgentRun[]> {
    return this.executor.run(() => {
      const limit = Math.max(0, options.limit ?? 100);
      const offset = Math.max(0, options.offset ?? 0);
      const direction = options.order === 'asc' ? 'asc' : 'desc';
      const rows = this.database.query(`
        select record_json from agent_runs
        where session_id = ?
        order by created_at ${direction}, id ${direction}
        limit ? offset ?
      `).all(sessionId, limit, offset) as RecordRow[];
      return rows.map((row) => parseRecord<AgentRun>(row.record_json));
    });
  }

  updateRun(runId: UUID, patch: Partial<AgentRun>, expectedVersion?: number): Promise<AgentRun> {
    return this.executor.run(() => {
      const current = this.requireRun(runId);
      if (expectedVersion !== undefined && current.version !== expectedVersion) {
        throw new SqliteOptimisticConcurrencyError(
          `Run ${runId} version mismatch: expected ${expectedVersion}, got ${current.version}`,
        );
      }
      assertMutableRunPatch(runId, current, patch);
      if (patch.currentChildRunId && !this.readRun(patch.currentChildRunId)) {
        throw new Error(`Current child run ${patch.currentChildRunId} does not exist`);
      }

      const now = new Date().toISOString();
      const nextStatus = patch.status ?? current.status;
      const completedAtWasPatched = Object.prototype.hasOwnProperty.call(patch, 'completedAt');
      const patchedCompletedAt = (patch as { completedAt?: string | null }).completedAt;
      const next: AgentRun = {
        ...current,
        ...patch,
        version: current.version + 1,
        updatedAt: now,
        completedAt: completedAtWasPatched
          ? (patchedCompletedAt ?? undefined)
          : current.completedAt ?? (isTerminalRunStatus(nextStatus) ? now : undefined),
      };

      this.persistRunUpdate(next, current.version);
      return clone(next);
    });
  }

  tryAcquireLease(params: { runId: UUID; owner: string; ttlMs: number; now: Date }): Promise<boolean> {
    return this.executor.run(() => {
      const current = this.requireRun(params.runId);
      const now = params.now.toISOString();
      const next: AgentRun = {
        ...current,
        leaseOwner: params.owner,
        leaseExpiresAt: new Date(params.now.getTime() + params.ttlMs).toISOString(),
        heartbeatAt: now,
        version: current.version + 1,
        updatedAt: now,
      };
      const result = this.database.run(`
        update agent_runs set
          lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?,
          version = ?, updated_at = ?, record_json = ?
        where id = ? and version = ?
          and (lease_owner is null or lease_owner = ? or lease_expires_at is null or lease_expires_at <= ?)
      `, [
        next.leaseOwner ?? null,
        next.leaseExpiresAt ?? null,
        next.heartbeatAt ?? null,
        next.version,
        next.updatedAt,
        JSON.stringify(next),
        next.id,
        current.version,
        params.owner,
        now,
      ]);
      return result.changes === 1;
    });
  }

  heartbeatLease(params: { runId: UUID; owner: string; ttlMs: number; now: Date }): Promise<void> {
    return this.executor.run(() => {
      const current = this.requireRun(params.runId);
      if (current.leaseOwner !== params.owner) {
        throw new Error(`Run ${params.runId} lease is not owned by ${params.owner}`);
      }
      const now = params.now.toISOString();
      const next: AgentRun = {
        ...current,
        leaseExpiresAt: new Date(params.now.getTime() + params.ttlMs).toISOString(),
        heartbeatAt: now,
        version: current.version + 1,
        updatedAt: now,
      };
      const result = this.database.run(`
        update agent_runs set
          lease_expires_at = ?, heartbeat_at = ?, version = ?, updated_at = ?, record_json = ?
        where id = ? and version = ? and lease_owner = ?
      `, [
        next.leaseExpiresAt ?? null,
        next.heartbeatAt ?? null,
        next.version,
        next.updatedAt,
        JSON.stringify(next),
        next.id,
        current.version,
        params.owner,
      ]);
      if (result.changes !== 1) {
        throw new Error(`Run ${params.runId} lease is not owned by ${params.owner}`);
      }
    });
  }

  releaseLease(runId: UUID, owner: string): Promise<void> {
    return this.executor.run(() => {
      const current = this.requireRun(runId);
      if (current.leaseOwner && current.leaseOwner !== owner) {
        throw new Error(`Run ${runId} lease is not owned by ${owner}`);
      }
      const next: AgentRun = {
        ...current,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        heartbeatAt: undefined,
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
      };
      const result = this.database.run(`
        update agent_runs set
          lease_owner = null, lease_expires_at = null, heartbeat_at = null,
          version = ?, updated_at = ?, record_json = ?
        where id = ? and version = ? and (lease_owner is null or lease_owner = ?)
      `, [
        next.version,
        next.updatedAt,
        JSON.stringify(next),
        next.id,
        current.version,
        owner,
      ]);
      if (result.changes !== 1) throw new Error(`Run ${runId} lease is not owned by ${owner}`);
    });
  }

  private readRun(runId: UUID): AgentRun | null {
    const row = this.database
      .query('select record_json from agent_runs where id = ?')
      .get(runId) as RecordRow | null;
    return row ? parseRecord<AgentRun>(row.record_json) : null;
  }

  private requireRun(runId: UUID): AgentRun {
    const run = this.readRun(runId);
    if (!run) throw new Error(`Run ${runId} does not exist`);
    return run;
  }

  private persistRunUpdate(next: AgentRun, previousVersion: number): void {
    const result = this.database.run(`
      update agent_runs set
        current_child_run_id = ?, status = ?, lease_owner = ?, lease_expires_at = ?,
        heartbeat_at = ?, version = ?, updated_at = ?, record_json = ?
      where id = ? and version = ?
    `, [
      next.currentChildRunId ?? null,
      next.status,
      next.leaseOwner ?? null,
      next.leaseExpiresAt ?? null,
      next.heartbeatAt ?? null,
      next.version,
      next.updatedAt,
      JSON.stringify(next),
      next.id,
      previousVersion,
    ]);
    if (result.changes !== 1) {
      throw new SqliteOptimisticConcurrencyError(`Run ${next.id} version mismatch while updating`);
    }
  }
}

export class SqliteEventStore implements EventStore, EventSink {
  private readonly listeners = new Set<(event: AgentEvent) => void>();

  constructor(
    private readonly database: Database,
    private readonly executor: StoreExecutor = DIRECT_EXECUTOR,
  ) {}

  append(event: Omit<AgentEvent, 'id' | 'seq' | 'createdAt'>): Promise<AgentEvent> {
    return this.executor.run(() => {
      const id = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      const row = this.database.query(`
        insert into agent_events (
          id, run_id, plan_execution_id, seq, step_id, tool_call_id,
          event_type, schema_version, payload_json, created_at
        )
        select ?, ?, ?, coalesce(max(seq), 0) + 1, ?, ?, ?, ?, ?, ?
        from agent_events where run_id = ?
        returning seq
      `).get(
        id,
        event.runId,
        event.planExecutionId ?? null,
        event.stepId ?? null,
        event.toolCallId ?? null,
        event.type,
        event.schemaVersion,
        JSON.stringify(event.payload),
        createdAt,
        event.runId,
      ) as { seq: number } | null;
      if (!row) throw new Error(`Failed to append event for run ${event.runId}`);

      const persisted: AgentEvent = { ...event, id, seq: Number(row.seq), createdAt };
      for (const listener of this.listeners) listener(clone(persisted));
      return clone(persisted);
    });
  }

  listByRun(runId: UUID, afterSeq = 0): Promise<AgentEvent[]> {
    return this.executor.run(() => {
      const rows = this.database.query(`
        select * from agent_events where run_id = ? and seq > ? order by seq asc
      `).all(runId, afterSeq) as EventRow[];
      return rows.map(eventRowToRecord);
    });
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async emit(event: Omit<AgentEvent, 'id' | 'seq' | 'createdAt'>): Promise<void> {
    await this.append(event);
  }
}

export class SqliteSnapshotStore implements SnapshotStore {
  constructor(
    private readonly database: Database,
    private readonly executor: StoreExecutor = DIRECT_EXECUTOR,
  ) {}

  save(snapshot: Omit<RunSnapshot, 'id' | 'createdAt'>): Promise<RunSnapshot> {
    return this.executor.run(() => {
      const stored: RunSnapshot = {
        ...clone(snapshot),
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
      };
      this.database.run(`
        insert into run_snapshots (id, run_id, snapshot_seq, status, created_at, record_json)
        values (?, ?, ?, ?, ?, ?)
      `, [
        stored.id,
        stored.runId,
        stored.snapshotSeq,
        stored.status,
        stored.createdAt,
        JSON.stringify(stored),
      ]);
      return clone(stored);
    });
  }

  getLatest(runId: UUID): Promise<RunSnapshot | null> {
    return this.executor.run(() => {
      const row = this.database.query(`
        select record_json from run_snapshots
        where run_id = ? order by snapshot_seq desc limit 1
      `).get(runId) as RecordRow | null;
      return row ? parseRecord<RunSnapshot>(row.record_json) : null;
    });
  }
}

export class SqlitePlanStore implements PlanStore {
  constructor(
    private readonly database: Database,
    private readonly executor: StoreExecutor = DIRECT_EXECUTOR,
  ) {}

  createPlan(plan: Omit<PlanArtifact, 'createdAt' | 'archivedAt'>): Promise<PlanArtifact> {
    return this.executor.run(() => {
      const stored: PlanArtifact = {
        ...clone(plan),
        createdAt: new Date().toISOString(),
      };
      this.database.run(`
        insert into plans (id, created_from_run_id, parent_plan_id, created_at, record_json)
        values (?, ?, ?, ?, ?)
      `, [
        stored.id,
        stored.createdFromRunId ?? null,
        stored.parentPlanId ?? null,
        stored.createdAt,
        JSON.stringify(stored),
      ]);
      return clone(stored);
    });
  }

  getPlan(planId: UUID): Promise<PlanArtifact | null> {
    return this.executor.run(() => {
      const row = this.database
        .query('select record_json from plans where id = ?')
        .get(planId) as RecordRow | null;
      return row ? parseRecord<PlanArtifact>(row.record_json) : null;
    });
  }

  listSteps(planId: UUID): Promise<PlanArtifact['steps']> {
    return this.executor.run(() => {
      const row = this.database
        .query('select record_json from plans where id = ?')
        .get(planId) as RecordRow | null;
      return row ? parseRecord<PlanArtifact>(row.record_json).steps : [];
    });
  }

  createExecution(
    execution: Omit<PlanExecution, 'createdAt' | 'updatedAt'>,
  ): Promise<PlanExecution> {
    return this.executor.run(() => {
      const now = new Date().toISOString();
      const stored: PlanExecution = {
        ...clone(execution),
        createdAt: now,
        updatedAt: now,
        completedAt: execution.completedAt ?? (
          TERMINAL_PLAN_EXECUTION_STATUSES.has(execution.status) ? now : undefined
        ),
      };
      this.database.run(`
        insert into plan_executions (
          id, plan_id, run_id, attempt, status, created_at, updated_at, record_json
        ) values (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        stored.id,
        stored.planId,
        stored.runId,
        stored.attempt,
        stored.status,
        stored.createdAt,
        stored.updatedAt,
        JSON.stringify(stored),
      ]);
      return clone(stored);
    });
  }

  getExecution(executionId: UUID): Promise<PlanExecution | null> {
    return this.executor.run(() => cloneNullable(this.readExecution(executionId)));
  }

  updateExecution(executionId: UUID, patch: Partial<PlanExecution>): Promise<PlanExecution> {
    return this.executor.run(() => {
      const current = this.readExecution(executionId);
      if (!current) throw new Error(`Plan execution ${executionId} does not exist`);
      if (patch.id && patch.id !== executionId) throw new Error('Plan execution IDs are immutable');
      if (patch.planId && patch.planId !== current.planId) throw new Error('planId is immutable');
      if (patch.runId && patch.runId !== current.runId) throw new Error('runId is immutable');

      const now = new Date().toISOString();
      const nextStatus = patch.status ?? current.status;
      const next: PlanExecution = {
        ...current,
        ...patch,
        updatedAt: now,
        completedAt: patch.completedAt ?? current.completedAt ?? (
          TERMINAL_PLAN_EXECUTION_STATUSES.has(nextStatus) ? now : undefined
        ),
      };
      const result = this.database.run(`
        update plan_executions set status = ?, updated_at = ?, record_json = ? where id = ?
      `, [next.status, next.updatedAt, JSON.stringify(next), executionId]);
      if (result.changes !== 1) throw new Error(`Plan execution ${executionId} does not exist`);
      return clone(next);
    });
  }

  private readExecution(executionId: UUID): PlanExecution | null {
    const row = this.database
      .query('select record_json from plan_executions where id = ?')
      .get(executionId) as RecordRow | null;
    return row ? parseRecord<PlanExecution>(row.record_json) : null;
  }
}

export class SqliteToolExecutionStore implements ToolExecutionStore {
  constructor(
    private readonly database: Database,
    private readonly executor: StoreExecutor = DIRECT_EXECUTOR,
  ) {}

  getByIdempotencyKey(idempotencyKey: string): Promise<ToolExecutionRecord | null> {
    return this.executor.run(() => cloneNullable(this.readRecord(idempotencyKey)));
  }

  markStarted(record: Parameters<ToolExecutionStore['markStarted']>[0]): Promise<ToolExecutionRecord> {
    return this.executor.run(() => {
      const existing = this.readRecord(record.idempotencyKey);
      if (existing) return clone(existing);

      const stored: ToolExecutionRecord = {
        ...clone(record),
        status: 'started',
        startedAt: new Date().toISOString(),
      };
      this.database.run(`
        insert into tool_executions (
          idempotency_key, run_id, step_id, tool_call_id, status,
          child_run_id, started_at, completed_at, record_json
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict (idempotency_key) do nothing
      `, toolBindings(stored));
      return clone(this.readRecord(record.idempotencyKey) ?? stored);
    });
  }

  markChildRunLinked(idempotencyKey: string, childRunId: UUID): Promise<ToolExecutionRecord> {
    return this.executor.run(() => {
      const current = this.requireRecord(idempotencyKey);
      const next: ToolExecutionRecord = { ...current, childRunId };
      this.persistRecord(next);
      return clone(next);
    });
  }

  markCompleted(idempotencyKey: string, output: JsonValue): Promise<ToolExecutionRecord> {
    return this.executor.run(() => {
      const current = this.requireRecord(idempotencyKey);
      const next: ToolExecutionRecord = {
        ...current,
        status: 'completed',
        output: clone(output),
        errorCode: undefined,
        errorMessage: undefined,
        completedAt: new Date().toISOString(),
      };
      this.persistRecord(next);
      return clone(next);
    });
  }

  markFailed(
    idempotencyKey: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<ToolExecutionRecord> {
    return this.executor.run(() => {
      const current = this.requireRecord(idempotencyKey);
      const next: ToolExecutionRecord = {
        ...current,
        status: 'failed',
        errorCode,
        errorMessage,
        completedAt: new Date().toISOString(),
      };
      this.persistRecord(next);
      return clone(next);
    });
  }

  private readRecord(idempotencyKey: string): ToolExecutionRecord | null {
    const row = this.database
      .query('select record_json from tool_executions where idempotency_key = ?')
      .get(idempotencyKey) as RecordRow | null;
    return row ? parseRecord<ToolExecutionRecord>(row.record_json) : null;
  }

  private requireRecord(idempotencyKey: string): ToolExecutionRecord {
    const record = this.readRecord(idempotencyKey);
    if (!record) throw new Error(`Tool execution ${idempotencyKey} does not exist`);
    return record;
  }

  private persistRecord(record: ToolExecutionRecord): void {
    const result = this.database.run(`
      update tool_executions set
        status = ?, child_run_id = ?, completed_at = ?, record_json = ?
      where idempotency_key = ?
    `, [
      record.status,
      record.childRunId ?? null,
      record.completedAt ?? null,
      JSON.stringify(record),
      record.idempotencyKey,
    ]);
    if (result.changes !== 1) {
      throw new Error(`Tool execution ${record.idempotencyKey} does not exist`);
    }
  }
}

export class SqliteContinuationStore implements ContinuationStore {
  constructor(
    private readonly database: Database,
    private readonly executor: StoreExecutor = DIRECT_EXECUTOR,
  ) {}

  createContinuation(
    continuation: Omit<RunContinuation, 'id' | 'createdAt'>,
  ): Promise<RunContinuation> {
    return this.executor.run(() => {
      const stored: RunContinuation = {
        ...clone(continuation),
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
      };
      this.database.run(`
        insert into run_continuations (
          id, source_run_id, continuation_run_id, created_at, record_json
        ) values (?, ?, ?, ?, ?)
      `, [
        stored.id,
        stored.sourceRunId,
        stored.continuationRunId,
        stored.createdAt,
        JSON.stringify(stored),
      ]);
      return clone(stored);
    });
  }

  listBySourceRun(sourceRunId: UUID): Promise<RunContinuation[]> {
    return this.executor.run(() => {
      const rows = this.database.query(`
        select record_json from run_continuations
        where source_run_id = ? order by created_at asc, id asc
      `).all(sourceRunId) as RecordRow[];
      return rows.map((row) => parseRecord<RunContinuation>(row.record_json));
    });
  }

  getByContinuationRun(continuationRunId: UUID): Promise<RunContinuation | null> {
    return this.executor.run(() => {
      const row = this.database.query(`
        select record_json from run_continuations where continuation_run_id = ?
      `).get(continuationRunId) as RecordRow | null;
      return row ? parseRecord<RunContinuation>(row.record_json) : null;
    });
  }
}

export interface SqliteRecoveryScannerOptions {
  now?: Date;
  staleRunMs?: number;
  limit?: number;
  includePendingInteractions?: boolean;
}

export interface SqliteRecoveryClaimOptions {
  runId: UUID;
  owner: string;
  ttlMs: number;
  now?: Date;
}

export class SqliteRecoveryScanner {
  private readonly runStore: SqliteRunStore;

  constructor(
    private readonly database: Database,
    private readonly executor: StoreExecutor = DIRECT_EXECUTOR,
  ) {
    this.runStore = new SqliteRunStore(database, executor);
  }

  scan(options: SqliteRecoveryScannerOptions = {}): Promise<RuntimeRecoveryCandidate[]> {
    return this.executor.run(() => {
      const now = options.now ?? new Date();
      const limit = normalizeNonNegativeInteger(options.limit ?? 100, 'limit');
      const staleRunMs = normalizeNonNegativeInteger(options.staleRunMs ?? 5 * 60_000, 'staleRunMs');
      const rows = this.database.query('select record_json from agent_runs').all() as RecordRow[];
      const runs = rows.map((row) => parseRecord<AgentRun>(row.record_json));
      const byId = new Map(runs.map((run) => [run.id, run]));
      const candidates: RuntimeRecoveryCandidate[] = [];

      const append = (
        reason: RecoveryScanReason,
        matches: AgentRun[],
        detail: string,
        child?: (run: AgentRun) => AgentRun | undefined,
      ): void => {
        for (const run of matches.slice(0, limit)) {
          candidates.push({ reason, run: clone(run), childRun: cloneNullable(child?.(run) ?? null) ?? undefined, detail });
        }
      };

      append(
        'expired_lease',
        runs
          .filter((run) => !isTerminalRunStatus(run.status) && run.leaseOwner && run.leaseExpiresAt && Date.parse(run.leaseExpiresAt) <= now.getTime())
          .sort((left, right) => compareRunOrder(left, right, 'leaseExpiresAt')),
        'Run lease expired before reaching a terminal status.',
      );
      append(
        'awaiting_subagent_terminal_child',
        runs
          .filter((run) => run.status === 'awaiting_subagent' && Boolean(run.currentChildRunId && isTerminalRunStatus(byId.get(run.currentChildRunId)?.status as RunStatus)))
          .sort(compareUpdatedRunOrder),
        'Parent is awaiting a child run that is already terminal.',
        (run) => run.currentChildRunId ? byId.get(run.currentChildRunId) : undefined,
      );
      append(
        'awaiting_subagent_missing_child',
        runs
          .filter((run) => run.status === 'awaiting_subagent' && !run.currentChildRunId)
          .sort(compareUpdatedRunOrder),
        'Parent is awaiting a sub-agent but has no current child run link.',
      );
      append(
        'awaiting_subagent_linkage_mismatch',
        runs
          .filter((run) => {
            const child = run.currentChildRunId ? byId.get(run.currentChildRunId) : undefined;
            return run.status === 'awaiting_subagent' && Boolean(child && child.parentRunId !== run.id);
          })
          .sort(compareUpdatedRunOrder),
        'Parent current child does not point back to the parent run.',
        (run) => run.currentChildRunId ? byId.get(run.currentChildRunId) : undefined,
      );
      const staleBefore = now.getTime() - staleRunMs;
      append(
        'stale_running',
        runs
          .filter((run) => run.status === 'running' && (!run.heartbeatAt || Date.parse(run.heartbeatAt) <= staleBefore))
          .sort(compareUpdatedRunOrder),
        'Run has been running without a recent heartbeat.',
      );
      append(
        'orphan_child',
        runs
          .filter((run) => Boolean(run.parentRunId && !byId.has(run.parentRunId)))
          .sort(compareUpdatedRunOrder),
        'Child run references a missing parent run.',
      );

      if (options.includePendingInteractions) {
        append(
          'pending_interaction',
          runs
            .filter((run) => run.status === 'awaiting_approval' || run.status === 'clarification_requested')
            .sort(compareUpdatedRunOrder),
          'Run is waiting for approval or clarification and may need session reattachment.',
        );
      }

      return candidates;
    });
  }

  claim(options: SqliteRecoveryClaimOptions): Promise<boolean> {
    return this.runStore.tryAcquireLease({
      runId: options.runId,
      owner: options.owner,
      ttlMs: options.ttlMs,
      now: options.now ?? new Date(),
    });
  }
}

export class SqliteRuntimeMaintenanceStore implements RuntimeMaintenanceStore {
  constructor(
    private readonly database: Database,
    private readonly executor: StoreExecutor = DIRECT_EXECUTOR,
  ) {}

  previewDeletion(target: RuntimeDeletionTarget): Promise<RuntimeDeletionPreview> {
    return this.executor.run(() => this.inImmediateTransaction(() => previewRuntimeDeletion(this.database, target)));
  }

  deleteHistory(target: RuntimeDeletionTarget): Promise<RuntimeDeletionPreview> {
    return this.executor.run(() => this.inImmediateTransaction(() => {
      const preview = previewRuntimeDeletion(this.database, target);
      if (preview.runIds.length === 0) return preview;

      const runs = this.database
        .query(`select id, status from agent_runs where id in (${placeholders(preview.runIds.length)})`)
        .all(...preview.runIds) as Array<{ id: string; status: RunStatus }>;
      const occupied = runs.filter((run) => !DELETABLE_RUN_STATUSES.has(run.status));
      if (occupied.length > 0) {
        throw new Error(`Cannot delete history while runs occupy execution slots: ${occupied.map((run) => run.id).sort().join(', ')}`);
      }

      if (preview.ownedPlanIds.length > 0) {
        this.database.run(
          `delete from plans where id in (${placeholders(preview.ownedPlanIds.length)})`,
          preview.ownedPlanIds,
        );
      }
      this.database.run(
        `update agent_runs set parent_run_id = null, current_child_run_id = null where id in (${placeholders(preview.runIds.length)})`,
        preview.runIds,
      );
      const childRunIds = preview.runIds.filter((runId) => !preview.rootRunIds.includes(runId));
      if (childRunIds.length > 0) {
        this.database.run(
          `delete from agent_runs where id in (${placeholders(childRunIds.length)})`,
          childRunIds,
        );
      }
      if (preview.rootRunIds.length > 0) {
        this.database.run(
          `delete from agent_runs where id in (${placeholders(preview.rootRunIds.length)})`,
          preview.rootRunIds,
        );
      }
      const foreignKeyFailures = this.database.query('pragma foreign_key_check').all();
      if (foreignKeyFailures.length > 0) throw new Error('Runtime deletion failed foreign key verification.');
      return preview;
    }));
  }

  private inImmediateTransaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.database.inTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

export class SqliteRuntimeStoreBundle implements RuntimeTransactionStore {
  readonly runStore: SqliteRunStore;
  readonly eventStore: SqliteEventStore;
  readonly snapshotStore: SqliteSnapshotStore;
  readonly planStore: SqlitePlanStore;
  readonly continuationStore: SqliteContinuationStore;
  readonly toolExecutionStore: SqliteToolExecutionStore;
  readonly recoveryScanner: SqliteRecoveryScanner;
  readonly maintenanceStore: SqliteRuntimeMaintenanceStore;
  private readonly executor = new SerializedStoreExecutor();

  constructor(
    private readonly database: Database,
    options: SqliteRuntimeOptions = {},
  ) {
    configureSqliteDatabase(database, options.busyTimeoutMs);
    if (options.migrate ?? true) runSqliteRuntimeMigrations(database);
    this.runStore = new SqliteRunStore(database, this.executor);
    this.eventStore = new SqliteEventStore(database, this.executor);
    this.snapshotStore = new SqliteSnapshotStore(database, this.executor);
    this.planStore = new SqlitePlanStore(database, this.executor);
    this.continuationStore = new SqliteContinuationStore(database, this.executor);
    this.toolExecutionStore = new SqliteToolExecutionStore(database, this.executor);
    this.recoveryScanner = new SqliteRecoveryScanner(database, this.executor);
    this.maintenanceStore = new SqliteRuntimeMaintenanceStore(database, this.executor);
  }

  runInTransaction<T>(operation: (stores: RuntimeStores) => Promise<T>): Promise<T> {
    return this.executor.run(async () => {
      this.database.exec('BEGIN IMMEDIATE');
      try {
        const result = await operation(createTransactionStores(this.database));
        this.database.exec('COMMIT');
        return result;
      } catch (error) {
        if (this.database.inTransaction) this.database.exec('ROLLBACK');
        throw error;
      }
    });
  }

  close(): Promise<void> {
    return this.executor.close(() => this.database.close(false));
  }
}

export function createSqliteRuntimeStores(options: {
  database: Database;
  busyTimeoutMs?: number;
  migrate?: boolean;
}): SqliteRuntimeStoreBundle {
  return new SqliteRuntimeStoreBundle(options.database, options);
}

export function openSqliteRuntimeStores(options: OpenSqliteRuntimeOptions): SqliteRuntimeStoreBundle {
  const database = new Database(options.path, { create: true, strict: true });
  try {
    return new SqliteRuntimeStoreBundle(database, options);
  } catch (error) {
    database.close(false);
    throw error;
  }
}

function createTransactionStores(database: Database): RuntimeStores {
  return {
    runStore: new SqliteRunStore(database),
    eventStore: new SqliteEventStore(database),
    snapshotStore: new SqliteSnapshotStore(database),
    planStore: new SqlitePlanStore(database),
    continuationStore: new SqliteContinuationStore(database),
    toolExecutionStore: new SqliteToolExecutionStore(database),
  };
}

function previewRuntimeDeletion(database: Database, target: RuntimeDeletionTarget): RuntimeDeletionPreview {
  const rootRunIds = target.kind === 'root-run'
    ? database.query('select id from agent_runs where id = ? and root_run_id = id').all(target.rootRunId).map((row) => (row as { id: string }).id)
    : database.query('select distinct root_run_id as id from agent_runs where session_id = ? order by root_run_id').all(target.sessionId).map((row) => (row as { id: string }).id);
  if (rootRunIds.length === 0) return { target, runIds: [], rootRunIds: [], ownedPlanIds: [], preservedPlanIds: [] };
  const rows = database.query(
    `select id, root_run_id from agent_runs where root_run_id in (${placeholders(rootRunIds.length)}) order by created_at, id`,
  ).all(...rootRunIds);
  const runs = rows as Array<{ id: string; root_run_id: string }>;
  const roots = new Set(rootRunIds);
  const runIds = runs.filter((run) => !roots.has(run.id)).map((run) => run.id)
    .concat(runs.filter((run) => roots.has(run.id)).map((run) => run.id));

  const candidatePlans = database.query(
    `select id from plans where created_from_run_id in (${placeholders(runIds.length)}) order by id`,
  ).all(...runIds) as Array<{ id: string }>;
  const ownedPlanIds: string[] = [];
  const preservedPlanIds: string[] = [];
  for (const { id } of candidatePlans) {
    const unrelated = database.query(
      `select exists(select 1 from plan_executions where plan_id = ? and run_id not in (${placeholders(runIds.length)})) as value`,
    ).get(id, ...runIds) as { value: number };
    (unrelated.value ? preservedPlanIds : ownedPlanIds).push(id);
  }
  return { target, runIds, rootRunIds, ownedPlanIds, preservedPlanIds };
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

function configureSqliteDatabase(database: Database, busyTimeoutMs = 5_000): void {
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60_000) {
    throw new Error('SQLite busy timeout must be an integer between 0 and 60000 milliseconds');
  }
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
}

function runBindings(run: AgentRun): Array<string | number | null> {
  return [
    run.id,
    run.sessionId ?? null,
    run.rootRunId,
    run.parentRunId ?? null,
    run.currentChildRunId ?? null,
    run.status,
    run.leaseOwner ?? null,
    run.leaseExpiresAt ?? null,
    run.heartbeatAt ?? null,
    run.version,
    run.createdAt,
    run.updatedAt,
    JSON.stringify(run),
  ];
}

function toolBindings(record: ToolExecutionRecord): Array<string | null> {
  return [
    record.idempotencyKey,
    record.runId,
    record.stepId,
    record.toolCallId,
    record.status,
    record.childRunId ?? null,
    record.startedAt,
    record.completedAt ?? null,
    JSON.stringify(record),
  ];
}

function eventRowToRecord(row: EventRow): AgentEvent {
  return {
    id: row.id,
    runId: row.run_id,
    planExecutionId: row.plan_execution_id ?? undefined,
    seq: Number(row.seq),
    stepId: row.step_id ?? undefined,
    toolCallId: row.tool_call_id ?? undefined,
    type: row.event_type as AgentEvent['type'],
    schemaVersion: row.schema_version,
    payload: parseRecord<JsonValue>(row.payload_json),
    createdAt: row.created_at,
  };
}

function emptyUsage(): UsageSummary {
  return { promptTokens: 0, completionTokens: 0, estimatedCostUSD: 0 };
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

function assertMutableRunPatch(runId: UUID, current: AgentRun, patch: Partial<AgentRun>): void {
  if (patch.id && patch.id !== runId) throw new Error('Run IDs are immutable');
  if (patch.sessionId && patch.sessionId !== current.sessionId) throw new Error('sessionId is immutable');
  if (patch.rootRunId && patch.rootRunId !== current.rootRunId) throw new Error('rootRunId is immutable');
  if (patch.parentRunId && patch.parentRunId !== current.parentRunId) throw new Error('parentRunId is immutable');
  if (patch.parentStepId && patch.parentStepId !== current.parentStepId) throw new Error('parentStepId is immutable');
  if (patch.delegateName && patch.delegateName !== current.delegateName) throw new Error('delegateName is immutable');
  if (patch.delegationDepth !== undefined && patch.delegationDepth !== current.delegationDepth) {
    throw new Error('delegationDepth is immutable');
  }
  if (patch.modelProvider && patch.modelProvider !== current.modelProvider) throw new Error('modelProvider is immutable');
  if (patch.modelName && patch.modelName !== current.modelName) throw new Error('modelName is immutable');
  if (patch.modelParameters && JSON.stringify(patch.modelParameters) !== JSON.stringify(current.modelParameters)) {
    throw new Error('modelParameters is immutable');
  }
  if (
    Object.prototype.hasOwnProperty.call(patch, 'executionContext') &&
    JSON.stringify(patch.executionContext) !== JSON.stringify(current.executionContext)
  ) {
    throw new Error('executionContext is immutable');
  }
}

function compareUpdatedRunOrder(left: AgentRun, right: AgentRun): number {
  return left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id);
}

function compareRunOrder(
  left: AgentRun,
  right: AgentRun,
  field: 'leaseExpiresAt',
): number {
  return (left[field] ?? '').localeCompare(right[field] ?? '') || compareUpdatedRunOrder(left, right);
}

function normalizeNonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function parseRecord<T>(value: string): T {
  return JSON.parse(value) as T;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneNullable<T>(value: T | null): T | null {
  return value === null ? null : clone(value);
}
