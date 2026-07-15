import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

import type { CliOptions, SessionUsageSummary, TraceReport } from './types.js';

const VERSION = 3;
const DEFAULT_TERMINAL_TTL = 5 * 60_000;
const MAX_BYTES = 100 * 1024 * 1024;
const TEMP_FILE_GRACE_MS = 10 * 60_000;

export type CacheValue = TraceReport | SessionUsageSummary;
interface Entry { version: number; createdAt: number; expiresAt: number; terminal: boolean; value: CacheValue }

export function parseCacheDuration(value: string, source = '--cache-ttl'): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(value.trim());
  if (!match) throw new Error(`${source} requires a non-negative duration using ms, s, m, h, or d (for example 0, 30s, or 5m).`);
  const factors: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const result = Number(match[1]) * factors[match[2] ?? 'ms'];
  if (!Number.isFinite(result) || result < 0) throw new Error(`${source} is outside the supported duration range.`);
  return result;
}

export function effectiveCacheTtl(terminal: boolean, override?: number): number {
  return override ?? (terminal ? DEFAULT_TERMINAL_TTL : 0);
}

export function databaseIdentity(connectionString: string, env = process.env): string {
  let sanitizedConnection: string;
  try {
    const url = new URL(connectionString);
    url.password = '';
    url.hostname = url.hostname.toLowerCase();
    if (url.port === '5432') url.port = '';
    url.searchParams.delete('password');
    url.searchParams.sort();
    sanitizedConnection = url.toString();
  } catch {
    sanitizedConnection = connectionString;
  }
  const environment = Object.entries(env)
    .filter(([key, value]) => value !== undefined && ((key.startsWith('PG') && key !== 'PGPASSWORD') || key === 'USER' || key === 'USERNAME'))
    .sort(([left], [right]) => left.localeCompare(right));
  const identity = JSON.stringify({ connection: sanitizedConnection, environment });
  return createHash('sha256').update(identity).digest('hex');
}

export function cacheKey(config: { connectionString: string }, options: CliOptions, kind: 'trace' | 'usage'): string {
  const target = options.sessionId
    ? ['session', options.sessionId, options.rootRunId ?? null]
    : options.rootRunId
      ? ['root-run', options.rootRunId]
      : ['run', options.runId];
  const variant = kind === 'usage' ? {} : {
    messages: Boolean(options.messages || options.systemOnly || options.view === 'messages'),
    reasoning: Boolean(options.reasoning), includePlans: options.includePlans,
    focusRunId: options.focusRunId ?? null, onlyDelegates: options.onlyDelegates,
  };
  return createHash('sha256').update(JSON.stringify({ version: VERSION, db: databaseIdentity(config.connectionString), kind, target, variant })).digest('hex');
}

export function cacheDirectory(env = process.env): string {
  if (env.TRACE_SESSION_CACHE_DIR) return env.TRACE_SESSION_CACHE_DIR;
  const base = platform() === 'darwin' ? join(homedir(), 'Library', 'Caches') : env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(base, 'adaptive-agent', 'trace-session');
}

export async function readCache(key: string, ttlOverride?: number, dir = cacheDirectory()): Promise<CacheValue | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, `${key}.json`), 'utf8')) as Entry;
    if (parsed.version !== VERSION || typeof parsed.createdAt !== 'number' || typeof parsed.expiresAt !== 'number' || typeof parsed.terminal !== 'boolean' || !('value' in parsed)) return undefined;
    const ttl = effectiveCacheTtl(parsed.terminal, ttlOverride);
    if (ttl <= 0 || Date.now() >= parsed.expiresAt || Date.now() - parsed.createdAt >= ttl) return undefined;
    return parsed.value;
  } catch { return undefined; }
}

export async function writeCache(key: string, value: CacheValue, terminal: boolean, ttlOverride?: number, dir = cacheDirectory()): Promise<void> {
  const ttl = effectiveCacheTtl(terminal, ttlOverride);
  if (ttl <= 0) return;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await prune(dir);
  const path = join(dir, `${key}.json`);
  const temp = join(dir, `.${key}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const createdAt = Date.now();
  try {
    await writeFile(temp, JSON.stringify({ version: VERSION, createdAt, expiresAt: createdAt + ttl, terminal, value } satisfies Entry), { mode: 0o600, flag: 'wx' });
    await chmod(temp, 0o600);
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
  await prune(dir);
}

async function prune(dir: string): Promise<void> {
  const names = (await readdir(dir)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name) || /^\.[a-f0-9]{64}\.\d+\.[a-f0-9]+\.tmp$/.test(name));
  const details = await Promise.all(names.map(async name => ({ name, temporary: name.startsWith('.'), ...(await stat(join(dir, name))) })));
  let total = details.reduce((sum, file) => sum + file.size, 0);
  for (const file of details.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (file.temporary) {
      if (Date.now() - file.mtimeMs >= TEMP_FILE_GRACE_MS) {
        await rm(join(dir, file.name), { force: true });
        total -= file.size;
      }
      continue;
    }
    let expired = false;
    try {
      const entry = JSON.parse(await readFile(join(dir, file.name), 'utf8')) as Entry;
      expired = entry.version !== VERSION || typeof entry.expiresAt !== 'number' || Date.now() >= entry.expiresAt;
    } catch { expired = true; }
    if (expired || total > MAX_BYTES) { await rm(join(dir, file.name), { force: true }); total -= file.size; }
  }
}

export function isTerminalReport(report: TraceReport): boolean {
  return report.rootRuns.length > 0 && report.rootRuns.every(run => ['succeeded', 'failed', 'cancelled'].includes(run.status ?? ''));
}
