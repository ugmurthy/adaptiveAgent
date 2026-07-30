import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'bun:test';
import { SignJWT } from 'jose';
import {
  GatewayService,
  InMemoryBillingStore,
  createJwtAuthenticator,
  startGatewayServer,
  validateRoutePolicy,
  type ProviderAdapter,
} from '@adaptive-agent/capability-gateway';

import type { DesktopRpcRequest } from './protocol.js';
import { DesktopRuntime, type CliExecutionRequest, type CliExecutor } from './runtime.js';

it('defaults the desktop runtime to SQLite and points CLI children at the initialized database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-bridge-sqlite-'));
  const agentPath = join(directory, 'agent.json');
  const settingsPath = join(directory, 'agent.settings.json');
  const sqlitePath = join(directory, 'desktop.sqlite');
  let execution: CliExecutionRequest | undefined;
  const executor: CliExecutor = {
    async execute(request) {
      execution = request;
      return { exitCode: 0, timedOut: false };
    },
  };
  const runtime = new DesktopRuntime(() => undefined, executor);

  try {
    await writeFile(agentPath, JSON.stringify({
      id: 'desktop-sqlite-agent',
      name: 'Desktop SQLite Agent',
      invocationModes: ['run'],
      defaultInvocationMode: 'run',
      model: { provider: 'ollama', model: 'qwen3.5' },
      tools: [],
    }));
    await writeFile(settingsPath, JSON.stringify({ runtime: { sqlitePath: './desktop.sqlite' } }));
    await runtime.handleRpc(request({
      id: 'initialize',
      method: 'initialize',
      params: { protocolVersion: '1.10', clientInfo: { name: 'desktop-test' } },
    }));

    const initialized = await runtime.handleRpc(request({
      id: 'runtime',
      method: 'runtime/initialize',
      params: { cwd: directory, agentConfigPath: agentPath, settingsConfigPath: settingsPath },
    }));
    expect(initialized).toMatchObject({ runtimeMode: 'sqlite' });
    expect(existsSync(sqlitePath)).toBe(true);

    await runtime.handleRpc(request({
      id: 'inspect',
      method: 'cli/execute',
      params: { argv: ['inspect', 'run-1'] },
    }));
    expect(execution).toMatchObject({
      argv: ['inspect', 'run-1', '--output', 'json', '--runtime', 'sqlite'],
      environment: { ADAPTIVE_AGENT_SQLITE_PATH: sqlitePath },
    });
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('runs remote inference in SQLite while writing artifacts locally', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'desktop-gateway-'));
  const artifactPath = join(cwd, 'gateway-artifact.txt');
  const provider: ProviderAdapter = {
    provider: 'ollama',
    model: 'stub-model',
    capabilities: { toolCalling: true, jsonOutput: true, streaming: true, usage: true },
    async generate(modelRequest) { return this.stream!(modelRequest, () => undefined); },
    async stream(modelRequest) {
      const hasToolResult = modelRequest.messages.some((message) => message.role === 'tool');
      const usage = {
        promptTokens: 4,
        completionTokens: 2,
        totalTokens: 6,
        estimatedCostUSD: 0.001,
        provider: 'ollama',
        model: 'stub-model',
      };
      return hasToolResult
        ? { text: 'artifact written', finishReason: 'stop', usage }
        : {
            toolCalls: [{
              id: 'write-artifact',
              name: 'write_file',
              input: { path: 'gateway-artifact.txt', content: 'written by the local desktop runtime\n' },
            }],
            finishReason: 'tool_calls',
            usage,
          };
    },
  };
  const target = { provider: provider.provider, model: provider.model, maxConcurrency: 2 } as const;
  const tier = { limits: { maxMessages: 32, maxOutputTokens: 2048, modelTimeoutMs: 5000 }, targets: [target] };
  const service = new GatewayService({
    routePolicy: validateRoutePolicy({
      version: 'desktop-policy',
      tiers: { low: tier, medium: tier, high: tier, 'xtra-high': tier },
    }),
    billingStore: new InMemoryBillingStore(),
    adapterFactory: () => provider,
  });
  const secret = 'desktop-phase-7-test-secret-at-least-32-bytes';
  const server = startGatewayServer({
    authenticator: createJwtAuthenticator({ hmacSecret: secret, issuer: 'desktop-test', audience: 'capability-gateway' }),
    service,
    hostname: '127.0.0.1',
    port: 0,
  });
  const token = await new SignJWT({
    account_id: 'desktop-account',
    tenant_id: 'desktop-tenant',
    allowed_tiers: ['medium'],
    permitted_modes: ['gateway'],
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('desktop-user')
    .setIssuer('desktop-test')
    .setAudience('capability-gateway')
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret));
  await writeFile(join(cwd, 'agent.json'), JSON.stringify({
    version: 1,
    id: 'desktop-gateway-agent',
    name: 'Desktop Gateway Agent',
    invocationModes: ['run'],
    defaultInvocationMode: 'run',
    model: { provider: 'ollama', model: 'unused' },
    tools: ['write_file'],
  }));
  const runtime = new DesktopRuntime(() => undefined);

  try {
    await runtime.handleRpc(request({
      id: 'init',
      method: 'initialize',
      params: { protocolVersion: '1.11', clientInfo: { name: 'swift-smoke' } },
    }));
    await runtime.handleRpc(request({
      id: 'token',
      method: 'auth/updateAccessToken',
      params: { accessToken: token },
    }));
    const initialized = await runtime.handleRpc(request({
      id: 'runtime',
      method: 'runtime/initialize',
      params: {
        cwd,
        agentConfigPath: join(cwd, 'agent.json'),
        runtimeMode: 'sqlite',
        sqlitePath: join(cwd, 'runtime.sqlite'),
        inferenceMode: 'gateway',
        inferenceTier: 'medium',
        gatewayUrl: server.url,
        approvalMode: 'auto',
      },
    }));
    expect(initialized).toMatchObject({
      runtimeMode: 'sqlite',
      inferenceMode: 'gateway',
      connections: { sqlite: 'connected', gateway: 'disconnected' },
    });

    const result = await runtime.handleRpc(request({
      id: 'run',
      method: 'agent/run',
      params: { goal: 'Write the requested artifact', inferenceMode: 'gateway', inferenceTier: 'medium' },
    }));
    expect(result).toMatchObject({ status: 'success', output: 'artifact written' });
    expect(await readFile(artifactPath, 'utf8')).toBe('written by the local desktop runtime\n');
    const info = await runtime.handleRpc(request({ id: 'info', method: 'runtime/info' }));
    expect(info).toMatchObject({
      connections: {
        sqlite: { configured: true, state: 'connected', path: join(cwd, 'runtime.sqlite') },
        gateway: { configured: true, state: 'connected' },
      },
    });
    expect(JSON.stringify(info)).not.toContain(token);
  } finally {
    await runtime.close();
    await server.stop({ gracePeriodMs: 100 });
    await rm(cwd, { recursive: true, force: true });
  }
}, 30_000);

function request(value: Omit<DesktopRpcRequest, 'jsonrpc'>): DesktopRpcRequest {
  return { jsonrpc: '2.0', ...value } as DesktopRpcRequest;
}
