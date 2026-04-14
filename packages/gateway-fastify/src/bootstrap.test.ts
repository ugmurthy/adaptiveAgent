import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { bootstrapGateway } from './bootstrap.js';
import type { CreatedAdaptiveAgent, RunResult } from './core.js';
import { createInMemoryGatewayStores } from './stores.js';

function createStubAgent(): CreatedAdaptiveAgent {
  const runResult: RunResult = {
    status: 'success',
    runId: 'run-1',
    output: 'done',
    stepsUsed: 1,
    usage: { promptTokens: 1, completionTokens: 1, estimatedCostUSD: 0 },
  };

  return {
    agent: {
      chat: async () => runResult,
      run: async () => runResult,
    },
    runtime: {
      runStore: { getRun: async () => ({ id: 'run-1', rootRunId: 'run-1', status: 'completed' }) },
      eventStore: {},
      snapshotStore: {},
      planStore: {},
    },
  };
}

async function createTempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'gateway-bootstrap-test-'));
}

function formatLogDate(date = new Date()): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await condition()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Condition was not met within ${timeoutMs}ms.`);
}

describe('bootstrapGateway cron lifecycle', () => {
  const tempDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
    tempDirectories.length = 0;
  });

  it('starts the scheduler automatically when the gateway begins listening', async () => {
    const workspace = await createTempWorkspace();
    tempDirectories.push(workspace);

    const gatewayConfigPath = join(workspace, 'gateway.json');
    const agentDirectory = join(workspace, 'agents');
    const agentConfigPath = join(agentDirectory, 'test-agent.json');

    await mkdir(agentDirectory, { recursive: true });
    await writeFile(
      gatewayConfigPath,
      JSON.stringify(
        {
          server: {
            host: '127.0.0.1',
            port: 3000,
            websocketPath: '/ws',
          },
          cron: {
            enabled: true,
            schedulerLeaseMs: 60_000,
            maxConcurrentJobs: 1,
          },
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
        },
        null,
        2,
      ),
    );
    await writeFile(
      agentConfigPath,
      JSON.stringify(
        {
          id: 'test-agent',
          name: 'Test Agent',
          invocationModes: ['chat', 'run'],
          defaultInvocationMode: 'chat',
          model: {
            provider: 'openrouter',
            model: 'test',
          },
          tools: [],
          delegates: [],
        },
        null,
        2,
      ),
    );

    const stores = createInMemoryGatewayStores();
    await stores.cronJobs.create({
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
    });

    const gateway = await bootstrapGateway({
      gatewayConfigPath,
      agentConfigDir: agentDirectory,
      agentFactory: () => createStubAgent(),
      stores,
      scheduler: {
        now: () => new Date('2026-01-01T00:05:00.000Z'),
        pollIntervalMs: 999_999,
      },
    });

    try {
      await gateway.app.listen({ host: '127.0.0.1', port: 0 });

      await waitFor(async () => {
        const cronRuns = await stores.cronRuns.listByJob('job-1');
        return cronRuns.length === 1 && cronRuns[0]?.status === 'succeeded';
      });

      const cronRuns = await stores.cronRuns.listByJob('job-1');
      expect(cronRuns).toHaveLength(1);
      expect(cronRuns[0]?.status).toBe('succeeded');
    } finally {
      await gateway.app.close();
    }
  });

  it('writes request logs to the configured bootstrap log directory', async () => {
    const workspace = await createTempWorkspace();
    tempDirectories.push(workspace);

    const gatewayConfigPath = join(workspace, 'gateway.json');
    const agentDirectory = join(workspace, 'agents');
    const logDir = join(workspace, 'logs');
    const agentConfigPath = join(agentDirectory, 'test-agent.json');

    await mkdir(agentDirectory, { recursive: true });
    await writeFile(
      gatewayConfigPath,
      JSON.stringify(
        {
          server: {
            host: '127.0.0.1',
            port: 3000,
            websocketPath: '/ws',
            healthPath: '/health',
            requestLogging: true,
            requestLoggingDestination: 'file',
          },
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
        },
        null,
        2,
      ),
    );
    await writeFile(
      agentConfigPath,
      JSON.stringify(
        {
          id: 'test-agent',
          name: 'Test Agent',
          invocationModes: ['chat', 'run'],
          defaultInvocationMode: 'chat',
          model: {
            provider: 'openrouter',
            model: 'test',
          },
          tools: [],
          delegates: [],
        },
        null,
        2,
      ),
    );

    const gateway = await bootstrapGateway({
      gatewayConfigPath,
      agentConfigDir: agentDirectory,
      agentFactory: () => createStubAgent(),
      logDir,
    });

    try {
      await gateway.app.inject({ method: 'GET', url: '/health' });
    } finally {
      await gateway.app.close();
    }

    const logContents = await readFile(join(logDir, `gateway-${formatLogDate()}.log`), 'utf-8');
    expect(logContents).toContain('"event":"http.request.started"');
    expect(logContents).toContain('"event":"http.request.completed"');
  });
});
