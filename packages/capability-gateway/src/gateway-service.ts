import {
  INFERENCE_TIERS,
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
  type AccountUsageParams,
  type GatewayRequestMethod,
  type InitializeResult,
  type JsonValue,
  type MethodResults,
  type ModelGenerateParams,
  type ModelGenerateResult,
  type ModelStreamEnvelope,
  type ModelToolCall,
  type RequestCancelParams,
  type RunAuthorizeParams,
  type RunAuthorizeResult,
  type UsageSummary,
  validateRpcResponse,
} from '@adaptive-agent/gateway-protocol';
import type { GatewayPrincipal } from './auth.js';
import type { BillingRecord, BillingStore } from './billing.js';
import { InMemoryBillingStore } from './billing.js';
import {
  CachedModelCall,
  ModelCallCache,
  stableModelRequestHash,
  type StreamSubscriber,
} from './call-cache.js';
import { GatewayError, gatewayError } from './errors.js';
import type { GatewayLogger } from './logger.js';
import { silentGatewayLogger } from './logger.js';
import { PermitService } from './permit.js';
import {
  AdapterPool,
  adapterSupportsRequest,
  assertRequestWithinTierLimits,
  type AdapterFactory,
  type ProviderAdapter,
  type ProviderModelResponse,
  type ProviderStreamEvent,
  type ProviderUsage,
  type RoutePolicy,
  type RouteTarget,
} from './route-policy.js';

export interface GatewayServiceOptions {
  routePolicy: RoutePolicy;
  adapterFactory?: AdapterFactory;
  billingStore?: BillingStore;
  permitService?: PermitService;
  callCache?: ModelCallCache;
  logger?: GatewayLogger;
  serverVersion?: string;
  now?: () => number;
}

export interface GatewayRequestContext {
  traceId: string;
  notify: StreamSubscriber;
}

export class GatewayService {
  readonly billingStore: BillingStore;
  readonly permitService: PermitService;
  readonly callCache: ModelCallCache;
  private readonly adapterPool: AdapterPool;
  private readonly logger: GatewayLogger;
  private readonly serverVersion: string;
  private readonly now: () => number;

  constructor(readonly options: GatewayServiceOptions) {
    this.billingStore = options.billingStore ?? new InMemoryBillingStore();
    this.permitService = options.permitService ?? new PermitService();
    this.callCache = options.callCache ?? new ModelCallCache();
    this.adapterPool = new AdapterPool(options.routePolicy, options.adapterFactory);
    const configuredLogger = options.logger ?? silentGatewayLogger;
    this.logger = {
      log(level, event, fields) {
        try {
          configuredLogger.log(level, event, fields);
        } catch {
          // Logging must never alter capability execution or billing state.
        }
      },
    };
    this.serverVersion = options.serverVersion ?? '0.1.0';
    this.now = options.now ?? Date.now;
  }

  async handle<M extends GatewayRequestMethod>(
    principal: GatewayPrincipal,
    method: M,
    params: import('@adaptive-agent/gateway-protocol').MethodParams[M],
    context: GatewayRequestContext,
  ): Promise<MethodResults[M]> {
    if (principal.expiresAtEpochSeconds * 1_000 <= this.now()) {
      throw new GatewayError('token_expired');
    }

    switch (method) {
      case 'initialize':
        return this.initialize(principal) as MethodResults[M];
      case 'profile/list':
        return { profiles: [] } as unknown as MethodResults[M];
      case 'profile/get':
      case 'tool/execute':
        throw new GatewayError('capability_not_entitled');
      case 'run/authorize':
        return this.authorize(principal, params as RunAuthorizeParams) as MethodResults[M];
      case 'model/generate':
        return await this.generate(
          principal,
          params as ModelGenerateParams,
          context,
        ) as MethodResults[M];
      case 'request/cancel':
        return this.cancel(principal, params as RequestCancelParams) as MethodResults[M];
      case 'account/usage':
        return await this.billingStore.listUsage(
          principal.accountId,
          params as AccountUsageParams,
        ) as MethodResults[M];
    }
  }

  activeCallCount(): number {
    return this.callCache.activeCount();
  }

  abortActiveCalls(): void {
    this.callCache.abortAll();
  }

  async close(): Promise<void> {
    this.callCache.abortAll();
    await this.callCache.waitForActiveCalls();
    await this.adapterPool.close();
    await this.billingStore.close?.();
  }

  private initialize(principal: GatewayPrincipal): InitializeResult {
    return {
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: this.serverVersion,
      inferenceTiers: INFERENCE_TIERS.filter((tier) => principal.allowedTiers.includes(tier)),
      streamEventVersions: ['1'],
      profileSchemaVersions: [],
      remoteTools: [],
      structuredOutput: true,
      cancellation: true,
      limits: {
        maxAttachmentBytes: 0,
        maxMessages: Math.min(
          PROTOCOL_LIMITS.maxMessages,
          ...principal.allowedTiers.map(
            (tier) => this.options.routePolicy.tiers[tier].limits.maxMessages,
          ),
        ),
      },
      account: {
        permittedModes: principal.permittedModes,
        tierCeiling: highestTier(principal.allowedTiers),
      },
    };
  }

  private authorize(
    principal: GatewayPrincipal,
    params: RunAuthorizeParams,
  ): RunAuthorizeResult {
    const permit = this.permitService.authorize(
      principal,
      params,
      this.options.routePolicy.version,
    );
    return {
      permitId: permit.id,
      inferenceMode: permit.inferenceMode,
      inferenceTier: permit.inferenceTier,
      routePolicyVersion: permit.routePolicyVersion,
      remoteCapabilities: permit.remoteCapabilities,
      expiresAt: permit.expiresAt,
    };
  }

  private cancel(
    principal: GatewayPrincipal,
    params: RequestCancelParams,
  ): { cancelled: boolean } {
    return {
      cancelled: params.callId
        ? this.callCache.cancel(principal.accountId, params.callId)
        : false,
    };
  }

  private async generate(
    principal: GatewayPrincipal,
    params: ModelGenerateParams,
    context: GatewayRequestContext,
  ): Promise<ModelGenerateResult> {
    this.permitService.verifyModelPermit(
      params.permitId,
      principal,
      params.tier,
      params.invocation.rootRunId,
      this.options.routePolicy.version,
    );
    const tierPolicy = this.options.routePolicy.tiers[params.tier];
    assertRequestWithinTierLimits(params, tierPolicy);

    const requestHash = stableModelRequestHash(params);
    const { call, created } = this.callCache.reserve(
      principal.accountId,
      params.invocation.callId,
      requestHash,
    );
    const unsubscribe = call.subscribe(context.notify);
    if (created) {
      void this.executeModelCall(call, principal, params, context.traceId)
        .then((result) => call.succeed(result))
        .catch((error) => {
          const normalized = gatewayError(error);
          const traceId = crypto.randomUUID();
          const terminalErrorEmitted = call.events.some(
            (event) => event.event.type === 'error',
          );
          if (!terminalErrorEmitted) {
            this.logger.log('error', 'model.terminal_state_failed', {
              traceId,
              accountId: principal.accountId,
              tenantId: principal.tenantId,
              callId: call.callId,
              tier: params.tier,
              routePolicyVersion: this.options.routePolicy.version,
              status: normalized.gatewayCode,
              errorType: normalized.gatewayCode,
            });
            call.append({ type: 'error', error: normalized.toPublic(traceId) });
          }
          call.touchedAt = this.now();
          call.fail(normalized, traceId);
        });
    }

    try {
      const outcome = await call.outcome;
      if (!outcome.ok) throw outcome.error;
      return structuredClone(outcome.result);
    } finally {
      unsubscribe();
    }
  }

  private async executeModelCall(
    call: CachedModelCall,
    principal: GatewayPrincipal,
    params: ModelGenerateParams,
    traceId: string,
  ): Promise<ModelGenerateResult> {
    const gatewayStartedAt = this.now();
    const createdAt = new Date(gatewayStartedAt).toISOString();
    const activeBilling: BillingRecord = {
      accountId: principal.accountId,
      tenantId: principal.tenantId,
      subject: principal.subject,
      permitId: params.permitId,
      capability: 'model/generate',
      callId: params.invocation.callId,
      requestHash: call.requestHash,
      requestedTier: params.tier,
      routePolicyVersion: this.options.routePolicy.version,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cost: 0,
      status: 'active',
      createdAt,
      updatedAt: createdAt,
    };
    call.append({ type: 'start' });
    if (!(await this.billingStore.begin(activeBilling))) {
      throw new GatewayError('idempotency_conflict', { callId: call.callId });
    }

    let lastRoute: { target: RouteTarget; index: number } | undefined;
    let providerDurationMs = 0;
    let routeAttempts = 0;

    try {
      const tierPolicy = this.options.routePolicy.tiers[params.tier];
      for (const [index, target] of tierPolicy.targets.entries()) {
        const previousRoute = lastRoute;
        lastRoute = { target, index };
        routeAttempts += 1;
        const attemptStartedAt = this.now();
        let lease: Awaited<ReturnType<AdapterPool['acquire']>> | undefined;
        let forwardedProviderOutput = false;
        let providerCompleted = false;
        try {
          lease = await this.adapterPool.acquire(target);
          if (!adapterSupportsRequest(lease.adapter, params)) {
            lastRoute = previousRoute;
            continue;
          }
          const tracker = createStreamTracker(call);
          const response = await invokeProvider(
            lease.adapter,
            params,
            tierPolicy.limits.modelTimeoutMs,
            call.controller.signal,
            (event) => {
              forwardedProviderOutput = mapProviderEvent(tracker, event) || forwardedProviderOutput;
            },
          );
          completeMissingStreamEvents(tracker, response);
          providerCompleted = true;
          forwardedProviderOutput = tracker.forwardedOutput || forwardedProviderOutput;
          providerDurationMs += this.now() - attemptStartedAt;

          const usage = gatewayUsage(response.usage, target, lease.adapter);
          const result = compactResult({
            callId: call.callId,
            traceId,
            text: response.text,
            structuredOutput: response.structuredOutput,
            toolCalls: response.toolCalls,
            finishReason: response.finishReason,
            usage,
            providerResponseId: response.providerResponseId,
            summary: response.summary,
            routePolicyVersion: this.options.routePolicy.version,
            timings: {
              gatewayDurationMs: this.now() - gatewayStartedAt,
              providerDurationMs,
              routeAttempts,
            },
          });
          validateRpcResponse('model/generate', {
            jsonrpc: '2.0',
            id: call.callId,
            result,
          });

          const completedAt = new Date(this.now()).toISOString();
          const completedBilling: BillingRecord = {
            ...activeBilling,
            selectedRouteIndex: index,
            provider: usage.provider,
            model: usage.model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
            cost: usage.cost ?? 0,
            status: 'completed',
            updatedAt: completedAt,
            completedAt,
          };
          await this.billingStore.finish(completedBilling);
          result.timings.gatewayDurationMs = this.now() - gatewayStartedAt;
          call.append({ type: 'usage', usage });
          call.append({ type: 'done' });
          call.touchedAt = this.now();
          this.logger.log('info', 'model.completed', {
            traceId,
            accountId: principal.accountId,
            tenantId: principal.tenantId,
            callId: call.callId,
            tier: params.tier,
            routePolicyVersion: this.options.routePolicy.version,
            routeIndex: index,
            provider: usage.provider,
            model: usage.model,
            status: 'completed',
            durationMs: this.now() - gatewayStartedAt,
          });
          return result;
        } catch (error) {
          providerDurationMs += this.now() - attemptStartedAt;
          if (providerCompleted) {
            throw new GatewayError('internal_error', {
              callId: call.callId,
              cause: error,
            });
          }
          const normalized = classifyProviderError(error, call.callId, call.controller.signal);
          if (normalized.gatewayCode === 'cancelled') throw normalized;
          if (
            !normalized.retryable ||
            forwardedProviderOutput ||
            index === tierPolicy.targets.length - 1
          ) {
            throw normalized;
          }
          this.logger.log('warn', 'model.route_fallback', {
            traceId,
            accountId: principal.accountId,
            callId: call.callId,
            tier: params.tier,
            routePolicyVersion: this.options.routePolicy.version,
            routeIndex: index,
            provider: target.provider,
            model: target.model,
            status: normalized.gatewayCode,
            durationMs: this.now() - attemptStartedAt,
          });
        } finally {
          lease?.release();
        }
      }
      throw new GatewayError('capability_not_entitled', { callId: call.callId });
    } catch (error) {
      const normalized = gatewayError(error);
      const completedAt = new Date(this.now()).toISOString();
      await this.billingStore.finish({
        ...activeBilling,
        ...(lastRoute
          ? {
              selectedRouteIndex: lastRoute.index,
              provider: lastRoute.target.provider,
              model: lastRoute.target.model,
            }
          : {}),
        status: normalized.gatewayCode === 'cancelled' ? 'cancelled' : 'failed',
        updatedAt: completedAt,
        completedAt,
      });
      call.append({ type: 'error', error: normalized.toPublic(traceId) });
      call.touchedAt = this.now();
      this.logger.log('warn', 'model.failed', {
        traceId,
        accountId: principal.accountId,
        tenantId: principal.tenantId,
        callId: call.callId,
        tier: params.tier,
        routePolicyVersion: this.options.routePolicy.version,
        routeIndex: lastRoute?.index,
        provider: lastRoute?.target.provider,
        model: lastRoute?.target.model,
        status: normalized.gatewayCode,
        durationMs: this.now() - gatewayStartedAt,
        errorType: normalized.gatewayCode,
      });
      throw normalized;
    }
  }
}

interface StreamTracker {
  call: CachedModelCall;
  text: string;
  startedToolCalls: Set<string>;
  endedToolCalls: Set<string>;
  summary?: string;
  forwardedOutput: boolean;
}

function createStreamTracker(call: CachedModelCall): StreamTracker {
  return {
    call,
    text: '',
    startedToolCalls: new Set(),
    endedToolCalls: new Set(),
    forwardedOutput: false,
  };
}

function mapProviderEvent(tracker: StreamTracker, event: ProviderStreamEvent): boolean {
  switch (event.type) {
    case 'text_delta':
      tracker.text += event.delta;
      tracker.call.append(event);
      tracker.forwardedOutput = true;
      return true;
    case 'tool_call_start':
      tracker.startedToolCalls.add(event.toolCallId);
      tracker.call.append(event);
      tracker.forwardedOutput = true;
      return true;
    case 'tool_call_delta':
      tracker.call.append(event);
      tracker.forwardedOutput = true;
      return true;
    case 'tool_call_end':
      tracker.endedToolCalls.add(event.toolCall.id);
      tracker.call.append(event);
      tracker.forwardedOutput = true;
      return true;
    case 'summary':
      tracker.summary = event.summary;
      tracker.call.append(event);
      tracker.forwardedOutput = true;
      return true;
    case 'start':
    case 'usage':
    case 'done':
    case 'error':
      return false;
  }
}

function completeMissingStreamEvents(
  tracker: StreamTracker,
  response: ProviderModelResponse,
): void {
  if (response.text !== undefined && response.text !== tracker.text) {
    if (!response.text.startsWith(tracker.text)) {
      throw new GatewayError('provider_unavailable', { callId: tracker.call.callId });
    }
    const suffix = response.text.slice(tracker.text.length);
    if (suffix) mapProviderEvent(tracker, { type: 'text_delta', delta: suffix });
  }
  for (const toolCall of response.toolCalls ?? []) {
    if (!tracker.startedToolCalls.has(toolCall.id)) {
      mapProviderEvent(tracker, {
        type: 'tool_call_start',
        toolCallId: toolCall.id,
        name: toolCall.name,
      });
    }
    if (!tracker.endedToolCalls.has(toolCall.id)) {
      mapProviderEvent(tracker, { type: 'tool_call_end', toolCall });
    }
  }
  if (
    [...tracker.startedToolCalls].some(
      (toolCallId) => !tracker.endedToolCalls.has(toolCallId),
    )
  ) {
    throw new GatewayError('provider_unavailable', { callId: tracker.call.callId });
  }
  if (response.summary && response.summary !== tracker.summary) {
    mapProviderEvent(tracker, { type: 'summary', summary: response.summary });
  }
}

async function invokeProvider(
  adapter: ProviderAdapter,
  params: ModelGenerateParams,
  modelTimeoutMs: number,
  signal: AbortSignal,
  onEvent: (event: ProviderStreamEvent) => void,
): Promise<ProviderModelResponse> {
  if (signal.aborted) {
    throw new GatewayError('cancelled', { cause: signal.reason });
  }
  const controller = new AbortController();
  let acceptEvents = true;
  let timedOut = false;
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  const request = {
    messages: params.messages,
    tools: params.tools?.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema,
    })),
    outputSchema: params.responseSchema,
    signal: controller.signal,
    modelTimeoutMs,
    invocation: params.invocation,
  };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = new Error('provider model timeout');
  timeoutError.name = 'TimeoutError';
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(timeoutError);
      reject(timeoutError);
    }, modelTimeoutMs);
  });
  let rejectCancellation!: (reason?: unknown) => void;
  const cancellationPromise = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = () => {
    rejectCancellation(new GatewayError('cancelled', { cause: signal.reason }));
  };
  signal.addEventListener('abort', cancel, { once: true });
  const providerPromise = Promise.resolve().then(() => adapter.stream
    ? adapter.stream(request, (event) => {
        if (acceptEvents) return onEvent(event);
      })
    : adapter.generate(request)).catch((error) => {
      if (timedOut) throw timeoutError;
      throw error;
    });
  try {
    return await Promise.race([
      providerPromise,
      timeoutPromise,
      cancellationPromise,
    ]);
  } finally {
    acceptEvents = false;
    if (timeout) clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
    signal.removeEventListener('abort', cancel);
  }
}

function gatewayUsage(
  usage: ProviderUsage | undefined,
  target: RouteTarget,
  adapter: ProviderAdapter,
): UsageSummary {
  const inputTokens = usage?.promptTokens ?? 0;
  const outputTokens = usage?.completionTokens ?? 0;
  return {
    provider: adapter.provider || target.provider,
    model: adapter.model || target.model,
    inputTokens,
    outputTokens,
    totalTokens: usage?.totalTokens ?? inputTokens + outputTokens,
    ...(usage?.estimatedCostUSD === undefined
      ? {}
      : { cost: usage.estimatedCostUSD }),
  };
}

function compactResult(
  value: ModelGenerateResult & Record<string, unknown>,
): ModelGenerateResult {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as unknown as ModelGenerateResult;
}

function classifyProviderError(
  error: unknown,
  callId: string,
  signal: AbortSignal,
): GatewayError {
  if (signal.aborted) {
    return new GatewayError('cancelled', { callId, cause: error });
  }
  if (error instanceof GatewayError) {
    return new GatewayError(error.gatewayCode, {
      retryable: error.retryable,
      retryAfterMs: error.retryAfterMs,
      callId,
      cause: error,
    });
  }
  const candidate = error as { statusCode?: unknown; name?: unknown };
  if (candidate?.name === 'TimeoutError') {
    return new GatewayError('provider_timeout', { callId, cause: error });
  }
  if (typeof candidate?.statusCode === 'number' && candidate.statusCode === 429) {
    return new GatewayError('rate_limited', { callId, cause: error });
  }
  return new GatewayError('provider_unavailable', { callId, cause: error });
}

function highestTier(tiers: import('@adaptive-agent/gateway-protocol').InferenceTier[]) {
  return [...INFERENCE_TIERS].reverse().find((tier) => tiers.includes(tier));
}
