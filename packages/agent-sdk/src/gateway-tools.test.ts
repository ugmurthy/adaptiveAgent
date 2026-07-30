import { describe, expect, it, vi } from 'vitest';
import {
  createReadWebPageTool,
  createAdaptiveAgentRuntime,
  createWebSearchTool,
  InMemoryToolExecutionStore,
  type JsonObject,
  type JsonValue,
  type ToolContext,
} from '@adaptive-agent/core';
import type {
  GatewayClient,
  ModelGenerateParams,
  ToolExecuteParams,
} from '@adaptive-agent/gateway-client';

import {
  createAgentSdk,
  createGatewayProxyTool,
  inspectAgentSdkResolution,
} from './index.js';

describe('gateway proxy tools', () => {
  it('preserves local schemas while forwarding protected permit and tool idempotency', async () => {
    const executeTool = vi.fn(async (params: ToolExecuteParams) => ({
      idempotencyKey: params.idempotencyKey,
      output: {
        query: 'current status',
        results: [{
          title: 'Current result',
          url: 'https://example.test/current',
          snippet: 'Current summary',
        }],
      },
      usage: { units: 1, cost: 0.02 },
      diagnostics: {
        provider: 'brave',
        operation: 'web_search@1',
        durationMs: 8,
        traceId: 'trace-search',
      },
    }));
    const client = { executeTool } as unknown as GatewayClient;
    const proxy = createGatewayProxyTool({ client, toolName: 'web_search' });

    expect(proxy.inputSchema).toEqual(
      createWebSearchTool({ provider: 'duckduckgo' }).inputSchema,
    );
    const context = toolContext();
    const input = { query: 'current status' };
    const output = await proxy.execute(input, context);

    expect(executeTool).toHaveBeenCalledWith({
      permitId: 'protected-permit',
      idempotencyKey: 'run:step:tool',
      toolName: 'web_search@1',
      input,
      timeoutMs: 90_000,
    }, { signal: context.signal });
    expect(proxy.getAccounting?.(output, input, context)).toEqual({
      provider: 'brave',
      operation: 'web_search',
      billable: true,
      units: { requests: 1 },
      estimatedCostUSD: 0.02,
      pricingSource: 'configured',
    });
    expect(JSON.stringify(output)).not.toContain('trace-search');
    expect(JSON.stringify(output)).not.toContain('brave');
  });

  it('uses root-run authorization for derived runs and keeps read results schema-compatible', async () => {
    const authorizeRun = vi.fn(async () => ({
      permitId: 'derived-permit',
      inferenceMode: 'gateway' as const,
      inferenceTier: 'medium' as const,
      routePolicyVersion: 'policy-v2',
      remoteCapabilities: ['read_web_page@1'],
      expiresAt: '2999-01-01T00:00:00.000Z',
    }));
    const executeTool = vi.fn(async (params: ToolExecuteParams) => ({
      idempotencyKey: params.idempotencyKey,
      output: {
        url: 'https://example.test',
        title: 'Example',
        text: 'Extracted by Parallel',
        bytesFetched: 21,
      },
      usage: { units: 1, cost: 0.01 },
      diagnostics: {
        provider: 'parallel',
        operation: 'read_web_page@1',
        durationMs: 12,
        traceId: 'trace-read',
      },
    }));
    const client = { authorizeRun, executeTool } as unknown as GatewayClient;
    const proxy = createGatewayProxyTool({ client, toolName: 'read_web_page' });

    expect(proxy.inputSchema).toEqual(
      createReadWebPageTool({ provider: 'direct' }).inputSchema,
    );
    const context = toolContext({
      runId: 'child-run',
      rootRunId: 'derived-root',
      executionContext: {
        inferenceMode: 'gateway',
        inferenceTier: 'medium',
        authorizationRef: 'inherited-permit',
        authorizationRunId: 'original-root',
        profileRefs: [],
      },
    });
    await proxy.execute({ url: 'https://example.test' }, context);

    expect(authorizeRun).toHaveBeenCalledWith({
      runId: 'derived-root',
      inferenceMode: 'gateway',
      requestedTier: 'medium',
      profileRefs: [],
    });
    expect(executeTool.mock.calls[0]?.[0]).toMatchObject({
      permitId: 'derived-permit',
      toolName: 'read_web_page@1',
    });
  });

  it('rejects derived authorization that omits the configured capability', async () => {
    const client = {
      authorizeRun: vi.fn(async () => ({
        permitId: 'model-only-permit',
        inferenceMode: 'gateway' as const,
        inferenceTier: 'medium' as const,
        routePolicyVersion: 'policy-v2',
        remoteCapabilities: ['model/generate'],
        expiresAt: '2999-01-01T00:00:00.000Z',
      })),
      executeTool: vi.fn(),
    } as unknown as GatewayClient;
    const proxy = createGatewayProxyTool({ client, toolName: 'web_search' });

    await expect(proxy.execute({ query: 'not entitled' }, toolContext({
      rootRunId: 'derived-root',
      executionContext: {
        inferenceMode: 'gateway',
        inferenceTier: 'medium',
        authorizationRef: 'inherited-permit',
        authorizationRunId: 'original-root',
      },
    }))).rejects.toThrow('not authorized for this account');
  });
});

describe('Agent SDK gateway tool wiring', () => {
  it('configures remote search alongside local page reads and keeps provided overrides highest', async () => {
    const providedSearch = {
      name: 'web_search',
      description: 'User-provided search override',
      inputSchema: {
        type: 'object',
        required: ['query'],
        properties: { query: { type: 'string' } },
      },
      async execute(): Promise<JsonValue> {
        return { results: [] };
      },
    };
    const inspection = await inspectAgentSdkResolution({
      cwd: process.cwd(),
      env: {},
      inferenceMode: 'gateway',
      gateway: { remoteTools: ['web_search'] },
      gatewayClient: {} as GatewayClient,
      agentConfig: {
        id: 'gateway-tools-inspection',
        name: 'Gateway Tools Inspection',
        invocationModes: ['run'],
        defaultInvocationMode: 'run',
        model: { provider: 'ollama', model: 'unused' },
        tools: ['web_search', 'read_web_page'],
      },
      tools: [providedSearch],
    });

    expect(inspection.config.gateway.remoteTools).toEqual(['web_search']);
    expect(inspection.tools.map((tool) => tool.name)).toEqual([
      'web_search',
      'read_web_page',
    ]);
    expect(inspection.tools.find((tool) => tool.name === 'web_search')?.description)
      .toBe('User-provided search override');
    expect(inspection.registeredToolNames).toContain('read_web_page');
  });

  it('persists remote output locally and records upstream provider accounting', async () => {
    const authorizeRun = vi.fn(async (params: { runId: string; requestedTier?: string }) => ({
      permitId: `permit-${params.runId}`,
      inferenceMode: 'gateway' as const,
      inferenceTier: params.requestedTier as 'medium',
      routePolicyVersion: 'policy-tools',
      remoteCapabilities: ['model/generate', 'web_search@1'],
      expiresAt: '2999-01-01T00:00:00.000Z',
    }));
    const generateModel = vi.fn(async (params: ModelGenerateParams) => {
      const hasToolResult = params.messages.some((message) => message.role === 'tool');
      return {
        callId: params.invocation.callId,
        traceId: `trace-${params.invocation.callId}`,
        ...(hasToolResult
          ? { text: 'remote search complete' }
          : {
              toolCalls: [{
                id: 'remote-search-call',
                name: 'web_search',
                input: { query: 'phase five' },
              }],
            }),
        finishReason: hasToolResult ? 'stop' as const : 'tool_calls' as const,
        usage: {
          provider: 'ollama',
          model: 'gateway-model',
          inputTokens: 2,
          outputTokens: 1,
          totalTokens: 3,
        },
        routePolicyVersion: 'policy-tools',
        timings: { gatewayDurationMs: 3, providerDurationMs: 2, routeAttempts: 1 },
      };
    });
    const executeTool = vi.fn(async (params: ToolExecuteParams) => ({
      idempotencyKey: params.idempotencyKey,
      output: {
        query: 'phase five',
        results: [{
          title: 'Phase Five',
          url: 'https://example.test/phase-five',
          snippet: 'Gateway result',
        }],
      },
      usage: { units: 1, cost: 0.015 },
      diagnostics: {
        provider: 'serper',
        operation: 'web_search@1',
        durationMs: 6,
        traceId: 'trace-tool',
      },
    }));
    const gatewayClient = {
      authorizeRun,
      generateModel,
      executeTool,
    } as unknown as GatewayClient;
    const toolExecutionStore = new InMemoryToolExecutionStore();
    const sdk = await createAgentSdk({
      cwd: process.cwd(),
      env: {},
      runtimeMode: 'memory',
      inferenceMode: 'gateway',
      gateway: { remoteTools: ['web_search'] },
      gatewayClient,
      runtime: createAdaptiveAgentRuntime({ toolExecutionStore }),
      agentConfig: {
        id: 'gateway-tool-run',
        name: 'Gateway Tool Run',
        invocationModes: ['run'],
        defaultInvocationMode: 'run',
        model: { provider: 'ollama', model: 'unused' },
        tools: ['web_search'],
      },
    });

    try {
      const result = await sdk.runRaw('Search through the gateway');
      const inspection = await sdk.inspect(result.runId);
      const idempotencyKey = executeTool.mock.calls[0]?.[0].idempotencyKey;

      expect(result).toMatchObject({ status: 'success', output: 'remote search complete' });
      expect(executeTool).toHaveBeenCalledTimes(1);
      expect(executeTool.mock.calls[0]?.[0]).toMatchObject({
        permitId: `permit-${result.runId}`,
        toolName: 'web_search@1',
        input: { query: 'phase five' },
      });
      expect(inspection.events.find((event) => event.type === 'tool.completed')?.payload)
        .toMatchObject({
          toolName: 'web_search',
          accounting: {
            provider: 'serper',
            operation: 'web_search',
            billable: true,
            units: { requests: 1 },
            estimatedCostUSD: 0.015,
          },
        });
      expect(idempotencyKey).toBeTruthy();
      await expect(toolExecutionStore.getByIdempotencyKey(idempotencyKey!)).resolves.toMatchObject({
        status: 'completed',
        output: { query: 'phase five' },
      });
    } finally {
      await sdk.close();
    }
  });
});

function toolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    runId: 'run-1',
    rootRunId: 'run-1',
    delegationDepth: 0,
    stepId: 'step-1',
    toolCallId: 'tool-1',
    idempotencyKey: 'run:step:tool',
    timeoutMs: 90_000,
    signal: new AbortController().signal,
    executionContext: {
      inferenceMode: 'gateway',
      inferenceTier: 'medium',
      authorizationRef: 'protected-permit',
      authorizationRunId: 'run-1',
      routePolicyRef: 'policy-v1',
      profileRefs: [],
    } satisfies JsonObject,
    emit: async () => {},
    ...overrides,
  };
}
