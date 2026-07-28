import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';

import { InMemoryContinuationStore } from './in-memory-continuation-store.js';
import { InMemoryEventStore } from './in-memory-event-store.js';
import { InMemoryPlanStore } from './in-memory-plan-store.js';
import { InMemoryRunStore } from './in-memory-run-store.js';
import { InMemorySnapshotStore } from './in-memory-snapshot-store.js';
import { InMemoryToolExecutionStore } from './in-memory-tool-execution-store.js';
import { createSqliteRuntimeStores } from './sqlite-runtime-stores.js';
import type {
  ContinuationStore,
  EventStore,
  PlanStore,
  RunStore,
  SnapshotStore,
  ToolExecutionStore,
} from './types.js';

interface ConformanceStores {
  runStore: RunStore;
  eventStore: EventStore;
  snapshotStore: SnapshotStore;
  planStore: PlanStore;
  continuationStore: ContinuationStore;
  toolExecutionStore: ToolExecutionStore;
  close?(): Promise<void>;
}

type StoreFactory = () => ConformanceStores | Promise<ConformanceStores>;

const openStores: ConformanceStores[] = [];

afterEach(async () => {
  await Promise.all(openStores.splice(0).map((stores) => stores.close?.()));
});

function defineRuntimeStoreConformance(name: string, factory: StoreFactory): void {
  const useStores = async (): Promise<ConformanceStores> => {
    const stores = await factory();
    openStores.push(stores);
    return stores;
  };

  describe(`${name} runtime store conformance`, () => {
    it('creates, reads, lists, updates, and rejects stale run versions', async () => {
      const stores = await useStores();
      const created = await stores.runStore.createRun({
        id: 'run-1',
        sessionId: 'session-1',
        goal: 'Persist a run',
        executionContext: { inferenceMode: 'gateway', inferenceTier: 'medium' },
        status: 'queued',
      });

      expect(created).toMatchObject({ id: 'run-1', rootRunId: 'run-1', version: 0 });
      expect((await stores.runStore.listBySession?.('session-1'))?.map((run) => run.id))
        .toEqual(['run-1']);
      const updated = await stores.runStore.updateRun(
        created.id,
        { status: 'running', currentStepId: 'step-1' },
        created.version,
      );
      expect(updated).toMatchObject({ status: 'running', currentStepId: 'step-1', version: 1 });
      await expect(stores.runStore.updateRun(created.id, { status: 'failed' }, 0))
        .rejects.toThrow(/version mismatch/);
      await expect(stores.runStore.updateRun(created.id, {
        executionContext: { inferenceMode: 'gateway', inferenceTier: 'low' },
      })).rejects.toThrow('executionContext is immutable');
    });

    it('acquires, heartbeats, excludes another owner, and releases leases', async () => {
      const stores = await useStores();
      await stores.runStore.createRun({ id: 'run-lease', goal: 'Lease me', status: 'running' });
      const now = new Date('2026-07-28T10:00:00.000Z');

      await expect(stores.runStore.tryAcquireLease({
        runId: 'run-lease', owner: 'worker-1', ttlMs: 60_000, now,
      })).resolves.toBe(true);
      await expect(stores.runStore.tryAcquireLease({
        runId: 'run-lease', owner: 'worker-2', ttlMs: 60_000, now,
      })).resolves.toBe(false);
      await stores.runStore.heartbeatLease({
        runId: 'run-lease', owner: 'worker-1', ttlMs: 60_000,
        now: new Date('2026-07-28T10:00:30.000Z'),
      });
      await expect(stores.runStore.heartbeatLease({
        runId: 'run-lease', owner: 'worker-2', ttlMs: 60_000, now,
      })).rejects.toThrow('lease is not owned');
      await stores.runStore.releaseLease('run-lease', 'worker-1');
      expect((await stores.runStore.getRun('run-lease'))?.leaseOwner).toBeUndefined();
    });

    it('assigns deterministic event sequences and saves the latest snapshot', async () => {
      const stores = await useStores();
      await stores.runStore.createRun({ id: 'run-events', goal: 'Record events', status: 'running' });
      await Promise.all(Array.from({ length: 5 }, (_, index) => stores.eventStore.append({
        runId: 'run-events',
        type: 'step.completed',
        schemaVersion: 1,
        payload: { index },
      })));
      expect((await stores.eventStore.listByRun('run-events')).map((event) => event.seq))
        .toEqual([1, 2, 3, 4, 5]);
      expect((await stores.eventStore.listByRun('run-events', 3)).map((event) => event.seq))
        .toEqual([4, 5]);

      await stores.snapshotStore.save({
        runId: 'run-events', snapshotSeq: 1, status: 'running',
        summary: { stepsUsed: 1 }, state: { schemaVersion: 1, messages: [] },
      });
      await stores.snapshotStore.save({
        runId: 'run-events', snapshotSeq: 2, status: 'running',
        summary: { stepsUsed: 2 }, state: { schemaVersion: 1, messages: ['done'] },
      });
      expect(await stores.snapshotStore.getLatest('run-events')).toMatchObject({
        snapshotSeq: 2,
        state: { schemaVersion: 1, messages: ['done'] },
      });
      await expect(stores.snapshotStore.save({
        runId: 'run-events', snapshotSeq: 2, status: 'running',
        summary: {}, state: {},
      })).rejects.toThrow();
    });

    it('persists plans and plan execution transitions', async () => {
      const stores = await useStores();
      await stores.runStore.createRun({ id: 'run-plan', goal: 'Execute a plan', status: 'planning' });
      const plan = await stores.planStore.createPlan({
        id: 'plan-1',
        version: 1,
        status: 'approved',
        goal: 'Execute a plan',
        summary: 'One step',
        toolsetHash: 'tools-v1',
        createdFromRunId: 'run-plan',
        steps: [{
          id: 'step-1',
          title: 'Look up data',
          toolName: 'lookup',
          inputTemplate: { query: 'durability' },
          onFailure: 'stop',
        }],
      });
      expect((await stores.planStore.getPlan(plan.id))?.steps).toHaveLength(1);
      expect((await stores.planStore.listSteps(plan.id)).map((step) => step.id)).toEqual(['step-1']);

      await stores.planStore.createExecution({
        id: 'execution-1', planId: plan.id, runId: 'run-plan', attempt: 1, status: 'running',
      });
      const completed = await stores.planStore.updateExecution('execution-1', {
        status: 'succeeded', output: { done: true },
      });
      expect(completed).toMatchObject({ status: 'succeeded', output: { done: true } });
      expect(completed.completedAt).toBeTruthy();
    });

    it('persists continuations and reuses completed idempotent tool executions', async () => {
      const stores = await useStores();
      await stores.runStore.createRun({ id: 'source-run', goal: 'Source', status: 'failed' });
      await stores.runStore.createRun({ id: 'continuation-run', goal: 'Continue', status: 'queued' });
      const continuation = await stores.continuationStore.createContinuation({
        sourceRunId: 'source-run',
        continuationRunId: 'continuation-run',
        strategy: 'latest_snapshot',
        failureClass: 'provider_transient',
        reason: 'Retry on another process',
      });
      expect(await stores.continuationStore.getByContinuationRun('continuation-run'))
        .toEqual(continuation);
      expect(await stores.continuationStore.listBySourceRun('source-run')).toEqual([continuation]);

      const startedInput = {
        runId: 'continuation-run',
        stepId: 'step-1',
        toolCallId: 'call-1',
        toolName: 'local_tool',
        idempotencyKey: 'continuation-run:step-1:call-1',
        inputHash: 'hash-1',
        input: { value: 1 },
      };
      await stores.toolExecutionStore.markStarted(startedInput);
      const completed = await stores.toolExecutionStore.markCompleted(
        startedInput.idempotencyKey,
        { cached: true },
      );
      expect(await stores.toolExecutionStore.markStarted(startedInput)).toEqual(completed);
      expect(await stores.toolExecutionStore.getByIdempotencyKey(startedInput.idempotencyKey))
        .toEqual(completed);
    });
  });
}

defineRuntimeStoreConformance('memory', () => ({
  runStore: new InMemoryRunStore(),
  eventStore: new InMemoryEventStore(),
  snapshotStore: new InMemorySnapshotStore(),
  planStore: new InMemoryPlanStore(),
  continuationStore: new InMemoryContinuationStore(),
  toolExecutionStore: new InMemoryToolExecutionStore(),
}));

defineRuntimeStoreConformance('sqlite', () => {
  const bundle = createSqliteRuntimeStores({ database: new Database(':memory:', { strict: true }) });
  return {
    ...bundle,
    runStore: bundle.runStore,
    eventStore: bundle.eventStore,
    snapshotStore: bundle.snapshotStore,
    planStore: bundle.planStore,
    continuationStore: bundle.continuationStore,
    toolExecutionStore: bundle.toolExecutionStore,
    close: () => bundle.close(),
  };
});
