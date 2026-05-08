import type {
  AgentEvent,
  AgentRun,
  ContinuationStore,
  ContinuationStrategy,
  EventSink,
  EventStore,
  FailureClass,
  JsonValue,
  PlanArtifact,
  PlanExecution,
  PlanExecutionStatus,
  PlanStatus,
  PlanStep,
  RecoveryScanReason,
  PlanStore,
  RunContinuation,
  RunSnapshot,
  RunStatus,
  RunStore,
  RuntimeRecoveryCandidate,
  RuntimeStores,
  RuntimeTransactionStore,
  SnapshotStore,
  ToolExecutionRecord,
  ToolExecutionStatus,
  ToolExecutionStore,
  UsageSummary,
  UUID,
} from './types.js';

export interface PostgresQueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface PostgresClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<PostgresQueryResult<T>>;
}

export interface PostgresTransactionClient extends PostgresClient {
  release(): void;
}

export interface PostgresPoolClient extends PostgresClient {
  connect(): Promise<PostgresTransactionClient>;
}

interface AgentRunRow {
  id: string;
  root_run_id: string;
  parent_run_id: string | null;
  parent_step_id: string | null;
  delegate_name: string | null;
  delegation_depth: number;
  current_child_run_id: string | null;
  goal: string;
  input: JsonValue | null;
  context: Record<string, JsonValue> | null;
  model_provider: string | null;
  model_name: string | null;
  model_parameters: Record<string, JsonValue> | null;
  metadata: Record<string, JsonValue> | null;
  status: string;
  current_step_id: string | null;
  current_plan_id: string | null;
  current_plan_execution_id: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  version: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_reasoning_tokens: number | null;
  estimated_cost_usd: string | number;
  result: JsonValue | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface AgentEventRow {
  id: string | number;
  run_id: string;
  plan_execution_id: string | null;
  seq: string | number;
  step_id: string | null;
  tool_call_id: string | null;
  event_type: string;
  schema_version: number;
  payload: JsonValue;
  created_at: string;
}

interface RunSnapshotRow {
  id: string;
  run_id: string;
  snapshot_seq: string | number;
  status: string;
  current_step_id: string | null;
  current_plan_id: string | null;
  current_plan_execution_id: string | null;
  summary: JsonValue;
  state: JsonValue;
  created_at: string;
}

interface PlanRow {
  id: string;
  version: number;
  status: string;
  goal: string;
  summary: string;
  input_schema: Record<string, unknown> | null;
  success_criteria: JsonValue | null;
  toolset_hash: string;
  planner_model: string | null;
  planner_prompt_version: string | null;
  created_from_run_id: string | null;
  parent_plan_id: string | null;
  metadata: Record<string, JsonValue> | null;
  created_at: string;
  archived_at: string | null;
}

interface PlanStepRow {
  step_key: string;
  title: string;
  tool_name: string;
  input_template: PlanStep['inputTemplate'];
  output_key: string | null;
  preconditions: PlanStep['preconditions'] | null;
  failure_policy: string;
  requires_approval: boolean;
}

interface PlanExecutionRow {
  id: string;
  plan_id: string;
  run_id: string;
  attempt: number;
  status: string;
  input: JsonValue | null;
  context: Record<string, JsonValue> | null;
  current_step_id: string | null;
  current_step_index: number | null;
  output: JsonValue | null;
  replan_reason: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface ToolExecutionRow {
  run_id: string;
  step_id: string;
  tool_call_id: string;
  tool_name: string;
  idempotency_key: string;
  status: string;
  input_hash: string;
  input: JsonValue | null;
  child_run_id: string | null;
  output: JsonValue | null;
  error_code: string | null;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
}

interface RunContinuationRow {
  id: string;
  source_run_id: string;
  continuation_run_id: string;
  strategy: string;
  failure_class: string;
  reason: string;
  source_snapshot_id: string | null;
  source_snapshot_seq: string | number | null;
  source_event_seq: string | number | null;
  source_step_id: string | null;
  next_step_id: string | null;
  provider: string | null;
  model: string | null;
  metadata: Record<string, JsonValue> | null;
  created_at: string;
}

interface RecoveryCandidateRow extends AgentRunRow {
  recovery_reason: string;
  recovery_detail: string | null;
  child_run: AgentRunRow | null;
}

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

export class PostgresOptimisticConcurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PostgresOptimisticConcurrencyError';
  }
}

export const POSTGRES_RUNTIME_RUN_QUERIES = {
  create: `
    INSERT INTO agent_runs (
      id, root_run_id, parent_run_id, parent_step_id, delegate_name,
      delegation_depth, current_child_run_id, goal, input, context,
      model_provider, model_name, model_parameters, metadata,
      status, version, total_prompt_tokens, total_completion_tokens,
      total_reasoning_tokens, estimated_cost_usd, created_at, updated_at,
      completed_at
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9, $10,
      $11, $12, $13, $14,
      $15, 0, 0, 0,
      0, 0, $16, $17,
      $18
    )
    RETURNING *
  `,
  get: `SELECT * FROM agent_runs WHERE id = $1`,
  update: `
    UPDATE agent_runs SET
      current_child_run_id = $2,
      status = $3,
      current_step_id = $4,
      current_plan_id = $5,
      current_plan_execution_id = $6,
      lease_owner = $7,
      lease_expires_at = $8,
      heartbeat_at = $9,
      version = version + 1,
      total_prompt_tokens = $10,
      total_completion_tokens = $11,
      total_reasoning_tokens = $12,
      estimated_cost_usd = $13,
      result = $14,
      error_code = $15,
      error_message = $16,
      metadata = $17,
      updated_at = $18,
      completed_at = $19
    WHERE id = $1 AND version = $20
    RETURNING *
  `,
  acquireLease: `
    UPDATE agent_runs SET
      lease_owner = $2,
      lease_expires_at = $3,
      heartbeat_at = $4,
      version = version + 1,
      updated_at = $4
    WHERE id = $1
      AND (lease_owner IS NULL OR lease_owner = $2 OR lease_expires_at IS NULL OR lease_expires_at <= $4)
    RETURNING *
  `,
  heartbeatLease: `
    UPDATE agent_runs SET
      lease_expires_at = $3,
      heartbeat_at = $4,
      version = version + 1,
      updated_at = $4
    WHERE id = $1 AND lease_owner = $2
    RETURNING *
  `,
  releaseLease: `
    UPDATE agent_runs SET
      lease_owner = NULL,
      lease_expires_at = NULL,
      heartbeat_at = NULL,
      version = version + 1,
      updated_at = $3
    WHERE id = $1 AND (lease_owner IS NULL OR lease_owner = $2)
    RETURNING *
  `,
} as const;

export const POSTGRES_RUNTIME_EVENT_QUERIES = {
  append: `
    INSERT INTO agent_events (
      run_id, plan_execution_id, seq, step_id, tool_call_id, event_type, schema_version, payload
    )
    SELECT
      $1, $2, COALESCE(MAX(seq), 0) + 1, $3, $4, $5, $6, $7
    FROM agent_events
    WHERE run_id = $1
    RETURNING *
  `,
  listByRun: `
    SELECT * FROM agent_events
    WHERE run_id = $1 AND seq > $2
    ORDER BY seq ASC
  `,
} as const;

export const POSTGRES_RUNTIME_SNAPSHOT_QUERIES = {
  save: `
    INSERT INTO run_snapshots (
      run_id, snapshot_seq, status, current_step_id, current_plan_id,
      current_plan_execution_id, summary, state
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8
    )
    RETURNING *
  `,
  getLatest: `
    SELECT * FROM run_snapshots
    WHERE run_id = $1
    ORDER BY snapshot_seq DESC
    LIMIT 1
  `,
} as const;

export const POSTGRES_RUNTIME_PLAN_QUERIES = {
  createPlan: `
    INSERT INTO plans (
      id, version, status, goal, summary, input_schema, success_criteria,
      toolset_hash, planner_model, planner_prompt_version, created_from_run_id,
      parent_plan_id, metadata, created_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11,
      $12, $13, $14
    )
    RETURNING *
  `,
  createStep: `
    INSERT INTO plan_steps (
      plan_id, step_index, step_key, title, tool_name, input_template,
      output_key, preconditions, failure_policy, requires_approval
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10
    )
    RETURNING *
  `,
  getPlan: `SELECT * FROM plans WHERE id = $1`,
  listSteps: `
    SELECT * FROM plan_steps
    WHERE plan_id = $1
    ORDER BY step_index ASC
  `,
  createExecution: `
    INSERT INTO plan_executions (
      id, plan_id, run_id, attempt, status, input, context, current_step_id,
      current_step_index, output, replan_reason, created_at, updated_at,
      completed_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8,
      $9, $10, $11, $12, $13,
      $14
    )
    RETURNING *
  `,
  getExecution: `SELECT * FROM plan_executions WHERE id = $1`,
  updateExecution: `
    UPDATE plan_executions SET
      status = $2,
      input = $3,
      context = $4,
      current_step_id = $5,
      current_step_index = $6,
      output = $7,
      replan_reason = $8,
      updated_at = $9,
      completed_at = $10
    WHERE id = $1
    RETURNING *
  `,
} as const;

export const POSTGRES_RUNTIME_TOOL_EXECUTION_QUERIES = {
  getByIdempotencyKey: `SELECT * FROM tool_executions WHERE idempotency_key = $1`,
  markStarted: `
    INSERT INTO tool_executions (
      run_id, step_id, tool_call_id, tool_name, idempotency_key,
      status, input_hash, input, started_at
    ) VALUES (
      $1, $2, $3, $4, $5,
      'started', $6, $7, $8
    )
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING *
  `,
  markChildRunLinked: `
    UPDATE tool_executions SET
      child_run_id = $2
    WHERE idempotency_key = $1
    RETURNING *
  `,
  markCompleted: `
    UPDATE tool_executions SET
      status = 'completed',
      output = $2,
      error_code = NULL,
      error_message = NULL,
      completed_at = $3
    WHERE idempotency_key = $1
    RETURNING *
  `,
  markFailed: `
    UPDATE tool_executions SET
      status = 'failed',
      error_code = $2,
      error_message = $3,
      completed_at = $4
    WHERE idempotency_key = $1
    RETURNING *
  `,
} as const;

export const POSTGRES_RUNTIME_CONTINUATION_QUERIES = {
  create: `
    INSERT INTO run_continuations (
      source_run_id, continuation_run_id, strategy, failure_class, reason,
      source_snapshot_id, source_snapshot_seq, source_event_seq, source_step_id,
      next_step_id, provider, model, metadata
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9,
      $10, $11, $12, $13
    )
    RETURNING *
  `,
  listBySourceRun: `
    SELECT * FROM run_continuations
    WHERE source_run_id = $1
    ORDER BY created_at ASC, id ASC
  `,
  getByContinuationRun: `SELECT * FROM run_continuations WHERE continuation_run_id = $1`,
} as const;

export const POSTGRES_RUNTIME_RECOVERY_QUERIES = {
  expiredLeases: `
    SELECT r.*, 'expired_lease' AS recovery_reason,
      'Run lease expired before reaching a terminal status.' AS recovery_detail,
      NULL::jsonb AS child_run
    FROM agent_runs r
    WHERE r.status <> ALL($2::text[])
      AND r.lease_owner IS NOT NULL
      AND r.lease_expires_at IS NOT NULL
      AND r.lease_expires_at <= $1
    ORDER BY r.lease_expires_at ASC, r.updated_at ASC, r.id ASC
    LIMIT $3
  `,
  awaitingSubagentTerminalChild: `
    SELECT parent.*, 'awaiting_subagent_terminal_child' AS recovery_reason,
      'Parent is awaiting a child run that is already terminal.' AS recovery_detail,
      to_jsonb(child_run.*) AS child_run
    FROM agent_runs parent
    JOIN agent_runs child_run ON child_run.id = parent.current_child_run_id
    WHERE parent.status = 'awaiting_subagent'
      AND child_run.status = ANY($1::text[])
    ORDER BY parent.updated_at ASC, parent.id ASC
    LIMIT $2
  `,
  awaitingSubagentMissingChild: `
    SELECT parent.*, 'awaiting_subagent_missing_child' AS recovery_reason,
      'Parent is awaiting a sub-agent but has no current child run link.' AS recovery_detail,
      NULL::jsonb AS child_run
    FROM agent_runs parent
    WHERE parent.status = 'awaiting_subagent'
      AND parent.current_child_run_id IS NULL
    ORDER BY parent.updated_at ASC, parent.id ASC
    LIMIT $1
  `,
  awaitingSubagentLinkageMismatch: `
    SELECT parent.*, 'awaiting_subagent_linkage_mismatch' AS recovery_reason,
      'Parent current child does not point back to the parent run.' AS recovery_detail,
      to_jsonb(child_run.*) AS child_run
    FROM agent_runs parent
    JOIN agent_runs child_run ON child_run.id = parent.current_child_run_id
    WHERE parent.status = 'awaiting_subagent'
      AND child_run.parent_run_id IS DISTINCT FROM parent.id
    ORDER BY parent.updated_at ASC, parent.id ASC
    LIMIT $1
  `,
  staleRunning: `
    SELECT r.*, 'stale_running' AS recovery_reason,
      'Run has been running without a recent heartbeat.' AS recovery_detail,
      NULL::jsonb AS child_run
    FROM agent_runs r
    WHERE r.status = 'running'
      AND (r.heartbeat_at IS NULL OR r.heartbeat_at <= $1)
    ORDER BY r.updated_at ASC, r.id ASC
    LIMIT $2
  `,
  pendingInteractions: `
    SELECT r.*, 'pending_interaction' AS recovery_reason,
      'Run is waiting for approval or clarification and may need session reattachment.' AS recovery_detail,
      NULL::jsonb AS child_run
    FROM agent_runs r
    WHERE r.status = ANY($1::text[])
    ORDER BY r.updated_at ASC, r.id ASC
    LIMIT $2
  `,
  orphanChildren: `
    SELECT child_run.*, 'orphan_child' AS recovery_reason,
      'Child run references a missing parent run.' AS recovery_detail,
      NULL::jsonb AS child_run
    FROM agent_runs child_run
    LEFT JOIN agent_runs parent ON parent.id = child_run.parent_run_id
    WHERE child_run.parent_run_id IS NOT NULL
      AND parent.id IS NULL
    ORDER BY child_run.updated_at ASC, child_run.id ASC
    LIMIT $1
  `,
} as const;

export class PostgresRunStore implements RunStore {
  constructor(private readonly client: PostgresClient) {}

  async createRun(run: Parameters<RunStore['createRun']>[0]): Promise<AgentRun> {
    const id = run.id ?? crypto.randomUUID();
    const parent = run.parentRunId ? await this.getRun(run.parentRunId) : null;
    if (run.parentRunId && !parent) {
      throw new Error(`Parent run ${run.parentRunId} does not exist`);
    }

    if ((run.parentStepId || run.delegateName) && !run.parentRunId) {
      throw new Error('parentStepId and delegateName require parentRunId');
    }

    const rootRunId = run.rootRunId ?? parent?.rootRunId ?? id;
    if (rootRunId !== id && !parent && !(await this.getRun(rootRunId))) {
      throw new Error(`Root run ${rootRunId} does not exist`);
    }

    const delegationDepth = run.delegationDepth ?? (parent ? parent.delegationDepth + 1 : 0);
    if (delegationDepth < 0) {
      throw new Error('delegationDepth must be >= 0');
    }

    const now = new Date().toISOString();
    const completedAt = isTerminalRunStatus(run.status) ? now : null;
    const result = await this.client.query<AgentRunRow>(POSTGRES_RUNTIME_RUN_QUERIES.create, [
      id,
      rootRunId,
      run.parentRunId ?? null,
      run.parentStepId ?? null,
      run.delegateName ?? null,
      delegationDepth,
      run.currentChildRunId ?? null,
      run.goal,
      jsonbParam(run.input),
      jsonbParam(run.context),
      run.modelProvider ?? null,
      run.modelName ?? null,
      jsonbParam(run.modelParameters),
      jsonbParam(run.metadata),
      run.status,
      now,
      now,
      completedAt,
    ]);

    const row = firstRow(result, `Failed to create run ${id}`);
    return runRowToRecord(row);
  }

  async getRun(runId: UUID): Promise<AgentRun | null> {
    const result = await this.client.query<AgentRunRow>(POSTGRES_RUNTIME_RUN_QUERIES.get, [runId]);
    return result.rows[0] ? runRowToRecord(result.rows[0]) : null;
  }

  async updateRun(runId: UUID, patch: Partial<AgentRun>, expectedVersion?: number): Promise<AgentRun> {
    const current = await this.getRun(runId);
    if (!current) {
      throw new Error(`Run ${runId} does not exist`);
    }

    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new PostgresOptimisticConcurrencyError(
        `Run ${runId} version mismatch: expected ${expectedVersion}, got ${current.version}`,
      );
    }

    assertMutableRunPatch(runId, current, patch);

    const nextStatus = patch.status ?? current.status;
    const now = new Date().toISOString();
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

    const result = await this.client.query<AgentRunRow>(POSTGRES_RUNTIME_RUN_QUERIES.update, [
      runId,
      next.currentChildRunId ?? null,
      next.status,
      next.currentStepId ?? null,
      next.currentPlanId ?? null,
      next.currentPlanExecutionId ?? null,
      next.leaseOwner ?? null,
      next.leaseExpiresAt ?? null,
      next.heartbeatAt ?? null,
      next.usage.promptTokens,
      next.usage.completionTokens,
      next.usage.reasoningTokens ?? 0,
      next.usage.estimatedCostUSD,
      jsonbParam(next.result),
      next.errorCode ?? null,
      next.errorMessage ?? null,
      jsonbParam(next.metadata),
      next.updatedAt,
      next.completedAt ?? null,
      current.version,
    ]);

    const row = result.rows[0];
    if (!row) {
      throw new PostgresOptimisticConcurrencyError(`Run ${runId} version mismatch while updating`);
    }

    return runRowToRecord(row);
  }

  async tryAcquireLease(params: { runId: UUID; owner: string; ttlMs: number; now: Date }): Promise<boolean> {
    const now = params.now.toISOString();
    const leaseExpiresAt = new Date(params.now.getTime() + params.ttlMs).toISOString();
    const result = await this.client.query<AgentRunRow>(POSTGRES_RUNTIME_RUN_QUERIES.acquireLease, [
      params.runId,
      params.owner,
      leaseExpiresAt,
      now,
    ]);

    return result.rowCount > 0;
  }

  async heartbeatLease(params: { runId: UUID; owner: string; ttlMs: number; now: Date }): Promise<void> {
    const now = params.now.toISOString();
    const leaseExpiresAt = new Date(params.now.getTime() + params.ttlMs).toISOString();
    const result = await this.client.query<AgentRunRow>(POSTGRES_RUNTIME_RUN_QUERIES.heartbeatLease, [
      params.runId,
      params.owner,
      leaseExpiresAt,
      now,
    ]);

    if (result.rowCount === 0) {
      throw new Error(`Run ${params.runId} lease is not owned by ${params.owner}`);
    }
  }

  async releaseLease(runId: UUID, owner: string): Promise<void> {
    const result = await this.client.query<AgentRunRow>(POSTGRES_RUNTIME_RUN_QUERIES.releaseLease, [
      runId,
      owner,
      new Date().toISOString(),
    ]);

    if (result.rowCount === 0) {
      throw new Error(`Run ${runId} lease is not owned by ${owner}`);
    }
  }
}

export class PostgresEventStore implements EventStore, EventSink {
  private readonly listeners = new Set<(event: AgentEvent) => void>();

  constructor(private readonly client: PostgresClient) {}

  async append(event: Omit<AgentEvent, 'id' | 'seq' | 'createdAt'>): Promise<AgentEvent> {
    const result = await this.client.query<AgentEventRow>(POSTGRES_RUNTIME_EVENT_QUERIES.append, [
      event.runId,
      event.planExecutionId ?? null,
      event.stepId ?? null,
      event.toolCallId ?? null,
      event.type,
      event.schemaVersion,
      jsonbParam(event.payload),
    ]);
    const persistedEvent = eventRowToRecord(firstRow(result, `Failed to append event for run ${event.runId}`));
    for (const listener of this.listeners) {
      listener(structuredClone(persistedEvent));
    }

    return persistedEvent;
  }

  async listByRun(runId: UUID, afterSeq = 0): Promise<AgentEvent[]> {
    const result = await this.client.query<AgentEventRow>(POSTGRES_RUNTIME_EVENT_QUERIES.listByRun, [runId, afterSeq]);
    return result.rows.map(eventRowToRecord);
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async emit(event: Omit<AgentEvent, 'id' | 'seq' | 'createdAt'>): Promise<void> {
    await this.append(event);
  }
}

export class PostgresSnapshotStore implements SnapshotStore {
  constructor(private readonly client: PostgresClient) {}

  async save(snapshot: Omit<RunSnapshot, 'id' | 'createdAt'>): Promise<RunSnapshot> {
    const result = await this.client.query<RunSnapshotRow>(POSTGRES_RUNTIME_SNAPSHOT_QUERIES.save, [
      snapshot.runId,
      snapshot.snapshotSeq,
      snapshot.status,
      snapshot.currentStepId ?? null,
      snapshot.currentPlanId ?? null,
      snapshot.currentPlanExecutionId ?? null,
      jsonbParam(snapshot.summary),
      jsonbParam(snapshot.state),
    ]);

    return snapshotRowToRecord(firstRow(result, `Failed to save snapshot ${snapshot.runId}@${snapshot.snapshotSeq}`));
  }

  async getLatest(runId: UUID): Promise<RunSnapshot | null> {
    const result = await this.client.query<RunSnapshotRow>(POSTGRES_RUNTIME_SNAPSHOT_QUERIES.getLatest, [runId]);
    return result.rows[0] ? snapshotRowToRecord(result.rows[0]) : null;
  }
}

export class PostgresPlanStore implements PlanStore {
  constructor(private readonly client: PostgresClient) {}

  async createPlan(plan: Omit<PlanArtifact, 'createdAt' | 'archivedAt'>): Promise<PlanArtifact> {
    const now = new Date().toISOString();
    const result = await this.client.query<PlanRow>(POSTGRES_RUNTIME_PLAN_QUERIES.createPlan, [
      plan.id,
      plan.version,
      plan.status,
      plan.goal,
      plan.summary,
      jsonbParam(plan.inputSchema),
      jsonbParam(plan.successCriteria),
      plan.toolsetHash,
      plan.plannerModel ?? null,
      plan.plannerPromptVersion ?? null,
      plan.createdFromRunId ?? null,
      plan.parentPlanId ?? null,
      jsonbParam(plan.metadata),
      now,
    ]);
    const createdPlan = planRowToRecord(firstRow(result, `Failed to create plan ${plan.id}`), []);

    const steps: PlanStep[] = [];
    for (let index = 0; index < plan.steps.length; index += 1) {
      const step = plan.steps[index];
      if (!step) {
        continue;
      }

      const stepResult = await this.client.query<PlanStepRow>(POSTGRES_RUNTIME_PLAN_QUERIES.createStep, [
        plan.id,
        index,
        step.id,
        step.title,
        step.toolName,
        jsonbParam(step.inputTemplate),
        step.outputKey ?? null,
        jsonbParam(step.preconditions ?? []),
        step.onFailure,
        step.requiresApproval ?? false,
      ]);
      steps.push(stepRowToRecord(firstRow(stepResult, `Failed to create plan step ${step.id}`)));
    }

    return {
      ...createdPlan,
      steps,
    };
  }

  async getPlan(planId: UUID): Promise<PlanArtifact | null> {
    const result = await this.client.query<PlanRow>(POSTGRES_RUNTIME_PLAN_QUERIES.getPlan, [planId]);
    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return planRowToRecord(row, await this.listSteps(planId));
  }

  async listSteps(planId: UUID): Promise<PlanStep[]> {
    const result = await this.client.query<PlanStepRow>(POSTGRES_RUNTIME_PLAN_QUERIES.listSteps, [planId]);
    return result.rows.map(stepRowToRecord);
  }

  async createExecution(execution: Omit<PlanExecution, 'createdAt' | 'updatedAt'>): Promise<PlanExecution> {
    const now = new Date().toISOString();
    const completedAt = TERMINAL_PLAN_EXECUTION_STATUSES.has(execution.status) ? now : null;
    const result = await this.client.query<PlanExecutionRow>(POSTGRES_RUNTIME_PLAN_QUERIES.createExecution, [
      execution.id,
      execution.planId,
      execution.runId,
      execution.attempt,
      execution.status,
      jsonbParam(execution.input),
      jsonbParam(execution.context),
      execution.currentStepId ?? null,
      execution.currentStepIndex ?? null,
      jsonbParam(execution.output),
      execution.replanReason ?? null,
      now,
      now,
      execution.completedAt ?? completedAt,
    ]);

    return executionRowToRecord(firstRow(result, `Failed to create plan execution ${execution.id}`));
  }

  async getExecution(executionId: UUID): Promise<PlanExecution | null> {
    const result = await this.client.query<PlanExecutionRow>(POSTGRES_RUNTIME_PLAN_QUERIES.getExecution, [executionId]);
    return result.rows[0] ? executionRowToRecord(result.rows[0]) : null;
  }

  async updateExecution(executionId: UUID, patch: Partial<PlanExecution>): Promise<PlanExecution> {
    const current = await this.getExecution(executionId);
    if (!current) {
      throw new Error(`Plan execution ${executionId} does not exist`);
    }

    if (patch.id && patch.id !== executionId) {
      throw new Error('Plan execution IDs are immutable');
    }

    if (patch.planId && patch.planId !== current.planId) {
      throw new Error('planId is immutable');
    }

    if (patch.runId && patch.runId !== current.runId) {
      throw new Error('runId is immutable');
    }

    const now = new Date().toISOString();
    const nextStatus = patch.status ?? current.status;
    const next: PlanExecution = {
      ...current,
      ...patch,
      updatedAt: now,
      completedAt:
        patch.completedAt ??
        current.completedAt ??
        (TERMINAL_PLAN_EXECUTION_STATUSES.has(nextStatus) ? now : undefined),
    };

    const result = await this.client.query<PlanExecutionRow>(POSTGRES_RUNTIME_PLAN_QUERIES.updateExecution, [
      executionId,
      next.status,
      jsonbParam(next.input),
      jsonbParam(next.context),
      next.currentStepId ?? null,
      next.currentStepIndex ?? null,
      jsonbParam(next.output),
      next.replanReason ?? null,
      next.updatedAt,
      next.completedAt ?? null,
    ]);

    return executionRowToRecord(firstRow(result, `Failed to update plan execution ${executionId}`));
  }
}

export class PostgresToolExecutionStore implements ToolExecutionStore {
  constructor(private readonly client: PostgresClient) {}

  async getByIdempotencyKey(idempotencyKey: string): Promise<ToolExecutionRecord | null> {
    const result = await this.client.query<ToolExecutionRow>(
      POSTGRES_RUNTIME_TOOL_EXECUTION_QUERIES.getByIdempotencyKey,
      [idempotencyKey],
    );
    return result.rows[0] ? toolExecutionRowToRecord(result.rows[0]) : null;
  }

  async markStarted(record: Parameters<ToolExecutionStore['markStarted']>[0]): Promise<ToolExecutionRecord> {
    const now = new Date().toISOString();
    const result = await this.client.query<ToolExecutionRow>(POSTGRES_RUNTIME_TOOL_EXECUTION_QUERIES.markStarted, [
      record.runId,
      record.stepId,
      record.toolCallId,
      record.toolName,
      record.idempotencyKey,
      record.inputHash,
      jsonbParam(record.input),
      now,
    ]);

    const inserted = result.rows[0];
    if (inserted) {
      return toolExecutionRowToRecord(inserted);
    }

    const existing = await this.getByIdempotencyKey(record.idempotencyKey);
    if (!existing) {
      throw new Error(`Tool execution ${record.idempotencyKey} was not created`);
    }

    return existing;
  }

  async markChildRunLinked(idempotencyKey: string, childRunId: UUID): Promise<ToolExecutionRecord> {
    const result = await this.client.query<ToolExecutionRow>(
      POSTGRES_RUNTIME_TOOL_EXECUTION_QUERIES.markChildRunLinked,
      [idempotencyKey, childRunId],
    );

    return toolExecutionRowToRecord(firstRow(result, `Tool execution ${idempotencyKey} does not exist`));
  }

  async markCompleted(idempotencyKey: string, output: JsonValue): Promise<ToolExecutionRecord> {
    const result = await this.client.query<ToolExecutionRow>(POSTGRES_RUNTIME_TOOL_EXECUTION_QUERIES.markCompleted, [
      idempotencyKey,
      jsonbParam(output),
      new Date().toISOString(),
    ]);

    return toolExecutionRowToRecord(firstRow(result, `Tool execution ${idempotencyKey} does not exist`));
  }

  async markFailed(idempotencyKey: string, errorCode: string, errorMessage: string): Promise<ToolExecutionRecord> {
    const result = await this.client.query<ToolExecutionRow>(POSTGRES_RUNTIME_TOOL_EXECUTION_QUERIES.markFailed, [
      idempotencyKey,
      errorCode,
      errorMessage,
      new Date().toISOString(),
    ]);

    return toolExecutionRowToRecord(firstRow(result, `Tool execution ${idempotencyKey} does not exist`));
  }
}

export class PostgresContinuationStore implements ContinuationStore {
  constructor(private readonly client: PostgresClient) {}

  async createContinuation(
    continuation: Omit<RunContinuation, 'id' | 'createdAt'>,
  ): Promise<RunContinuation> {
    const result = await this.client.query<RunContinuationRow>(POSTGRES_RUNTIME_CONTINUATION_QUERIES.create, [
      continuation.sourceRunId,
      continuation.continuationRunId,
      continuation.strategy,
      continuation.failureClass,
      continuation.reason,
      continuation.sourceSnapshotId ?? null,
      continuation.sourceSnapshotSeq ?? null,
      continuation.sourceEventSeq ?? null,
      continuation.sourceStepId ?? null,
      continuation.nextStepId ?? null,
      continuation.provider ?? null,
      continuation.model ?? null,
      jsonbParam(continuation.metadata),
    ]);

    return continuationRowToRecord(
      firstRow(result, `Failed to create continuation for run ${continuation.continuationRunId}`),
    );
  }

  async listBySourceRun(sourceRunId: UUID): Promise<RunContinuation[]> {
    const result = await this.client.query<RunContinuationRow>(
      POSTGRES_RUNTIME_CONTINUATION_QUERIES.listBySourceRun,
      [sourceRunId],
    );
    return result.rows.map(continuationRowToRecord);
  }

  async getByContinuationRun(continuationRunId: UUID): Promise<RunContinuation | null> {
    const result = await this.client.query<RunContinuationRow>(
      POSTGRES_RUNTIME_CONTINUATION_QUERIES.getByContinuationRun,
      [continuationRunId],
    );
    return result.rows[0] ? continuationRowToRecord(result.rows[0]) : null;
  }
}

export interface PostgresRecoveryScannerOptions {
  now?: Date;
  staleRunMs?: number;
  limit?: number;
  includePendingInteractions?: boolean;
}

export interface PostgresRecoveryClaimOptions {
  runId: UUID;
  owner: string;
  ttlMs: number;
  now?: Date;
}

export class PostgresRecoveryScanner {
  private readonly runStore: PostgresRunStore;

  constructor(private readonly client: PostgresClient) {
    this.runStore = new PostgresRunStore(client);
  }

  async scan(options: PostgresRecoveryScannerOptions = {}): Promise<RuntimeRecoveryCandidate[]> {
    const now = options.now ?? new Date();
    const limit = options.limit ?? 100;
    const staleRunMs = options.staleRunMs ?? 5 * 60_000;
    const staleBefore = new Date(now.getTime() - staleRunMs);
    const candidates: RuntimeRecoveryCandidate[] = [];

    candidates.push(
      ...(await this.queryCandidates(POSTGRES_RUNTIME_RECOVERY_QUERIES.expiredLeases, [
        now.toISOString(),
        [...TERMINAL_RUN_STATUSES],
        limit,
      ])),
      ...(await this.queryCandidates(POSTGRES_RUNTIME_RECOVERY_QUERIES.awaitingSubagentTerminalChild, [
        [...TERMINAL_RUN_STATUSES],
        limit,
      ])),
      ...(await this.queryCandidates(POSTGRES_RUNTIME_RECOVERY_QUERIES.awaitingSubagentMissingChild, [limit])),
      ...(await this.queryCandidates(POSTGRES_RUNTIME_RECOVERY_QUERIES.awaitingSubagentLinkageMismatch, [limit])),
      ...(await this.queryCandidates(POSTGRES_RUNTIME_RECOVERY_QUERIES.staleRunning, [
        staleBefore.toISOString(),
        limit,
      ])),
      ...(await this.queryCandidates(POSTGRES_RUNTIME_RECOVERY_QUERIES.orphanChildren, [limit])),
    );

    if (options.includePendingInteractions) {
      candidates.push(
        ...(await this.queryCandidates(POSTGRES_RUNTIME_RECOVERY_QUERIES.pendingInteractions, [
          ['awaiting_approval', 'clarification_requested'],
          limit,
        ])),
      );
    }

    return candidates;
  }

  async claim(options: PostgresRecoveryClaimOptions): Promise<boolean> {
    return this.runStore.tryAcquireLease({
      runId: options.runId,
      owner: options.owner,
      ttlMs: options.ttlMs,
      now: options.now ?? new Date(),
    });
  }

  private async queryCandidates(sql: string, params: unknown[]): Promise<RuntimeRecoveryCandidate[]> {
    const result = await this.client.query<RecoveryCandidateRow>(sql, params);
    return result.rows.map((row) => ({
      reason: row.recovery_reason as RecoveryScanReason,
      run: runRowToRecord(row),
      childRun: row.child_run ? runRowToRecord(row.child_run) : undefined,
      detail: row.recovery_detail ?? undefined,
    }));
  }
}

export class PostgresRuntimeStoreBundle implements RuntimeTransactionStore {
  readonly runStore: PostgresRunStore;
  readonly eventStore: PostgresEventStore;
  readonly snapshotStore: PostgresSnapshotStore;
  readonly planStore: PostgresPlanStore;
  readonly continuationStore: PostgresContinuationStore;
  readonly toolExecutionStore: PostgresToolExecutionStore;
  readonly recoveryScanner: PostgresRecoveryScanner;

  constructor(private readonly client: PostgresClient | PostgresPoolClient) {
    this.runStore = new PostgresRunStore(client);
    this.eventStore = new PostgresEventStore(client);
    this.snapshotStore = new PostgresSnapshotStore(client);
    this.planStore = new PostgresPlanStore(client);
    this.continuationStore = new PostgresContinuationStore(client);
    this.toolExecutionStore = new PostgresToolExecutionStore(client);
    this.recoveryScanner = new PostgresRecoveryScanner(client);
  }

  async runInTransaction<T>(operation: (stores: RuntimeStores) => Promise<T>): Promise<T> {
    return runPostgresTransaction(this.client, (client) =>
      operation({
        runStore: new PostgresRunStore(client),
        eventStore: new PostgresEventStore(client),
        snapshotStore: new PostgresSnapshotStore(client),
        planStore: new PostgresPlanStore(client),
        continuationStore: new PostgresContinuationStore(client),
        toolExecutionStore: new PostgresToolExecutionStore(client),
      }),
    );
  }
}

export function createPostgresRuntimeStores(options: { client: PostgresClient | PostgresPoolClient }): PostgresRuntimeStoreBundle {
  return new PostgresRuntimeStoreBundle(options.client);
}

function runRowToRecord(row: AgentRunRow): AgentRun {
  return {
    id: row.id,
    rootRunId: row.root_run_id,
    parentRunId: row.parent_run_id ?? undefined,
    parentStepId: row.parent_step_id ?? undefined,
    delegateName: row.delegate_name ?? undefined,
    delegationDepth: row.delegation_depth,
    currentChildRunId: row.current_child_run_id ?? undefined,
    goal: row.goal,
    input: row.input ?? undefined,
    context: row.context ?? undefined,
    modelProvider: row.model_provider ?? undefined,
    modelName: row.model_name ?? undefined,
    modelParameters: row.model_parameters ?? undefined,
    status: row.status as RunStatus,
    currentStepId: row.current_step_id ?? undefined,
    currentPlanId: row.current_plan_id ?? undefined,
    currentPlanExecutionId: row.current_plan_execution_id ?? undefined,
    leaseOwner: row.lease_owner ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    heartbeatAt: row.heartbeat_at ?? undefined,
    version: row.version,
    usage: usageFromRunRow(row),
    result: row.result ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    metadata: row.metadata ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function usageFromRunRow(row: AgentRunRow): UsageSummary {
  const reasoningTokens = row.total_reasoning_tokens ?? 0;
  return {
    promptTokens: row.total_prompt_tokens,
    completionTokens: row.total_completion_tokens,
    reasoningTokens: reasoningTokens > 0 ? reasoningTokens : undefined,
    totalTokens: row.total_prompt_tokens + row.total_completion_tokens + reasoningTokens,
    estimatedCostUSD: Number(row.estimated_cost_usd),
  };
}

function jsonbParam(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function eventRowToRecord(row: AgentEventRow): AgentEvent {
  return {
    id: String(row.id),
    runId: row.run_id,
    planExecutionId: row.plan_execution_id ?? undefined,
    seq: Number(row.seq),
    type: row.event_type as AgentEvent['type'],
    stepId: row.step_id ?? undefined,
    toolCallId: row.tool_call_id ?? undefined,
    schemaVersion: row.schema_version,
    payload: row.payload,
    createdAt: row.created_at,
  };
}

function snapshotRowToRecord(row: RunSnapshotRow): RunSnapshot {
  return {
    id: row.id,
    runId: row.run_id,
    snapshotSeq: Number(row.snapshot_seq),
    status: row.status as RunStatus,
    currentStepId: row.current_step_id ?? undefined,
    currentPlanId: row.current_plan_id ?? undefined,
    currentPlanExecutionId: row.current_plan_execution_id ?? undefined,
    summary: row.summary,
    state: row.state,
    createdAt: row.created_at,
  };
}

function planRowToRecord(row: PlanRow, steps: PlanStep[]): PlanArtifact {
  return {
    id: row.id,
    version: row.version,
    status: row.status as PlanStatus,
    goal: row.goal,
    summary: row.summary,
    inputSchema: row.input_schema ?? undefined,
    successCriteria: row.success_criteria ?? undefined,
    toolsetHash: row.toolset_hash,
    plannerModel: row.planner_model ?? undefined,
    plannerPromptVersion: row.planner_prompt_version ?? undefined,
    createdFromRunId: row.created_from_run_id ?? undefined,
    parentPlanId: row.parent_plan_id ?? undefined,
    metadata: row.metadata ?? undefined,
    steps,
    createdAt: row.created_at,
    archivedAt: row.archived_at ?? undefined,
  };
}

function stepRowToRecord(row: PlanStepRow): PlanStep {
  return {
    id: row.step_key,
    title: row.title,
    toolName: row.tool_name,
    inputTemplate: row.input_template,
    outputKey: row.output_key ?? undefined,
    preconditions: row.preconditions ?? undefined,
    onFailure: row.failure_policy as PlanStep['onFailure'],
    requiresApproval: row.requires_approval || undefined,
  };
}

function executionRowToRecord(row: PlanExecutionRow): PlanExecution {
  return {
    id: row.id,
    planId: row.plan_id,
    runId: row.run_id,
    attempt: row.attempt,
    status: row.status as PlanExecutionStatus,
    input: row.input ?? undefined,
    context: row.context ?? undefined,
    currentStepId: row.current_step_id ?? undefined,
    currentStepIndex: row.current_step_index ?? undefined,
    output: row.output ?? undefined,
    replanReason: row.replan_reason ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function toolExecutionRowToRecord(row: ToolExecutionRow): ToolExecutionRecord {
  return {
    runId: row.run_id,
    stepId: row.step_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    idempotencyKey: row.idempotency_key,
    status: row.status as ToolExecutionStatus,
    inputHash: row.input_hash,
    input: row.input ?? undefined,
    childRunId: row.child_run_id ?? undefined,
    output: row.output ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function continuationRowToRecord(row: RunContinuationRow): RunContinuation {
  return {
    id: row.id,
    sourceRunId: row.source_run_id,
    continuationRunId: row.continuation_run_id,
    strategy: row.strategy as ContinuationStrategy,
    failureClass: row.failure_class as FailureClass,
    reason: row.reason,
    sourceSnapshotId: row.source_snapshot_id ?? undefined,
    sourceSnapshotSeq: row.source_snapshot_seq === null ? undefined : Number(row.source_snapshot_seq),
    sourceEventSeq: row.source_event_seq === null ? undefined : Number(row.source_event_seq),
    sourceStepId: row.source_step_id ?? undefined,
    nextStepId: row.next_step_id ?? undefined,
    provider: row.provider ?? undefined,
    model: row.model ?? undefined,
    metadata: row.metadata ?? undefined,
    createdAt: row.created_at,
  };
}

function firstRow<T>(result: PostgresQueryResult<T>, message: string): T {
  const row = result.rows[0];
  if (!row) {
    throw new Error(message);
  }

  return row;
}

async function runPostgresTransaction<T>(
  client: PostgresClient | PostgresPoolClient,
  operation: (client: PostgresClient) => Promise<T>,
): Promise<T> {
  const transactionClient = isPostgresPoolClient(client) ? await client.connect() : client;
  const shouldRelease = isPostgresTransactionClient(transactionClient);

  try {
    await transactionClient.query('BEGIN');
    const result = await operation(transactionClient);
    await transactionClient.query('COMMIT');
    return result;
  } catch (error) {
    await transactionClient.query('ROLLBACK');
    throw error;
  } finally {
    if (shouldRelease) {
      transactionClient.release();
    }
  }
}

function isPostgresPoolClient(client: PostgresClient | PostgresPoolClient): client is PostgresPoolClient {
  return typeof (client as PostgresPoolClient).connect === 'function';
}

function isPostgresTransactionClient(client: PostgresClient): client is PostgresTransactionClient {
  return typeof (client as PostgresTransactionClient).release === 'function';
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

function assertMutableRunPatch(runId: UUID, current: AgentRun, patch: Partial<AgentRun>): void {
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

  if (patch.modelProvider && patch.modelProvider !== current.modelProvider) {
    throw new Error('modelProvider is immutable');
  }

  if (patch.modelName && patch.modelName !== current.modelName) {
    throw new Error('modelName is immutable');
  }

  if (patch.modelParameters && JSON.stringify(patch.modelParameters) !== JSON.stringify(current.modelParameters)) {
    throw new Error('modelParameters is immutable');
  }
}
