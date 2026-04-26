import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import type { JsonObject } from './core.js';
import { GATEWAY_LOG_EVENTS, type GatewayLogger } from './observability.js';
import type { GatewayCronJobRecord, GatewayStores } from './stores.js';

export interface CronFileSyncOptions {
  dir: string;
  stores: Pick<GatewayStores, 'cronJobs'>;
  logger?: GatewayLogger;
  intervalMs?: number;
  now?: () => Date;
}

export interface CronFileSyncHandle {
  stop(): Promise<void>;
  tick(): Promise<CronFileSyncSummary>;
}

export interface CronFileSyncSummary {
  scanned: number;
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
}

interface CronFileCandidate {
  path: string;
  sourceModifiedAtMs: number;
  sourceModifiedAt: string;
}

const DEFAULT_SYNC_INTERVAL_MS = 60_000;

export function createCronFileSyncLoop(options: CronFileSyncOptions): CronFileSyncHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  let activeTick: Promise<CronFileSyncSummary> | undefined;

  const runTick = (): Promise<CronFileSyncSummary> => {
    if (!running) {
      return Promise.resolve({
        scanned: 0,
        imported: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
      });
    }

    if (activeTick) {
      return activeTick;
    }

    const tickPromise = syncCronFiles(options).finally(() => {
      if (activeTick === tickPromise) {
        activeTick = undefined;
      }
    });
    activeTick = tickPromise;
    return tickPromise;
  };

  const handle: CronFileSyncHandle = {
    async stop() {
      running = false;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      await activeTick?.catch(() => {});
    },
    tick() {
      return runTick();
    },
  };

  running = true;
  timer = setInterval(async () => {
    if (!running || activeTick) return;
    try {
      await runTick();
    } catch (error) {
      options.logger?.warn(GATEWAY_LOG_EVENTS.cron_file_sync_failed, 'Cron file sync failed', {
        dir: resolve(options.dir),
        error: error instanceof Error ? error.message : 'Cron file sync failed.',
      });
    }
  }, intervalMs);

  return handle;
}

export async function syncCronFiles(options: CronFileSyncOptions): Promise<CronFileSyncSummary> {
  const dir = resolve(options.dir);
  const summary: CronFileSyncSummary = {
    scanned: 0,
    imported: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
  };

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') {
      options.logger?.debug(GATEWAY_LOG_EVENTS.cron_file_sync_completed, 'Cron file sync directory missing', {
        dir,
        scanned: 0,
        imported: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
      });
      return summary;
    }

    throw error;
  }

  for (const entry of entries.filter((fileName) => fileName.endsWith('.json')).sort()) {
    const filePath = join(dir, entry);
    summary.scanned += 1;

    try {
      const candidate = await getCronFileCandidate(filePath);
      const syncResult = await syncCronFile(candidate, options);
      summary[syncResult] += 1;
    } catch (error) {
      summary.failed += 1;
      options.logger?.warn(GATEWAY_LOG_EVENTS.cron_file_sync_failed, 'Cron file sync skipped invalid file', {
        filePath,
        error: error instanceof Error ? error.message : 'Cron file sync skipped invalid file.',
      });
    }
  }

  options.logger?.debug(GATEWAY_LOG_EVENTS.cron_file_sync_completed, 'Cron file sync completed', {
    dir,
    scanned: summary.scanned,
    imported: summary.imported,
    updated: summary.updated,
    skipped: summary.skipped,
    failed: summary.failed,
  });

  return summary;
}

async function getCronFileCandidate(filePath: string): Promise<CronFileCandidate> {
  const stats = await stat(filePath);
  if (!stats.isFile()) {
    throw new Error('Cron file path is not a regular file.');
  }

  const sourceModifiedAtMs = Math.max(stats.mtimeMs, Number.isFinite(stats.birthtimeMs) ? stats.birthtimeMs : 0);

  return {
    path: filePath,
    sourceModifiedAtMs,
    sourceModifiedAt: new Date(sourceModifiedAtMs).toISOString(),
  };
}

async function syncCronFile(
  candidate: CronFileCandidate,
  options: CronFileSyncOptions,
): Promise<'imported' | 'updated' | 'skipped'> {
  const fileId = basename(candidate.path, '.json');
  const existing = await options.stores.cronJobs.get(fileId);

  if (existing && Date.parse(existing.updatedAt) >= candidate.sourceModifiedAtMs) {
    return 'skipped';
  }

  const raw = await readFile(candidate.path, 'utf-8');
  const parsed = parseCronJob(raw, candidate.path);
  if (parsed.id !== fileId) {
    throw new Error(`Cron file id "${parsed.id}" must match filename "${fileId}".`);
  }

  const sourceHash = createHash('sha256').update(raw).digest('hex');
  const sourceMetadata = buildSourceMetadata(candidate, sourceHash);
  const syncedJob: GatewayCronJobRecord = {
    ...parsed,
    leaseOwner: existing?.leaseOwner,
    leaseExpiresAt: existing?.leaseExpiresAt,
    metadata: {
      ...(parsed.metadata ?? {}),
      source: sourceMetadata,
    },
    createdAt: existing?.createdAt ?? parsed.createdAt,
    updatedAt: candidate.sourceModifiedAt,
  };

  if (!existing) {
    await options.stores.cronJobs.create(syncedJob);
    options.logger?.info(GATEWAY_LOG_EVENTS.cron_file_imported, 'Cron job imported from file', {
      jobId: syncedJob.id,
      filePath: candidate.path,
      sourceModifiedAt: candidate.sourceModifiedAt,
      nextFireAt: syncedJob.nextFireAt,
      deliveryMode: syncedJob.deliveryMode,
      targetKind: syncedJob.targetKind,
    });
    return 'imported';
  }

  const existingHash = getExistingSourceHash(existing.metadata);
  if (existingHash === sourceHash) {
    await options.stores.cronJobs.update({
      ...existing,
      metadata: {
        ...(existing.metadata ?? {}),
        source: sourceMetadata,
      },
    });
    return 'skipped';
  }

  await options.stores.cronJobs.update(syncedJob);
  options.logger?.info(GATEWAY_LOG_EVENTS.cron_file_updated, 'Cron job updated from file', {
    jobId: syncedJob.id,
    filePath: candidate.path,
    sourceModifiedAt: candidate.sourceModifiedAt,
    nextFireAt: syncedJob.nextFireAt,
    deliveryMode: syncedJob.deliveryMode,
    targetKind: syncedJob.targetKind,
  });
  return 'updated';
}

function parseCronJob(raw: string, filePath: string): GatewayCronJobRecord {
  const value = JSON.parse(raw) as unknown;
  if (!isRecord(value)) {
    throw new Error('Cron job file must contain a JSON object.');
  }

  const requiredStringKeys = [
    'id',
    'schedule',
    'targetKind',
    'deliveryMode',
    'nextFireAt',
    'createdAt',
    'updatedAt',
  ] as const;

  for (const key of requiredStringKeys) {
    if (typeof value[key] !== 'string' || value[key].trim().length === 0) {
      throw new Error(`Cron job file ${filePath} must include string field "${key}".`);
    }
  }

  if (typeof value.enabled !== 'boolean') {
    throw new Error(`Cron job file ${filePath} must include boolean field "enabled".`);
  }

  if (!isRecord(value.target)) {
    throw new Error(`Cron job file ${filePath} must include object field "target".`);
  }

  if (!isRecord(value.delivery)) {
    throw new Error(`Cron job file ${filePath} must include object field "delivery".`);
  }

  return value as unknown as GatewayCronJobRecord;
}

function buildSourceMetadata(candidate: CronFileCandidate, sha256: string): JsonObject {
  return {
    kind: 'file',
    path: candidate.path,
    modifiedAt: candidate.sourceModifiedAt,
    modifiedAtMs: candidate.sourceModifiedAtMs,
    sha256,
  };
}

function getExistingSourceHash(metadata: JsonObject | undefined): string | undefined {
  const source = metadata?.source;
  if (!isRecord(source)) {
    return undefined;
  }

  return typeof source.sha256 === 'string' ? source.sha256 : undefined;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
