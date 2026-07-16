import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { AdaptiveAgent } from './adaptive-agent.js';
import { resolveContextRefs } from './context-ref-resolver.js';
import { InMemoryContinuationStore } from './in-memory-continuation-store.js';
import { InMemoryEventStore } from './in-memory-event-store.js';
import { InMemoryPlanStore } from './in-memory-plan-store.js';
import { InMemoryRunStore } from './in-memory-run-store.js';
import { InMemorySnapshotStore } from './in-memory-snapshot-store.js';
import { InMemoryToolExecutionStore } from './in-memory-tool-execution-store.js';
import { createReadFileTool } from './tools/read-file.js';
import { createWriteFileTool } from './tools/write-file.js';
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
    const { signal: _signal, onRetry: _onRetry, ...cloneableRequest } = request;
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

class AliasingSequenceModel extends SequenceModel {
  formatToolName(name: string): string {
    if (!name.startsWith('delegate.')) {
      return name;
    }

    return `delegate__${Buffer.from(name.slice('delegate.'.length), 'utf8').toString('hex')}`;
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

function createStrictSearchTool(onExecute?: (input: Record<string, unknown>) => void): ToolDefinition {
  return {
    name: 'web_search',
    description: 'Search the web.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      additionalProperties: false,
      properties: {
        query: { type: 'string' },
        purpose: { type: 'string' },
        maxResults: { type: 'number' },
      },
    },
    budgetGroup: 'web_research.search',
    execute: async (input) => {
      const objectInput = typeof input === 'object' && input !== null && !Array.isArray(input)
        ? input as Record<string, unknown>
        : {};
      onExecute?.(objectInput);
      return {
        query: typeof objectInput.query === 'string' ? objectInput.query : 'unknown',
        results: [{ title: 'stub', url: 'https://example.com', snippet: 'stub' }],
      };
    },
  };
}

function createBudgetedReadWebPageTool(onExecute?: () => void): ToolDefinition {
  return {
    name: 'read_web_page',
    description: 'Read a web page.',
    inputSchema: { type: 'object', additionalProperties: true },
    budgetGroup: 'web_research.read',
    execute: async (input) => {
      onExecute?.();
      return {
        url: typeof input === 'object' && input && 'url' in input ? input.url : 'https://example.com',
        title: 'stub',
        text: 'stub',
        bytesFetched: 4,
      };
    },
  };
}

describe('AdaptiveAgent', () => {
  it('persists sessionId for run-style root runs', async () => {
    const runStore = new InMemoryRunStore();
    const agent = new AdaptiveAgent({
      model: new SequenceModel([{ finishReason: 'stop', text: 'done' }]),
      tools: [],
      runStore,
      eventStore: new InMemoryEventStore(),
      snapshotStore: new InMemorySnapshotStore(),
    });

    const result = await agent.run({ sessionId: 'session-1', goal: 'Remember this session' });

    const storedRun = await runStore.getRun(result.runId);
    expect(storedRun).toMatchObject({
      id: result.runId,
      sessionId: 'session-1',
      status: 'succeeded',
    });
  });

  it('resolves run context refs into model-visible reserved context and audit events', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const source = await runStore.createRun({
      id: '11111111-1111-4111-8111-111111111111',
      goal: 'Research migration options',
      status: 'queued',
    });
    const completedSource = await runStore.updateRun(source.id, { status: 'succeeded', result: { finding: 'Use durable run refs' } }, source.version);
    const model = new SequenceModel([{ finishReason: 'stop', text: 'done' }]);
    const agent = new AdaptiveAgent({
      model,
      tools: [],
      runStore,
      eventStore,
      snapshotStore: new InMemorySnapshotStore(),
    });

    const result = await agent.run({ goal: 'Write final brief', contextRefs: [{ kind: 'run', id: source.id }] });

    const storedRun = await runStore.getRun(result.runId);
    expect(storedRun?.metadata?.contextRefs).toMatchObject({
      source: [{ kind: 'run', id: source.id }],
      resolution: {
        refs: [expect.objectContaining({
          kind: 'run',
          id: source.id,
          view: 'result',
          status: 'succeeded',
          sources: [expect.objectContaining({
            runId: source.id,
            sourceRunVersion: completedSource.version,
            sourceUpdatedAt: completedSource.updatedAt,
          })],
        })],
      },
    });
    expect(storedRun?.context?.__adaptiveAgent).toMatchObject({
      resolvedContextRefs: [
        expect.objectContaining({
          kind: 'run',
          id: source.id,
          sourceRunVersion: completedSource.version,
          sourceUpdatedAt: completedSource.updatedAt,
          sourceCompletedAt: completedSource.completedAt,
          result: { finding: 'Use durable run refs' },
        }),
      ],
    });
    expect(model.receivedRequests[0]?.messages.some((message) =>
      message.role === 'system' && typeof message.content === 'string' && message.content.includes('Referenced Runtime Context')
    )).toBe(true);
    const events = await eventStore.listByRun(result.runId);
    expect(events.some((event) => event.type === 'context.refs.resolved')).toBe(true);

    await runStore.updateRun(source.id, { result: { finding: 'A later source generation' } }, completedSource.version);
    const persistedConsumer = await runStore.getRun(result.runId);
    expect(persistedConsumer?.context?.__adaptiveAgent).toMatchObject({
      resolvedContextRefs: [expect.objectContaining({
        sourceRunVersion: completedSource.version,
        result: { finding: 'Use durable run refs' },
      })],
    });
  });

  it('resolves eligible session root runs and records omitted statuses in audit data', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const first = await runStore.createRun({ id: 'session-run-a', sessionId: 'session-ref-1', goal: 'First root', status: 'queued' });
    await runStore.updateRun(first.id, { status: 'succeeded', result: 'first' }, first.version);
    const parent = await runStore.createRun({ id: 'session-run-b', sessionId: 'session-ref-1', goal: 'Second root', status: 'queued' });
    await runStore.updateRun(parent.id, { status: 'succeeded', result: 'second' }, parent.version);
    const child = await runStore.createRun({
      id: 'session-run-child',
      sessionId: 'session-ref-1',
      rootRunId: parent.id,
      parentRunId: parent.id,
      parentStepId: 'step-1',
      delegateName: 'worker',
      delegationDepth: 1,
      goal: 'Child internal',
      status: 'queued',
    });
    await runStore.updateRun(child.id, { status: 'succeeded', result: 'child' }, child.version);
    await runStore.createRun({ id: 'session-run-c', sessionId: 'session-ref-1', goal: 'Failed root', status: 'failed' });
    await runStore.createRun({ id: 'session-run-d', sessionId: 'session-ref-1', goal: 'Cancelled root', status: 'cancelled' });
    const model = new SequenceModel([{ finishReason: 'stop', text: 'done' }]);
    const agent = new AdaptiveAgent({
      model,
      tools: [],
      runStore,
      eventStore,
      snapshotStore: new InMemorySnapshotStore(),
    });

    const result = await agent.run({ goal: 'Use session', contextRefs: [{ kind: 'session', id: 'session-ref-1' }] });

    const storedRun = await runStore.getRun(result.runId);
    const resolved = storedRun?.context?.__adaptiveAgent as {
      resolvedContextRefs?: Array<{ runs?: Array<{ runId: string }>; warnings?: string[] }>;
    } | undefined;
    expect(resolved?.resolvedContextRefs?.[0]?.runs?.map((run) => run.runId)).toEqual(['session-run-a', 'session-run-b']);
    expect(resolved?.resolvedContextRefs?.[0]?.warnings).toEqual(['omitted 1 failed run and 1 cancelled run']);
    expect(storedRun?.metadata?.contextRefs).toMatchObject({
      resolution: {
        refs: [{
          kind: 'session',
          id: 'session-ref-1',
          runCount: 2,
          bytes: expect.any(Number),
          truncated: true,
          warnings: ['omitted 1 failed run and 1 cancelled run'],
        }],
      },
    });
    const resolutionEvent = (await eventStore.listByRun(result.runId))
      .find((event) => event.type === 'context.refs.resolved');
    expect(resolutionEvent?.payload).toMatchObject({
      resolved: [{
        kind: 'session',
        id: 'session-ref-1',
        runCount: 2,
        bytes: expect.any(Number),
        truncated: true,
        warnings: ['omitted 1 failed run and 1 cancelled run'],
      }],
      totalBytes: expect.any(Number),
    });
  });

  it('filters session statuses before maxRuns and includes explicitly allowed failures', async () => {
    const runStore = new InMemoryRunStore();
    await runStore.createRun({ id: 'filter-a', sessionId: 'filter-session', goal: 'Failed first', status: 'failed' });
    await runStore.createRun({ id: 'filter-b', sessionId: 'filter-session', goal: 'Succeeded first', status: 'succeeded' });
    await runStore.createRun({ id: 'filter-c', sessionId: 'filter-session', goal: 'Failed second', status: 'failed' });
    await runStore.createRun({ id: 'filter-d', sessionId: 'filter-session', goal: 'Succeeded second', status: 'succeeded' });
    await runStore.createRun({ id: 'filter-e', sessionId: 'filter-session', goal: 'Succeeded third', status: 'succeeded' });

    const filtered = await resolveContextRefs({
      runStore,
      refs: [{ kind: 'session', id: 'filter-session', maxRuns: 2 }],
    });
    expect(filtered?.resolved[0]?.runs?.map((run) => run.runId)).toEqual(['filter-d', 'filter-e']);
    expect(filtered?.resolved[0]?.warnings).toEqual([
      'omitted 2 failed runs',
      'session contained 3 matching runs; included latest 2',
    ]);

    const earliest = await resolveContextRefs({
      runStore,
      refs: [{ kind: 'session', id: 'filter-session', selection: 'earliest', maxRuns: 2 }],
    });
    expect(earliest?.resolved[0]?.runs?.map((run) => run.runId)).toEqual(['filter-b', 'filter-d']);
    expect(earliest?.resolved[0]?.warnings).toEqual([
      'omitted 2 failed runs',
      'session contained 3 matching runs; included earliest 2',
    ]);

    const withFailures = await resolveContextRefs({
      runStore,
      refs: [{ kind: 'session', id: 'filter-session', allowStatuses: ['succeeded', 'failed'] }],
    });
    expect(withFailures?.resolved[0]?.runs?.map((run) => run.runId)).toEqual([
      'filter-a',
      'filter-b',
      'filter-c',
      'filter-d',
      'filter-e',
    ]);
    expect(withFailures?.resolved[0]?.warnings).toEqual([]);
  });

  it('pages large sessions and applies deterministic latest and earliest tie-breakers', async () => {
    const runStore = new InMemoryRunStore();
    const createdAt = '2026-07-10T12:00:00.000Z';
    for (let index = 0; index < 105; index += 1) {
      const id = `paged-${String(index).padStart(3, '0')}`;
      const run = await runStore.createRun({ id, sessionId: 'paged-session', goal: id, status: 'succeeded' });
      await runStore.updateRun(id, { createdAt }, run.version);
    }
    const listBySession = vi.spyOn(runStore, 'listBySession');

    const latest = await resolveContextRefs({
      runStore,
      refs: [{ kind: 'session', id: 'paged-session', maxRuns: 3 }],
    });
    expect(latest?.resolved[0]?.runs?.map((run) => run.runId)).toEqual(['paged-102', 'paged-103', 'paged-104']);
    expect(listBySession).toHaveBeenNthCalledWith(1, 'paged-session', { limit: 100, offset: 0, order: 'desc' });
    expect(listBySession).toHaveBeenNthCalledWith(2, 'paged-session', { limit: 100, offset: 100, order: 'desc' });

    listBySession.mockClear();
    const earliest = await resolveContextRefs({
      runStore,
      refs: [{ kind: 'session', id: 'paged-session', selection: 'earliest', maxRuns: 3 }],
    });
    expect(earliest?.resolved[0]?.runs?.map((run) => run.runId)).toEqual(['paged-000', 'paged-001', 'paged-002']);
    expect(listBySession).toHaveBeenNthCalledWith(1, 'paged-session', { limit: 100, offset: 0, order: 'asc' });
    expect(listBySession).toHaveBeenNthCalledWith(2, 'paged-session', { limit: 100, offset: 100, order: 'asc' });
  });

  it('bounds session scans and authorizes every candidate run before exposing it', async () => {
    const runStore = new InMemoryRunStore();
    await runStore.createRun({ id: 'auth-a', sessionId: 'auth-session', goal: 'Visible A', status: 'succeeded' });
    await runStore.createRun({ id: 'auth-b', sessionId: 'auth-session', goal: 'Secret B', status: 'succeeded' });
    await runStore.createRun({ id: 'auth-c', sessionId: 'auth-session', goal: 'Visible C', status: 'succeeded' });
    const authorizationTargets: Array<string | undefined> = [];

    const resolution = await resolveContextRefs({
      runStore,
      refs: [{ kind: 'session', id: 'auth-session', maxScanRuns: 2 }],
      authorizer: ({ targetRun }) => {
        authorizationTargets.push(targetRun?.id);
        return targetRun?.id !== 'auth-b';
      },
    });

    expect(authorizationTargets).toEqual([undefined, 'auth-c', 'auth-b']);
    expect(resolution?.resolved[0]?.runs?.map((run) => run.runId)).toEqual(['auth-c']);
    expect(resolution?.resolved[0]?.warnings).toEqual([
      'session scan exceeded 2 runs; selected from latest 2 runs',
      'omitted 1 unauthorized run',
    ]);
    expect(JSON.stringify(resolution)).not.toContain('Secret B');

    await expect(resolveContextRefs({
      runStore,
      refs: [{ kind: 'session', id: 'auth-session' }],
      authorizer: ({ targetRun }) => targetRun === undefined,
    })).rejects.toThrow('Context ref session auth-session has no authorized runs');
  });

  it('rejects a non-empty session when no runs match its allowed statuses', async () => {
    const runStore = new InMemoryRunStore();
    await runStore.createRun({ id: 'failed-session-run', sessionId: 'failed-session', goal: 'Failed work', status: 'failed' });
    const model = new SequenceModel([{ finishReason: 'stop', text: 'unused' }]);
    const agent = new AdaptiveAgent({
      model,
      tools: [],
      runStore,
      eventStore: new InMemoryEventStore(),
      snapshotStore: new InMemorySnapshotStore(),
    });

    await expect(agent.run({
      goal: 'Use failed session',
      contextRefs: [{ kind: 'session', id: 'failed-session' }],
    })).rejects.toThrow('Context ref session failed-session has no runs matching allowed statuses [succeeded]');
    expect(model.receivedRequests).toHaveLength(0);
  });

  it('rejects reserved context collisions and failed run refs before creating a run', async () => {
    const runStore = new InMemoryRunStore();
    const source = await runStore.createRun({ id: '22222222-2222-4222-8222-222222222222', goal: 'Failed source', status: 'failed' });
    const agent = new AdaptiveAgent({
      model: new SequenceModel([{ finishReason: 'stop', text: 'done' }]),
      tools: [],
      runStore,
      eventStore: new InMemoryEventStore(),
      snapshotStore: new InMemorySnapshotStore(),
    });

    await expect(agent.run({ goal: 'bad context', context: { __adaptiveAgent: {} } })).rejects.toThrow('reserved');
    await expect(agent.run({ goal: 'bad ref', contextRefs: [{ kind: 'run', id: source.id }] })).rejects.toThrow('allowed statuses');
    const getRun = vi.spyOn(runStore, 'getRun');
    getRun.mockClear();
    await expect(resolveContextRefs({
      runStore,
      refs: [{ kind: 'run', id: 'c453e5947-6e7e-4cde-a488-cb133288e29c' }],
    })).rejects.toThrow('must be a valid UUID');
    expect(getRun).not.toHaveBeenCalled();
    await expect(resolveContextRefs({
      runStore,
      refs: [{ kind: 'run', id: '33333333-3333-4333-8333-333333333333' }],
    })).rejects.toThrow('Context ref run 33333333-3333-4333-8333-333333333333 is unavailable');
    await expect(resolveContextRefs({
      runStore,
      refs: [{ kind: 'run', id: source.id, allowStatuses: ['failed'] }],
      authorizer: () => false,
    })).rejects.toThrow(`Context ref run ${source.id} is unavailable`);
    expect((await runStore.listBySession('unused')).length).toBe(0);
  });

  it('rewrites file content parts to read_file instructions when native file input is unavailable', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'agent-file-policy-'));
    try {
      const filePath = join(tempDir, 'brief.docx');
      await writeFile(filePath, 'placeholder');
      const model = new SequenceModel([{ finishReason: 'stop', text: 'done' }], 'mesh');
      const agent = new AdaptiveAgent({
        model,
        tools: [createReadFileTool({ allowedRoot: tempDir })],
        runStore: new InMemoryRunStore(),
        eventStore: new InMemoryEventStore(),
        snapshotStore: new InMemorySnapshotStore(),
      });

      await agent.run({
        goal: 'Summarize the attachment.',
        contentParts: [{ type: 'file', file: { source: { kind: 'path', path: filePath }, name: 'brief.docx' } }],
      });

      const userMessage = model.receivedRequests[0]?.messages.find((message) => message.role === 'user');
      expect(Array.isArray(userMessage?.content)).toBe(true);
      const parts = userMessage?.content as Array<{ type: string; text?: string }>;
      expect(parts.some((part) => part.type === 'file')).toBe(false);
      expect(parts.at(-1)?.text).toContain('use the read_file tool');
      expect(parts.at(-1)?.text).toContain('Read each listed file at most once unless you need to re-check it.');
      expect(parts.at(-1)?.text).toContain(filePath);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves file content parts when provider_native policy is selected', async () => {
    const model = new SequenceModel([{ finishReason: 'stop', text: 'done' }], 'mesh');
    const agent = new AdaptiveAgent({
      model,
      tools: [createReadFileTool()],
      runStore: new InMemoryRunStore(),
      eventStore: new InMemoryEventStore(),
      snapshotStore: new InMemorySnapshotStore(),
      defaults: { fileInputPolicy: 'provider_native' },
    });

    await agent.run({
      goal: 'Summarize the attachment.',
      contentParts: [{ type: 'file', file: { source: { kind: 'path', path: '/tmp/brief.pdf' }, name: 'brief.pdf' } }],
    });

    const userMessage = model.receivedRequests[0]?.messages.find((message) => message.role === 'user');
    expect(Array.isArray(userMessage?.content)).toBe(true);
    expect((userMessage?.content as Array<{ type: string }>).some((part) => part.type === 'file')).toBe(true);
  });

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
      sessionId: 'chat-session-1',
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
    expect(storedRun).toMatchObject({
      goal: 'What is the capital of France?',
      sessionId: 'chat-session-1',
    });
  });

  it('keeps system messages in the provider-compatible prefix for chat-style runs', async () => {
    const model = new SequenceModel([{ finishReason: 'stop', text: 'done' }]);
    const agent = new AdaptiveAgent({
      model,
      tools: [],
      runStore: new InMemoryRunStore(),
      eventStore: new InMemoryEventStore(),
      snapshotStore: new InMemorySnapshotStore(),
    });

    const result = await agent.chat({
      messages: [
        { role: 'user', content: 'Remember this preference.' },
        { role: 'system', content: 'Reply tersely.' },
        { role: 'user', content: 'Say done.' },
      ],
    });

    expect(result.status).toBe('success');
    const requestMessages = model.receivedRequests[0]?.messages ?? [];
    const firstNonSystemIndex = requestMessages.findIndex((message) => message.role !== 'system');
    expect(firstNonSystemIndex).toBeGreaterThan(0);
    expect(requestMessages.slice(firstNonSystemIndex).some((message) => message.role === 'system')).toBe(false);
    expect(requestMessages[firstNonSystemIndex - 1]).toMatchObject({
      role: 'system',
      content: 'Reply tersely.',
    });
  });

  it('adds run image inputs to the initial user model message without embedding bytes', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const model = new SequenceModel([
      {
        finishReason: 'stop',
        text: 'The receipt total is $12.50.',
      },
    ]);

    const agent = new AdaptiveAgent({
      model,
      tools: [],
      runStore,
      eventStore,
      snapshotStore,
    });

    const result = await agent.run({
      goal: 'Read the receipt total.',
      images: [{ path: '/tmp/receipt.png', detail: 'high' }],
    });

    expect(result.status).toBe('success');
    const userMessage = model.receivedRequests[0].messages.at(-1);
    expect(userMessage?.content).toEqual([
      {
        type: 'text',
        text: expect.stringContaining('Read the receipt total.'),
      },
      {
        type: 'image',
        image: { path: '/tmp/receipt.png', detail: 'high' },
      },
    ]);
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
    expect(messages[1]?.content).not.toContain('"inputSchema"');
    expect(messages[2]).toMatchObject({
      role: 'user',
      content: expect.stringContaining('Inspect runtime manifest'),
    });
  });

  it('filters model-visible tools from RunRequest allowedTools and forbiddenTools', async () => {
    const runStore = new InMemoryRunStore();
    const model = new SequenceModel([
      {
        finishReason: 'stop',
        text: 'Done.',
      },
    ]);
    const forbiddenTool: ToolDefinition = {
      name: 'forbidden_lookup',
      description: 'Should not be visible.',
      inputSchema: { type: 'object', additionalProperties: true },
      execute: async () => ({ ok: true }),
    };

    const agent = new AdaptiveAgent({
      model,
      tools: [createLookupTool(), forbiddenTool],
      runStore,
    });

    const result = await agent.run({
      goal: 'Use only lookup',
      allowedTools: ['lookup', 'forbidden_lookup'],
      forbiddenTools: ['forbidden_lookup'],
    });
    expect(result.status).toBe('success');

    expect(model.receivedRequests[0].tools?.map((tool) => tool.name)).toEqual(['lookup']);
    expect(model.receivedRequests[0].messages[1]?.content).toContain('"name": "lookup"');
    expect(model.receivedRequests[0].messages[1]?.content).not.toContain('forbidden_lookup');
  });

  it('continues a failed run from durable partial progress with a linked audit record', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const continuationStore = new InMemoryContinuationStore();
    const model = new SequenceModel([
      {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'lookup-1',
            name: 'lookup',
            input: { topic: 'continuation' },
          },
        ],
      },
      new Error('HTTP 524 provider timeout'),
      {
        finishReason: 'stop',
        text: 'Recovered from the prior lookup result.',
      },
    ]);

    const agent = new AdaptiveAgent({
      model,
      tools: [createLookupTool()],
      runStore,
      eventStore,
      snapshotStore,
      continuationStore,
      recovery: {
        continuation: {
          enabled: true,
          defaultStrategy: 'hybrid_snapshot_then_step',
        },
      },
    });

    const failedResult = await agent.run({ sessionId: 'session-continuation-1', goal: 'Research continuation recovery' });
    expect(failedResult).toMatchObject({
      status: 'failure',
      code: 'MODEL_ERROR',
      stepsUsed: 1,
    });

    const recovery = await agent.getRecoveryOptions(failedResult.runId);
    expect(recovery).toMatchObject({
      continuable: true,
      decision: 'continue_new_run',
      failureClass: 'provider_transient',
      lastCompletedStepId: 'step-1',
      nextStepId: 'step-2',
    });

    const plan = await agent.getRecoveryPlan(failedResult.runId);
    expect(plan).toMatchObject({
      runId: failedResult.runId,
      status: 'failed',
      action: 'retry_same_run',
      executable: true,
      retryability: {
        retryable: true,
        failureKind: 'timeout',
      },
    });

    const continuedResult = await agent.continueRun({ fromRunId: failedResult.runId });
    expect(continuedResult).toMatchObject({
      status: 'success',
      output: 'Recovered from the prior lookup result.',
      stepsUsed: 2,
    });
    expect(continuedResult.runId).not.toBe(failedResult.runId);

    const sourceRun = await runStore.getRun(failedResult.runId);
    const continuationRun = await runStore.getRun(continuedResult.runId);
    const continuations = await continuationStore.listBySourceRun(failedResult.runId);
    const continuationEvents = await eventStore.listByRun(continuedResult.runId);
    const continuationRequest = model.receivedRequests.at(-1);

    expect(sourceRun).toMatchObject({ status: 'failed', sessionId: 'session-continuation-1' });
    expect(continuationRun).toMatchObject({
      sessionId: 'session-continuation-1',
      status: 'succeeded',
      metadata: expect.objectContaining({
        continuationOfRunId: failedResult.runId,
        continuationStrategy: 'hybrid_snapshot_then_step',
        continuationLastCompletedStepId: 'step-1',
        continuationNextStepId: 'step-2',
      }),
    });
    expect(continuations).toHaveLength(1);
    expect(continuations[0]).toMatchObject({
      sourceRunId: failedResult.runId,
      continuationRunId: continuedResult.runId,
      strategy: 'hybrid_snapshot_then_step',
      failureClass: 'provider_transient',
      sourceStepId: 'step-1',
      nextStepId: 'step-2',
    });
    expect(continuationEvents.some((event) => event.type === 'run.continuation_created')).toBe(true);
    expect(continuationRequest?.messages.at(-1)?.content).toContain('Continue the previous failed run');
    expect(continuationRequest?.messages.at(-1)?.content).toContain('"lastCompletedStepId": "step-1"');
    expect(continuationRequest?.messages.at(-1)?.content).toContain('"nextStepId": "step-2"');
  });

  it('feeds capped model-visible tool output back to the model while preserving raw tool output', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const toolExecutionStore = new InMemoryToolExecutionStore();
    const rawContent = 'x'.repeat(1_000);
    const compactTool: ToolDefinition = {
      name: 'compact_lookup',
      description: 'Returns a large result.',
      inputSchema: { type: 'object', additionalProperties: true },
      maxModelResultBytes: 220,
      execute: async () => ({
        content: rawContent,
        rawOnly: 'keep-this-out-of-model-history',
      }),
      formatResultForModel: (output) => ({
        content: typeof output === 'object' && output !== null && 'content' in output ? output.content : '',
        modelOnly: true,
      }),
    };
    const model = new SequenceModel([
      {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'compact-call-1',
            name: 'compact_lookup',
            input: {},
          },
        ],
      },
      {
        finishReason: 'stop',
        text: 'Done with compact output.',
      },
    ]);

    const agent = new AdaptiveAgent({
      model,
      tools: [compactTool],
      runStore,
      eventStore,
      snapshotStore,
      toolExecutionStore,
    });

    const result = await agent.run({ goal: 'Use the compact lookup' });
    expect(result.status).toBe('success');

    const toolMessage = model.receivedRequests[1].messages.find((message) => message.role === 'tool');
    expect(toolMessage?.content).not.toContain('keep-this-out-of-model-history');
    const modelOutput = JSON.parse(toolMessage?.content as string);
    expect(modelOutput).toMatchObject({
      modelOnly: true,
      truncated: true,
    });
    expect(Buffer.byteLength(toolMessage?.content as string, 'utf8')).toBeLessThanOrEqual(260);

    const execution = await toolExecutionStore.getByIdempotencyKey(`${result.runId}:step-1:compact-call-1`);
    expect(execution?.output).toMatchObject({
      content: rawContent,
      rawOnly: 'keep-this-out-of-model-history',
    });
  });

  it('aborts the tool signal when a tool timeout fires', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    let aborted = false;
    let contextTimeoutMs: number | undefined;
    const hangingTool: ToolDefinition = {
      name: 'hang',
      description: 'Waits forever unless aborted.',
      inputSchema: { type: 'object', additionalProperties: true },
      timeoutMs: 10,
      execute: async (_input, context) =>
        new Promise((resolve) => {
          contextTimeoutMs = context.timeoutMs;
          context.signal.addEventListener('abort', () => {
            aborted = true;
          });
        }),
    };
    const model = new SequenceModel([
      {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'hang-call-1',
            name: 'hang',
            input: {},
          },
        ],
      },
    ]);

    const agent = new AdaptiveAgent({
      model,
      tools: [hangingTool],
      runStore,
      eventStore,
      snapshotStore,
    });

    const result = await agent.run({ goal: 'Trigger timeout cancellation' });
    expect(result).toMatchObject({
      status: 'failure',
      code: 'TOOL_ERROR',
      error: 'Timed out after 10ms',
    });
    expect(contextTimeoutMs).toBe(10);
    expect(aborted).toBe(true);
  });

  it('blocks continuation when a tool call has no durable completion', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const continuationStore = new InMemoryContinuationStore();
    const model = new SequenceModel([]);
    const createdRun = await runStore.createRun({
      goal: 'Do an unsafe side effect',
      status: 'failed',
    });
    const failedRun = await runStore.updateRun(createdRun.id, {
      errorCode: 'TOOL_ERROR',
      errorMessage: 'process crashed during tool execution',
    });
    await snapshotStore.save({
      runId: failedRun.id,
      snapshotSeq: 1,
      status: 'running',
      currentStepId: 'step-1',
      summary: { stepsUsed: 0 },
      state: {
        schemaVersion: 1,
        messages: [],
        stepsUsed: 0,
      },
    });
    await eventStore.append({
      runId: failedRun.id,
      stepId: 'step-1',
      toolCallId: 'unsafe-1',
      type: 'tool.started',
      schemaVersion: 1,
      payload: { toolName: 'unsafe_write' },
    });

    const agent = new AdaptiveAgent({
      model,
      tools: [],
      runStore,
      eventStore,
      snapshotStore,
      continuationStore,
    });

    const recovery = await agent.getRecoveryOptions(failedRun.id);
    expect(recovery).toMatchObject({
      continuable: false,
      decision: 'requires_reconciliation',
      failureClass: 'tool_uncertain',
      requiresReconciliation: true,
    });
    await expect(agent.createContinuationRun({ fromRunId: failedRun.id })).rejects.toThrow(
      'started but no durable tool completion was recorded',
    );
  });

  it('uses provider-facing delegate names in the runtime tool manifest when the adapter rewrites them', async () => {
    const runStore = new InMemoryRunStore();
    const model = new AliasingSequenceModel([
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

    const result = await agent.run({ goal: 'Inspect aliased runtime manifest' });
    expect(result.status).toBe('success');

    const messages = model.receivedRequests[0]?.messages ?? [];
    expect(messages[1]?.content).toContain('"name": "lookup"');
    expect(messages[1]?.content).toContain('"name": "delegate__72657365617263686572"');
    expect(messages[1]?.content).not.toContain('"name": "delegate.researcher"');
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

  it('allows repeated retries for timeout and Cloudflare 524 model failures', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const model = new SequenceModel([
      new Error('Model timed out after 90000ms'),
      new Error('OpenRouter API returned 524: cloudflare timeout'),
      {
        finishReason: 'stop',
        text: 'Recovered after repeated retries.',
      },
    ]);

    const agent = new AdaptiveAgent({
      model,
      tools: [],
      runStore,
      eventStore,
      snapshotStore,
    });

    const failed = await agent.run({ goal: 'Retry until the model recovers' });
    expect(failed).toMatchObject({
      status: 'failure',
      code: 'MODEL_ERROR',
      error: 'Model timed out after 90000ms',
    });

    const failedAgain = await agent.retry(failed.runId);
    expect(failedAgain).toMatchObject({
      status: 'failure',
      code: 'MODEL_ERROR',
      error: 'OpenRouter API returned 524: cloudflare timeout',
    });

    const retried = await agent.retry(failed.runId);
    expect(retried).toMatchObject({
      status: 'success',
      runId: failed.runId,
      output: 'Recovered after repeated retries.',
      stepsUsed: 1,
    });

    const storedRun = await runStore.getRun(failed.runId);
    expect(storedRun?.metadata).toMatchObject({
      retryAttempts: 2,
      lastRetryFailureKind: 'timeout',
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

  it('accepts string-valued delegate tool arguments as the delegate goal', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const model = new SequenceModel([
      {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'delegate-call-1',
            name: 'delegate.researcher',
            input: 'Research delegation',
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
    });

    const result = await agent.run({ goal: 'Delegate this research task' });
    const childRuns = await runStore.listChildren(result.runId);

    expect(result).toMatchObject({
      status: 'success',
      output: { report: 'delegation complete' },
    });
    expect(childRuns).toHaveLength(1);
    expect(childRuns[0]).toMatchObject({
      delegateName: 'researcher',
      goal: 'Research delegation',
    });
  });

  it('envelopes string-valued delegate results for parent model messages', async () => {
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
            input: { goal: 'Research plain text output' },
          },
        ],
      },
      {
        finishReason: 'stop',
        text: 'plain child report',
      },
      {
        finishReason: 'stop',
        structuredOutput: { report: 'done' },
      },
    ]);
    const agent = new AdaptiveAgent({
      model,
      tools: [],
      delegates: [
        {
          name: 'researcher',
          description: 'Researches a topic.',
          allowedTools: [],
        },
      ],
      runStore,
      eventStore,
      snapshotStore,
    });

    const result = await agent.run({ goal: 'Delegate and continue' });

    expect(result).toMatchObject({ status: 'success', output: { report: 'done' } });
    const childRuns = await runStore.listChildren(result.runId);
    expect(childRuns[0]?.result).toBe('plain child report');

    const toolMessage = model.receivedRequests[2]?.messages.find((message) => message.role === 'tool');
    expect(JSON.parse(toolMessage?.content as string)).toEqual({
      result: 'plain child report',
      resultType: 'text',
    });
  });

  it('preserves object-shaped delegate results for parent model messages', async () => {
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
            input: { goal: 'Research object output' },
          },
        ],
      },
      {
        finishReason: 'stop',
        structuredOutput: { finding: 'child-done' },
      },
      {
        finishReason: 'stop',
        structuredOutput: { report: 'done' },
      },
    ]);
    const agent = new AdaptiveAgent({
      model,
      tools: [],
      delegates: [
        {
          name: 'researcher',
          description: 'Researches a topic.',
          allowedTools: [],
        },
      ],
      runStore,
      eventStore,
      snapshotStore,
    });

    const result = await agent.run({ goal: 'Delegate and continue' });

    expect(result).toMatchObject({ status: 'success', output: { report: 'done' } });
    const toolMessage = model.receivedRequests[2]?.messages.find((message) => message.role === 'tool');
    expect(JSON.parse(toolMessage?.content as string)).toEqual({ finding: 'child-done' });
  });

  it('rejects delegate input with string outputSchema before spawning a child run', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const model = new SequenceModel([
      {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'bad-delegate-call',
            name: 'delegate.researcher',
            input: {
              goal: 'Research malformed schema',
              outputSchema: '{"type":"object"}',
            },
          },
        ],
      },
      {
        finishReason: 'stop',
        structuredOutput: { report: 'repaired without delegation' },
      },
    ]);
    const agent = new AdaptiveAgent({
      model,
      tools: [],
      delegates: [
        {
          name: 'researcher',
          description: 'Researches a topic.',
          allowedTools: [],
        },
      ],
      runStore,
      eventStore,
      snapshotStore,
    });

    const result = await agent.run({ goal: 'Reject malformed delegate schema' });

    expect(result).toMatchObject({ status: 'success', output: { report: 'repaired without delegation' } });
    expect(await runStore.listChildren(result.runId)).toHaveLength(0);

    const events = await eventStore.listByRun(result.runId);
    expect(events.find((event) => event.type === 'model.tool_call_rejected')?.payload).toMatchObject({
      requestedToolName: 'delegate.researcher',
      reason: 'invalid_tool_input',
      willRetry: true,
      error: expect.stringContaining('input.outputSchema must be a JSON object'),
    });
    expect(events.some((event) => event.type === 'delegate.spawned')).toBe(false);
  });

  it.each([
    ['context', { context: '{"topic":"delegation"}' }, 'input.context'],
    ['metadata', { metadata: '{"source":"model"}' }, 'input.metadata'],
  ] as const)('rejects delegate input with string %s before spawning a child run', async (_field, malformedFields, expectedPath) => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const model = new SequenceModel([
      {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'bad-delegate-call',
            name: 'delegate.researcher',
            input: {
              goal: 'Research malformed delegate object',
              ...malformedFields,
            },
          },
        ],
      },
      {
        finishReason: 'stop',
        structuredOutput: { report: 'repaired without delegation' },
      },
    ]);
    const agent = new AdaptiveAgent({
      model,
      tools: [],
      delegates: [
        {
          name: 'researcher',
          description: 'Researches a topic.',
          allowedTools: [],
        },
      ],
      runStore,
      eventStore,
      snapshotStore,
    });

    const result = await agent.run({ goal: 'Reject malformed delegate objects' });

    expect(result.status).toBe('success');
    expect(await runStore.listChildren(result.runId)).toHaveLength(0);
    const rejection = (await eventStore.listByRun(result.runId)).find(
      (event) => event.type === 'model.tool_call_rejected',
    );
    expect(rejection?.payload).toMatchObject({
      requestedToolName: 'delegate.researcher',
      reason: 'invalid_tool_input',
      error: expect.stringContaining(`${expectedPath} must be a JSON object`),
    });
  });

  it('normalizes fenced JSON text for outputSchema before repair', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const outputSchema = {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
    };
    const model = new SequenceModel([
      {
        finishReason: 'stop',
        text: '```json\n{"answer":"done"}\n```',
      },
    ]);
    const agent = new AdaptiveAgent({
      model,
      tools: [],
      runStore,
      eventStore,
      snapshotStore,
    });

    const result = await agent.run({ goal: 'Return fenced structured output', outputSchema });

    expect(result).toMatchObject({ status: 'success', output: { answer: 'done' } });
    expect(model.receivedRequests).toHaveLength(1);
  });

  it('normalizes prose-wrapped JSON object text for outputSchema before repair', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const outputSchema = {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
    };
    const model = new SequenceModel([
      {
        finishReason: 'stop',
        text: 'Here is the answer:\n{\n  "answer": "done"\n}\nThanks.',
      },
    ]);
    const agent = new AdaptiveAgent({
      model,
      tools: [],
      runStore,
      eventStore,
      snapshotStore,
    });

    const result = await agent.run({ goal: 'Return prose-wrapped structured output', outputSchema });

    expect(result).toMatchObject({ status: 'success', output: { answer: 'done' } });
    expect(model.receivedRequests).toHaveLength(1);
  });

  it('unwraps single-object JSON arrays for outputSchema before repair', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const outputSchema = {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
    };
    const model = new SequenceModel([
      {
        finishReason: 'stop',
        text: '[\n  { "answer": "done" }\n]',
      },
    ]);
    const agent = new AdaptiveAgent({
      model,
      tools: [],
      runStore,
      eventStore,
      snapshotStore,
    });

    const result = await agent.run({ goal: 'Return array-wrapped structured output', outputSchema });

    expect(result).toMatchObject({ status: 'success', output: { answer: 'done' } });
    expect(model.receivedRequests).toHaveLength(1);
  });

  it('normalizes provider structuredOutput strings for outputSchema before repair', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const outputSchema = {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
    };
    const model = new SequenceModel([
      {
        finishReason: 'stop',
        structuredOutput: '```json\n{"answer":"done"}\n```',
      },
    ]);
    const agent = new AdaptiveAgent({
      model,
      tools: [],
      runStore,
      eventStore,
      snapshotStore,
    });

    const result = await agent.run({ goal: 'Return string structured output', outputSchema });

    expect(result).toMatchObject({ status: 'success', output: { answer: 'done' } });
    expect(model.receivedRequests).toHaveLength(1);
  });

  it('records capped diagnostics when outputSchema fails with no visible model output', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const outputSchema = {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
    };
    const model = new SequenceModel([
      {
        finishReason: 'stop',
        reasoning: 'internal-only reasoning',
        providerResponseId: 'provider-response-1',
      },
    ]);
    const agent = new AdaptiveAgent({
      model,
      tools: [],
      runStore,
      eventStore,
      snapshotStore,
    });

    const result = await agent.run({ goal: 'Return structured output', outputSchema });

    expect(result).toMatchObject({
      status: 'failure',
      code: 'MODEL_ERROR',
      error: expect.stringContaining('outputSchema'),
    });
    const failedEvent = (await eventStore.listByRun(result.runId)).find((event) => event.type === 'run.failed');
    expect(failedEvent?.payload).toMatchObject({
      code: 'MODEL_ERROR',
      diagnostics: {
        kind: 'output_schema_noncompliance',
        parseFailureReason: 'no_visible_text_or_structured_output',
        finishReason: 'stop',
        providerResponseId: 'provider-response-1',
        toolCallCount: 0,
        visibleTextBytes: 0,
        structuredOutputBytes: 0,
        reasoningBytes: 23,
        repairAttempted: false,
      },
    });
    expect(JSON.stringify(failedEvent?.payload)).not.toContain('internal-only reasoning');
  });

  it('repairs a child run with outputSchema when the child model returns only text', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const outputSchema = {
      type: 'object',
      properties: { finding: { type: 'string' } },
      required: ['finding'],
    };
    const model = new SequenceModel([
      {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'parent-call-1',
            name: 'delegate.researcher',
            input: {
              goal: 'Research with required structure',
              outputSchema,
            },
          },
        ],
      },
      {
        finishReason: 'stop',
        text: 'plain child report',
      },
      {
        finishReason: 'stop',
        structuredOutput: { finding: 'repaired from plain child report' },
      },
      {
        finishReason: 'stop',
        structuredOutput: { report: 'parent completed' },
      },
    ]);
    const agent = new AdaptiveAgent({
      model,
      tools: [],
      delegates: [
        {
          name: 'researcher',
          description: 'Researches a topic.',
          allowedTools: [],
        },
      ],
      runStore,
      eventStore,
      snapshotStore,
    });

    const result = await agent.run({ goal: 'Delegate with structured result' });

    expect(result).toMatchObject({ status: 'success', output: { report: 'parent completed' } });
    expect(model.receivedRequests[1]?.outputSchema).toMatchObject({ type: 'object' });
    expect(model.receivedRequests[2]).toMatchObject({
      tools: [],
      outputSchema,
    });
    expect(model.receivedRequests[2]?.messages.at(-1)?.content).toContain('plain child report');
    const parentToolMessage = model.receivedRequests[3]?.messages.find((message) => message.role === 'tool');
    expect(JSON.parse(parentToolMessage?.content as string)).toEqual({ finding: 'repaired from plain child report' });

    const childRuns = await runStore.listChildren(result.runId);
    expect(childRuns[0]).toMatchObject({
      status: 'succeeded',
      result: { finding: 'repaired from plain child report' },
    });
  });

  it('fails a child run with outputSchema when text repair does not return an object', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const outputSchema = {
      type: 'object',
      properties: { finding: { type: 'string' } },
      required: ['finding'],
    };
    const model = new SequenceModel([
      {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'parent-call-1',
            name: 'delegate.researcher',
            input: {
              goal: 'Research with required structure',
              outputSchema,
            },
          },
        ],
      },
      {
        finishReason: 'stop',
        text: 'plain child report',
      },
      {
        finishReason: 'stop',
        text: 'still not JSON',
      },
    ]);
    const agent = new AdaptiveAgent({
      model,
      tools: [],
      delegates: [
        {
          name: 'researcher',
          description: 'Researches a topic.',
          allowedTools: [],
        },
      ],
      runStore,
      eventStore,
      snapshotStore,
    });

    const result = await agent.run({ goal: 'Delegate with unrepaired structured result' });

    expect(result).toMatchObject({
      status: 'failure',
      code: 'MODEL_ERROR',
      error: expect.stringContaining('outputSchema'),
    });
    expect(model.receivedRequests[2]).toMatchObject({ tools: [], outputSchema });

    const childRuns = await runStore.listChildren(result.runId);
    expect(childRuns[0]).toMatchObject({
      status: 'failed',
      errorCode: 'MODEL_ERROR',
      errorMessage: expect.stringContaining('outputSchema'),
    });
  });

  it('corrects a misspelled delegate tool name returned by the model when there is a unique close delegate match', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const model = new SequenceModel([
      {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'delegate-call-1',
            name: 'delegate.researecher',
            input: {
              goal: 'Research typo recovery',
              input: { topic: 'delegation typo' },
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
            input: { topic: 'delegation typo' },
          },
        ],
      },
      {
        finishReason: 'stop',
        structuredOutput: {
          finding: 'child finished',
        },
      },
      {
        finishReason: 'stop',
        structuredOutput: {
          report: 'parent finished',
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
    });

    const result = await agent.run({ goal: 'Recover delegate typo' });
    const childRuns = await runStore.listChildren(result.runId);

    expect(result).toMatchObject({
      status: 'success',
      output: { report: 'parent finished' },
    });
    expect(childRuns).toHaveLength(1);
    expect(childRuns[0]).toMatchObject({
      delegateName: 'researcher',
      status: 'succeeded',
      result: { finding: 'child finished' },
    });

    const parentEvents = await eventStore.listByRun(result.runId);
    expect(
      parentEvents.some((event) => {
        if (event.type !== 'delegate.spawned' || typeof event.payload !== 'object' || event.payload === null) {
          return false;
        }

        return (event.payload as { toolName?: unknown }).toolName === 'delegate.researcher';
      }),
    ).toBe(true);
  });

  it('corrects a repeated-prefix delegate tool name returned by the model when there is a unique match', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const model = new SequenceModel([
      {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'delegate-call-1',
            name: 'delegate.researesearcher',
            input: {
              goal: 'Research repeated prefix typo recovery',
              input: { topic: 'delegation stutter typo' },
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
            input: { topic: 'delegation stutter typo' },
          },
        ],
      },
      {
        finishReason: 'stop',
        structuredOutput: {
          finding: 'child finished',
        },
      },
      {
        finishReason: 'stop',
        structuredOutput: {
          report: 'parent finished',
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
    });

    const result = await agent.run({ goal: 'Recover repeated prefix delegate typo' });
    const childRuns = await runStore.listChildren(result.runId);

    expect(result).toMatchObject({
      status: 'success',
      output: { report: 'parent finished' },
    });
    expect(childRuns).toHaveLength(1);
    expect(childRuns[0]).toMatchObject({
      delegateName: 'researcher',
      status: 'succeeded',
      result: { finding: 'child finished' },
    });

    const parentEvents = await eventStore.listByRun(result.runId);
    expect(
      parentEvents.some((event) => {
        if (event.type !== 'delegate.spawned' || typeof event.payload !== 'object' || event.payload === null) {
          return false;
        }

        return (event.payload as { toolName?: unknown }).toolName === 'delegate.researcher';
      }),
    ).toBe(true);
  });

  it('reprompts once when the model requests an unknown tool before execution', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const model = new SequenceModel([
      {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'bad-delegate-call',
            name: 'delegate.resistelher',
            input: {
              goal: 'Research with typo',
            },
          },
        ],
      },
      {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'delegate-call-1',
            name: 'delegate.researcher',
            input: {
              goal: 'Research after repair',
            },
          },
        ],
      },
      {
        finishReason: 'stop',
        structuredOutput: {
          finding: 'child recovered',
        },
      },
      {
        finishReason: 'stop',
        structuredOutput: {
          report: 'parent recovered',
        },
      },
    ]);
    const agent = new AdaptiveAgent({
      model,
      tools: [],
      delegates: [
        {
          name: 'researcher',
          description: 'Researches a topic.',
          allowedTools: [],
        },
      ],
      runStore,
      eventStore,
      snapshotStore,
    });

    const result = await agent.run({ goal: 'Recover unknown delegate name' });

    expect(result).toMatchObject({
      status: 'success',
      output: { report: 'parent recovered' },
    });
    expect(model.receivedRequests).toHaveLength(4);
    expect(
      model.receivedRequests[1]?.messages.some(
        (message) =>
          message.role === 'system' &&
          typeof message.content === 'string' &&
          message.content.includes('previous model response requested unavailable tool "delegate.resistelher"'),
      ),
    ).toBe(true);

    const events = await eventStore.listByRun(result.runId);
    const rejectionEvent = events.find((event) => event.type === 'model.tool_call_rejected');
    expect(rejectionEvent).toMatchObject({
      toolCallId: 'bad-delegate-call',
      payload: expect.objectContaining({
        requestedToolName: 'delegate.resistelher',
        reason: 'unknown_tool',
        repairAttempt: 1,
        retryLimit: 1,
        willRetry: true,
      }),
    });
    expect(
      events.some((event) => event.type === 'tool.started' && event.toolCallId === 'bad-delegate-call'),
    ).toBe(false);
  });

  it('fails with TOOL_ERROR after the invalid tool-call repair attempt is exhausted', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const model = new SequenceModel([
      {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'bad-delegate-call-1',
            name: 'delegate.resistelher',
            input: {
              goal: 'Research with typo',
            },
          },
        ],
      },
      {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'bad-delegate-call-2',
            name: 'delegate.resistelher',
            input: {
              goal: 'Research with typo again',
            },
          },
        ],
      },
    ]);
    const agent = new AdaptiveAgent({
      model,
      tools: [],
      delegates: [
        {
          name: 'researcher',
          description: 'Researches a topic.',
          allowedTools: [],
        },
      ],
      runStore,
      eventStore,
      snapshotStore,
    });

    const result = await agent.run({ goal: 'Fail after invalid tool repair is exhausted' });

    expect(result).toMatchObject({
      status: 'failure',
      code: 'TOOL_ERROR',
      error: 'Unknown tool delegate.resistelher after 1 invalid tool-call repair attempt',
      stepsUsed: 0,
    });

    const events = (await eventStore.listByRun(result.runId)).filter((event) => event.type === 'model.tool_call_rejected');
    expect(events).toHaveLength(2);
    expect(events[0].payload).toMatchObject({ requestedToolName: 'delegate.resistelher', willRetry: true });
    expect(events[1].payload).toMatchObject({ requestedToolName: 'delegate.resistelher', willRetry: false });

    const latestSnapshot = await snapshotStore.getLatest(result.runId);
    expect(latestSnapshot?.state).toMatchObject({
      pendingToolCall: {
        name: 'delegate.resistelher',
      },
      invalidToolCallRepairAttempts: {
        'step-1': 1,
      },
    });
  });

  it('parses double-serialized delegate object input before spawning the child run', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const model = new SequenceModel([
      {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'delegate-call',
            name: 'delegate.researcher',
            input: JSON.stringify({
              goal: 'Research parsed delegate object',
              context: { source: 'model-json-string' },
            }),
          },
        ],
      },
      {
        finishReason: 'stop',
        structuredOutput: { finding: 'child-done' },
      },
      {
        finishReason: 'stop',
        structuredOutput: { report: 'done' },
      },
    ]);
    const agent = new AdaptiveAgent({
      model,
      tools: [],
      delegates: [
        {
          name: 'researcher',
          description: 'Researches a topic.',
          allowedTools: [],
        },
      ],
      runStore,
      eventStore,
      snapshotStore,
    });

    const result = await agent.run({ goal: 'Delegate double-serialized input' });

    expect(result).toMatchObject({ status: 'success', output: { report: 'done' } });
    const children = await runStore.listChildren(result.runId);
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      goal: 'Research parsed delegate object',
      context: { source: 'model-json-string' },
    });
  });

  it('repairs malformed normal tool input before executing write_file', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'adaptive-agent-write-repair-'));
    try {
      const runStore = new InMemoryRunStore();
      const eventStore = new InMemoryEventStore();
      const snapshotStore = new InMemorySnapshotStore();
      const model = new SequenceModel([
        {
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'bad-write-call',
              name: 'write_file',
              input: 'rubik.html',
            },
          ],
        },
        {
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'good-write-call',
              name: 'write_file',
              input: {
                path: 'rubik.html',
                content: '<script src="bundle.js"></script>',
              },
            },
          ],
        },
        {
          finishReason: 'stop',
          text: 'fixed',
        },
      ]);

      const agent = new AdaptiveAgent({
        model,
        tools: [createWriteFileTool({ allowedRoot: tempDir })],
        runStore,
        eventStore,
        snapshotStore,
        defaults: { autoApproveAll: true },
      });

      const result = await agent.run({ goal: 'Fix rubik html' });

      expect(result).toMatchObject({
        status: 'success',
        output: 'fixed',
      });
      await expect(readFile(join(tempDir, 'rubik.html'), 'utf-8')).resolves.toBe('<script src="bundle.js"></script>');

      const events = await eventStore.listByRun(result.runId);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'model.tool_call_rejected',
          toolCallId: 'bad-write-call',
          payload: expect.objectContaining({
            requestedToolName: 'write_file',
            reason: 'invalid_tool_input',
            willRetry: true,
          }),
        }),
      ]));
      expect(events.some((event) => event.type === 'tool.started' && event.toolCallId === 'bad-write-call')).toBe(false);
      expect(events.some((event) => event.type === 'tool.started' && event.toolCallId === 'good-write-call')).toBe(true);
      expect(
        model.receivedRequests[1]?.messages.some(
          (message) =>
            message.role === 'system' &&
            typeof message.content === 'string' &&
            message.content.includes('called tool "write_file" with invalid input'),
        ),
      ).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('normalizes schema-guided numeric string tool input before validation and execution', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    let executedInput: Record<string, unknown> | undefined;
    const model = new SequenceModel([
      {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'search-1',
            name: 'web_search',
            input: { query: 'first', purpose: 'find evidence', maxResults: '10' },
          },
        ],
      },
      {
        finishReason: 'stop',
        structuredOutput: { done: true },
      },
    ]);
    const agent = new AdaptiveAgent({
      model,
      tools: [createStrictSearchTool((input) => { executedInput = input; })],
      runStore,
      eventStore,
      snapshotStore,
    });

    const result = await agent.run({ goal: 'Search with numeric string' });

    expect(result).toMatchObject({ status: 'success', output: { done: true } });
    expect(executedInput?.maxResults).toBe(10);
    const events = await eventStore.listByRun(result.runId);
    expect(events.some((event) => event.type === 'model.tool_call_rejected')).toBe(false);
    expect(events.find((event) => event.type === 'tool.started')?.payload).toMatchObject({
      input: expect.objectContaining({
        preview: expect.objectContaining({ maxResults: 10 }),
      }),
    });
  });

  it('still rejects non-numeric strings for numeric tool schema fields', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const model = new SequenceModel([
      {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'search-1',
            name: 'web_search',
            input: { query: 'first', purpose: 'find evidence', maxResults: 'ten' },
          },
        ],
      },
      {
        finishReason: 'stop',
        structuredOutput: { done: true },
      },
    ]);
    const agent = new AdaptiveAgent({
      model,
      tools: [createStrictSearchTool()],
      runStore,
      eventStore,
      snapshotStore,
    });

    const result = await agent.run({ goal: 'Reject invalid numeric string' });

    expect(result).toMatchObject({ status: 'success', output: { done: true } });
    const rejection = (await eventStore.listByRun(result.runId)).find((event) => event.type === 'model.tool_call_rejected');
    expect(rejection?.payload).toMatchObject({
      requestedToolName: 'web_search',
      reason: 'invalid_tool_input',
      error: expect.stringContaining('web_search input.maxResults must be "number", not a string'),
    });
  });

  it('retries an existing pre-tool unknown-tool failure by clearing the invalid tool call and reprompting', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const createdRun = await runStore.createRun({
      goal: 'Historical failed run',
      modelProvider: 'test',
      modelName: 'sequence',
      status: 'running',
    });
    const failedRun = await runStore.updateRun(
      createdRun.id,
      {
        status: 'failed',
        currentStepId: 'step-1',
        errorCode: 'TOOL_ERROR',
        errorMessage: 'Unknown tool delegate.resistelher',
      },
      createdRun.version,
    );
    await eventStore.append({
      runId: failedRun.id,
      stepId: 'step-1',
      type: 'run.failed',
      schemaVersion: 1,
      payload: {
        error: 'Unknown tool delegate.resistelher',
        code: 'TOOL_ERROR',
      },
    });
    await snapshotStore.save({
      runId: failedRun.id,
      snapshotSeq: 1,
      status: 'failed',
      currentStepId: 'step-1',
      summary: null,
      state: {
        schemaVersion: 1,
        messages: [
          { role: 'system', content: 'You are AdaptiveAgent.' },
          { role: 'user', content: 'Do the task.' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'bad-delegate-call',
                name: 'delegate.resistelher',
                input: { goal: 'Research with typo' },
              },
            ],
          },
        ],
        stepsUsed: 0,
        pendingToolCalls: [
          {
            id: 'bad-delegate-call',
            name: 'delegate.resistelher',
            input: { goal: 'Research with typo' },
            stepId: 'step-1',
            needsStepStarted: false,
          },
        ],
        pendingToolCall: {
          id: 'bad-delegate-call',
          name: 'delegate.resistelher',
          input: { goal: 'Research with typo' },
          stepId: 'step-1',
          needsStepStarted: false,
        },
      },
    });
    const model = new SequenceModel([
      {
        finishReason: 'stop',
        structuredOutput: {
          report: 'retried from historical unknown tool',
        },
      },
    ]);
    const agent = new AdaptiveAgent({
      model,
      tools: [],
      delegates: [
        {
          name: 'researcher',
          description: 'Researches a topic.',
          allowedTools: [],
        },
      ],
      runStore,
      eventStore,
      snapshotStore,
    });

    const retried = await agent.retry(failedRun.id);

    expect(retried).toMatchObject({
      status: 'success',
      runId: failedRun.id,
      output: { report: 'retried from historical unknown tool' },
    });
    expect(model.receivedRequests[0]?.messages).not.toContainEqual(
      expect.objectContaining({
        role: 'assistant',
        toolCalls: expect.arrayContaining([
          expect.objectContaining({
            name: 'delegate.resistelher',
          }),
        ]),
      }),
    );
    expect(
      model.receivedRequests[0]?.messages.some(
        (message) =>
          message.role === 'system' &&
          typeof message.content === 'string' &&
          message.content.includes('previous model response requested unavailable tool "delegate.resistelher"'),
      ),
    ).toBe(true);

    const storedRun = await runStore.getRun(failedRun.id);
    expect(storedRun?.metadata).toMatchObject({
      retryAttempts: 1,
      lastRetryFailureKind: 'invalid_tool_call',
    });

    const events = await eventStore.listByRun(failedRun.id);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'run.retry_started',
        payload: expect.objectContaining({
          failureKind: 'invalid_tool_call',
          retryAttempts: 1,
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'model.tool_call_rejected',
        toolCallId: 'bad-delegate-call',
        payload: expect.objectContaining({
          requestedToolName: 'delegate.resistelher',
          trigger: 'terminal_retry',
          willRetry: true,
        }),
      }),
    );
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

  it('preserves assistant reasoning blocks across retry after a timeout', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const model = new SequenceModel([
      {
        finishReason: 'tool_calls',
        reasoning: 'Need to look this up before answering.',
        reasoningDetails: [
          {
            type: 'reasoning.text',
            text: 'Need to look this up before answering.',
            format: 'openai-responses-v1',
          },
        ],
        toolCalls: [
          {
            id: 'lookup-call-1',
            name: 'lookup',
            input: { topic: 'retry' },
          },
        ],
      },
      new Error('Model timed out after 90000ms'),
      {
        finishReason: 'stop',
        structuredOutput: {
          report: 'recovered after retry',
        },
      },
    ], 'openrouter');
    const agent = new AdaptiveAgent({
      model,
      tools: [createLookupTool()],
      runStore,
      eventStore,
      snapshotStore,
    });

    const failed = await agent.run({ goal: 'Use a tool and then recover from timeout' });
    expect(failed).toMatchObject({
      status: 'failure',
      code: 'MODEL_ERROR',
    });

    const retried = await agent.retry(failed.runId);
    expect(retried).toMatchObject({
      status: 'success',
      output: {
        report: 'recovered after retry',
      },
    });

    expect(model.receivedRequests).toHaveLength(3);

    const retryRequestMessages = model.receivedRequests[2]?.messages ?? [];
    const assistantMessage = retryRequestMessages.find((message) => message.role === 'assistant');
    expect(assistantMessage).toMatchObject({
      role: 'assistant',
      content: '',
      reasoning: 'Need to look this up before answering.',
      reasoningDetails: [
        {
          type: 'reasoning.text',
          text: 'Need to look this up before answering.',
          format: 'openai-responses-v1',
        },
      ],
      toolCalls: [
        {
          id: 'lookup-call-1',
          name: 'lookup',
          input: { topic: 'retry' },
        },
      ],
    });
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
    const parentEvents = await eventStore.listByRun(result.runId);
    expect(parentEvents.find((event) =>
      event.type === 'snapshot.created'
      && typeof event.payload === 'object'
      && event.payload !== null
      && !Array.isArray(event.payload)
      && event.payload.status === 'awaiting_subagent',
    )?.payload).toMatchObject({ snapshotSeq: 3 });
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
          rawProviderResponse: {
            id: 'chatcmpl_raw_123',
            object: 'chat.completion',
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: '{"report":"delegation complete"}',
                },
              },
            ],
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

    const result = await agent.run({ sessionId: 'session-delegation-1', goal: 'Write a delegation memo' });
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
    expect(modelRequestLog?.performance).toMatchObject({
      messageCount: expect.any(Number),
      requestBytes: expect.any(Number),
    });

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
    expect(lookupStartLog?.performance).toMatchObject({
      inputBytes: expect.any(Number),
      eventInputBytes: expect.any(Number),
    });

    const lookupCompletedLog = entries.find(
      (entry) => entry.event === 'tool.completed' && entry.toolName === 'lookup',
    );
    expect(lookupCompletedLog?.output).toMatchObject({
      finding: 'researched:delegation',
    });
    expect(lookupCompletedLog?.performance).toMatchObject({
      durationMs: expect.any(Number),
      rawOutputBytes: expect.any(Number),
      modelOutputBytes: expect.any(Number),
    });

    const modelResponseLog = entries.find(
      (entry) => entry.event === 'model.response' && entry.rawProviderResponse,
    );
    expect(modelResponseLog?.rawProviderResponse).toMatchObject({
      id: 'chatcmpl_raw_123',
      object: 'chat.completion',
    });

    const events = await eventStore.listByRun(result.runId);
    const modelStartedEvent = events.find((event) => event.type === 'model.started');
    expect(modelStartedEvent?.payload).toEqual(
      expect.objectContaining({
        performance: expect.objectContaining({
          requestBytes: expect.any(Number),
          eventPayloadBytes: expect.any(Number),
        }),
      }),
    );

    const childRuns = await runStore.listChildren(result.runId);
    const childEvents = childRuns[0] ? await eventStore.listByRun(childRuns[0].id) : [];
    const lookupCompletedEvent = childEvents.find(
      (event) =>
        event.type === 'tool.completed' &&
        event.payload &&
        typeof event.payload === 'object' &&
        !Array.isArray(event.payload) &&
        event.payload.toolName === 'lookup',
    );
    expect(lookupCompletedEvent?.payload).toEqual(
      expect.objectContaining({
        performance: expect.objectContaining({
          durationMs: expect.any(Number),
          rawOutputBytes: expect.any(Number),
          eventPayloadBytes: expect.any(Number),
        }),
      }),
    );

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

  it('retries a model timeout when modelRetryPolicy allows it', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    let attempts = 0;
    const model: ModelAdapter = {
      provider: 'test',
      model: 'timeout-once',
      capabilities: {
        toolCalling: true,
        jsonOutput: true,
        streaming: false,
        usage: false,
      },
      async generate(request) {
        attempts += 1;
        if (attempts === 1) {
          return new Promise((_, reject) => {
            request.signal?.addEventListener(
              'abort',
              () => reject(request.signal?.reason ?? new Error('aborted')),
              { once: true },
            );
          });
        }

        return {
          finishReason: 'stop',
          text: 'Recovered after timeout.',
        };
      },
    };

    const agent = new AdaptiveAgent({
      model,
      tools: [],
      runStore,
      eventStore,
      snapshotStore,
      defaults: {
        modelTimeoutMs: 5,
        modelRetryPolicy: {
          maxRetries: 1,
          baseDelayMs: 0,
          maxDelayMs: 0,
          jitter: false,
        },
      },
    });

    const result = await agent.run({ goal: 'Recover from a timeout once' });
    expect(result).toMatchObject({ status: 'success', output: 'Recovered after timeout.' });
    expect(attempts).toBe(2);

    const events = await eventStore.listByRun(result.runId);
    const retryEvent = events.find((event) => event.type === 'model.retry' && event.payload.phase === 'runtime');
    expect(retryEvent).toMatchObject({
      stepId: 'step-1',
      payload: expect.objectContaining({
        attempt: 1,
        nextAttempt: 2,
        reason: 'timeout',
        retryDelayMs: 0,
      }),
    });
    const failedEvent = events.find((event) => event.type === 'model.failed');
    expect(failedEvent).toMatchObject({
      payload: expect.objectContaining({
        attempt: 1,
        maxAttempts: 2,
        failureKind: 'timeout',
        retryable: true,
      }),
    });
    const completedEvent = events.find((event) => event.type === 'model.completed');
    expect(completedEvent).toMatchObject({
      payload: expect.objectContaining({
        attempt: 2,
        maxAttempts: 2,
      }),
    });
  });

  it('retries a transient provider model error when modelRetryPolicy allows it', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const model = new SequenceModel([
      new Error('Upstream provider returned an error.'),
      { finishReason: 'stop', text: 'Recovered after provider error.' },
    ]);
    const agent = new AdaptiveAgent({
      model,
      tools: [],
      runStore,
      eventStore,
      snapshotStore,
      defaults: {
        modelRetryPolicy: {
          maxRetries: 1,
          baseDelayMs: 0,
          maxDelayMs: 0,
          jitter: false,
        },
      },
    });

    const result = await agent.run({ goal: 'Recover from provider error once' });
    expect(result).toMatchObject({ status: 'success', output: 'Recovered after provider error.' });
    expect(model.receivedRequests).toHaveLength(2);

    const events = await eventStore.listByRun(result.runId);
    expect(events.find((event) => event.type === 'model.retry' && event.payload.phase === 'runtime')).toMatchObject({
      payload: expect.objectContaining({
        reason: 'provider_error',
        attempt: 1,
        nextAttempt: 2,
      }),
    });
  });

  it('fails after the configured model retry budget is exhausted', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const model = new SequenceModel([
      new Error('Upstream provider returned an error.'),
      new Error('Upstream provider returned an error.'),
    ]);
    const agent = new AdaptiveAgent({
      model,
      tools: [],
      runStore,
      eventStore,
      snapshotStore,
      defaults: {
        modelRetryPolicy: {
          maxRetries: 1,
          baseDelayMs: 0,
          maxDelayMs: 0,
          jitter: false,
        },
      },
    });

    const result = await agent.run({ goal: 'Provider stays down' });
    expect(result).toMatchObject({
      status: 'failure',
      code: 'MODEL_ERROR',
      error: 'Upstream provider returned an error.',
    });
    expect(model.receivedRequests).toHaveLength(2);

    const events = await eventStore.listByRun(result.runId);
    expect(events.filter((event) => event.type === 'model.retry' && event.payload.phase === 'runtime')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'model.failed')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'model.failed')[1]).toMatchObject({
      payload: expect.objectContaining({
        attempt: 2,
        maxAttempts: 2,
        retryable: false,
      }),
    });
  });

  it('does not retry non-retryable model errors', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const model = new SequenceModel([new Error('Invalid API key')]);
    const agent = new AdaptiveAgent({
      model,
      tools: [],
      runStore,
      eventStore,
      snapshotStore,
      defaults: {
        modelRetryPolicy: {
          maxRetries: 1,
          baseDelayMs: 0,
          maxDelayMs: 0,
          jitter: false,
        },
      },
    });

    const result = await agent.run({ goal: 'Do not retry auth-ish error' });
    expect(result).toMatchObject({
      status: 'failure',
      code: 'MODEL_ERROR',
      error: 'Invalid API key',
    });
    expect(model.receivedRequests).toHaveLength(1);

    const events = await eventStore.listByRun(result.runId);
    expect(events.find((event) => event.type === 'model.retry' && event.payload.phase === 'runtime')).toBeUndefined();
  });

  it('emits model.retry when the adapter reports an internal retry', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const model: ModelAdapter = {
      provider: 'test',
      model: 'retrying-model',
      capabilities: {
        toolCalling: true,
        jsonOutput: true,
        streaming: false,
        usage: false,
      },
      async generate(request) {
        await request.onRetry?.({
          attempt: 1,
          nextAttempt: 2,
          statusCode: 524,
          retryDelayMs: 250,
          reason: 'provider_error',
          phase: 'http_status',
          message: 'mesh API returned 524: cloudflare timeout',
        });
        return {
          finishReason: 'stop',
          text: 'Recovered after retry.',
        };
      },
    };

    const agent = new AdaptiveAgent({
      model,
      tools: [],
      runStore,
      eventStore,
      snapshotStore,
    });

    const result = await agent.run({ goal: 'Retry internally' });
    expect(result).toMatchObject({ status: 'success', output: 'Recovered after retry.' });

    const events = await eventStore.listByRun(result.runId);
    const retryEvent = events.find((event) => event.type === 'model.retry');
    expect(retryEvent).toMatchObject({
      stepId: 'step-1',
      payload: expect.objectContaining({
        attempt: 1,
        nextAttempt: 2,
        statusCode: 524,
        retryDelayMs: 250,
        reason: 'provider_error',
        phase: 'http_status',
        provider: 'test',
        model: 'retrying-model',
      }),
    });
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

    const result = await agent.run({ sessionId: 'session-delegation-1', goal: 'Write a delegation memo' });
    if (result.status !== 'success') {
      throw new Error(`Expected success, received ${result.status}`);
    }

    expect(result.output).toEqual({ report: 'delegation complete' });

    const childRuns = await runStore.listChildren(result.runId);
    expect(childRuns).toHaveLength(1);
    expect(childRuns[0]).toMatchObject({
      sessionId: 'session-delegation-1',
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

  it('carries assistant tool-call text into queued tool state and lifecycle events', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const gatedExecute = vi.fn(async () => ({ ok: true }));
    const assistantContent = 'I will update the protected record after you approve this action.';
    const agent = new AdaptiveAgent({
      model: new SequenceModel([
        {
          finishReason: 'tool_calls',
          text: assistantContent,
          toolCalls: [
            {
              id: 'approval-call-2',
              name: 'secure.write',
              input: { recordId: 'doc-2' },
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

    const firstResult = await agent.run({ goal: 'Write another protected record' });
    if (firstResult.status !== 'approval_requested') {
      throw new Error(`Expected approval_requested, received ${firstResult.status}`);
    }

    const latestSnapshot = await snapshotStore.getLatest(firstResult.runId);
    expect(latestSnapshot?.state).toMatchObject({
      schemaVersion: 1,
      pendingToolCall: {
        name: 'secure.write',
        assistantContent,
      },
      pendingToolCalls: [
        {
          name: 'secure.write',
          assistantContent,
        },
      ],
    });

    const approvalEvents = await eventStore.listByRun(firstResult.runId);
    expect(approvalEvents).toContainEqual(
      expect.objectContaining({
        type: 'approval.requested',
        payload: expect.objectContaining({
          toolName: 'secure.write',
          assistantContent,
        }),
      }),
    );

    await agent.resolveApproval(firstResult.runId, true);
    const completed = await agent.resume(firstResult.runId);
    expect(completed).toMatchObject({
      status: 'success',
      output: { status: 'done' },
    });

    const completedEvents = await eventStore.listByRun(firstResult.runId);
    expect(completedEvents).toContainEqual(
      expect.objectContaining({
        type: 'approval.resolved',
        payload: expect.objectContaining({
          toolName: 'secure.write',
          assistantContent,
          approved: true,
        }),
      }),
    );
    expect(completedEvents).toContainEqual(
      expect.objectContaining({
        type: 'tool.started',
        payload: expect.objectContaining({
          toolName: 'secure.write',
          assistantContent,
        }),
      }),
    );
    expect(completedEvents).toContainEqual(
      expect.objectContaining({
        type: 'tool.completed',
        payload: expect.objectContaining({
          toolName: 'secure.write',
          assistantContent,
          output: { ok: true },
        }),
      }),
    );
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

  it('includes current lease details when resume cannot acquire a run lease', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const run = await runStore.createRun({
      goal: 'Leased resume',
      status: 'running',
    });
    const leaseNow = new Date();
    await runStore.tryAcquireLease({
      runId: run.id,
      owner: 'worker-old',
      ttlMs: 60_000,
      now: leaseNow,
    });
    await snapshotStore.save({
      runId: run.id,
      snapshotSeq: 1,
      status: 'running',
      summary: {
        status: 'running',
        stepsUsed: 0,
      },
      state: {
        schemaVersion: 1,
        messages: [
          { role: 'system', content: 'You are AdaptiveAgent.' },
          { role: 'user', content: '{"goal":"Leased resume"}' },
        ],
        stepsUsed: 0,
      },
    });

    const agent = new AdaptiveAgent({
      model: new SequenceModel([]),
      tools: [],
      runStore,
      eventStore,
      snapshotStore,
    });

    await expect(agent.resume(run.id)).rejects.toThrow(
      `owner=worker-old, expiresAt=${new Date(leaseNow.getTime() + 60_000).toISOString()}, heartbeatAt=${leaseNow.toISOString()}`,
    );
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

  it('lets a delegate research policy override the parent default', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const toolExecutionStore = new InMemoryToolExecutionStore();
    let executedReads = 0;
    const model = new SequenceModel([
      {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'parent-call-1',
            name: 'delegate.researcher',
            input: {
              goal: 'Read enough pages to need the delegate policy',
            },
          },
        ],
      },
      {
        finishReason: 'tool_calls',
        toolCalls: Array.from({ length: 5 }, (_, index) => ({
          id: `child-read-${index + 1}`,
          name: 'read_web_page',
          input: { url: `https://example.com/child/${index + 1}` },
        })),
      },
      {
        finishReason: 'stop',
        structuredOutput: { finding: 'child-done' },
      },
      {
        finishReason: 'stop',
        structuredOutput: { report: 'done' },
      },
    ]);

    const agent = new AdaptiveAgent({
      model,
      tools: [createBudgetedReadWebPageTool(() => { executedReads += 1; })],
      delegates: [
        {
          name: 'researcher',
          description: 'Researches a topic.',
          allowedTools: ['read_web_page'],
          defaults: {
            researchPolicy: 'deep',
          },
        },
      ],
      runStore,
      eventStore,
      snapshotStore,
      toolExecutionStore,
      defaults: {
        researchPolicy: 'light',
      },
    });

    const result = await agent.run({ goal: 'Delegate this research task' });
    expect(result).toMatchObject({
      status: 'success',
      output: { report: 'done' },
    });
    expect(executedReads).toBe(5);
    expect(model.receivedRequests[2]?.messages.some(
      (message) => message.role === 'tool' && typeof message.content === 'string' && message.content.includes('budget_exhausted'),
    )).toBe(false);
  });

  it('injects the budget checkpoint as an appended user message before the next model call', async () => {
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
      role: 'user',
      snapshotField: 'pendingRuntimeMessages',
      snapshotStoreConfigured: true,
    });
    expect(checkpointLog?.content).toMatchObject({
      type: 'string',
      preview: expect.stringContaining('near the web search budget'),
    });

    const secondRequestMessages = model.receivedRequests[1]?.messages ?? [];
    expect(secondRequestMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('near the web search budget'),
        }),
      ]),
    );
    const checkpointIndex = secondRequestMessages.findIndex(
      (message) => message.role === 'user' && typeof message.content === 'string' && message.content.includes('near the web search budget'),
    );
    expect(checkpointIndex).toBeGreaterThanOrEqual(0);
    expect(secondRequestMessages[checkpointIndex - 1]).toMatchObject({ role: 'tool' });
    expect(checkpointIndex).toBe(secondRequestMessages.length - 1);
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
    expect(model.receivedRequests[3]?.tools?.map((tool) => tool.name)).not.toContain('web_search');
  });

  it('returns skipped partial results when the model repeats an exhausted-budget tool call', async () => {
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
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'search-4', name: 'web_search', input: { query: 'fourth', purpose: 'ignore the budget' } }],
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
    expect(result).toMatchObject({
      status: 'success',
      output: { done: true },
    });
    expect(model.receivedRequests[4]?.messages.at(-1)).toMatchObject({
      role: 'tool',
      name: 'web_search',
      content: expect.stringContaining('budget_exhausted'),
    });
    expect(model.receivedRequests[4]?.tools?.map((tool) => tool.name)).not.toContain('web_search');
  });

  it('returns skipped partial results for exhausted hidden-budget calls before validating stale input', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const toolExecutionStore = new InMemoryToolExecutionStore();
    let executedSearches = 0;
    const searchTool = createStrictSearchTool(() => { executedSearches += 1; });
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
        toolCalls: [{ id: 'search-3', name: 'web_search', input: { query: 'third', purpose: 'exhaust budget' } }],
      },
      {
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'search-4', name: 'web_search', input: { query: 'fourth', purpose: 'stale hidden call', maxResults: '10' } }],
      },
      {
        finishReason: 'stop',
        structuredOutput: { done: true },
      },
    ]);

    const agent = new AdaptiveAgent({
      model,
      tools: [searchTool],
      runStore,
      eventStore,
      snapshotStore,
      toolExecutionStore,
      defaults: {
        researchPolicy: 'light',
      },
    });

    const result = await agent.run({ goal: 'Research something current' });

    expect(result).toMatchObject({ status: 'success', output: { done: true } });
    expect(executedSearches).toBe(2);
    const events = await eventStore.listByRun(result.runId);
    expect(events.filter((event) => event.type === 'model.tool_call_rejected')).toHaveLength(0);
    expect(model.receivedRequests[4]?.messages.at(-1)).toMatchObject({
      role: 'tool',
      name: 'web_search',
      toolCallId: 'search-4',
      content: expect.stringContaining('budget_exhausted'),
    });
    expect(model.receivedRequests[4]?.tools?.map((tool) => tool.name)).not.toContain('web_search');
  });

  it('keeps returning skipped results when the model repeatedly calls an exhausted hidden-budget tool', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const toolExecutionStore = new InMemoryToolExecutionStore();
    let executedSearches = 0;
    const searchTool: ToolDefinition = {
      ...createBudgetedSearchTool(),
      execute: async (input) => {
        executedSearches += 1;
        return {
          query: typeof input === 'object' && input && 'query' in input ? input.query : 'unknown',
          results: [{ title: 'stub', url: 'https://example.com', snippet: 'stub' }],
        };
      },
    };
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
        toolCalls: [{ id: 'search-3', name: 'web_search', input: { query: 'third', purpose: 'exhaust budget' } }],
      },
      {
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'search-4', name: 'web_search', input: { query: 'fourth', purpose: 'ignore hidden tool list' } }],
      },
      {
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'search-5', name: 'web_search', input: { query: 'fifth', purpose: 'repeat stale manifest call' } }],
      },
      {
        finishReason: 'stop',
        structuredOutput: { done: true },
      },
    ]);

    const agent = new AdaptiveAgent({
      model,
      tools: [searchTool],
      runStore,
      eventStore,
      snapshotStore,
      toolExecutionStore,
      defaults: {
        researchPolicy: 'light',
      },
    });

    const result = await agent.run({ goal: 'Research something current' });
    expect(result).toMatchObject({
      status: 'success',
      output: { done: true },
    });
    expect(executedSearches).toBe(2);
    expect(model.receivedRequests[4]?.tools?.map((tool) => tool.name)).not.toContain('web_search');
    expect(model.receivedRequests[5]?.messages.at(-1)).toMatchObject({
      role: 'tool',
      name: 'web_search',
      toolCallId: 'search-5',
      content: expect.stringContaining('budget_exhausted'),
    });
  });

  it('drains same-batch pending calls for exhausted research budgets as skipped tool results', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const toolExecutionStore = new InMemoryToolExecutionStore();
    let executedSearches = 0;
    const searchTool: ToolDefinition = {
      ...createBudgetedSearchTool(),
      execute: async (input) => {
        executedSearches += 1;
        return {
          query: typeof input === 'object' && input && 'query' in input ? input.query : 'unknown',
          results: [{ title: 'stub', url: 'https://example.com', snippet: 'stub' }],
        };
      },
    };
    const model = new SequenceModel([
      {
        finishReason: 'tool_calls',
        toolCalls: [
          { id: 'search-1', name: 'web_search', input: { query: 'first', purpose: 'find starting evidence' } },
          { id: 'search-2', name: 'web_search', input: { query: 'second', purpose: 'double check' } },
          { id: 'search-3', name: 'web_search', input: { query: 'third', purpose: 'keep searching' } },
          { id: 'search-4', name: 'web_search', input: { query: 'fourth', purpose: 'same batch overflow' } },
        ],
      },
      {
        finishReason: 'stop',
        structuredOutput: { done: true },
      },
    ]);

    const agent = new AdaptiveAgent({
      model,
      tools: [searchTool],
      runStore,
      eventStore,
      snapshotStore,
      toolExecutionStore,
      defaults: {
        researchPolicy: 'light',
      },
    });

    const result = await agent.run({ goal: 'Research something current' });
    expect(result).toMatchObject({
      status: 'success',
      output: { done: true },
    });
    expect(executedSearches).toBe(2);
    const finalMessages = model.receivedRequests[1]?.messages ?? [];
    const budgetMessages = finalMessages.filter(
      (message) => message.role === 'tool' && typeof message.content === 'string' && message.content.includes('budget_exhausted'),
    );
    expect(budgetMessages).toEqual([
      expect.objectContaining({
        role: 'tool',
        name: 'web_search',
        toolCallId: 'search-3',
        content: expect.stringContaining('budget_exhausted'),
      }),
      expect.objectContaining({
        role: 'tool',
        name: 'web_search',
        toolCallId: 'search-4',
        content: expect.stringContaining('budget_exhausted'),
      }),
    ]);
  });

  it('does not derive hidden consecutive read limits from deep research policy', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const toolExecutionStore = new InMemoryToolExecutionStore();
    let executedReads = 0;
    const model = new SequenceModel([
      {
        finishReason: 'tool_calls',
        toolCalls: Array.from({ length: 5 }, (_, index) => ({
          id: `read-${index + 1}`,
          name: 'read_web_page',
          input: { url: `https://example.com/${index + 1}` },
        })),
      },
      {
        finishReason: 'stop',
        structuredOutput: { done: true },
      },
    ]);

    const agent = new AdaptiveAgent({
      model,
      tools: [createBudgetedReadWebPageTool(() => { executedReads += 1; })],
      runStore,
      eventStore,
      snapshotStore,
      toolExecutionStore,
      defaults: {
        researchPolicy: 'deep',
      },
    });

    const result = await agent.run({ goal: 'Read several pages' });
    expect(result).toMatchObject({
      status: 'success',
      output: { done: true },
    });
    expect(executedReads).toBe(5);
    expect(model.receivedRequests[1]?.messages.some(
      (message) => message.role === 'tool' && typeof message.content === 'string' && message.content.includes('budget_exhausted'),
    )).toBe(false);
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

  it('steers an in-progress run by injecting a user message at the next step boundary', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const model = new SequenceModel([
      {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'call-1',
            name: 'noop',
            input: {},
          },
        ],
      },
      {
        finishReason: 'stop',
        text: 'Acknowledged steering.',
      },
    ]);

    let agent!: AdaptiveAgent;
    const noopTool: ToolDefinition = {
      name: 'noop',
      description: 'No-op that triggers a steer.',
      inputSchema: { type: 'object', additionalProperties: true },
      execute: async (_input, ctx) => {
        await agent.steer(ctx.runId, { message: 'Reply only in French.' });
        return { ok: true };
      },
    };

    agent = new AdaptiveAgent({
      model,
      tools: [noopTool],
      runStore,
      eventStore,
      snapshotStore,
    });

    const result = await agent.run({ goal: 'Test steer' });
    expect(result).toMatchObject({
      status: 'success',
      output: 'Acknowledged steering.',
    });

    const secondRequestMessages = model.receivedRequests[1]?.messages ?? [];
    const steeredUser = secondRequestMessages.find(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content === 'Reply only in French.',
    );
    expect(steeredUser).toBeTruthy();

    const events = await eventStore.listByRun(result.runId);
    const steeredEvent = events.find((event) => event.type === 'run.steered');
    expect(steeredEvent).toBeTruthy();
    expect(steeredEvent?.payload).toMatchObject({
      role: 'user',
      message: 'Reply only in French.',
    });

    const finalRun = await runStore.getRun(result.runId);
    expect((finalRun?.metadata as Record<string, unknown> | undefined)?.pendingSteerMessages).toBeUndefined();
  });

  it('reroutes child steer to the parent when the steer requires a missing child capability', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const parentModel = new SequenceModel([
      {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'parent-call-1',
            name: 'delegate.researcher',
            input: {
              goal: 'Research Tamil Nadu politics',
            },
          },
        ],
      },
      {
        finishReason: 'stop',
        text: 'Parent handled deferred steer.',
      },
    ]);
    const childModel = new SequenceModel([
      {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'child-call-1',
            name: 'lookup',
            input: { topic: 'tamil-nadu' },
          },
        ],
      },
      {
        finishReason: 'stop',
        text: 'Child completed research.',
      },
    ]);

    let agent!: AdaptiveAgent;
    const lookupTool: ToolDefinition = {
      name: 'lookup',
      description: 'Research helper that triggers a steer.',
      inputSchema: { type: 'object', additionalProperties: true },
      execute: async (_input, ctx) => {
        await agent.steer(ctx.runId, { message: 'Write the final report to tn.html' });
        return { finding: 'researched:tamil-nadu' };
      },
    };

    agent = new AdaptiveAgent({
      model: parentModel,
      tools: [lookupTool, createWriteFileTool({ allowedRoot: '/tmp' })],
      delegates: [
        {
          name: 'researcher',
          description: 'Researches using lookup only.',
          allowedTools: ['lookup'],
          model: childModel,
        },
      ],
      runStore,
      eventStore,
      snapshotStore,
    });

    const result = await agent.run({ goal: 'Research and report' });
    expect(result).toMatchObject({
      status: 'success',
      output: 'Parent handled deferred steer.',
    });

    const childRequestMessages = childModel.receivedRequests[1]?.messages ?? [];
    expect(
      childRequestMessages.some(
        (message) =>
          message.role === 'user' &&
          typeof message.content === 'string' &&
          message.content.includes('Write the final report to tn.html'),
      ),
    ).toBe(false);

    const parentRequestMessages = parentModel.receivedRequests[1]?.messages ?? [];
    expect(
      parentRequestMessages.some(
        (message) =>
          message.role === 'user' &&
          typeof message.content === 'string' &&
          message.content === 'Write the final report to tn.html',
      ),
    ).toBe(true);

    const parentRun = await runStore.getRun(result.runId);
    expect((parentRun?.metadata as Record<string, unknown> | undefined)?.pendingSteerMessages).toBeUndefined();
  });

  it('keeps child steer on the child when no extra capability is required', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const parentModel = new SequenceModel([
      {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'parent-call-1',
            name: 'delegate.researcher',
            input: {
              goal: 'Research Tamil Nadu politics',
            },
          },
        ],
      },
      {
        finishReason: 'stop',
        text: 'Parent completed.',
      },
    ]);
    const childModel = new SequenceModel([
      {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'child-call-1',
            name: 'lookup',
            input: { topic: 'tamil-nadu' },
          },
        ],
      },
      {
        finishReason: 'stop',
        text: 'Child incorporated steer.',
      },
    ]);

    let agent!: AdaptiveAgent;
    const lookupTool: ToolDefinition = {
      name: 'lookup',
      description: 'Research helper that triggers a steer.',
      inputSchema: { type: 'object', additionalProperties: true },
      execute: async (_input, ctx) => {
        await agent.steer(ctx.runId, { message: 'Focus more on alliance reactions.' });
        return { finding: 'researched:tamil-nadu' };
      },
    };

    agent = new AdaptiveAgent({
      model: parentModel,
      tools: [lookupTool, createWriteFileTool({ allowedRoot: '/tmp' })],
      delegates: [
        {
          name: 'researcher',
          description: 'Researches using lookup only.',
          allowedTools: ['lookup'],
          model: childModel,
        },
      ],
      runStore,
      eventStore,
      snapshotStore,
    });

    const result = await agent.run({ goal: 'Research and report' });
    expect(result).toMatchObject({
      status: 'success',
      output: 'Parent completed.',
    });

    const childRequestMessages = childModel.receivedRequests[1]?.messages ?? [];
    expect(
      childRequestMessages.some(
        (message) =>
          message.role === 'user' &&
          typeof message.content === 'string' &&
          message.content === 'Focus more on alliance reactions.',
      ),
    ).toBe(true);

    const parentRequestMessages = parentModel.receivedRequests[1]?.messages ?? [];
    expect(
      parentRequestMessages.some(
        (message) =>
          message.role === 'user' &&
          typeof message.content === 'string' &&
          message.content === 'Focus more on alliance reactions.',
      ),
    ).toBe(false);
  });

  it('rejects steering for a terminal run', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const model = new SequenceModel([
      {
        finishReason: 'stop',
        text: 'done',
      },
    ]);
    const agent = new AdaptiveAgent({ model, tools: [], runStore, eventStore, snapshotStore });
    const result = await agent.run({ goal: 'short run' });
    expect(result.status).toBe('success');

    await expect(agent.steer(result.runId, 'too late')).rejects.toThrow(/succeeded/);
  });
});
