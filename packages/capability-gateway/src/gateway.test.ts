import { describe, expect, test } from 'bun:test';
import { SignJWT } from 'jose';
import type {
  InferenceTier,
  JsonRpcErrorResponse,
  ModelGenerateParams,
  ModelStreamNotification,
  RunAuthorizeResult,
} from '@adaptive-agent/gateway-protocol';
import {
  StreamSequenceValidator,
  validateModelStreamNotification,
  validateRpcResponse,
} from '@adaptive-agent/gateway-protocol';
import {
  createJwtAuthenticator,
  type GatewayPrincipal,
} from './auth.js';
import {
  billingInsertParameters,
  InMemoryBillingStore,
  type BillingRecord,
} from './billing.js';
import { ModelCallCache, stableModelRequestHash } from './call-cache.js';
import { GatewayError, gatewayError } from './errors.js';
import { GatewayService } from './gateway-service.js';
import { createMetadataLogger } from './logger.js';
import { defaultShutdownGraceMs, startupFailureStatus } from './main.js';
import { PermitService } from './permit.js';
import {
  AdapterPool,
  assertRoutePolicyEnvironment,
  type ProviderAdapter,
  type RouteTarget,
  validateRoutePolicy,
} from './route-policy.js';
import {
  RemoteToolRegistry,
  type RemoteToolProvider,
} from './remote-tools.js';
import {
  startGatewayServer,
  type GatewayServer,
  type GatewayServerOptions,
} from './server.js';

const JWT_SECRET = 'gateway-test-secret-that-is-at-least-32-bytes';
const JWT_KEY = new TextEncoder().encode(JWT_SECRET);

const principal: GatewayPrincipal = {
  subject: 'user-1',
  accountId: 'account-1',
  tenantId: 'tenant-1',
  allowedTiers: ['low', 'medium'],
  permittedModes: ['gateway'],
  expiresAtEpochSeconds: Math.floor(Date.now() / 1_000) + 3_600,
};

describe('JWT authentication', () => {
  const authenticate = createJwtAuthenticator({
    hmacSecret: JWT_SECRET,
    issuer: 'test-issuer',
    audience: 'capability-gateway',
  });

  test('accepts a valid bearer token and derives entitlements from claims', async () => {
    const token = await signToken();
    await expect(authenticate(`Bearer ${token}`)).resolves.toEqual(principal);
  });

  test('rejects absent, expired, wrong-issuer, and wrong-audience tokens', async () => {
    await expect(authenticate(null)).rejects.toMatchObject({
      gatewayCode: 'unauthenticated',
    });
    await expect(authenticate(`Bearer ${await signToken({ expiresIn: '-1s' })}`))
      .rejects.toMatchObject({ gatewayCode: 'token_expired' });
    await expect(authenticate(`Bearer ${await signToken({ issuer: 'wrong' })}`))
      .rejects.toMatchObject({ gatewayCode: 'unauthenticated' });
    await expect(authenticate(`Bearer ${await signToken({ audience: 'wrong' })}`))
      .rejects.toMatchObject({ gatewayCode: 'unauthenticated' });
  });

  test('rejects malformed entitlement claims', async () => {
    const token = await signToken({ claims: { allowed_tiers: ['unknown'] } });
    await expect(authenticate(`Bearer ${token}`)).rejects.toMatchObject({
      gatewayCode: 'forbidden',
    });
  });
});

describe('route policy and permits', () => {
  test('strictly validates all tiers, limits, targets, and API-key environment', () => {
    const policy = validateRoutePolicy(testPolicy());
    expect(policy.version).toBe('policy-v1');
    expect(defaultShutdownGraceMs(policy)).toBe(10_000);
    expect(() => validateRoutePolicy({
      ...(testPolicy() as Record<string, unknown>),
      unexpected: true,
    })).toThrow(
      'unknown field',
    );
    const incomplete = testPolicy() as Record<string, unknown>;
    delete (incomplete.tiers as Record<string, unknown>).high;
    expect(() => validateRoutePolicy(incomplete)).toThrow('tier high');

    const keyed = testPolicy([{ provider: 'mistral', model: 'model-a', apiKeyEnv: 'MODEL_KEY', maxConcurrency: 2 }]);
    const keyedPolicy = validateRoutePolicy(keyed);
    expect(() => assertRoutePolicyEnvironment(keyedPolicy, {})).toThrow('MODEL_KEY');
    expect(() => assertRoutePolicyEnvironment(keyedPolicy, { MODEL_KEY: 'configured' }))
      .not.toThrow();
  });

  test('binds permits to principal, run, gateway mode, tier, policy, and expiry', () => {
    let now = Date.now();
    const permits = new PermitService({ ttlMs: 100, now: () => now });
    const permit = permits.authorize(principal, authorizeParams(), 'policy-v1');
    expect(permits.verifyModelPermit(
      permit.id,
      principal,
      'low',
      'run-1',
      'policy-v1',
    ).id).toBe(permit.id);
    expect(() => permits.verifyModelPermit(
      permit.id,
      { ...principal, accountId: 'other-account' },
      'low',
      'run-1',
      'policy-v1',
    )).toThrow();
    expect(() => permits.authorize(
      { ...principal, permittedModes: ['local'] },
      authorizeParams(),
      'policy-v1',
    )).toThrow();
    now += 101;
    expect(() => permits.verifyModelPermit(
      permit.id,
      principal,
      'low',
      'run-1',
      'policy-v1',
    )).toThrow();
  });

  test('recovers adapter creation failures without corrupting concurrency limits', async () => {
    const policy = validateRoutePolicy(testPolicy());
    const target = policy.tiers.low.targets[0]!;
    let creations = 0;
    const pool = new AdapterPool(policy, async (route) => {
      creations += 1;
      if (creations === 1) throw new Error('transient adapter setup failure');
      return providerAdapter(route, async () => providerResponse(route, 'ok'));
    });

    const failed = await Promise.allSettled([
      pool.acquire(target),
      pool.acquire(target),
    ]);
    expect(failed.map((result) => result.status)).toEqual(['rejected', 'rejected']);

    const first = await pool.acquire(target);
    const second = await pool.acquire(target);
    await expect(pool.acquire(target)).rejects.toMatchObject({
      gatewayCode: 'rate_limited',
    });
    expect(creations).toBe(2);
    first.release();
    second.release();
    await pool.close();
  });
});

describe('idempotency, billing, errors, and logs', () => {
  test('shares/replays identical calls and rejects a changed request hash', () => {
    const cache = new ModelCallCache();
    const params = modelParams('permit-1', 'call-1');
    const hash = stableModelRequestHash(params);
    const first = cache.reserve(principal.accountId, 'call-1', hash);
    first.call.append({ type: 'start' });
    first.call.append({ type: 'text_delta', delta: 'hello' });

    const replayed: number[] = [];
    const second = cache.reserve(principal.accountId, 'call-1', hash);
    second.call.subscribe((event) => replayed.push(event.seq));
    expect(second.created).toBe(false);
    expect(replayed).toEqual([0, 1]);
    expect(() => cache.reserve(principal.accountId, 'call-1', 'different'))
      .toThrow();
  });

  test('stores one metadata-only row, protects terminal state, and scopes usage', async () => {
    const store = new InMemoryBillingStore();
    const active = billingRecord();
    expect(await store.begin(active)).toBe(true);
    expect(await store.begin(active)).toBe(false);
    const completed: BillingRecord = {
      ...active,
      status: 'completed',
      inputTokens: 3,
      outputTokens: 4,
      totalTokens: 7,
      cost: 0.01,
      updatedAt: '2026-01-01T00:00:01.000Z',
      completedAt: '2026-01-01T00:00:01.000Z',
    };
    await store.finish(completed);
    await store.finish(completed);
    await expect(store.finish({ ...completed, totalTokens: 8 })).rejects.toThrow();
    expect(store.records.size).toBe(1);
    expect(JSON.stringify(billingInsertParameters(completed))).not.toMatch(
      /prompt|message|response|tool|secret/i,
    );
    expect((await store.listUsage('other-account', usageParams())).items).toEqual([]);
    expect((await store.listUsage(principal.accountId, usageParams())).items)
      .toHaveLength(1);
  });

  test('sanitizes internal errors and enforces the metadata log allowlist', () => {
    const secret = 'https://provider.invalid?api_key=secret prompt contents';
    const publicError = gatewayError(new Error(secret)).toJsonRpc('trace-1');
    expect(JSON.stringify(publicError)).not.toContain(secret);
    expect(publicError.data?.gatewayCode).toBe('internal_error');

    const records: string[] = [];
    const logger = createMetadataLogger((record) => records.push(record));
    logger.log('info', 'tested', {
      accountId: 'account-1',
      prompt: secret,
      token: 'access-token',
    } as never);
    expect(records[0]).toContain('account-1');
    expect(records[0]).not.toContain(secret);
    expect(records[0]).not.toContain('access-token');
  });

  test('reports actionable startup configuration errors without leaking internals', () => {
    expect(startupFailureStatus(new Error('DATABASE_URL is required')))
      .toBe('DATABASE_URL is required');
    expect(startupFailureStatus(new Error(
      'invalid route policy: low.targets[0].model must be a bounded non-empty string',
    ))).toBe(
      'invalid route policy: low.targets[0].model must be a bounded non-empty string',
    );
    expect(startupFailureStatus(Object.assign(
      new Error('password authentication failed with secret details'),
      { code: '28P01' },
    ))).toBe('error_28P01');
    expect(startupFailureStatus(new Error('provider secret payload')))
      .toBe('startup_error');
  });
});

describe('routing service', () => {
  test('falls back deterministically on a transient error and commits selected usage', async () => {
    let firstCalls = 0;
    let secondCalls = 0;
    const billing = new InMemoryBillingStore();
    const service = new GatewayService({
      routePolicy: validateRoutePolicy(testPolicy([
        { provider: 'ollama', model: 'first', maxConcurrency: 2 },
        {
          provider: 'mistral',
          model: 'second',
          apiKeyEnv: 'MISTRAL_API_KEY',
          maxConcurrency: 2,
        },
      ])),
      billingStore: billing,
      adapterFactory: (target) => providerAdapter(target, async (_request, onEvent) => {
        if (target.model === 'first') {
          firstCalls += 1;
          throw new Error('transient provider payload that must not escape');
        }
        secondCalls += 1;
        onEvent({ type: 'text_delta', delta: 'ok' });
        return providerResponse(target, 'ok');
      }),
    });
    const permit = await service.handle(
      principal,
      'run/authorize',
      authorizeParams(),
      requestContext(),
    );
    const notifications: ModelStreamNotification[] = [];
    const result = await service.handle(
      principal,
      'model/generate',
      modelParams(permit.permitId, 'fallback-call'),
      requestContext((envelope) => notifications.push({
        jsonrpc: '2.0',
        method: 'model/stream',
        params: envelope,
      })),
    );

    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(1);
    expect(result.usage).toMatchObject({ provider: 'mistral', model: 'second' });
    expect(result.timings.routeAttempts).toBe(2);
    expect((await billing.get(principal.accountId, 'fallback-call')))
      .toMatchObject({ status: 'completed', selectedRouteIndex: 1, provider: 'mistral' });
    validateStream(notifications, 'fallback-call');
    await service.close();
  });

  test('does not fall back on non-retryable failures', async () => {
    let calls = 0;
    const service = new GatewayService({
      routePolicy: validateRoutePolicy(testPolicy([
        { provider: 'ollama', model: 'first', maxConcurrency: 2 },
        {
          provider: 'mistral',
          model: 'second',
          apiKeyEnv: 'MISTRAL_API_KEY',
          maxConcurrency: 2,
        },
      ])),
      adapterFactory: (target) => providerAdapter(target, async () => {
        calls += 1;
        throw new GatewayError('invalid_params');
      }),
    });
    const permit = await service.handle(
      principal,
      'run/authorize',
      authorizeParams(),
      requestContext(),
    );
    await expect(service.handle(
      principal,
      'model/generate',
      modelParams(permit.permitId, 'nonretryable-call'),
      requestContext(),
    )).rejects.toMatchObject({ gatewayCode: 'invalid_params' });
    expect(calls).toBe(1);
    await service.close();
  });

  test('enforces the configured model timeout and aborts provider consumption', async () => {
    const rawPolicy = testPolicy() as {
      tiers: Record<InferenceTier, { limits: { modelTimeoutMs: number } }>;
    };
    for (const tier of Object.values(rawPolicy.tiers)) {
      tier.limits.modelTimeoutMs = 5;
    }
    let providerAborted = false;
    const service = new GatewayService({
      routePolicy: validateRoutePolicy(rawPolicy),
      adapterFactory: (target) => providerAdapter(target, (request) =>
        new Promise((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => {
            providerAborted = true;
            reject(request.signal?.reason);
          }, { once: true });
        })),
    });
    const permit = await service.handle(
      principal,
      'run/authorize',
      authorizeParams(),
      requestContext(),
    );
    await expect(service.handle(
      principal,
      'model/generate',
      modelParams(permit.permitId, 'timeout-call'),
      requestContext(),
    )).rejects.toMatchObject({ gatewayCode: 'provider_timeout' });
    expect(providerAborted).toBe(true);
    await service.close();
  });

  test('skips routes that cannot satisfy requested model capabilities', async () => {
    let providerCalls = 0;
    const target = { provider: 'ollama', model: 'text-only', maxConcurrency: 2 } as const;
    const adapter = providerAdapter(target, async () => {
      providerCalls += 1;
      return providerResponse(target, 'unexpected');
    });
    adapter.capabilities.toolCalling = false;
    const service = new GatewayService({
      routePolicy: validateRoutePolicy(testPolicy([target])),
      adapterFactory: () => adapter,
    });
    const permit = await service.handle(
      principal,
      'run/authorize',
      authorizeParams(),
      requestContext(),
    );
    await expect(service.handle(
      principal,
      'model/generate',
      {
        ...modelParams(permit.permitId, 'unsupported-call'),
        tools: [{ name: 'lookup', inputSchema: { type: 'object' } }],
      },
      requestContext(),
    )).rejects.toMatchObject({ gatewayCode: 'capability_not_entitled' });
    expect(providerCalls).toBe(0);
    await service.close();
  });

  test('never turns a partial streamed tool call into a completed call', async () => {
    const target = { provider: 'ollama', model: 'partial-tools', maxConcurrency: 2 } as const;
    const billing = new InMemoryBillingStore();
    const service = new GatewayService({
      routePolicy: validateRoutePolicy(testPolicy([target])),
      billingStore: billing,
      adapterFactory: () => providerAdapter(target, async (_request, onEvent) => {
        onEvent({ type: 'tool_call_start', toolCallId: 'tool-1', name: 'lookup' });
        onEvent({
          type: 'tool_call_delta',
          toolCallId: 'tool-1',
          argumentsDelta: '{"query":"unfinished',
        });
        return providerResponse(target, '');
      }),
    });
    const permit = await service.handle(
      principal,
      'run/authorize',
      authorizeParams(),
      requestContext(),
    );
    const notifications: ModelStreamNotification[] = [];
    await expect(service.handle(
      principal,
      'model/generate',
      modelParams(permit.permitId, 'partial-tool-call'),
      requestContext((envelope) => notifications.push({
        jsonrpc: '2.0',
        method: 'model/stream',
        params: envelope,
      })),
    )).rejects.toMatchObject({ gatewayCode: 'provider_unavailable' });
    expect(notifications.map((entry) => entry.params.event.type))
      .toEqual(['start', 'tool_call_start', 'tool_call_delta', 'error']);
    expect(await billing.get(principal.accountId, 'partial-tool-call'))
      .toMatchObject({ status: 'failed' });
    await service.close();
  });
});

describe('Bun WebSocket gateway', () => {
  test('advertises and executes an idempotent remote tool over JSON-RPC', async () => {
    let providerCalls = 0;
    const remoteTools = await RemoteToolRegistry.create({
      tools: [{
        name: 'web_search@1',
        provider: 'brave',
        apiKeyEnv: 'SEARCH_KEY',
      }],
    }, { SEARCH_KEY: 'server-owned-secret' }, (config): RemoteToolProvider => ({
      provider: config.provider,
      operation: config.name,
      async execute() {
        providerCalls += 1;
        return {
          output: {
            query: 'gateway search',
            results: [{
              title: 'Gateway result',
              url: 'https://example.test/result',
              snippet: 'Result content',
            }],
          },
          units: 1,
          cost: 0.01,
          providerRequestId: 'provider-request-1',
        };
      },
    }));
    const billing = new InMemoryBillingStore();
    const target = { provider: 'ollama', model: 'stub-model', maxConcurrency: 4 } as const;
    const { server, token } = await integrationGateway(
      providerAdapter(target, async () => providerResponse(target, 'unused')),
      billing,
      {},
      remoteTools,
    );
    const client = await RpcClient.connect(server.url, token);
    try {
      const initialized = validateRpcResponse('initialize', await client.request('initialize', {
        protocolVersion: '1.0',
        clientName: 'gateway-tool-test',
        clientVersion: '0.1.0',
      }));
      expect('result' in initialized && initialized.result.remoteTools).toEqual([
        { name: 'web_search', schemaVersion: '1' },
      ]);
      const permit = await authorize(client);
      expect(permit.remoteCapabilities).toContain('web_search@1');
      const params = {
        permitId: permit.permitId,
        idempotencyKey: 'wss-tool-key',
        toolName: 'web_search@1',
        input: { query: 'gateway search' },
      };

      const first = validateRpcResponse(
        'tool/execute',
        await client.request('tool/execute', params),
      );
      const replay = validateRpcResponse(
        'tool/execute',
        await client.request('tool/execute', params),
      );

      expect('result' in first && first.result).toMatchObject({
        output: { query: 'gateway search' },
        providerRequestId: 'provider-request-1',
        diagnostics: { provider: 'brave', operation: 'web_search@1' },
      });
      expect('result' in replay && replay.result.cacheHit).toBe(true);
      expect(providerCalls).toBe(1);
      expect(billing.records.size).toBe(1);
    } finally {
      client.close();
      await server.stop({ gracePeriodMs: 100 });
    }
  });

  test('authenticates, initializes, authorizes, streams, responds, and bills once', async () => {
    let providerCalls = 0;
    const billing = new InMemoryBillingStore();
    const adapter = providerAdapter(
      { provider: 'ollama', model: 'stub-model', maxConcurrency: 4 },
      async (_request, onEvent) => {
        providerCalls += 1;
        onEvent({ type: 'text_delta', delta: 'hello ' });
        onEvent({ type: 'text_delta', delta: 'world' });
        onEvent({ type: 'reasoning', reasoning: 'private chain of thought' } as never);
        return {
          ...providerResponse(
            { provider: 'ollama', model: 'stub-model' },
            'hello world',
          ),
          reasoning: 'private chain of thought',
        } as never;
      },
    );
    const { server, token } = await integrationGateway(adapter, billing);
    const client = await RpcClient.connect(server.url, token);
    try {
      await initialize(client);
      const duplicateInitialize = await client.request('initialize', {
        protocolVersion: '1.0',
        clientName: 'gateway-test',
        clientVersion: '0.1.0',
      }) as JsonRpcErrorResponse;
      expect(duplicateInitialize.error.data?.gatewayCode).toBe('invalid_params');
      const permit = await authorize(client);
      const deniedTier = await client.request(
        'model/generate',
        modelParams(permit.permitId, 'denied-tier-call', 'medium'),
      ) as JsonRpcErrorResponse;
      expect(deniedTier.error.data?.gatewayCode).toBe('tier_not_entitled');
      expect(providerCalls).toBe(0);
      const params = modelParams(permit.permitId, 'vertical-call');
      const raw = await client.request('model/generate', params);
      const response = validateRpcResponse('model/generate', raw);
      expect('result' in response && response.result.text).toBe('hello world');
      expect(JSON.stringify(response)).not.toContain('private chain of thought');
      const streams = client.messages
        .filter((message) => message.method === 'model/stream')
        .map(validateModelStreamNotification);
      validateStream(streams, 'vertical-call');
      expect(providerCalls).toBe(1);
      expect(billing.records.size).toBe(1);

      const replay = validateRpcResponse(
        'model/generate',
        await client.request('model/generate', params),
      );
      expect('result' in replay).toBe(true);
      if ('result' in replay && 'result' in response) {
        expect(replay.result).toEqual(response.result);
      }
      expect(providerCalls).toBe(1);
      expect(billing.records.size).toBe(1);

      const conflict = await client.request('model/generate', {
        ...params,
        messages: [{ role: 'user', content: 'changed' }],
      }) as JsonRpcErrorResponse;
      expect(conflict.error.data?.gatewayCode).toBe('idempotency_conflict');
      expect(providerCalls).toBe(1);
    } finally {
      client.close();
      await server.stop({ gracePeriodMs: 100 });
    }
  });

  test('keeps a call alive across disconnect and replays it after reauthorization', async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    let providerCalls = 0;
    const billing = new InMemoryBillingStore();
    const target = { provider: 'ollama', model: 'slow-model', maxConcurrency: 4 } as const;
    const adapter = providerAdapter(target, async (_request, onEvent) => {
      providerCalls += 1;
      started.resolve();
      await release.promise;
      onEvent({ type: 'text_delta', delta: 'resumed' });
      return providerResponse(target, 'resumed');
    });
    const { server, token } = await integrationGateway(adapter, billing);
    const first = await RpcClient.connect(server.url, token);
    let second: RpcClient | undefined;
    try {
      await initialize(first);
      const firstPermit = await authorize(first);
      void first.request(
        'model/generate',
        modelParams(firstPermit.permitId, 'reconnect-call'),
      ).catch(() => undefined);
      await started.promise;
      await first.closeAndWait();

      second = await RpcClient.connect(server.url, token);
      await initialize(second);
      const secondPermit = await authorize(second);
      const retried = second.request(
        'model/generate',
        modelParams(secondPermit.permitId, 'reconnect-call'),
      );
      await Bun.sleep(10);
      expect(providerCalls).toBe(1);
      release.resolve();

      const response = validateRpcResponse('model/generate', await retried);
      expect('result' in response && response.result.text).toBe('resumed');
      validateStream(
        second.messages
          .filter((message) => message.method === 'model/stream')
          .map(validateModelStreamNotification),
        'reconnect-call',
      );
      expect(providerCalls).toBe(1);
      expect(billing.records.size).toBe(1);
    } finally {
      release.resolve();
      second?.close();
      first.close();
      await server.stop({ gracePeriodMs: 100 });
    }
  });

  test('enforces transport ordering and explicitly cancels provider work', async () => {
    const providerStarted = deferred<void>();
    const target = { provider: 'ollama', model: 'cancel-model', maxConcurrency: 4 } as const;
    const billing = new InMemoryBillingStore();
    const adapter = providerAdapter(target, (request) => new Promise((_resolve, reject) => {
      providerStarted.resolve();
      const abort = () => reject(new DOMException('cancelled provider details', 'AbortError'));
      if (request.signal?.aborted) abort();
      else request.signal?.addEventListener('abort', abort, { once: true });
    }));
    const { server, token } = await integrationGateway(adapter, billing);
    const client = await RpcClient.connect(server.url, token);
    try {
      const beforeInitialize = await client.request('run/authorize', authorizeParams()) as JsonRpcErrorResponse;
      expect(beforeInitialize.error.data?.gatewayCode).toBe('forbidden');
      client.sendRaw(JSON.stringify([]));
      const batchError = await client.waitFor(
        (message) => message.error?.code === -32600,
      );
      expect(batchError.id).toBeNull();

      await initialize(client);
      const permit = await authorize(client);
      const generate = client.request(
        'model/generate',
        modelParams(permit.permitId, 'cancel-call'),
      );
      await providerStarted.promise;
      const cancelled = await client.request('request/cancel', { callId: 'cancel-call' });
      expect(cancelled.result).toEqual({ cancelled: true });
      const failed = await generate as JsonRpcErrorResponse;
      expect(failed.error.data?.gatewayCode).toBe('cancelled');
      expect(JSON.stringify(failed)).not.toContain('cancelled provider details');
      expect(await billing.get(principal.accountId, 'cancel-call'))
        .toMatchObject({ status: 'cancelled' });
    } finally {
      client.close();
      await server.stop({ gracePeriodMs: 100 });
    }
  });

  test('rejects duplicate request IDs and bounds per-socket in-flight work', async () => {
    const providerStarted = deferred<void>();
    const release = deferred<void>();
    const target = { provider: 'ollama', model: 'bounded-model', maxConcurrency: 4 } as const;
    const adapter = providerAdapter(target, async (_request, onEvent) => {
      providerStarted.resolve();
      await release.promise;
      onEvent({ type: 'text_delta', delta: 'done' });
      return providerResponse(target, 'done');
    });
    const { server, token } = await integrationGateway(
      adapter,
      new InMemoryBillingStore(),
      { maxInFlightRequests: 1 },
    );
    const client = await RpcClient.connect(server.url, token);
    try {
      await initialize(client);
      const permit = await authorize(client);
      client.sendRequestWithId(
        'active-id',
        'model/generate',
        modelParams(permit.permitId, 'bounded-call'),
      );
      await providerStarted.promise;

      client.sendRequestWithId('active-id', 'account/usage', usageParams());
      const duplicate = await client.waitFor(
        (message) => message.id === 'active-id' &&
          message.error?.data?.gatewayCode === 'invalid_params',
      );
      expect(duplicate.error.data.gatewayCode).toBe('invalid_params');

      client.sendRequestWithId('over-limit', 'account/usage', usageParams());
      const overloaded = await client.waitFor(
        (message) => message.id === 'over-limit',
      );
      expect(overloaded.error.data.gatewayCode).toBe('rate_limited');

      release.resolve();
      const completed = await client.waitFor(
        (message) => message.id === 'active-id' && message.result !== undefined,
      );
      validateRpcResponse('model/generate', completed);
    } finally {
      release.resolve();
      client.close();
      await server.stop({ gracePeriodMs: 100 });
    }
  });

  test('graceful shutdown cancels bounded residual work and commits billing state', async () => {
    const providerStarted = deferred<void>();
    let providerAborted = false;
    const target = { provider: 'ollama', model: 'shutdown-model', maxConcurrency: 4 } as const;
    const billing = new InMemoryBillingStore();
    const adapter = providerAdapter(target, (request) => new Promise((_resolve, reject) => {
      providerStarted.resolve();
      request.signal?.addEventListener('abort', () => {
        providerAborted = true;
        reject(request.signal?.reason);
      }, { once: true });
    }));
    const { server, token } = await integrationGateway(adapter, billing);
    const client = await RpcClient.connect(server.url, token);
    await initialize(client);
    const permit = await authorize(client);
    void client.request(
      'model/generate',
      modelParams(permit.permitId, 'shutdown-call'),
    ).catch(() => undefined);
    await providerStarted.promise;

    await server.stop({ gracePeriodMs: 1 });
    expect(providerAborted).toBe(true);
    expect(await billing.get(principal.accountId, 'shutdown-call'))
      .toMatchObject({ status: 'cancelled' });
  });

  test('graceful shutdown drains calls that finish within the deadline', async () => {
    const providerStarted = deferred<void>();
    const release = deferred<void>();
    const target = { provider: 'ollama', model: 'drain-model', maxConcurrency: 4 } as const;
    const billing = new InMemoryBillingStore();
    const adapter = providerAdapter(target, async (_request, onEvent) => {
      providerStarted.resolve();
      await release.promise;
      onEvent({ type: 'text_delta', delta: 'drained' });
      return providerResponse(target, 'drained');
    });
    const { server, token } = await integrationGateway(adapter, billing);
    const client = await RpcClient.connect(server.url, token);
    await initialize(client);
    const permit = await authorize(client);
    const result = client.request(
      'model/generate',
      modelParams(permit.permitId, 'drained-call'),
    );
    await providerStarted.promise;
    setTimeout(() => release.resolve(), 20);

    await server.stop({ gracePeriodMs: 200 });
    const response = validateRpcResponse('model/generate', await result);
    expect('result' in response && response.result.text).toBe('drained');
    expect(await billing.get(principal.accountId, 'drained-call'))
      .toMatchObject({ status: 'completed' });
  });

  test('rejects missing upgrade auth, other paths, and binary frames', async () => {
    const target = { provider: 'ollama', model: 'stub-model', maxConcurrency: 4 } as const;
    const { server, token } = await integrationGateway(
      providerAdapter(target, async () => providerResponse(target, 'unused')),
      new InMemoryBillingStore(),
      { maxConnections: 1, maxFrameBytes: 256 },
    );
    try {
      await expect(RpcClient.connect(server.url)).rejects.toThrow();
      const httpUrl = server.url.replace('ws://', 'http://').replace('/rpc', '/other');
      expect((await fetch(httpUrl)).status).toBe(404);

      const client = await RpcClient.connect(server.url, token);
      await expect(RpcClient.connect(server.url, token)).rejects.toThrow();
      client.sendBinary(new Uint8Array([1, 2, 3]));
      expect(await client.closed).toBe(1003);

      const oversized = await RpcClient.connect(server.url, token);
      oversized.sendRaw('x'.repeat(257));
      expect([1006, 1009]).toContain(await oversized.closed);
    } finally {
      await server.stop({ gracePeriodMs: 100 });
    }
  });
});

async function integrationGateway(
  adapter: ProviderAdapter,
  billing: InMemoryBillingStore,
  serverOptions: Partial<GatewayServerOptions> = {},
  remoteTools?: RemoteToolRegistry,
): Promise<{ server: GatewayServer; token: string }> {
  const policy = validateRoutePolicy(testPolicy([{
    provider: adapter.provider as RouteTarget['provider'],
    model: adapter.model,
    maxConcurrency: 4,
  }]));
  const service = new GatewayService({
    routePolicy: policy,
    billingStore: billing,
    adapterFactory: () => adapter,
    remoteTools,
  });
  const server = startGatewayServer({
    authenticator: createJwtAuthenticator({
      hmacSecret: JWT_SECRET,
      issuer: 'test-issuer',
      audience: 'capability-gateway',
    }),
    service,
    hostname: '127.0.0.1',
    port: 0,
    idleTimeoutMs: 5_000,
    ...serverOptions,
  });
  return { server, token: await signToken() };
}

async function initialize(client: RpcClient): Promise<void> {
  const response = validateRpcResponse('initialize', await client.request('initialize', {
    protocolVersion: '1.0',
    clientName: 'gateway-test',
    clientVersion: '0.1.0',
  }));
  if ('error' in response) throw new Error(response.error.message);
}

async function authorize(client: RpcClient): Promise<RunAuthorizeResult> {
  const response = validateRpcResponse(
    'run/authorize',
    await client.request('run/authorize', authorizeParams()),
  );
  if ('error' in response) throw new Error(response.error.message);
  return response.result;
}

function validateStream(notifications: ModelStreamNotification[], callId: string): void {
  const sequence = new StreamSequenceValidator(callId);
  for (const notification of notifications) sequence.accept(notification.params);
  sequence.assertTerminal();
  expect(notifications.map((entry) => entry.params.seq))
    .toEqual(notifications.map((_, index) => index));
  expect(notifications[0]?.params.event.type).toBe('start');
  expect(notifications.at(-1)?.params.event.type).toBe('done');
}

function providerAdapter(
  target: Pick<RouteTarget, 'provider' | 'model' | 'maxConcurrency'>,
  stream: NonNullable<ProviderAdapter['stream']>,
): ProviderAdapter {
  return {
    provider: target.provider,
    model: target.model,
    capabilities: {
      toolCalling: true,
      jsonOutput: true,
      streaming: true,
      usage: true,
    },
    generate: (request) => stream(request, () => undefined),
    stream,
  };
}

function providerResponse(
  target: Pick<RouteTarget, 'provider' | 'model'>,
  text: string,
) {
  return {
    text,
    finishReason: 'stop' as const,
    providerResponseId: 'provider-response-1',
    usage: {
      promptTokens: 3,
      completionTokens: 2,
      totalTokens: 5,
      estimatedCostUSD: 0.001,
      provider: target.provider,
      model: target.model,
    },
  };
}

function testPolicy(targets: RouteTarget[] = [{
  provider: 'ollama',
  model: 'model-a',
  maxConcurrency: 2,
}]): unknown {
  const tier = {
    limits: {
      maxMessages: 16,
      maxOutputTokens: 4_096,
      modelTimeoutMs: 5_000,
    },
    targets,
  };
  return {
    version: 'policy-v1',
    tiers: {
      low: structuredClone(tier),
      medium: structuredClone(tier),
      high: structuredClone(tier),
      'xtra-high': structuredClone(tier),
    },
  };
}

function authorizeParams() {
  return {
    runId: 'run-1',
    inferenceMode: 'gateway' as const,
    requestedTier: 'low' as const,
    profileRefs: [],
  };
}

function modelParams(
  permitId: string,
  callId: string,
  tier: InferenceTier = 'low',
): ModelGenerateParams {
  return {
    permitId,
    tier,
    invocation: {
      runId: 'run-1',
      rootRunId: 'run-1',
      stepId: 'step-1',
      purpose: 'agent_turn',
      callId,
      attempt: 1,
    },
    messages: [{ role: 'user', content: 'hello' }],
    maxOutputTokens: 100,
  };
}

function requestContext(
  notify: (envelope: ModelStreamNotification['params']) => void = () => undefined,
) {
  return { traceId: crypto.randomUUID(), notify };
}

function billingRecord(): BillingRecord {
  return {
    accountId: principal.accountId,
    tenantId: principal.tenantId,
    subject: principal.subject,
    permitId: 'permit-1',
    capability: 'model/generate',
    callId: 'billing-call',
    requestHash: 'request-hash',
    requestedTier: 'low',
    routePolicyVersion: 'policy-v1',
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cost: 0,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function usageParams() {
  return {
    from: '2025-01-01T00:00:00.000Z',
    to: '2027-01-01T00:00:00.000Z',
  };
}

interface SignTokenOptions {
  issuer?: string;
  audience?: string;
  expiresIn?: string;
  claims?: Record<string, unknown>;
}

async function signToken(options: SignTokenOptions = {}): Promise<string> {
  return new SignJWT({
    account_id: principal.accountId,
    tenant_id: principal.tenantId,
    allowed_tiers: principal.allowedTiers,
    permitted_modes: principal.permittedModes,
    ...options.claims,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(principal.subject)
    .setIssuer(options.issuer ?? 'test-issuer')
    .setAudience(options.audience ?? 'capability-gateway')
    .setExpirationTime(options.expiresIn ?? '1h')
    .sign(JWT_KEY);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class RpcClient {
  readonly messages: Array<Record<string, any>> = [];
  readonly closed: Promise<number>;
  private nextId = 1;
  private readonly waiters = new Set<{
    predicate: (message: Record<string, any>) => boolean;
    resolve: (message: Record<string, any>) => void;
    reject: (error: Error) => void;
    timer: Timer;
  }>();

  private constructor(readonly socket: WebSocket) {
    this.closed = new Promise((resolve) => {
      socket.addEventListener('close', (event) => {
        resolve(event.code);
        this.rejectWaiters(new Error(`WebSocket closed (${event.code})`));
      }, { once: true });
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as Record<string, any>;
      this.messages.push(message);
      for (const waiter of this.waiters) {
        if (!waiter.predicate(message)) continue;
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.resolve(message);
      }
    });
  }

  static async connect(url: string, token?: string): Promise<RpcClient> {
    const socket = new WebSocket(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    } as never);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket open timed out')), 2_000);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('WebSocket upgrade rejected'));
      }, { once: true });
    });
    return new RpcClient(socket);
  }

  async request(method: string, params: unknown): Promise<Record<string, any>> {
    const id = this.nextId++;
    const response = this.waitFor((message) => message.id === id);
    this.sendRaw(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return response;
  }

  waitFor(
    predicate: (message: Record<string, any>) => boolean,
    timeoutMs = 2_000,
  ): Promise<Record<string, any>> {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error('Timed out waiting for gateway frame'));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  sendRaw(frame: string): void {
    this.socket.send(frame);
  }

  sendRequestWithId(id: string | number, method: string, params: unknown): void {
    this.sendRaw(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  }

  sendBinary(frame: Uint8Array): void {
    this.socket.send(frame);
  }

  close(): void {
    this.socket.close();
  }

  async closeAndWait(): Promise<void> {
    this.close();
    await this.closed;
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }
}
