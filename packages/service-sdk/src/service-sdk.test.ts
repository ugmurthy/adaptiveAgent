import { describe, expect, it } from 'vitest';

import {
  IdempotencyConflictError,
  InMemoryArtifactStore,
  InMemoryServiceStore,
  ServiceForbiddenError,
  ServiceNotFoundError,
  ServiceSdk,
  type AgentRegistry,
  type ServiceActor,
} from './index.js';

const actor: ServiceActor = { tenantId: 'tenant', userId: 'alice' };

function fixture() {
  const store = new InMemoryServiceStore();
  let id = 0;
  const registry: AgentRegistry = {
    async resolve(agentId, workload) {
      return {
        profile: { agentId, version: '1', contentHash: `hash-${agentId}` },
        allowedWorkloads: [workload],
      };
    },
  };
  const sdk = new ServiceSdk({
    persistence: store,
    artifacts: new InMemoryArtifactStore(store),
    registry,
    authorization: { async authorize() { return true; } },
    clock: { now: () => new Date('2026-01-01T00:00:00Z') },
    ids: { generate: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}` },
  });
  return { sdk, store };
}

describe('ServiceSdk', () => {
  it('submits all workload kinds with session, profile references, and outbox', async () => {
    const { sdk, store } = fixture();
    const jobs = await Promise.all([
      sdk.submitRun(actor, { schemaVersion: 1, agentId: 'a', goal: 'g' }),
      sdk.submitChat(actor, { schemaVersion: 1, agentId: 'a', message: 'm' }),
      sdk.submitSwarmRun(actor, { schemaVersion: 1, coordinatorAgentId: 'c', workerAgentIds: ['w'], qualityAgentId: 'q', synthesizerAgentId: 's', objective: 'o' }),
      sdk.submitOrchestratedRun(actor, { schemaVersion: 1, orchestratorAgentId: 'o', agentIds: ['a'], objective: 'x' }),
    ]);

    expect(jobs.map((job) => job.kind)).toEqual(['run', 'chat', 'swarm', 'orchestration']);
    expect(jobs.every((job) => job.sessionId && job.profiles.every((profile) => !('model' in profile)))).toBe(true);
    expect(jobs[2]?.profiles.map((profile) => profile.agentId)).toEqual(['c', 'w', 'q', 's']);
    expect(store.outboxRows).toHaveLength(4);
  });

  it('scopes submission idempotency and detects hash conflicts', async () => {
    const { sdk } = fixture();
    const one = await sdk.submitRun(actor, { schemaVersion: 1, agentId: 'a', goal: 'g' }, { idempotencyKey: 'key' });
    const two = await sdk.submitRun(actor, { schemaVersion: 1, goal: 'g', agentId: 'a' }, { idempotencyKey: 'key' });
    expect(two.id).toBe(one.id);
    await expect(sdk.submitRun(actor, { schemaVersion: 1, agentId: 'a', goal: 'different' }, { idempotencyKey: 'key' }))
      .rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('persists explicit file references and includes them in idempotency identity',async()=>{
    const {sdk}=fixture();
    const artifactId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const job=await sdk.submitRun(actor,{schemaVersion:1,agentId:'a',goal:'summarize selected input',fileRefs:[{artifactId:artifactId.toUpperCase()}]},{idempotencyKey:'files'});
    expect(job.request).toMatchObject({fileRefs:[{artifactId}]});
    await expect(sdk.submitRun(actor,{schemaVersion:1,agentId:'a',goal:'summarize selected input',fileRefs:[{artifactId}]},{idempotencyKey:'files'})).resolves.toMatchObject({id:job.id});
    await expect(sdk.submitRun(actor,{schemaVersion:1,agentId:'a',goal:'summarize selected input',fileRefs:[{artifactId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}]},{idempotencyKey:'files'}))
      .rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('deduplicates control commands with an idempotency key', async () => {
    const { sdk, store } = fixture();
    const job = await sdk.submitRun(actor, { schemaVersion: 1, agentId: 'a', goal: 'g' });
    store.jobRows.set(job.id, { ...job, state: 'running' });

    const first = await sdk.steerJob(actor, job.id, 'focus on tests', { idempotencyKey: 'steer-1' });
    const second = await sdk.steerJob(actor, job.id, 'focus on tests', { idempotencyKey: 'steer-1' });

    expect(second.commandVersion).toBe(first.commandVersion);
    expect(store.outboxRows).toHaveLength(2);
    await expect(sdk.steerJob(actor, job.id, 'different', { idempotencyKey: 'steer-1' }))
      .rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('does not enumerate cross-user get, control, events, or artifacts', async () => {
    const { sdk } = fixture();
    const job = await sdk.submitRun(actor, { schemaVersion: 1, agentId: 'a', goal: 'g' });
    const other = { tenantId: 'tenant', userId: 'bob' };
    for (const call of [
      () => sdk.getJob(other, job.id),
      () => sdk.cancelJob(other, job.id),
      () => sdk.listEvents(other, job.id),
      () => sdk.listArtifacts(other, job.id),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(ServiceNotFoundError);
    }
  });

  it('lists only the current user jobs with filters and pagination metadata', async () => {
    const { sdk } = fixture();
    await sdk.submitRun(actor, { schemaVersion: 1, agentId: 'a', goal: 'mine' });
    await sdk.submitChat({ tenantId: 'tenant', userId: 'bob' }, { schemaVersion: 1, agentId: 'a', message: 'private' });

    const page = await sdk.listJobs(actor, { kind: 'run', limit: 10, offset: 0 });

    expect(page).toMatchObject({ total: 1, limit: 10, offset: 0 });
    expect(page.items.map(job => job.ownerUserId)).toEqual(['alice']);
  });

  it('requires platform admin and audits cross-tenant inspection and idempotent control', async () => {
    const { sdk, store } = fixture();
    const job = await sdk.submitRun(actor, { schemaVersion: 1, agentId: 'a', goal: 'inspect' });
    store.jobRows.set(job.id, { ...job, state: 'running' });
    await expect(sdk.adminGetJob(actor, job.id)).rejects.toBeInstanceOf(ServiceForbiddenError);

    const admin: ServiceActor = { tenantId: 'operations', userId: 'root', roles: ['platform_admin'] };
    expect((await sdk.adminGetJob(admin, job.id)).ownerUserId).toBe('alice');
    const first = await sdk.adminCancelJob(admin, job.id, { idempotencyKey: 'cancel-once' });
    const second = await sdk.adminCancelJob(admin, job.id, { idempotencyKey: 'cancel-once' });

    expect(second.commandVersion).toBe(first.commandVersion);
    expect(store.outboxRows.filter(row => row.jobId === job.id)).toHaveLength(2);
    expect(store.auditRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: 'root', jobId: job.id, action: 'admin:get_job' }),
      expect.objectContaining({ userId: 'root', jobId: job.id, action: 'admin:cancel' }),
    ]));
  });

  it('rolls back job creation when the transaction fails', async () => {
    const { sdk, store } = fixture();
    store.failAfterJobCreate = true;
    await expect(sdk.submitRun(actor, { schemaVersion: 1, agentId: 'a', goal: 'g' })).rejects.toThrow('injected');
    expect(store.jobRows.size).toBe(0);
    expect(store.outboxRows).toHaveLength(0);
  });
});
