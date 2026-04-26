import { PassThrough } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { AdaptiveAgent } from './adaptive-agent.js';
import { InMemoryEventStore } from './in-memory-event-store.js';
import { InMemoryPlanStore } from './in-memory-plan-store.js';
import { InMemoryRunStore } from './in-memory-run-store.js';
import { InMemorySnapshotStore } from './in-memory-snapshot-store.js';
import { InMemoryToolExecutionStore } from './in-memory-tool-execution-store.js';
import { createReadFileTool } from './tools/read-file.js';
import type { ModelAdapter, ModelRequest, ModelResponse, RuntimeStores, ToolDefinition } from './types.js';

class SequenceModel implements ModelAdapter {
  readonly provider: string;
  readonly model = 'sequence';
  readonly capabilities = {
    toolCalling: true,
    jsonOutput: true,
    streaming: false,
    usage: false,
  };

  readonly receivedRequests: ModelRequest[] = [];

  constructor(
    private readonly responses: Array<ModelResponse | Error>,
    provider = 'test',
  ) {
    this.provider = provider;
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const { signal: _signal, ...cloneableRequest } = request;
    this.receivedRequests.push(structuredClone(cloneableRequest));
    const nextResponse = this.responses.shift();
    if (!nextResponse) {
      throw new Error('SequenceModel received an unexpected generate() call');
    }

    if (nextResponse instanceof Error) {
      throw nextResponse;
    }

    return structuredClone(nextResponse);
  }
}

function createLookupTool(): ToolDefinition {
  return {
    name: 'lookup',
    description: 'Looks up a topic.',
    inputSchema: { type: 'object', additionalProperties: true },
    execute: async (input) => {
      const topic = typeof input === 'object' && input && 'topic' in input ? input.topic : 'unknown';
      return {
        finding: `researched:${String(topic)}`,
      };
    },
  };
}

function createBudgetedSearchTool(): ToolDefinition {
  return {
    name: 'web_search',
    description: 'Search the web.',
    inputSchema: { type: 'object', additionalProperties: true },
    budgetGroup: 'web_research.search',
    execute: async (input) => ({
      query: typeof input === 'object' && input && 'query' in input ? input.query : 'unknown',
      results: [{ title: 'stub', url: 'https://example.com', snippet: 'stub' }],
    }),
  };
}

describe('AdaptiveAgent', () => {
  it('uses transcript messages for chat-style runs', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const model = new SequenceModel([
      {
        finishReason: 'stop',
        text: 'Paris is the capital of France.',
      },
    ]);

    const agent = new AdaptiveAgent({
      model,
      tools: [],
      runStore,
      eventStore,
      snapshotStore,
      systemInstructions: 'Reply in one sentence.',
    });

    const result = await agent.chat({
      messages: [
        { role: 'system', content: 'Call the user Sam.' },
        { role: 'assistant', content: 'Hi Sam! What would you like to know?' },
        { role: 'user', content: 'What is the capital of France?' },
      ],
      context: { locale: 'en-US' },
      metadata: { channel: 'cli' },
    });

    expect(result).toMatchObject({
      status: 'success',
      output: 'Paris is the capital of France.',
      stepsUsed: 1,
    });

    expect(model.receivedRequests[0]).toMatchObject({
      tools: [],
      metadata: { channel: 'cli' },
      messages: [
        {
          role: 'system',
          content: expect.stringContaining('Reply in one sentence.'),
        },
        {
          role: 'system',
          content: expect.stringContaining('## Available Tools and Delegates'),
        },
        {
          role: 'system',
          content: expect.stringContaining('"locale": "en-US"'),
        },
        {
          role: 'system',
          content: 'Call the user Sam.',
        },
        {
          role: 'assistant',
          content: 'Hi Sam! What would you like to know?',
        },
        {
          role: 'user',
          content: 'What is the capital of France?',
        },
      ],
    });

    const storedRun = await runStore.getRun(result.runId);
    expect(storedRun?.goal).toBe('What is the capital of France?');
  });

  it('injects a runtime tool manifest after the initial system message by default', async () => {
    const runStore = new InMemoryRunStore();
    const model = new SequenceModel([
      {
        finishReason: 'stop',
        text: 'Done.',
      },
    ]);

    const agent = new AdaptiveAgent({
      model,
      tools: [createLookupTool()],
      delegates: [
        {
          name: 'researcher',
          description: 'Researches a topic.',
          allowedTools: ['lookup'],
        },
      ],
      runStore,
    });

    const result = await agent.run({ goal: 'Inspect runtime manifest' });
    expect(result.status).toBe('success');

    const messages = model.receivedRequests[0]?.messages ?? [];
    expect(messages[0]).toMatchObject({
      role: 'system',
      content: expect.stringContaining('You are AdaptiveAgent.'),
    });
    expect(messages[1]).toMatchObject({
      role: 'system',
      content: expect.stringContaining('## Available Tools and Delegates'),
    });
    expect(messages[1]?.content).toContain('"name": "lookup"');
    expect(messages[1]?.content).toContain('"kind": "tool"');
    expect(messages[1]?.content).toContain('"name": "delegate.researcher"');
    expect(messages[1]?.content).toContain('"kind": "delegate"');
    expect(messages[2]).toMatchObject({
      role: 'user',
      content: expect.stringContaining('Inspect runtime manifest'),
    });
  });

  it('can disable the runtime tool manifest through agent defaults', async () => {
    const runStore = new InMemoryRunStore();
    const model = new SequenceModel([
      {
        finishReason: 'stop',
        text: 'Done.',
      },
    ]);

    const agent = new AdaptiveAgent({
      model,
      tools: [createLookupTool()],
      runStore,
      defaults: {
        injectToolManifest: false,
      },
    });

    const result = await agent.run({ goal: 'Skip manifest' });
    expect(result.status).toBe('success');
    expect(model.receivedRequests[0]?.messages).toHaveLength(2);
    expect(
      model.receivedRequests[0]?.messages.some((message) => message.content.includes('## Available Tools and Delegates')),
    ).toBe(false);
  });

  it('persists provider and model on newly created runs', async () => {
    const runStore = new InMemoryRunStore();
    const model = new SequenceModel([
      {
        finishReason: 'stop',
        text: 'Done.',
      },
    ], 'mesh');

    const createRunSpy = vi.spyOn(runStore, 'createRun');
    const agent = new AdaptiveAgent({
      model,
      tools: [],
      runStore,
    });

    const result = await agent.run({
      goal: 'Persist model config',
    });

    expect(result.status).toBe('success');
    expect(createRunSpy).toHaveBeenCalledWith(expect.objectContaining({
      modelProvider: 'mesh',
      modelName: 'sequence',
    }));

    const storedRun = await runStore.getRun(result.runId);
    expect(storedRun).toMatchObject({
      modelProvider: 'mesh',
      modelName: 'sequence',
    });
    expect(storedRun?.modelParameters).toBeUndefined();
  });

  it('retries a failed model timeout from the same run and step', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const model = new SequenceModel([
      new Error('Model timed out after 90000ms'),
      {
        finishReason: 'stop',
        text: 'Recovered from the same step.',
      },
    ]);

    const agent = new AdaptiveAgent({
      model,
      tools: [],
      runStore,
      eventStore,
      snapshotStore,
    });

    const failed = await agent.run({
      goal: 'Retry this run',
    });

    expect(failed).toMatchObject({
      status: 'failure',
      code: 'MODEL_ERROR',
      error: 'Model timed out after 90000ms',
      stepsUsed: 0,
    });

    const retried = await agent.retry(failed.runId);

    expect(retried).toMatchObject({
      status: 'success',
      runId: failed.runId,
      output: 'Recovered from the same step.',
      stepsUsed: 1,
    });
    expect(model.receivedRequests).toHaveLength(2);

    const storedRun = await runStore.getRun(failed.runId);
    expect(storedRun).toMatchObject({
      status: 'succeeded',
      errorCode: undefined,
      errorMessage: undefined,
      metadata: {
        retryAttempts: 1,
        lastRetryFailureKind: 'timeout',
      },
    });

    const retryEvents = (await eventStore.listByRun(failed.runId)).filter((event) => event.type === 'run.retry_started');
    expect(retryEvents).toHaveLength(1);
    expect(retryEvents[0].payload).toMatchObject({
      failureKind: 'timeout',
      retryAttempts: 1,
    });
  });

  it('retries a read_file not_found failure after the file is created', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'adaptive-agent-read-retry-'));
    try {
      const runStore = new InMemoryRunStore();
      const eventStore = new InMemoryEventStore();
      const snapshotStore = new InMemorySnapshotStore();
      const toolExecutionStore = new InMemoryToolExecutionStore();
      const model = new SequenceModel([
        {
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'read-call-1',
              name: 'read_file',
              input: { path: 'lic.txt' },
            },
          ],
        },
        {
          finishReason: 'stop',
          structuredOutput: { status: 'read after retry' },
        },
      ]);

      const agent = new AdaptiveAgent({
        model,
        tools: [createReadFileTool({ allowedRoot: tempDir })],
        runStore,
        eventStore,
        snapshotStore,
        toolExecutionStore,
      });

      const failed = await agent.run({ goal: 'Read lic.txt' });
      expect(failed).toMatchObject({
        status: 'failure',
        code: 'TOOL_ERROR',
      });

      await writeFile(join(tempDir, 'lic.txt'), 'license text', 'utf-8');

      const retried = await agent.retry(failed.runId);
      expect(retried).toMatchObject({
        status: 'success',
        runId: failed.runId,
        output: { status: 'read after retry' },
      });

      const storedRun = await runStore.getRun(failed.runId);
      expect(storedRun?.metadata).toMatchObject({
        retryAttempts: 1,
        lastRetryFailureKind: 'not_found',
      });
      expect(model.receivedRequests.at(-1)?.messages.at(-1)).toMatchObject({
        role: 'tool',
        name: 'read_file',
        toolCallId: 'read-call-1',
        content: expect.stringContaining('license text'),
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects MAX_STEPS retry until the configured step budget is raised', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const toolExecutionStore = new InMemoryToolExecutionStore();
    const model = new SequenceModel([
      {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'lookup-call-1',
            name: 'lookup',
            input: { topic: 'budget' },
          },
        ],
      },
    ]);

    const agent = new AdaptiveAgent({
      model,
      tools: [createLookupTool()],
      runStore,
      eventStore,
      snapshotStore,
      toolExecutionStore,
      defaults: { maxSteps: 1 },
    });

    const failed = await agent.run({ goal: 'Use a tool then continue' });
    expect(failed).toMatchObject({
      status: 'failure',
      code: 'MAX_STEPS',
      stepsUsed: 1,
    });

    await expect(agent.retry(failed.runId)).rejects.toThrowError(
      `increase maxSteps above ${failed.stepsUsed} before retrying`,
    );
  });

  it('recovers a MAX_STEPS failure when restarted with a higher step budget', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const toolExecutionStore = new InMemoryToolExecutionStore();
    const initialModel = new SequenceModel([
      {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'lookup-call-1',
            name: 'lookup',
            input: { topic: 'budget' },
          },
        ],
      },
    ]);

    const initialAgent = new AdaptiveAgent({
      model: initialModel,
      tools: [createLookupTool()],
      runStore,
      eventStore,
      snapshotStore,
      toolExecutionStore,
      defaults: { maxSteps: 1 },
    });

    const failed = await initialAgent.run({ goal: 'Use a tool then continue' });
    expect(failed).toMatchObject({
      status: 'failure',
      code: 'MAX_STEPS',
      stepsUsed: 1,
    });

    const restartedModel = new SequenceModel([
      {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'lookup-call-2',
            name: 'lookup',
            input: { topic: 'second-budget' },
          },
        ],
      },
    ]);
    const restartedAgent = new AdaptiveAgent({
      model: restartedModel,
      tools: [createLookupTool()],
      runStore,
      eventStore,
      snapshotStore,
      toolExecutionStore,
      defaults: { maxSteps: 2 },
    });

    const failedAgain = await restartedAgent.retry(failed.runId);
    expect(failedAgain).toMatchObject({
      status: 'failure',
      code: 'MAX_STEPS',
      runId: failed.runId,
      stepsUsed: 2,
    });

    const raisedAgainModel = new SequenceModel([
      {
        finishReason: 'stop',
        structuredOutput: { status: 'continued after budget increase' },
      },
    ]);
    const raisedAgainAgent = new AdaptiveAgent({
      model: raisedAgainModel,
      tools: [createLookupTool()],
      runStore,
      eventStore,
      snapshotStore,
      toolExecutionStore,
      defaults: { maxSteps: 3 },
    });

    const retried = await raisedAgainAgent.retry(failed.runId);

    expect(retried).toMatchObject({
      status: 'success',
      runId: failed.runId,
      output: { status: 'continued after budget increase' },
      stepsUsed: 3,
    });
    expect(raisedAgainModel.receivedRequests[0]?.messages.at(-1)).toMatchObject({
      role: 'tool',
      name: 'lookup',
      toolCallId: 'lookup-call-2',
      content: expect.stringContaining('researched:second-budget'),
    });

    const storedRun = await runStore.getRun(failed.runId);
    expect(storedRun?.metadata).toMatchObject({
      retryAttempts: 2,
      lastRetryFailureKind: 'max_steps',
    });
  });

  it('recovers a delegated child MAX_STEPS failure through parent retry when the delegate budget is raised', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const toolExecutionStore = new InMemoryToolExecutionStore();
    const initialModel = new SequenceModel([
      {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'parent-call-1',
            name: 'delegate.researcher',
            input: {
              goal: 'Research budget recovery',
              input: { topic: 'budget' },
            },
          },
        ],
      },
      {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'child-call-1',
            name: 'lookup',
            input: { topic: 'budget' },
          },
        ],
      },
    ]);

    const initialAgent = new AdaptiveAgent({
      model: initialModel,
      tools: [createLookupTool()],
      delegates: [
        {
          name: 'researcher',
          description: 'Researches a topic using the lookup tool.',
          allowedTools: ['lookup'],
          defaults: { maxSteps: 1 },
        },
      ],
      runStore,
      eventStore,
      snapshotStore,
      toolExecutionStore,
    });

    const failed = await initialAgent.run({ goal: 'Delegate then continue' });
    expect(failed).toMatchObject({
      status: 'failure',
      code: 'MAX_STEPS',
      stepsUsed: 0,
    });

    const childRuns = await runStore.listChildren(failed.runId);
    expect(childRuns).toHaveLength(1);
    expect(childRuns[0]).toMatchObject({
      status: 'failed',
      errorCode: 'MAX_STEPS',
    });

    const restartedModel = new SequenceModel([
      {
        finishReason: 'stop',
        structuredOutput: {
          finding: 'recovered child result',
        },
      },
      {
        finishReason: 'stop',
        structuredOutput: {
          report: 'parent continued after child recovery',
        },
      },
    ]);
    const restartedAgent = new AdaptiveAgent({
      model: restartedModel,
      tools: [createLookupTool()],
      delegates: [
        {
          name: 'researcher',
          description: 'Researches a topic using the lookup tool.',
          allowedTools: ['lookup'],
          defaults: { maxSteps: 2 },
        },
      ],
      runStore,
      eventStore,
      snapshotStore,
      toolExecutionStore,
    });

    const retried = await restartedAgent.retry(failed.runId);

    expect(retried).toMatchObject({
      status: 'success',
      runId: failed.runId,
      output: {
        report: 'parent continued after child recovery',
      },
      stepsUsed: 2,
    });

    const retriedChildren = await runStore.listChildren(failed.runId);
    expect(retriedChildren).toHaveLength(1);
    expect(retriedChildren[0]).toMatchObject({
      status: 'succeeded',
      result: {
        finding: 'recovered child result',
      },
    });

    const parentEvents = await eventStore.listByRun(failed.runId);
    expect(parentEvents.filter((event) => event.type === 'delegate.spawned')).toHaveLength(1);
  });

  it('retries a failed delegated child in place for retryable model timeouts', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const toolExecutionStore = new InMemoryToolExecutionStore();
    const model = new SequenceModel([
      {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'parent-call-1',
            name: 'delegate.researcher',
            input: {
              goal: 'Research after a timeout',
              input: { topic: 'retry' },
            },
          },
        ],
      },
      new Error('Model timed out after 90000ms'),
      {
        finishReason: 'stop',
        structuredOutput: {
          finding: 'recovered child timeout',
        },
      },
      {
        finishReason: 'stop',
        structuredOutput: {
          report: 'parent continued after timeout recovery',
        },
      },
    ]);
    const agent = new AdaptiveAgent({
      model,
      tools: [createLookupTool()],
      delegates: [
        {
          name: 'researcher',
          description: 'Researches a topic using the lookup tool.',
          allowedTools: ['lookup'],
        },
      ],
      runStore,
      eventStore,
      snapshotStore,
      toolExecutionStore,
    });

    const failed = await agent.run({ goal: 'Delegate then recover a timeout' });
    expect(failed).toMatchObject({
      status: 'failure',
      code: 'MODEL_ERROR',
      stepsUsed: 0,
    });

    const initialChildren = await runStore.listChildren(failed.runId);
    expect(initialChildren).toHaveLength(1);
    expect(initialChildren[0]).toMatchObject({
      status: 'failed',
      errorCode: 'MODEL_ERROR',
    });

    const retried = await agent.retry(failed.runId);

    expect(retried).toMatchObject({
      status: 'success',
      runId: failed.runId,
      output: {
        report: 'parent continued after timeout recovery',
      },
    });

    const retriedChildren = await runStore.listChildren(failed.runId);
    expect(retriedChildren).toHaveLength(1);
    expect(retriedChildren[0]).toMatchObject({
      id: initialChildren[0]?.id,
      status: 'succeeded',
      result: {
        finding: 'recovered child timeout',
      },
    });
    const parentEvents = await eventStore.listByRun(failed.runId);
    expect(parentEvents.filter((event) => event.type === 'delegate.spawned')).toHaveLength(1);
  });

  it('rejects parent retry when the linked delegated child is not retryable', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const toolExecutionStore = new InMemoryToolExecutionStore();
    const model = new SequenceModel([
      {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'parent-call-1',
            name: 'delegate.researcher',
            input: {
              goal: 'Research with a permanent tool failure',
            },
          },
        ],
      },
      {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'child-call-1',
            name: 'permanent_failure',
            input: { topic: 'retry' },
          },
        ],
      },
    ]);
    const agent = new AdaptiveAgent({
      model,
      tools: [
        {
          name: 'permanent_failure',
          description: 'Always fails without a retry policy.',
          inputSchema: { type: 'object', additionalProperties: true },
          execute: async () => {
            throw new Error('Permanent child tool failure');
          },
        },
      ],
      delegates: [
        {
          name: 'researcher',
          description: 'Researches a topic using a tool.',
          allowedTools: ['permanent_failure'],
        },
      ],
      runStore,
      eventStore,
      snapshotStore,
      toolExecutionStore,
    });

    const failed = await agent.run({ goal: 'Delegate then reject retry' });
    expect(failed).toMatchObject({
      status: 'failure',
      code: 'TOOL_ERROR',
      stepsUsed: 0,
    });
    await expect(agent.retry(failed.runId)).rejects.toThrow('not marked retryable');

    const childRuns = await runStore.listChildren(failed.runId);
    expect(childRuns).toHaveLength(1);
    expect(childRuns[0]).toMatchObject({
      status: 'failed',
      errorCode: 'TOOL_ERROR',
    });
  });

  it('uses a transaction store for initial run creation and snapshot persistence', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const runInTransaction = vi.fn(async (operation: (stores: RuntimeStores) => Promise<unknown>) =>
      operation({
        runStore,
        eventStore,
        snapshotStore,
      }),
    );
    const agent = new AdaptiveAgent({
      model: new SequenceModel([
        {
          finishReason: 'stop',
          text: 'done',
        },
      ]),
      tools: [],
      runStore,
      eventStore,
      snapshotStore,
      transactionStore: {
        runStore,
        eventStore,
        snapshotStore,
        runInTransaction,
      },
    });

    const result = await agent.run({ goal: 'Persist the initial state transactionally' });

    expect(result.status).toBe('success');
    expect(runInTransaction).toHaveBeenCalledTimes(2);
    const events = await eventStore.listByRun(result.runId);
    expect(events[0]?.type).toBe('run.created');
    expect(events[1]?.type).toBe('snapshot.created');
    const latestSnapshot = await snapshotStore.getLatest(result.runId);
    expect(latestSnapshot?.state).toMatchObject({
      schemaVersion: 1,
      stepsUsed: 1,
    });
  });

  it('uses a transaction store for terminal failure persistence', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const runInTransaction = vi.fn(async (operation: (stores: RuntimeStores) => Promise<unknown>) =>
      operation({
        runStore,
        eventStore,
        snapshotStore,
      }),
    );
    const agent = new AdaptiveAgent({
      model: new SequenceModel([]),
      tools: [],
      runStore,
      eventStore,
      snapshotStore,
      transactionStore: {
        runStore,
        eventStore,
        snapshotStore,
        runInTransaction,
      },
    });

    const result = await agent.run({ goal: 'Fail transactionally' });

    expect(result.status).toBe('failure');
    expect(runInTransaction).toHaveBeenCalledTimes(2);
    const events = await eventStore.listByRun(result.runId);
    expect(events.at(-2)?.type).toBe('snapshot.created');
    expect(events.at(-1)?.type).toBe('run.failed');
    const storedRun = await runStore.getRun(result.runId);
    expect(storedRun?.status).toBe('failed');
    expect(storedRun?.errorCode).toBe('MODEL_ERROR');
  });

  it('uses a transaction store for model tool-call queue snapshots', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const runInTransaction = vi.fn(async (operation: (stores: RuntimeStores) => Promise<unknown>) =>
      operation({
        runStore,
        eventStore,
        snapshotStore,
      }),
    );
    const agent = new AdaptiveAgent({
      model: new SequenceModel([
        {
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'lookup-call-1',
              name: 'lookup',
              input: { topic: 'transactions' },
            },
          ],
        },
        {
          finishReason: 'stop',
          structuredOutput: { report: 'queued and resumed' },
        },
      ]),
      tools: [createLookupTool()],
      runStore,
      eventStore,
      snapshotStore,
      transactionStore: {
        runStore,
        eventStore,
        snapshotStore,
        runInTransaction,
      },
    });

    const result = await agent.run({ goal: 'Queue a tool call transactionally' });

    expect(result.status).toBe('success');
    expect(runInTransaction).toHaveBeenCalledTimes(4);
    const events = await eventStore.listByRun(result.runId);
    const snapshotEvents = events.filter((event) => event.type === 'snapshot.created');
    expect(snapshotEvents.length).toBeGreaterThanOrEqual(3);
    const toolQueueSnapshotEvent = snapshotEvents.find(
      (event) =>
        typeof event.payload === 'object' &&
        event.payload !== null &&
        !Array.isArray(event.payload) &&
        event.payload.snapshotSeq === 2,
    );
    expect(toolQueueSnapshotEvent).toBeDefined();
  });

  it('uses a transaction store for tool completion ledger and event persistence', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const toolExecutionStore = new InMemoryToolExecutionStore();
    const runInTransaction = vi.fn(async (operation: (stores: RuntimeStores) => Promise<unknown>) =>
      operation({
        runStore,
        eventStore,
        snapshotStore,
        toolExecutionStore,
      }),
    );
    const agent = new AdaptiveAgent({
      model: new SequenceModel([
        {
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'lookup-call-1',
              name: 'lookup',
              input: { topic: 'tool-ledger' },
            },
          ],
        },
        {
          finishReason: 'stop',
          structuredOutput: { report: 'tool completed transactionally' },
        },
      ]),
      tools: [createLookupTool()],
      runStore,
      eventStore,
      snapshotStore,
      toolExecutionStore,
      transactionStore: {
        runStore,
        eventStore,
        snapshotStore,
        toolExecutionStore,
        runInTransaction,
      },
    });

    const result = await agent.run({ goal: 'Complete a tool call transactionally' });

    expect(result.status).toBe('success');
    expect(runInTransaction).toHaveBeenCalledTimes(4);
    const events = await eventStore.listByRun(result.runId);
    expect(events.some((event) => event.type === 'tool.completed')).toBe(true);
    const record = await toolExecutionStore.getByIdempotencyKey(`${result.runId}:step-1:lookup-call-1`);
    expect(record).toMatchObject({
      status: 'completed',
      output: { finding: 'researched:tool-ledger' },
    });
  });

  it('uses a transaction store for child spawn and parent delegate resolution', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const transactionEventGroups: string[][] = [];
    const runInTransaction = vi.fn(async (operation: (stores: RuntimeStores) => Promise<unknown>) => {
      const eventTypes: string[] = [];
      try {
        return await operation({
          runStore,
          eventStore: {
            append: async (event) => {
              eventTypes.push(event.type);
              return eventStore.append(event);
            },
            listByRun: (runId, afterSeq) => eventStore.listByRun(runId, afterSeq),
            subscribe: (listener) => eventStore.subscribe(listener),
          },
          snapshotStore,
        });
      } finally {
        transactionEventGroups.push(eventTypes);
      }
    });
    const agent = new AdaptiveAgent({
      model: new SequenceModel([
        {
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'parent-call-1',
              name: 'delegate.researcher',
              input: {
                goal: 'Research transactional delegation',
                input: { topic: 'transactions' },
              },
            },
          ],
        },
        {
          finishReason: 'stop',
          structuredOutput: {
            finding: 'child result',
          },
        },
        {
          finishReason: 'stop',
          structuredOutput: {
            report: 'parent result',
          },
        },
      ]),
      tools: [createLookupTool()],
      delegates: [
        {
          name: 'researcher',
          description: 'Researches a topic using the lookup tool.',
          allowedTools: ['lookup'],
        },
      ],
      runStore,
      eventStore,
      snapshotStore,
      transactionStore: {
        runStore,
        eventStore,
        snapshotStore,
        runInTransaction,
      },
    });

    const result = await agent.run({ goal: 'Delegate transactionally' });

    expect(result).toMatchObject({
      status: 'success',
      output: {
        report: 'parent result',
      },
    });
    expect(transactionEventGroups).toContainEqual([
      'run.status_changed',
      'snapshot.created',
      'delegate.spawned',
      'run.created',
    ]);
    expect(transactionEventGroups).toContainEqual(['run.status_changed', 'tool.completed']);
  });

  it('emits structured lifecycle logs with model, tool, and delegation context', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const chunks: string[] = [];
    const stream = new PassThrough();
    stream.on('data', (chunk) => chunks.push(chunk.toString()));

    const logger = pino({ level: 'debug', base: undefined }, stream);
    const agent = new AdaptiveAgent({
      model: new SequenceModel([
        {
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'parent-call-1',
              name: 'delegate.researcher',
              input: {
                goal: 'Research delegation',
                input: { topic: 'delegation' },
              },
            },
          ],
        },
        {
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'child-call-1',
              name: 'lookup',
              input: { topic: 'delegation' },
            },
          ],
        },
        {
          finishReason: 'stop',
          structuredOutput: {
            finding: 'researched:delegation',
          },
        },
        {
          finishReason: 'stop',
          structuredOutput: {
            report: 'delegation complete',
          },
        },
      ]),
      tools: [createLookupTool()],
      delegates: [
        {
          name: 'researcher',
          description: 'Researches a topic using the lookup tool.',
          allowedTools: ['lookup'],
        },
      ],
      logger,
      runStore,
      eventStore,
      snapshotStore,
      defaults: {
        capture: 'full',
      },
    });

    const result = await agent.run({ goal: 'Write a delegation memo' });
    expect(result.status).toBe('success');

    await new Promise((resolve) => setTimeout(resolve, 0));
    const entries = chunks
      .join('')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    const modelRequestLog = entries.find((entry) => entry.event === 'model.request');
    expect(modelRequestLog).toBeDefined();
    expect(modelRequestLog?.messageCount).toBeGreaterThan(0);

    const systemInjectionLog = entries.find(
      (entry) => entry.event === 'system_message.injected' && entry.source === 'initial_prompt',
    );
    expect(systemInjectionLog).toMatchObject({
      snapshotField: 'messages',
      snapshotStoreConfigured: true,
    });
    expect(systemInjectionLog?.content).toMatchObject({
      type: 'string',
      preview: expect.stringContaining('You are AdaptiveAgent.'),
    });

    const delegateSpawnedLog = entries.find(
      (entry) => entry.event === 'delegate.spawned' && entry.toolName === 'delegate.researcher',
    );
    expect(delegateSpawnedLog).toBeDefined();
    expect(delegateSpawnedLog?.childRunId).toBeTruthy();

    const lookupStartLog = entries.find(
      (entry) => entry.event === 'tool.started' && entry.toolName === 'lookup',
    );
    expect(lookupStartLog?.input).toMatchObject({
      topic: 'delegation',
    });

    const lookupCompletedLog = entries.find(
      (entry) => entry.event === 'tool.completed' && entry.toolName === 'lookup',
    );
    expect(lookupCompletedLog?.output).toMatchObject({
      finding: 'researched:delegation',
    });

    const latestSnapshot = await snapshotStore.getLatest(result.runId);
    expect(latestSnapshot?.state).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: 'system',
          content: expect.stringContaining('You are AdaptiveAgent.'),
        }),
      ]),
    });

    const completedRunLog = entries.find((entry) => entry.event === 'run.completed' && entry.output);
    expect(completedRunLog).toBeDefined();
  });

  it('executes multiple tool calls from one model turn before resuming the model', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const model = new SequenceModel([
      {
        finishReason: 'tool_calls',
        usage: {
          promptTokens: 10,
          completionTokens: 4,
          totalTokens: 14,
          estimatedCostUSD: 0,
        },
        toolCalls: [
          {
            id: 'call-1',
            name: 'lookup',
            input: { topic: 'alpha' },
          },
          {
            id: 'call-2',
            name: 'lookup',
            input: { topic: 'beta' },
          },
        ],
      },
      {
        finishReason: 'stop',
        usage: {
          promptTokens: 20,
          completionTokens: 6,
          totalTokens: 26,
          estimatedCostUSD: 0,
        },
        structuredOutput: {
          report: 'complete',
        },
      },
    ]);

    const agent = new AdaptiveAgent({
      model,
      tools: [createLookupTool()],
      runStore,
      eventStore,
      snapshotStore,
    });

    const result = await agent.run({ goal: 'Research two topics' });
    expect(result).toMatchObject({
      status: 'success',
      output: { report: 'complete' },
      stepsUsed: 3,
      usage: {
        promptTokens: 30,
        completionTokens: 10,
        totalTokens: 40,
        estimatedCostUSD: 0,
      },
    });

    const followupRequest = model.receivedRequests[1];
    expect(followupRequest).toBeDefined();

    const assistantMessage = followupRequest.messages.find((message) => message.role === 'assistant');
    expect(assistantMessage).toMatchObject({
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'call-1', name: 'lookup', input: { topic: 'alpha' } },
        { id: 'call-2', name: 'lookup', input: { topic: 'beta' } },
      ],
    });

    const toolMessages = followupRequest.messages.filter((message) => message.role === 'tool');
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages).toMatchObject([
      {
        toolCallId: 'call-1',
        name: 'lookup',
        content: '{"finding":"researched:alpha"}',
      },
      {
        toolCallId: 'call-2',
        name: 'lookup',
        content: '{"finding":"researched:beta"}',
      },
    ]);
  });

  it('continues after a recoverable tool error and passes the recovered output back to the model', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const model = new SequenceModel([
      {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'recoverable-call-1',
            name: 'web_like.lookup',
            input: { query: 'recoverable error' },
          },
        ],
      },
      {
        finishReason: 'stop',
        structuredOutput: { status: 'continued' },
      },
    ]);

    const agent = new AdaptiveAgent({
      model,
      tools: [
        {
          name: 'web_like.lookup',
          description: 'Simulates a web tool that can soft-fail.',
          inputSchema: { type: 'object', additionalProperties: true },
          async execute() {
            throw new Error('HTTP 429 fetching search results');
          },
          recoverError(error) {
            return {
              query: 'recoverable error',
              results: [],
              error: error instanceof Error ? error.message : String(error),
            };
          },
        },
      ],
      runStore,
      eventStore,
      snapshotStore,
    });

    const result = await agent.run({ goal: 'Keep going after a web-style transient failure' });
    expect(result).toMatchObject({
      status: 'success',
      output: { status: 'continued' },
    });

    const followupRequest = model.receivedRequests[1];
    expect(followupRequest?.messages.filter((message) => message.role === 'tool')).toMatchObject([
      {
        name: 'web_like.lookup',
        toolCallId: 'recoverable-call-1',
        content: JSON.stringify({
          query: 'recoverable error',
          results: [],
          error: 'HTTP 429 fetching search results',
        }),
      },
    ]);

    const events = await eventStore.listByRun(result.runId);
    expect(
      events.find(
        (event) =>
          event.type === 'tool.failed' &&
          typeof event.payload === 'object' &&
          event.payload !== null &&
          'toolName' in event.payload &&
          event.payload.toolName === 'web_like.lookup',
      )?.payload,
    ).toMatchObject({
      input: {
        preview: {
          query: 'recoverable error',
        },
        type: 'object',
      },
      recoverable: true,
      output: {
        query: 'recoverable error',
        results: [],
        error: 'HTTP 429 fetching search results',
      },
    });
  });

  it('continues after a recoverable tool timeout and passes the recovered output back to the model', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const model = new SequenceModel([
      {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'timeout-call-1',
            name: 'web_like.read',
            input: { url: 'https://example.com/slow' },
          },
        ],
      },
      {
        finishReason: 'stop',
        structuredOutput: { status: 'continued-after-timeout' },
      },
    ]);

    const agent = new AdaptiveAgent({
      model,
      tools: [
        {
          name: 'web_like.read',
          description: 'Simulates a slow web reader.',
          inputSchema: { type: 'object', additionalProperties: true },
          timeoutMs: 1,
          async execute() {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return {
              url: 'https://example.com/slow',
              title: 'too late',
              text: 'too late',
              bytesFetched: 123,
            };
          },
          recoverError(error, input) {
            const payload = input as { url: string };
            return {
              url: payload.url,
              title: '',
              text: '',
              bytesFetched: 0,
              error: error instanceof Error ? error.message : String(error),
            };
          },
        },
      ],
      runStore,
      eventStore,
      snapshotStore,
    });

    const result = await agent.run({ goal: 'Keep going after a tool timeout' });
    expect(result).toMatchObject({
      status: 'success',
      output: { status: 'continued-after-timeout' },
    });

    const followupRequest = model.receivedRequests[1];
    expect(followupRequest?.messages.filter((message) => message.role === 'tool')).toMatchObject([
      {
        name: 'web_like.read',
        toolCallId: 'timeout-call-1',
        content: JSON.stringify({
          url: 'https://example.com/slow',
          title: '',
          text: '',
          bytesFetched: 0,
          error: 'Timed out after 1ms',
        }),
      },
    ]);
  });

  it('uses a longer default model timeout for ollama unless explicitly overridden', async () => {
    const ollamaRunStore = new InMemoryRunStore();
    const ollamaEventStore = new InMemoryEventStore();
    const ollamaSnapshotStore = new InMemorySnapshotStore();
    const ollamaLeaseSpy = vi.spyOn(ollamaRunStore, 'tryAcquireLease');
    const ollamaAgent = new AdaptiveAgent({
      model: new SequenceModel(
        [
          {
            finishReason: 'stop',
            structuredOutput: {
              report: 'complete',
            },
          },
        ],
        'ollama',
      ),
      tools: [createLookupTool()],
      runStore: ollamaRunStore,
      eventStore: ollamaEventStore,
      snapshotStore: ollamaSnapshotStore,
    });

    await ollamaAgent.run({ goal: 'Finish quickly' });
    expect(ollamaLeaseSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        ttlMs: 360_000,
      }),
    );

    const overrideRunStore = new InMemoryRunStore();
    const overrideEventStore = new InMemoryEventStore();
    const overrideSnapshotStore = new InMemorySnapshotStore();
    const overrideLeaseSpy = vi.spyOn(overrideRunStore, 'tryAcquireLease');
    const overrideAgent = new AdaptiveAgent({
      model: new SequenceModel(
        [
          {
            finishReason: 'stop',
            structuredOutput: {
              report: 'complete',
            },
          },
        ],
        'ollama',
      ),
      tools: [createLookupTool()],
      runStore: overrideRunStore,
      eventStore: overrideEventStore,
      snapshotStore: overrideSnapshotStore,
      defaults: {
        modelTimeoutMs: 12_345,
      },
    });

    await overrideAgent.run({ goal: 'Finish quickly' });
    expect(overrideLeaseSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        ttlMs: 12_345,
      }),
    );
  });

  it('fails the run cleanly when the model exceeds modelTimeoutMs', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    let receivedSignal: AbortSignal | undefined;

    const model: ModelAdapter = {
      provider: 'test',
      model: 'slow-model',
      capabilities: {
        toolCalling: true,
        jsonOutput: true,
        streaming: false,
        usage: false,
      },
      async generate(request) {
        receivedSignal = request.signal;
        return new Promise<ModelResponse>((_resolve, reject) => {
          request.signal?.addEventListener(
            'abort',
            () => reject(request.signal?.reason ?? new Error('aborted')),
            { once: true },
          );
        });
      },
    };

    const agent = new AdaptiveAgent({
      model,
      tools: [createLookupTool()],
      runStore,
      eventStore,
      snapshotStore,
      defaults: {
        modelTimeoutMs: 5,
      },
    });

    const result = await agent.run({ goal: 'Wait for a model response that never arrives' });
    expect(result).toMatchObject({
      status: 'failure',
      code: 'MODEL_ERROR',
      error: 'Model timed out after 5ms',
    });
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal?.aborted).toBe(true);

    const storedRun = await runStore.getRun(result.runId);
    expect(storedRun?.status).toBe('failed');
  });

  it('maps delegated child completion back to the parent run', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const toolExecutionStore = new InMemoryToolExecutionStore();
    const agent = new AdaptiveAgent({
      model: new SequenceModel([
        {
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'parent-call-1',
              name: 'delegate.researcher',
              input: {
                goal: 'Research delegation',
                input: { topic: 'delegation' },
              },
            },
          ],
        },
        {
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'child-call-1',
              name: 'lookup',
              input: { topic: 'delegation' },
            },
          ],
        },
        {
          finishReason: 'stop',
          structuredOutput: {
            finding: 'researched:delegation',
          },
        },
        {
          finishReason: 'stop',
          structuredOutput: {
            report: 'delegation complete',
          },
        },
      ]),
      tools: [createLookupTool()],
      delegates: [
        {
          name: 'researcher',
          description: 'Researches a topic using the lookup tool.',
          allowedTools: ['lookup'],
        },
      ],
      runStore,
      eventStore,
      snapshotStore,
      toolExecutionStore,
    });

    const result = await agent.run({ goal: 'Write a delegation memo' });
    if (result.status !== 'success') {
      throw new Error(`Expected success, received ${result.status}`);
    }

    expect(result.output).toEqual({ report: 'delegation complete' });

    const childRuns = await runStore.listChildren(result.runId);
    expect(childRuns).toHaveLength(1);
    expect(childRuns[0]).toMatchObject({
      parentRunId: result.runId,
      delegateName: 'researcher',
      status: 'succeeded',
      result: {
        finding: 'researched:delegation',
      },
    });

    const parentEvents = await eventStore.listByRun(result.runId);
    expect(parentEvents.some((event) => event.type === 'delegate.spawned')).toBe(true);
    expect(
      parentEvents.find(
        (event) =>
          event.type === 'tool.completed' &&
          typeof event.payload === 'object' &&
          event.payload !== null &&
          'toolName' in event.payload &&
          event.payload.toolName === 'delegate.researcher',
      )?.payload,
    ).toMatchObject({
      output: {
        finding: 'researched:delegation',
      },
    });

    const delegateExecution = await toolExecutionStore.getByIdempotencyKey(`${result.runId}:step-1:parent-call-1`);
    expect(delegateExecution).toMatchObject({
      toolName: 'delegate.researcher',
      input: {
        goal: 'Research delegation',
        input: { topic: 'delegation' },
      },
      childRunId: childRuns[0]?.id,
      status: 'completed',
      output: {
        finding: 'researched:delegation',
      },
    });
  });

  it('uses explicit parent maxSteps as a floor for delegated child agents', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const agent = new AdaptiveAgent({
      model: new SequenceModel([
        {
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'parent-call-1',
              name: 'delegate.researcher',
              input: {
                goal: 'Research with raised parent budget',
                input: { topic: 'raised-budget' },
              },
            },
          ],
        },
        {
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'child-call-1',
              name: 'lookup',
              input: { topic: 'raised-budget' },
            },
          ],
        },
        {
          finishReason: 'stop',
          structuredOutput: {
            finding: 'researched:raised-budget',
          },
        },
        {
          finishReason: 'stop',
          structuredOutput: {
            report: 'delegation complete',
          },
        },
      ]),
      tools: [createLookupTool()],
      delegates: [
        {
          name: 'researcher',
          description: 'Researches a topic using the lookup tool.',
          allowedTools: ['lookup'],
          defaults: { maxSteps: 1 },
        },
      ],
      defaults: { maxSteps: 3 },
      runStore,
      eventStore,
      snapshotStore,
    });

    const result = await agent.run({ goal: 'Delegate with raised parent budget' });

    expect(result).toMatchObject({
      status: 'success',
      output: {
        report: 'delegation complete',
      },
    });
    const childRuns = await runStore.listChildren(result.runId);
    expect(childRuns[0]).toMatchObject({
      status: 'succeeded',
      result: {
        finding: 'researched:raised-budget',
      },
    });
  });

  it('does not apply the parent tool timeout to delegate tools while the child run is still making progress', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const slowLookup = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { finding: 'slow-result' };
    });

    const agent = new AdaptiveAgent({
      model: new SequenceModel([
        {
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'parent-call-1',
              name: 'delegate.researcher',
              input: {
                goal: 'Research slowly',
              },
            },
          ],
        },
        {
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'child-call-1',
              name: 'lookup',
              input: { topic: 'slow' },
            },
          ],
        },
        {
          finishReason: 'stop',
          structuredOutput: {
            finding: 'slow-result',
          },
        },
        {
          finishReason: 'stop',
          structuredOutput: {
            report: 'delegate completed',
          },
        },
      ]),
      tools: [
        {
          name: 'lookup',
          description: 'Looks up a topic slowly.',
          inputSchema: { type: 'object', additionalProperties: true },
          execute: slowLookup,
        },
      ],
      delegates: [
        {
          name: 'researcher',
          description: 'Researches slowly using the lookup tool.',
          allowedTools: ['lookup'],
          defaults: {
            toolTimeoutMs: 100,
          },
        },
      ],
      runStore,
      eventStore,
      snapshotStore,
      defaults: {
        toolTimeoutMs: 5,
      },
    });

    const result = await agent.run({ goal: 'Wait for the delegated child run' });
    expect(result).toMatchObject({
      status: 'success',
      output: { report: 'delegate completed' },
    });
    expect(slowLookup).toHaveBeenCalledTimes(1);
  });

  it('resumes a parent run from awaiting_subagent using the stored child result', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const parentRun = await runStore.createRun({
      goal: 'Resume a delegated parent',
      status: 'queued',
    });
    const childRun = await runStore.createRun({
      rootRunId: parentRun.id,
      parentRunId: parentRun.id,
      parentStepId: 'step-1',
      delegateName: 'researcher',
      delegationDepth: 1,
      goal: 'Research a topic',
      status: 'queued',
    });
    await runStore.updateRun(
      childRun.id,
      {
        status: 'succeeded',
        result: {
          finding: 'resume-ready',
        },
      },
      childRun.version,
    );
    const waitingParent = await runStore.updateRun(
      parentRun.id,
      {
        status: 'awaiting_subagent',
        currentChildRunId: childRun.id,
        currentStepId: 'step-1',
      },
      parentRun.version,
    );

    await snapshotStore.save({
      runId: waitingParent.id,
      snapshotSeq: 1,
      status: 'awaiting_subagent',
      currentStepId: 'step-1',
      summary: {
        status: 'awaiting_subagent',
        stepsUsed: 0,
      },
      state: {
        messages: [
          { role: 'system', content: 'You are AdaptiveAgent.' },
          { role: 'user', content: 'Resume the parent run.' },
        ],
        stepsUsed: 0,
        pendingToolCall: {
          id: 'parent-call-1',
          name: 'delegate.researcher',
          input: {
            goal: 'Research a topic',
          },
          stepId: 'step-1',
        },
        waitingOnChildRunId: childRun.id,
      },
    });

    const agent = new AdaptiveAgent({
      model: new SequenceModel([
        {
          finishReason: 'stop',
          structuredOutput: {
            report: 'resumed successfully',
          },
        },
      ]),
      tools: [createLookupTool()],
      delegates: [
        {
          name: 'researcher',
          description: 'Researches a topic using the lookup tool.',
          allowedTools: ['lookup'],
        },
      ],
      runStore,
      eventStore,
      snapshotStore,
    });

    const result = await agent.resume(parentRun.id);
    if (result.status !== 'success') {
      throw new Error(`Expected success, received ${result.status}`);
    }

    expect(result.output).toEqual({ report: 'resumed successfully' });

    const storedParent = await runStore.getRun(parentRun.id);
    expect(storedParent).toMatchObject({
      status: 'succeeded',
      currentChildRunId: undefined,
      result: {
        report: 'resumed successfully',
      },
    });

    const parentEvents = await eventStore.listByRun(parentRun.id);
    expect(
      parentEvents.find(
        (event) =>
          event.type === 'tool.completed' &&
          typeof event.payload === 'object' &&
          event.payload !== null &&
          'toolName' in event.payload &&
          event.payload.toolName === 'delegate.researcher',
      )?.payload,
    ).toMatchObject({
      output: {
        finding: 'resume-ready',
      },
    });
  });

  it('fails a resumed parent run cleanly when the stored child run failed', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const parentRun = await runStore.createRun({
      goal: 'Resume a failed delegated parent',
      status: 'queued',
    });
    const childRun = await runStore.createRun({
      rootRunId: parentRun.id,
      parentRunId: parentRun.id,
      parentStepId: 'step-1',
      delegateName: 'researcher',
      delegationDepth: 1,
      goal: 'Research a topic',
      status: 'queued',
    });
    await runStore.updateRun(
      childRun.id,
      {
        status: 'failed',
        errorCode: 'TOOL_ERROR',
        errorMessage: 'Child run failed',
      },
      childRun.version,
    );
    const waitingParent = await runStore.updateRun(
      parentRun.id,
      {
        status: 'awaiting_subagent',
        currentChildRunId: childRun.id,
        currentStepId: 'step-1',
      },
      parentRun.version,
    );

    await snapshotStore.save({
      runId: waitingParent.id,
      snapshotSeq: 1,
      status: 'awaiting_subagent',
      currentStepId: 'step-1',
      summary: {
        status: 'awaiting_subagent',
        stepsUsed: 0,
      },
      state: {
        messages: [
          { role: 'system', content: 'You are AdaptiveAgent.' },
          { role: 'user', content: 'Resume the parent run.' },
        ],
        stepsUsed: 0,
        pendingToolCall: {
          id: 'parent-call-1',
          name: 'delegate.researcher',
          input: {
            goal: 'Research a topic',
          },
          stepId: 'step-1',
        },
        waitingOnChildRunId: childRun.id,
      },
    });

    const agent = new AdaptiveAgent({
      model: new SequenceModel([]),
      tools: [createLookupTool()],
      delegates: [
        {
          name: 'researcher',
          description: 'Researches a topic using the lookup tool.',
          allowedTools: ['lookup'],
        },
      ],
      runStore,
      eventStore,
      snapshotStore,
    });

    const result = await agent.resume(parentRun.id);
    if (result.status !== 'failure') {
      throw new Error(`Expected failure, received ${result.status}`);
    }

    expect(result.error).toContain('Child run failed');
    expect(result.code).toBe('TOOL_ERROR');

    const storedParent = await runStore.getRun(parentRun.id);
    expect(storedParent).toMatchObject({
      status: 'failed',
      currentChildRunId: undefined,
      errorCode: 'TOOL_ERROR',
      errorMessage: 'Child run failed',
    });
  });

  it('recovers a resolved parent delegate snapshot without spawning another child run', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const parentRun = await runStore.createRun({
      goal: 'Recover a resolved delegation boundary',
      status: 'queued',
    });
    const childRun = await runStore.createRun({
      rootRunId: parentRun.id,
      parentRunId: parentRun.id,
      parentStepId: 'step-1',
      delegateName: 'researcher',
      delegationDepth: 1,
      goal: 'Research a topic',
      status: 'queued',
    });
    await runStore.updateRun(
      childRun.id,
      {
        status: 'succeeded',
        result: {
          finding: 'already-resolved',
        },
      },
      childRun.version,
    );
    const runningParent = await runStore.updateRun(
      parentRun.id,
      {
        status: 'running',
        currentChildRunId: undefined,
        currentStepId: 'step-1',
      },
      parentRun.version,
    );

    await snapshotStore.save({
      runId: runningParent.id,
      snapshotSeq: 1,
      status: 'awaiting_subagent',
      currentStepId: 'step-1',
      summary: {
        status: 'awaiting_subagent',
        stepsUsed: 0,
      },
      state: {
        schemaVersion: 1,
        messages: [
          { role: 'system', content: 'You are AdaptiveAgent.' },
          { role: 'user', content: 'Resume after a crash.' },
        ],
        stepsUsed: 0,
        pendingToolCall: {
          id: 'parent-call-1',
          name: 'delegate.researcher',
          input: {
            goal: 'Research a topic',
          },
          stepId: 'step-1',
        },
        waitingOnChildRunId: childRun.id,
      },
    });

    const agent = new AdaptiveAgent({
      model: new SequenceModel([
        {
          finishReason: 'stop',
          structuredOutput: {
            report: 'continued from child result',
          },
        },
      ]),
      tools: [createLookupTool()],
      delegates: [
        {
          name: 'researcher',
          description: 'Researches a topic using the lookup tool.',
          allowedTools: ['lookup'],
        },
      ],
      runStore,
      eventStore,
      snapshotStore,
    });

    const result = await agent.resume(parentRun.id);

    expect(result).toMatchObject({
      status: 'success',
      output: {
        report: 'continued from child result',
      },
    });
    await expect(runStore.listChildren(parentRun.id)).resolves.toHaveLength(1);
    const parentEvents = await eventStore.listByRun(parentRun.id);
    expect(parentEvents.some((event) => event.type === 'delegate.spawned')).toBe(false);
    expect(parentEvents.some((event) => event.type === 'step.completed')).toBe(true);
  });

  it('fails a waiting parent when the claimed child run belongs to another parent', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const parentRun = await runStore.createRun({
      goal: 'Reject mismatched child linkage',
      status: 'queued',
    });
    const otherParentRun = await runStore.createRun({
      goal: 'Own the child run',
      status: 'queued',
    });
    const childRun = await runStore.createRun({
      rootRunId: otherParentRun.id,
      parentRunId: otherParentRun.id,
      parentStepId: 'step-1',
      delegateName: 'researcher',
      delegationDepth: 1,
      goal: 'Research for the other parent',
      status: 'queued',
    });
    await runStore.updateRun(
      childRun.id,
      {
        status: 'succeeded',
        result: {
          finding: 'wrong-parent',
        },
      },
      childRun.version,
    );
    const waitingParent = await runStore.updateRun(
      parentRun.id,
      {
        status: 'awaiting_subagent',
        currentChildRunId: childRun.id,
        currentStepId: 'step-1',
      },
      parentRun.version,
    );

    await snapshotStore.save({
      runId: waitingParent.id,
      snapshotSeq: 1,
      status: 'awaiting_subagent',
      currentStepId: 'step-1',
      summary: {
        status: 'awaiting_subagent',
        stepsUsed: 0,
      },
      state: {
        schemaVersion: 1,
        messages: [
          { role: 'system', content: 'You are AdaptiveAgent.' },
          { role: 'user', content: 'Resume with a bad child link.' },
        ],
        stepsUsed: 0,
        pendingToolCall: {
          id: 'parent-call-1',
          name: 'delegate.researcher',
          input: {
            goal: 'Research a topic',
          },
          stepId: 'step-1',
        },
        waitingOnChildRunId: childRun.id,
      },
    });

    const agent = new AdaptiveAgent({
      model: new SequenceModel([]),
      tools: [createLookupTool()],
      delegates: [
        {
          name: 'researcher',
          description: 'Researches a topic using the lookup tool.',
          allowedTools: ['lookup'],
        },
      ],
      runStore,
      eventStore,
      snapshotStore,
    });

    const result = await agent.resume(parentRun.id);

    expect(result).toMatchObject({
      status: 'failure',
      code: 'TOOL_ERROR',
    });
    if (result.status !== 'failure') {
      throw new Error(`Expected failure, received ${result.status}`);
    }
    expect(result.error).toContain('is not linked to parent run');
    const storedParent = await runStore.getRun(parentRun.id);
    expect(storedParent).toMatchObject({
      status: 'failed',
      currentChildRunId: undefined,
    });
  });

  it('executes a gated tool after approval is resolved', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const gatedExecute = vi.fn(async () => ({ ok: true }));
    const agent = new AdaptiveAgent({
      model: new SequenceModel([
        {
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'approval-call-1',
              name: 'secure.write',
              input: { recordId: 'doc-1' },
            },
          ],
        },
        {
          finishReason: 'stop',
          structuredOutput: { status: 'done' },
        },
      ]),
      tools: [
        {
          name: 'secure.write',
          description: 'Writes a protected record.',
          inputSchema: { type: 'object', additionalProperties: true },
          requiresApproval: true,
          execute: gatedExecute,
        },
      ],
      runStore,
      eventStore,
      snapshotStore,
    });

    const firstResult = await agent.run({ goal: 'Write a protected record' });
    if (firstResult.status !== 'approval_requested') {
      throw new Error(`Expected approval_requested, received ${firstResult.status}`);
    }

    expect(firstResult.toolName).toBe('secure.write');
    expect(gatedExecute).not.toHaveBeenCalled();

    const storedRun = await runStore.getRun(firstResult.runId);
    expect(storedRun?.status).toBe('awaiting_approval');

    const latestSnapshot = await snapshotStore.getLatest(firstResult.runId);
    expect(latestSnapshot?.status).toBe('awaiting_approval');
    expect(latestSnapshot?.state).toMatchObject({
      schemaVersion: 1,
      pendingToolCall: {
        name: 'secure.write',
      },
    });

    const resumed = await agent.resume(firstResult.runId);
    expect(resumed).toMatchObject({
      status: 'approval_requested',
      runId: firstResult.runId,
      toolName: 'secure.write',
    });

    await agent.resolveApproval(firstResult.runId, true);

    const approvedSnapshot = await snapshotStore.getLatest(firstResult.runId);
    expect(approvedSnapshot?.status).toBe('running');
    expect(approvedSnapshot?.state).toMatchObject({
      schemaVersion: 1,
      approvedToolCallIds: ['approval-call-1'],
    });

    const completed = await agent.resume(firstResult.runId);
    expect(completed).toMatchObject({
      status: 'success',
      runId: firstResult.runId,
      output: { status: 'done' },
    });
    expect(gatedExecute).toHaveBeenCalledTimes(1);

    const approvalEvents = await eventStore.listByRun(firstResult.runId);
    expect(approvalEvents.some((event) => event.type === 'approval.requested')).toBe(true);
    expect(approvalEvents.some((event) => event.type === 'approval.resolved')).toBe(true);
  });

  it('continues a clarification-requested run after resolveClarification()', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const model = new SequenceModel([
      {
        finishReason: 'stop',
        structuredOutput: { format: 'markdown' },
      },
    ]);

    const agent = new AdaptiveAgent({
      model,
      tools: [],
      runStore,
      eventStore,
      snapshotStore,
    });

    const run = await runStore.createRun({
      goal: 'Prepare the final report',
      status: 'clarification_requested',
    });
    await snapshotStore.save({
      runId: run.id,
      snapshotSeq: 1,
      status: 'clarification_requested',
      currentStepId: 'step-1',
      summary: {
        status: 'clarification_requested',
        stepsUsed: 1,
      },
      state: {
        messages: [
          { role: 'system', content: 'You are AdaptiveAgent.' },
          { role: 'user', content: '{"goal":"Prepare the final report"}' },
          { role: 'assistant', content: 'What format should the report use?' },
        ],
        stepsUsed: 1,
      },
    });

    const result = await agent.resolveClarification(run.id, 'Use markdown with headings');

    expect(result).toMatchObject({
      status: 'success',
      runId: run.id,
      output: { format: 'markdown' },
    });
    expect(model.receivedRequests[0]?.messages.at(-1)).toEqual({
      role: 'user',
      content: 'Use markdown with headings',
    });

    const storedRun = await runStore.getRun(run.id);
    expect(storedRun?.status).toBe('succeeded');

    const runEvents = await eventStore.listByRun(run.id);
    expect(runEvents.some((event) => event.type === 'run.resumed')).toBe(true);
  });

  it('rejects incompatible versioned snapshot state during resume', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const run = await runStore.createRun({
      goal: 'Resume from a future snapshot',
      status: 'interrupted',
    });
    await snapshotStore.save({
      runId: run.id,
      snapshotSeq: 1,
      status: 'interrupted',
      currentStepId: 'step-1',
      summary: {
        status: 'interrupted',
        stepsUsed: 1,
      },
      state: {
        schemaVersion: 999,
        messages: [
          { role: 'system', content: 'You are AdaptiveAgent.' },
          { role: 'user', content: '{"goal":"Resume from a future snapshot"}' },
        ],
        stepsUsed: 1,
      },
    });

    const agent = new AdaptiveAgent({
      model: new SequenceModel([]),
      tools: [],
      runStore,
      eventStore,
      snapshotStore,
    });

    await expect(agent.resume(run.id)).rejects.toThrow('latest snapshot state is not compatible');
  });

  it('reuses a completed tool execution ledger entry during resume', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const toolExecutionStore = new InMemoryToolExecutionStore();
    const execute = vi.fn(async () => ({ finding: 'fresh' }));
    const run = await runStore.createRun({
      goal: 'Resume a cached tool call',
      status: 'interrupted',
    });
    await snapshotStore.save({
      runId: run.id,
      snapshotSeq: 1,
      status: 'interrupted',
      currentStepId: 'step-1',
      summary: {
        status: 'interrupted',
        stepsUsed: 0,
      },
      state: {
        schemaVersion: 1,
        messages: [
          { role: 'system', content: 'You are AdaptiveAgent.' },
          { role: 'user', content: '{"goal":"Resume a cached tool call"}' },
        ],
        stepsUsed: 0,
        pendingToolCall: {
          id: 'call-1',
          name: 'lookup',
          input: {
            topic: 'resumability',
          },
          stepId: 'step-1',
        },
      },
    });
    await toolExecutionStore.markStarted({
      runId: run.id,
      stepId: 'step-1',
      toolCallId: 'call-1',
      toolName: 'lookup',
      idempotencyKey: `${run.id}:step-1:call-1`,
      inputHash: '{"topic":"resumability"}',
    });
    await toolExecutionStore.markCompleted(`${run.id}:step-1:call-1`, { finding: 'cached' });

    const model = new SequenceModel([
      {
        finishReason: 'stop',
        structuredOutput: { report: 'used cached tool result' },
      },
    ]);
    const agent = new AdaptiveAgent({
      model,
      tools: [
        {
          name: 'lookup',
          description: 'Looks up a topic.',
          inputSchema: { type: 'object', additionalProperties: true },
          execute,
        },
      ],
      runStore,
      eventStore,
      snapshotStore,
      toolExecutionStore,
    });

    const result = await agent.resume(run.id);

    expect(result).toMatchObject({
      status: 'success',
      output: { report: 'used cached tool result' },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(model.receivedRequests[0]?.messages.at(-1)).toEqual({
      role: 'tool',
      name: 'lookup',
      toolCallId: 'call-1',
      content: JSON.stringify({ finding: 'cached' }),
    });
  });

  it('continues from a model tool-call snapshot after a crash window', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const execute = vi.fn(async () => ({ finding: 'fresh after restart' }));
    const run = await runStore.createRun({
      goal: 'Resume a queued tool call',
      status: 'running',
    });
    await snapshotStore.save({
      runId: run.id,
      snapshotSeq: 1,
      status: 'running',
      currentStepId: 'step-1',
      summary: {
        status: 'running',
        stepsUsed: 0,
      },
      state: {
        schemaVersion: 1,
        messages: [
          { role: 'system', content: 'You are AdaptiveAgent.' },
          { role: 'user', content: '{"goal":"Resume a queued tool call"}' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'call-queued',
                name: 'lookup',
                input: { topic: 'crash-window' },
              },
            ],
          },
        ],
        stepsUsed: 0,
        pendingToolCall: {
          id: 'call-queued',
          name: 'lookup',
          input: {
            topic: 'crash-window',
          },
          stepId: 'step-1',
        },
      },
    });

    const model = new SequenceModel([
      {
        finishReason: 'stop',
        structuredOutput: { report: 'continued after queued tool call' },
      },
    ]);
    const agent = new AdaptiveAgent({
      model,
      tools: [
        {
          name: 'lookup',
          description: 'Looks up a topic.',
          inputSchema: { type: 'object', additionalProperties: true },
          execute,
        },
      ],
      runStore,
      eventStore,
      snapshotStore,
    });

    const result = await agent.resume(run.id);

    expect(result).toMatchObject({
      status: 'success',
      output: { report: 'continued after queued tool call' },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      { topic: 'crash-window' },
      expect.objectContaining({
        runId: run.id,
        stepId: 'step-1',
        idempotencyKey: `${run.id}:step-1:call-queued`,
      }),
    );
    expect(model.receivedRequests[0]?.messages.at(-1)).toEqual({
      role: 'tool',
      name: 'lookup',
      toolCallId: 'call-queued',
      content: JSON.stringify({ finding: 'fresh after restart' }),
    });
  });

  it('returns the stored terminal result on repeated resume attempts', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const run = await runStore.createRun({
      goal: 'Repeated terminal resume',
      status: 'succeeded',
    });
    await runStore.updateRun(run.id, {
      result: { stable: true },
      status: 'succeeded',
    });
    await snapshotStore.save({
      runId: run.id,
      snapshotSeq: 1,
      status: 'succeeded',
      summary: {
        status: 'succeeded',
        stepsUsed: 2,
      },
      state: {
        schemaVersion: 1,
        messages: [
          { role: 'system', content: 'You are AdaptiveAgent.' },
          { role: 'user', content: '{"goal":"Repeated terminal resume"}' },
          { role: 'assistant', content: JSON.stringify({ stable: true }) },
        ],
        stepsUsed: 2,
      },
    });

    const model = new SequenceModel([]);
    const agent = new AdaptiveAgent({
      model,
      tools: [],
      runStore,
      eventStore,
      snapshotStore,
    });

    const first = await agent.resume(run.id);
    const second = await agent.resume(run.id);

    expect(first).toMatchObject({
      status: 'success',
      output: { stable: true },
      stepsUsed: 2,
    });
    expect(second).toEqual(first);
    expect(model.receivedRequests).toHaveLength(0);
  });

  it('rejects persisted delegate steps during executePlan with replan.required', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const planStore = new InMemoryPlanStore();
    const plan = await planStore.createPlan({
      id: crypto.randomUUID(),
      version: 1,
      status: 'approved',
      goal: 'Execute a persisted plan',
      summary: 'This plan should be rejected because it contains a delegate step.',
      toolsetHash: 'test-toolset',
      steps: [
        {
          id: 'step-1',
          title: 'Delegate research',
          toolName: 'delegate.researcher',
          inputTemplate: {
            goal: 'Research a topic',
          },
          onFailure: 'stop',
        },
      ],
    });
    const agent = new AdaptiveAgent({
      model: new SequenceModel([]),
      tools: [createLookupTool()],
      delegates: [
        {
          name: 'researcher',
          description: 'Researches a topic using the lookup tool.',
          allowedTools: ['lookup'],
        },
      ],
      runStore,
      eventStore,
      snapshotStore,
      planStore,
    });

    const result = await agent.executePlan({ planId: plan.id });
    if (result.status !== 'failure') {
      throw new Error(`Expected failure, received ${result.status}`);
    }

    expect(result.code).toBe('REPLAN_REQUIRED');
    expect(result.error).toContain('delegate.researcher');

    const storedRun = await runStore.getRun(result.runId);
    expect(storedRun?.status).toBe('replan_required');
    expect(storedRun?.currentPlanId).toBe(plan.id);
    expect(storedRun?.currentPlanExecutionId).toBeTruthy();

    const planExecution = await planStore.getExecution(storedRun?.currentPlanExecutionId ?? 'missing');
    expect(planExecution).toMatchObject({
      planId: plan.id,
      runId: result.runId,
      status: 'replan_required',
    });
    expect(planExecution?.replanReason).toContain('delegate.researcher');

    const runEvents = await eventStore.listByRun(result.runId);
    expect(runEvents.some((event) => event.type === 'replan.required')).toBe(true);
  });

  it('injects delegate instructions into the child run system prompt', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const model = new SequenceModel([
      {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'parent-call-1',
            name: 'delegate.researcher',
            input: {
              goal: 'Research delegation',
              input: { topic: 'delegation' },
            },
          },
        ],
      },
      // child model call — this is what we inspect
      {
        finishReason: 'stop',
        structuredOutput: { finding: 'child-done' },
      },
      // parent continues after child completes
      {
        finishReason: 'stop',
        structuredOutput: { report: 'done' },
      },
    ]);

    const agent = new AdaptiveAgent({
      model,
      tools: [createLookupTool()],
      delegates: [
        {
          name: 'researcher',
          description: 'Researches a topic.',
          instructions: '# Custom Researcher\n\nAlways cite your sources and be thorough.',
          allowedTools: ['lookup'],
        },
      ],
      runStore,
      eventStore,
      snapshotStore,
    });

    const result = await agent.run({ goal: 'Test instructions flow' });
    expect(result.status).toBe('success');

    // The second generate() call is the child agent's first model call
    const childRequest = model.receivedRequests[1];
    expect(childRequest).toBeDefined();

    const systemMessage = childRequest.messages.find((m) => m.role === 'system');
    expect(systemMessage).toBeDefined();
    expect(systemMessage!.content).toContain('## Skill Instructions');
    expect(systemMessage!.content).toContain('# Custom Researcher');
    expect(systemMessage!.content).toContain('Always cite your sources');
  });

  it('injects the budget checkpoint message before the next model call', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const toolExecutionStore = new InMemoryToolExecutionStore();
    const chunks: string[] = [];
    const stream = new PassThrough();
    stream.on('data', (chunk) => chunks.push(chunk.toString()));
    const model = new SequenceModel([
      {
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'search-1', name: 'web_search', input: { query: 'first', purpose: 'find starting evidence' } }],
      },
      {
        finishReason: 'stop',
        structuredOutput: { done: true },
      },
    ]);

    const agent = new AdaptiveAgent({
      model,
      tools: [createBudgetedSearchTool()],
      runStore,
      eventStore,
      snapshotStore,
      toolExecutionStore,
      logger: pino({ level: 'info', base: undefined }, stream),
      defaults: {
        researchPolicy: 'light',
      },
    });

    const result = await agent.run({ goal: 'Research something current' });
    expect(result).toMatchObject({ status: 'success' });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const entries = chunks
      .join('')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const checkpointLog = entries.find(
      (entry) => entry.event === 'system_message.injected' && entry.source === 'tool_budget.checkpoint',
    );
    expect(checkpointLog).toMatchObject({
      snapshotField: 'pendingRuntimeMessages',
      snapshotStoreConfigured: true,
    });
    expect(checkpointLog?.content).toMatchObject({
      type: 'string',
      preview: expect.stringContaining('near the web research budget'),
    });

    expect(model.receivedRequests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'system',
          content: expect.stringContaining('near the web research budget'),
        }),
      ]),
    );
  });

  it('steers the model to answer from current evidence when the search budget is exhausted', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const toolExecutionStore = new InMemoryToolExecutionStore();
    const model = new SequenceModel([
      {
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'search-1', name: 'web_search', input: { query: 'first', purpose: 'find starting evidence' } }],
      },
      {
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'search-2', name: 'web_search', input: { query: 'second', purpose: 'double check' } }],
      },
      {
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'search-3', name: 'web_search', input: { query: 'third', purpose: 'keep searching' } }],
      },
      {
        finishReason: 'stop',
        structuredOutput: { done: true },
      },
    ]);

    const agent = new AdaptiveAgent({
      model,
      tools: [createBudgetedSearchTool()],
      runStore,
      eventStore,
      snapshotStore,
      toolExecutionStore,
      defaults: {
        researchPolicy: 'light',
      },
    });

    const result = await agent.run({ goal: 'Research something current' });
    expect(result).toMatchObject({ status: 'success' });
    expect(model.receivedRequests[3]?.messages.at(-1)).toMatchObject({
      role: 'tool',
      name: 'web_search',
      content: expect.stringContaining('budget_exhausted'),
    });
  });

  it('logs model failure diagnostics for underlying transport timeouts', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const chunks: string[] = [];
    const stream = new PassThrough();
    stream.on('data', (chunk) => chunks.push(chunk.toString()));
    const transportTimeout = Object.assign(new Error('The operation timed out.'), {
      name: 'TimeoutError',
      modelInvocationPhase: 'http_request' as const,
      modelInvocationAttempt: 1,
    });
    const agent = new AdaptiveAgent({
      model: new SequenceModel([transportTimeout]),
      tools: [],
      logger: pino({ level: 'debug', base: undefined }, stream),
      runStore,
      eventStore,
      snapshotStore,
      defaults: {
        modelTimeoutMs: 900000,
      },
    });

    const result = await agent.run({ goal: 'Trigger a timeout' });
    expect(result).toMatchObject({
      status: 'failure',
      code: 'MODEL_ERROR',
      error: 'The operation timed out.',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const entries = chunks
      .join('')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    const failureLog = entries.find((entry) => entry.event === 'model.failed');
    expect(failureLog).toMatchObject({
      failurePhase: 'http_request',
      failureAttempt: 1,
    });
    expect(failureLog?.timeoutSource).toBeUndefined();
    expect(failureLog?.error).toMatchObject({
      name: 'TimeoutError',
      message: 'The operation timed out.',
      modelInvocationPhase: 'http_request',
      modelInvocationAttempt: 1,
    });
  });
});
