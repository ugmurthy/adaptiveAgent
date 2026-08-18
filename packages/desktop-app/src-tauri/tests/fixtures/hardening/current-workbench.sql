PRAGMA foreign_keys = ON;

CREATE TABLE fixture_identity(
  fixture_version integer primary key,
  agent_id text not null,
  agent_config_path text not null,
  agent_fingerprint text not null,
  workspace_root text not null,
  shell_cwd text not null
);

INSERT INTO fixture_identity VALUES(
  1,
  'fixture-agent',
  '/fixtures/agents/fixture-agent.json',
  'fixture-fingerprint-v1',
  '/fixtures/workspace-before-settings-change',
  '/fixtures/workspace-before-settings-change/project'
);

-- Open a copied fixture through WorkbenchDb to create and validate the current schema. This
-- identity row is intentionally independent of implementation-owned forward migrations.
