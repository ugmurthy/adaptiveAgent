import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';
import { SignJWT } from 'jose';
import {
  GatewayService,
  InMemoryBillingStore,
  createJwtAuthenticator,
  startGatewayServer,
  validateRoutePolicy,
  type ProviderAdapter,
} from '@adaptive-agent/capability-gateway';
import type { ModelAdapter } from '@adaptive-agent/core';

import { AgentSdk, loadAgentSdkConfig, type AgentConfigFile } from './index.js';
import { testEnvironment } from './test-environment.js';

const temporaryDirectories: string[] = [];
const openSdks: AgentSdk[] = [];

afterEach(async () => {
  await Promise.all(openSdks.splice(0).map((sdk) => sdk.close()));
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Agent SDK SQLite runtime', () => {
  it('resolves and opens SQLite without DATABASE_URL', async () => {
    const directory = await temporaryDirectory();
    const home = join(directory, 'home');
    const config = await loadAgentSdkConfig({
      cwd: directory,
      env: testEnvironment({ HOME: home, ADAPTIVE_AGENT_HOME: home }),
      runtimeMode: 'sqlite',
      agentConfig: agentConfig([]),
    });

    expect(config.runtime).toEqual({
      requestedMode: 'sqlite',
      mode: 'sqlite',
      autoMigrate: true,
      sqlitePath: join(home, 'runtime.sqlite'),
    });

    const sdk = await AgentSdk.create({
      cwd: directory,
      env: testEnvironment({ HOME: home, ADAPTIVE_AGENT_HOME: home }),
      runtimeMode: 'sqlite',
      agentConfig: agentConfig([]),
      modelAdapter: finalModel({ durable: true }),
    });
    openSdks.push(sdk);
    expect(existsSync(join(home, 'runtime.sqlite'))).toBe(true);
  });

  it('reopens persisted runs and does not rerun a completed local tool on resume', async () => {
    const directory = await temporaryDirectory();
    const sqlitePath = join(directory, 'runtime.sqlite');
    const executeCalls: unknown[] = [];
    const options = {
      cwd: directory,
      env: testEnvironment({ HOME: directory, ADAPTIVE_AGENT_HOME: join(directory, 'home') }),
      runtimeMode: 'sqlite' as const,
      sqlitePath,
      agentConfig: agentConfig(['lookup']),
      tools: [{
        name: 'lookup',
        description: 'Look up local data.',
        inputSchema: { type: 'object', additionalProperties: true },
        execute: async (input: unknown) => {
          executeCalls.push(input);
          return { finding: 'fresh' };
        },
      }],
      modelAdapter: finalModel({ report: 'used durable tool result' }),
    };
    const first = await AgentSdk.create(options);
    const run = await first.created.runtime.runStore.createRun({
      id: 'resume-run',
      goal: 'Resume a completed local tool',
      status: 'interrupted',
    });
    await first.created.runtime.snapshotStore.save({
      runId: run.id,
      snapshotSeq: 1,
      status: 'interrupted',
      currentStepId: 'step-1',
      summary: { status: 'interrupted', stepsUsed: 0 },
      state: {
        schemaVersion: 1,
        messages: [
          { role: 'system', content: 'You are AdaptiveAgent.' },
          { role: 'user', content: '{"goal":"Resume a completed local tool"}' },
        ],
        stepsUsed: 0,
        pendingToolCall: {
          id: 'call-1',
          name: 'lookup',
          input: { topic: 'durability' },
          stepId: 'step-1',
        },
      },
    });
    const ledger = first.created.runtime.toolExecutionStore;
    if (!ledger) throw new Error('SQLite runtime did not provide a tool execution store');
    await ledger.markStarted({
      runId: run.id,
      stepId: 'step-1',
      toolCallId: 'call-1',
      toolName: 'lookup',
      idempotencyKey: `${run.id}:step-1:call-1`,
      inputHash: '{"topic":"durability"}',
    });
    await ledger.markCompleted(`${run.id}:step-1:call-1`, { finding: 'cached' });
    await first.close();

    const reopened = await AgentSdk.create(options);
    openSdks.push(reopened);
    const result = await reopened.resumeRaw(run.id);

    expect(result).toMatchObject({
      status: 'success',
      output: { report: 'used durable tool result' },
    });
    expect(executeCalls).toHaveLength(0);
    expect(await reopened.inspect(run.id)).toMatchObject({
      run: { id: run.id, status: 'succeeded' },
    });
  });

  it('completes and reopens a gateway run with a client-side tool', async () => {
    const directory = await temporaryDirectory();
    const sqlitePath = join(directory, 'gateway-runtime.sqlite');
    const billing = new InMemoryBillingStore();
    const providerRequests: Parameters<ProviderAdapter['generate']>[0][] = [];
    const provider: ProviderAdapter = {
      provider: 'ollama',
      model: 'sqlite-gateway-model',
      capabilities: { toolCalling: true, jsonOutput: true, streaming: true, usage: true },
      async generate(request) {
        return this.stream!(request, () => undefined);
      },
      async stream(request, onEvent) {
        providerRequests.push(request);
        const usage = {
          promptTokens: 4,
          completionTokens: 2,
          totalTokens: 6,
          estimatedCostUSD: 0.002,
          provider: 'ollama',
          model: 'sqlite-gateway-model',
        };
        if (request.messages.some((message) => message.role === 'tool')) {
          onEvent({ type: 'text_delta', delta: 'gateway complete' });
          return { text: 'gateway complete', finishReason: 'stop', usage };
        }
        return {
          toolCalls: [{ id: 'local-call', name: 'local_uppercase', input: { text: 'client-side' } }],
          finishReason: 'tool_calls',
          usage,
        };
      },
    };
    const target = { provider: 'ollama', model: provider.model, maxConcurrency: 2 } as const;
    const tier = {
      limits: { maxMessages: 32, maxOutputTokens: 4_096, modelTimeoutMs: 5_000 },
      targets: [target],
    };
    const service = new GatewayService({
      routePolicy: validateRoutePolicy({
        version: 'sqlite-policy-v1',
        tiers: {
          low: structuredClone(tier),
          medium: structuredClone(tier),
          high: structuredClone(tier),
          'xtra-high': structuredClone(tier),
        },
      }),
      billingStore: billing,
      adapterFactory: () => provider,
    });
    const secret = 'sqlite-gateway-test-secret-at-least-32-bytes';
    const server = startGatewayServer({
      authenticator: createJwtAuthenticator({
        hmacSecret: secret,
        issuer: 'sqlite-test',
        audience: 'capability-gateway',
      }),
      service,
      hostname: '127.0.0.1',
      port: 0,
    });
    const token = await new SignJWT({
      account_id: 'account-sqlite',
      tenant_id: 'tenant-sqlite',
      allowed_tiers: ['medium'],
      permitted_modes: ['gateway'],
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-sqlite')
      .setIssuer('sqlite-test')
      .setAudience('capability-gateway')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(secret));
    let localToolCalls = 0;
    const sdkOptions = {
      cwd: directory,
      env: testEnvironment({ HOME: directory, ADAPTIVE_AGENT_HOME: join(directory, 'home') }),
      runtimeMode: 'sqlite' as const,
      sqlitePath,
      inferenceMode: 'gateway' as const,
      inferenceTier: 'medium' as const,
      gateway: { url: server.url, requestTimeoutMs: 5_000 },
      accessToken: () => token,
      agentConfig: agentConfig(['local_uppercase']),
      tools: [{
        name: 'local_uppercase',
        description: 'Uppercase text locally.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['text'],
          properties: { text: { type: 'string' } },
        },
        execute: async (input: { text: string }) => {
          localToolCalls += 1;
          return { uppercased: input.text.toUpperCase() };
        },
      }],
    };

    try {
      const sdk = await AgentSdk.create(sdkOptions);
      const result = await sdk.runRaw('Use the local uppercase tool');
      await sdk.close();

      expect(result).toMatchObject({ status: 'success', output: 'gateway complete' });
      expect(result.usage).toMatchObject({
        promptTokens: 8,
        completionTokens: 4,
        totalTokens: 12,
        estimatedCostUSD: 0.004,
      });
      expect(localToolCalls).toBe(1);
      expect(providerRequests).toHaveLength(2);
      expect(providerRequests[1]?.messages.some(
        (message) => message.role === 'tool' && message.content.includes('CLIENT-SIDE'),
      )).toBe(true);
      expect([...billing.records.values()]).toHaveLength(2);

      const reopened = await AgentSdk.create({
        ...sdkOptions,
        inferenceMode: 'byok',
        modelAdapter: finalModel('unused'),
      });
      openSdks.push(reopened);
      const inspection = await reopened.inspect(result.runId);
      expect(inspection.run).toMatchObject({
        id: result.runId,
        status: 'succeeded',
        usage: {
          promptTokens: 8,
          completionTokens: 4,
          totalTokens: 12,
          estimatedCostUSD: 0.004,
          provider: 'ollama',
          model: 'sqlite-gateway-model',
        },
        executionContext: {
          inferenceMode: 'gateway',
          inferenceTier: 'medium',
          routePolicyRef: 'sqlite-policy-v1',
        },
      });
      expect(inspection.events.filter((event) => event.type === 'model.completed')).toHaveLength(2);
      expect(JSON.stringify(inspection)).not.toContain(token);
    } finally {
      await server.stop({ gracePeriodMs: 100 });
    }
  });
});

function agentConfig(tools: string[]): AgentConfigFile {
  return {
    id: 'sqlite-agent',
    name: 'SQLite Agent',
    invocationModes: ['run'],
    defaultInvocationMode: 'run',
    model: { provider: 'ollama', model: 'unused-local-model' },
    tools,
  };
}

function finalModel(output: unknown): ModelAdapter {
  return {
    provider: 'test',
    model: 'test-model',
    capabilities: { toolCalling: true, jsonOutput: true, streaming: false, usage: true },
    async generate() {
      return {
        structuredOutput: output as never,
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, estimatedCostUSD: 0 },
      };
    },
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-sdk-sqlite-'));
  temporaryDirectories.push(directory);
  return directory;
}
