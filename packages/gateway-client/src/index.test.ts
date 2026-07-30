import { describe, expect, test, vi } from 'vitest';
import type { ModelRequest } from '@adaptive-agent/core/src/types.js';
import {
  StreamSequenceValidator,
  type JsonRpcRequest,
  type ModelGenerateParams,
  type ModelGenerateResult,
} from '@adaptive-agent/gateway-protocol';

import {
  GatewayClient,
  GatewayModelAdapter,
  GatewayProtocolError,
  GatewayResponseError,
  GatewayTimeoutError,
  GatewayTransportError,
  type GatewayWebSocketFactory,
  type WebSocketLike,
} from './index.js';

describe('gateway client transport', () => {
  test('keeps concurrent model streams correlated when frames are interleaved', async () => {
    const generateRequests: Array<{ request: JsonRpcRequest<'model/generate'>; socket: FakeSocket }> = [];
    const { client } = fakeClient((request, socket) => {
      if (respondToSetup(request, socket)) return;
      if (request.method !== 'model/generate') return;
      generateRequests.push({ request, socket });
      if (generateRequests.length !== 2) return;

      const [first, second] = generateRequests;
      stream(second!, 0, { type: 'start' });
      stream(first!, 0, { type: 'start' });
      stream(first!, 1, { type: 'text_delta', delta: 'first' });
      stream(second!, 1, { type: 'text_delta', delta: 'second' });
      stream(second!, 2, { type: 'done' });
      stream(first!, 2, { type: 'done' });
      respond(first!, resultFor(first!.request.params, 'first'));
      respond(second!, resultFor(second!.request.params, 'second'));
    });

    const [first, second] = await Promise.all([
      client.generateModel(modelParams('call-first')),
      client.generateModel(modelParams('call-second')),
    ]);

    expect(first.text).toBe('first');
    expect(second.text).toBe('second');
    client.close();
  });

  test('diagnoses missing, duplicate, and out-of-order model sequences', async () => {
    for (const terminalSequence of [2, 0, 4]) {
      const { client } = fakeClient((request, socket) => {
        if (respondToSetup(request, socket)) return;
        if (request.method !== 'model/generate') return;
        const entry = { request, socket };
        stream(entry, 0, { type: 'start' });
        stream(entry, terminalSequence, { type: 'done' });
      });

      await expect(client.generateModel(modelParams(`bad-sequence-${terminalSequence}`)))
        .rejects.toThrow(GatewayProtocolError);
      client.close();
    }
  });

  test('aborts locally, sends cancellation, and ignores late frames without crossing another stream', async () => {
    let cancelledCallId: string | undefined;
    let firstSocket: FakeSocket | undefined;
    const started = deferred<void>();
    const { client } = fakeClient((request, socket) => {
      if (respondToSetup(request, socket)) return;
      if (request.method === 'request/cancel') {
        cancelledCallId = request.params.callId;
        socket.serverMessage({ jsonrpc: '2.0', id: request.id, result: { cancelled: true } });
        return;
      }
      if (request.method !== 'model/generate') return;
      const entry = { request, socket };
      if (request.params.invocation.callId === 'abort-call') {
        firstSocket = socket;
        stream(entry, 0, { type: 'start' });
        started.resolve();
        return;
      }
      stream(entry, 0, { type: 'start' });
      firstSocket?.serverMessage(streamFrame('abort-call', 1, { type: 'done' }));
      stream(entry, 1, { type: 'done' });
      respond(entry, resultFor(request.params, 'still-alive'));
    });
    const controller = new AbortController();
    const aborted = client.generateModel(modelParams('abort-call'), { signal: controller.signal });
    await started.promise;
    controller.abort();

    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    await expect(client.generateModel(modelParams('other-call'))).resolves.toMatchObject({ text: 'still-alive' });
    expect(cancelledCallId).toBe('abort-call');
    client.close();
  });

  test('aborts locally while connection setup is still pending', async () => {
    const token = deferred<string>();
    let socketCreated = false;
    const { client } = fakeClient(() => undefined, {
      accessToken: () => token.promise,
      onCreate() { socketCreated = true; },
    });
    const controller = new AbortController();
    const pending = client.generateModel(modelParams('connect-abort-call'), { signal: controller.signal });

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(socketCreated).toBe(false);
    client.close();
  });

  test('close stops an in-flight call without reconnecting the client', async () => {
    let connections = 0;
    const started = deferred<void>();
    const { client } = fakeClient((request, socket) => {
      if (respondToSetup(request, socket)) return;
      if (request.method !== 'model/generate') return;
      stream({ request, socket }, 0, { type: 'start' });
      started.resolve();
    }, {
      onCreate() { connections += 1; },
    });
    const pending = client.generateModel(modelParams('closed-call'));
    await started.promise;

    client.close();

    await expect(pending).rejects.toThrow('Gateway client is closed');
    await expect(client.connect()).rejects.toThrow('Gateway client is closed');
    expect(connections).toBe(1);
  });

  test('refreshes the token and reissues the original call ID after disconnect', async () => {
    const headers: Readonly<Record<string, string>>[] = [];
    const callIds: string[] = [];
    let connection = 0;
    let tokenNumber = 0;
    const { client } = fakeClient((request, socket) => {
      if (respondToSetup(request, socket)) return;
      if (request.method !== 'model/generate') return;
      callIds.push(request.params.invocation.callId);
      if (connection === 1) {
        stream({ request, socket }, 0, { type: 'start' });
        socket.disconnect();
        return;
      }
      stream({ request, socket }, 0, { type: 'start' });
      stream({ request, socket }, 1, { type: 'done' });
      respond({ request, socket }, resultFor(request.params, 'replayed'));
    }, {
      accessToken: () => `rotating-token-${++tokenNumber}`,
      onCreate(socketHeaders) {
        connection += 1;
        headers.push(socketHeaders);
      },
    });

    await expect(client.generateModel(modelParams('stable-call'))).resolves.toMatchObject({ text: 'replayed' });
    expect(callIds).toEqual(['stable-call', 'stable-call']);
    expect(headers).toEqual([
      { Authorization: 'Bearer rotating-token-1' },
      { Authorization: 'Bearer rotating-token-2' },
    ]);
    expect(JSON.stringify(client)).not.toContain('rotating-token');
    client.close();
  });

  test('ignores a late timed-out response without failing another active model stream', async () => {
    let authorizationRequest: JsonRpcRequest<'run/authorize'> | undefined;
    const { client } = fakeClient((request, socket) => {
      if (request.method === 'initialize') {
        respondToSetup(request, socket);
        return;
      }
      if (request.method === 'run/authorize') {
        authorizationRequest = request;
        setTimeout(() => socket.serverMessage({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            permitId: 'late-permit',
            inferenceMode: 'gateway',
            inferenceTier: 'high',
            routePolicyVersion: 'policy-v1',
            remoteCapabilities: [],
            expiresAt: '2026-07-28T00:00:00.000Z',
          },
        }), 120);
        return;
      }
      if (request.method !== 'model/generate') return;
      const entry = { request, socket };
      stream(entry, 0, { type: 'start' });
      setTimeout(() => {
        stream(entry, 1, { type: 'done' });
        respond(entry, resultFor(request.params, 'unaffected'));
      }, 80);
    }, { requestTimeoutMs: 100 });

    const authorization = client.authorizeRun({
      runId: 'late-authorization-run',
      inferenceMode: 'gateway',
      requestedTier: 'high',
      profileRefs: [],
    });
    await sleep(70);
    const model = client.generateModel(modelParams('unaffected-call'));

    await expect(authorization).rejects.toThrow(GatewayTimeoutError);
    await expect(model).resolves.toMatchObject({ text: 'unaffected' });
    expect(authorizationRequest).toBeDefined();
    client.close();
  });

  test('isolates a timed-out model call, cancels it, and does not reconnect the shared socket', async () => {
    let connections = 0;
    let cancelledCallId: string | undefined;
    const modelCallIds: string[] = [];
    const { client } = fakeClient((request, socket) => {
      if (respondToSetup(request, socket)) return;
      if (request.method === 'request/cancel') {
        cancelledCallId = request.params.callId;
        socket.serverMessage({ jsonrpc: '2.0', id: request.id, result: { cancelled: true } });
        return;
      }
      if (request.method !== 'model/generate') return;
      modelCallIds.push(request.params.invocation.callId);
      const entry = { request, socket };
      stream(entry, 0, { type: 'start' });
      if (request.params.invocation.callId === 'slow-call') {
        setTimeout(() => {
          stream(entry, 1, { type: 'done' });
          respond(entry, resultFor(request.params, 'too-late'));
        }, 130);
        return;
      }
      setTimeout(() => {
        stream(entry, 1, { type: 'done' });
        respond(entry, resultFor(request.params, 'still-running'));
      }, 80);
    }, {
      requestTimeoutMs: 100,
      onCreate() { connections += 1; },
    });

    const slow = client.generateModel(modelParams('slow-call'));
    await sleep(70);
    const unaffected = client.generateModel(modelParams('unaffected-call'));

    await expect(slow).rejects.toThrow(GatewayTimeoutError);
    await expect(unaffected).resolves.toMatchObject({ text: 'still-running' });
    expect(cancelledCallId).toBe('slow-call');
    expect(modelCallIds).toEqual(['slow-call', 'unaffected-call']);
    expect(connections).toBe(1);
    client.close();
  });

  test('forwards tool identity and idempotency and cancels with the tool key on abort', async () => {
    let toolRequest: JsonRpcRequest<'tool/execute'> | undefined;
    let cancelledKey: string | undefined;
    const started = deferred<void>();
    const { client } = fakeClient((request, socket) => {
      if (respondToSetup(request, socket)) return;
      if (request.method === 'tool/execute') {
        toolRequest = request;
        started.resolve();
        return;
      }
      if (request.method === 'request/cancel') {
        cancelledKey = request.params.idempotencyKey;
        socket.serverMessage({
          jsonrpc: '2.0',
          id: request.id,
          result: { cancelled: true },
        });
      }
    });
    const controller = new AbortController();
    const execution = client.executeTool({
      permitId: 'permit-tool',
      idempotencyKey: 'run:step:tool',
      toolName: 'web_search@1',
      input: { query: 'current status' },
      timeoutMs: 90_000,
    }, { signal: controller.signal });
    await started.promise;

    controller.abort();

    await expect(execution).rejects.toMatchObject({ name: 'AbortError' });
    expect(toolRequest?.params).toEqual({
      permitId: 'permit-tool',
      idempotencyKey: 'run:step:tool',
      toolName: 'web_search@1',
      input: { query: 'current status' },
      timeoutMs: 90_000,
    });
    expect(cancelledKey).toBe('run:step:tool');
    client.close();
  });

  test('reconnects tool execution with the original idempotency key', async () => {
    let connection = 0;
    const keys: string[] = [];
    const { client } = fakeClient((request, socket) => {
      if (respondToSetup(request, socket)) return;
      if (request.method !== 'tool/execute') return;
      keys.push(request.params.idempotencyKey);
      if (connection === 1) {
        socket.disconnect();
        return;
      }
      socket.serverMessage({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          idempotencyKey: request.params.idempotencyKey,
          output: { query: 'reconnected', results: [] },
          usage: { units: 1, cost: 0.01 },
          diagnostics: {
            provider: 'brave',
            operation: 'web_search@1',
            durationMs: 5,
            traceId: 'trace-tool',
          },
        },
      });
    }, {
      onCreate() { connection += 1; },
    });

    await expect(client.executeTool({
      permitId: 'permit-tool',
      idempotencyKey: 'stable-tool-key',
      toolName: 'web_search@1',
      input: { query: 'reconnected' },
    })).resolves.toMatchObject({
      idempotencyKey: 'stable-tool-key',
      output: { query: 'reconnected', results: [] },
    });
    expect(keys).toEqual(['stable-tool-key', 'stable-tool-key']);
    expect(connection).toBe(2);
    client.close();
  });
});

describe('gateway model adapter', () => {
  test('returns actual route usage and safe route, timing, and trace diagnostics', async () => {
    const generateModel = vi.fn(async (params: ModelGenerateParams) => resultFor(params, 'adapter-result'));
    const adapter = new GatewayModelAdapter({
      client: { generateModel } as unknown as GatewayClient,
      defaultTier: 'medium',
    });
    const request: ModelRequest = {
      messages: [{ role: 'user', content: 'hello' }],
      metadata: { accessToken: 'must-not-transit' },
      executionContext: {
        inferenceMode: 'gateway',
        inferenceTier: 'high',
        authorizationRef: 'permit-1',
        authorizationRunId: 'run-1',
        routePolicyRef: 'policy-v1',
        profileRefs: [],
      },
      invocation: {
        runId: 'run-1',
        rootRunId: 'run-1',
        stepId: 'step-1',
        purpose: 'agent_turn',
        callId: 'adapter-call',
        attempt: 1,
      },
    };

    const response = await adapter.generate(request);

    expect(response.usage).toMatchObject({
      provider: 'ollama',
      model: 'actual-high',
      promptTokens: 3,
      completionTokens: 2,
      totalTokens: 5,
    });
    expect(response.performance).toMatchObject({
      traceId: 'trace-adapter-call',
      requestedTier: 'high',
      routePolicyVersion: 'policy-v1',
      gatewayDurationMs: 9,
      providerDurationMs: 7,
      routeAttempts: 1,
    });
    expect(generateModel.mock.calls[0]?.[0]).not.toHaveProperty('metadata');
    expect(JSON.stringify(generateModel.mock.calls[0]?.[0])).not.toContain('must-not-transit');
  });

  test('authorizes a derived root once when inherited context belongs to another root run', async () => {
    const authorizeRun = vi.fn(async (params: { runId: string; requestedTier?: string }) => ({
      permitId: `permit-${params.runId}`,
      inferenceMode: 'gateway' as const,
      inferenceTier: params.requestedTier as 'high',
      routePolicyVersion: 'policy-derived',
      remoteCapabilities: [],
      expiresAt: '2999-07-28T00:00:00.000Z',
    }));
    const generateModel = vi.fn(async (params: ModelGenerateParams) => resultFor(params, 'derived-result'));
    const adapter = new GatewayModelAdapter({
      client: { authorizeRun, generateModel } as unknown as GatewayClient,
      defaultTier: 'medium',
    });
    const request = (callId: string): ModelRequest => ({
      messages: [{ role: 'user', content: 'hello' }],
      executionContext: {
        inferenceMode: 'gateway',
        inferenceTier: 'high',
        authorizationRef: 'permit-original-root',
        authorizationRunId: 'original-root',
        profileRefs: [],
      },
      invocation: {
        runId: 'derived-root',
        rootRunId: 'derived-root',
        stepId: 'step-1',
        purpose: 'agent_turn',
        callId,
        attempt: 1,
      },
    });

    await adapter.generate(request('derived-call-1'));
    await adapter.generate(request('derived-call-2'));

    expect(authorizeRun).toHaveBeenCalledTimes(1);
    expect(authorizeRun).toHaveBeenCalledWith({
      runId: 'derived-root',
      inferenceMode: 'gateway',
      requestedTier: 'high',
      profileRefs: [],
    });
    expect(generateModel.mock.calls.map(([params]) => params.permitId)).toEqual([
      'permit-derived-root',
      'permit-derived-root',
    ]);
  });

  test('refreshes a rejected expired permit once and replays the original call ID', async () => {
    const authorizeRun = vi.fn(async () => ({
      permitId: 'permit-refreshed',
      inferenceMode: 'gateway' as const,
      inferenceTier: 'high' as const,
      routePolicyVersion: 'policy-refreshed',
      remoteCapabilities: [],
      expiresAt: '2999-07-28T00:00:00.000Z',
    }));
    const callIds: string[] = [];
    const permitIds: string[] = [];
    const generateModel = vi.fn(async (params: ModelGenerateParams) => {
      callIds.push(params.invocation.callId);
      permitIds.push(params.permitId);
      if (params.permitId === 'permit-expired') {
        throw new GatewayResponseError('forbidden', false, 'trace-expired');
      }
      return resultFor(params, 'refreshed-result');
    });
    const adapter = new GatewayModelAdapter({
      client: { authorizeRun, generateModel } as unknown as GatewayClient,
      defaultTier: 'medium',
    });
    const request: ModelRequest = {
      messages: [{ role: 'user', content: 'resume after permit expiry' }],
      executionContext: {
        inferenceMode: 'gateway',
        inferenceTier: 'high',
        authorizationRef: 'permit-expired',
        authorizationRunId: 'run-resumed',
        profileRefs: [],
      },
      invocation: {
        runId: 'run-resumed',
        rootRunId: 'run-resumed',
        stepId: 'step-resumed',
        purpose: 'agent_turn',
        callId: 'stable-resumed-call',
        attempt: 1,
      },
    };

    await expect(adapter.generate(request)).resolves.toMatchObject({ text: 'refreshed-result' });
    expect(authorizeRun).toHaveBeenCalledTimes(1);
    expect(authorizeRun).toHaveBeenCalledWith({
      runId: 'run-resumed',
      inferenceMode: 'gateway',
      requestedTier: 'high',
      profileRefs: [],
    });
    expect(callIds).toEqual(['stable-resumed-call', 'stable-resumed-call']);
    expect(permitIds).toEqual(['permit-expired', 'permit-refreshed']);
  });

  test('public errors expose classification fields but no upstream response body', () => {
    const error = new GatewayResponseError('rate_limited', true, 'trace-safe', 250);
    expect(error.message).toBe('Gateway rate limit exceeded');
    expect(error.modelInvocationStatusCode).toBe(429);
    expect(error.modelInvocationRetryDelayMs).toBe(250);
    expect(error).not.toHaveProperty('responseBody');
    expect(new GatewayTransportError().message).toContain('network connection');
    expect(new GatewayResponseError('provider_timeout', true).modelInvocationStatusCode).toBe(524);
  });
});

describe('protocol sequence validator fixtures', () => {
  test('diagnoses changed call IDs and incomplete streams', () => {
    const validator = new StreamSequenceValidator('call-1');
    expect(() => validator.accept({ callId: 'call-2', seq: 0, event: { type: 'start' } })).toThrow(/callId changed/);
    expect(() => validator.assertTerminal()).toThrow(/no terminal/);
  });
});

interface FakeClientOptions {
  accessToken?: () => string | Promise<string>;
  onCreate?: (headers: Readonly<Record<string, string>>) => void;
  requestTimeoutMs?: number;
}

function fakeClient(
  onRequest: (request: JsonRpcRequest, socket: FakeSocket) => void,
  options: FakeClientOptions = {},
): { client: GatewayClient; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const factory: GatewayWebSocketFactory = (_url, headers) => {
    options.onCreate?.(headers);
    const socket = new FakeSocket(onRequest);
    sockets.push(socket);
    return socket;
  };
  return {
    client: new GatewayClient({
      url: 'wss://gateway.example/rpc',
      accessToken: options.accessToken ?? (() => 'test-token'),
      clientName: 'gateway-client-test',
      clientVersion: '0.1.0',
      connectTimeoutMs: 500,
      requestTimeoutMs: options.requestTimeoutMs ?? 500,
      reconnectAttempts: 1,
      webSocketFactory: factory,
    }),
    sockets,
  };
}

class FakeSocket implements WebSocketLike {
  readyState = 0;
  private readonly listeners = new Map<string, Array<{ listener: (event: Event | MessageEvent) => void; once: boolean }>>();

  constructor(private readonly onRequest: (request: JsonRpcRequest, socket: FakeSocket) => void) {
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit('open', new Event('open'));
    });
  }

  addEventListener(
    type: 'open' | 'close' | 'error' | 'message',
    listener: (event: Event | MessageEvent) => void,
    options?: { once?: boolean },
  ): void {
    const entries = this.listeners.get(type) ?? [];
    entries.push({ listener, once: options?.once ?? false });
    this.listeners.set(type, entries);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('socket is closed');
    this.onRequest(JSON.parse(data) as JsonRpcRequest, this);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', new Event('close'));
  }

  disconnect(): void {
    this.close();
  }

  serverMessage(value: unknown): void {
    queueMicrotask(() => this.emit('message', { data: JSON.stringify(value) } as MessageEvent));
  }

  private emit(type: string, event: Event | MessageEvent): void {
    const entries = [...(this.listeners.get(type) ?? [])];
    this.listeners.set(type, entries.filter((entry) => !entry.once));
    for (const entry of entries) entry.listener(event);
  }
}

function respondToSetup(request: JsonRpcRequest, socket: FakeSocket): boolean {
  if (request.method === 'initialize') {
    socket.serverMessage({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: '1.0',
        serverVersion: '0.1.0',
        inferenceTiers: ['low', 'medium', 'high', 'xtra-high'],
        streamEventVersions: ['1'],
        profileSchemaVersions: [],
        remoteTools: [],
        structuredOutput: true,
        cancellation: true,
        limits: { maxAttachmentBytes: 0, maxMessages: 128 },
        account: { permittedModes: ['gateway'], tierCeiling: 'xtra-high' },
      },
    });
    return true;
  }
  if (request.method === 'run/authorize') {
    socket.serverMessage({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        permitId: 'permit-1',
        inferenceMode: 'gateway',
        inferenceTier: request.params.requestedTier,
        routePolicyVersion: 'policy-v1',
        remoteCapabilities: [],
        expiresAt: '2026-07-28T00:00:00.000Z',
      },
    });
    return true;
  }
  return false;
}

function modelParams(callId: string): ModelGenerateParams {
  return {
    permitId: 'permit-1',
    tier: 'high',
    invocation: {
      runId: 'run-1',
      rootRunId: 'run-1',
      stepId: 'step-1',
      purpose: 'agent_turn',
      callId,
      attempt: 1,
    },
    messages: [{ role: 'user', content: 'hello' }],
  };
}

function resultFor(params: ModelGenerateParams, text: string): ModelGenerateResult {
  return {
    callId: params.invocation.callId,
    traceId: `trace-${params.invocation.callId}`,
    text,
    finishReason: 'stop',
    usage: {
      provider: 'ollama',
      model: `actual-${params.tier}`,
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
      cost: 0.001,
    },
    routePolicyVersion: 'policy-v1',
    timings: { gatewayDurationMs: 9, providerDurationMs: 7, routeAttempts: 1 },
  };
}

function stream(
  entry: { request: JsonRpcRequest<'model/generate'>; socket: FakeSocket },
  seq: number,
  event: Record<string, unknown>,
): void {
  entry.socket.serverMessage(streamFrame(entry.request.params.invocation.callId, seq, event));
}

function streamFrame(callId: string, seq: number, event: Record<string, unknown>): unknown {
  return { jsonrpc: '2.0', method: 'model/stream', params: { callId, seq, event } };
}

function respond(
  entry: { request: JsonRpcRequest<'model/generate'>; socket: FakeSocket },
  result: ModelGenerateResult,
): void {
  entry.socket.serverMessage({ jsonrpc: '2.0', id: entry.request.id, result });
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
