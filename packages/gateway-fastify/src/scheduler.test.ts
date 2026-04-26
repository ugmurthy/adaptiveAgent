import { describe, expect, it } from 'vitest';

import type { AgentRegistryEntry } from './agent-registry.js';
import { AgentRegistry } from './agent-registry.js';
import type { GatewayConfig } from './config.js';
import type { CreatedAdaptiveAgent, RunResult } from './core.js';
import { createGatewayLogger, GATEWAY_LOG_EVENTS, type GatewayLogEntry } from './observability.js';
import { createModuleRegistry } from './registries.js';
import { createInMemoryGatewayStores, type GatewayCronJobRecord, type GatewayStores } from './stores.js';
import { createSchedulerLoop, executeCronTarget } from './scheduler.js';

function createStubAgent(overrides: {
  chatResult?: RunResult;
  runResult?: RunResult;
} = {}): CreatedAdaptiveAgent {
  const defaultSuccess: RunResult = {
    status: 'success',
    runId: 'run-1',
    output: 'done',
    stepsUsed: 1,
    usage: { promptTokens: 10, completionTokens: 5, estimatedCostUSD: 0 },
  };

  return {
    agent: {
      chat: async () => overrides.chatResult ?? defaultSuccess,
      run: async () => overrides.runResult ?? defaultSuccess,
    },
    runtime: {
      runStore: { getRun: async () => ({ id: 'run-1', rootRunId: 'run-1', status: 'completed' }) },
      eventStore: {},
      snapshotStore: {},
      planStore: {},
    },
  };
}

function createTestAgentRegistry(
  stubAgent: CreatedAdaptiveAgent = createStubAgent(),
): AgentRegistry {
  const moduleRegistry = createModuleRegistry({});
  return new AgentRegistry({
    agents: [
      {
        path: '/test/agent.json',
        config: {
          id: 'test-agent',
          name: 'Test Agent',
          invocationModes: ['chat', 'run'],
          defaultInvocationMode: 'chat',
          model: { provider: 'openrouter', model: 'test' },
          tools: [],
          delegates: [],
        },
      },
    ],
    moduleRegistry,
    agentFactory: () => stubAgent,
  });
}

function createTestGatewayConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    server: { host: '0.0.0.0', port: 3000, websocketPath: '/ws' },
    bindings: [],
    defaultAgentId: 'test-agent',
    hooks: {
      failurePolicy: 'fail',
      modules: [],
      onAuthenticate: [],
      onSessionResolve: [],
      beforeRoute: [],
      beforeInboundMessage: [],
      beforeRunStart: [],
      afterRunResult: [],
      onAgentEvent: [],
      beforeOutboundFrame: [],
      onDisconnect: [],
      onError: [],
    },
    ...overrides,
  };
}

function createDueJob(overrides: Partial<GatewayCronJobRecord> = {}): GatewayCronJobRecord {
  return {
    id: 'job-1',
    schedule: '*/5 * * * *',
    targetKind: 'isolated_run',
    target: {
      agentId: 'test-agent',
      goal: 'run the scheduled task',
    },
    deliveryMode: 'none',
    delivery: {},
    enabled: true,
    nextFireAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const fixedNow = () => new Date('2026-01-01T00:05:00.000Z');
let idCounter = 0;
const idFactory = () => `gen-${++idCounter}`;

describe('executeCronTarget', () => {
  it('dispatches isolated_run target kind through agent.run', async () => {
    const stores = createInMemoryGatewayStores();
    const job = createDueJob();
    await stores.cronJobs.create(job);

    const result = await executeCronTarget(job, {
      gatewayConfig: createTestGatewayConfig(),
      agentRegistry: createTestAgentRegistry(),
      stores,
      now: fixedNow,
      idFactory,
    });

    expect(result.status).toBe('succeeded');
    expect(result.runId).toBe('run-1');
  });

  it('dispatches isolated_chat target kind through a fresh session', async () => {
    const stores = createInMemoryGatewayStores();
    const job = createDueJob({
      targetKind: 'isolated_chat',
      target: {
        agentId: 'test-agent',
        content: 'hello from cron',
        channelId: 'cron-chan',
      },
    });
    await stores.cronJobs.create(job);

    const result = await executeCronTarget(job, {
      gatewayConfig: createTestGatewayConfig(),
      agentRegistry: createTestAgentRegistry(),
      stores,
      now: fixedNow,
      idFactory,
    });

    expect(result.status).toBe('succeeded');
    expect(result.sessionId).toBeDefined();
  });

  it('dispatches session_event target kind through an existing session', async () => {
    const stores = createInMemoryGatewayStores();
    const session = await stores.sessions.create({
      id: 'sess-1',
      channelId: 'main',
      authSubject: 'user-1',
      status: 'idle',
      transcriptVersion: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const job = createDueJob({
      targetKind: 'session_event',
      target: {
        sessionId: session.id,
        content: 'scheduled check-in',
      },
    });
    await stores.cronJobs.create(job);

    const result = await executeCronTarget(job, {
      gatewayConfig: createTestGatewayConfig(),
      agentRegistry: createTestAgentRegistry(),
      stores,
      now: fixedNow,
      idFactory,
    });

    expect(result.status).toBe('succeeded');
    expect(result.sessionId).toBe('sess-1');
  });

  it('returns failed when session_event references a missing session', async () => {
    const stores = createInMemoryGatewayStores();
    const job = createDueJob({
      targetKind: 'session_event',
      target: { sessionId: 'no-such-session' },
    });

    const result = await executeCronTarget(job, {
      gatewayConfig: createTestGatewayConfig(),
      agentRegistry: createTestAgentRegistry(),
      stores,
      now: fixedNow,
      idFactory,
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('does not exist');
  });

  it('returns failed when session_event is missing sessionId', async () => {
    const stores = createInMemoryGatewayStores();
    const job = createDueJob({
      targetKind: 'session_event',
      target: {},
    });

    const result = await executeCronTarget(job, {
      gatewayConfig: createTestGatewayConfig(),
      agentRegistry: createTestAgentRegistry(),
      stores,
      now: fixedNow,
      idFactory,
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('requires target.sessionId');
  });

  it('marks approval-requested cron runs as needs_review', async () => {
    const approvalResult: RunResult = {
      status: 'approval_requested',
      runId: 'run-2',
      message: 'need approval',
      toolName: 'dangerousTool',
    };

    const stores = createInMemoryGatewayStores();
    const job = createDueJob({
      targetKind: 'isolated_run',
      target: { goal: 'do something risky' },
    });

    const result = await executeCronTarget(job, {
      gatewayConfig: createTestGatewayConfig(),
      agentRegistry: createTestAgentRegistry(createStubAgent({ runResult: approvalResult })),
      stores,
      now: fixedNow,
      idFactory,
    });

    expect(result.status).toBe('needs_review');
    expect(result.error).toContain('approval');
  });

  it('returns failed for unknown target kind', async () => {
    const stores = createInMemoryGatewayStores();
    const job = createDueJob({
      targetKind: 'unknown_kind' as any,
      target: {},
    });

    const result = await executeCronTarget(job, {
      gatewayConfig: createTestGatewayConfig(),
      agentRegistry: createTestAgentRegistry(),
      stores,
      now: fixedNow,
      idFactory,
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('Unknown cron target kind');
  });
});

describe('createSchedulerLoop', () => {
  it('logs cron lifecycle events for successful runs', async () => {
    const stores = createInMemoryGatewayStores();
    const job = createDueJob();
    const logEntries: GatewayLogEntry[] = [];
    await stores.cronJobs.create(job);

    const scheduler = createSchedulerLoop({
      gatewayConfig: createTestGatewayConfig(),
      agentRegistry: createTestAgentRegistry(),
      stores,
      logger: createGatewayLogger((entry) => logEntries.push(entry)),
      leaseOwner: 'test-worker',
      now: fixedNow,
      idFactory,
      pollIntervalMs: 999_999,
    });

    try {
      expect(await scheduler.tick()).toBe(1);

      expect(logEntries.map((entry) => entry.event)).toEqual([
        GATEWAY_LOG_EVENTS.cron_claimed,
        GATEWAY_LOG_EVENTS.cron_dispatched,
        GATEWAY_LOG_EVENTS.cron_completed,
      ]);
      expect(logEntries[2]).toMatchObject({
        level: 'info',
        event: GATEWAY_LOG_EVENTS.cron_completed,
        data: expect.objectContaining({
          jobId: 'job-1',
          status: 'succeeded',
          targetKind: 'isolated_run',
        }),
      });
    } finally {
      scheduler.stop();
    }
  });

  it('logs cron failures when dispatch or delivery fails', async () => {
    const stores = createInMemoryGatewayStores();
    const job = createDueJob({
      deliveryMode: 'session',
    });
    const logEntries: GatewayLogEntry[] = [];
    await stores.cronJobs.create(job);

    const scheduler = createSchedulerLoop({
      gatewayConfig: createTestGatewayConfig(),
      agentRegistry: createTestAgentRegistry(),
      stores,
      logger: createGatewayLogger((entry) => logEntries.push(entry)),
      leaseOwner: 'test-worker',
      now: fixedNow,
      idFactory,
      pollIntervalMs: 999_999,
    });

    try {
      expect(await scheduler.tick()).toBe(1);

      expect(logEntries.map((entry) => entry.event)).toEqual([
        GATEWAY_LOG_EVENTS.cron_claimed,
        GATEWAY_LOG_EVENTS.cron_dispatched,
        GATEWAY_LOG_EVENTS.cron_failed,
      ]);
      expect(logEntries[2]).toMatchObject({
        level: 'error',
        event: GATEWAY_LOG_EVENTS.cron_failed,
        data: expect.objectContaining({
          jobId: 'job-1',
          status: 'failed',
          failureStage: 'delivery',
        }),
      });
    } finally {
      scheduler.stop();
    }
  });

  it('tick() claims due jobs and dispatches them', async () => {
    const stores = createInMemoryGatewayStores();
    const job = createDueJob();
    await stores.cronJobs.create(job);

    const scheduler = createSchedulerLoop({
      gatewayConfig: createTestGatewayConfig(),
      agentRegistry: createTestAgentRegistry(),
      stores,
      leaseOwner: 'test-worker',
      now: fixedNow,
      idFactory,
      pollIntervalMs: 999_999,
    });

    try {
      const dispatched = await scheduler.tick();
      expect(dispatched).toBe(1);

      const cronRuns = await stores.cronRuns.listByJob(job.id);
      expect(cronRuns).toHaveLength(1);
      expect(cronRuns[0]!.status).toBe('succeeded');
      expect(cronRuns[0]!.output).toBe('done');

      const updatedJob = await stores.cronJobs.get(job.id);
      expect(updatedJob?.nextFireAt).toBe('2026-01-01T00:05:00.000Z');
    } finally {
      scheduler.stop();
    }
  });

  it('tick() delivers completed cron results to the created session', async () => {
    const stores = createInMemoryGatewayStores();
    const job = createDueJob({
      targetKind: 'isolated_chat',
      target: {
        agentId: 'test-agent',
        content: 'hello from cron',
        channelId: 'cron-chan',
      },
      deliveryMode: 'session',
    });
    await stores.cronJobs.create(job);

    const scheduler = createSchedulerLoop({
      gatewayConfig: createTestGatewayConfig(),
      agentRegistry: createTestAgentRegistry(),
      stores,
      leaseOwner: 'test-worker',
      now: fixedNow,
      idFactory,
      pollIntervalMs: 999_999,
    });

    try {
      expect(await scheduler.tick()).toBe(1);

      const cronRuns = await stores.cronRuns.listByJob(job.id);
      expect(cronRuns).toHaveLength(1);
      expect(cronRuns[0]!.status).toBe('succeeded');
      expect(cronRuns[0]!.sessionId).toBeDefined();
      expect(cronRuns[0]!.output).toBe('done');

      const messages = await stores.transcriptMessages.listBySession(cronRuns[0]!.sessionId!);
      const deliveryMessages = messages.filter((message) => message.id === `cron-delivery-${cronRuns[0]!.id}`);
      expect(deliveryMessages).toHaveLength(1);
      expect(deliveryMessages[0]!.role).toBe('system');
      expect(deliveryMessages[0]!.content).toContain('[Scheduled job "job-1"] completed successfully');
    } finally {
      scheduler.stop();
    }
  });

  it('tick() records delivery failures on the cron run', async () => {
    const stores = createInMemoryGatewayStores();
    const job = createDueJob({
      deliveryMode: 'session',
    });
    await stores.cronJobs.create(job);

    const scheduler = createSchedulerLoop({
      gatewayConfig: createTestGatewayConfig(),
      agentRegistry: createTestAgentRegistry(),
      stores,
      leaseOwner: 'test-worker',
      now: fixedNow,
      idFactory,
      pollIntervalMs: 999_999,
    });

    try {
      expect(await scheduler.tick()).toBe(1);

      const cronRuns = await stores.cronRuns.listByJob(job.id);
      expect(cronRuns).toHaveLength(1);
      expect(cronRuns[0]!.status).toBe('failed');
      expect(cronRuns[0]!.error).toContain('Session delivery requires a sessionId');
      expect(cronRuns[0]!.metadata?.delivery).toEqual({
        delivered: false,
        error: 'Session delivery requires a sessionId on the cron run or delivery config.',
      });
    } finally {
      scheduler.stop();
    }
  });

  it('tick() advances nextFireAt so later ticks execute later occurrences', async () => {
    const stores = createInMemoryGatewayStores();
    const job = createDueJob();
    await stores.cronJobs.create(job);

    let now = new Date('2026-01-01T00:05:00.000Z');
    const scheduler = createSchedulerLoop({
      gatewayConfig: createTestGatewayConfig(),
      agentRegistry: createTestAgentRegistry(),
      stores,
      leaseOwner: 'test-worker',
      now: () => now,
      idFactory,
      pollIntervalMs: 999_999,
    });

    try {
      expect(await scheduler.tick()).toBe(1);

      now = new Date('2026-01-01T00:10:00.000Z');
      expect(await scheduler.tick()).toBe(1);

      const cronRuns = await stores.cronRuns.listByJob(job.id);
      expect(cronRuns.map((run) => run.fireTime)).toEqual([
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:05:00.000Z',
      ]);

      const updatedJob = await stores.cronJobs.get(job.id);
      expect(updatedJob?.nextFireAt).toBe('2026-01-01T00:10:00.000Z');
    } finally {
      scheduler.stop();
    }
  });

  it('tick() skips jobs that already have a cron run for that fire time', async () => {
    const stores = createInMemoryGatewayStores();
    const job = createDueJob();
    await stores.cronJobs.create(job);

    await stores.cronRuns.create({
      id: 'existing-run',
      jobId: job.id,
      fireTime: job.nextFireAt,
      status: 'succeeded',
      startedAt: '2026-01-01T00:01:00.000Z',
      finishedAt: '2026-01-01T00:02:00.000Z',
    });

    const scheduler = createSchedulerLoop({
      gatewayConfig: createTestGatewayConfig(),
      agentRegistry: createTestAgentRegistry(),
      stores,
      leaseOwner: 'test-worker',
      now: fixedNow,
      idFactory,
      pollIntervalMs: 999_999,
    });

    try {
      const dispatched = await scheduler.tick();
      expect(dispatched).toBe(0);

      const updatedJob = await stores.cronJobs.get(job.id);
      expect(updatedJob?.nextFireAt).toBe('2026-01-01T00:05:00.000Z');
    } finally {
      scheduler.stop();
    }
  });

  it('tick() records failed cron runs on dispatch errors', async () => {
    const failingAgent = createStubAgent({
      runResult: {
        status: 'failure',
        runId: 'fail-run',
        error: 'something broke',
        code: 'TOOL_ERROR',
        stepsUsed: 1,
        usage: { promptTokens: 0, completionTokens: 0, estimatedCostUSD: 0 },
      },
    });

    const stores = createInMemoryGatewayStores();
    const job = createDueJob();
    await stores.cronJobs.create(job);

    const scheduler = createSchedulerLoop({
      gatewayConfig: createTestGatewayConfig(),
      agentRegistry: createTestAgentRegistry(failingAgent),
      stores,
      leaseOwner: 'test-worker',
      now: fixedNow,
      idFactory,
      pollIntervalMs: 999_999,
    });

    try {
      const dispatched = await scheduler.tick();
      expect(dispatched).toBe(1);

      const cronRuns = await stores.cronRuns.listByJob(job.id);
      expect(cronRuns).toHaveLength(1);
      expect(cronRuns[0]!.status).toBe('failed');

      const updatedJob = await stores.cronJobs.get(job.id);
      expect(updatedJob?.nextFireAt).toBe('2026-01-01T00:05:00.000Z');
    } finally {
      scheduler.stop();
    }
  });

  it('disables jobs whose schedule cannot be advanced', async () => {
    const stores = createInMemoryGatewayStores();
    const job = createDueJob({ schedule: 'not-a-cron' });
    await stores.cronJobs.create(job);

    const scheduler = createSchedulerLoop({
      gatewayConfig: createTestGatewayConfig(),
      agentRegistry: createTestAgentRegistry(),
      stores,
      leaseOwner: 'test-worker',
      now: fixedNow,
      idFactory,
      pollIntervalMs: 999_999,
    });

    try {
      const dispatched = await scheduler.tick();
      expect(dispatched).toBe(1);

      const updatedJob = await stores.cronJobs.get(job.id);
      expect(updatedJob?.enabled).toBe(false);
      expect(updatedJob?.nextFireAt).toBe('2026-01-01T00:00:00.000Z');
    } finally {
      scheduler.stop();
    }
  });

  it('stop() prevents further tick execution', async () => {
    const stores = createInMemoryGatewayStores();
    const scheduler = createSchedulerLoop({
      gatewayConfig: createTestGatewayConfig(),
      agentRegistry: createTestAgentRegistry(),
      stores,
      pollIntervalMs: 999_999,
    });

    scheduler.stop();

    const dispatched = await scheduler.tick();
    expect(dispatched).toBe(0);
  });

  it('stop() waits for an in-flight tick to finish', async () => {
    const releaseTick = createDeferred<void>();
    const stores = createInMemoryGatewayStores();
    const scheduler = createSchedulerLoop({
      gatewayConfig: createTestGatewayConfig(),
      agentRegistry: createTestAgentRegistry(),
      stores: {
        ...stores,
        cronJobs: {
          ...stores.cronJobs,
          listDue: async () => {
            await releaseTick.promise;
            return [];
          },
        },
      },
      pollIntervalMs: 999_999,
    });

    const tickPromise = scheduler.tick();
    await Promise.resolve();

    let stopResolved = false;
    const stopPromise = scheduler.stop().then(() => {
      stopResolved = true;
    });

    await Promise.resolve();
    expect(stopResolved).toBe(false);

    releaseTick.resolve();

    await stopPromise;
    await expect(tickPromise).resolves.toBe(0);
    expect(stopResolved).toBe(true);
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
