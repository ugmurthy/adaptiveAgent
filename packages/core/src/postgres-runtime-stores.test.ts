import { describe, expect, it, vi } from 'vitest';

import {
  POSTGRES_RUNTIME_EVENT_QUERIES,
  POSTGRES_RUNTIME_PLAN_QUERIES,
  POSTGRES_RUNTIME_RECOVERY_QUERIES,
  POSTGRES_RUNTIME_RUN_QUERIES,
  POSTGRES_RUNTIME_SNAPSHOT_QUERIES,
  POSTGRES_RUNTIME_TOOL_EXECUTION_QUERIES,
  PostgresEventStore,
  PostgresOptimisticConcurrencyError,
  PostgresPlanStore,
  PostgresRecoveryScanner,
  PostgresRuntimeStoreBundle,
  PostgresRunStore,
  PostgresSnapshotStore,
  PostgresToolExecutionStore,
  createPostgresRuntimeStores,
  type PostgresClient,
  type PostgresTransactionClient,
} from './postgres-runtime-stores.js';

function createMockClient(): PostgresClient & { calls: Array<{ sql: string; params?: unknown[] }> } {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    calls,
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }),
  };
}

function createMockClientWithRows(rows: Record<string, unknown>[]): PostgresClient {
  return {
    query: vi.fn(async () => ({ rows, rowCount: rows.length })) as PostgresClient['query'],
  };
}

function createQueuedClient(results: Array<Record<string, unknown>[]>): PostgresClient {
  const queue = [...results];
  return {
    query: vi.fn(async () => {
      const rows = queue.shift() ?? [];
      return { rows, rowCount: rows.length };
    }) as PostgresClient['query'],
  };
}

const sampleRunRow = {
  id: 'run-1',
  root_run_id: 'run-1',
  parent_run_id: null,
  parent_step_id: null,
  delegate_name: null,
  delegation_depth: 0,
  current_child_run_id: null,
  goal: 'Write a report',
  input: { topic: 'resumability' },
  context: { locale: 'en-US' },
  metadata: { requestId: 'req-1' },
  status: 'running',
  current_step_id: 'step-1',
  current_plan_id: null,
  current_plan_execution_id: null,
  lease_owner: null,
  lease_expires_at: null,
  heartbeat_at: null,
  version: 3,
  total_prompt_tokens: 10,
  total_completion_tokens: 5,
  total_reasoning_tokens: 2,
  estimated_cost_usd: '0.00012345',
  result: null,
  error_code: null,
  error_message: null,
  created_at: '2026-04-13T10:00:00.000Z',
  updated_at: '2026-04-13T10:01:00.000Z',
  completed_at: null,
};

const completedRunRow = {
  ...sampleRunRow,
  status: 'succeeded',
  version: 4,
  result: { report: 'done' },
  completed_at: '2026-04-13T10:02:00.000Z',
};

const childRunRow = {
  ...completedRunRow,
  id: 'child-run-1',
  root_run_id: 'run-1',
  parent_run_id: 'run-1',
  parent_step_id: 'step-1',
  delegate_name: 'researcher',
  delegation_depth: 1,
  result: { finding: 'ready' },
};

const sampleEventRow = {
  id: '42',
  run_id: 'run-1',
  plan_execution_id: null,
  seq: '7',
  step_id: 'step-1',
  event_type: 'tool.completed',
  schema_version: 1,
  payload: { toolName: 'lookup' },
  created_at: '2026-04-13T10:01:00.000Z',
};

const sampleSnapshotRow = {
  id: 'snapshot-1',
  run_id: 'run-1',
  snapshot_seq: '4',
  status: 'running',
  current_step_id: 'step-1',
  current_plan_id: null,
  current_plan_execution_id: null,
  summary: { status: 'running' },
  state: { schemaVersion: 1, messages: [], stepsUsed: 1 },
  created_at: '2026-04-13T10:01:00.000Z',
};

const samplePlanRow = {
  id: 'plan-1',
  version: 1,
  status: 'approved',
  goal: 'Execute plan',
  summary: 'A simple test plan.',
  input_schema: { type: 'object' },
  success_criteria: { done: true },
  toolset_hash: 'toolset-1',
  planner_model: 'planner-model',
  planner_prompt_version: 'prompt-v1',
  created_from_run_id: 'run-1',
  parent_plan_id: null,
  metadata: { owner: 'test' },
  created_at: '2026-04-13T10:00:00.000Z',
  archived_at: null,
};

const sampleStepRow = {
  step_key: 'step-1',
  title: 'Look up data',
  tool_name: 'lookup',
  input_template: { topic: { $ref: '$input.topic' } },
  output_key: 'research',
  preconditions: [{ kind: 'exists', left: { $ref: '$input.topic' } }],
  failure_policy: 'stop',
  requires_approval: false,
};

const sampleExecutionRow = {
  id: 'execution-1',
  plan_id: 'plan-1',
  run_id: 'run-1',
  attempt: 1,
  status: 'running',
  input: { topic: 'resumability' },
  context: { locale: 'en-US' },
  current_step_id: 'step-1',
  current_step_index: 0,
  output: null,
  replan_reason: null,
  created_at: '2026-04-13T10:00:00.000Z',
  updated_at: '2026-04-13T10:01:00.000Z',
  completed_at: null,
};

const completedExecutionRow = {
  ...sampleExecutionRow,
  status: 'succeeded',
  output: { done: true },
  completed_at: '2026-04-13T10:02:00.000Z',
};

const sampleToolExecutionRow = {
  run_id: 'run-1',
  step_id: 'step-1',
  tool_call_id: 'call-1',
  tool_name: 'lookup',
  idempotency_key: 'run-1:step-1:call-1',
  status: 'completed',
  input_hash: '{"topic":"resumability"}',
  output: { finding: 'cached' },
  error_code: null,
  error_message: null,
  started_at: '2026-04-13T10:00:00.000Z',
  completed_at: '2026-04-13T10:01:00.000Z',
};

describe('PostgresRunStore', () => {
  it('creates a root run and maps the returned row', async () => {
    const client = createMockClientWithRows([sampleRunRow]);
    const store = new PostgresRunStore(client);

    const run = await store.createRun({
      id: 'run-1',
      goal: 'Write a report',
      input: { topic: 'resumability' },
      context: { locale: 'en-US' },
      metadata: { requestId: 'req-1' },
      status: 'running',
    });

    expect(run).toMatchObject({
      id: 'run-1',
      rootRunId: 'run-1',
      goal: 'Write a report',
      status: 'running',
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        reasoningTokens: 2,
        totalTokens: 17,
        estimatedCostUSD: 0.00012345,
      },
    });
    expect(client.query).toHaveBeenCalledWith(
      POSTGRES_RUNTIME_RUN_QUERIES.create,
      expect.arrayContaining(['run-1', 'run-1', null, null, null]),
    );
  });

  it('returns null when a run is missing', async () => {
    const client = createMockClient();
    const store = new PostgresRunStore(client);

    await expect(store.getRun('missing')).resolves.toBeNull();
  });

  it('updates a run with optimistic versioning', async () => {
    const client = createQueuedClient([[sampleRunRow], [completedRunRow]]);
    const store = new PostgresRunStore(client);

    const run = await store.updateRun('run-1', { status: 'succeeded', result: { report: 'done' } }, 3);

    expect(run).toMatchObject({
      id: 'run-1',
      status: 'succeeded',
      result: { report: 'done' },
    });
    expect(client.query).toHaveBeenLastCalledWith(
      POSTGRES_RUNTIME_RUN_QUERIES.update,
      expect.arrayContaining(['run-1']),
    );
  });

  it('throws an optimistic concurrency error before update when expected version differs', async () => {
    const client = createMockClientWithRows([sampleRunRow]);
    const store = new PostgresRunStore(client);

    await expect(store.updateRun('run-1', { status: 'succeeded' }, 99)).rejects.toBeInstanceOf(
      PostgresOptimisticConcurrencyError,
    );
  });

  it('returns false when a lease cannot be acquired', async () => {
    const client = createMockClient();
    const store = new PostgresRunStore(client);
    const acquired = await store.tryAcquireLease({
      runId: 'run-1',
      owner: 'worker-1',
      ttlMs: 60_000,
      now: new Date('2026-04-13T10:00:00.000Z'),
    });

    expect(acquired).toBe(false);
    expect(client.query).toHaveBeenCalledWith(
      POSTGRES_RUNTIME_RUN_QUERIES.acquireLease,
      ['run-1', 'worker-1', '2026-04-13T10:01:00.000Z', '2026-04-13T10:00:00.000Z'],
    );
  });

  it('throws when heartbeat does not own the lease', async () => {
    const client = createMockClient();
    const store = new PostgresRunStore(client);

    await expect(
      store.heartbeatLease({
        runId: 'run-1',
        owner: 'worker-1',
        ttlMs: 60_000,
        now: new Date('2026-04-13T10:00:00.000Z'),
      }),
    ).rejects.toThrow('lease is not owned');
  });
});

describe('PostgresEventStore', () => {
  it('appends an event, maps the row, and notifies subscribers', async () => {
    const client = createMockClientWithRows([sampleEventRow]);
    const store = new PostgresEventStore(client);
    const listener = vi.fn();
    store.subscribe(listener);

    const event = await store.append({
      runId: 'run-1',
      stepId: 'step-1',
      type: 'tool.completed',
      schemaVersion: 1,
      payload: { toolName: 'lookup' },
    });

    expect(event).toMatchObject({
      id: '42',
      runId: 'run-1',
      seq: 7,
      type: 'tool.completed',
      payload: { toolName: 'lookup' },
    });
    expect(listener).toHaveBeenCalledWith(event);
    expect(client.query).toHaveBeenCalledWith(
      POSTGRES_RUNTIME_EVENT_QUERIES.append,
      ['run-1', null, 'step-1', 'tool.completed', 1, { toolName: 'lookup' }],
    );
  });

  it('lists events after the requested sequence', async () => {
    const client = createMockClientWithRows([sampleEventRow]);
    const store = new PostgresEventStore(client);

    const events = await store.listByRun('run-1', 3);

    expect(events).toHaveLength(1);
    expect(events[0]?.seq).toBe(7);
    expect(client.query).toHaveBeenCalledWith(POSTGRES_RUNTIME_EVENT_QUERIES.listByRun, ['run-1', 3]);
  });
});

describe('PostgresSnapshotStore', () => {
  it('saves a run snapshot', async () => {
    const client = createMockClientWithRows([sampleSnapshotRow]);
    const store = new PostgresSnapshotStore(client);

    const snapshot = await store.save({
      runId: 'run-1',
      snapshotSeq: 4,
      status: 'running',
      currentStepId: 'step-1',
      summary: { status: 'running' },
      state: { schemaVersion: 1, messages: [], stepsUsed: 1 },
    });

    expect(snapshot).toMatchObject({
      id: 'snapshot-1',
      runId: 'run-1',
      snapshotSeq: 4,
      status: 'running',
    });
    expect(client.query).toHaveBeenCalledWith(
      POSTGRES_RUNTIME_SNAPSHOT_QUERIES.save,
      [
        'run-1',
        4,
        'running',
        'step-1',
        null,
        null,
        { status: 'running' },
        { schemaVersion: 1, messages: [], stepsUsed: 1 },
      ],
    );
  });

  it('loads the latest snapshot', async () => {
    const client = createMockClientWithRows([sampleSnapshotRow]);
    const store = new PostgresSnapshotStore(client);

    const snapshot = await store.getLatest('run-1');

    expect(snapshot?.snapshotSeq).toBe(4);
    expect(snapshot?.state).toEqual({ schemaVersion: 1, messages: [], stepsUsed: 1 });
    expect(client.query).toHaveBeenCalledWith(POSTGRES_RUNTIME_SNAPSHOT_QUERIES.getLatest, ['run-1']);
  });
});

describe('PostgresPlanStore', () => {
  it('creates a plan and its ordered steps', async () => {
    const client = createQueuedClient([[samplePlanRow], [sampleStepRow]]);
    const store = new PostgresPlanStore(client);

    const plan = await store.createPlan({
      id: 'plan-1',
      version: 1,
      status: 'approved',
      goal: 'Execute plan',
      summary: 'A simple test plan.',
      inputSchema: { type: 'object' },
      successCriteria: { done: true },
      toolsetHash: 'toolset-1',
      plannerModel: 'planner-model',
      plannerPromptVersion: 'prompt-v1',
      createdFromRunId: 'run-1',
      metadata: { owner: 'test' },
      steps: [
        {
          id: 'step-1',
          title: 'Look up data',
          toolName: 'lookup',
          inputTemplate: { topic: { $ref: '$input.topic' } },
          outputKey: 'research',
          preconditions: [{ kind: 'exists', left: { $ref: '$input.topic' } }],
          onFailure: 'stop',
        },
      ],
    });

    expect(plan).toMatchObject({
      id: 'plan-1',
      status: 'approved',
      steps: [
        {
          id: 'step-1',
          toolName: 'lookup',
          outputKey: 'research',
        },
      ],
    });
    expect(client.query).toHaveBeenNthCalledWith(
      1,
      POSTGRES_RUNTIME_PLAN_QUERIES.createPlan,
      expect.arrayContaining(['plan-1', 1, 'approved', 'Execute plan']),
    );
    expect(client.query).toHaveBeenNthCalledWith(
      2,
      POSTGRES_RUNTIME_PLAN_QUERIES.createStep,
      expect.arrayContaining(['plan-1', 0, 'step-1', 'Look up data', 'lookup']),
    );
  });

  it('loads a plan with its stored steps', async () => {
    const client = createQueuedClient([[samplePlanRow], [sampleStepRow]]);
    const store = new PostgresPlanStore(client);

    const plan = await store.getPlan('plan-1');

    expect(plan).toMatchObject({
      id: 'plan-1',
      toolsetHash: 'toolset-1',
      steps: [{ id: 'step-1', toolName: 'lookup' }],
    });
    expect(client.query).toHaveBeenNthCalledWith(1, POSTGRES_RUNTIME_PLAN_QUERIES.getPlan, ['plan-1']);
    expect(client.query).toHaveBeenNthCalledWith(2, POSTGRES_RUNTIME_PLAN_QUERIES.listSteps, ['plan-1']);
  });

  it('creates and updates a plan execution', async () => {
    const client = createQueuedClient([[sampleExecutionRow], [sampleExecutionRow], [completedExecutionRow]]);
    const store = new PostgresPlanStore(client);

    const created = await store.createExecution({
      id: 'execution-1',
      planId: 'plan-1',
      runId: 'run-1',
      attempt: 1,
      status: 'running',
      input: { topic: 'resumability' },
      context: { locale: 'en-US' },
      currentStepId: 'step-1',
      currentStepIndex: 0,
    });
    const updated = await store.updateExecution('execution-1', { status: 'succeeded', output: { done: true } });

    expect(created.status).toBe('running');
    expect(updated).toMatchObject({
      id: 'execution-1',
      status: 'succeeded',
      output: { done: true },
      completedAt: '2026-04-13T10:02:00.000Z',
    });
    expect(client.query).toHaveBeenNthCalledWith(
      1,
      POSTGRES_RUNTIME_PLAN_QUERIES.createExecution,
      expect.arrayContaining(['execution-1', 'plan-1', 'run-1', 1, 'running']),
    );
    expect(client.query).toHaveBeenNthCalledWith(2, POSTGRES_RUNTIME_PLAN_QUERIES.getExecution, ['execution-1']);
    expect(client.query).toHaveBeenNthCalledWith(
      3,
      POSTGRES_RUNTIME_PLAN_QUERIES.updateExecution,
      expect.arrayContaining(['execution-1', 'succeeded']),
    );
  });
});

describe('PostgresToolExecutionStore', () => {
  it('loads a tool execution by idempotency key', async () => {
    const client = createMockClientWithRows([sampleToolExecutionRow]);
    const store = new PostgresToolExecutionStore(client);

    const record = await store.getByIdempotencyKey('run-1:step-1:call-1');

    expect(record).toMatchObject({
      runId: 'run-1',
      stepId: 'step-1',
      toolCallId: 'call-1',
      toolName: 'lookup',
      status: 'completed',
      output: { finding: 'cached' },
    });
    expect(client.query).toHaveBeenCalledWith(POSTGRES_RUNTIME_TOOL_EXECUTION_QUERIES.getByIdempotencyKey, [
      'run-1:step-1:call-1',
    ]);
  });

  it('marks a tool execution as started', async () => {
    const startedRow = { ...sampleToolExecutionRow, status: 'started', output: null, completed_at: null };
    const client = createMockClientWithRows([startedRow]);
    const store = new PostgresToolExecutionStore(client);

    const record = await store.markStarted({
      runId: 'run-1',
      stepId: 'step-1',
      toolCallId: 'call-1',
      toolName: 'lookup',
      idempotencyKey: 'run-1:step-1:call-1',
      inputHash: '{"topic":"resumability"}',
    });

    expect(record.status).toBe('started');
    expect(client.query).toHaveBeenCalledWith(
      POSTGRES_RUNTIME_TOOL_EXECUTION_QUERIES.markStarted,
      expect.arrayContaining(['run-1', 'step-1', 'call-1', 'lookup', 'run-1:step-1:call-1']),
    );
  });

  it('marks a tool execution as completed', async () => {
    const client = createMockClientWithRows([sampleToolExecutionRow]);
    const store = new PostgresToolExecutionStore(client);

    const record = await store.markCompleted('run-1:step-1:call-1', { finding: 'cached' });

    expect(record.status).toBe('completed');
    expect(record.output).toEqual({ finding: 'cached' });
    expect(client.query).toHaveBeenCalledWith(
      POSTGRES_RUNTIME_TOOL_EXECUTION_QUERIES.markCompleted,
      expect.arrayContaining(['run-1:step-1:call-1', { finding: 'cached' }]),
    );
  });
});

describe('PostgresRecoveryScanner', () => {
  it('scans for expired leases and inconsistent waiting states', async () => {
    const expiredRunRow = {
      ...sampleRunRow,
      lease_owner: 'worker-old',
      lease_expires_at: '2026-04-13T09:59:00.000Z',
      heartbeat_at: '2026-04-13T09:58:30.000Z',
    };
    const waitingParentRow = {
      ...sampleRunRow,
      status: 'awaiting_subagent',
      current_child_run_id: 'child-run-1',
    };
    const client = createQueuedClient([
      [
        {
          ...expiredRunRow,
          recovery_reason: 'expired_lease',
          recovery_detail: 'Run lease expired before reaching a terminal status.',
          child_run: null,
        },
      ],
      [
        {
          ...waitingParentRow,
          recovery_reason: 'awaiting_subagent_terminal_child',
          recovery_detail: 'Parent is awaiting a child run that is already terminal.',
          child_run: childRunRow,
        },
      ],
      [],
      [],
      [],
      [],
    ]);
    const scanner = new PostgresRecoveryScanner(client);

    const candidates = await scanner.scan({
      now: new Date('2026-04-13T10:00:00.000Z'),
      staleRunMs: 60_000,
      limit: 10,
    });

    expect(candidates).toMatchObject([
      {
        reason: 'expired_lease',
        run: {
          id: 'run-1',
          leaseOwner: 'worker-old',
          leaseExpiresAt: '2026-04-13T09:59:00.000Z',
        },
      },
      {
        reason: 'awaiting_subagent_terminal_child',
        run: {
          status: 'awaiting_subagent',
          currentChildRunId: 'child-run-1',
        },
        childRun: {
          id: 'child-run-1',
          status: 'succeeded',
          parentRunId: 'run-1',
        },
      },
    ]);
    expect(client.query).toHaveBeenNthCalledWith(1, POSTGRES_RUNTIME_RECOVERY_QUERIES.expiredLeases, [
      '2026-04-13T10:00:00.000Z',
      expect.any(Array),
      10,
    ]);
    expect(client.query).toHaveBeenNthCalledWith(
      2,
      POSTGRES_RUNTIME_RECOVERY_QUERIES.awaitingSubagentTerminalChild,
      [expect.any(Array), 10],
    );
  });

  it('includes pending interactions only when requested', async () => {
    const awaitingApprovalRow = {
      ...sampleRunRow,
      status: 'awaiting_approval',
      recovery_reason: 'pending_interaction',
      recovery_detail: 'Run is waiting for approval or clarification and may need session reattachment.',
      child_run: null,
    };
    const client = createQueuedClient([[], [], [], [], [], [], [awaitingApprovalRow]]);
    const scanner = new PostgresRecoveryScanner(client);

    const candidates = await scanner.scan({
      now: new Date('2026-04-13T10:00:00.000Z'),
      includePendingInteractions: true,
    });

    expect(candidates).toMatchObject([
      {
        reason: 'pending_interaction',
        run: {
          status: 'awaiting_approval',
        },
      },
    ]);
    expect(client.query).toHaveBeenLastCalledWith(POSTGRES_RUNTIME_RECOVERY_QUERIES.pendingInteractions, [
      ['awaiting_approval', 'clarification_requested'],
      100,
    ]);
  });

  it('claims a candidate by acquiring its lease', async () => {
    const client = createMockClientWithRows([{ ...sampleRunRow, lease_owner: 'recovery-worker' }]);
    const scanner = new PostgresRecoveryScanner(client);

    const claimed = await scanner.claim({
      runId: 'run-1',
      owner: 'recovery-worker',
      ttlMs: 60_000,
      now: new Date('2026-04-13T10:00:00.000Z'),
    });

    expect(claimed).toBe(true);
    expect(client.query).toHaveBeenCalledWith(
      POSTGRES_RUNTIME_RUN_QUERIES.acquireLease,
      ['run-1', 'recovery-worker', '2026-04-13T10:01:00.000Z', '2026-04-13T10:00:00.000Z'],
    );
  });
});

describe('createPostgresRuntimeStores', () => {
  it('creates runtime stores around one client', () => {
    const client = createMockClient();
    const stores = createPostgresRuntimeStores({ client });

    expect(stores).toBeInstanceOf(PostgresRuntimeStoreBundle);
    expect(stores.runStore).toBeInstanceOf(PostgresRunStore);
    expect(stores.eventStore).toBeInstanceOf(PostgresEventStore);
    expect(stores.snapshotStore).toBeInstanceOf(PostgresSnapshotStore);
    expect(stores.planStore).toBeInstanceOf(PostgresPlanStore);
    expect(stores.toolExecutionStore).toBeInstanceOf(PostgresToolExecutionStore);
    expect(stores.recoveryScanner).toBeInstanceOf(PostgresRecoveryScanner);
  });

  it('runs transactional operations on a checked-out Postgres client', async () => {
    const transactionClient: PostgresTransactionClient & { calls: string[] } = {
      calls: [],
      query: vi.fn(async (sql: string) => {
        transactionClient.calls.push(sql);
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      connect: vi.fn(async () => transactionClient),
    };
    const stores = createPostgresRuntimeStores({ client: pool });

    const result = await stores.runInTransaction(async (transactionStores) => {
      expect(transactionStores.runStore).toBeInstanceOf(PostgresRunStore);
      expect(transactionStores.eventStore).toBeInstanceOf(PostgresEventStore);
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(pool.connect).toHaveBeenCalledOnce();
    expect(transactionClient.calls).toEqual(['BEGIN', 'COMMIT']);
    expect(transactionClient.release).toHaveBeenCalledOnce();
  });

  it('rolls back transactional operations when the callback fails', async () => {
    const transactionClient: PostgresTransactionClient & { calls: string[] } = {
      calls: [],
      query: vi.fn(async (sql: string) => {
        transactionClient.calls.push(sql);
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const stores = createPostgresRuntimeStores({
      client: {
        query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
        connect: vi.fn(async () => transactionClient),
      },
    });

    await expect(
      stores.runInTransaction(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(transactionClient.calls).toEqual(['BEGIN', 'ROLLBACK']);
    expect(transactionClient.release).toHaveBeenCalledOnce();
  });
});
