import { PassThrough } from 'node:stream';

import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { AdaptiveAgent } from './adaptive-agent.js';
import { InMemoryEventStore } from './in-memory-event-store.js';
import { InMemoryPlanStore } from './in-memory-plan-store.js';
import { InMemoryRunStore } from './in-memory-run-store.js';
import { InMemorySnapshotStore } from './in-memory-snapshot-store.js';
import type { ModelAdapter, ModelRequest, ModelResponse, ToolDefinition } from './types.js';

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
    private readonly responses: ModelResponse[],
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

describe('AdaptiveAgent', () => {
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
});
