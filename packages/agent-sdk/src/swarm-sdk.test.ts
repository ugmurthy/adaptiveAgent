import { createAdaptiveAgentRuntime } from '@adaptive-agent/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AgentSdk,
  SwarmSdk,
  loadAgentSdkConfig,
  type AgentConfigFile,
  type ResolvedAgentSdkConfig,
} from './index.js';
import { runSwarmDecomposition } from './swarm-runner.js';
import { testEnvironment } from './test-environment.js';

const openSdks: AgentSdk[] = [];

afterEach(async () => {
  await Promise.allSettled(openSdks.splice(0).map((sdk) => sdk.close()));
});

describe('SwarmSdk', () => {
  it('forwards a per-run inference tier into coordinator authorization', async () => {
    const runRaw = vi.fn(async () => ({
      status: 'success' as const,
      runId: 'coordinator-run',
      output: { subtasks: [] },
      stepsUsed: 1,
      usage: { promptTokens: 0, completionTokens: 0, estimatedCostUSD: 0 },
    }));

    await runSwarmDecomposition({
      coordinatorSdk: { runRaw } as unknown as AgentSdk,
      sessionId: 'session-tier',
      topLevelObjective: 'decompose this',
      workerAgents: [agentConfig('worker')],
      workerIds: ['worker'],
      inputJson: undefined,
      inferenceTier: 'high',
    });

    expect(runRaw).toHaveBeenCalledWith('decompose this', expect.objectContaining({ inferenceTier: 'high' }));
  });

  it('rejects duplicate worker IDs during transport-neutral resolution', async () => {
    const coordinator = await resolvedConfig('coordinator');
    const worker = await resolvedConfig('worker');
    await expect(SwarmSdk.resolveConfig({
      coordinatorConfig: coordinator,
      workerConfigs: [worker, worker],
      qualityConfig: await resolvedConfig('quality'),
      synthesizerConfig: await resolvedConfig('synthesizer'),
    })).rejects.toThrow('duplicate agent id: worker');
  });

  it('classifies persisted decomposition and active execution without owning the caller SDK', async () => {
    const runtime = createAdaptiveAgentRuntime();
    const coordinator = await AgentSdk.create({ agentConfig: agentConfig('coordinator'), runtime, env: testEnvironment() });
    openSdks.push(coordinator);
    const runStore = coordinator.created.runtime.runStore;
    const lifecycle: string[] = [];
    const swarm = await SwarmSdk.create({
      coordinatorSdk: coordinator,
      workerConfigs: [await resolvedConfig('worker')],
      qualityConfig: await resolvedConfig('quality'),
      synthesizerConfig: await resolvedConfig('synthesizer'),
      lifecycleListener: (event) => lifecycle.push(`${event.phase}:${event.state}`),
    });

    let ready = await runStore.createRun({
      sessionId: 'session-ready',
      goal: 'decompose',
      status: 'succeeded',
      metadata: { orchestration: { kind: 'swarm', coordinatorRunId: 'pending', role: 'coordinator' } },
    });
    ready = await runStore.updateRun(ready.id, {
      result: { subtasks: [{ id: 'one', subObjective: 'work', input: null, attachmentRefs: [], targetAgentId: 'worker' }] },
    }, ready.version);
    const activeCoordinator = await runStore.createRun({
      sessionId: 'session-active',
      goal: 'execute',
      status: 'running',
      metadata: { orchestration: { kind: 'swarm', coordinatorRunId: 'pending', role: 'coordinator' } },
    });
    await runStore.updateRun(activeCoordinator.id, {
      metadata: { orchestration: { kind: 'swarm', coordinatorRunId: activeCoordinator.id, role: 'coordinator' } },
    }, activeCoordinator.version);

    await expect(swarm.inspectSession('missing')).resolves.toMatchObject({ state: 'not_started' });
    await expect(swarm.inspectSession('session-ready')).resolves.toMatchObject({
      state: 'ready',
      coordinatorRunId: ready.id,
    });
    await expect(swarm.inspectSession('session-active')).resolves.toMatchObject({ state: 'active' });
    expect(lifecycle).toEqual(['initialization:started', 'initialization:completed']);

    let finalizersPending = await runStore.createRun({
      sessionId: 'session-finalizers-pending',
      goal: 'decompose',
      status: 'succeeded',
      metadata: {
        orchestration: { kind: 'swarm', coordinatorRunId: 'pending', role: 'coordinator' },
        swarmExecution: {
          schemaVersion: 1,
          sessionId: 'session-finalizers-pending',
          coordinatorRunId: 'pending',
          topLevelObjective: 'finish the swarm',
          maxWorkers: 1,
          subtasks: [],
          agents: { workerAgentIds: {} },
        },
      },
    });
    finalizersPending = await runStore.updateRun(finalizersPending.id, {
      result: { subtasks: [] },
      metadata: {
        orchestration: { kind: 'swarm', coordinatorRunId: finalizersPending.id, role: 'coordinator' },
        swarmExecution: {
          schemaVersion: 1,
          sessionId: 'session-finalizers-pending',
          coordinatorRunId: finalizersPending.id,
          topLevelObjective: 'finish the swarm',
          maxWorkers: 1,
          subtasks: [],
          agents: { workerAgentIds: {} },
        },
      },
    }, finalizersPending.version);
    await expect(swarm.inspectSession('session-finalizers-pending')).resolves.toMatchObject({
      state: 'failed',
      retryable: true,
      coordinatorRunId: finalizersPending.id,
    });

    await swarm.close();
    await swarm.close();
    await expect(coordinator.inspect(ready.id)).resolves.toMatchObject({ run: { id: ready.id } });
  });
});

async function resolvedConfig(id: string): Promise<ResolvedAgentSdkConfig> {
  return loadAgentSdkConfig({
    agentConfig: agentConfig(id),
    settingsConfig: { runtime: { mode: 'memory' } },
  });
}

function agentConfig(id: string): AgentConfigFile {
  return {
    version: 1,
    id,
    name: id,
    invocationModes: ['run', 'chat'],
    defaultInvocationMode: 'run',
    model: { provider: 'ollama', model: 'test-model' },
    tools: [],
  };
}
