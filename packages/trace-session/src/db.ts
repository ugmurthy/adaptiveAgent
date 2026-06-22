import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { Pool, types } from 'pg';

import type { PostgresClient } from './trace-session/data.js';

const TIMESTAMP_OIDS = [1082, 1114, 1184] as const;

let pgTypeParsersConfigured = false;

export interface TracePostgresConfig {
  connectionString: string;
  ssl?: boolean;
}

export interface TraceConfigOptions {
  configPath?: string;
  databaseUrl?: string;
  databaseUrlEnv?: string;
  ssl?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export type TracePostgresPool = PostgresClient & {
  end(): Promise<void>;
};

export async function resolveTracePostgresConfig(options: TraceConfigOptions = {}): Promise<TracePostgresConfig> {
  const env = options.env ?? process.env;
  const envName = options.databaseUrlEnv ?? 'DATABASE_URL';
  const explicitConnectionString = options.databaseUrl ?? env[envName];
  const config = explicitConnectionString
    ? { connectionString: explicitConnectionString }
    : options.configPath
      ? await loadTraceConfigFile(expandPath(options.configPath, options.cwd))
      : undefined;

  if (!config?.connectionString) {
    throw new Error(`trace-session requires a Postgres connection string. Pass --database-url, set ${envName}, or pass --config <path>.`);
  }

  return {
    connectionString: config.connectionString,
    ssl: options.ssl ?? config.ssl ?? readBoolean(env.PGSSL),
  };
}

export function createTracePostgresPool(config: TracePostgresConfig, options: { password?: string } = {}): TracePostgresPool {
  configurePgTypeParsers();

  const pool = new Pool({
    connectionString: options.password ? connectionStringWithPassword(config.connectionString, options.password) : config.connectionString,
    password: options.password,
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
  });

  return pool as unknown as TracePostgresPool;
}

async function loadTraceConfigFile(path: string): Promise<TracePostgresConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf-8'));
  } catch (error) {
    throw new Error(`Unable to read trace-session config at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid trace-session config at ${path}: expected a JSON object.`);
  }

  const root = parsed as Record<string, unknown>;
  const stores = root.stores && typeof root.stores === 'object' ? root.stores as Record<string, unknown> : undefined;
  const postgres = root.postgres && typeof root.postgres === 'object' ? root.postgres as Record<string, unknown> : undefined;
  const candidate = postgres ?? stores ?? root;
  const connectionString = readString(candidate.connectionString) ?? readString(candidate.databaseUrl);
  const urlEnv = readString(candidate.urlEnv) ?? readString(candidate.databaseUrlEnv);

  if (connectionString) {
    return { connectionString, ssl: readOptionalBoolean(candidate.ssl) };
  }
  if (urlEnv) {
    const envValue = process.env[urlEnv];
    if (!envValue) {
      throw new Error(`Trace config ${path} references ${urlEnv}, but that environment variable is not set.`);
    }
    return { connectionString: envValue, ssl: readOptionalBoolean(candidate.ssl) };
  }
  throw new Error(`Invalid trace-session config at ${path}: expected connectionString, databaseUrl, urlEnv, or databaseUrlEnv.`);
}

function expandPath(path: string, cwd = process.cwd()): string {
  if (path === '~') {
    return homedir();
  }
  if (path.startsWith('~/')) {
    return resolve(homedir(), path.slice(2));
  }
  return resolve(cwd, path);
}

function connectionStringWithPassword(connectionString: string, password: string): string {
  try {
    const url = new URL(connectionString);
    url.password = password;
    return url.toString();
  } catch {
    return connectionString;
  }
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

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === '1' || value === 'yes';
}
