import { describe, expect, test } from 'bun:test';
import { RemoteToolRegistry, stableToolRequestHash, type RemoteToolProvider } from './remote-tools.js';
import { ToolCallCache } from './call-cache.js';
import type { JsonObject, JsonValue } from '@adaptive-agent/gateway-protocol';
import type { GatewayPrincipal } from './auth.js';
import { InMemoryBillingStore } from './billing.js';
import { GatewayService } from './gateway-service.js';
import { validateRoutePolicy } from './route-policy.js';

const searchPolicy = {
  tools: [{ name: 'web_search@1' as const, provider: 'brave' as const, apiKeyEnv: 'SEARCH_KEY', timeoutMs: 1000, maxOutputBytes: 1024 }],
};

describe('remote tool registry', () => {
  test('advertises only configured versioned tools and rejects unsafe provider wiring', async () => {
    const registry = await RemoteToolRegistry.create(searchPolicy, { SEARCH_KEY: 'secret' }, fakeFactory());
    expect(registry.descriptors()).toEqual([{ name: 'web_search', schemaVersion: '1' }]);
    expect(registry.has('anything@1')).toBe(false);
    await expect(RemoteToolRegistry.create({ tools: [{ name: 'read_web_page@1', provider: 'brave', apiKeyEnv: 'KEY' }] } as never, { KEY: 'secret' }, fakeFactory())).rejects.toThrow('unsupported');
    expect((await RemoteToolRegistry.create(undefined)).descriptors()).toEqual([]);
  });

  test('strictly bounds search and read inputs, URLs, output, and timeout', async () => {
    let effectiveTimeoutMs: number | undefined;
    const search = await RemoteToolRegistry.create(searchPolicy, { SEARCH_KEY: 'secret' }, fakeFactory());
    await expect(search.execute('web_search@1', 'a', { query: 'ok', unknown: true }, 500, 'k', new AbortController().signal)).rejects.toMatchObject({ gatewayCode: 'invalid_params' });
    await expect(search.execute('web_search@1', 'a', { query: 'x'.repeat(2049) }, 500, 'k', new AbortController().signal)).rejects.toMatchObject({ gatewayCode: 'invalid_params' });
    const read = await RemoteToolRegistry.create({ tools: [{ name: 'read_web_page@1', provider: 'parallel', apiKeyEnv: 'KEY', timeoutMs: 1000 }] }, { KEY: 'secret' }, fakeFactory());
    for (const url of ['file:///etc/passwd', 'https://user:pass@example.com']) await expect(read.execute('read_web_page@1', 'a', { url }, 500, url, new AbortController().signal)).rejects.toMatchObject({ gatewayCode: 'invalid_params' });
    const clamped = await RemoteToolRegistry.create(
      searchPolicy,
      { SEARCH_KEY: 'secret' },
      fakeFactory(async (_input, _signal, timeoutMs) => {
        effectiveTimeoutMs = timeoutMs;
        return { results: [] };
      }),
    );
    await clamped.execute(
      'web_search@1',
      'a',
      { query: 'ok' },
      90_000,
      'timeout',
      new AbortController().signal,
    );
    expect(effectiveTimeoutMs).toBe(1_000);

    const boundedOutput = await RemoteToolRegistry.create(
      { tools: [{ ...searchPolicy.tools[0]!, maxOutputBytes: 32 }] },
      { SEARCH_KEY: 'secret' },
      fakeFactory(async () => ({ content: 'x'.repeat(64) })),
    );
    await expect(boundedOutput.execute(
      'web_search@1',
      'a',
      { query: 'ok' },
      undefined,
      'oversized-output',
      new AbortController().signal,
    )).rejects.toMatchObject({ gatewayCode: 'provider_unavailable', retryable: false });
  });

  test('passes cancellation and enforces provider concurrency and account quota', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const registry = await RemoteToolRegistry.create({ tools: [{ ...searchPolicy.tools[0]!, maxConcurrency: 1, accountQuota: 1 }] }, { SEARCH_KEY: 'secret' }, fakeFactory(async (_input, signal) => { await Promise.race([blocked, new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))]); return { results: [] }; }));
    const controller = new AbortController();
    const first = registry.execute('web_search@1', 'a', { query: 'one' }, 500, 'one', controller.signal);
    await expect(registry.execute('web_search@1', 'b', { query: 'two' }, 500, 'two', new AbortController().signal)).rejects.toMatchObject({ gatewayCode: 'rate_limited' });
    controller.abort();
    await expect(first).rejects.toMatchObject({ gatewayCode: 'cancelled' });
    release();
    await expect(registry.execute('web_search@1', 'a', { query: 'again' }, 500, 'three', new AbortController().signal)).rejects.toMatchObject({ gatewayCode: 'quota_exceeded' });
  });

  test('hash excludes permits and cache shares active/terminal calls while detecting conflicts', () => {
    const base = { idempotencyKey: 'key', toolName: 'web_search@1', input: { query: 'safe' } };
    expect(stableToolRequestHash({ ...base, permitId: 'one' })).toBe(stableToolRequestHash({ ...base, permitId: 'two' }));
    expect(stableToolRequestHash({ ...base, permitId: 'one', timeoutMs: 500 })).toBe(
      stableToolRequestHash({ ...base, permitId: 'one', timeoutMs: 1_000 }),
    );
    const cache = new ToolCallCache();
    const first = cache.reserve('account', 'key', 'hash');
    expect(cache.reserve('account', 'key', 'hash').created).toBe(false);
    first.call.succeed({ idempotencyKey: 'key', output: { results: [] } });
    expect(cache.reserve('account', 'key', 'hash').created).toBe(false);
    expect(() => cache.reserve('account', 'key', 'changed')).toThrow();
  });
});

describe('gateway remote tool execution', () => {
  test('revalidates permits and replays one provider invocation and billing row', async () => {
    let providerCalls = 0;
    const billing = new InMemoryBillingStore();
    const remoteTools = await RemoteToolRegistry.create(
      searchPolicy,
      { SEARCH_KEY: 'server-owned-secret' },
      fakeFactory(async () => {
        providerCalls += 1;
        return {
          query: 'private query',
          results: [{ title: 'Result', url: 'https://example.test', snippet: 'private output' }],
        };
      }),
    );
    const service = gatewayService(remoteTools, billing);
    const authorization = await authorize(service);
    expect(authorization.remoteCapabilities).toContain('web_search@1');
    const params = {
      permitId: authorization.permitId,
      idempotencyKey: 'run:step:tool',
      toolName: 'web_search@1',
      input: { query: 'private query' },
      timeoutMs: 90_000,
    };

    const first = await service.handle(TEST_PRINCIPAL, 'tool/execute', params, requestContext());
    const replay = await service.handle(TEST_PRINCIPAL, 'tool/execute', params, requestContext());

    expect(first).toMatchObject({
      idempotencyKey: params.idempotencyKey,
      usage: { units: 1, cost: 0.01 },
      diagnostics: { provider: 'brave', operation: 'web_search@1' },
    });
    expect(replay.cacheHit).toBe(true);
    expect(providerCalls).toBe(1);
    expect(billing.records.size).toBe(1);
    expect(await billing.get(TEST_PRINCIPAL.accountId, params.idempotencyKey)).toMatchObject({
      capability: 'web_search@1',
      provider: 'brave',
      units: 1,
      cost: 0.01,
      status: 'completed',
    });
    expect(JSON.stringify([...billing.records.values()])).not.toContain('private query');
    expect(JSON.stringify([...billing.records.values()])).not.toContain('private output');

    await expect(service.handle(TEST_PRINCIPAL, 'tool/execute', {
      ...params,
      input: { query: 'changed' },
    }, requestContext())).rejects.toMatchObject({ gatewayCode: 'idempotency_conflict' });
    await expect(service.handle(TEST_PRINCIPAL, 'tool/execute', {
      ...params,
      idempotencyKey: 'unknown-tool',
      toolName: 'shell_exec',
    }, requestContext())).rejects.toMatchObject({ gatewayCode: 'capability_not_entitled' });
    await service.close();
  });

  test('allows core to retry a transient failure with the same idempotency key', async () => {
    let providerCalls = 0;
    const billing = new InMemoryBillingStore();
    const remoteTools = await RemoteToolRegistry.create(
      searchPolicy,
      { SEARCH_KEY: 'server-owned-secret' },
      fakeFactory(async () => {
        providerCalls += 1;
        if (providerCalls === 1) throw new Error('transient provider details');
        return { query: 'retry', results: [] };
      }),
    );
    const service = gatewayService(remoteTools, billing);
    const authorization = await authorize(service);
    const params = {
      permitId: authorization.permitId,
      idempotencyKey: 'retryable-tool',
      toolName: 'web_search@1',
      input: { query: 'retry' },
    };

    await expect(service.handle(
      TEST_PRINCIPAL,
      'tool/execute',
      params,
      requestContext(),
    )).rejects.toMatchObject({ gatewayCode: 'provider_unavailable' });
    expect(await billing.get(TEST_PRINCIPAL.accountId, params.idempotencyKey))
      .toMatchObject({ status: 'failed' });

    await expect(service.handle(
      TEST_PRINCIPAL,
      'tool/execute',
      params,
      requestContext(),
    )).resolves.toMatchObject({ output: { query: 'retry', results: [] } });
    expect(providerCalls).toBe(2);
    expect(billing.records.size).toBe(1);
    expect(await billing.get(TEST_PRINCIPAL.accountId, params.idempotencyKey))
      .toMatchObject({ status: 'completed' });
    await service.close();
  });

  test('cancels active provider work and records a cancelled terminal state', async () => {
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => { providerStarted = resolve; });
    const billing = new InMemoryBillingStore();
    const remoteTools = await RemoteToolRegistry.create(
      searchPolicy,
      { SEARCH_KEY: 'server-owned-secret' },
      fakeFactory(async (_input, signal) => {
        providerStarted();
        await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        return { results: [] };
      }),
    );
    const service = gatewayService(remoteTools, billing);
    const authorization = await authorize(service);
    const idempotencyKey = 'cancelled-tool';
    const execution = service.handle(TEST_PRINCIPAL, 'tool/execute', {
      permitId: authorization.permitId,
      idempotencyKey,
      toolName: 'web_search@1',
      input: { query: 'cancel me' },
    }, requestContext());
    await started;

    await expect(service.handle(TEST_PRINCIPAL, 'request/cancel', {
      idempotencyKey,
    }, requestContext())).resolves.toEqual({ cancelled: true });
    await expect(execution).rejects.toMatchObject({ gatewayCode: 'cancelled' });
    expect(await billing.get(TEST_PRINCIPAL.accountId, idempotencyKey))
      .toMatchObject({ status: 'cancelled' });
    await service.close();
  });
});

const TEST_PRINCIPAL: GatewayPrincipal = {
  subject: 'remote-tool-user',
  accountId: 'remote-tool-account',
  tenantId: 'remote-tool-tenant',
  allowedTiers: ['low'],
  permittedModes: ['gateway'],
  expiresAtEpochSeconds: Math.floor(Date.now() / 1_000) + 3_600,
};

function gatewayService(
  remoteTools: RemoteToolRegistry,
  billingStore: InMemoryBillingStore,
): GatewayService {
  return new GatewayService({
    routePolicy: validateRoutePolicy(testRoutePolicy()),
    remoteTools,
    billingStore,
  });
}

async function authorize(service: GatewayService) {
  return service.handle(TEST_PRINCIPAL, 'run/authorize', {
    runId: 'remote-tool-run',
    inferenceMode: 'gateway',
    requestedTier: 'low',
    profileRefs: [],
  }, requestContext());
}

function requestContext() {
  return { traceId: crypto.randomUUID(), notify: () => undefined };
}

function testRoutePolicy(): unknown {
  const tier = {
    limits: { maxMessages: 16, maxOutputTokens: 4_096, modelTimeoutMs: 5_000 },
    targets: [{ provider: 'ollama', model: 'unused', maxConcurrency: 1 }],
  };
  return {
    version: 'remote-tool-policy-v1',
    tiers: {
      low: structuredClone(tier),
      medium: structuredClone(tier),
      high: structuredClone(tier),
      'xtra-high': structuredClone(tier),
    },
  };
}

function fakeFactory(
  execute: (
    input: JsonObject,
    signal: AbortSignal,
    timeoutMs: number,
  ) => Promise<JsonValue> = async () => ({ results: [] }),
) {
  return (config: { name: 'web_search@1' | 'read_web_page@1'; provider: 'brave' | 'serper' | 'parallel' }): RemoteToolProvider => ({
    provider: config.provider,
    operation: config.name,
    async execute(input, context) {
      return {
        output: await execute(input, context.signal, context.timeoutMs),
        units: 1,
        cost: 0.01,
      };
    },
  });
}
