import { describe, expect, it, vi } from 'vitest';

import { AdaptiveAgent } from './adaptive-agent.js';
import { InMemoryEventStore } from './in-memory-event-store.js';
import { InMemoryPlanStore } from './in-memory-plan-store.js';
import { InMemoryRunStore } from './in-memory-run-store.js';
import { InMemorySnapshotStore } from './in-memory-snapshot-store.js';
import type { ModelAdapter, ModelRequest, ModelResponse, ToolDefinition } from './types.js';

class SequenceModel implements ModelAdapter {
  readonly provider = 'test';
  readonly model = 'sequence';
  readonly capabilities = {
    toolCalling: true,
    jsonOutput: true,
    streaming: false,
    usage: false,
  };

  readonly receivedRequests: ModelRequest[] = [];

  constructor(private readonly responses: ModelResponse[]) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.receivedRequests.push(structuredClone(request));
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
  it('executes multiple tool calls from one model turn before resuming the model', async () => {
    const runStore = new InMemoryRunStore();
    const eventStore = new InMemoryEventStore();
    const snapshotStore = new InMemorySnapshotStore();
    const model = new SequenceModel([
      {
        finishReason: 'tool_calls',
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

  it('enters approval wait without executing the gated tool and remains resumable', async () => {
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

    const approvalEvents = await eventStore.listByRun(firstResult.runId);
    expect(approvalEvents.some((event) => event.type === 'approval.requested')).toBe(true);
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
