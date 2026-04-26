import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createCronFileSyncLoop, syncCronFiles } from './cron-file-sync.js';
import { createInMemoryGatewayStores, type GatewayCronJobRecord } from './stores.js';

const tempDirectories: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cron-file-sync-test-'));
  tempDirectories.push(dir);
  return dir;
}

function createCronJob(overrides: Partial<GatewayCronJobRecord> = {}): GatewayCronJobRecord {
  return {
    id: 'ipl',
    schedule: '30 21 * * *',
    targetKind: 'isolated_run',
    target: {
      agentId: 'ipl-agent',
      goal: 'run examples/ipl2.sh',
    },
    deliveryMode: 'webhook',
    delivery: {
      url: 'http://127.0.0.1:3999/cron',
    },
    enabled: true,
    nextFireAt: '2026-04-15T21:30:00.000Z',
    createdAt: '2026-04-11T18:00:00.000Z',
    updatedAt: '2026-04-11T18:00:00.000Z',
    ...overrides,
  };
}

async function writeCronJob(dir: string, job: GatewayCronJobRecord): Promise<string> {
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${job.id}.json`);
  await writeFile(filePath, `${JSON.stringify(job, null, 2)}\n`, 'utf-8');
  return filePath;
}

describe('cron file sync', () => {
  afterEach(async () => {
    await Promise.all(tempDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
    tempDirectories.length = 0;
  });

  it('imports cron jobs from json files into the target store', async () => {
    const dir = await createTempDir();
    const stores = createInMemoryGatewayStores();
    await writeCronJob(dir, createCronJob());

    const summary = await syncCronFiles({ dir, stores });
    const imported = await stores.cronJobs.get('ipl');

    expect(summary).toMatchObject({ scanned: 1, imported: 1, updated: 0, skipped: 0, failed: 0 });
    expect(imported).toMatchObject({
      id: 'ipl',
      schedule: '30 21 * * *',
      deliveryMode: 'webhook',
      nextFireAt: '2026-04-15T21:30:00.000Z',
    });
    expect(imported?.metadata?.source).toMatchObject({
      kind: 'file',
      path: join(dir, 'ipl.json'),
    });
  });

  it('does not overwrite a postgres-newer cron job with an older file', async () => {
    const dir = await createTempDir();
    const stores = createInMemoryGatewayStores();
    await writeCronJob(dir, createCronJob({ schedule: '30 21 * * *' }));
    await stores.cronJobs.create(createCronJob({
      schedule: '0 22 * * *',
      updatedAt: '2999-01-01T00:00:00.000Z',
    }));

    const summary = await syncCronFiles({ dir, stores });
    const job = await stores.cronJobs.get('ipl');

    expect(summary).toMatchObject({ scanned: 1, imported: 0, updated: 0, skipped: 1, failed: 0 });
    expect(job?.schedule).toBe('0 22 * * *');
  });

  it('updates a cron job when the file is newer than the store row', async () => {
    const dir = await createTempDir();
    const stores = createInMemoryGatewayStores();
    await stores.cronJobs.create(createCronJob({
      schedule: '0 22 * * *',
      updatedAt: '2000-01-01T00:00:00.000Z',
    }));
    await writeCronJob(dir, createCronJob({ schedule: '30 21 * * *' }));

    const summary = await syncCronFiles({ dir, stores });
    const job = await stores.cronJobs.get('ipl');

    expect(summary).toMatchObject({ scanned: 1, imported: 0, updated: 1, skipped: 0, failed: 0 });
    expect(job?.schedule).toBe('30 21 * * *');
    expect(job?.metadata?.source).toMatchObject({
      kind: 'file',
      path: join(dir, 'ipl.json'),
    });
  });

  it('stop() waits for an in-flight sync to finish', async () => {
    const releaseSync = createDeferred<void>();
    const stores = createInMemoryGatewayStores();
    const dir = await createTempDir();
    await writeCronJob(dir, createCronJob());
    const blockingCronJobs = {
      get: async (id: string) => {
        await releaseSync.promise;
        return stores.cronJobs.get(id);
      },
      create: (job: GatewayCronJobRecord) => stores.cronJobs.create(job),
      update: (job: GatewayCronJobRecord) => stores.cronJobs.update(job),
      listDue: (nowIso: string) => stores.cronJobs.listDue(nowIso),
      listAll: () => stores.cronJobs.listAll(),
      delete: (id: string) => stores.cronJobs.delete(id),
    };
    const inFlightSync = createCronFileSyncLoop({
      dir,
      stores: {
        ...stores,
        cronJobs: blockingCronJobs,
      },
      pollIntervalMs: 999_999,
    });

    try {
      const tickPromise = inFlightSync.tick();
      await Promise.resolve();

      let stopResolved = false;
      const stopPromise = inFlightSync.stop().then(() => {
        stopResolved = true;
      });

      await Promise.resolve();
      expect(stopResolved).toBe(false);

      releaseSync.resolve();

      await stopPromise;
      await expect(tickPromise).resolves.toMatchObject({ scanned: 1, imported: 1, updated: 0, skipped: 0, failed: 0 });
      expect(stopResolved).toBe(true);
    } finally {
      await inFlightSync.stop();
    }
  });
});

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return {
    promise,
    resolve,
    reject,
  };
}
