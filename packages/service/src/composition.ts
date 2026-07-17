import { POSTGRES_RUNTIME_MIGRATIONS } from '@adaptive-agent/core';
import { runServicePostgresMigrations } from '@adaptive-agent/service-sdk';
import { Pool } from 'pg';
import type { QueueRoutes } from './queue.js';

export function createPoolFromEnv(env: NodeJS.ProcessEnv = process.env): Pool {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  return new Pool({ connectionString: env.DATABASE_URL, max: positiveInt(env.PG_POOL_SIZE, 10) });
}

export async function runBackendMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("select pg_advisory_xact_lock(hashtext('adaptive-agent:migrations'))");
    await client.query('create table if not exists adaptive_agent_migrations (name text primary key, applied_at timestamptz not null default now())');
    for (const migration of POSTGRES_RUNTIME_MIGRATIONS) {
      const applied = await client.query('select 1 from adaptive_agent_migrations where name=$1', [migration.name]);
      if (!applied.rowCount) {
        await client.query(migration.sql);
        await client.query('insert into adaptive_agent_migrations(name) values($1)', [migration.name]);
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
  await runServicePostgresMigrations(pool);
}

export function queueRoutesFromEnv(env: NodeJS.ProcessEnv = process.env): QueueRoutes {
  return {
    run: { name: env.RUN_QUEUE ?? 'agent-run', concurrency: positiveInt(env.RUN_CONCURRENCY, 4) },
    chat: { name: env.CHAT_QUEUE ?? 'agent-chat', concurrency: positiveInt(env.CHAT_CONCURRENCY, 4) },
    swarm: { name: env.SWARM_QUEUE ?? 'agent-swarm', concurrency: positiveInt(env.SWARM_CONCURRENCY, 1) },
    orchestration: { name: env.ORCHESTRATION_QUEUE ?? 'agent-orchestration', concurrency: positiveInt(env.ORCHESTRATION_CONCURRENCY, 2) },
  };
}
export function redisConnection(env: NodeJS.ProcessEnv = process.env): { url: string; maxRetriesPerRequest: null } {
  if (!env.REDIS_URL) throw new Error('REDIS_URL is required');
  return { url: env.REDIS_URL, maxRetriesPerRequest: null };
}
export function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Expected positive integer, received ${value}`);
  return parsed;
}
