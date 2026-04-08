import { PassThrough } from 'node:stream';

import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { InMemoryEventStore } from './in-memory-event-store.js';
import { InMemoryRunStore } from './in-memory-run-store.js';
import { InMemorySnapshotStore } from './in-memory-snapshot-store.js';
import { createAdaptiveAgent, createAdaptiveAgentRuntime } from './create-adaptive-agent.js';
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

  constructor(
    private readonly responses: ModelResponse[],
    provider = 'test',
  ) {
    this.provider = provider;
  }

  async generate(_request: ModelRequest): Promise<ModelResponse> {
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

describe('createAdaptiveAgent', () => {
  it('creates default in-memory runtime stores', () => {
    const runtime = createAdaptiveAgentRuntime();

    expect(runtime.runStore).toBeInstanceOf(InMemoryRunStore);
    expect(runtime.eventStore).toBeInstanceOf(InMemoryEventStore);
    expect(runtime.snapshotStore).toBeInstanceOf(InMemorySnapshotStore);
    expect(runtime.planStore).toBeUndefined();
  });

  it('preserves supplied runtime instances', () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();

    const { runtime } = createAdaptiveAgent({
      model: new SequenceModel([{ finishReason: 'stop', structuredOutput: { ok: true } }]),
      tools: [],
      runtime: {
        runStore,
        eventStore,
        snapshotStore,
      },
    });

    expect(runtime.runStore).toBe(runStore);
    expect(runtime.eventStore).toBe(eventStore);
    expect(runtime.snapshotStore).toBe(snapshotStore);
  });

  it('accepts model adapter config input', () => {
    const chunks: string[] = [];
    const stream = new PassThrough();
    stream.on('data', (chunk) => chunks.push(chunk.toString()));
    const logger = pino({ level: 'debug', base: undefined }, stream);

    createAdaptiveAgent({
      model: { provider: 'ollama', model: 'qwen3.5' },
      tools: [],
      logger,
    });

    const output = chunks.join('');
    expect(output).toContain('agent.initialized');
    expect(output).toContain('"provider":"ollama"');
    expect(output).toContain('"model":"qwen3.5"');
  });

  it('converts provided skills into delegates and keeps the runtime accessible', async () => {
    const { agent, runtime } = createAdaptiveAgent({
      model: new SequenceModel([
        {
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'delegate-call-1',
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
      skills: [
        {
          name: 'researcher',
          description: 'Researches a topic using the lookup tool.',
          instructions: 'Use the lookup tool to research the requested topic.',
          allowedTools: ['lookup'],
        },
      ],
    });

    const result = await agent.run({ goal: 'Delegate this research task' });
    const childRuns = await runtime.runStore.listChildren(result.runId);

    expect(result).toMatchObject({
      status: 'success',
      output: { report: 'delegation complete' },
    });
    expect(childRuns).toHaveLength(1);
    expect(childRuns[0]).toMatchObject({ delegateName: 'researcher' });
  });

  it('rejects duplicate delegate names across delegates and skills', () => {
    expect(() =>
      createAdaptiveAgent({
        model: new SequenceModel([{ finishReason: 'stop', structuredOutput: { ok: true } }]),
        tools: [],
        delegates: [
          {
            name: 'researcher',
            description: 'Built-in delegate',
            allowedTools: [],
          },
        ],
        skills: [
          {
            name: 'researcher',
            description: 'Loaded skill',
            instructions: 'Same name as the explicit delegate.',
            allowedTools: [],
          },
        ],
      }),
    ).toThrow('Duplicate delegate name researcher');
  });
});
