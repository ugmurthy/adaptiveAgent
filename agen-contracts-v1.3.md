# AdaptiveAgent v1.3 Contracts And Postgres Schema

This document turns the v1.3 product spec into implementation-facing contracts. It defines:

- TypeScript interfaces for runtime boundaries
- plan and run data shapes
- recommended Postgres tables and indexes

The goal is to give implementation a stable starting point without over-designing the runtime.

## 1. TypeScript Contracts

```ts
export type UUID = string;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type JsonSchema = Record<string, unknown>;

export type CaptureMode = 'full' | 'summary' | 'none';
export type RunStatus =
  | 'queued'
  | 'planning'
  | 'awaiting_approval'
  | 'running'
  | 'interrupted'
  | 'succeeded'
  | 'failed'
  | 'clarification_requested'
  | 'replan_required'
  | 'cancelled';

export type PlanStatus = 'draft' | 'approved' | 'archived';
export type PlanExecutionStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'succeeded'
  | 'failed'
  | 'replan_required'
  | 'cancelled';

export type FailurePolicy = 'stop' | 'skip' | 'replan';

export type EventType =
  | 'run.created'
  | 'run.status_changed'
  | 'run.interrupted'
  | 'run.resumed'
  | 'run.completed'
  | 'run.failed'
  | 'plan.created'
  | 'plan.execution_started'
  | 'step.started'
  | 'step.completed'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.failed'
  | 'approval.requested'
  | 'approval.resolved'
  | 'clarification.requested'
  | 'usage.updated'
  | 'snapshot.created'
  | 'replan.required';

export interface UsageSummary {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  totalTokens?: number;
  estimatedCostUSD: number;
  provider?: string;
  model?: string;
}

export interface ModelCapabilities {
  toolCalling: boolean;
  jsonOutput: boolean;
  streaming: boolean;
  usage: boolean;
}

export interface AgentDefaults {
  maxSteps?: number;
  toolTimeoutMs?: number;
  modelTimeoutMs?: number;
  maxRetriesPerStep?: number;
  requireApprovalForWriteTools?: boolean;
  capture?: CaptureMode;
}

export interface RunRequest {
  goal: string;
  input?: JsonValue;
  context?: Record<string, JsonValue>;
  allowedTools?: string[];
  forbiddenTools?: string[];
  outputSchema?: JsonSchema;
  metadata?: Record<string, JsonValue>;
}

export interface PlanRequest {
  goal: string;
  input?: JsonValue;
  context?: Record<string, JsonValue>;
  allowedTools?: string[];
  forbiddenTools?: string[];
  inputSchema?: JsonSchema;
  successCriteria?: JsonValue;
  metadata?: Record<string, JsonValue>;
}

export interface ExecutePlanRequest {
  planId: UUID;
  input?: JsonValue;
  context?: Record<string, JsonValue>;
  metadata?: Record<string, JsonValue>;
}

export interface ToolRedactionPolicy {
  inputPaths?: string[];
  outputPaths?: string[];
}

export interface ToolContext {
  runId: UUID;
  stepId: string;
  planId?: UUID;
  planExecutionId?: UUID;
  input?: JsonValue;
  context?: Record<string, JsonValue>;
  idempotencyKey: string;
  signal: AbortSignal;
  emit: (event: Omit<AgentEvent, 'id' | 'seq' | 'createdAt'>) => Promise<void>;
}

export interface ToolDefinition<I extends JsonValue = JsonValue, O extends JsonValue = JsonValue> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  timeoutMs?: number;
  requiresApproval?: boolean;
  capture?: CaptureMode;
  redact?: ToolRedactionPolicy;
  summarizeResult?: (output: O) => JsonValue;
  execute(input: I, context: ToolContext): Promise<O>;
}

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  toolCallId?: string;
}

export interface ModelToolCall {
  id: string;
  name: string;
  input: JsonValue;
}

export interface ModelRequest {
  messages: ModelMessage[];
  tools?: Array<Pick<ToolDefinition, 'name' | 'description' | 'inputSchema'>>;
  outputSchema?: JsonSchema;
  signal?: AbortSignal;
  metadata?: Record<string, JsonValue>;
}

export interface ModelResponse {
  text?: string;
  structuredOutput?: JsonValue;
  toolCalls?: ModelToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error';
  usage?: UsageSummary;
  providerResponseId?: string;
  summary?: string;
}

export interface ModelStreamEvent {
  type: 'status' | 'summary' | 'usage';
  payload: JsonValue;
}

export interface ModelAdapter {
  provider: string;
  model: string;
  capabilities: ModelCapabilities;
  generate(request: ModelRequest): Promise<ModelResponse>;
  stream?(
    request: ModelRequest,
    onEvent: (event: ModelStreamEvent) => Promise<void> | void,
  ): Promise<ModelResponse>;
}

export type TemplateValue =
  | JsonValue
  | { $ref: `$input.${string}` }
  | { $ref: `$context.${string}` }
  | { $ref: `$steps.${string}` }
  | { $ref: `$steps.${string}.${string}` };

export interface PlanCondition {
  kind: 'exists' | 'equals' | 'not_equals';
  left: TemplateValue;
  right?: TemplateValue;
}

export interface PlanStep {
  id: string;
  title: string;
  toolName: string;
  inputTemplate: TemplateValue | { [key: string]: TemplateValue };
  outputKey?: string;
  preconditions?: PlanCondition[];
  onFailure: FailurePolicy;
  requiresApproval?: boolean;
}

export interface PlanArtifact {
  id: UUID;
  version: number;
  status: PlanStatus;
  goal: string;
  summary: string;
  inputSchema?: JsonSchema;
  successCriteria?: JsonValue;
  toolsetHash: string;
  plannerModel?: string;
  plannerPromptVersion?: string;
  createdFromRunId?: UUID;
  parentPlanId?: UUID;
  metadata?: Record<string, JsonValue>;
  steps: PlanStep[];
  createdAt: string;
  archivedAt?: string;
}

export interface AgentRun {
  id: UUID;
  goal: string;
  input?: JsonValue;
  context?: Record<string, JsonValue>;
  status: RunStatus;
  currentStepId?: string;
  currentPlanId?: UUID;
  currentPlanExecutionId?: UUID;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  heartbeatAt?: string;
  version: number;
  usage: UsageSummary;
  result?: JsonValue;
  errorCode?: string;
  errorMessage?: string;
  metadata?: Record<string, JsonValue>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface PlanExecution {
  id: UUID;
  planId: UUID;
  runId: UUID;
  attempt: number;
  status: PlanExecutionStatus;
  input?: JsonValue;
  context?: Record<string, JsonValue>;
  currentStepId?: string;
  currentStepIndex?: number;
  output?: JsonValue;
  replanReason?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface AgentEvent {
  id: string;
  runId: UUID;
  planExecutionId?: UUID;
  seq: number;
  type: EventType;
  stepId?: string;
  schemaVersion: number;
  payload: JsonValue;
  createdAt: string;
}

export interface RunSnapshot {
  id: UUID;
  runId: UUID;
  snapshotSeq: number;
  status: RunStatus;
  currentStepId?: string;
  currentPlanId?: UUID;
  currentPlanExecutionId?: UUID;
  summary: JsonValue;
  state: JsonValue;
  createdAt: string;
}

export interface EventSink {
  emit(event: Omit<AgentEvent, 'id' | 'seq' | 'createdAt'>): Promise<void> | void;
}

export interface RunStore {
  createRun(run: {
    goal: string;
    input?: JsonValue;
    context?: Record<string, JsonValue>;
    metadata?: Record<string, JsonValue>;
    status: RunStatus;
  }): Promise<AgentRun>;

  getRun(runId: UUID): Promise<AgentRun | null>;

  updateRun(runId: UUID, patch: Partial<AgentRun>, expectedVersion?: number): Promise<AgentRun>;

  tryAcquireLease(params: {
    runId: UUID;
    owner: string;
    ttlMs: number;
    now: Date;
  }): Promise<boolean>;

  heartbeatLease(params: {
    runId: UUID;
    owner: string;
    ttlMs: number;
    now: Date;
  }): Promise<void>;

  releaseLease(runId: UUID, owner: string): Promise<void>;
}

export interface EventStore {
  append(event: Omit<AgentEvent, 'id' | 'seq' | 'createdAt'>): Promise<AgentEvent>;
  listByRun(runId: UUID, afterSeq?: number): Promise<AgentEvent[]>;
}

export interface SnapshotStore {
  save(snapshot: Omit<RunSnapshot, 'id' | 'createdAt'>): Promise<RunSnapshot>;
  getLatest(runId: UUID): Promise<RunSnapshot | null>;
}

export interface PlanStore {
  createPlan(plan: Omit<PlanArtifact, 'createdAt' | 'archivedAt'>): Promise<PlanArtifact>;
  getPlan(planId: UUID): Promise<PlanArtifact | null>;
  listSteps(planId: UUID): Promise<PlanStep[]>;

  createExecution(execution: Omit<PlanExecution, 'createdAt' | 'updatedAt'>): Promise<PlanExecution>;
  getExecution(executionId: UUID): Promise<PlanExecution | null>;
  updateExecution(executionId: UUID, patch: Partial<PlanExecution>): Promise<PlanExecution>;
}

export type RunResult<T extends JsonValue = JsonValue> =
  | {
      status: 'success';
      runId: UUID;
      planId?: UUID;
      output: T;
      stepsUsed: number;
      usage: UsageSummary;
    }
  | {
      status: 'failure';
      runId: UUID;
      error: string;
      code: 'MAX_STEPS' | 'TOOL_ERROR' | 'MODEL_ERROR' | 'APPROVAL_REJECTED' | 'REPLAN_REQUIRED' | 'INTERRUPTED';
      stepsUsed: number;
      usage: UsageSummary;
    }
  | {
      status: 'clarification_requested';
      runId: UUID;
      message: string;
      suggestedQuestions?: string[];
    }
  | {
      status: 'approval_requested';
      runId: UUID;
      message: string;
      toolName: string;
    };
```

## 2. Postgres Schema

The schema below uses PostgreSQL with `pgcrypto` or an equivalent UUID function enabled.

```sql
create extension if not exists pgcrypto;

create table agent_runs (
  id uuid primary key default gen_random_uuid(),
  goal text not null,
  input jsonb,
  context jsonb,
  metadata jsonb,
  status text not null,
  current_step_id text,
  current_plan_id uuid,
  current_plan_execution_id uuid,
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  version integer not null default 0,
  total_prompt_tokens integer not null default 0,
  total_completion_tokens integer not null default 0,
  total_reasoning_tokens integer not null default 0,
  estimated_cost_usd numeric(18, 8) not null default 0,
  result jsonb,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index agent_runs_status_idx on agent_runs (status, updated_at desc);
create index agent_runs_lease_idx on agent_runs (lease_expires_at);

create table plans (
  id uuid primary key default gen_random_uuid(),
  version integer not null default 1,
  status text not null,
  goal text not null,
  summary text not null,
  input_schema jsonb,
  success_criteria jsonb,
  toolset_hash text not null,
  planner_model text,
  planner_prompt_version text,
  created_from_run_id uuid references agent_runs(id) on delete set null,
  parent_plan_id uuid references plans(id) on delete set null,
  metadata jsonb,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

create index plans_status_idx on plans (status, created_at desc);
create index plans_created_from_run_idx on plans (created_from_run_id);

create table plan_steps (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references plans(id) on delete cascade,
  step_index integer not null,
  step_key text not null,
  title text not null,
  tool_name text not null,
  input_template jsonb not null,
  output_key text,
  preconditions jsonb not null default '[]'::jsonb,
  failure_policy text not null default 'stop',
  requires_approval boolean not null default false,
  created_at timestamptz not null default now(),
  unique (plan_id, step_index),
  unique (plan_id, step_key)
);

create index plan_steps_tool_idx on plan_steps (tool_name);

create table plan_executions (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references plans(id) on delete restrict,
  run_id uuid not null references agent_runs(id) on delete cascade,
  attempt integer not null default 1,
  status text not null,
  input jsonb,
  context jsonb,
  current_step_id text,
  current_step_index integer,
  output jsonb,
  replan_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (run_id, attempt)
);

create index plan_executions_plan_idx on plan_executions (plan_id, created_at desc);
create index plan_executions_status_idx on plan_executions (status, updated_at desc);

alter table agent_runs
  add constraint agent_runs_current_plan_fk
  foreign key (current_plan_id) references plans(id) on delete set null;

alter table agent_runs
  add constraint agent_runs_current_plan_execution_fk
  foreign key (current_plan_execution_id) references plan_executions(id) on delete set null;

create table agent_events (
  id bigserial primary key,
  run_id uuid not null references agent_runs(id) on delete cascade,
  plan_execution_id uuid references plan_executions(id) on delete set null,
  seq bigint not null,
  step_id text,
  event_type text not null,
  schema_version integer not null default 1,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (run_id, seq)
);

create index agent_events_run_idx on agent_events (run_id, seq);
create index agent_events_type_idx on agent_events (event_type, created_at desc);
create index agent_events_plan_execution_idx on agent_events (plan_execution_id, seq);

create table run_snapshots (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references agent_runs(id) on delete cascade,
  snapshot_seq bigint not null,
  status text not null,
  current_step_id text,
  current_plan_id uuid references plans(id) on delete set null,
  current_plan_execution_id uuid references plan_executions(id) on delete set null,
  summary jsonb not null default '{}'::jsonb,
  state jsonb not null,
  created_at timestamptz not null default now(),
  unique (run_id, snapshot_seq)
);

create index run_snapshots_run_idx on run_snapshots (run_id, snapshot_seq desc);
```

## 3. Schema Notes

### `agent_runs`

- stores run-level lifecycle state
- stores cumulative usage and cost totals
- carries the current lease and optimistic version counter
- does not attempt to store the full replayable execution graph in one JSON blob

### `agent_events`

- append-only log for replay, UI timelines, and audit
- ordered by `seq` within each run
- payload can store summaries instead of raw prompt content when capture policy requires it

### `run_snapshots`

- compact resumability layer
- one snapshot every important boundary, not every token or event
- `state` should contain only what is needed to continue execution

### `plans` and `plan_steps`

- plans are preserved independently from runs
- versioning is per plan row using `version` and optional `parent_plan_id`
- `toolset_hash` is used for compatibility checks at execution time

### `plan_executions`

- binds a plan to a run
- allows later analysis of how a preserved plan behaved across multiple executions
- `attempt` allows explicit retries without overwriting the original execution record

## 4. Compatibility Rules For Re-Execution

Before `executePlan()` starts, the runtime should verify:

1. every referenced `tool_name` still exists
2. tool input schemas are compatible with the saved step templates
3. any tool approval requirements are still satisfied by host policy
4. the current toolset hash matches the plan's `toolset_hash`, or the host explicitly allows execution on mismatch

If compatibility fails, the run should move to `replan_required` and emit a `replan.required` event rather than silently mutating the saved plan.

## 5. Minimal Resume Algorithm

Recommended resume flow:

1. load `agent_runs`
2. acquire lease if available
3. load latest `run_snapshots`
4. restore in-memory execution state from `state`
5. continue from `current_step_id` or terminalize if already complete

Recommended execution loop:

1. append event
2. update run status or usage totals
3. persist snapshot at safe boundaries
4. heartbeat lease periodically
5. release lease on terminal status

## 6. Suggested Next Implementation Order

1. define shared TypeScript types in `packages/core/src/types.ts`
2. implement in-memory stores using the same interfaces
3. implement the linear planner and step executor
4. add Postgres stores that satisfy `RunStore`, `EventStore`, `SnapshotStore`, and `PlanStore`
5. wire the dashboard example to the event stream
