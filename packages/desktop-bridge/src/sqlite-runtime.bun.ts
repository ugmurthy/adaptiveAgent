import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Database } from 'bun:sqlite';
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
      params: { runId: crypto.randomUUID(), goal: 'Write the requested artifact', inferenceMode: 'gateway', inferenceTier: 'medium' },
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

it('keeps three spawned sidecar runs and control responses correlated under SQLite concurrency', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'desktop-concurrency-'));
  const sqlitePath = join(cwd, 'runtime.sqlite');
  const runIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const entered: string[] = [];
  const gates = new Map<string, { resolve: () => void; promise: Promise<void> }>();
  let enteredResolve!: () => void;
  const allEntered = new Promise<void>((resolveEntered) => { enteredResolve = resolveEntered; });
  for (const runId of runIds) {
    let resolveGate!: () => void;
    const promise = new Promise<void>((resolve) => { resolveGate = resolve; });
    gates.set(runId, { resolve: resolveGate, promise });
  }
  const provider: ProviderAdapter = {
    provider: 'ollama',
    model: 'concurrency-stub',
    capabilities: { toolCalling: false, jsonOutput: true, streaming: true, usage: true },
    async generate(modelRequest) { return this.stream!(modelRequest, () => undefined); },
    async stream(modelRequest) {
      const runId = modelRequest.invocation.runId;
      entered.push(runId);
      if (entered.length === runIds.length) enteredResolve();
      await gates.get(runId)!.promise;
      return {
        text: `completed:${runId}`,
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
  };
  const target = { provider: provider.provider, model: provider.model, maxConcurrency: 3 } as const;
  const tier = { limits: { maxMessages: 32, maxOutputTokens: 2048, modelTimeoutMs: 10_000 }, targets: [target] };
  const service = new GatewayService({
    routePolicy: validateRoutePolicy({
      version: 'desktop-concurrency-policy',
      tiers: { low: tier, medium: tier, high: tier, 'xtra-high': tier },
    }),
    billingStore: new InMemoryBillingStore(),
    adapterFactory: () => provider,
  });
  const secret = 'desktop-concurrency-secret-at-least-32-bytes';
  const server = startGatewayServer({
    authenticator: createJwtAuthenticator({ hmacSecret: secret, issuer: 'desktop-test', audience: 'capability-gateway' }),
    service,
    hostname: '127.0.0.1',
    port: 0,
  });
  const token = await new SignJWT({
    account_id: 'desktop-account', tenant_id: 'desktop-tenant',
    allowed_tiers: ['medium'], permitted_modes: ['gateway'],
  })
    .setProtectedHeader({ alg: 'HS256' }).setSubject('desktop-user')
    .setIssuer('desktop-test').setAudience('capability-gateway').setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret));
  await writeFile(join(cwd, 'agent.json'), JSON.stringify({
    version: 1, id: 'concurrency-agent', name: 'Concurrency Agent',
    invocationModes: ['run'], defaultInvocationMode: 'run',
    model: { provider: 'ollama', model: 'unused' }, tools: [],
  }));

  const child = spawn('bun', [resolve(import.meta.dirname, 'main.ts')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const rpc = createRpcPeer(child.stdout, child.stdin);
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });

  try {
    await rpc.call('initialize', 'initialize', { protocolVersion: '1.12', clientInfo: { name: 'concurrency-test' } });
    await rpc.call('token', 'auth/updateAccessToken', { accessToken: token });
    await rpc.call('runtime', 'runtime/initialize', {
      cwd, agentConfigPath: join(cwd, 'agent.json'), runtimeMode: 'sqlite', sqlitePath,
      inferenceMode: 'gateway', inferenceTier: 'medium', gatewayUrl: server.url,
      approvalMode: 'auto', clarificationMode: 'fail',
    });

    const runs = runIds.map((runId, index) => rpc.call(`run-${index}`, 'agent/run', {
      runId, goal: `blocked run ${index}`, inferenceMode: 'gateway', inferenceTier: 'medium',
    }));
    await withTimeout(allEntered, 5_000, 'three provider calls did not enter');
    expect(new Set(entered)).toEqual(new Set(runIds));

    const inspection = await rpc.call('inspect-pending', 'run/inspect', { runId: runIds[1] });
    expect(inspection).toMatchObject({ run: { id: runIds[1] } });
    const interrupted = await rpc.call('interrupt-pending', 'run/interrupt', { runId: runIds[0] });
    expect(interrupted).toEqual({ runId: runIds[0], interrupted: true });

    // The provider is deliberately gate-controlled even after interruption, so release it
    // explicitly and then finish the remaining calls in reverse submission order.
    gates.get(runIds[0])!.resolve();
    gates.get(runIds[2])!.resolve();
    const third = await runs[2];
    gates.get(runIds[1])!.resolve();
    const [first, second] = await Promise.all([runs[0], runs[1]]);
    expect(third).toMatchObject({ runId: runIds[2], output: `completed:${runIds[2]}` });
    expect(second).toMatchObject({ runId: runIds[1], output: `completed:${runIds[1]}` });
    expect(first).toMatchObject({ runId: runIds[0] });

    await rpc.call('shutdown', 'runtime/shutdown', {});
    child.stdin.end();
    expect(await childExit(child)).toBe(0);
    expect(stderr).toBe('');

    const database = new Database(sqlitePath, { strict: true, readonly: true });
    try {
      const events = database.query('select run_id as runId, seq from agent_events where run_id in (?, ?, ?) order by run_id, seq')
        .all(...runIds) as Array<{ runId: string; seq: number }>;
      for (const runId of runIds) {
        const sequences = events.filter((event) => event.runId === runId).map((event) => event.seq);
        expect(sequences.length).toBeGreaterThan(0);
        expect(new Set(sequences).size).toBe(sequences.length);
        expect(sequences.every((seq, index) => index === 0 || seq > sequences[index - 1]!)).toBe(true);
      }
      expect(database.query('pragma foreign_key_check').all()).toEqual([]);
      expect(database.query('pragma integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally {
      database.close();
    }
  } finally {
    for (const gate of gates.values()) gate.resolve();
    if (child.exitCode === null) child.kill('SIGTERM');
    await server.stop({ gracePeriodMs: 100 });
    await rm(cwd, { recursive: true, force: true });
  }
}, 30_000);

function createRpcPeer(stdout: NodeJS.ReadableStream, stdin: NodeJS.WritableStream) {
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let buffer = '';
  stdout.on('data', (chunk) => {
    buffer += String(chunk);
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as { id?: string; result?: unknown; error?: { message: string } };
      if (message.id === undefined) continue;
      const waiter = pending.get(String(message.id));
      if (!waiter) continue;
      pending.delete(String(message.id));
      message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
    }
  });
  return {
    call(id: string, method: string, params: unknown): Promise<any> {
      const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return response;
    },
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer!));
}

function childExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', resolveExit);
  });
}

function request(value: Omit<DesktopRpcRequest, 'jsonrpc'>): DesktopRpcRequest {
  return { jsonrpc: '2.0', ...value } as DesktopRpcRequest;
}
