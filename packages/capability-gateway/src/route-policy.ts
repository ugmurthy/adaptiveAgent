import {
  INFERENCE_TIERS,
  PROTOCOL_LIMITS,
  type InferenceTier,
  type JsonObject,
  type JsonValue,
  type ModelGenerateParams,
  type ModelInvocationIdentity,
  type ModelMessage,
  type ModelToolCall,
} from '@adaptive-agent/gateway-protocol';
import { GatewayError } from './errors.js';

export type ProviderName = 'openrouter' | 'ollama' | 'mistral' | 'mesh';

export interface RouteTarget {
  provider: ProviderName;
  model: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  maxConcurrency: number;
  structuredOutputMode?: 'prompted' | 'strict';
}

export interface TierRouteLimits {
  maxMessages: number;
  maxOutputTokens: number;
  modelTimeoutMs: number;
}

export interface TierRoutePolicy {
  limits: TierRouteLimits;
  targets: RouteTarget[];
}

export interface RoutePolicy {
  version: string;
  tiers: Record<InferenceTier, TierRoutePolicy>;
}

export type ProviderStreamEvent =
  | { type: 'start'; provider: string; model: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call_start'; toolCallId: string; name: string }
  | { type: 'tool_call_delta'; toolCallId: string; argumentsDelta: string }
  | { type: 'tool_call_end'; toolCall: ModelToolCall }
  | { type: 'summary'; summary: string }
  | { type: 'usage'; usage: ProviderUsage }
  | { type: 'done' }
  | { type: 'error'; error: { message: string; name?: string } };

export interface ProviderUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  estimatedCostUSD?: number;
  provider?: string;
  model?: string;
}

export interface ProviderModelRequest {
  messages: ModelMessage[];
  tools?: Array<{ name: string; description: string; inputSchema: JsonObject }>;
  outputSchema?: JsonObject;
  signal?: AbortSignal;
  modelTimeoutMs?: number;
  invocation: ModelInvocationIdentity;
}

export interface ProviderModelResponse {
  text?: string;
  structuredOutput?: JsonValue;
  toolCalls?: ModelToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error';
  usage?: ProviderUsage;
  providerResponseId?: string;
  summary?: string;
}

export interface ProviderAdapter {
  provider: string;
  model: string;
  capabilities: {
    toolCalling: boolean;
    jsonOutput: boolean;
    streaming: boolean;
    usage: boolean;
  };
  generate(request: ProviderModelRequest): Promise<ProviderModelResponse>;
  stream?(
    request: ProviderModelRequest,
    onEvent: (event: ProviderStreamEvent) => Promise<void> | void,
  ): Promise<ProviderModelResponse>;
  close?(): Promise<void> | void;
}

export type AdapterFactory = (
  target: RouteTarget,
) => ProviderAdapter | Promise<ProviderAdapter>;

export async function loadRoutePolicy(path: string): Promise<RoutePolicy> {
  const value = await Bun.file(path).json();
  try {
    return validateRoutePolicy(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'validation failed';
    throw new Error(`invalid route policy: ${detail}`, { cause: error });
  }
}

export function assertRoutePolicyEnvironment(
  policy: RoutePolicy,
  env: Record<string, string | undefined> = process.env,
): void {
  const missing = new Set<string>();
  for (const tier of INFERENCE_TIERS) {
    for (const target of policy.tiers[tier].targets) {
      if (target.apiKeyEnv && !env[target.apiKeyEnv]?.trim()) {
        missing.add(target.apiKeyEnv);
      }
    }
  }
  if (missing.size > 0) {
    throw new Error(`route policy requires environment variables: ${[...missing].sort().join(', ')}`);
  }
}

export function validateRoutePolicy(value: unknown): RoutePolicy {
  const policy = plainObject(value, 'route policy');
  exactKeys(policy, ['version', 'tiers'], 'route policy');
  boundedString(policy.version, 'route policy version');
  const tiers = plainObject(policy.tiers, 'route policy tiers');
  exactKeys(tiers, INFERENCE_TIERS, 'route policy tiers');

  const providerConcurrency = new Map<string, number>();
  for (const tier of INFERENCE_TIERS) {
    const tierPolicy = plainObject(tiers[tier], `tier ${tier}`);
    exactKeys(tierPolicy, ['limits', 'targets'], `tier ${tier}`);
    validateLimits(tierPolicy.limits, tier);
    if (!Array.isArray(tierPolicy.targets) || tierPolicy.targets.length === 0) {
      throw new Error(`tier ${tier} requires at least one route target`);
    }
    if (tierPolicy.targets.length > 16) {
      throw new Error(`tier ${tier} has too many route targets`);
    }
    for (const [index, entry] of tierPolicy.targets.entries()) {
      const target = validateTarget(entry, `${tier}.targets[${index}]`);
      const existing = providerConcurrency.get(target.provider);
      if (existing !== undefined && existing !== target.maxConcurrency) {
        throw new Error(`provider ${target.provider} must use one maxConcurrency value`);
      }
      providerConcurrency.set(target.provider, target.maxConcurrency);
    }
  }
  return structuredClone(value) as RoutePolicy;
}

export function assertRequestWithinTierLimits(
  params: ModelGenerateParams,
  policy: TierRoutePolicy,
): void {
  if (params.messages.length > policy.limits.maxMessages) {
    throw new GatewayError('invalid_params');
  }
  if (
    params.maxOutputTokens !== undefined &&
    params.maxOutputTokens > policy.limits.maxOutputTokens
  ) {
    throw new GatewayError('invalid_params');
  }
}

export function adapterSupportsRequest(
  adapter: ProviderAdapter,
  params: ModelGenerateParams,
): boolean {
  return (!params.tools?.length || adapter.capabilities.toolCalling) &&
    (!params.responseSchema || adapter.capabilities.jsonOutput);
}

export function createDefaultAdapterFactory(
  env: Record<string, string | undefined> = process.env,
): AdapterFactory {
  return async (target) => {
    const apiKey = target.apiKeyEnv ? env[target.apiKeyEnv] : undefined;
    if (target.apiKeyEnv && !apiKey) {
      throw new GatewayError('provider_unavailable');
    }
    const moduleName = '@adaptive-agent/core';
    const core = await import(moduleName) as {
      createModelAdapter(config: {
        provider: ProviderName;
        model: string;
        apiKey?: string;
        baseUrl?: string;
        maxConcurrentRequests?: number;
        structuredOutputMode?: 'prompted' | 'strict';
      }): ProviderAdapter;
    };
    return core.createModelAdapter({
      provider: target.provider,
      model: target.model,
      apiKey,
      baseUrl: target.baseUrl,
      maxConcurrentRequests: target.maxConcurrency,
      structuredOutputMode: target.structuredOutputMode,
    });
  };
}

export class AdapterPool {
  private readonly adapters = new Map<string, Promise<ProviderAdapter>>();
  private readonly activeByProvider = new Map<ProviderName, number>();
  private readonly concurrencyByProvider = new Map<ProviderName, number>();

  constructor(
    policy: RoutePolicy,
    private readonly factory: AdapterFactory = createDefaultAdapterFactory(),
  ) {
    for (const tier of INFERENCE_TIERS) {
      for (const target of policy.tiers[tier].targets) {
        this.concurrencyByProvider.set(target.provider, target.maxConcurrency);
      }
    }
  }

  async acquire(target: RouteTarget): Promise<{
    adapter: ProviderAdapter;
    release(): void;
  }> {
    const active = this.activeByProvider.get(target.provider) ?? 0;
    const maximum = this.concurrencyByProvider.get(target.provider) ?? target.maxConcurrency;
    if (active >= maximum) {
      throw new GatewayError('rate_limited', { retryAfterMs: 250 });
    }
    this.activeByProvider.set(target.provider, active + 1);

    try {
      const key = adapterKey(target);
      let pending = this.adapters.get(key);
      if (!pending) {
        pending = Promise.resolve(this.factory(target));
        this.adapters.set(key, pending);
        void pending.catch(() => {
          if (this.adapters.get(key) === pending) {
            this.adapters.delete(key);
          }
        });
      }
      const adapter = await pending;
      let released = false;
      return {
        adapter,
        release: () => {
          if (released) return;
          released = true;
          this.activeByProvider.set(target.provider, Math.max(
            0,
            (this.activeByProvider.get(target.provider) ?? 1) - 1,
          ));
        },
      };
    } catch (error) {
      this.activeByProvider.set(target.provider, Math.max(
        0,
        (this.activeByProvider.get(target.provider) ?? 1) - 1,
      ));
      throw error;
    }
  }

  async close(): Promise<void> {
    const adapters = await Promise.all(
      [...this.adapters.values()].map((pending) => pending.catch(() => undefined)),
    );
    await Promise.all(adapters.map((adapter) => adapter?.close?.()));
  }
}

function validateLimits(value: unknown, tier: InferenceTier): void {
  const limits = plainObject(value, `${tier}.limits`);
  exactKeys(limits, ['maxMessages', 'maxOutputTokens', 'modelTimeoutMs'], `${tier}.limits`);
  positiveInteger(limits.maxMessages, `${tier}.limits.maxMessages`, PROTOCOL_LIMITS.maxMessages);
  positiveInteger(limits.maxOutputTokens, `${tier}.limits.maxOutputTokens`, 1_000_000);
  positiveInteger(limits.modelTimeoutMs, `${tier}.limits.modelTimeoutMs`, 15 * 60_000);
}

function validateTarget(value: unknown, at: string): RouteTarget {
  const target = plainObject(value, at);
  exactKeys(
    target,
    ['provider', 'model', 'apiKeyEnv', 'baseUrl', 'maxConcurrency', 'structuredOutputMode'],
    at,
  );
  if (!['openrouter', 'ollama', 'mistral', 'mesh'].includes(String(target.provider))) {
    throw new Error(`${at}.provider is unsupported`);
  }
  if (target.provider !== 'ollama' && target.apiKeyEnv === undefined) {
    throw new Error(`${at}.apiKeyEnv is required for ${String(target.provider)}`);
  }
  boundedString(target.model, `${at}.model`);
  positiveInteger(target.maxConcurrency, `${at}.maxConcurrency`, 1_000);
  if (target.apiKeyEnv !== undefined && (
    typeof target.apiKeyEnv !== 'string' ||
    !/^[A-Z][A-Z0-9_]*$/.test(target.apiKeyEnv)
  )) {
    throw new Error(`${at}.apiKeyEnv is invalid`);
  }
  if (target.baseUrl !== undefined) {
    boundedString(target.baseUrl, `${at}.baseUrl`, PROTOCOL_LIMITS.maxUrlBytes);
    let url: URL;
    try {
      url = new URL(target.baseUrl as string);
    } catch {
      throw new Error(`${at}.baseUrl must be a valid URL`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`${at}.baseUrl must use HTTP or HTTPS`);
    }
    if (url.username || url.password) {
      throw new Error(`${at}.baseUrl must not contain credentials`);
    }
  }
  if (
    target.structuredOutputMode !== undefined &&
    target.structuredOutputMode !== 'prompted' &&
    target.structuredOutputMode !== 'strict'
  ) {
    throw new Error(`${at}.structuredOutputMode is invalid`);
  }
  return target as unknown as RouteTarget;
}

function plainObject(value: unknown, at: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${at} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  at: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${at} contains an unknown field`);
}

function boundedString(value: unknown, at: string, maximum = 256): void {
  if (
    typeof value !== 'string' ||
    !value ||
    new TextEncoder().encode(value).byteLength > maximum
  ) {
    throw new Error(`${at} must be a bounded non-empty string`);
  }
}

function positiveInteger(value: unknown, at: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new Error(`${at} must be a positive bounded integer`);
  }
}

function adapterKey(target: RouteTarget): string {
  return JSON.stringify([
    target.provider,
    target.model,
    target.apiKeyEnv ?? null,
    target.baseUrl ?? null,
    target.structuredOutputMode ?? null,
  ]);
}
