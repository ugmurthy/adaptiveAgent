import type { Database } from 'bun:sqlite';

export interface SqliteMigrationDefinition {
  version: number;
  name: string;
  sql: string;
}

export const SQLITE_RUNTIME_SCHEMA_VERSION = 1;

export const SQLITE_RUNTIME_MIGRATIONS: SqliteMigrationDefinition[] = [
  {
    version: 1,
    name: 'core:001_runtime_sqlite',
    sql: `
create table agent_runs (
  id text primary key,
  session_id text,
  root_run_id text not null references agent_runs(id) on delete restrict,
  parent_run_id text references agent_runs(id) on delete set null,
  current_child_run_id text references agent_runs(id) on delete set null,
  status text not null,
  lease_owner text,
  lease_expires_at text,
  heartbeat_at text,
  version integer not null default 0,
  created_at text not null,
  updated_at text not null,
  record_json text not null check (json_valid(record_json))
);

create index agent_runs_root_idx on agent_runs (root_run_id, created_at desc);
create index agent_runs_session_idx on agent_runs (session_id, created_at desc, id) where session_id is not null;
create index agent_runs_parent_idx on agent_runs (parent_run_id, created_at desc);
create index agent_runs_status_idx on agent_runs (status, updated_at asc, id asc);
create index agent_runs_lease_idx on agent_runs (lease_expires_at asc, updated_at asc, id asc);
create index agent_runs_current_child_idx on agent_runs (current_child_run_id);

create table plans (
  id text primary key,
  created_from_run_id text references agent_runs(id) on delete set null,
  parent_plan_id text references plans(id) on delete set null,
  created_at text not null,
  record_json text not null check (json_valid(record_json))
);

create index plans_run_idx on plans (created_from_run_id, created_at desc);
create index plans_parent_idx on plans (parent_plan_id, created_at desc);

create table plan_executions (
  id text primary key,
  plan_id text not null references plans(id) on delete cascade,
  run_id text not null references agent_runs(id) on delete cascade,
  attempt integer not null,
  status text not null,
  created_at text not null,
  updated_at text not null,
  record_json text not null check (json_valid(record_json)),
  unique (run_id, attempt)
);

create index plan_executions_run_idx on plan_executions (run_id, created_at desc);
create index plan_executions_plan_idx on plan_executions (plan_id, created_at desc);

create table agent_events (
  id text primary key,
  run_id text not null references agent_runs(id) on delete cascade,
  plan_execution_id text references plan_executions(id) on delete set null,
  seq integer not null,
  step_id text,
  tool_call_id text,
  event_type text not null,
  schema_version integer not null default 1,
  payload_json text not null check (json_valid(payload_json)),
  created_at text not null,
  unique (run_id, seq)
);

create index agent_events_run_idx on agent_events (run_id, seq);
create index agent_events_type_idx on agent_events (event_type, created_at desc);
create index agent_events_plan_execution_idx on agent_events (plan_execution_id, seq);
create index agent_events_run_tool_call_idx on agent_events (run_id, tool_call_id, seq) where tool_call_id is not null;

create table run_snapshots (
  id text primary key,
  run_id text not null references agent_runs(id) on delete cascade,
  snapshot_seq integer not null,
  status text not null,
  created_at text not null,
  record_json text not null check (json_valid(record_json)),
  unique (run_id, snapshot_seq)
);

create index run_snapshots_run_idx on run_snapshots (run_id, snapshot_seq desc);

create table tool_executions (
  idempotency_key text primary key,
  run_id text not null references agent_runs(id) on delete cascade,
  step_id text not null,
  tool_call_id text not null,
  status text not null,
  child_run_id text references agent_runs(id) on delete set null,
  started_at text not null,
  completed_at text,
  record_json text not null check (json_valid(record_json)),
  unique (run_id, step_id, tool_call_id)
);

create index tool_executions_run_idx on tool_executions (run_id, started_at desc);
create index tool_executions_status_idx on tool_executions (status, started_at asc);
create index tool_executions_child_run_idx on tool_executions (child_run_id) where child_run_id is not null;

create table run_continuations (
  id text primary key,
  source_run_id text not null references agent_runs(id) on delete cascade,
  continuation_run_id text not null references agent_runs(id) on delete cascade,
  created_at text not null,
  record_json text not null check (json_valid(record_json)),
  unique (continuation_run_id)
);

create index run_continuations_source_idx on run_continuations (source_run_id, created_at asc, id asc);
`,
  },
];

export function runSqliteRuntimeMigrations(database: Database): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(`
      create table if not exists adaptive_agent_migrations (
        version integer primary key,
        name text not null unique,
        applied_at text not null
      )
    `);

    for (const migration of SQLITE_RUNTIME_MIGRATIONS) {
      const existing = database
        .query('select version from adaptive_agent_migrations where version = ?')
        .get(migration.version);
      if (existing) continue;

      database.exec(migration.sql);
      database.run(
        'insert into adaptive_agent_migrations (version, name, applied_at) values (?, ?, ?)',
        [migration.version, migration.name, new Date().toISOString()],
      );
    }

    database.exec(`PRAGMA user_version = ${SQLITE_RUNTIME_SCHEMA_VERSION}`);
    database.exec('COMMIT');
  } catch (error) {
    if (database.inTransaction) database.exec('ROLLBACK');
    throw error;
  }
}
