import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'bun:test';

import { SQLITE_RUNTIME_SCHEMA_VERSION } from './sqlite-runtime-migrations.js';
import {
  createSqliteRuntimeStores,
  openSqliteRuntimeStores,
  type SqliteRuntimeStoreBundle,
} from './sqlite-runtime-stores.js';

const cleanupPaths: string[] = [];
const openBundles: SqliteRuntimeStoreBundle[] = [];

afterEach(async () => {
  await Promise.all(openBundles.splice(0).map((bundle) => bundle.close()));
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('SQLite runtime stores', () => {
  it('enables WAL, foreign keys, busy timeout, migrations, and schema version', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'runtime.sqlite');
    const database = new Database(path, { create: true, strict: true });
    const bundle = createSqliteRuntimeStores({ database, busyTimeoutMs: 2_500 });
    openBundles.push(bundle);

    expect(database.query('pragma journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(database.query('pragma foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(database.query('pragma busy_timeout').get()).toEqual({ timeout: 2_500 });
    expect(database.query('pragma user_version').get()).toEqual({ user_version: SQLITE_RUNTIME_SCHEMA_VERSION });
    expect(database.query('select name from adaptive_agent_migrations').all())
      .toEqual([{ name: 'core:001_runtime_sqlite' }]);
  });

  it('atomically commits or rolls back delegate child spawn boundaries', async () => {
    const bundle = createSqliteRuntimeStores({ database: new Database(':memory:', { strict: true }) });
    openBundles.push(bundle);
    const parent = await bundle.runStore.createRun({ id: 'parent', goal: 'Delegate', status: 'running' });
    await bundle.toolExecutionStore.markStarted({
      runId: parent.id,
      stepId: 'step-1',
      toolCallId: 'call-1',
      toolName: 'delegate_researcher',
      idempotencyKey: 'parent:step-1:call-1',
      inputHash: 'hash-1',
    });

    await expect(bundle.runInTransaction(async (stores) => {
      await stores.runStore.createRun({
        id: 'rolled-back-child',
        rootRunId: parent.id,
        parentRunId: parent.id,
        parentStepId: 'step-1',
        delegateName: 'researcher',
        goal: 'Research',
        status: 'queued',
      });
      await stores.runStore.updateRun(parent.id, {
        status: 'awaiting_subagent',
        currentChildRunId: 'rolled-back-child',
      }, parent.version);
      throw new Error('simulated crash');
    })).rejects.toThrow('simulated crash');

    expect(await bundle.runStore.getRun('rolled-back-child')).toBeNull();
    expect(await bundle.runStore.getRun(parent.id)).toMatchObject({
      status: 'running',
      version: parent.version,
    });
    expect((await bundle.runStore.getRun(parent.id))?.currentChildRunId).toBeUndefined();

    await bundle.runInTransaction(async (stores) => {
      await stores.runStore.createRun({
        id: 'child',
        rootRunId: parent.id,
        parentRunId: parent.id,
        parentStepId: 'step-1',
        delegateName: 'researcher',
        goal: 'Research',
        status: 'queued',
      });
      await stores.runStore.updateRun(parent.id, {
        status: 'awaiting_subagent',
        currentChildRunId: 'child',
      }, parent.version);
      await stores.toolExecutionStore?.markChildRunLinked('parent:step-1:call-1', 'child');
      await stores.eventStore?.append({
        runId: parent.id,
        type: 'delegate.spawned',
        schemaVersion: 1,
        payload: { childRunId: 'child' },
      });
    });

    expect(await bundle.runStore.getRun(parent.id)).toMatchObject({
      status: 'awaiting_subagent', currentChildRunId: 'child',
    });
    expect(await bundle.toolExecutionStore.getByIdempotencyKey('parent:step-1:call-1'))
      .toMatchObject({ childRunId: 'child' });
    expect(await bundle.eventStore.listByRun(parent.id)).toHaveLength(1);
  });

  it('reopens durable state and reports an expired run as a recovery candidate', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'runtime.sqlite');
    const first = openSqliteRuntimeStores({ path });
    await first.runStore.createRun({ id: 'interrupted-run', goal: 'Recover me', status: 'running' });
    await first.runStore.tryAcquireLease({
      runId: 'interrupted-run',
      owner: 'dead-process',
      ttlMs: 1_000,
      now: new Date('2026-07-28T09:59:00.000Z'),
    });
    await first.toolExecutionStore.markStarted({
      runId: 'interrupted-run',
      stepId: 'step-1',
      toolCallId: 'call-1',
      toolName: 'local_tool',
      idempotencyKey: 'interrupted-run:step-1:call-1',
      inputHash: 'hash-1',
    });
    await first.toolExecutionStore.markCompleted(
      'interrupted-run:step-1:call-1',
      { durable: true },
    );
    await first.close();

    const reopened = openSqliteRuntimeStores({ path });
    openBundles.push(reopened);
    expect(await reopened.runStore.getRun('interrupted-run')).toMatchObject({
      status: 'running', leaseOwner: 'dead-process',
    });
    expect(await reopened.recoveryScanner.scan({
      now: new Date('2026-07-28T10:00:02.000Z'),
      staleRunMs: 60_000,
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'expired_lease', run: expect.objectContaining({ id: 'interrupted-run' }) }),
    ]));
    expect(await reopened.toolExecutionStore.getByIdempotencyKey('interrupted-run:step-1:call-1'))
      .toMatchObject({ status: 'completed', output: { durable: true } });
  });

  it('recovers a valid candidate after the writer process is killed', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'killed-runtime.sqlite');
    const storesModule = pathToFileURL(join(import.meta.dir, 'sqlite-runtime-stores.ts')).href;
    const script = `
      import { openSqliteRuntimeStores } from ${JSON.stringify(storesModule)};
      const stores = openSqliteRuntimeStores({ path: ${JSON.stringify(path)} });
      await stores.runStore.createRun({ id: 'killed-run', goal: 'Survive SIGKILL', status: 'running' });
      await stores.runStore.tryAcquireLease({
        runId: 'killed-run', owner: 'killed-process', ttlMs: 1000,
        now: new Date('2026-07-28T09:59:00.000Z'),
      });
      console.log('READY');
      setInterval(() => undefined, 1000);
    `;
    const child = Bun.spawn([process.execPath, '-e', script], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let output = '';
    while (!output.includes('READY')) {
      const chunk = await reader.read();
      if (chunk.done) {
        const errorOutput = await new Response(child.stderr).text();
        throw new Error(`SQLite crash fixture exited before readiness: ${errorOutput}`);
      }
      output += decoder.decode(chunk.value, { stream: true });
    }
    child.kill(9);
    await child.exited;

    const reopened = openSqliteRuntimeStores({ path });
    openBundles.push(reopened);
    expect(await reopened.recoveryScanner.scan({
      now: new Date('2026-07-28T10:00:02.000Z'),
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        reason: 'expired_lease',
        run: expect.objectContaining({ id: 'killed-run', leaseOwner: 'killed-process' }),
      }),
    ]));
  });

  it('waits for queued work before closing and rejects operations after close', async () => {
    const bundle = createSqliteRuntimeStores({ database: new Database(':memory:', { strict: true }) });
    const create = bundle.runStore.createRun({ id: 'before-close', goal: 'Finish write', status: 'queued' });
    await bundle.close();
    await expect(create).resolves.toMatchObject({ id: 'before-close' });
    await expect(bundle.runStore.getRun('before-close')).rejects.toThrow('SQLite runtime is closed');
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'core-sqlite-runtime-'));
  cleanupPaths.push(directory);
  return directory;
}
