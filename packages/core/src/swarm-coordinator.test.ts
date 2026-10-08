import { describe, expect, it } from 'vitest';

import { AdaptiveAgent } from './adaptive-agent.js';
import { InMemoryContinuationStore } from './in-memory-continuation-store.js';
import { InMemoryEventStore } from './in-memory-event-store.js';
import { InMemoryRunStore } from './in-memory-run-store.js';
import { InMemorySnapshotStore } from './in-memory-snapshot-store.js';
import { SwarmCoordinator } from './swarm-coordinator.js';
import type { AgentRun, ModelAdapter, ModelRequest, ModelResponse, ToolDefinition } from './types.js';

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
      executionContext: {
        inferenceMode: 'gateway',
        inferenceTier: 'high',
        authorizationRef: 'permit-swarm',
      },
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
    expect(sessionRuns.every((run) =>
      JSON.stringify(run.executionContext) === JSON.stringify({
        inferenceMode: 'gateway',
        inferenceTier: 'high',
        authorizationRef: 'permit-swarm',
      })
    )).toBe(true);
    expect([
      coordinatorModel,
      researcherModel,
      writerModel,
      qualityModel,
      synthesizerModel,
    ].every((model) => model.receivedRequests.every((request) =>
      request.executionContext?.authorizationRef === 'permit-swarm'
    ))).toBe(true);
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

interface SharedStores {
  runStore: InMemoryRunStore;
  eventStore: InMemoryEventStore;
  snapshotStore: InMemorySnapshotStore;
  continuationStore: InMemoryContinuationStore;
}

function createSharedStores(): SharedStores {
  return {
    runStore: new InMemoryRunStore(),
    eventStore: new InMemoryEventStore(),
    snapshotStore: new InMemorySnapshotStore(),
    continuationStore: new InMemoryContinuationStore(),
  };
}

function createSharedAgent(model: ModelAdapter, stores: SharedStores, tools: ToolDefinition[] = []): AdaptiveAgent {
  return new AdaptiveAgent({
    model,
    tools,
    runStore: stores.runStore,
    eventStore: stores.eventStore,
    snapshotStore: stores.snapshotStore,
    continuationStore: stores.continuationStore,
    recovery: { continuation: { enabled: true, defaultStrategy: 'hybrid_snapshot_then_step' } },
  });
}

interface RecoverySwarmModels {
  coordinator?: ModelAdapter;
  researcher: ModelAdapter;
  writer?: ModelAdapter;
  quality: ModelAdapter;
  synthesizer: ModelAdapter;
  researcherTools?: ToolDefinition[];
}

function createRecoverySwarm(stores: SharedStores, models: RecoverySwarmModels) {
  const researcherAgent = createSharedAgent(models.researcher, stores, models.researcherTools ?? []);
  const coordinatorAgent = createSharedAgent(models.coordinator ?? new SequenceModel('coordinator', []), stores);
  const swarm = new SwarmCoordinator({
    runStore: stores.runStore,
    coordinatorAgent,
    coordinatorAgentId: 'coordinator',
    workerAgents: {
      researcher: researcherAgent,
      writer: createSharedAgent(models.writer ?? new SequenceModel('writer', []), stores),
    },
    qualityAgent: createSharedAgent(models.quality, stores),
    qualityAgentId: 'quality',
    synthesizerAgent: createSharedAgent(models.synthesizer, stores),
    synthesizerAgentId: 'synthesizer',
  });
  return { swarm, researcherAgent, coordinatorAgent };
}

function qualityResponse(subtaskIds: string[]): ModelResponse {
  return {
    finishReason: 'stop',
    structuredOutput: {
      assessments: subtaskIds.map((subtaskId) => ({ subtaskId, runId: null, usable: true, score: 1, issues: [], recommendation: 'use' })),
    },
  };
}

function answer(text: string): ModelResponse {
  return { finishReason: 'stop', structuredOutput: { answer: text } };
}

const TWO_SUBTASKS = [
  { id: 'subtask-1', subObjective: 'Research the market.', targetAgentId: 'researcher' },
  { id: 'subtask-2', subObjective: 'Draft the recommendation.', targetAgentId: 'writer' },
];

async function createPendingCoordinator(stores: SharedStores, id: string, sessionId: string): Promise<void> {
  await stores.runStore.createRun({
    id,
    sessionId,
    goal: 'Create a market entry recommendation.',
    metadata: { orchestration: { kind: 'swarm', coordinatorRunId: 'pending', role: 'coordinator' } },
    status: 'running',
  });
}

async function sessionSnapshot(stores: SharedStores, sessionId: string): Promise<string> {
  const runs = await stores.runStore.listBySession(sessionId, { order: 'asc' });
  return JSON.stringify(runs);
}

function orchestrationOf(run: AgentRun | null | undefined): Record<string, unknown> {
  const value = run?.metadata?.orchestration;
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

class BlockingModel implements ModelAdapter {
  readonly provider = 'test';
  readonly model = 'blocking';
  readonly capabilities = { toolCalling: true, jsonOutput: true, streaming: false, usage: false };
  private notifyStarted!: () => void;
  readonly started = new Promise<void>((resolve) => { this.notifyStarted = resolve; });

  async generate(): Promise<ModelResponse> {
    this.notifyStarted();
    return new Promise<ModelResponse>(() => {});
  }
}

describe('SwarmCoordinator.recoverSession', () => {
  it.each(['awaiting_approval', 'APPROVAL_REJECTED'] as const)('does not regenerate a protected finalizer (%s) when worker output would change', async (state) => {
    const stores = createSharedStores();
    const researcher = new SequenceModel('researcher', [new Error('Model timed out'), answer('unexpected retry')]);
    const quality = new SequenceModel('quality', [qualityResponse(['subtask-1', 'subtask-2'])]);
    const { swarm } = createRecoverySwarm(stores, {
      researcher, writer: new SequenceModel('writer', [answer('draft')]), quality,
      synthesizer: new SequenceModel('synthesizer', [answer('partial')]),
    });
    await createPendingCoordinator(stores, 'protected-coordinator', 'protected-finalizer');
    const initial = await swarm.execute({ sessionId: 'protected-finalizer', coordinatorRunId: 'protected-coordinator', topLevelObjective: 'research', subtasks: TWO_SUBTASKS });
    const finalizer = (await stores.runStore.getRun(initial.qualityRunId!))!;
    await stores.runStore.updateRun(finalizer.id, state === 'awaiting_approval'
      ? { status: 'awaiting_approval' }
      : { status: 'failed', errorCode: 'APPROVAL_REJECTED', errorMessage: 'approval rejected' }, finalizer.version);
    expect(await swarm.recoverSession({ sessionId: 'protected-finalizer', requireApproval: true })).toMatchObject({ outcome: 'blocked', actions: [] });
    expect(researcher.receivedRequests).toHaveLength(1);
    expect(quality.receivedRequests).toHaveLength(1);
    expect((await stores.runStore.listBySession!('protected-finalizer')).filter((run) => orchestrationOf(run)?.role === 'quality')).toHaveLength(1);
  });

  it('recovers a failed worker in place, preserves completed workers, regenerates finalizers, and no-ops when repeated', async () => {
    const stores = createSharedStores();
    const researcherModel = new SequenceModel('researcher', [
      new Error('Model timed out after 90000ms'),
      { finishReason: 'stop', structuredOutput: { finding: 'market recovered' } },
    ]);
    const writerModel = new SequenceModel('writer', [{ finishReason: 'stop', structuredOutput: { draft: 'initial draft' } }]);
    const qualityModel = new SequenceModel('quality', [qualityResponse(['subtask-1', 'subtask-2']), qualityResponse(['subtask-1', 'subtask-2'])]);
    const synthesizerModel = new SequenceModel('synthesizer', [answer('Initial answer with a gap.'), answer('Recovered answer.')]);
    const { swarm } = createRecoverySwarm(stores, { researcher: researcherModel, writer: writerModel, quality: qualityModel, synthesizer: synthesizerModel });
    await createPendingCoordinator(stores, 'coordinator-recover', 'session-recover');

    const initial = await swarm.execute({
      sessionId: 'session-recover',
      coordinatorRunId: 'coordinator-recover',
      topLevelObjective: 'Create a market entry recommendation.',
      subtasks: TWO_SUBTASKS,
    });
    const failedWorkerRunId = initial.subtaskResults[0]!.runId;
    const writerRunId = initial.subtaskResults[1]!.runId;
    expect(initial.subtaskResults.map((result) => result.status)).toEqual(['failed', 'succeeded']);
    const writerBefore = await stores.runStore.getRun(writerRunId);

    const recovered = await swarm.recoverSession({ sessionId: 'session-recover' });

    expect(recovered).toMatchObject({
      sessionId: 'session-recover',
      coordinatorRunId: 'coordinator-recover',
      outcome: 'completed',
      plans: [{ runId: failedWorkerRunId, action: 'retry_same_run', executable: true }],
      actions: [{ runId: failedWorkerRunId, action: 'retry_same_run', result: { status: 'success', runId: failedWorkerRunId } }],
      result: {
        status: 'succeeded',
        output: { answer: 'Recovered answer.' },
        subtaskResults: [
          { subtaskId: 'subtask-1', runId: failedWorkerRunId, status: 'succeeded', output: { finding: 'market recovered' } },
          { subtaskId: 'subtask-2', runId: writerRunId, status: 'succeeded', output: { draft: 'initial draft' } },
        ],
      },
    });
    // Completed worker preserved: not re-run, not mutated.
    expect(writerModel.receivedRequests).toHaveLength(1);
    expect(await stores.runStore.getRun(writerRunId)).toEqual(writerBefore);
    // Finalizers regenerated because worker outputs changed, linked to their predecessors.
    expect(recovered.startedRunIds).toEqual([recovered.result!.qualityRunId, recovered.result!.synthesizerRunId]);
    expect(recovered.result!.qualityRunId).not.toBe(initial.qualityRunId);
    expect(orchestrationOf(await stores.runStore.getRun(recovered.result!.qualityRunId!))).toMatchObject({
      role: 'quality', attempt: 2, supersedesRunId: initial.qualityRunId,
    });
    expect(orchestrationOf(await stores.runStore.getRun(recovered.result!.synthesizerRunId!))).toMatchObject({
      role: 'synthesizer', attempt: 2, supersedesRunId: initial.synthesizerRunId,
    });
    const coordinator = await stores.runStore.getRun('coordinator-recover');
    expect(coordinator).toMatchObject({ status: 'succeeded', result: recovered.result, leaseOwner: undefined });

    const repeated = await swarm.recoverSession({ sessionId: 'session-recover' });
    expect(repeated).toEqual({
      sessionId: 'session-recover',
      coordinatorRunId: 'coordinator-recover',
      outcome: 'completed',
      plans: [],
      actions: [],
      reason: 'Swarm session is already completed',
      result: coordinator!.result,
    });
    expect(researcherModel.receivedRequests).toHaveLength(2);
    expect(qualityModel.receivedRequests).toHaveLength(2);
    expect(synthesizerModel.receivedRequests).toHaveLength(2);
  });

  it('follows continuation lineage and recovers the continuation head instead of the historical failed attempt', async () => {
    const stores = createSharedStores();
    const lookupTool: ToolDefinition = {
      name: 'lookup',
      description: 'Looks up a topic.',
      inputSchema: { type: 'object', additionalProperties: true },
      execute: async () => ({ finding: 'partial research' }),
    };
    const researcherModel = new SequenceModel('researcher', [
      { finishReason: 'tool_calls', toolCalls: [{ id: 'lookup-1', name: 'lookup', input: { topic: 'market' } }] },
      new Error('HTTP 524 provider timeout'),
      new Error('Model timed out after 90000ms'),
      { finishReason: 'stop', text: 'continued research' },
    ]);
    const { swarm, researcherAgent } = createRecoverySwarm(stores, {
      researcher: researcherModel,
      researcherTools: [lookupTool],
      writer: new SequenceModel('writer', [{ finishReason: 'stop', text: 'draft' }]),
      quality: new SequenceModel('quality', [qualityResponse(['subtask-1', 'subtask-2']), qualityResponse(['subtask-1', 'subtask-2'])]),
      synthesizer: new SequenceModel('synthesizer', [answer('Partial.'), answer('Complete.')]),
    });
    await createPendingCoordinator(stores, 'coordinator-continuation', 'session-continuation');
    const initial = await swarm.execute({
      sessionId: 'session-continuation',
      coordinatorRunId: 'coordinator-continuation',
      topLevelObjective: 'Create a market entry recommendation.',
      subtasks: TWO_SUBTASKS,
    });
    const sourceRunId = initial.subtaskResults[0]!.runId;
    expect(initial.subtaskResults[0]).toMatchObject({ status: 'failed' });

    const continued = await researcherAgent.continueRun({ fromRunId: sourceRunId });
    expect(continued.status).toBe('failure');
    const continuationRunId = continued.runId;
    const sourceBefore = await stores.runStore.getRun(sourceRunId);

    const recovered = await swarm.recoverSession({ sessionId: 'session-continuation' });

    expect(recovered.outcome).toBe('completed');
    expect(recovered.plans.map((plan) => plan.runId)).toEqual([continuationRunId]);
    expect(recovered.actions).toMatchObject([{ runId: continuationRunId, action: 'retry_same_run' }]);
    expect(recovered.result).toMatchObject({
      status: 'succeeded',
      output: { answer: 'Complete.' },
      subtaskResults: [
        { subtaskId: 'subtask-1', runId: continuationRunId, status: 'succeeded', output: 'continued research' },
        { subtaskId: 'subtask-2', status: 'succeeded' },
      ],
    });
    // Historical failed attempt is not replayed.
    expect(await stores.runStore.getRun(sourceRunId)).toEqual(sourceBefore);
    expect(researcherModel.receivedRequests).toHaveLength(4);
  });

  it('reports busy for live leases and resumes a stale interrupted worker after the owner disappears', async () => {
    const stores = createSharedStores();
    const blockingModel = new BlockingModel();
    const crashed = createRecoverySwarm(stores, {
      researcher: blockingModel,
      quality: new SequenceModel('quality', []),
      synthesizer: new SequenceModel('synthesizer', []),
    });
    await createPendingCoordinator(stores, 'coordinator-stale', 'session-stale');
    void crashed.swarm.execute({
      sessionId: 'session-stale',
      coordinatorRunId: 'coordinator-stale',
      topLevelObjective: 'Research.',
      subtasks: [TWO_SUBTASKS[0]!],
    });
    await blockingModel.started;
    const workerRun = (await stores.runStore.listBySession('session-stale')).find((run) => orchestrationOf(run).role === 'worker')!;
    expect(workerRun).toMatchObject({ status: 'running', leaseOwner: expect.any(String) });

    const recoveringResearcher = new SequenceModel('researcher', [{ finishReason: 'stop', text: 'resumed research' }]);
    const recoveringQuality = new SequenceModel('quality', [qualityResponse(['subtask-1'])]);
    const recovering = createRecoverySwarm(stores, {
      researcher: recoveringResearcher,
      quality: recoveringQuality,
      synthesizer: new SequenceModel('synthesizer', [answer('Resumed answer.')]),
    });
    const before = await sessionSnapshot(stores, 'session-stale');

    const busy = await recovering.swarm.recoverSession({ sessionId: 'session-stale' });
    const busyDryRun = await recovering.swarm.recoverSession({ sessionId: 'session-stale', dryRun: true });
    expect(busy).toMatchObject({ outcome: 'busy', plans: [], actions: [] });
    expect(busy.reason).toContain(workerRun.id);
    expect(busyDryRun).toMatchObject({ outcome: 'busy', plans: [], actions: [] });
    expect(recoveringResearcher.receivedRequests).toHaveLength(0);
    const afterBusy = JSON.parse(await sessionSnapshot(stores, 'session-stale')) as AgentRun[];
    expect(afterBusy.find((run) => run.id === workerRun.id)).toEqual((JSON.parse(before) as AgentRun[]).find((run) => run.id === workerRun.id));

    // Simulate the owning process dying: the run is interrupted and its lease is gone.
    const current = (await stores.runStore.getRun(workerRun.id))!;
    await stores.runStore.updateRun(workerRun.id, {
      status: 'interrupted',
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      heartbeatAt: undefined,
    }, current.version);

    const recovered = await recovering.swarm.recoverSession({ sessionId: 'session-stale' });

    expect(recovered).toMatchObject({
      outcome: 'completed',
      plans: [{ runId: workerRun.id, status: 'interrupted', action: 'resume_same_run', executable: true }],
      actions: [{ runId: workerRun.id, action: 'resume_same_run', result: { status: 'success' } }],
      result: {
        status: 'succeeded',
        output: { answer: 'Resumed answer.' },
        subtaskResults: [{ subtaskId: 'subtask-1', runId: workerRun.id, status: 'succeeded', output: 'resumed research' }],
      },
    });
    expect(recoveringQuality.receivedRequests).toHaveLength(1);
  });

  it('blocks on pending approvals and cancelled workers without approving or mutating anything', async () => {
    const stores = createSharedStores();
    let published = 0;
    const publishTool: ToolDefinition = {
      name: 'publish',
      description: 'Publishes research.',
      inputSchema: { type: 'object', additionalProperties: true },
      requiresApproval: true,
      execute: async () => {
        published += 1;
        return { published: true };
      },
    };
    const researcherModel = new SequenceModel('researcher', [
      { finishReason: 'tool_calls', toolCalls: [{ id: 'publish-1', name: 'publish', input: {} }] },
    ]);
    const { swarm } = createRecoverySwarm(stores, {
      researcher: researcherModel,
      researcherTools: [publishTool],
      writer: new SequenceModel('writer', [{ finishReason: 'stop', text: 'draft' }]),
      quality: new SequenceModel('quality', [qualityResponse(['subtask-1', 'subtask-2'])]),
      synthesizer: new SequenceModel('synthesizer', [answer('Waiting on approval.')]),
    });
    await createPendingCoordinator(stores, 'coordinator-blocked', 'session-blocked');
    const initial = await swarm.execute({
      sessionId: 'session-blocked',
      coordinatorRunId: 'coordinator-blocked',
      topLevelObjective: 'Create a market entry recommendation.',
      subtasks: TWO_SUBTASKS,
    });
    const approvalRunId = initial.subtaskResults[0]!.runId;
    expect(initial.subtaskResults[0]).toMatchObject({ status: 'awaiting_approval' });
    const before = await sessionSnapshot(stores, 'session-blocked');

    const blocked = await swarm.recoverSession({ sessionId: 'session-blocked', requireApproval: true });

    expect(blocked).toMatchObject({
      outcome: 'blocked',
      plans: [{ runId: approvalRunId, action: 'requires_user_action', executable: false }],
      actions: [],
    });
    expect(blocked.reason).toContain(approvalRunId);
    expect(published).toBe(0);
    expect(researcherModel.receivedRequests).toHaveLength(1);
    const afterBlocked = JSON.parse(await sessionSnapshot(stores, 'session-blocked')) as AgentRun[];
    const beforeRuns = JSON.parse(before) as AgentRun[];
    // Only the coordinator lease bookkeeping may differ; every worker/finalizer run is untouched.
    expect(afterBlocked.filter((run) => run.id !== 'coordinator-blocked')).toEqual(beforeRuns.filter((run) => run.id !== 'coordinator-blocked'));
    const coordinatorAfter = afterBlocked.find((run) => run.id === 'coordinator-blocked')!;
    expect(coordinatorAfter).toMatchObject({
      status: beforeRuns.find((run) => run.id === 'coordinator-blocked')!.status,
      result: beforeRuns.find((run) => run.id === 'coordinator-blocked')!.result,
    });
    expect(coordinatorAfter.leaseOwner).toBeUndefined();

    const awaiting = (await stores.runStore.getRun(approvalRunId))!;
    await stores.runStore.updateRun(approvalRunId, { status: 'cancelled' }, awaiting.version);
    const cancelled = await swarm.recoverSession({ sessionId: 'session-blocked' });
    expect(cancelled).toMatchObject({ outcome: 'blocked', actions: [] });
    expect(cancelled.reason).toContain('cancelled');
    expect(published).toBe(0);
  });

  it('recovers a failed decomposition before a descriptor exists, with dry-run leaving the session untouched', async () => {
    const stores = createSharedStores();
    const coordinatorModel = new SequenceModel('coordinator', [
      new Error('Model timed out after 90000ms'),
      {
        finishReason: 'stop',
        structuredOutput: {
          subtasks: [{ id: 'subtask-1', subObjective: 'Research the market.', input: null, attachmentRefs: [], targetAgentId: 'researcher' }],
        },
      },
    ]);
    const { swarm } = createRecoverySwarm(stores, {
      coordinator: coordinatorModel,
      researcher: new SequenceModel('researcher', [{ finishReason: 'stop', text: 'research' }]),
      quality: new SequenceModel('quality', [qualityResponse(['subtask-1'])]),
      synthesizer: new SequenceModel('synthesizer', [answer('Recovered from decomposition.')]),
    });

    const failed = await swarm.run({ sessionId: 'session-decomposition', topLevelObjective: 'Create a market entry recommendation.' });
    expect(failed).toMatchObject({ status: 'failed', errorCode: 'MODEL_ERROR' });
    const coordinatorRunId = failed.coordinatorRunId;
    expect((await stores.runStore.getRun(coordinatorRunId))?.metadata?.swarmExecution).toBeUndefined();
    const before = await sessionSnapshot(stores, 'session-decomposition');

    const planned = await swarm.recoverSession({ sessionId: 'session-decomposition', dryRun: true });

    expect(planned).toMatchObject({
      coordinatorRunId,
      outcome: 'planned',
      plans: [{ runId: coordinatorRunId, action: 'retry_same_run', executable: true }],
      actions: [],
    });
    expect(await sessionSnapshot(stores, 'session-decomposition')).toBe(before);
    expect(coordinatorModel.receivedRequests).toHaveLength(1);

    // Succeeds only if the swarm lease is released while the coordinator agent recovers its own run.
    const recovered = await swarm.recoverSession({ sessionId: 'session-decomposition' });

    expect(recovered).toMatchObject({
      coordinatorRunId,
      outcome: 'completed',
      actions: [{ runId: coordinatorRunId, action: 'retry_same_run', result: { status: 'success' } }],
      result: {
        status: 'succeeded',
        output: { answer: 'Recovered from decomposition.' },
        subtaskResults: [{ subtaskId: 'subtask-1', status: 'succeeded', output: 'research' }],
      },
    });
    const coordinator = await stores.runStore.getRun(coordinatorRunId);
    expect(coordinator?.metadata?.swarmExecution).toMatchObject({ coordinatorRunId, subtasks: [{ id: 'subtask-1' }] });
    expect(coordinator?.leaseOwner).toBeUndefined();
    await expect(swarm.recoverSession({ sessionId: 'session-decomposition' })).resolves.toMatchObject({ outcome: 'completed', actions: [] });
  });

  it('starts missing worker runs from the persisted descriptor', async () => {
    const stores = createSharedStores();
    const writerModel = new SequenceModel('writer', [{ finishReason: 'stop', text: 'fresh draft' }]);
    const { swarm } = createRecoverySwarm(stores, {
      researcher: new SequenceModel('researcher', []),
      writer: writerModel,
      quality: new SequenceModel('quality', [qualityResponse(['subtask-1', 'subtask-2'])]),
      synthesizer: new SequenceModel('synthesizer', [answer('Finished with descriptor.')]),
    });
    await stores.runStore.createRun({
      id: 'coordinator-missing',
      sessionId: 'session-missing',
      goal: 'Create a market entry recommendation.',
      status: 'running',
      metadata: {
        orchestration: { kind: 'swarm', coordinatorRunId: 'coordinator-missing', role: 'coordinator' },
        swarmExecution: {
          schemaVersion: 1,
          sessionId: 'session-missing',
          coordinatorRunId: 'coordinator-missing',
          topLevelObjective: 'Create a market entry recommendation.',
          maxWorkers: 2,
          subtasks: TWO_SUBTASKS,
          agents: { workerAgentIds: { 'subtask-1': 'researcher', 'subtask-2': 'writer' } },
        },
      },
    });
    let worker = await stores.runStore.createRun({
      id: 'worker-existing',
      sessionId: 'session-missing',
      goal: 'Research the market.',
      status: 'succeeded',
      metadata: { orchestration: { kind: 'swarm', coordinatorRunId: 'coordinator-missing', role: 'worker', subtaskId: 'subtask-1', agentId: 'researcher' } },
    });
    worker = await stores.runStore.updateRun(worker.id, { result: 'existing research' }, worker.version);

    const planned = await swarm.recoverSession({ sessionId: 'session-missing', dryRun: true });
    expect(planned).toMatchObject({ outcome: 'planned', missingWorkerSubtaskIds: ['subtask-2'], actions: [] });
    expect(writerModel.receivedRequests).toHaveLength(0);

    const recovered = await swarm.recoverSession({ sessionId: 'session-missing' });
    expect(recovered).toMatchObject({
      outcome: 'completed',
      missingWorkerSubtaskIds: ['subtask-2'],
      result: {
        status: 'succeeded',
        output: { answer: 'Finished with descriptor.' },
        subtaskResults: [
          { subtaskId: 'subtask-1', runId: 'worker-existing', status: 'succeeded', output: 'existing research' },
          { subtaskId: 'subtask-2', status: 'succeeded', output: 'fresh draft' },
        ],
      },
    });
    expect(recovered.startedRunIds).toContain(recovered.result!.subtaskResults[1]!.runId);
  });

  it('recovers a failed synthesizer in place and reuses quality when worker inputs did not change', async () => {
    const stores = createSharedStores();
    const qualityModel = new SequenceModel('quality', [qualityResponse(['subtask-1'])]);
    const synthesizerModel = new SequenceModel('synthesizer', [new Error('Model timed out after 90000ms'), answer('Synthesized after retry.')]);
    const { swarm } = createRecoverySwarm(stores, {
      researcher: new SequenceModel('researcher', [{ finishReason: 'stop', text: 'research' }]),
      quality: qualityModel,
      synthesizer: synthesizerModel,
    });
    await createPendingCoordinator(stores, 'coordinator-synth', 'session-synth');
    const initial = await swarm.execute({
      sessionId: 'session-synth',
      coordinatorRunId: 'coordinator-synth',
      topLevelObjective: 'Research.',
      subtasks: [TWO_SUBTASKS[0]!],
    });
    expect(initial).toMatchObject({ status: 'failed', errorCode: 'MODEL_ERROR' });

    const recovered = await swarm.recoverSession({ sessionId: 'session-synth' });

    expect(recovered).toMatchObject({
      outcome: 'completed',
      plans: [{ runId: initial.synthesizerRunId, action: 'retry_same_run' }],
      actions: [{ runId: initial.synthesizerRunId, action: 'retry_same_run' }],
      result: {
        status: 'succeeded',
        qualityRunId: initial.qualityRunId,
        synthesizerRunId: initial.synthesizerRunId,
        output: { answer: 'Synthesized after retry.' },
      },
    });
    expect(recovered.startedRunIds).toBeUndefined();
    expect(qualityModel.receivedRequests).toHaveLength(1);
  });
});
