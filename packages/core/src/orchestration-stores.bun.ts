import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryOrchestrationStore, OrchestrationOptimisticConcurrencyError } from './in-memory-orchestration-store.js';
import { openSqliteRuntimeStores, type SqliteRuntimeStoreBundle } from './sqlite-runtime-stores.js';
import { createAdaptiveAgent, PreparedOrchestrationExecutor, type OrchestrationPlan } from './index.js';
import type { ModelAdapter, ModelResponse, OrchestrationExecution, OrchestrationStage, OrchestrationStore } from './types.js';

const firstRun = '00000000-0000-4000-8000-000000000001';
const secondRun = '00000000-0000-4000-8000-000000000002';
async function exercise(store: OrchestrationStore) {
  const execution = await store.createExecution({ request:{objective:'x'},catalogFingerprint:'sha256:x',plan:{nodes:['a','b']},stages:[{nodeId:'a',runId:firstRun,agentId:'worker'},{nodeId:'b',runId:secondRun,agentId:'reviewer',dependencies:['a'],upstreamRunIds:[firstRun]}] });
  expect((await store.claimReadyStage(execution.id))?.nodeId).toBe('a');
  expect(await store.claimReadyStage(execution.id)).toBeNull();
  const a=(await store.listStages(execution.id))[0]!; await store.updateStage(execution.id,'a',{status:'succeeded'},a.version);
  expect((await store.claimReadyStage(execution.id))?.nodeId).toBe('b');
  await expect(store.updateExecution(execution.id,{status:'running'},99)).rejects.toBeInstanceOf(OrchestrationOptimisticConcurrencyError);
  const updated=await store.updateExecution(execution.id,{status:'cancelled'},execution.version);
  const stages=await store.listStages(execution.id); const b=stages.find(s=>s.nodeId==='b')!; await store.updateStage(execution.id,'b',{status:'queued'},b.version);
  expect(await store.claimReadyStage(updated.id)).toBeNull();
  return updated.id;
}

async function expectFailedDependencyToBeTerminal(store: OrchestrationStore) {
  const execution = await store.createExecution({
    request: { objective: 'continue after failure' },
    catalogFingerprint: 'sha256:failure',
    plan: { nodes: ['worker', 'synthesis'] },
    stages: [
      { nodeId: 'worker', runId: crypto.randomUUID(), agentId: 'worker' },
      { nodeId: 'synthesis', runId: crypto.randomUUID(), agentId: 'synthesizer', dependencies: ['worker'] },
    ],
  });
  const worker = await store.claimReadyStage(execution.id);
  await store.updateStage(execution.id, 'worker', { status: 'failed' }, worker!.version);
  expect((await store.claimReadyStage(execution.id))?.nodeId).toBe('synthesis');
}

type SessionListingStore = OrchestrationStore & { listBySession(sessionId: string): Promise<OrchestrationExecution[]> };
type RunIdPatchStore = OrchestrationStore & { updateStage(executionId: string, nodeId: string, patch: { status?: OrchestrationStage['status']; runId?: string }, expectedVersion: number): Promise<OrchestrationStage> };

/** Creates executions for two sessions (one without any started stage) and patches a stage run ID. */
async function exerciseSessionListingAndRunIdPatch(store: SessionListingStore & RunIdPatchStore) {
  const ids = ['00000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000c1'];
  const create = (id: string, sessionId: string) => store.createExecution({ id, request: { objective: id }, catalogFingerprint: 'sha256:session', plan: { sessionId, nodes: ['a'] }, stages: [{ nodeId: 'a', runId: crypto.randomUUID(), agentId: 'worker' }] });
  await create(ids[0]!, 'session-listing');
  await create(ids[1]!, 'session-listing');
  await create(ids[2]!, 'session-listing-other');
  await store.createExecution({ id: crypto.randomUUID(), request: {}, catalogFingerprint: 'sha256:session', plan: { nodes: [] }, stages: [] });
  const listed = await store.listBySession('session-listing');
  expect(listed.map((execution) => execution.id).sort()).toEqual([ids[0], ids[1]].sort());
  const deterministic = [...listed].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  expect(listed.map((execution) => execution.id)).toEqual(deterministic.map((execution) => execution.id));
  expect(await store.listBySession('session-listing')).toEqual(listed);
  expect(await store.listBySession('session-')).toEqual([]);
  expect((await store.listBySession('session-listing-other')).map((execution) => execution.id)).toEqual([ids[2]]);

  const stage = (await store.listStages(ids[0]!))[0]!;
  const continuationRunId = crypto.randomUUID();
  const patched = await store.updateStage(ids[0]!, 'a', { status: 'succeeded', runId: continuationRunId }, stage.version);
  expect(patched).toMatchObject({ runId: continuationRunId, status: 'succeeded', version: stage.version + 1 });
  expect((await store.listStages(ids[0]!))[0]?.runId).toBe(continuationRunId);
  return { executionId: ids[0]!, continuationRunId };
}

describe('durable orchestration stores',()=>{
  test('in-memory optimistic versions, ready claims, and cancellation',async()=>{const store=new InMemoryOrchestrationStore();await exercise(store);await expectFailedDependencyToBeTerminal(store);});
  test('SQLite persists across reopen',async()=>{const dir=await mkdtemp(join(tmpdir(),'orchestration-'));const path=join(dir,'runtime.db');try{const first=openSqliteRuntimeStores({path});const id=await exercise(first.orchestrationStore);await expectFailedDependencyToBeTerminal(first.orchestrationStore);await first.close();const reopened=openSqliteRuntimeStores({path});expect((await reopened.orchestrationStore.getExecution(id))?.status).toBe('cancelled');expect(await reopened.orchestrationStore.listStages(id)).toHaveLength(2);await reopened.close();}finally{await rm(dir,{recursive:true,force:true});}});
  test('in-memory lists executions by plan session and accepts stage run ID patches',async()=>{await exerciseSessionListingAndRunIdPatch(new InMemoryOrchestrationStore());});
  test('SQLite lists executions by plan session and persists patched stage run IDs across reopen',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'orchestration-session-'));const path=join(dir,'runtime.db');
    try{
      const first=openSqliteRuntimeStores({path});
      const { executionId, continuationRunId }=await exerciseSessionListingAndRunIdPatch(first.orchestrationStore);
      await first.close();
      const reopened=openSqliteRuntimeStores({path});
      expect((await reopened.orchestrationStore.listStages(executionId))[0]?.runId).toBe(continuationRunId);
      expect((await reopened.orchestrationStore.listBySession('session-listing')).map((execution)=>execution.id)).toContain(executionId);
      await reopened.close();
    }finally{await rm(dir,{recursive:true,force:true});}
  });

  test('executes and recovers a prepared plan after SQLite reopen without duplicate continuation or sibling work', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'prepared-orchestration-'));
    const path = join(dir, 'runtime.db');
    const bundles: SqliteRuntimeStoreBundle[] = [];
    let recovering = false;
    let lookupEffects = 0;
    const modelCalls: Record<string, number> = { analysis: 0, sibling: 0, synthesis: 0 };
    let enterRecovery!: () => void;
    let releaseRecovery!: () => void;
    const entered = new Promise<void>((resolve) => { enterRecovery = resolve; });
    const gate = new Promise<void>((resolve) => { releaseRecovery = resolve; });
    const executorFor = (bundle: SqliteRuntimeStoreBundle) => {
      const runners = Object.fromEntries(['analysis', 'sibling', 'synthesis'].map((id) => {
        const model: ModelAdapter = {
          provider: 'test', model: id,
          capabilities: { toolCalling: true, jsonOutput: true, streaming: false, usage: false },
          async generate(request): Promise<ModelResponse> {
            modelCalls[id]++;
            if (id === 'analysis' && !recovering) {
              if (modelCalls.analysis === 1) return { finishReason: 'tool_calls', toolCalls: [{ id: 'lookup-1', name: 'lookup', input: {} }] };
              throw new Error('Invalid model output after completed lookup');
            }
            if (id === 'analysis') {
              enterRecovery();
              await gate;
            }
            if (id === 'synthesis') {
              const message = request.messages.find((item) => item.role === 'user');
              const input = JSON.parse(message!.content as string).input;
              return { finishReason: 'stop', structuredOutput: { sum: input.analysis.value + input.sibling.value } };
            }
            return { finishReason: 'stop', structuredOutput: { value: id === 'analysis' ? 17 : 31 } };
          },
        };
        const { agent } = createAdaptiveAgent({ model, runtime: bundle, tools: [{ name: 'lookup', description: 'Read a finding', inputSchema: { type: 'object' }, async execute() { lookupEffects++; return { finding: 11 }; } }] });
        return [id, {
          agent, inspect: async (runId: string) => ({ run: await bundle.runStore.getRun(runId) }),
          resumeRaw: agent.resume.bind(agent), getRecoveryPlan: agent.getRecoveryPlan.bind(agent), recoverRaw: agent.recover.bind(agent),
        }];
      }));
      return new PreparedOrchestrationExecutor({
        getStore: () => bundle.orchestrationStore, catalogFingerprint: 'catalog-v1', hasAgent: (id) => id in runners,
        getRunner: async (id) => runners[id],
        runNode: ({ runner, goal, options, node, runId, sessionId, priorResults }) => runner.agent.run({
          ...options, goal, runId, sessionId,
          input: node.id === 'synthesis' ? Object.fromEntries([...priorResults].map(([id, stage]) => [id, stage.result.status === 'success' ? stage.result.output : null])) : undefined,
        }),
      });
    };
    try {
      const first = openSqliteRuntimeStores({ path });
      bundles.push(first);
      const plan: OrchestrationPlan = {
        executionId: 'prepared-execution', sessionId: 'conversation', requestedAgentId: 'synthesis', catalogFingerprint: 'catalog-v1',
        detectedModalities: ['text'], detectedSubjects: [], inputClaims: [{ id: 'goal', modality: 'text', source: 'goal' }],
        executionShape: 'parallel_fanout_then_synthesis', finalNodeId: 'synthesis', routingReason: 'Prepared by host',
        routingDecision: { mode: 'orchestration', primaryAgentId: 'synthesis', selectedCatalogAgentIds: ['analysis', 'sibling', 'synthesis'], assignments: [{ agentId: 'analysis', modalities: ['text'], reason: 'Prepared' }], reason: 'Prepared', source: 'deterministic' },
        routingDiagnostics: { subjectCandidates: [] },
        nodes: [
          { id: 'analysis', agentId: 'analysis', stage: 'parallel_specialist', dependsOn: [] },
          { id: 'sibling', agentId: 'sibling', stage: 'parallel_specialist', dependsOn: [] },
          { id: 'synthesis', agentId: 'synthesis', stage: 'final_synthesis', dependsOn: ['analysis', 'sibling'] },
        ],
      };
      const request = { goal: 'Combine both findings', options: {} };
      const initial = await executorFor(first).start({ executionId: 'prepared-execution', plan, request, persistedRequest: request, catalogFingerprint: 'catalog-v1' });
      expect(initial.finalResult.status).toBe('failure');
      const before = await first.orchestrationStore.listStages('prepared-execution');
      const failedStage = before.find((stage) => stage.nodeId === 'analysis')!;
      const siblingStage = before.find((stage) => stage.nodeId === 'sibling')!;
      await first.close();
      bundles.pop();
      recovering = true;
      const reopened = openSqliteRuntimeStores({ path });
      const competing = openSqliteRuntimeStores({ path });
      bundles.push(reopened, competing);
      const executor = executorFor(reopened);
      const planned = await executor.recoverExecution('prepared-execution', { dryRun: true });
      expect(planned).toMatchObject({ outcome: 'planned', actions: [], plans: [{ action: 'continue_new_run' }] });
      expect(await reopened.orchestrationStore.listStages('prepared-execution')).toEqual(before);
      const inFlight = executor.recoverExecution('prepared-execution');
      await entered;
      expect(await executor.recoverExecution('prepared-execution')).toMatchObject({ outcome: 'busy' });
      expect(await executorFor(competing).recoverExecution('prepared-execution')).toMatchObject({ outcome: 'busy' });
      releaseRecovery();
      const recovered = await inFlight;
      expect(recovered).toMatchObject({ outcome: 'completed', result: { sessionId: 'conversation', finalResult: { status: 'success', output: { sum: 48 } } } });
      const after = await reopened.orchestrationStore.listStages('prepared-execution');
      expect(after.find((stage) => stage.nodeId === 'sibling')).toEqual(siblingStage);
      const continuationId = after.find((stage) => stage.nodeId === 'analysis')!.runId;
      expect(continuationId).not.toBe(failedStage.runId);
      expect((await reopened.continuationStore.listBySourceRun(failedStage.runId)).map((item) => item.continuationRunId)).toEqual([continuationId]);
      expect([...after.find((stage) => stage.nodeId === 'synthesis')!.upstreamRunIds].sort()).toEqual([continuationId, siblingStage.runId].sort());
      expect((await reopened.runStore.getRun(failedStage.runId))?.status).toBe('failed');
      expect(await executorFor(competing).recoverExecution('prepared-execution')).toMatchObject({ outcome: 'completed', actions: [] });
      expect(lookupEffects).toBe(1);
      expect(modelCalls).toEqual({ analysis: 3, sibling: 1, synthesis: 1 });
      expect(await competing.orchestrationStore.listStages('prepared-execution')).toEqual(after);
    } finally {
      releaseRecovery();
      await Promise.all(bundles.map((bundle) => bundle.close()));
      await rm(dir, { recursive: true, force: true });
    }
  });
});
