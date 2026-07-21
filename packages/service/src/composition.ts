import { POSTGRES_RUNTIME_MIGRATIONS } from '@adaptive-agent/core';
import { runServicePostgresMigrations } from '@adaptive-agent/service-sdk';
import { Pool } from 'pg';
import { ArtifactManager, PostgresArtifactRepository, S3ArtifactStorage } from './artifacts.js';
import type { QueueRoutes } from './queue.js';

const SENSITIVE_ENV_NAME = /(?:^|_)(?:API_KEY|ACCESS_KEY(?:_ID)?|SECRET(?:_ACCESS_KEY)?|PASSWORD|PASSWD|TOKEN|PRIVATE_KEY|CREDENTIALS?|AUTHORIZATION|COOKIE)(?:_|$)/i;

export function printEnvironmentIfRequested(program: string, env: NodeJS.ProcessEnv = process.env): void {
  if (env.PRINT_ENV_VARS !== '1') return;
  const variables = Object.fromEntries(Object.entries(env).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => [name, printableEnvValue(name, value ?? '')]));
  console.info(JSON.stringify({ type: 'service.environment', program, variables }));
}

function printableEnvValue(name: string, value: string): string {
  if (SENSITIVE_ENV_NAME.test(name)) return '[REDACTED]';
  if (!name.endsWith('_URL')) return value;
  try {
    const url = new URL(value);
    if (url.password) url.password = '[REDACTED]';
    for (const key of url.searchParams.keys()) {
      if (SENSITIVE_ENV_NAME.test(key)) url.searchParams.set(key, '[REDACTED]');
    }
    return url.toString();
  } catch {
    return value.replace(/:\/\/([^:/?#]+):([^@/?#]+)@/, '://$1:[REDACTED]@');
  }
}

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

export function createArtifactManagerFromEnv(pool: Pool, env: NodeJS.ProcessEnv = process.env): { manager:ArtifactManager; storage:S3ArtifactStorage } {
  const bucket=env.ARTIFACT_S3_BUCKET;
  if(!bucket)throw new Error('ARTIFACT_S3_BUCKET is required');
  if(Boolean(env.ARTIFACT_S3_ACCESS_KEY_ID)!==Boolean(env.ARTIFACT_S3_SECRET_ACCESS_KEY))throw new Error('Both artifact S3 credentials must be configured together');
  const encryption=env.ARTIFACT_S3_SERVER_SIDE_ENCRYPTION??'AES256';
  if(encryption!=='AES256'&&encryption!=='none')throw new Error('ARTIFACT_S3_SERVER_SIDE_ENCRYPTION must be AES256 or none');
  const storage=new S3ArtifactStorage(bucket,{
    region:env.ARTIFACT_S3_REGION??'us-east-1',endpoint:env.ARTIFACT_S3_ENDPOINT,
    accessKeyId:env.ARTIFACT_S3_ACCESS_KEY_ID,secretAccessKey:env.ARTIFACT_S3_SECRET_ACCESS_KEY,
    forcePathStyle:env.ARTIFACT_S3_FORCE_PATH_STYLE==='true',serverSideEncryption:encryption==='AES256'?'AES256':undefined,
  });
  const quotas={
    maxFiles:positiveInt(env.ARTIFACT_MAX_FILES,20),
    maxFileBytes:positiveInt(env.ARTIFACT_MAX_FILE_BYTES,50*1024*1024),
    maxTotalBytes:positiveInt(env.ARTIFACT_MAX_TOTAL_BYTES,100*1024*1024),
  };
  return {storage,manager:new ArtifactManager(new PostgresArtifactRepository(pool),storage,undefined,quotas,
    positiveInt(env.ARTIFACT_RETENTION_DAYS,7)*24*60*60*1000,
    positiveInt(env.ARTIFACT_QUARANTINE_RETENTION_DAYS,30)*24*60*60*1000)};
}
