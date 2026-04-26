# AdaptiveAgent v1.4 Contracts And Postgres Schema

This document turns the v1.4 product spec into implementation-facing contracts. It defines:

- TypeScript interfaces for runtime boundaries
- hierarchical run and plan data shapes
- recommended Postgres tables and indexes
- compatibility and resume rules for bounded supervisor delegation

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
  | 'awaiting_subagent'
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
  | 'delegate.spawned'
  | 'delegate.retried'
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
  toolBudgets?: Record<string, ToolBudget>;
  researchPolicy?: ResearchPolicyName | ResearchPolicy;
}

export type ToolBudgetExhaustedAction = 'fail' | 'continue_with_warning' | 'ask_model';

export interface ToolBudget {
  maxCalls?: number;
  maxConsecutiveCalls?: number;
  checkpointAfter?: number;
  onExhausted?: ToolBudgetExhaustedAction;
}

export type ResearchPolicyName = 'none' | 'light' | 'standard' | 'deep';

export interface ResearchPolicy {
  mode: ResearchPolicyName;
  maxSearches?: number;
  maxPagesRead?: number;
  checkpointAfter?: number;
  requirePurpose?: boolean;
}

export interface DelegationPolicy {
  maxDepth?: number;
  maxChildrenPerRun?: number;
  allowRecursiveDelegation?: boolean;
  childRunsMayRequestApproval?: boolean;
  childRunsMayRequestClarification?: boolean;
  maxDelegateRetries?: number;
  retryableChildErrorCodes?: string[];
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

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  context?: Record<string, JsonValue>;
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

export interface DelegateDefinition {
  name: string;
  description: string;
  instructions?: string;
  allowedTools: string[];
  model?: ModelAdapter;
  defaults?: Partial<AgentDefaults>;
}

export interface DelegateToolInput {
  goal: string;
  input?: JsonValue;
  context?: Record<string, JsonValue>;
  outputSchema?: JsonSchema;
  metadata?: Record<string, JsonValue>;
}

export interface DelegateSpawnedPayload {
  toolName: string;
  delegateName: string;
  childRunId: UUID;
  parentRunId: UUID;
  parentStepId: string;
  rootRunId: UUID;
  delegationDepth: number;
}

export interface DelegateRetriedPayload {
  toolName: string;
  delegateName: string;
  parentRunId: UUID;
  parentStepId: string;
  rootRunId: UUID;
  previousChildRunId: UUID;
  childRunId: UUID;
  attempt: number;
  retryReason: string;
}

export interface AdaptiveAgentOptions {
  model: ModelAdapter;
  tools: ToolDefinition[];
  delegates?: DelegateDefinition[];
  delegation?: DelegationPolicy;
  runStore: RunStore;
  eventStore?: EventStore;
  snapshotStore?: SnapshotStore;
  planStore?: PlanStore;
  eventSink?: EventSink;
  defaults?: AgentDefaults;
}

export interface ToolContext {
  runId: UUID;
  rootRunId: UUID;
  parentRunId?: UUID;
  parentStepId?: string;
  delegateName?: string;
  delegationDepth: number;
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
  budgetGroup?: string;
  summarizeResult?: (output: O) => JsonValue;
  execute(input: I, context: ToolContext): Promise<O>;
}

These defaults are additive and disabled unless configured. In the first v1.4 pass, research budgets steer tool admission and model prompting only; first-class top-level `partial` run results remain deferred.

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ModelToolCall[];
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
  rootRunId: UUID;
  parentRunId?: UUID;
  parentStepId?: string;
  delegateName?: string;
  delegationDepth: number;
  currentChildRunId?: UUID;
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

export interface DelegateAttempt {
  parentRunId: UUID;
  parentStepId: string;
  parentToolCallId: string;
  attempt: number;
  delegateName: string;
  childRunId: UUID;
  status: 'started' | 'succeeded' | 'failed' | 'interrupted';
  retryable?: boolean;
  retryReason?: string;
  errorCode?: string;
  errorMessage?: string;
  startedAt: string;
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
  toolCallId?: string;
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
    id?: UUID;
    rootRunId?: UUID;
    parentRunId?: UUID;
    parentStepId?: string;
    delegateName?: string;
    delegationDepth?: number;
    currentChildRunId?: UUID;
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
  subscribe?(listener: (event: AgentEvent) => void): () => void;
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

export type ChatResult<T extends JsonValue = JsonValue> = RunResult<T>;
```

Additive runtime note:

- `AdaptiveAgent.chat(request)` is the transcript-oriented companion to `run(request)`.
- `chat()` seeds the run snapshot with transcript messages instead of the JSON `{ goal, input, context }` envelope used by `run()`.
- `chat()` still uses the same run lifecycle, event log, snapshots, tool execution path, and `RunResult` union as `run()`.

## 2. Contract Notes

### 2.1 Delegate Profiles

A `DelegateDefinition` is registered at construction time and surfaced to the planner as a synthetic tool named `delegate.${name}`.

Examples:

- `researcher` becomes `delegate.researcher`
- `writer` becomes `delegate.writer`

The reserved `delegate.` namespace belongs to the runtime. Host-authored persisted plans should not use tool names under that namespace.

### 2.2 Run Hierarchy

`AgentRun` adds the minimum linkage needed for hierarchical execution:

- `rootRunId` identifies the root of the run tree
- `parentRunId` is set only for delegated child runs
- `parentStepId` points to the supervisor step that spawned the child
- `delegateName` records which delegate profile created the child
- `delegationDepth` is `0` for root runs
- `currentChildRunId` is the one active child run the parent is waiting on
- retry history for a delegate boundary lives in `DelegateAttempt` records rather than by mutating a persisted plan step

This is enough to reconstruct a run tree without creating a general orchestration graph.

### 2.3 Run Usage Semantics

`usage` on `AgentRun` is the usage recorded on that run row.

The minimal v1.4 contract does not require the runtime to roll descendant usage into parent rows. Hosts may aggregate usage across all runs sharing the same `rootRunId` when they need tree-wide totals.

### 2.4 Tool Context Semantics

`ToolContext` now carries hierarchical fields so tools and adapters can:

- derive child-safe idempotency keys
- attach richer event payloads
- enforce policy based on delegation depth or profile

### 2.5 Child Run Interaction Policy

The first multi-agent iteration keeps child runs non-interactive.

If a child run reaches an approval or clarification terminal envelope, the runtime should surface that to the parent as a delegate tool failure instead of exposing nested interaction state to the caller.

Retryable child failures should stay inside the same parent delegate boundary:

- `interrupted` child runs should be resumed in place when possible
- terminal child `failed` runs may create a new `DelegateAttempt` when policy allows retry
- parent `tool.failed` should be emitted only after delegate retry budget is exhausted or the failure is non-retryable

## 3. Postgres Schema

The schema below uses PostgreSQL with `pgcrypto` or an equivalent UUID function enabled.

```sql
create extension if not exists pgcrypto;

create table agent_runs (
  id uuid primary key default gen_random_uuid(),
  root_run_id uuid not null references agent_runs(id) on delete restrict,
  parent_run_id uuid references agent_runs(id) on delete set null,
  parent_step_id text,
  delegate_name text,
  delegation_depth integer not null default 0,
  current_child_run_id uuid references agent_runs(id) on delete set null,
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
  completed_at timestamptz,
  check (delegation_depth >= 0)
);

create index agent_runs_status_idx on agent_runs (status, updated_at desc);
create index agent_runs_lease_idx on agent_runs (lease_expires_at);
create index agent_runs_root_idx on agent_runs (root_run_id, created_at desc);
create index agent_runs_parent_idx on agent_runs (parent_run_id, created_at desc);
create index agent_runs_delegate_idx on agent_runs (delegate_name, created_at desc);
create index agent_runs_current_child_idx on agent_runs (current_child_run_id);

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
  tool_call_id text,
  event_type text not null,
  schema_version integer not null default 1,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (run_id, seq)
);

create index agent_events_run_idx on agent_events (run_id, seq);
create index agent_events_type_idx on agent_events (event_type, created_at desc);
create index agent_events_plan_execution_idx on agent_events (plan_execution_id, seq);
create index agent_events_run_tool_call_idx on agent_events (run_id, tool_call_id, seq);

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

create table tool_executions (
  run_id uuid not null references agent_runs(id) on delete cascade,
  step_id text not null,
  tool_call_id text not null,
  tool_name text not null,
  idempotency_key text not null,
  status text not null,
  input_hash text not null,
  input jsonb,
  child_run_id uuid references agent_runs(id) on delete set null,
  output jsonb,
  error_code text,
  error_message text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (run_id, step_id, tool_call_id),
  unique (idempotency_key)
);

create index tool_executions_run_idx on tool_executions (run_id, started_at desc);
create index tool_executions_status_idx on tool_executions (status, started_at asc);
create index tool_executions_child_run_idx on tool_executions (child_run_id);

create table delegate_attempts (
  parent_run_id uuid not null references agent_runs(id) on delete cascade,
  parent_step_id text not null,
  parent_tool_call_id text not null,
  attempt integer not null,
  delegate_name text not null,
  child_run_id uuid not null references agent_runs(id) on delete cascade,
  status text not null,
  retryable boolean,
  retry_reason text,
  error_code text,
  error_message text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (parent_run_id, parent_step_id, parent_tool_call_id, attempt),
  unique (child_run_id)
);

create index delegate_attempts_parent_idx
  on delegate_attempts (parent_run_id, parent_step_id, parent_tool_call_id, attempt desc);
create index delegate_attempts_child_idx on delegate_attempts (child_run_id);
```

## 4. Schema Notes

### `agent_runs`

- stores run-level lifecycle state
- stores cumulative usage and cost totals for that row
- carries lease and optimistic version counters
- stores parent and child linkage for hierarchical execution
- does not attempt to store the full execution graph in one JSON blob

### `agent_events`

- append-only log for replay, UI timelines, and audit
- ordered by `seq` within each run
- `tool_call_id` links tool lifecycle events to the durable tool execution ledger when present
- payload can store summaries instead of raw prompt content when capture policy requires it
- delegation linkage can live in payload and be joined through `agent_runs`

### `run_snapshots`

- compact resumability layer
- one snapshot every important boundary, not every token or event
- `state` should contain only what is needed to continue execution
- waiting-on-child state should be stored in `state` when relevant

### `plans` and `plan_steps`

- plans are preserved independently from runs
- versioning is per plan row using `version` and optional `parent_plan_id`
- `toolset_hash` is used for compatibility checks at execution time
- persisted plans remain tool-only and must not contain `delegate.*` steps

### `tool_executions`

- durable tool execution ledger keyed by `idempotency_key`
- stores exact start/end timestamps for execution forensics
- stores raw `input` when capture policy allows so traces do not need to reconstruct from event payloads
- `child_run_id` links a delegate tool execution to the current or latest child run

### `delegate_attempts`

- preserves retry history for one logical parent `delegate.*` tool execution
- lets the runtime retry delegation without overwriting the original child run record
- keeps the parent delegate boundary stable while allowing a fresh terminal child attempt when needed
- `attempt = 1` is the original child run; later attempts are explicit runtime retries

### `plan_executions`

- binds a persisted plan to a run
- allows later analysis of how a preserved plan behaved across multiple executions
- `attempt` allows explicit retries without overwriting the original execution record

Delegate retries should follow the same principle: retries create a new `DelegateAttempt` row instead of mutating prior child execution history.

## 5. Migration From v1.3

When migrating an existing v1.3 database, apply the following changes to `agent_runs`:

```sql
alter table agent_runs
  add column root_run_id uuid,
  add column parent_run_id uuid references agent_runs(id) on delete set null,
  add column parent_step_id text,
  add column delegate_name text,
  add column delegation_depth integer not null default 0,
  add column current_child_run_id uuid references agent_runs(id) on delete set null;

update agent_runs
set root_run_id = id
where root_run_id is null;

alter table agent_runs
  alter column root_run_id set not null;

alter table agent_runs
  add constraint agent_runs_root_idx_fk
  foreign key (root_run_id) references agent_runs(id) on delete restrict;

create index agent_runs_root_idx on agent_runs (root_run_id, created_at desc);
create index agent_runs_parent_idx on agent_runs (parent_run_id, created_at desc);
create index agent_runs_delegate_idx on agent_runs (delegate_name, created_at desc);
create index agent_runs_current_child_idx on agent_runs (current_child_run_id);
```

Existing runs should be backfilled as root runs with:

- `root_run_id = id`
- `delegation_depth = 0`
- `parent_run_id = null`
- `current_child_run_id = null`

## 6. Compatibility Rules For Re-Execution

Before `executePlan()` starts, the runtime should verify:

1. every referenced `tool_name` still exists
2. tool input schemas are compatible with the saved step templates
3. any tool approval requirements are still satisfied by host policy
4. no saved `tool_name` starts with `delegate.`
5. the current toolset hash matches the plan's `toolset_hash`, or the host explicitly allows execution on mismatch

If compatibility fails, the run should move to `replan_required` and emit a `replan.required` event rather than silently mutating the saved plan.

## 7. Minimal Resume And Delegation Algorithms

### Operational Guarantees

Runtime persistence provides these guarantees:

- `resume(runId)` loads the latest compatible `run_snapshots` record and fails explicitly if the snapshot shape is missing required fields or uses an incompatible future schema version.
- New snapshots should use `schemaVersion: 1`; unversioned legacy snapshots may be treated as v1-compatible only during the transition window.
- Durable stores provide at-least-once execution by default. They do not claim exactly-once model or tool execution without additional idempotency support.
- Completed durable tool ledger entries keyed by `idempotencyKey` provide runtime-level exactly-once result reuse. If the runtime crashes after a side-effecting tool completes but before the continuation snapshot is saved, a later resume must reuse the completed ledger output instead of invoking the tool again.
- External side effects are exactly-once only when the tool implementation honors `ToolContext.idempotencyKey` against the external system.
- Model calls may replay unless the model response was durably represented in a snapshot before tool execution. A snapshotted model tool-call response may resume from the queued pending tool call instead of calling the model again.
- Terminal run records are stable. Repeated `resume()` calls for `succeeded`, `failed`, or `cancelled` runs should return the stored result or failure without advancing the event log or re-entering the execution loop.
- Parent and child delegate resolution is idempotent. A parent waiting on a terminal child must consume the existing child result exactly once, and linkage mismatches must fail explicitly.
- Retryable delegate failures are resolved inside the delegation boundary. The parent remains on the same logical delegate tool execution while the runtime resumes an interrupted child or creates a new `DelegateAttempt`.
- Gateway reconnect is a session reattachment policy, not a new execution primitive. It should re-present pending approval or clarification state, settle terminal run state, resume expired active run leases when supported, and otherwise subscribe the client as an observer.
- Recovery scanners may identify inconsistent or expired states, but they must acquire the run lease before modifying any run.

### Transaction Boundaries

When the configured stores support transactions, these changes should commit atomically:

- root run creation, initial snapshot, `run.created`, and `snapshot.created`
- non-terminal continuation snapshots and `snapshot.created`
- model tool-call queue snapshots and `snapshot.created`
- tool ledger completion or failure, matching tool event, step completion, and continuation snapshot
- child run creation, parent `awaiting_subagent` state, waiting snapshot, `delegate.spawned`, and child `run.created`
- child terminal resolution into the parent delegate step, parent state update, parent event, and parent snapshot
- terminal run status update, final snapshot, and terminal event

After each transaction, persistent state should describe one valid continuation path. If a process crashes before commit, resume should continue from the previous safe boundary. If it crashes after commit, resume should observe the committed boundary and avoid duplicate side effects.

### Resume Flow

Recommended resume flow:

1. load `agent_runs`
2. acquire lease if available
3. load latest `run_snapshots`
4. restore in-memory execution state from `state`
5. if the run is `awaiting_subagent`, load `currentChildRunId`
6. if the child is terminal, continue the parent from the next boundary
7. if the child is interrupted, resume or fail the child before continuing the parent
8. continue from `current_step_id` or terminalize if already complete

### Execution Loop

Recommended execution loop:

1. append event
2. update run status or usage totals
3. persist snapshot at safe boundaries
4. heartbeat lease periodically
5. if a delegate tool is selected, create a child run and move the parent to `awaiting_subagent`
6. release lease on terminal status

### Gateway Reconnect Flow

On `session.open` with an existing session:

1. authenticate the caller and load the gateway session
2. load `currentRunId`, `currentRootRunId`, and the routed agent when available
3. if the runtime run is terminal, update the session to idle or failed and emit the stored output or error
4. if the run is `awaiting_approval`, keep the session in `awaiting_approval` and re-present the approval request state
5. if the run is `clarification_requested`, re-present the clarification state without starting a new run
6. if the run is active and its lease is expired, call `resume(currentRunId)` when the agent supports resume
7. if the run is active and leased elsewhere, subscribe the connection to session, root run, run, and agent channels as an observer
8. if the runtime run is missing, fail the session explicitly rather than silently clearing it

## 8. Suggested Next Implementation Order

1. define shared TypeScript types in `packages/core/src/types.ts`
2. implement in-memory stores using the same interfaces
3. implement synthetic delegate tool registration from `DelegateDefinition`
4. implement the linear planner and step executor for root and child runs
5. add Postgres stores that satisfy `RunStore`, `EventStore`, `SnapshotStore`, and `PlanStore`
6. wire the dashboard example to the run tree and event stream
