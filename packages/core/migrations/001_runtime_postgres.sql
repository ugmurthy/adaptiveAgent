create extension if not exists pgcrypto;

create table if not exists agent_runs (
  id uuid primary key,
  session_id text,
  root_run_id uuid not null,
  parent_run_id uuid references agent_runs(id) on delete set null,
  parent_step_id text,
  delegate_name text,
  delegation_depth integer not null default 0,
  current_child_run_id uuid references agent_runs(id) on delete set null,
  goal text not null,
  input jsonb,
  context jsonb,
  model_provider text,
  model_name text,
  model_parameters jsonb,
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
  total_reasoning_tokens integer,
  estimated_cost_usd numeric(18, 8) not null default 0,
  result jsonb,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists agent_runs_root_idx on agent_runs (root_run_id, created_at desc);
create index if not exists agent_runs_session_idx on agent_runs (session_id, created_at desc, id) where session_id is not null;
create index if not exists agent_runs_parent_idx on agent_runs (parent_run_id, created_at desc);
create index if not exists agent_runs_delegate_idx on agent_runs (delegate_name, created_at desc);
create index if not exists agent_runs_status_idx on agent_runs (status, updated_at asc, id asc);
create index if not exists agent_runs_lease_idx on agent_runs (lease_expires_at asc, updated_at asc, id asc);
create index if not exists agent_runs_current_child_idx on agent_runs (current_child_run_id);

create table if not exists plans (
  id uuid primary key,
  version integer not null,
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

create index if not exists plans_run_idx on plans (created_from_run_id, created_at desc);
create index if not exists plans_parent_idx on plans (parent_plan_id, created_at desc);

create table if not exists plan_steps (
  plan_id uuid not null references plans(id) on delete cascade,
  step_index integer not null,
  step_key text not null,
  title text not null,
  tool_name text not null,
  input_template jsonb not null,
  output_key text,
  preconditions jsonb,
  failure_policy text not null,
  requires_approval boolean not null default false,
  primary key (plan_id, step_index),
  unique (plan_id, step_key)
);

create index if not exists plan_steps_tool_idx on plan_steps (tool_name, plan_id, step_index);

create table if not exists plan_executions (
  id uuid primary key,
  plan_id uuid not null references plans(id) on delete cascade,
  run_id uuid not null references agent_runs(id) on delete cascade,
  attempt integer not null,
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

create index if not exists plan_executions_run_idx on plan_executions (run_id, created_at desc);
create index if not exists plan_executions_plan_idx on plan_executions (plan_id, created_at desc);

alter table agent_runs
  add constraint agent_runs_root_run_fk
  foreign key (root_run_id) references agent_runs(id) on delete restrict;

alter table agent_runs
  add constraint agent_runs_current_plan_fk
  foreign key (current_plan_id) references plans(id) on delete set null;

alter table agent_runs
  add constraint agent_runs_current_plan_execution_fk
  foreign key (current_plan_execution_id) references plan_executions(id) on delete set null;

create table if not exists agent_events (
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

create index if not exists agent_events_run_idx on agent_events (run_id, seq);
create index if not exists agent_events_type_idx on agent_events (event_type, created_at desc);
create index if not exists agent_events_plan_execution_idx on agent_events (plan_execution_id, seq);

create table if not exists run_snapshots (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references agent_runs(id) on delete cascade,
  snapshot_seq bigint not null,
  schema_version integer not null default 1,
  status text not null,
  current_step_id text,
  current_plan_id uuid references plans(id) on delete set null,
  current_plan_execution_id uuid references plan_executions(id) on delete set null,
  summary jsonb not null default '{}'::jsonb,
  state jsonb not null,
  created_at timestamptz not null default now(),
  unique (run_id, snapshot_seq)
);

create index if not exists run_snapshots_run_idx on run_snapshots (run_id, snapshot_seq desc);

create table if not exists tool_executions (
  run_id uuid not null references agent_runs(id) on delete cascade,
  step_id text not null,
  tool_call_id text not null,
  tool_name text not null,
  idempotency_key text not null,
  status text not null,
  input_hash text not null,
  output jsonb,
  error_code text,
  error_message text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (run_id, step_id, tool_call_id),
  unique (idempotency_key)
);

create index if not exists tool_executions_run_idx on tool_executions (run_id, started_at desc);
create index if not exists tool_executions_status_idx on tool_executions (status, started_at asc);
