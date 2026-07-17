import { describe, expect, it } from 'vitest';

import { AdaptiveAgent } from './adaptive-agent.js';
import { InMemoryEventStore } from './in-memory-event-store.js';
import { InMemoryRunStore } from './in-memory-run-store.js';
import { InMemorySnapshotStore } from './in-memory-snapshot-store.js';
import { SwarmCoordinator } from './swarm-coordinator.js';
import type { ModelAdapter, ModelRequest, ModelResponse, ToolDefinition } from './types.js';

class SequenceModel implements ModelAdapter {
  readonly provider = 'test';
  readonly model: string;
  readonly capabilities = {
    toolCalling: true,
    jsonOutput: true,
    streaming: false,
    usage: false,
  };

  readonly receivedRequests: ModelRequest[] = [];

  constructor(model: string, private readonly responses: Array<ModelResponse | Error>) {
    this.model = model;
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const { signal: _signal, onRetry: _onRetry, ...cloneableRequest } = request;
    this.receivedRequests.push(structuredClone(cloneableRequest));
    const response = this.responses.shift();
    if (!response) {
      throw new Error(`${this.model} received an unexpected generate() call`);
    }
    if (response instanceof Error) {
      throw response;
    }
    return structuredClone(response);
  }
}

function createAgent(model: ModelAdapter, runStore: InMemoryRunStore): AdaptiveAgent {
  return new AdaptiveAgent({
    model,
    tools: [],
    runStore,
    eventStore: new InMemoryEventStore(),
    snapshotStore: new InMemorySnapshotStore(),
  });
}

describe('InMemoryRunStore session queries', () => {
  it('lists runs by session with deterministic pagination', async () => {
    const store = new InMemoryRunStore();
    await store.createRun({ id: 'run-a', sessionId: 'session-1', goal: 'A', status: 'queued' });
    await store.createRun({ id: 'run-b', sessionId: 'session-2', goal: 'B', status: 'queued' });
    await store.createRun({ id: 'run-c', sessionId: 'session-1', goal: 'C', status: 'queued' });

    const firstPage = await store.listBySession('session-1', { limit: 1 });
    const secondPage = await store.listBySession('session-1', { limit: 1, offset: 1 });
    const ascending = await store.listBySession('session-1', { order: 'asc' });
    const descending = await store.listBySession('session-1', { order: 'desc' });

    expect(firstPage).toHaveLength(1);
    expect(secondPage).toHaveLength(1);
    expect(new Set([firstPage[0]?.id, secondPage[0]?.id])).toEqual(new Set(['run-a', 'run-c']));
    expect(ascending.map((run) => run.id)).toEqual(['run-a', 'run-c']);
    expect(descending.map((run) => run.id)).toEqual(['run-c', 'run-a']);
    expect((await store.listBySession('missing'))).toEqual([]);
  });
});

describe('SwarmCoordinator', () => {
  it('runs text-only decomposition workers quality and synthesis under one session', async () => {
    const runStore = new InMemoryRunStore();
    const coordinatorModel = new SequenceModel('coordinator', [
      {
        finishReason: 'stop',
        structuredOutput: {
          subtasks: [
            {
              id: 'subtask-1',
              subObjective: 'Research the market.',
              input: null,
              attachmentRefs: [],
              targetAgentId: 'researcher',
            },
            {
              id: 'subtask-2',
              subObjective: 'Draft the recommendation.',
              input: null,
              attachmentRefs: [],
              targetAgentId: 'writer',
            },
          ],
        },
      },
    ]);
    const researcherModel = new SequenceModel('researcher', [
      { finishReason: 'stop', structuredOutput: { finding: 'market is attractive' } },
    ]);
    const writerModel = new SequenceModel('writer', [
      { finishReason: 'stop', structuredOutput: { draft: 'enter with pilots' } },
    ]);
    const qualityModel = new SequenceModel('quality', [
      {
        finishReason: 'stop',
        structuredOutput: {
          assessments: [
            { subtaskId: 'subtask-1', usable: true, score: 0.9, recommendation: 'use' },
            { subtaskId: 'subtask-2', usable: true, score: 0.8, recommendation: 'use' },
          ],
        },
      },
    ]);
    const synthesizerModel = new SequenceModel('synthesizer', [
      { finishReason: 'stop', structuredOutput: { answer: 'Enter with a pilot-led market plan.' } },
    ]);

    const swarm = new SwarmCoordinator({
      runStore,
      coordinatorAgent: createAgent(coordinatorModel, runStore),
      workerAgents: {
        researcher: createAgent(researcherModel, runStore),
        writer: createAgent(writerModel, runStore),
      },
      qualityAgent: createAgent(qualityModel, runStore),
      synthesizerAgent: createAgent(synthesizerModel, runStore),
    });

    const result = await swarm.run({
      sessionId: 'session-swarm-1',
      topLevelObjective: 'Create a market entry recommendation.',
      maxWorkers: 1,
    });

    expect(result).toMatchObject({
      sessionId: 'session-swarm-1',
      status: 'succeeded',
      output: { answer: 'Enter with a pilot-led market plan.' },
      subtaskResults: [
        { subtaskId: 'subtask-1', status: 'succeeded', output: { finding: 'market is attractive' } },
        { subtaskId: 'subtask-2', status: 'succeeded', output: { draft: 'enter with pilots' } },
      ],
      qualityAssessments: [
        { subtaskId: 'subtask-1', usable: true, recommendation: 'use' },
        { subtaskId: 'subtask-2', usable: true, recommendation: 'use' },
      ],
    });

    const sessionRuns = await runStore.listBySession('session-swarm-1');
    expect(sessionRuns).toHaveLength(5);
    const runsByRole = new Map(
      sessionRuns.map((run) => [
        typeof run.metadata?.orchestration === 'object' && run.metadata.orchestration !== null
          ? String(run.metadata.orchestration.role)
          : run.id,
        run,
      ]),
    );
    const coordinatorRun = await runStore.getRun(result.coordinatorRunId);
    expect(coordinatorRun).toMatchObject({
      parentRunId: undefined,
      rootRunId: result.coordinatorRunId,
      result,
    });
    expect(coordinatorRun?.metadata?.orchestration).toMatchObject({
      kind: 'swarm',
      coordinatorRunId: result.coordinatorRunId,
      role: 'coordinator',
    });
    expect(result.subtaskResults.every((subtask) => subtask.rootRunId === subtask.runId)).toBe(true);
    expect(runsByRole.get('quality')?.metadata?.orchestration).toMatchObject({
      coordinatorRunId: result.coordinatorRunId,
      role: 'quality',
    });
    expect(runsByRole.get('synthesizer')?.metadata?.orchestration).toMatchObject({
      coordinatorRunId: result.coordinatorRunId,
      role: 'synthesizer',
    });
    expect(researcherModel.receivedRequests[0]?.messages.at(-1)?.content).toContain('Research the market.');
    expect(synthesizerModel.receivedRequests[0]?.messages.at(-1)?.content).toContain('qualityAssessments');
    expect(coordinatorModel.receivedRequests[0]?.outputSchema).toMatchObject({
      type: 'object',
      required: ['subtasks'],
      additionalProperties: false,
      properties: {
        subtasks: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'subObjective', 'input', 'attachmentRefs', 'targetAgentId'],
            additionalProperties: false,
            properties: {
              input: { type: ['string', 'null'] },
              attachmentRefs: { type: 'array', items: { type: 'string' } },
              targetAgentId: { type: 'string', enum: ['researcher', 'writer'] },
            },
          },
        },
      },
    });
    expect(qualityModel.receivedRequests[0]?.outputSchema).toMatchObject({
      type: 'object',
      required: ['assessments'],
      additionalProperties: false,
      properties: {
        assessments: {
          type: 'array',
          items: {
            type: 'object',
            required: ['subtaskId', 'runId', 'usable', 'score', 'issues', 'recommendation'],
            additionalProperties: false,
            properties: {
              runId: { type: ['string', 'null'] },
              score: { type: ['number', 'null'] },
              issues: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    });
  });

  it('retries failed swarm workers in place and creates fresh quality and synthesizer runs', async () => {
    const runStore = new InMemoryRunStore();
    const researcherModel = new SequenceModel('researcher', [
      new Error('Model timed out after 90000ms'),
      { finishReason: 'stop', structuredOutput: { finding: 'market recovered' } },
    ]);
    const writerModel = new SequenceModel('writer', [
      { finishReason: 'stop', structuredOutput: { draft: 'initial draft' } },
    ]);
    const qualityModel = new SequenceModel('quality', [
      {
        finishReason: 'stop',
        structuredOutput: {
          assessments: [
            { subtaskId: 'subtask-1', usable: false, recommendation: 'retry' },
            { subtaskId: 'subtask-2', usable: true, recommendation: 'use' },
          ],
        },
      },
      {
        finishReason: 'stop',
        structuredOutput: {
          assessments: [
            { subtaskId: 'subtask-1', usable: true, recommendation: 'use' },
            { subtaskId: 'subtask-2', usable: true, recommendation: 'use' },
          ],
        },
      },
    ]);
    const synthesizerModel = new SequenceModel('synthesizer', [
      { finishReason: 'stop', structuredOutput: { answer: 'Initial answer with a gap.' } },
      { finishReason: 'stop', structuredOutput: { answer: 'Recovered answer.' } },
    ]);

    const swarm = new SwarmCoordinator({
      runStore,
      coordinatorAgent: createAgent(new SequenceModel('coordinator', []), runStore),
      coordinatorAgentId: 'coordinator',
      workerAgents: {
        researcher: createAgent(researcherModel, runStore),
        writer: createAgent(writerModel, runStore),
      },
      qualityAgent: createAgent(qualityModel, runStore),
      qualityAgentId: 'quality',
      synthesizerAgent: createAgent(synthesizerModel, runStore),
      synthesizerAgentId: 'synthesizer',
    });
    await runStore.createRun({
      id: 'coordinator-run-retry',
      sessionId: 'session-swarm-retry',
      goal: 'Create a market entry recommendation.',
      metadata: { orchestration: { kind: 'swarm', coordinatorRunId: 'pending', role: 'coordinator' } },
      status: 'running',
    });

    const initial = await swarm.execute({
      sessionId: 'session-swarm-retry',
      topLevelObjective: 'Create a market entry recommendation.',
      coordinatorRunId: 'coordinator-run-retry',
      maxWorkers: 2,
      subtasks: [
        { id: 'subtask-1', subObjective: 'Research the market.', targetAgentId: 'researcher' },
        { id: 'subtask-2', subObjective: 'Draft the recommendation.', targetAgentId: 'writer' },
      ],
    });

    expect(initial).toMatchObject({
      status: 'succeeded',
      output: { answer: 'Initial answer with a gap.' },
      subtaskResults: [
        { subtaskId: 'subtask-1', status: 'failed', errorCode: 'MODEL_ERROR' },
        { subtaskId: 'subtask-2', status: 'succeeded' },
      ],
    });

    const failedWorkerRunId = initial.subtaskResults[0]!.runId;
    const firstQualityRunId = initial.qualityRunId;
    const firstSynthesizerRunId = initial.synthesizerRunId;

    const retried = await swarm.retrySession({ sessionId: 'session-swarm-retry' });

    expect(retried).toMatchObject({
      sessionId: 'session-swarm-retry',
      coordinatorRunId: 'coordinator-run-retry',
      status: 'succeeded',
      output: { answer: 'Recovered answer.' },
      retriedWorkerRunIds: [failedWorkerRunId],
      subtaskResults: [
        { subtaskId: 'subtask-1', runId: failedWorkerRunId, status: 'succeeded', output: { finding: 'market recovered' } },
        { subtaskId: 'subtask-2', status: 'succeeded', output: { draft: 'initial draft' } },
      ],
    });
    expect(retried.qualityRunId).toBeDefined();
    expect(retried.synthesizerRunId).toBeDefined();
    expect(retried.qualityRunId).not.toBe(firstQualityRunId);
    expect(retried.synthesizerRunId).not.toBe(firstSynthesizerRunId);

    const failedWorker = await runStore.getRun(failedWorkerRunId);
    expect(failedWorker).toMatchObject({
      status: 'succeeded',
      metadata: { retryAttempts: 1, lastRetryFailureKind: 'timeout' },
    });
    const coordinatorRun = await runStore.getRun('coordinator-run-retry');
    expect(coordinatorRun?.metadata?.swarmExecution).toMatchObject({
      schemaVersion: 1,
      sessionId: 'session-swarm-retry',
      coordinatorRunId: 'coordinator-run-retry',
    });
    expect(coordinatorRun?.result).toMatchObject({ output: { answer: 'Recovered answer.' } });
  });

  it('resumes finalizers when workers completed before the coordinator result was finalized', async () => {
    const runStore = new InMemoryRunStore();
    const qualityModel = new SequenceModel('quality', [{
      finishReason: 'stop',
      structuredOutput: {
        assessments: [{
          subtaskId: 'subtask-1',
          runId: 'worker-run-pending-finalizers',
          usable: true,
          score: 1,
          issues: [],
          recommendation: 'use',
        }],
      },
    }]);
    const synthesizerModel = new SequenceModel('synthesizer', [
      { finishReason: 'stop', structuredOutput: { answer: 'Recovered after worker completion.' } },
    ]);
    const swarm = new SwarmCoordinator({
      runStore,
      coordinatorAgent: createAgent(new SequenceModel('coordinator', []), runStore),
      coordinatorAgentId: 'coordinator',
      workerAgents: { researcher: createAgent(new SequenceModel('researcher', []), runStore) },
      qualityAgent: createAgent(qualityModel, runStore),
      qualityAgentId: 'quality',
      synthesizerAgent: createAgent(synthesizerModel, runStore),
      synthesizerAgentId: 'synthesizer',
    });
    let coordinator = await runStore.createRun({
      id: 'coordinator-pending-finalizers',
      sessionId: 'session-pending-finalizers',
      goal: 'Decompose the objective.',
      status: 'succeeded',
      metadata: {
        orchestration: { kind: 'swarm', coordinatorRunId: 'coordinator-pending-finalizers', role: 'coordinator' },
        swarmExecution: {
          schemaVersion: 1,
          sessionId: 'session-pending-finalizers',
          coordinatorRunId: 'coordinator-pending-finalizers',
          topLevelObjective: 'Finish this swarm.',
          maxWorkers: 1,
          subtasks: [{ id: 'subtask-1', subObjective: 'Research.', targetAgentId: 'researcher' }],
          agents: { workerAgentIds: { 'subtask-1': 'researcher' } },
        },
      },
    });
    coordinator = await runStore.updateRun(coordinator.id, {
      result: { subtasks: [{ id: 'subtask-1', subObjective: 'Research.', targetAgentId: 'researcher' }] },
    }, coordinator.version);
    let worker = await runStore.createRun({
      id: 'worker-run-pending-finalizers',
      sessionId: 'session-pending-finalizers',
      goal: 'Research.',
      status: 'succeeded',
      metadata: {
        orchestration: {
          kind: 'swarm',
          coordinatorRunId: coordinator.id,
          role: 'worker',
          subtaskId: 'subtask-1',
          agentId: 'researcher',
        },
      },
    });
    worker = await runStore.updateRun(worker.id, { result: { finding: 'worker completed' } }, worker.version);

    const retried = await swarm.retrySession({ sessionId: 'session-pending-finalizers' });

    expect(retried).toMatchObject({
      coordinatorRunId: coordinator.id,
      retriedWorkerRunIds: [],
      status: 'succeeded',
      output: { answer: 'Recovered after worker completion.' },
      subtaskResults: [{ subtaskId: 'subtask-1', runId: worker.id, status: 'succeeded' }],
    });
    await expect(runStore.getRun(coordinator.id)).resolves.toMatchObject({
      result: { status: 'succeeded', output: { answer: 'Recovered after worker completion.' } },
    });
  });

  it('rejects unknown targetAgentId before launching workers quality or synthesis', async () => {
    const runStore = new InMemoryRunStore();
    const qualityModel = new SequenceModel('quality', []);
    const synthesizerModel = new SequenceModel('synthesizer', []);
    const swarm = new SwarmCoordinator({
      runStore,
      coordinatorAgent: createAgent(new SequenceModel('coordinator', [
        {
          finishReason: 'stop',
          structuredOutput: {
            subtasks: [{ id: 'subtask-1', subObjective: 'Use missing specialist.', input: null, attachmentRefs: [], targetAgentId: 'missing' }],
          },
        },
      ]), runStore),
      workerAgents: {},
      qualityAgent: createAgent(qualityModel, runStore),
      synthesizerAgent: createAgent(synthesizerModel, runStore),
    });

    const result = await swarm.run({ sessionId: 'session-swarm-failure', topLevelObjective: 'Needs a specialist' });

    expect(result).toMatchObject({
      status: 'failed',
      errorCode: 'INVALID_DECOMPOSITION',
      subtaskResults: [],
    });
    expect(result.errorMessage).toContain('unknown worker agent "missing"');
    expect(qualityModel.receivedRequests).toHaveLength(0);
    expect(synthesizerModel.receivedRequests).toHaveLength(0);
    expect(await runStore.listBySession('session-swarm-failure')).toHaveLength(1);
  });

  it('rejects extra model-generated subtask fields before launching workers quality or synthesis', async () => {
    const runStore = new InMemoryRunStore();
    const workerModel = new SequenceModel('researcher', []);
    const qualityModel = new SequenceModel('quality', []);
    const synthesizerModel = new SequenceModel('synthesizer', []);
    const swarm = new SwarmCoordinator({
      runStore,
      coordinatorAgent: createAgent(new SequenceModel('coordinator', [
        {
          finishReason: 'stop',
          structuredOutput: {
            subtasks: [
              {
                id: 'subtask-1',
                subObjective: 'Research the market.',
                input: null,
                attachmentRefs: [],
                targetAgentId: 'researcher',
                metadata: { priority: 'high' },
              },
            ],
          },
        },
      ]), runStore),
      workerAgents: { researcher: createAgent(workerModel, runStore) },
      qualityAgent: createAgent(qualityModel, runStore),
      synthesizerAgent: createAgent(synthesizerModel, runStore),
    });

    const result = await swarm.run({ sessionId: 'session-swarm-extra-fields', topLevelObjective: 'Needs strict subtasks' });

    expect(result).toMatchObject({
      status: 'failed',
      errorCode: 'INVALID_DECOMPOSITION',
      subtaskResults: [],
    });
    expect(result.errorMessage).toContain('unsupported keys: metadata');
    expect(workerModel.receivedRequests).toHaveLength(0);
    expect(qualityModel.receivedRequests).toHaveLength(0);
    expect(synthesizerModel.receivedRequests).toHaveLength(0);
  });

  it('validates all decomposed subtasks before launching any worker', async () => {
    const runStore = new InMemoryRunStore();
    const workerModel = new SequenceModel('researcher', [{ finishReason: 'stop', text: 'should not run' }]);
    const swarm = new SwarmCoordinator({
      runStore,
      coordinatorAgent: createAgent(new SequenceModel('coordinator', []), runStore),
      workerAgents: { researcher: createAgent(workerModel, runStore) },
      qualityAgent: createAgent(new SequenceModel('quality', []), runStore),
      synthesizerAgent: createAgent(new SequenceModel('synthesizer', []), runStore),
    });

    const result = await swarm.execute({
      sessionId: 'session-validation',
      topLevelObjective: 'Validate first',
      subtasks: [
        { id: 'same', subObjective: 'Valid work.', targetAgentId: 'researcher' },
        { id: 'same', subObjective: '', targetAgentId: 'researcher' },
      ],
    });

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('INVALID_DECOMPOSITION');
    expect(result.errorMessage).toContain('duplicated');
    expect(result.errorMessage).toContain('missing subObjective');
    expect(workerModel.receivedRequests).toHaveLength(0);
  });
});
