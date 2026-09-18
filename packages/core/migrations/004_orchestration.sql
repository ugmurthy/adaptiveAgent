create table if not exists orchestration_executions (
  id uuid primary key, status text not null, version integer not null default 0,
  created_at timestamptz not null, updated_at timestamptz not null, record_json jsonb not null
);
create index if not exists orchestration_executions_status_idx on orchestration_executions(status,updated_at,id);
create table if not exists orchestration_stages (
  execution_id uuid not null references orchestration_executions(id) on delete cascade,
  node_id text not null, run_id uuid not null unique, status text not null,
  dependencies jsonb not null default '[]'::jsonb, version integer not null default 0,
  created_at timestamptz not null, updated_at timestamptz not null, record_json jsonb not null,
  primary key(execution_id,node_id)
);
create index if not exists orchestration_stages_ready_idx on orchestration_stages(execution_id,status,node_id);
