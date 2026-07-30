import type {
  JsonObject as CoreJsonObject,
  ModelAdapter,
  ModelRequest,
  ModelResponse,
} from '@adaptive-agent/core/src/types.js';
import {
  PROTOCOL_VERSION,
  StreamSequenceValidator,
  validateModelStreamNotification,
  validateDeclarativeProfileBundle,
  validateRpcResponse,
  type GatewayRequestMethod,
  type InferenceMode,
  type InferenceTier,
  type InitializeResult,
  type JsonRpcId,
  type MethodParams,
  type MethodResults,
  type ModelGenerateParams,
  type ModelGenerateResult,
  type ModelStreamEnvelope,
  type DeclarativeProfileBundle,
  type ProfileSummary,
  type ProfileRef,
  type PublicGatewayError,
  type PublicGatewayErrorCode,
  type RunAuthorizeParams,
  type RunAuthorizeResult,
  type ToolExecuteParams,
  type ToolExecuteResult,
} from '@adaptive-agent/gateway-protocol';

export type { DeclarativeProfileBundle, ProfileSummary, InferenceMode, InferenceTier, ProfileRef, PublicGatewayError, PublicGatewayErrorCode, RunAuthorizeParams, RunAuthorizeResult, ModelGenerateParams, ModelGenerateResult, ToolExecuteParams, ToolExecuteResult };
export { validateDeclarativeProfileBundle };

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'close' | 'error' | 'message', listener: (event: Event | MessageEvent) => void, options?: { once?: boolean }): void;
}

export type GatewayWebSocketFactory = (url: string, headers: Readonly<Record<string, string>>) => WebSocketLike;

export interface GatewayClientOptions {
  url: string;
  accessToken: () => string | Promise<string>;
  clientName: string;
  clientVersion: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  reconnectAttempts?: number;
  webSocketFactory?: GatewayWebSocketFactory;
}

export class GatewayClientError extends Error {
  readonly modelInvocationStatusCode?: number;
  readonly modelInvocationPhase?: 'connect' | 'request' | 'http_status';
  readonly modelInvocationRetryDelayMs?: number;
  constructor(message: string, options: { cause?: unknown; statusCode?: number; phase?: 'connect' | 'request' | 'http_status'; retryDelayMs?: number } = {}) {
    super(message, { cause: options.cause });
    this.name = 'GatewayClientError';
    this.modelInvocationStatusCode = options.statusCode;
    this.modelInvocationPhase = options.phase;
    this.modelInvocationRetryDelayMs = options.retryDelayMs;
  }
}

export class GatewayTransportError extends GatewayClientError {
  constructor(message = 'Gateway network connection unavailable', cause?: unknown) { super(message, { cause, phase: 'connect' }); this.name = 'GatewayTransportError'; }
}
export class GatewayTimeoutError extends GatewayClientError {
  constructor(message = 'Gateway request timed out') { super(message, { statusCode: 408, phase: 'request' }); this.name = 'GatewayTimeoutError'; }
}
export class GatewayProtocolError extends GatewayClientError {
  constructor(message: string, cause?: unknown) { super(`Gateway protocol error: ${message}`, { cause, statusCode: 400, phase: 'request' }); this.name = 'GatewayProtocolError'; }
}
export class GatewayResponseError extends GatewayClientError {
  constructor(public readonly gatewayCode: PublicGatewayErrorCode | 'unknown', public readonly retryable: boolean, public readonly traceId?: string, retryAfterMs?: number) {
    super(safeErrorMessage(gatewayCode), { statusCode: statusFor(gatewayCode), phase: 'http_status', retryDelayMs: retryAfterMs });
    this.name = 'GatewayResponseError';
  }
}

interface Pending { method: GatewayRequestMethod; resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout>; }
interface StreamState { validator: StreamSequenceValidator; reject(error: unknown): void; }

const bounded = (value: number | undefined, fallback: number, min: number, max: number): number => Math.min(max, Math.max(min, value ?? fallback));

export class GatewayClient {
  private socket?: WebSocketLike;
  private connecting?: Promise<void>;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private readonly streams = new Map<string, StreamState>();
  private readonly ignoredStreamCallIds = new Set<string>();
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly reconnectAttempts: number;
  private readonly factory: GatewayWebSocketFactory;
  private readonly lifetime = new AbortController();
  private initialized?: InitializeResult;

  constructor(private readonly options: GatewayClientOptions) {
    const url = new URL(options.url);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new GatewayClientError('Gateway URL must use ws or wss');
    if (url.username || url.password || [...url.searchParams.keys()].some(key => /token|auth|key/i.test(key))) throw new GatewayClientError('Gateway URL must not contain credentials');
    this.connectTimeoutMs = bounded(options.connectTimeoutMs, 10_000, 100, 120_000);
    this.requestTimeoutMs = bounded(options.requestTimeoutMs, 120_000, 100, 300_000);
    this.reconnectAttempts = bounded(options.reconnectAttempts, 2, 0, 10);
    this.factory = options.webSocketFactory ?? ((target, headers) => {
      const BunWebSocket = WebSocket as unknown as new (url: string, options: { headers: Readonly<Record<string, string>> }) => WebSocketLike;
      return new BunWebSocket(target, { headers });
    });
  }

  async connect(): Promise<void> {
    if (this.lifetime.signal.aborted) throw closedError();
    if (this.socket?.readyState === 1 && this.initialized) return;
    if (this.connecting) return this.connecting;
    this.connecting = waitForConnection(this.openAndInitialize(), this.lifetime.signal)
      .catch((error) => {
        const socket = this.socket;
        this.socket = undefined;
        this.initialized = undefined;
        socket?.close(1011, 'connection setup failed');
        throw this.lifetime.signal.aborted ? closedError() : error;
      })
      .finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  close(): void {
    this.lifetime.abort();
    const socket = this.socket;
    this.socket = undefined;
    this.initialized = undefined;
    socket?.close(1000, 'client closing');
    this.failAll(closedError());
  }

  async authorizeRun(params: RunAuthorizeParams): Promise<RunAuthorizeResult> { return this.request('run/authorize', params); }

  async listProfiles(schemaVersion?: string): Promise<ProfileSummary[]> {
    return (await this.request('profile/list', schemaVersion ? { schemaVersion } : {})).profiles;
  }

  async getProfile(ref: ProfileRef): Promise<DeclarativeProfileBundle> {
    return (await this.request('profile/get', { ref })).bundle;
  }

  async executeTool(params: ToolExecuteParams, options: { signal?: AbortSignal } = {}): Promise<ToolExecuteResult> {
    let last: unknown;
    for (let attempt = 0; attempt <= this.reconnectAttempts; attempt++) {
      if (options.signal?.aborted) throw abortError();
      try {
        await waitForConnection(this.connect(), options.signal);
        return await this.requestRawWithSignal('tool/execute', params, options.signal);
      } catch (error) {
        last = error;
        if (options.signal?.aborted || error instanceof GatewayTimeoutError) {
          void this.requestRaw('request/cancel', { idempotencyKey: params.idempotencyKey }).catch(() => undefined);
          throw options.signal?.aborted ? abortError() : error;
        }
        if (!(error instanceof GatewayTransportError) || attempt === this.reconnectAttempts) throw error;
        const socket = this.socket;
        this.socket = undefined;
        this.initialized = undefined;
        this.failAll(error);
        socket?.close(1012, 'reconnecting');
      }
    }
    throw last;
  }

  async generateModel(params: ModelGenerateParams, options: { signal?: AbortSignal } = {}): Promise<ModelGenerateResult> {
    let last: unknown;
    for (let attempt = 0; attempt <= this.reconnectAttempts; attempt++) {
      if (options.signal?.aborted) throw abortError();
      try { return await this.generateOnce(params, options.signal); }
      catch (error) {
        last = error;
        if (error instanceof GatewayTimeoutError) {
          this.ignoreCancelledStream(params.invocation.callId);
          void this.requestRaw('request/cancel', { callId: params.invocation.callId }).catch(() => undefined);
          throw error;
        }
        if (
          options.signal?.aborted ||
          !(error instanceof GatewayTransportError) ||
          attempt === this.reconnectAttempts
        ) throw error;
        const socket = this.socket;
        this.socket = undefined;
        this.initialized = undefined;
        this.failAll(error);
        socket?.close(1012, 'reconnecting');
      }
    }
    throw last;
  }

  private async generateOnce(params: ModelGenerateParams, signal?: AbortSignal): Promise<ModelGenerateResult> {
    await waitForConnection(this.connect(), signal);
    if (this.streams.has(params.invocation.callId)) {
      throw new GatewayClientError(`Gateway model call ${params.invocation.callId} is already active`);
    }
    let rejectStream!: (error: unknown) => void;
    const failed = new Promise<never>((_, reject) => { rejectStream = reject; });
    let rejectAborted!: (error: unknown) => void;
    const abortFailure = new Promise<never>((_, reject) => { rejectAborted = reject; });
    this.streams.set(params.invocation.callId, {
      validator: new StreamSequenceValidator(params.invocation.callId),
      reject: rejectStream,
    });
    const abort = () => {
      this.streams.delete(params.invocation.callId);
      this.ignoreCancelledStream(params.invocation.callId);
      void this.requestRaw('request/cancel', { callId: params.invocation.callId }).catch(() => undefined);
      rejectAborted(abortError());
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      if (signal?.aborted) await abortFailure;
      const result = await Promise.race([this.requestRaw('model/generate', params), failed, abortFailure]);
      const state = this.streams.get(params.invocation.callId);
      if (!state) throw abortError();
      try { state.validator.assertTerminal(); } catch (error) { throw new GatewayProtocolError('incomplete model stream', error); }
      if (result.callId !== params.invocation.callId) throw new GatewayProtocolError('terminal response callId changed');
      return result;
    } finally { signal?.removeEventListener('abort', abort); this.streams.delete(params.invocation.callId); }
  }

  private async openAndInitialize(): Promise<void> {
    let token: string;
    try {
      token = await this.options.accessToken();
    } catch {
      throw new GatewayClientError('Gateway access token could not be loaded', {
        statusCode: 401,
        phase: 'connect',
      });
    }
    if (this.lifetime.signal.aborted) throw closedError();
    if (!token) throw new GatewayClientError('Gateway access token is unavailable', { statusCode: 401, phase: 'connect' });
    let ws: WebSocketLike;
    try { ws = this.factory(this.options.url, { Authorization: `Bearer ${token}` }); } catch (error) { throw new GatewayTransportError(undefined, error); }
    this.socket = ws;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new GatewayTimeoutError('Gateway connection timed out')); }, this.connectTimeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new GatewayTransportError()); }, { once: true });
    });
    ws.addEventListener('message', event => {
      if (this.socket === ws) this.onMessage((event as MessageEvent).data);
    });
    ws.addEventListener('close', () => this.onDisconnect(ws));
    this.initialized = await this.requestRaw('initialize', { protocolVersion: PROTOCOL_VERSION, clientName: this.options.clientName, clientVersion: this.options.clientVersion });
  }

  private async request<M extends GatewayRequestMethod>(method: M, params: MethodParams[M]): Promise<MethodResults[M]> { await this.connect(); return this.requestRaw(method, params); }
  private requestRaw<M extends GatewayRequestMethod>(method: M, params: MethodParams[M]): Promise<MethodResults[M]> {
    const ws = this.socket;
    if (!ws || ws.readyState !== 1) return Promise.reject(new GatewayTransportError());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new GatewayTimeoutError()); }, this.requestTimeoutMs);
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer });
      try { ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(new GatewayTransportError(undefined, error)); }
    });
  }

  private requestRawWithSignal<M extends GatewayRequestMethod>(method: M, params: MethodParams[M], signal?: AbortSignal): Promise<MethodResults[M]> {
    if (!signal) return this.requestRaw(method, params);
    const ws = this.socket;
    if (!ws || ws.readyState !== 1) return Promise.reject(new GatewayTransportError());
    if (signal.aborted) return Promise.reject(abortError());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const cleanup = () => signal.removeEventListener('abort', abort);
      const timer = setTimeout(() => {
        cleanup();
        this.pending.delete(id);
        reject(new GatewayTimeoutError());
      }, this.requestTimeoutMs);
      const abort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        cleanup();
        reject(abortError());
      };
      signal.addEventListener('abort', abort, { once: true });
      this.pending.set(id, {
        method,
        resolve: (value) => { cleanup(); resolve(value as MethodResults[M]); },
        reject: (error) => { cleanup(); reject(error); },
        timer,
      });
      try { ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); cleanup(); reject(new GatewayTransportError(undefined, error)); }
    });
  }

  private onMessage(data: unknown): void {
    if (typeof data !== 'string') { this.failAll(new GatewayProtocolError('binary frames are not supported')); this.socket?.close(1002, 'text frames required'); return; }
    let value: unknown;
    try { value = JSON.parse(data); } catch (error) { this.failAll(new GatewayProtocolError('malformed JSON frame', error)); return; }
    if (isNotification(value)) {
      let notification;
      try {
        notification = validateModelStreamNotification(value);
      } catch (error) {
        this.failStreams(new GatewayProtocolError((error as Error).message, error));
        return;
      }
      const state = this.streams.get(notification.params.callId);
      if (!state && this.ignoredStreamCallIds.has(notification.params.callId)) {
        if (notification.params.event.type === 'done' || notification.params.event.type === 'error') {
          this.ignoredStreamCallIds.delete(notification.params.callId);
        }
        return;
      }
      if (!state) {
        this.failStreams(new GatewayProtocolError('stream received for an unknown callId'));
        return;
      }
      try {
        state.validator.accept(notification.params);
        if (notification.params.event.type === 'error') state.reject(fromPublicError(notification.params.event.error));
      } catch (error) {
        state.reject(error instanceof GatewayClientError ? error : new GatewayProtocolError((error as Error).message, error));
      }
      return;
    }
    const id = isRecord(value) ? value.id as JsonRpcId : undefined;
    const pending = id !== undefined ? this.pending.get(id) : undefined;
    if (!pending) return;
    this.pending.delete(id as JsonRpcId); clearTimeout(pending.timer);
    try {
      const response = validateRpcResponse(pending.method, value);
      if ('error' in response) pending.reject(response.error.data ? fromPublicError(response.error.data) : new GatewayResponseError('unknown', false));
      else pending.resolve(response.result);
    } catch (error) { pending.reject(new GatewayProtocolError((error as Error).message, error)); }
  }

  private onDisconnect(socket: WebSocketLike): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.initialized = undefined;
    this.failAll(new GatewayTransportError('Gateway network connection closed'));
  }
  private failStreams(error: unknown): void { for (const state of this.streams.values()) state.reject(error); }
  private failAll(error: unknown): void { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); } this.pending.clear(); this.failStreams(error); }
  private ignoreCancelledStream(callId: string): void {
    this.ignoredStreamCallIds.add(callId);
    const timer = setTimeout(() => this.ignoredStreamCallIds.delete(callId), this.requestTimeoutMs);
    timer.unref?.();
  }
}

export interface GatewayExecutionContext {
  inferenceMode?: InferenceMode;
  inferenceTier?: InferenceTier;
  authorizationRef?: string;
  authorizationRunId?: string;
  routePolicyRef?: string;
  profileRefs?: ProfileRef[];
}
export interface GatewayModelAdapterOptions { client: GatewayClient; defaultTier: InferenceTier; }

export class GatewayModelAdapter implements ModelAdapter {
  static readonly provider = 'adaptive-agent-gateway';
  readonly provider = GatewayModelAdapter.provider;
  readonly model: string;
  readonly capabilities = { toolCalling: true, jsonOutput: true, streaming: true, usage: true } as const;
  private readonly permits = new Map<string, Promise<RunAuthorizeResult>>();
  constructor(private readonly options: GatewayModelAdapterOptions) { this.model = `tier:${options.defaultTier}`; }
  async generate(request: ModelRequest): Promise<ModelResponse> {
    if (!request.invocation) throw new GatewayClientError('Gateway model requests require invocation context');
    const context = (request.executionContext ?? {}) as GatewayExecutionContext;
    if (context.inferenceMode !== undefined && context.inferenceMode !== 'gateway') throw new GatewayClientError('Gateway adapter requires gateway inference mode');
    if (typeof context.authorizationRef !== 'string' || !context.authorizationRef) throw new GatewayClientError('Gateway authorization permit is required');
    const tier = context.inferenceTier ?? this.options.defaultTier;
    const rootRunId = request.invocation.rootRunId;
    let authorization = this.authorizationFor(rootRunId, tier, context);
    let permit = await authorization.promise;
    if (authorizationExpired(permit.expiresAt)) {
      this.invalidateAuthorization(authorization.key, authorization.promise);
      authorization = this.authorizeRoot(rootRunId, tier, context.profileRefs ?? []);
      permit = await authorization.promise;
    }
    const messages = request.messages.map(message => ({
      role: message.role, content: textContent(message.content), name: message.name, toolCallId: message.toolCallId,
      toolCalls: message.toolCalls?.map(call => ({ id: call.id, name: call.name, input: call.input })),
    }));
    const params: ModelGenerateParams = {
      permitId: permit.permitId,
      tier,
      invocation: request.invocation,
      messages,
      tools: request.tools?.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema as CoreJsonObject })),
      responseSchema: request.outputSchema as CoreJsonObject | undefined,
    };
    let result: ModelGenerateResult;
    try {
      result = await this.options.client.generateModel(params, { signal: request.signal });
    } catch (error) {
      if (!(error instanceof GatewayResponseError) || error.gatewayCode !== 'forbidden') throw error;
      this.invalidateAuthorization(authorization.key, authorization.promise);
      authorization = this.authorizeRoot(rootRunId, tier, context.profileRefs ?? []);
      permit = await authorization.promise;
      result = await this.options.client.generateModel({ ...params, permitId: permit.permitId }, { signal: request.signal });
    }
    return {
      text: result.text, structuredOutput: result.structuredOutput, toolCalls: result.toolCalls,
      finishReason: result.finishReason, providerResponseId: result.providerResponseId, summary: result.summary,
      usage: { promptTokens: result.usage.inputTokens, completionTokens: result.usage.outputTokens, totalTokens: result.usage.totalTokens, estimatedCostUSD: result.usage.cost ?? 0, provider: result.usage.provider, model: result.usage.model },
      performance: {
        callId: result.callId,
        traceId: result.traceId,
        requestedTier: tier,
        routePolicyVersion: result.routePolicyVersion,
        gatewayDurationMs: result.timings.gatewayDurationMs,
        providerDurationMs: result.timings.providerDurationMs,
        routeAttempts: result.timings.routeAttempts,
      },
    };
  }

  private authorizationFor(
    rootRunId: string,
    tier: InferenceTier,
    context: GatewayExecutionContext,
  ): { key: string; promise: Promise<RunAuthorizeResult> } {
    const key = `${rootRunId}:${tier}`;
    const existing = this.permits.get(key);
    if (existing) return { key, promise: existing };
    if (context.authorizationRunId === undefined || context.authorizationRunId === rootRunId) {
      return {
        key,
        promise: Promise.resolve({
          permitId: context.authorizationRef!,
          inferenceMode: 'gateway',
          inferenceTier: tier,
          routePolicyVersion: context.routePolicyRef ?? '',
          remoteCapabilities: [],
          expiresAt: '9999-12-31T23:59:59.999Z',
        }),
      };
    }
    return this.authorizeRoot(rootRunId, tier, context.profileRefs ?? []);
  }

  private authorizeRoot(
    rootRunId: string,
    tier: InferenceTier,
    profileRefs: ProfileRef[],
  ): { key: string; promise: Promise<RunAuthorizeResult> } {
    const key = `${rootRunId}:${tier}`;
    const existing = this.permits.get(key);
    if (existing) return { key, promise: existing };
    const pending = this.options.client.authorizeRun({
      runId: rootRunId,
      inferenceMode: 'gateway',
      requestedTier: tier,
      profileRefs,
    });
    this.permits.set(key, pending);
    void pending.then(
      (result) => this.expireAuthorization(key, pending, result.expiresAt),
      () => this.invalidateAuthorization(key, pending),
    );
    return { key, promise: pending };
  }

  private invalidateAuthorization(key: string, pending: Promise<RunAuthorizeResult>): void {
    if (this.permits.get(key) === pending) this.permits.delete(key);
  }

  private expireAuthorization(key: string, pending: Promise<RunAuthorizeResult>, expiresAt: string): void {
    const expiration = Date.parse(expiresAt);
    if (!Number.isFinite(expiration)) return;
    const delayMs = Math.max(0, Math.min(expiration - Date.now(), 2_147_483_647));
    const timer = setTimeout(() => this.invalidateAuthorization(key, pending), delayMs);
    timer.unref?.();
  }
}

function textContent(content: ModelRequest['messages'][number]['content']): string {
  if (typeof content === 'string') return content;
  return content.map(part => { if (part.type !== 'text') throw new GatewayClientError(`Gateway model does not support ${part.type} message parts`); return part.text; }).join('');
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function isNotification(value: unknown): boolean { return isRecord(value) && !('id' in value) && 'method' in value; }
function abortError(): Error { return new DOMException('Gateway model request aborted', 'AbortError'); }
function closedError(): GatewayClientError { return new GatewayClientError('Gateway client is closed'); }
async function waitForConnection(connection: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return connection;
  if (signal.aborted) throw abortError();
  let rejectAborted!: (error: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAborted = reject; });
  const abort = () => rejectAborted(abortError());
  signal.addEventListener('abort', abort, { once: true });
  try { await Promise.race([connection, aborted]); }
  finally { signal.removeEventListener('abort', abort); }
}
function fromPublicError(error: PublicGatewayError): GatewayResponseError { return new GatewayResponseError(error.gatewayCode, error.retryable, error.traceId, error.retryAfterMs); }
function safeErrorMessage(code: PublicGatewayErrorCode | 'unknown'): string {
  if (code === 'rate_limited' || code === 'quota_exceeded') return 'Gateway rate limit exceeded';
  if (code === 'provider_timeout') return 'Gateway provider timed out';
  if (code === 'provider_unavailable' || code === 'internal_error') return 'Gateway provider unavailable';
  if (code === 'unauthenticated' || code === 'token_expired') return 'Gateway authentication required';
  if (code === 'cancelled') return 'Gateway request cancelled';
  return `Gateway request rejected (${code})`;
}
function statusFor(code: PublicGatewayErrorCode | 'unknown'): number { if (code === 'rate_limited' || code === 'quota_exceeded') return 429; if (code === 'provider_timeout') return 524; if (code === 'unauthenticated' || code === 'token_expired') return 401; if (code === 'forbidden' || code === 'tier_not_entitled' || code === 'capability_not_entitled') return 403; if (code === 'provider_unavailable' || code === 'internal_error') return 503; return 400; }
function authorizationExpired(expiresAt: string): boolean { const expiration = Date.parse(expiresAt); return Number.isFinite(expiration) && expiration <= Date.now(); }
