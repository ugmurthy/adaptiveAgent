import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryOrchestrationStore, OrchestrationOptimisticConcurrencyError } from './in-memory-orchestration-store.js';
import { openSqliteRuntimeStores } from './sqlite-runtime-stores.js';
import type { OrchestrationStore } from './types.js';

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

describe('durable orchestration stores',()=>{
  test('in-memory optimistic versions, ready claims, and cancellation',async()=>{const store=new InMemoryOrchestrationStore();await exercise(store);await expectFailedDependencyToBeTerminal(store);});
  test('SQLite persists across reopen',async()=>{const dir=await mkdtemp(join(tmpdir(),'orchestration-'));const path=join(dir,'runtime.db');try{const first=openSqliteRuntimeStores({path});const id=await exercise(first.orchestrationStore);await expectFailedDependencyToBeTerminal(first.orchestrationStore);await first.close();const reopened=openSqliteRuntimeStores({path});expect((await reopened.orchestrationStore.getExecution(id))?.status).toBe('cancelled');expect(await reopened.orchestrationStore.listStages(id)).toHaveLength(2);await reopened.close();}finally{await rm(dir,{recursive:true,force:true});}});
});
