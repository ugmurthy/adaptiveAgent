import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayTransportError, type GatewayClient, type ModelGenerateParams } from '@adaptive-agent/gateway-client';
import { SignJWT } from 'jose';
import {
  GatewayService,
  InMemoryBillingStore,
  createJwtAuthenticator,
  startGatewayServer,
  validateRoutePolicy,
  type ProviderAdapter,
} from '@adaptive-agent/capability-gateway';

import { main as runCli } from './adaptive-agent.js';
import { AgentSettingsValidationError, createAgentSdk, inspectAgentSdkResolution, loadAgentSdkConfig } from './index.js';
import { testEnvironment } from './test-environment.js';

const bunIt = typeof Bun === 'undefined' ? it.skip : it;

describe('agent-sdk config resolution', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-sdk-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('loads agent.json and falls back from default postgres to memory without DATABASE_URL', async () => {
    await writeAgentConfig(join(tempDir, 'agent.json'));

    const config = await loadAgentSdkConfig({ cwd: tempDir, env: testEnvironment({ ADAPTIVE_AGENT_HOME: join(tempDir, 'home') }) });

    expect(config.runtime.requestedMode).toBe('postgres');
    expect(config.runtime.mode).toBe('memory');
    expect(config.workspaceRoot).toBe(tempDir);
    expect(config.shellCwd).toBe(tempDir);
    expect(config.interaction.approvalMode).toBe('auto');
    expect(config.agents.dirs).toEqual([join(tempDir, 'agents'), join(process.env.HOME ?? '', '.adaptiveAgent', 'agents')]);
    expect(config.skills.dirs).toEqual([join(tempDir, 'skills'), join(process.env.HOME ?? '', '.adaptiveAgent', 'skills')]);
  });

  it('resolves an agent filename from settings agents dirs', async () => {
    await mkdir(join(tempDir, 'catalog'));
    await writeAgentConfig(join(tempDir, 'catalog', 'researcher.json'), 'researcher');
    await writeFile(join(tempDir, 'agent.settings.json'), JSON.stringify({ agents: { dirs: ['./catalog'] } }));

    const config = await loadAgentSdkConfig({ cwd: tempDir, agentConfigPath: 'researcher', env: testEnvironment() });

    expect(config.agent.id).toBe('researcher');
    expect(config.agents.dirs).toEqual([join(tempDir, 'catalog')]);
  });

  it('resolves an agent id from settings agents dirs when the filename differs', async () => {
    await mkdir(join(tempDir, 'catalog'));
    await writeAgentConfig(join(tempDir, 'catalog', 'gaia2-improved.json'), 'gaia-agent-improved');
    await writeFile(join(tempDir, 'agent.settings.json'), JSON.stringify({ agents: { dirs: ['./catalog'] } }));

    const config = await loadAgentSdkConfig({ cwd: tempDir, agentConfigPath: 'gaia-agent-improved', env: testEnvironment() });

    expect(config.agent.id).toBe('gaia-agent-improved');
  });

  it('rejects ambiguous agent filenames from settings agents dirs', async () => {
    await mkdir(join(tempDir, 'catalog-a'));
    await mkdir(join(tempDir, 'catalog-b'));
    await writeAgentConfig(join(tempDir, 'catalog-a', 'worker.json'), 'worker-a');
    await writeAgentConfig(join(tempDir, 'catalog-b', 'worker.json'), 'worker-b');
    await writeFile(join(tempDir, 'agent.settings.json'), JSON.stringify({ agents: { dirs: ['./catalog-a', './catalog-b'] } }));

    await expect(loadAgentSdkConfig({ cwd: tempDir, agentConfigPath: 'worker', env: testEnvironment() })).rejects.toThrow('Ambiguous agent config "worker"');
  });

  it('uses settings provider/model only as fallbacks', async () => {
    await writeFile(
      join(tempDir, 'agent.json'),
      JSON.stringify({
        id: 'agent',
        name: 'Agent',
        invocationModes: ['run'],
        defaultInvocationMode: 'run',
        model: { provider: 'ollama', model: 'qwen3.5' },
        tools: ['read_file'],
      }),
    );
    await writeFile(
      join(tempDir, 'agent.settings.json'),
      JSON.stringify({ model: { overrideProvider: 'openrouter', overrideModel: 'openai/gpt-5-mini' } }),
    );

    const config = await loadAgentSdkConfig({ cwd: tempDir, env: testEnvironment() });

    expect(config.model.provider).toBe('ollama');
    expect(config.model.model).toBe('qwen3.5');
  });

  it('fails explicit postgres without DATABASE_URL', async () => {
    await writeAgentConfig(join(tempDir, 'agent.json'));
    await writeFile(join(tempDir, 'agent.settings.json'), JSON.stringify({ runtime: { mode: 'postgres' } }));

    await expect(loadAgentSdkConfig({ cwd: tempDir, env: testEnvironment() })).rejects.toThrow(AgentSettingsValidationError);
  });

  it('loads ground truth calendar policy from settings', async () => {
    await writeAgentConfig(join(tempDir, 'agent.json'));
    await writeFile(
      join(tempDir, 'agent.settings.json'),
      JSON.stringify({
        groundTruth: {
          timezone: 'Asia/Kolkata',
          locale: 'en-IN',
          weekStartsOn: 'monday',
          fiscalYearStartMonth: 4,
          fiscalQuarterNaming: 'endYear',
          businessDays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
        },
      }),
    );

    const config = await loadAgentSdkConfig({ cwd: tempDir, env: testEnvironment() });

    expect(config.groundTruth).toMatchObject({
      enabled: true,
      timezone: 'Asia/Kolkata',
      locale: 'en-IN',
      weekStartsOn: 'monday',
      fiscalYearStartMonth: 4,
      fiscalQuarterNaming: 'endYear',
    });
  });

  it('resolves non-secret gateway settings and inference defaults', async () => {
    await writeAgentConfig(join(tempDir, 'agent.json'));
    await writeFile(
      join(tempDir, 'agent.settings.json'),
      JSON.stringify({
        inference: { mode: 'gateway', tier: 'high' },
        gateway: {
          url: '${GATEWAY_URL}',
          accessTokenEnv: 'TEST_GATEWAY_TOKEN',
          requireRunPermit: true,
          connectTimeoutMs: 1500,
        },
      }),
    );

    const config = await loadAgentSdkConfig({
      cwd: tempDir,
      env: testEnvironment({ GATEWAY_URL: 'wss://gateway.example/rpc' }),
    });

    expect(config.inference).toEqual({ mode: 'gateway', tier: 'high' });
    expect(config.gateway).toMatchObject({
      url: 'wss://gateway.example/rpc',
      accessTokenEnv: 'TEST_GATEWAY_TOKEN',
      requireRunPermit: true,
      connectTimeoutMs: 1500,
    });
    expect(JSON.stringify(config)).not.toContain('access-token-value');
  });

  it('rejects invalid fiscal year start month', async () => {
    await writeAgentConfig(join(tempDir, 'agent.json'));
    await writeFile(join(tempDir, 'agent.settings.json'), JSON.stringify({ groundTruth: { fiscalYearStartMonth: 13 } }));

    await expect(loadAgentSdkConfig({ cwd: tempDir, env: testEnvironment() })).rejects.toThrow(AgentSettingsValidationError);
  });

  it('inspects resolved tools without creating a runtime bundle', async () => {
    await writeAgentConfig(join(tempDir, 'agent.json'));

    const inspection = await inspectAgentSdkResolution({ cwd: tempDir, env: testEnvironment() });

    expect(inspection.config.agent.id).toBe('agent');
    expect(inspection.tools.map((tool) => tool.name)).toEqual(['read_file']);
    expect(inspection.registeredToolNames).toContain('read_file');
    expect(inspection.registeredToolNames).toContain('search_files');
    expect(inspection.registeredToolNames).toContain('edit_file');
    expect(inspection.delegates).toEqual([]);
  });
});

describe('agent-sdk gateway integration', () => {
  it('uses an injected model adapter instead of the configured provider', async () => {
    const generate = vi.fn(async () => ({ finishReason: 'stop' as const, text: 'injected adapter result' }));
    const sdk = await createAgentSdk({
      cwd: process.cwd(),
      env: testEnvironment(),
      runtimeMode: 'memory',
      inferenceMode: 'local',
      modelAdapter: {
        provider: 'injected',
        model: 'injected-model',
        capabilities: { toolCalling: true, jsonOutput: true, streaming: false, usage: false },
        generate,
      },
      agentConfig: {
        id: 'injected-model-agent',
        name: 'Injected Model Agent',
        invocationModes: ['run'],
        defaultInvocationMode: 'run',
        model: { provider: 'openrouter', model: 'must-not-be-used' },
        tools: [],
      },
    });

    try {
      const result = await sdk.runRaw('use the injected model', {
        executionContext: {
          callerContext: 'preserved',
          fileAccess: {
            version: 1,
            workspaceRoot: '/caller-selected-workspace',
            attachmentRoots: [],
          },
        },
      });
      expect(result).toMatchObject({
        status: 'success',
        output: 'injected adapter result',
      });
      const inspection = await sdk.inspect(result.runId);
      expect(inspection.run?.executionContext).toMatchObject({
        fileAccess: {
          version: 1,
          workspaceRoot: process.cwd(),
          attachmentRoots: [],
        },
        callerContext: 'preserved',
      });
      expect(generate).toHaveBeenCalledTimes(1);
    } finally {
      await sdk.close();
    }
  });

  it.each(['local', 'byok'] as const)('authorizes %s runs without sending prompts or provider keys to the gateway', async (inferenceMode) => {
    const authorizeRun = vi.fn(async (params: { runId: string; inferenceMode: 'local' | 'byok' }) => ({
      permitId: `permit-${params.runId}`,
      inferenceMode: params.inferenceMode,
      routePolicyVersion: 'policy-direct-v1',
      remoteCapabilities: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    }));
    const generateModel = vi.fn();
    const localGenerate = vi.fn(async () => ({ finishReason: 'stop' as const, text: `${inferenceMode} complete` }));
    const sdk = await createAgentSdk({
      cwd: process.cwd(),
      env: testEnvironment({ OPENROUTER_API_KEY: 'client-owned-provider-key' }),
      runtimeMode: 'memory',
      inferenceMode,
      gateway: { requireRunPermit: true },
      gatewayClient: { authorizeRun, generateModel } as unknown as GatewayClient,
      modelAdapter: {
        provider: inferenceMode === 'local' ? 'ollama' : 'openrouter',
        model: 'client-owned-model',
        capabilities: { toolCalling: true, jsonOutput: true, streaming: false, usage: true },
        generate: localGenerate,
      },
      agentConfig: {
        id: `${inferenceMode}-permit-agent`,
        name: `${inferenceMode} Permit Agent`,
        invocationModes: ['run'],
        defaultInvocationMode: 'run',
        model: { provider: 'openrouter', model: 'client-owned-model', apiKeyEnv: 'OPENROUTER_API_KEY' },
        tools: [],
      },
    });

    try {
      const goal = `private ${inferenceMode} prompt`;
      const result = await sdk.runRaw(goal);
      const inspection = await sdk.inspect(result.runId);

      expect(result).toMatchObject({ status: 'success', output: `${inferenceMode} complete` });
      expect(authorizeRun).toHaveBeenCalledWith({
        runId: result.runId,
        inferenceMode,
        profileRefs: [],
      });
      expect(JSON.stringify(authorizeRun.mock.calls)).not.toContain(goal);
      expect(JSON.stringify(authorizeRun.mock.calls)).not.toContain('client-owned-provider-key');
      expect(generateModel).not.toHaveBeenCalled();
      expect(localGenerate).toHaveBeenCalled();
      expect(inspection.run?.executionContext).toMatchObject({
        inferenceMode,
        authorizationRef: `permit-${result.runId}`,
        authorizationRunId: result.runId,
        routePolicyRef: 'policy-direct-v1',
      });
      expect(inspection.run?.executionContext).not.toHaveProperty('inferenceTier');
    } finally {
      await sdk.close();
    }
  });

  it('fails actionably before creating a local run when authorization is unavailable', async () => {
    const sdk = await createAgentSdk({
      cwd: process.cwd(),
      env: testEnvironment(),
      runtimeMode: 'memory',
      inferenceMode: 'gateway',
      gatewayClient: {
        authorizeRun: vi.fn(async () => { throw new GatewayTransportError(); }),
      } as unknown as GatewayClient,
      agentConfig: {
        id: 'gateway-unavailable-agent',
        name: 'Gateway Unavailable Agent',
        invocationModes: ['run'],
        defaultInvocationMode: 'run',
        model: { provider: 'ollama', model: 'unused-local-model' },
        tools: [],
      },
    });

    try {
      await expect(sdk.runRaw('must not be created', { sessionId: 'gateway-unavailable' }))
        .rejects.toThrow('Gateway network connection unavailable');
      await expect(sdk.created.runtime.runStore.listBySession?.('gateway-unavailable')).resolves.toEqual([]);
    } finally {
      await sdk.close();
    }
  });

  it('authorizes each run before local execution and safely supports per-run tiers and local tools', async () => {
    const authorizeRun = vi.fn(async (params: { runId: string; requestedTier?: string }) => ({
      permitId: `permit-${params.runId}`,
      inferenceMode: 'gateway' as const,
      inferenceTier: params.requestedTier as 'low' | 'high',
      routePolicyVersion: 'policy-v3',
      remoteCapabilities: [],
      expiresAt: '2026-07-28T00:00:00.000Z',
    }));
    const generateModel = vi.fn(async (params: ModelGenerateParams) => {
      const hasToolResult = params.messages.some((message) => message.role === 'tool');
      return {
        callId: params.invocation.callId,
        traceId: `trace-${params.tier}`,
        ...(hasToolResult
          ? { text: `completed-${params.tier}` }
          : { toolCalls: [{ id: `tool-${params.invocation.callId}`, name: 'local_echo', input: { text: params.tier } }] }),
        finishReason: hasToolResult ? 'stop' as const : 'tool_calls' as const,
        usage: {
          provider: 'ollama',
          model: `actual-${params.tier}`,
          inputTokens: 3,
          outputTokens: 2,
          totalTokens: 5,
          cost: 0.001,
        },
        routePolicyVersion: 'policy-v3',
        timings: { gatewayDurationMs: 9, providerDurationMs: 7, routeAttempts: 1 },
      };
    });
    const gatewayClient = { authorizeRun, generateModel } as unknown as GatewayClient;
    const localTool = vi.fn(async (input: { text: string }) => ({ echoed: input.text }));
    const sdk = await createAgentSdk({
      cwd: process.cwd(),
      env: testEnvironment(),
      runtimeMode: 'memory',
      inferenceMode: 'gateway',
      inferenceTier: 'medium',
      gatewayClient,
      agentConfig: {
        id: 'gateway-agent',
        name: 'Gateway Agent',
        invocationModes: ['run'],
        defaultInvocationMode: 'run',
        model: { provider: 'ollama', model: 'unused-local-model' },
        tools: ['local_echo'],
      },
      tools: [{
        name: 'local_echo',
        description: 'Echo locally',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['text'],
          properties: { text: { type: 'string' } },
        },
        execute: localTool,
      }],
    });

    try {
      const [low, high] = await Promise.all([
        sdk.runRaw('low tier run', {
          inferenceTier: 'low',
          executionContext: {
            inferenceMode: 'byok',
            inferenceTier: 'xtra-high',
            authorizationRef: 'caller-supplied-permit',
            authorizationRunId: 'caller-supplied-run',
            routePolicyRef: 'caller-supplied-policy',
            profileRefs: [{ source: 'server', id: 'caller', version: '1', contentHash: 'caller' }],
            callerContext: 'preserved',
          },
        }),
        sdk.runRaw('high tier run', { inferenceTier: 'high' }),
      ]);

      expect(low).toMatchObject({ status: 'success', output: 'completed-low' });
      expect(high).toMatchObject({ status: 'success', output: 'completed-high' });
      expect(authorizeRun.mock.calls.map(([params]) => params.requestedTier)).toEqual(['low', 'high']);
      expect(generateModel.mock.calls.map(([params]) => params.tier).sort()).toEqual(['high', 'high', 'low', 'low']);
      expect(localTool.mock.calls.map(([input]) => input.text)).toEqual(['low', 'high']);

      const lowInspection = await sdk.inspect(low.runId);
      expect(lowInspection.run?.executionContext).toMatchObject({
        inferenceMode: 'gateway',
        inferenceTier: 'low',
        authorizationRunId: low.runId,
        routePolicyRef: 'policy-v3',
        profileRefs: [],
        callerContext: 'preserved',
      });
      expect(JSON.stringify(lowInspection)).not.toContain('caller-supplied-permit');
      expect(JSON.stringify(lowInspection)).not.toContain('caller-supplied-policy');
      expect(lowInspection.events.find((event) => event.type === 'model.completed')?.payload).toMatchObject({
        callId: generateModel.mock.calls.find(([params]) => params.tier === 'low')?.[0].invocation.callId,
        provider: 'ollama',
        model: 'actual-low',
        performance: {
          adapter: {
            traceId: 'trace-low',
            requestedTier: 'low',
            routePolicyVersion: 'policy-v3',
          },
        },
      });
      expect(lowInspection.events.find((event) => event.type === 'usage.updated')?.payload).toMatchObject({
        usage: {
          promptTokens: 3,
          completionTokens: 2,
          provider: 'ollama',
          model: 'actual-low',
        },
      });
      expect(JSON.stringify(lowInspection)).not.toContain('access-token-value');
    } finally {
      await sdk.close();
    }
  });

  bunIt('completes memory-runtime SDK and CLI WSS runs with local tools between model turns', async () => {
    const cliDir = await mkdtemp(join(tmpdir(), 'agent-sdk-gateway-cli-'));
    const cliInputPath = join(cliDir, 'gateway-input.txt');
    await writeFile(cliInputPath, 'CLI-GATEWAY-CONTENT');
    const billing = new InMemoryBillingStore();
    const providerRequests: Parameters<ProviderAdapter['generate']>[0][] = [];
    const provider: ProviderAdapter = {
      provider: 'ollama',
      model: 'gateway-e2e-model',
      capabilities: {
        toolCalling: true,
        jsonOutput: true,
        streaming: true,
        usage: true,
      },
      async generate(request) {
        return this.stream!(request, () => undefined);
      },
      async stream(request, onEvent) {
        providerRequests.push(request);
        const hasLocalToolResult = request.messages.some((message) => message.role === 'tool');
        const usage = {
          promptTokens: 4,
          completionTokens: 2,
          totalTokens: 6,
          estimatedCostUSD: 0.002,
          provider: 'ollama',
          model: 'gateway-e2e-model',
        };
        if (hasLocalToolResult) {
          onEvent({ type: 'text_delta', delta: 'gateway complete' });
          return { text: 'gateway complete', finishReason: 'stop', usage };
        }
        const useSdkTool = request.tools?.some((tool) => tool.name === 'local_uppercase');
        if (useSdkTool) {
          return {
            toolCalls: [{ id: 'local-tool-call', name: 'local_uppercase', input: { text: 'client-side' } }],
            finishReason: 'tool_calls',
            usage,
          };
        }
        return {
          toolCalls: [{ id: 'local-tool-call', name: 'read_file', input: { path: cliInputPath } }],
          finishReason: 'tool_calls',
          usage,
        };
      },
    };
    const routeTarget = { provider: 'ollama', model: provider.model, maxConcurrency: 4 } as const;
    const tierPolicy = {
      limits: { maxMessages: 32, maxOutputTokens: 4096, modelTimeoutMs: 5000 },
      targets: [routeTarget],
    };
    const service = new GatewayService({
      routePolicy: validateRoutePolicy({
        version: 'policy-e2e',
        tiers: {
          low: structuredClone(tierPolicy),
          medium: structuredClone(tierPolicy),
          high: structuredClone(tierPolicy),
          'xtra-high': structuredClone(tierPolicy),
        },
      }),
      billingStore: billing,
      adapterFactory: () => provider,
    });
    const jwtSecret = 'phase-3-agent-sdk-gateway-test-secret';
    const server = startGatewayServer({
      authenticator: createJwtAuthenticator({
        hmacSecret: jwtSecret,
        issuer: 'agent-sdk-test',
        audience: 'capability-gateway',
      }),
      service,
      hostname: '127.0.0.1',
      port: 0,
    });
    const token = await new SignJWT({
      account_id: 'account-e2e',
      tenant_id: 'tenant-e2e',
      allowed_tiers: ['medium'],
      permitted_modes: ['gateway'],
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-e2e')
      .setIssuer('agent-sdk-test')
      .setAudience('capability-gateway')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(jwtSecret));
    const localTool = vi.fn(async (input: { text: string }) => ({ uppercased: input.text.toUpperCase() }));
    const sdk = await createAgentSdk({
      cwd: process.cwd(),
      env: testEnvironment(),
      runtimeMode: 'memory',
      inferenceMode: 'gateway',
      inferenceTier: 'medium',
      gateway: { url: server.url, requestTimeoutMs: 5000 },
      accessToken: () => token,
      agentConfig: {
        id: 'gateway-e2e-agent',
        name: 'Gateway E2E Agent',
        invocationModes: ['run'],
        defaultInvocationMode: 'run',
        model: { provider: 'ollama', model: 'unused-local-model' },
        tools: ['local_uppercase'],
      },
      tools: [{
        name: 'local_uppercase',
        description: 'Uppercase text on the client',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['text'],
          properties: { text: { type: 'string' } },
        },
        execute: localTool,
      }],
    });

    try {
      const result = await sdk.runRaw('Use the local uppercase tool');
      const inspection = await sdk.inspect(result.runId);

      expect(result).toMatchObject({ status: 'success', output: 'gateway complete' });
      expect(localTool).toHaveBeenCalledWith(
        { text: 'client-side' },
        expect.objectContaining({ runId: result.runId }),
      );
      expect(providerRequests).toHaveLength(2);
      expect(providerRequests[1]?.messages.some((message) => message.role === 'tool' && message.content.includes('CLIENT-SIDE'))).toBe(true);
      expect([...billing.records.values()]).toHaveLength(2);
      expect([...billing.records.values()].every((record) => record.status === 'completed')).toBe(true);
      expect(inspection.run?.executionContext).toMatchObject({
        inferenceMode: 'gateway',
        inferenceTier: 'medium',
        routePolicyRef: 'policy-e2e',
      });
      expect(inspection.events.filter((event) => event.type === 'model.completed')).toHaveLength(2);
      expect(JSON.stringify(inspection)).not.toContain(token);
      expect(JSON.stringify([...billing.records.values()])).not.toContain('Use the local uppercase tool');
      expect(JSON.stringify([...billing.records.values()])).not.toContain('CLIENT-SIDE');

      await writeAgentConfig(join(cliDir, 'agent.json'), 'gateway-cli-agent');
      await writeFile(join(cliDir, 'agent.settings.json'), JSON.stringify({
        runtime: { mode: 'memory' },
        gateway: { url: server.url, accessTokenEnv: 'PHASE_3_GATEWAY_CLI_TOKEN' },
      }));
      const previousToken = process.env.PHASE_3_GATEWAY_CLI_TOKEN;
      process.env.PHASE_3_GATEWAY_CLI_TOKEN = token;
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        const exitCode = await runCli([
          'run',
          'Read the local gateway input file',
          '--cwd', cliDir,
          '--runtime', 'memory',
          '--inference-mode', 'gateway',
          '--tier', 'medium',
          '--inspect',
          '--output', 'json',
        ]);
        const cliOutput = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
          resolvedConfig: { inferenceMode: string; inferenceTier: string; runtimeMode: string };
          result: { status: string; output: string };
          inspection: { run: { executionContext: Record<string, unknown> }; eventTypes: Record<string, number> };
        };

        expect(exitCode).toBe(0);
        expect(cliOutput.resolvedConfig).toMatchObject({ inferenceMode: 'gateway', inferenceTier: 'medium', runtimeMode: 'memory' });
        expect(cliOutput.result).toMatchObject({ status: 'success', output: 'gateway complete' });
        expect(cliOutput.inspection.run.executionContext).toMatchObject({ inferenceMode: 'gateway', inferenceTier: 'medium', routePolicyRef: 'policy-e2e' });
        expect(cliOutput.inspection.eventTypes).toMatchObject({ 'tool.completed': 1, 'model.completed': 2 });
        expect(providerRequests).toHaveLength(4);
        expect(providerRequests[3]?.messages.some((message) => message.role === 'tool' && message.content.includes('CLI-GATEWAY-CONTENT'))).toBe(true);
        expect(JSON.stringify(cliOutput)).not.toContain(token);
      } finally {
        log.mockRestore();
        if (previousToken === undefined) delete process.env.PHASE_3_GATEWAY_CLI_TOKEN;
        else process.env.PHASE_3_GATEWAY_CLI_TOKEN = previousToken;
      }
    } finally {
      await sdk.close();
      await server.stop({ gracePeriodMs: 100 });
      await rm(cliDir, { recursive: true, force: true });
    }
  });
});

async function writeAgentConfig(path: string, id = 'agent'): Promise<void> {
  await writeFile(
    path,
    JSON.stringify({
      id,
      name: id,
      invocationModes: ['chat', 'run'],
      defaultInvocationMode: 'chat',
      model: { provider: 'ollama', model: 'qwen3.5' },
      tools: ['read_file'],
    }),
  );
}
