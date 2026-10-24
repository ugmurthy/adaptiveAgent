import { describe, expect, it } from 'vitest';

import { InMemoryOrchestrationStore, PreparedOrchestrationExecutor, type OrchestrationPlan, type PreparedOrchestrationStartInput } from './index.js';

function preparedInput(): PreparedOrchestrationStartInput {
  const plan: OrchestrationPlan = {
    executionId: 'execution', sessionId: 'conversation', requestedAgentId: 'writer',
    catalogFingerprint: 'catalog-v1', detectedModalities: ['text'], detectedSubjects: [],
    inputClaims: [{ id: 'goal', modality: 'text', source: 'goal' }],
    executionShape: 'sequential', finalNodeId: 'synthesis', routingReason: 'Prepared by host',
    routingDecision: {
      mode: 'orchestration', primaryAgentId: 'writer', synthesisAgentId: 'writer',
      assignments: [{ agentId: 'worker', modalities: ['text'], reason: 'Prepared by host' }],
      selectedCatalogAgentIds: ['worker', 'writer'], reason: 'Prepared by host', source: 'deterministic',
    },
    routingDiagnostics: { subjectCandidates: [] },
    nodes: [
      { id: 'analysis', agentId: 'worker', stage: 'subject_specialist', dependsOn: [], inputSelector: { claimIds: ['goal'] } },
      { id: 'synthesis', agentId: 'writer', stage: 'final_synthesis', dependsOn: ['analysis'], inputSelector: { includePriorOutputs: ['analysis'] } },
    ],
  };
  return { executionId: 'execution', plan, request: { goal: 'Prepare a report', options: {} }, persistedRequest: { goal: 'Prepare a report', options: {} }, catalogFingerprint: 'catalog-v1' };
}

describe('prepared orchestration execution boundary', () => {
  const invalidInputs: Array<[string, (input: PreparedOrchestrationStartInput) => void, RegExp]> = [
    ['duplicate node IDs', (input) => { input.plan.nodes[1].id = 'analysis'; }, /unique IDs/],
    ['unknown dependency', (input) => { input.plan.nodes[1].dependsOn = ['missing']; }, /unknown dependency/],
    ['dependency cycle', (input) => { input.plan.nodes[0].dependsOn = ['synthesis']; }, /dependency cycle/],
    ['missing final node', (input) => { input.plan.finalNodeId = 'missing'; }, /final node/],
    ['unavailable agent', (input) => { input.plan.nodes[0].agentId = 'unknown'; }, /unavailable/],
    ['unknown input claim', (input) => { input.plan.nodes[0].inputSelector = { claimIds: ['unknown'] }; }, /unknown input claim/],
    ['output without dependency', (input) => { input.plan.nodes[0].inputSelector = { includePriorOutputs: ['synthesis'] }; }, /non-dependency output/],
    ['mismatched execution ID', (input) => { input.plan.executionId = 'other'; }, /execution identity/],
    ['mismatched fingerprint', (input) => { input.catalogFingerprint = 'different'; }, /catalog fingerprint/],
    ['mismatched replay goal', (input) => { input.persistedRequest.goal = 'Different work'; }, /request goals differ/],
    ['invalid execution policy', (input) => { input.request.options.executionContext = [] as never; }, /executionContext/],
  ];

  it.each(invalidInputs)('rejects %s before persisting or starting work', async (_name, change, message) => {
    const store = new InMemoryOrchestrationStore();
    const executor = new PreparedOrchestrationExecutor({
      getStore: () => store, catalogFingerprint: 'catalog-v1', hasAgent: (id) => ['worker', 'writer'].includes(id),
      getRunner: async () => { throw new Error('Invalid input must not reach a runner'); },
      runNode: async () => { throw new Error('Invalid input must not start work'); },
    });
    const input = preparedInput();
    change(input);
    await expect(executor.start(input)).rejects.toThrow(message);
    expect(await store.getExecution('execution')).toBeNull();
    expect(await store.listStages('execution')).toEqual([]);
  });

  it.each(['resume', 'recover'] as const)('rejects stored stage/profile mismatches before %s mutates the execution', async (method) => {
    const input = preparedInput();
    const store = new InMemoryOrchestrationStore();
    const execution = await store.createExecution({
      id: input.executionId, status: 'failed', catalogFingerprint: input.catalogFingerprint,
      request: JSON.parse(JSON.stringify(input.persistedRequest)), plan: JSON.parse(JSON.stringify(input.plan)),
      stages: input.plan.nodes.map((node) => ({ nodeId: node.id, agentId: 'wrong-profile', runId: crypto.randomUUID(), dependencies: node.dependsOn })),
    });
    const before = await store.listStages(execution.id);
    const executor = new PreparedOrchestrationExecutor({
      getStore: () => store, catalogFingerprint: input.catalogFingerprint, hasAgent: () => true,
      getRunner: async () => { throw new Error('Mismatched stage must not reach a runner'); },
      runNode: async () => { throw new Error('Mismatched stage must not start work'); },
    });
    await expect(method === 'resume' ? executor.resumeExecution(execution.id) : executor.recoverExecution(execution.id)).rejects.toThrow('stored stage');
    expect(await store.getExecution(execution.id)).toEqual(execution);
    expect(await store.listStages(execution.id)).toEqual(before);
  });
});
