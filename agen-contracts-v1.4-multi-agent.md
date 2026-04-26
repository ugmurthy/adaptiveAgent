# AdaptiveAgent Multi-Agent Delta

This document extends [agen-contracts-v1.3.md](file:///Users/ugmurthy/riding-amp/AgentSmith/agen-contracts-v1.3.md) with the minimum contract and schema changes needed to support a supervisor agent that delegates work to sub-agents.

The goal is to add hierarchical execution without turning the runtime into a general workflow engine.

## 1. Scope And Constraints

- A supervisor run may spawn child runs.
- A child run is a normal `AgentRun` with parent linkage.
- Delegation is exposed to the planner as synthetic tools such as `delegate.researcher`.
- `Tool` remains the only first-class executable primitive.
- Preserved plans remain linear and tool-only for deterministic `executePlan()` re-execution.
- v1 multi-agent allows only one active child run per parent run at a time.
- Delegation depth must be bounded.

Out of scope for this delta:

- parallel child runs
- child-to-child messaging
- mailbox or queue primitives
- delegate steps inside preserved plans
- tree-wide total ordering of events

## 2. TypeScript Contract Delta

### 2.1 New And Updated Types

Replace `RunStatus` with:

```ts
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
```

Replace `EventType` with:

```ts
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
```

Add the following new interfaces:

```ts
export interface DelegationPolicy {
  maxDepth?: number;
  maxChildrenPerRun?: number;
  allowRecursiveDelegation?: boolean;
  childRunsMayRequestApproval?: boolean;
  childRunsMayRequestClarification?: boolean;
  maxDelegateRetries?: number;
  retryableChildErrorCodes?: string[];
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
```

### 2.2 `ToolContext`

Replace `ToolContext` with:

```ts
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
```

These hierarchy fields let any tool execution know whether it is running inside a delegated child run.

### 2.3 `AgentRun`

Replace `AgentRun` with:

```ts
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
```

Semantics:

- `rootRunId` is the top-most run in the tree.
- `parentRunId` is set only for delegated child runs.
- `parentStepId` is the supervisor step that spawned the child.
- `delegateName` is the stable delegate profile used to create the child.
- `delegationDepth` is `0` for the root run, `1` for direct children, and so on.
- `currentChildRunId` is the single active child run the parent is waiting on.
- delegate retry history belongs to runtime execution state, not to a persisted plan step.

### 2.4 `RunStore`

Replace `RunStore` with:

```ts
export interface RunStore {
  createRun(run: {
    id?: UUID;
    rootRunId?: UUID;
    parentRunId?: UUID;
    parentStepId?: string;
    delegateName?: string;
    delegationDepth?: number;
    goal: string;
    input?: JsonValue;
    context?: Record<string, JsonValue>;
    metadata?: Record<string, JsonValue>;
    status: RunStatus;
    currentChildRunId?: UUID;
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
```

Notes:

- `id` is now optional so the runtime may pre-allocate UUIDs before creating linked parent and child runs.
- `rootRunId` should equal `id` for a root run.
- Child runs inherit `rootRunId` from their parent.

### 2.5 Event Payload Conventions

Keep `AgentEvent` unchanged, but standardize delegation payloads.

When the parent invokes a delegate tool:

- `tool.started` payload should include `toolName`, `delegateName`, and `childRunId`.
- `delegate.spawned` payload should follow `DelegateSpawnedPayload`.
- `delegate.retried` payload should follow `DelegateRetriedPayload`.
- `tool.completed` and `tool.failed` payload should include `toolName`, `delegateName`, and `childRunId`.

The child run continues to emit ordinary `run.*`, `step.*`, and `tool.*` events under its own `runId`.

### 2.6 Preserved Plan Rules

`PlanArtifact`, `PlanStep`, `PlanExecution`, `PlanRequest`, and `ExecutePlanRequest` do not change in this delta.

Instead, add these rules:

- Delegate tools use a reserved `delegate.` namespace at runtime.
- Internal ephemeral plans created during `run()` may contain delegate steps.
- Persisted plans created by `plan()` must not contain delegate steps.
- `executePlan()` must treat any saved step whose `toolName` starts with `delegate.` as incompatible and emit `replan.required`.

This preserves the v1.3 guarantee that `executePlan()` is deterministic relative to a saved linear tool plan.

### 2.7 Result Envelope

`RunResult` does not change in this delta.

Supervisor-visible child failures should map to the parent run's existing failure path, typically:

```ts
{ status: 'failure', code: 'TOOL_ERROR', ... }
```

An explicit `SUBAGENT_ERROR` code can be added later if analytics or UX demand it.

## 3. Runtime Rules

### 3.1 Delegation Behavior

At runtime, each `DelegateDefinition` is surfaced to the model as a synthetic tool:

- delegate tool name: `delegate.${delegate.name}`
- delegate tool input: `DelegateToolInput`

When invoked, the runtime must:

1. create a child run with `parentRunId`, `parentStepId`, `delegateName`, and inherited `rootRunId`
2. move the parent run to `awaiting_subagent`
3. set `currentChildRunId` on the parent run
4. emit `delegate.spawned`
5. execute the child run
6. on child completion, clear `currentChildRunId`, restore the parent to `running`, and treat the child output as the delegate tool result

### 3.2 Required Guardrails

The runtime should enforce all of the following:

- only one active child run per parent at a time
- `maxDepth` defaults to `1`
- `maxChildrenPerRun` defaults to a small bounded value such as `5`
- recursive self-delegation is disallowed unless explicitly enabled
- interrupting a parent should best-effort interrupt its active child
- resuming a parent in `awaiting_subagent` must inspect the child run before continuing
- retrying a delegate must stay inside the same logical parent `delegate.*` execution

### 3.3 Child Run Interactions

For the first multi-agent iteration:

- child runs should be treated as non-interactive
- if a child run reaches `approval_requested`, the runtime should fail that child and surface the failure to the parent
- if a child run reaches `clarification_requested`, the runtime should fail that child and surface the failure to the parent

This keeps approvals and clarifications owned by the supervisor or host, rather than creating nested interaction flows.

## 4. Postgres Schema Delta

### 4.1 `agent_runs` Migration

Apply the following migration to the v1.3 schema:

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
  add constraint agent_runs_root_run_fk
  foreign key (root_run_id) references agent_runs(id) on delete restrict;

alter table agent_runs
  add constraint agent_runs_delegation_depth_chk
  check (delegation_depth >= 0);

create index agent_runs_root_idx on agent_runs (root_run_id, created_at desc);
create index agent_runs_parent_idx on agent_runs (parent_run_id, created_at desc);
create index agent_runs_delegate_idx on agent_runs (delegate_name, created_at desc);
create index agent_runs_current_child_idx on agent_runs (current_child_run_id);
```

Add a retry history table for logical parent delegate executions:

```sql
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
```

For a fresh schema, the `agent_runs` table becomes:

```sql
create table agent_runs (
  id uuid primary key default gen_random_uuid(),
  root_run_id uuid not null,
  parent_run_id uuid,
  parent_step_id text,
  delegate_name text,
  delegation_depth integer not null default 0,
  current_child_run_id uuid,
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
  foreign key (root_run_id) references agent_runs(id) on delete restrict,
  foreign key (parent_run_id) references agent_runs(id) on delete set null,
  foreign key (current_child_run_id) references agent_runs(id) on delete set null,
  check (delegation_depth >= 0)
);

create index agent_runs_status_idx on agent_runs (status, updated_at desc);
create index agent_runs_lease_idx on agent_runs (lease_expires_at);
create index agent_runs_root_idx on agent_runs (root_run_id, created_at desc);
create index agent_runs_parent_idx on agent_runs (parent_run_id, created_at desc);
create index agent_runs_delegate_idx on agent_runs (delegate_name, created_at desc);
create index agent_runs_current_child_idx on agent_runs (current_child_run_id);
```

### 4.2 `agent_events`

No new columns are required for `agent_events` in the minimal design.

Delegation linkage is stored in event payloads and discovered through the run tree in `agent_runs`.

This avoids turning the event log into a second orchestration graph.

### 4.3 `run_snapshots`

No table changes are required for `run_snapshots`.

The existing `state jsonb` field should include delegation wait state when relevant, for example:

```json
{
  "waitingOnChildRunId": "8c2b5f0b-8295-49cd-bd60-d0e40a4ec631",
  "waitingOnDelegateName": "researcher"
}
```

### 4.4 `plans`, `plan_steps`, And `plan_executions`

No schema changes are required for the minimal design.

Compatibility rules change instead:

- if a stored `plan_steps.tool_name` starts with `delegate.` then `executePlan()` must mark the run as `replan_required`
- the runtime must not silently convert delegate steps into new child runs during deterministic re-execution

## 5. Migration Notes

- Store implementations may need to generate run IDs in the runtime before inserting rows so `id` and `root_run_id` can be written together.
- Existing runs can be backfilled by setting `root_run_id = id` and `delegation_depth = 0`.
- Existing dashboards can stay functional by treating parent and child runs as separate rows until a tree view is added.

## 6. Example Execution Trace

A typical delegated sequence looks like this:

1. root run emits `run.created`
2. parent step emits `tool.started` for `delegate.researcher`
3. parent emits `delegate.spawned` with `childRunId`
4. child run emits `run.created`
5. child run performs normal `step.*` and `tool.*` events
6. child run emits `run.completed`
7. parent emits `tool.completed` for `delegate.researcher`
8. parent continues its own next step

Every run keeps its own event sequence. Tree relationships are reconstructed using `rootRunId`, `parentRunId`, and `currentChildRunId`.

When a child fails with a retryable error such as model timeout:

- if the child is `interrupted`, the runtime should prefer `resume(childRunId)` so completed child work can be reused
- if the child is terminal `failed`, the runtime may create a fresh child attempt linked to the same parent step and emit `delegate.retried`
- the parent remains in `awaiting_subagent` until one child attempt succeeds or the retry budget is exhausted
