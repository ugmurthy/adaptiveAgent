alter table agent_runs
  add column if not exists execution_context jsonb;
