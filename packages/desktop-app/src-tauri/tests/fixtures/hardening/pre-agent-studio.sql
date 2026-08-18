PRAGMA foreign_keys = ON;

CREATE TABLE desktop_migrations(version integer primary key, applied_at text not null);
CREATE TABLE workbench_items(
  id text primary key,
  kind text not null,
  title text not null,
  session_id text,
  pinned_agent_name text,
  pinned_agent_fingerprint text,
  pinned_agent_config_path text,
  created_at text not null,
  updated_at text not null
);
CREATE TABLE workbench_runs(
  run_id text primary key,
  item_id text not null references workbench_items(id) on delete cascade,
  invocation_kind text not null,
  cached_status text not null,
  submission_state text not null,
  created_at text not null,
  updated_at text not null
);

INSERT INTO workbench_items VALUES(
  'legacy-item', 'task', 'Preserve legacy history', NULL, 'Legacy Agent',
  'legacy-fingerprint', '/fixtures/agents/legacy.json', '1700000000000', '1700000000000'
);
INSERT INTO workbench_runs VALUES(
  'legacy-run', 'legacy-item', 'run', 'succeeded', 'submitted', '1700000000000', '1700000000000'
);
