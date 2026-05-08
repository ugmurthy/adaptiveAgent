import { access } from 'node:fs/promises';
import { delimiter } from 'node:path';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import {
  createListDirectoryTool,
  createAdaptiveAgentRuntime,
  createPostgresRuntimeStores,
  createReadFileTool,
  createReadWebPageTool,
  createShellExecTool,
  createWebSearchTool,
  createWriteFileTool,
  loadSkillFromDirectory,
  POSTGRES_RUNTIME_MIGRATIONS,
  skillToDelegate,
  type AdaptiveAgentRuntimeOptions,
  type ContinuationStore,
  type DelegateDefinition,
  type EventStore,
  type PlanStore,
  type PostgresClient,
  type PostgresMigrationDefinition,
  type PostgresPoolClient,
  type PostgresRuntimeStoreBundle,
  type PostgresTransactionClient,
  type RunStore,
  type SnapshotStore,
  type ToolDefinition,
} from '@adaptive-agent/core';
import { Pool, types } from 'pg';

export const BUILTIN_LOCAL_TOOL_NAMES = [
  'read_file',
  'list_directory',
  'write_file',
  'shell_exec',
  'web_search',
  'read_web_page',
] as const;

export type BuiltinLocalToolName = (typeof BUILTIN_LOCAL_TOOL_NAMES)[number];
export type RuntimeMode = 'memory' | 'postgres';
export type CoreCliRuntimeOptions = AdaptiveAgentRuntimeOptions<
  RunStore,
  EventStore,
  SnapshotStore,
  PlanStore | undefined,
  ContinuationStore
>;
export type LocalToolDefinition = ToolDefinition<any, any>;

export interface ResolveLocalModulesOptions {
  workspaceRoot: string;
  requestedToolNames: string[];
  requestedDelegateNames: string[];
  skillsDirs?: string[];
  allowExampleSkills?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ResolvedLocalModules {
  tools: LocalToolDefinition[];
  delegates: DelegateDefinition[];
  registeredToolNames: string[];
  skillSearchDirs: string[];
}

export interface RuntimeBundle {
  mode: RuntimeMode;
  runtime?: CoreCliRuntimeOptions;
  close?: () => Promise<void>;
}

export async function resolveLocalModules(options: ResolveLocalModulesOptions): Promise<ResolvedLocalModules> {
  const env = options.env ?? process.env;
  const builtinTools = createBuiltinTools(options.workspaceRoot, env);
  const registeredToolNames = [...builtinTools.keys()].sort();
  const missingToolNames = options.requestedToolNames.filter((toolName) => !builtinTools.has(toolName));

  if (missingToolNames.length > 0) {
    throw new Error(
      `Unknown tool reference(s): ${missingToolNames.join(', ')}. Registered tools: ${formatNameList(registeredToolNames)}.`,
    );
  }

  const tools = options.requestedToolNames.map((toolName) => builtinTools.get(toolName)!);
  const delegates = await loadRequestedDelegates({
    availableToolNames: new Set(tools.map((tool) => tool.name)),
    requestedDelegateNames: options.requestedDelegateNames,
    searchDirs: resolveSkillSearchDirs({
      cwd: options.cwd,
      skillsDirs: options.skillsDirs,
      allowExampleSkills: options.allowExampleSkills,
      env,
    }),
  });

  return {
    tools,
    delegates,
    registeredToolNames,
    skillSearchDirs: resolveSkillSearchDirs({
      cwd: options.cwd,
      skillsDirs: options.skillsDirs,
      allowExampleSkills: options.allowExampleSkills,
      env,
    }),
  };
}

export async function resolveRuntimeBundle(mode: RuntimeMode): Promise<RuntimeBundle> {
  if (mode === 'memory') {
    return { mode, runtime: createAdaptiveAgentRuntime<RunStore, EventStore, SnapshotStore, PlanStore | undefined>() };
  }

  const pool = createCoreCliPostgresPool();
  await runPostgresRuntimeMigrations(pool);
  const stores = createPostgresRuntimeStores({ client: pool });

  return {
    mode,
    runtime: postgresStoresToRuntime(stores),
    close: async () => {
      await pool.end();
    },
  };
}

export function resolveSkillSearchDirs(options: {
  cwd?: string;
  skillsDirs?: string[];
  allowExampleSkills?: boolean;
  env?: NodeJS.ProcessEnv;
}): string[] {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const dirs: string[] = [];

  if (options.skillsDirs && options.skillsDirs.length > 0) {
    dirs.push(...options.skillsDirs);
  } else if (env.ADAPTIVE_AGENT_SKILLS_DIR) {
    dirs.push(...env.ADAPTIVE_AGENT_SKILLS_DIR.split(delimiter).filter(Boolean));
  } else {
    dirs.push(resolve(cwd, 'skills'));
    dirs.push(resolve(homedir(), '.adaptiveAgent', 'skills'));
  }

  if (options.allowExampleSkills) {
    dirs.push(resolve(cwd, 'examples', 'skills'));
  }

  return dirs.map((dir) => resolve(dir));
}

function createBuiltinTools(workspaceRoot: string, env: NodeJS.ProcessEnv): Map<string, LocalToolDefinition> {
  const tools = new Map<string, LocalToolDefinition>();
  tools.set('read_file', createReadFileTool({ allowedRoot: workspaceRoot }));
  tools.set('list_directory', createListDirectoryTool({ allowedRoot: workspaceRoot }));
  tools.set('write_file', createWriteFileTool({ allowedRoot: workspaceRoot }));
  tools.set('shell_exec', createShellExecTool({ cwd: workspaceRoot }));

  const webToolTimeoutMs = parseOptionalPositiveInteger(env.WEB_TOOL_TIMEOUT_MS);
  if (env.WEB_SEARCH_PROVIDER === 'brave') {
    if (env.BRAVE_SEARCH_API_KEY) {
      tools.set(
        'web_search',
        createWebSearchTool({ provider: 'brave', apiKey: env.BRAVE_SEARCH_API_KEY, timeoutMs: webToolTimeoutMs }),
      );
    }
  } else {
    tools.set('web_search', createWebSearchTool({ provider: 'duckduckgo', timeoutMs: webToolTimeoutMs }));
  }

  tools.set('read_web_page', createReadWebPageTool({ timeoutMs: webToolTimeoutMs }));
  return tools;
}

async function loadRequestedDelegates(options: {
  availableToolNames: Set<string>;
  requestedDelegateNames: string[];
  searchDirs: string[];
}): Promise<DelegateDefinition[]> {
  const requestedNames = new Set(options.requestedDelegateNames);
  const loadedDelegates = new Map<string, DelegateDefinition>();

  if (requestedNames.size === 0) {
    return [];
  }

  for (const searchDir of options.searchDirs) {
    if (!(await pathExists(searchDir))) {
      continue;
    }

    for (const delegateName of requestedNames) {
      if (loadedDelegates.has(delegateName)) {
        continue;
      }

      const skillDir = resolve(searchDir, delegateName);
      if (!(await pathExists(skillDir))) {
        continue;
      }

      const skill = await loadSkillFromDirectory(skillDir);
      const delegate = skillToDelegate(skill);
      if (delegate.name !== delegateName) {
        throw new Error(`Delegate "${delegateName}" loaded from ${skillDir} declared skill name "${delegate.name}".`);
      }

      const missingToolNames = delegate.allowedTools.filter((toolName) => !options.availableToolNames.has(toolName));
      if (missingToolNames.length > 0) {
        throw new Error(
          `Delegate "${delegate.name}" requires unavailable tool(s): ${missingToolNames.join(', ')}. Root agent tools: ${formatNameList([...options.availableToolNames].sort())}.`,
        );
      }

      loadedDelegates.set(delegateName, delegate);
    }
  }

  const missingDelegateNames = [...requestedNames].filter((delegateName) => !loadedDelegates.has(delegateName));
  if (missingDelegateNames.length > 0) {
    throw new Error(
      `Unable to load delegate(s): ${missingDelegateNames.join(', ')}. Skill search dirs: ${formatNameList(options.searchDirs)}.`,
    );
  }

  return options.requestedDelegateNames.map((delegateName) => loadedDelegates.get(delegateName)!);
}

type CoreCliPostgresPool = PostgresPoolClient & { end(): Promise<void> };

const TIMESTAMP_OIDS = [1082, 1114, 1184] as const;
let pgTypeParsersConfigured = false;

function createCoreCliPostgresPool(): CoreCliPostgresPool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('Postgres runtime requires DATABASE_URL.');
  }

  configurePgTypeParsers();
  const pool = new Pool({
    connectionString,
    ssl: readBooleanEnv(process.env.PGSSL) ? { rejectUnauthorized: false } : undefined,
  });

  return pool as unknown as CoreCliPostgresPool;
}

function postgresStoresToRuntime(stores: PostgresRuntimeStoreBundle): CoreCliRuntimeOptions {
  return {
    runStore: stores.runStore,
    eventStore: stores.eventStore,
    snapshotStore: stores.snapshotStore,
    planStore: stores.planStore,
    continuationStore: stores.continuationStore,
    toolExecutionStore: stores.toolExecutionStore,
    transactionStore: stores,
  };
}

const CREATE_MIGRATION_TABLE_SQL = `
create table if not exists adaptive_agent_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
)
`;

async function runPostgresRuntimeMigrations(client: PostgresClient | PostgresPoolClient): Promise<void> {
  await runWithPostgresTransaction(client, async (transactionClient) => {
    await transactionClient.query(CREATE_MIGRATION_TABLE_SQL);
    for (const migration of POSTGRES_RUNTIME_MIGRATIONS) {
      await runMigrationIfNeeded(transactionClient, migration);
    }
  });
}

async function runMigrationIfNeeded(client: PostgresClient, migration: PostgresMigrationDefinition): Promise<void> {
  const existing = await client.query<{ name: string }>('SELECT name FROM adaptive_agent_migrations WHERE name = $1', [
    migration.name,
  ]);
  if (existing.rowCount > 0) {
    return;
  }

  await client.query(migration.sql);
  await client.query('INSERT INTO adaptive_agent_migrations (name) VALUES ($1)', [migration.name]);
}

async function runWithPostgresTransaction<T>(
  client: PostgresClient | PostgresPoolClient,
  operation: (client: PostgresClient) => Promise<T>,
): Promise<T> {
  const transactionClient = isPostgresPoolClient(client) ? await client.connect() : client;
  const shouldRelease = isPostgresTransactionClient(transactionClient);

  try {
    await transactionClient.query('BEGIN');
    const result = await operation(transactionClient);
    await transactionClient.query('COMMIT');
    return result;
  } catch (error) {
    await transactionClient.query('ROLLBACK');
    throw error;
  } finally {
    if (shouldRelease) {
      transactionClient.release();
    }
  }
}

function isPostgresPoolClient(client: PostgresClient | PostgresPoolClient): client is PostgresPoolClient {
  return typeof (client as PostgresPoolClient).connect === 'function';
}

function isPostgresTransactionClient(client: PostgresClient): client is PostgresTransactionClient {
  return typeof (client as PostgresTransactionClient).release === 'function';
}

function configurePgTypeParsers(): void {
  if (pgTypeParsersConfigured) {
    return;
  }

  for (const oid of TIMESTAMP_OIDS) {
    types.setTypeParser(oid, (value) => value);
  }

  pgTypeParsersConfigured = true;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function formatNameList(values: string[]): string {
  return values.length > 0 ? values.join(', ') : '(none)';
}

function parseOptionalPositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function readBooleanEnv(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}
