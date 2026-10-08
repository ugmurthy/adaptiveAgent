import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getSessionRecoveryTargets, type ModelAdapter, type ModelResponse } from '@adaptive-agent/core';
import { createAgentSdk, createOrchestrationSdk, createSwarmSdk, type AgentConfigFile, type AgentSdk } from './index.js';
import { testEnvironment } from './test-environment.js';

const directories: string[] = [];
const sdks: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(sdks.splice(0).map((sdk) => sdk.close()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(responses: Array<ModelResponse | Error>) {
  const cwd = await mkdtemp(join(tmpdir(), 'session-recovery-'));
  directories.push(cwd);
  await mkdir(join(cwd, 'agents'));
  const model: ModelAdapter = {
    provider: 'ollama', model: 'test',
    capabilities: { toolCalling: true, jsonOutput: true, streaming: false, usage: false },
    generate: async () => {
      calls++;
      const response = responses.shift();
      if (!response) throw new Error('Unexpected model call');
      if (response instanceof Error) throw response;
      return response;
    },
  };
  let calls = 0;
  const profile = (id: string, extra: Partial<AgentConfigFile> = {}): AgentConfigFile => ({
    id, name: id, invocationModes: ['run'], defaultInvocationMode: 'run',
    model: { provider: 'ollama', model: 'test' }, tools: [], ...extra,
  });
  const general = profile('general');
  await writeFile(join(cwd, 'agent.json'), JSON.stringify(general));
  const options = {
    cwd, agentConfigPath: join(cwd, 'agent.json'), runtimeMode: 'memory' as const,
    env: testEnvironment({ ADAPTIVE_AGENT_HOME: join(cwd, 'home') }),
    settingsConfig: { agents: { dirs: [join(cwd, 'agents')] }, logging: { enabled: false } },
    modelAdapter: model,
  };
  const sdk = await createAgentSdk(options);
  sdks.push(sdk);
  const addProfile = async (id: string, extra: Partial<AgentConfigFile> = {}) => {
    const path = join(cwd, 'agents', `${id}.json`);
    await writeFile(path, JSON.stringify(profile(id, extra)));
    return path;
  };
  return { sdk, options, general, addProfile, calls: () => calls };
}
const answer = (text: string): ModelResponse => ({ finishReason: 'stop', text });

describe('unified SDK session recovery', () => {
  it('plans without mutation, retries an ordinary run, and returns completed work without rerunning', async () => {
    const { sdk, calls } = await fixture([new Error('Model timed out'), answer('recovered')]);
    const failed = await sdk.runRaw('recover ordinary work', { sessionId: 'ordinary' });
    expect(failed.status).toBe('failure');
    const before = await sdk.inspect(failed.runId);
    const planned = await sdk.recover({ sessionId: 'ordinary', dryRun: true });
    expect(planned).toMatchObject({ outcome: 'planned', target: { kind: 'run', id: failed.runId }, actions: [], plans: [{ action: 'retry_same_run' }] });
    expect(await sdk.inspect(failed.runId)).toEqual(before);
    expect(calls()).toBe(1);
    expect(await sdk.recover({ sessionId: 'ordinary' })).toMatchObject({ outcome: 'completed', result: { runId: failed.runId, output: 'recovered' } });
    expect(await sdk.recoverRaw({ sessionId: 'ordinary' })).toMatchObject({ outcome: 'completed', actions: [], result: { output: 'recovered' } });
    expect(calls()).toBe(2);
  });

  it('reports independent unfinished runs as ambiguous, and an unknown session as not_found', async () => {
    const { sdk, calls } = await fixture([]);
    await sdk.created.runtime.runStore.createRun({ id: 'one', sessionId: 'ambiguous', goal: 'one', status: 'interrupted' });
    await sdk.created.runtime.runStore.createRun({ id: 'two', sessionId: 'ambiguous', goal: 'two', status: 'failed' });
    expect(await sdk.recover({ sessionId: 'ambiguous' })).toMatchObject({ outcome: 'ambiguous', actions: [], candidates: [{ id: 'one' }, { id: 'two' }] });
    expect(await sdk.recover({ sessionId: 'missing' })).toMatchObject({ outcome: 'not_found', actions: [] });
    await expect(sdk.recover({ sessionId: 'ambiguous', runId: 'one' } as never)).rejects.toThrow('exactly one');
    expect(calls()).toBe(0);
  });

  it('follows continuation identity instead of retrying its historical failed source or delegate children', async () => {
    const { sdk, calls } = await fixture([]);
    const store = sdk.created.runtime.runStore;
    await store.createRun({ id: 'old', sessionId: 'lineage', goal: 'work', status: 'failed' });
    await store.createRun({ id: 'continued', sessionId: 'lineage', goal: 'work', status: 'succeeded', metadata: { continuationOfRunId: 'old' } });
    await store.updateRun('continued', { result: 'already done' });
    await store.createRun({ id: 'child', sessionId: 'lineage', rootRunId: 'old', parentRunId: 'old', goal: 'child', status: 'failed' });
    expect(await getSessionRecoveryTargets(sdk.created.runtime, 'lineage')).toEqual([{ kind: 'run', id: 'continued', status: 'succeeded', runIds: ['continued'], lineageRootRunId: 'old' }]);
    expect(await sdk.recover({ sessionId: 'lineage' })).toMatchObject({ outcome: 'completed', actions: [], result: { runId: 'continued', output: 'already done' } });
    expect((await store.getRun('old'))?.status).toBe('failed');
    expect(calls()).toBe(0);
  });

  it('does not select a failed continuation branch when another branch already succeeded', async () => {
    const { sdk, calls } = await fixture([]);
    const store = sdk.created.runtime.runStore;
    await store.createRun({ id: 'source', sessionId: 'branches', goal: 'work', status: 'failed' });
    await store.createRun({ id: 'done', sessionId: 'branches', goal: 'work', status: 'succeeded', metadata: { continuationOfRunId: 'source' } });
    await store.createRun({ id: 'unfinished', sessionId: 'branches', goal: 'work', status: 'failed', metadata: { continuationOfRunId: 'source' } });
    expect(await sdk.recover({ sessionId: 'branches' })).toMatchObject({ outcome: 'ambiguous', actions: [], candidates: [{ id: 'done' }, { id: 'unfinished' }] });
    expect(calls()).toBe(0);
  });

  it('does not auto-resolve approvals or recover a live lease', async () => {
    const { sdk, calls } = await fixture([]);
    const store = sdk.created.runtime.runStore;
    await store.createRun({ id: 'approval', sessionId: 'approval', goal: 'write', status: 'awaiting_approval' });
    expect(await sdk.recover({ sessionId: 'approval', requireApproval: true })).toMatchObject({ outcome: 'blocked', plans: [{ action: 'requires_user_action' }] });
    await store.createRun({ id: 'busy', sessionId: 'busy', goal: 'busy', status: 'running' });
    await store.tryAcquireLease({ runId: 'busy', owner: 'another', ttlMs: 60_000, now: new Date() });
    expect(await sdk.recover({ sessionId: 'busy' })).toMatchObject({ outcome: 'busy', actions: [] });
    expect(calls()).toBe(0);
  });

  it('recovers a swarm through the same facade and preserves its successful worker', async () => {
    const quality = answer(JSON.stringify({ assessments: [] }));
    const { sdk, options, addProfile, calls } = await fixture([
      answer(JSON.stringify({ subtasks: [
        { id: 'a', subObjective: 'A', input: null, attachmentRefs: [], targetAgentId: 'worker' },
        { id: 'b', subObjective: 'B', input: null, attachmentRefs: [], targetAgentId: 'worker' },
      ] })), new Error('Model timed out'), answer('B preserved'), quality, answer('partial'),
      answer('A recovered'), quality, answer('complete'),
    ]);
    const worker = await addProfile('worker');
    const swarm = await createSwarmSdk({ ...options, coordinatorSdk: sdk, workerConfigPaths: [worker], maxWorkers: 1 });
    sdks.push(swarm);
    const initial = await swarm.run({ sessionId: 'swarm', topLevelObjective: 'A and B' });
    expect(initial.state).toBe('completed');
    const successful = initial.executionResult!.subtaskResults.find((result) => result.subtaskId === 'b')!;
    const before = await sdk.created.runtime.runStore.getRun(successful.runId);
    const recovery = await sdk.recover({ sessionId: 'swarm' });
    expect(recovery).toMatchObject({ outcome: 'completed', target: { kind: 'swarm' }, result: { output: 'complete' } });
    expect(await sdk.created.runtime.runStore.getRun(successful.runId)).toEqual(before);
    expect(await sdk.recover({ sessionId: 'swarm' })).toMatchObject({ outcome: 'completed', actions: [] });
    expect(calls()).toBe(8);
  });

  it('honors a coordinator selector when two unfinished swarms share a session', async () => {
    const { sdk, calls } = await fixture([]);
    for (const id of ['swarm-a', 'swarm-b']) await sdk.created.runtime.runStore.createRun({
      id, sessionId: 'two-swarms', goal: id, status: 'awaiting_approval', metadata: { agentId: 'general', orchestration: { kind: 'swarm', role: 'coordinator', coordinatorRunId: 'pending' } },
    });
    expect(await sdk.recover({ sessionId: 'two-swarms' })).toMatchObject({ outcome: 'ambiguous' });
    expect(await sdk.recover({ sessionId: 'two-swarms', coordinatorRunId: 'swarm-b' })).toMatchObject({ outcome: 'blocked', target: { id: 'swarm-b' }, plans: [{ runId: 'swarm-b', action: 'requires_user_action' }] });
    expect(calls()).toBe(0);
  });

  it('recovers saved orchestration stages and executes skipped synthesis under the original session', async () => {
    const { sdk, options, addProfile, calls } = await fixture([
      new Error('Model timed out'), answer('specialist recovered'), answer('synthesized'),
    ]);
    await addProfile('specialist', { capabilities: { modalitiesSupported: ['text'], subjectsPreferred: ['astronomy'] } });
    const orchestration = await createOrchestrationSdk({ ...options, requestedAgentConfig: sdk.config.agent, includeDiscoveredAgents: true, runtime: sdk.created.runtime, orchestrationStore: sdk.created.runtime.orchestrationStore });
    sdks.push(orchestration);
    const initial = await orchestration.runRaw('explain astronomy', { sessionId: 'orchestrated', executionId: 'execution-one' });
    expect(initial.finalResult.status).toBe('failure');
    const planned = await sdk.recover({ sessionId: 'orchestrated', dryRun: true });
    expect(planned, planned.reason).toMatchObject({ outcome: 'planned', target: { kind: 'orchestration', id: 'execution-one' } });
    expect(calls()).toBe(1);
    const recovered = await sdk.recover({ sessionId: 'orchestrated' });
    expect(recovered).toMatchObject({ outcome: 'completed', result: { finalResult: { output: 'synthesized' } } });
    const runs = await sdk.created.runtime.runStore.listBySession!('orchestrated');
    expect(runs).toHaveLength(2);
    expect(calls()).toBe(3);
    expect(await sdk.recover({ sessionId: 'orchestrated' })).toMatchObject({ outcome: 'completed', actions: [] });
    expect(calls()).toBe(3);
  });

  it('detects executions before any stage run exists, and requires an explicit selector for multiple plans', async () => {
    const { sdk, calls } = await fixture([]);
    const store = sdk.created.runtime.orchestrationStore;
    for (const id of ['execution-a', 'execution-b']) await store.createExecution({ id, status: 'failed', request: {}, catalogFingerprint: 'old', plan: { sessionId: 'plans' }, stages: [] });
    expect(await sdk.recover({ sessionId: 'plans' })).toMatchObject({ outcome: 'ambiguous', candidates: [{ id: 'execution-a' }, { id: 'execution-b' }] });
    expect(await sdk.recover({ sessionId: 'plans', executionId: 'not-in-session' })).toMatchObject({ outcome: 'not_found' });
    expect(calls()).toBe(0);
  });

  it('blocks historical orchestration model drift even when the catalog profiles have not changed', async () => {
    const { sdk, options, addProfile, calls } = await fixture([new Error('Model timed out')]);
    await addProfile('specialist', { capabilities: { modalitiesSupported: ['text'], subjectsPreferred: ['astronomy'] } });
    const orchestration = await createOrchestrationSdk({ ...options, requestedAgentConfig: sdk.config.agent, includeDiscoveredAgents: true, runtime: sdk.created.runtime, orchestrationStore: sdk.created.runtime.orchestrationStore });
    sdks.push(orchestration);
    await orchestration.runRaw('explain astronomy', { sessionId: 'historical-model', executionId: 'model-execution' });
    const changed = await createAgentSdk({ ...options, runtime: sdk.created.runtime, modelAdapter: { ...options.modelAdapter, model: 'different-model' } });
    sdks.push(changed);
    expect(await changed.recover({ sessionId: 'historical-model' })).toMatchObject({ outcome: 'blocked', actions: [], reason: expect.stringContaining('Historical model') });
    expect(calls()).toBe(1);
  });
});
