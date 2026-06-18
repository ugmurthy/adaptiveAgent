import { Pool, types } from 'pg';

import {
  createAdaptiveAgentRuntime,
  createPostgresRuntimeStores,
  POSTGRES_RUNTIME_MIGRATIONS,
  type AdaptiveAgentRuntimeOptions,
  type ContinuationStore,
  type EventStore,
  type PlanStore,
  type PostgresClient,
  type PostgresMigrationDefinition,
  type PostgresPoolClient,
  type PostgresRuntimeStoreBundle,
  type PostgresTransactionClient,
  type RunStore,
  type SnapshotStore,
} from '@adaptive-agent/core';

import type { RuntimeMode } from './config-types.js';
import { readBooleanEnv } from './sdk-utils.js';

export async function resolveRuntimeBundle(mode: RuntimeMode, autoMigrate: boolean, env: NodeJS.ProcessEnv = process.env): Promise<{ mode: RuntimeMode; runtime?: AdaptiveAgentRuntimeOptions<RunStore, EventStore, SnapshotStore, PlanStore | undefined, ContinuationStore>; close?: () => Promise<void> }> {
  if (mode === 'memory') return { mode, runtime: createAdaptiveAgentRuntime<RunStore, EventStore, SnapshotStore, PlanStore | undefined>() };
  const pool = createPostgresPool(env);
  if (autoMigrate) await runPostgresRuntimeMigrations(pool);
  const stores = createPostgresRuntimeStores({ client: pool });
  return { mode, runtime: postgresStoresToRuntime(stores), close: () => pool.end() };
}

type CorePool = PostgresPoolClient & { end(): Promise<void> };
const TIMESTAMP_OIDS = [1082, 1114, 1184] as const;
let pgTypesConfigured = false;
function createPostgresPool(env: NodeJS.ProcessEnv): CorePool {
  if (!env.DATABASE_URL) throw new Error('Postgres runtime requires DATABASE_URL.');
  if (!pgTypesConfigured) { for (const oid of TIMESTAMP_OIDS) types.setTypeParser(oid, (value) => value); pgTypesConfigured = true; }
  return new Pool({ connectionString: env.DATABASE_URL, ssl: readBooleanEnv(env.PGSSL) ? { rejectUnauthorized: false } : undefined }) as unknown as CorePool;
}
function postgresStoresToRuntime(stores: PostgresRuntimeStoreBundle): AdaptiveAgentRuntimeOptions<RunStore, EventStore, SnapshotStore, PlanStore | undefined, ContinuationStore> { return { runStore: stores.runStore, eventStore: stores.eventStore, snapshotStore: stores.snapshotStore, planStore: stores.planStore, continuationStore: stores.continuationStore, toolExecutionStore: stores.toolExecutionStore, transactionStore: stores }; }
const CREATE_MIGRATION_TABLE_SQL = `create table if not exists adaptive_agent_migrations (name text primary key, applied_at timestamptz not null default now())`;
async function runPostgresRuntimeMigrations(client: PostgresClient | PostgresPoolClient): Promise<void> { await runWithPostgresTransaction(client, async (tx) => { await tx.query(CREATE_MIGRATION_TABLE_SQL); for (const migration of POSTGRES_RUNTIME_MIGRATIONS) await runMigrationIfNeeded(tx, migration); }); }
async function runMigrationIfNeeded(client: PostgresClient, migration: PostgresMigrationDefinition): Promise<void> { const existing = await client.query<{ name: string }>('SELECT name FROM adaptive_agent_migrations WHERE name = $1', [migration.name]); if (existing.rowCount) return; await client.query(migration.sql); await client.query('INSERT INTO adaptive_agent_migrations (name) VALUES ($1)', [migration.name]); }
async function runWithPostgresTransaction<T>(client: PostgresClient | PostgresPoolClient, operation: (client: PostgresClient) => Promise<T>): Promise<T> { const tx = isPool(client) ? await client.connect() : client; const release = isTx(tx); try { await tx.query('BEGIN'); const result = await operation(tx); await tx.query('COMMIT'); return result; } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { if (release) tx.release(); } }
function isPool(client: PostgresClient | PostgresPoolClient): client is PostgresPoolClient { return typeof (client as PostgresPoolClient).connect === 'function'; }
function isTx(client: PostgresClient): client is PostgresTransactionClient { return typeof (client as PostgresTransactionClient).release === 'function'; }
