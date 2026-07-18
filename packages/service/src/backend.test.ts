import type { ServiceJob } from '@adaptive-agent/service-sdk';
import { describe, expect, it, vi } from 'vitest';

import { ServiceBackendStore, type ClaimedJob } from './postgres.js';
import { queueJobId, type ServiceQueuePayload } from './queue.js';
import { AgentWorker, type AgentWorkerStore, type WorkloadExecutor } from './worker.js';

describe('queue contract', () => {
  it('uses safe deterministic command IDs and an opaque payload', () => {
    expect(queueJobId('job:unsafe', 7)).toBe('service-job_unsafe-v7');
    expect(queueJobId('job:unsafe', 7)).not.toContain(':');
    const payload: ServiceQueuePayload = { jobId: 'job-1' };
    expect(Object.keys(payload)).toEqual(['jobId']);
  });
});

describe('outbox dispatch transaction', () => {
  it('marks published only after publish succeeds', async () => {
    const fake = dispatchPool();
    const store = new ServiceBackendStore(fake.pool as never);
    await store.dispatchBatch(10, async () => undefined);

    expect(fake.sql.some((statement) => statement.includes('update service_outbox set published_at = now()'))).toBe(true);
    expect(fake.sql.at(-1)).toBe('COMMIT');
  });

  it('rolls back and leaves the outbox pending when publish fails', async () => {
    const fake = dispatchPool();
    const store = new ServiceBackendStore(fake.pool as never);
    await expect(store.dispatchBatch(10, async () => { throw new Error('redis unavailable'); }))
      .rejects.toThrow('redis unavailable');

    expect(fake.sql.some((statement) => statement.includes('set published_at'))).toBe(false);
    expect(fake.sql.at(-1)).toBe('ROLLBACK');
  });
});

describe('command claiming', () => {
  it('claims an unprocessed retry command on a terminal job', async () => {
    const fake = claimPool('retry');
    const store = new ServiceBackendStore(fake.pool as never);
    const claimed = await store.claim('job-1');

    expect(claimed).toMatchObject({
      action: 'process',
      claim: { commandVersion: 2, command: { kind: 'retry' } },
    });
    expect(fake.sql.some((statement) => statement.includes('set lease_owner'))).toBe(true);
  });

  it('acknowledges a redelivered execute command already reflected by a terminal job', async () => {
    const fake = claimPool('execute');
    const store = new ServiceBackendStore(fake.pool as never);
    await expect(store.claim('job-1')).resolves.toEqual({ action: 'ack' });
    expect(fake.sql.some((statement) => statement.includes('set processed_at = now()'))).toBe(true);
  });

  it('acknowledges cancellation that lost a race with terminal execution', async () => {
    const fake = claimPool('cancel', 'succeeded');
    const store = new ServiceBackendStore(fake.pool as never);
    await expect(store.claim('job-1')).resolves.toEqual({ action: 'ack' });
    expect(fake.sql.some((statement) => statement.includes('set processed_at = now()'))).toBe(true);
    expect(fake.sql.some((statement) => statement.includes('update service_jobs set state'))).toBe(false);
  });
});

describe('AgentWorker redelivery handling', () => {
  it('does not call the executor when the store acknowledges a duplicate', async () => {
    const store = workerStore({ action: 'ack' });
    const executor = workloadExecutor();
    const worker = new AgentWorker(store, executor);

    await worker.process({ jobId: 'job-1' });

    expect(executor.execute).not.toHaveBeenCalled();
    expect(store.complete).not.toHaveBeenCalled();
  });

  it('defers an execution with a live core lease without marking its command processed', async () => {
    const claim = sampleClaim();
    const store = workerStore({ action: 'process', claim });
    const executor = workloadExecutor({ state: 'running', deferred: true });
    const worker = new AgentWorker(store, executor);

    await worker.process({ jobId: claim.job.id });

    expect(store.defer).toHaveBeenCalledWith(claim, 'running');
    expect(store.complete).not.toHaveBeenCalled();
  });

  it('never persists raw executor error details in public job errors', async () => {
    const claim = sampleClaim();
    const store = workerStore({ action: 'process', claim });
    const executor = workloadExecutor({
      state: 'failed',
      error: {
        schemaVersion: 1,
        code: 'provider_failed',
        message: 'Bearer secret-token postgres://user:password@private/database',
        retryable: true,
      },
    });
    const worker = new AgentWorker(store, executor);

    await worker.process({ jobId: claim.job.id });

    expect(store.complete).toHaveBeenCalledWith(claim, 'failed', undefined, {
      schemaVersion: 1,
      code: 'provider_failed',
      message: 'Agent execution failed.',
      retryable: true,
    });
  });
});

function dispatchPool() {
  const sql: string[] = [];
  const client = {
    async query(statement: string) {
      sql.push(statement.trim());
      if (statement.includes('from service_outbox o')) {
        return { rows: [{ id: 'outbox-1', jobId: 'job-1', commandVersion: 2, kind: 'run' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  return { sql, pool: { connect: async () => client } };
}

function claimPool(kind: 'cancel' | 'execute' | 'retry', state: ServiceJob['state'] = 'failed') {
  const sql: string[] = [];
  const row = serviceJobRow({ state, commandVersion: 2, pendingKind: kind });
  const client = {
    async query(statement: string) {
      const normalized = statement.trim();
      sql.push(normalized);
      if (normalized.startsWith('select * from service_jobs')) return { rows: [row], rowCount: 1 };
      if (normalized.includes('select id, command_version, command')) {
        return {
          rows: [{
            id: 'outbox-2',
            command_version: 2,
            command: { kind, version: 2, requestedAt: '2026-01-01T00:00:00.000Z' },
          }],
          rowCount: 1,
        };
      }
      if (normalized.includes('from service_job_run_links')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  return { sql, pool: { connect: async () => client } };
}

function serviceJobRow(options: { state: ServiceJob['state']; commandVersion: number; pendingKind: 'cancel' | 'execute' | 'retry' }) {
  return {
    id: 'job-1',
    tenant_id: 'tenant-1',
    owner_user_id: 'user-1',
    kind: 'run',
    state: options.state,
    session_id: 'session-1',
    coordinator_run_id: null,
    request: { schemaVersion: 1, agentId: 'agent-1', goal: 'test' },
    profile_refs: [{ agentId: 'agent-1', version: '1', contentHash: 'hash' }],
    command_version: options.commandVersion,
    processed_command_version: 1,
    pending_command: { kind: options.pendingKind, version: options.commandVersion, requestedAt: '2026-01-01T00:00:00.000Z' },
    result: null,
    error: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function sampleClaim(): ClaimedJob {
  const command = { kind: 'execute' as const, version: 1, requestedAt: '2026-01-01T00:00:00.000Z' };
  return {
    job: {
      schemaVersion: 1,
      id: 'job-1',
      tenantId: 'tenant-1',
      ownerUserId: 'user-1',
      kind: 'run',
      state: 'running',
      sessionId: 'session-1',
      request: { schemaVersion: 1, agentId: 'agent-1', goal: 'test' },
      profiles: [{ agentId: 'agent-1', version: '1', contentHash: 'hash' }],
      commandVersion: 1,
      processedCommandVersion: 0,
      pendingCommand: command,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    links: [],
    commandVersion: 1,
    command,
    leaseOwner: 'worker-1',
    recovery: false,
  };
}

function workerStore(result: Awaited<ReturnType<AgentWorkerStore['claim']>>): AgentWorkerStore & Record<'complete' | 'defer', ReturnType<typeof vi.fn>> {
  return {
    claim: vi.fn(async () => result),
    link: vi.fn(async () => undefined),
    complete: vi.fn(async () => true),
    defer: vi.fn(async () => undefined),
  };
}

function workloadExecutor(outcome: import('./worker.js').ExecutionOutcome = { state: 'succeeded' }): WorkloadExecutor & { execute: ReturnType<typeof vi.fn> } {
  return {
    execute: vi.fn(async () => outcome),
    close: vi.fn(async () => undefined),
  };
}
