import { createHash } from 'node:crypto';
import type { JsonObject, JsonValue, RemoteToolDescriptor, ToolExecuteParams } from '@adaptive-agent/gateway-protocol';
import { GatewayError } from './errors.js';

export type RemoteToolName = 'web_search@1' | 'read_web_page@1';
export type RemoteProviderName = 'brave' | 'serper' | 'parallel';

export interface RemoteToolPolicy {
  tools: Array<{
    name: RemoteToolName;
    provider: RemoteProviderName;
    apiKeyEnv: string;
    maxConcurrency?: number;
    accountQuota?: number;
    accountQuotaWindowMs?: number;
    timeoutMs?: number;
    maxOutputBytes?: number;
    estimatedCostPerRequestUSD?: number;
    baseUrl?: string;
  }>;
}

export interface RemoteToolProviderResult {
  output: JsonValue;
  units?: number;
  cost?: number;
  providerRequestId?: string;
}

export interface RemoteToolProvider {
  readonly provider: RemoteProviderName;
  readonly operation: RemoteToolName;
  execute(input: JsonObject, context: { signal: AbortSignal; timeoutMs: number; idempotencyKey: string }): Promise<RemoteToolProviderResult>;
  close?(): Promise<void> | void;
}

export type RemoteToolProviderFactory = (config: RemoteToolPolicy['tools'][number], apiKey: string) => Promise<RemoteToolProvider> | RemoteToolProvider;

interface RegisteredTool {
  config: Required<Pick<
    RemoteToolPolicy['tools'][number],
    'maxConcurrency' | 'accountQuota' | 'accountQuotaWindowMs' | 'timeoutMs' | 'maxOutputBytes'
  >> & RemoteToolPolicy['tools'][number];
  provider: RemoteToolProvider;
  active: number;
  accountUses: Map<string, { count: number; windowStartedAt: number }>;
}

export class RemoteToolRegistry {
  private readonly tools = new Map<RemoteToolName, RegisteredTool>();

  constructor(private readonly now: () => number = Date.now) {}

  static async create(
    policy: RemoteToolPolicy | undefined,
    env: Record<string, string | undefined> = process.env,
    factory: RemoteToolProviderFactory = createCoreRemoteToolProvider,
    options: { now?: () => number } = {},
  ): Promise<RemoteToolRegistry> {
    const registry = new RemoteToolRegistry(options.now);
    validatePolicy(policy);
    for (const raw of policy?.tools ?? []) {
      validateConfig(raw);
      if (registry.tools.has(raw.name)) throw new Error(`duplicate remote tool ${raw.name}`);
      const key = env[raw.apiKeyEnv]?.trim();
      if (!key) throw new Error(`remote tool policy requires environment variable: ${raw.apiKeyEnv}`);
      const config = {
        ...raw,
        maxConcurrency: raw.maxConcurrency ?? 4,
        accountQuota: raw.accountQuota ?? 1_000,
        accountQuotaWindowMs: raw.accountQuotaWindowMs ?? 60_000,
        timeoutMs: raw.timeoutMs ?? 30_000,
        maxOutputBytes: raw.maxOutputBytes ?? 262_144,
      };
      const provider = await factory(config, key);
      if (provider.provider !== config.provider || provider.operation !== config.name) {
        throw new Error(`remote tool provider identity mismatch for ${config.name}`);
      }
      registry.tools.set(raw.name, {
        config,
        provider,
        active: 0,
        accountUses: new Map(),
      });
    }
    return registry;
  }

  descriptors(): RemoteToolDescriptor[] {
    return [...this.tools.keys()].map((name) => ({ name: name.slice(0, name.indexOf('@')), schemaVersion: '1' }));
  }

  capabilities(): string[] { return [...this.tools.keys()]; }
  has(name: string): name is RemoteToolName { return this.tools.has(name as RemoteToolName); }
  providerFor(name: RemoteToolName): RemoteProviderName {
    return this.tools.get(name)!.provider.provider;
  }

  validate(name: RemoteToolName, input: JsonObject, requestedTimeout?: number): number {
    const entry = this.tools.get(name);
    if (!entry) throw new GatewayError('capability_not_entitled');
    validateInput(name, input);
    if (requestedTimeout !== undefined && (
      !Number.isSafeInteger(requestedTimeout) || requestedTimeout < 100
    )) {
      throw new GatewayError('invalid_params');
    }
    return Math.min(requestedTimeout ?? entry.config.timeoutMs, entry.config.timeoutMs);
  }

  async execute(
    name: RemoteToolName,
    accountId: string,
    input: JsonObject,
    requestedTimeout: number | undefined,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<RemoteToolProviderResult & { provider: string; operation: string }> {
    const entry = this.tools.get(name)!;
    const timeoutMs = this.validate(name, input, requestedTimeout);
    if (entry.active >= entry.config.maxConcurrency) throw new GatewayError('rate_limited', { retryAfterMs: 250, idempotencyKey });
    this.consumeQuota(entry, accountId, idempotencyKey);
    entry.active += 1;
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('remote tool timeout'));
    }, timeoutMs);
    try {
      const result = await entry.provider.execute(input, { signal: controller.signal, timeoutMs, idempotencyKey });
      const bytes = new TextEncoder().encode(JSON.stringify(result.output)).byteLength;
      if (bytes > entry.config.maxOutputBytes) {
        throw new GatewayError('provider_unavailable', {
          idempotencyKey,
          retryable: false,
        });
      }
      return {
        ...result,
        units: result.units ?? 1,
        cost: result.cost ?? entry.config.estimatedCostPerRequestUSD,
        provider: entry.provider.provider,
        operation: name,
      };
    } catch (error) {
      if (signal.aborted) throw new GatewayError('cancelled', { idempotencyKey, cause: error });
      if (timedOut) throw new GatewayError('provider_timeout', { idempotencyKey, cause: error });
      throw error instanceof GatewayError ? error : new GatewayError('provider_unavailable', { idempotencyKey, cause: error });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      entry.active -= 1;
    }
  }

  async close(): Promise<void> { await Promise.all([...this.tools.values()].map((x) => x.provider.close?.())); }

  private consumeQuota(
    entry: RegisteredTool,
    accountId: string,
    idempotencyKey: string,
  ): void {
    const now = this.now();
    const current = entry.accountUses.get(accountId);
    const usage = !current || now - current.windowStartedAt >= entry.config.accountQuotaWindowMs
      ? { count: 0, windowStartedAt: now }
      : current;
    if (usage.count >= entry.config.accountQuota) {
      throw new GatewayError('quota_exceeded', { idempotencyKey });
    }
    usage.count += 1;
    entry.accountUses.set(accountId, usage);
  }
}

export function stableToolRequestHash(params: ToolExecuteParams): string {
  return createHash('sha256')
    .update(stableJson({ toolName: params.toolName, input: params.input }))
    .digest('hex');
}

function validateInput(name: RemoteToolName, input: JsonObject): void {
  const keys = Object.keys(input);
  const allowed = name === 'web_search@1' ? ['query', 'maxResults', 'purpose', 'expectedUse', 'freshnessRequired', 'domainHints', 'excludeDomains', 'exactPhrases', 'answerType'] : ['url', 'objective', 'maxTextLength'];
  if (keys.some((key) => !allowed.includes(key))) throw new GatewayError('invalid_params');
  if (name === 'web_search@1') {
    boundedString(input.query, 2048);
    optionalString(input.purpose, 2048);
    boundedInteger(input.maxResults, 1, 20, true);
    enumValue(input.expectedUse, ['verify', 'discover', 'compare', 'current_status']);
    enumValue(input.answerType, ['date', 'number', 'name', 'place', 'organization', 'file', 'other']);
    if (input.freshnessRequired !== undefined && typeof input.freshnessRequired !== 'boolean') throw new GatewayError('invalid_params');
    for (const field of ['domainHints', 'excludeDomains', 'exactPhrases'] as const) validateStringArray(input[field], 16, 256);
  } else {
    boundedString(input.url, 4096);
    let url: URL; try { url = new URL(input.url as string); } catch { throw new GatewayError('invalid_params'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new GatewayError('invalid_params');
    optionalString(input.objective, 4096);
    boundedInteger(input.maxTextLength, 1, 50_000, true);
  }
}

function validateConfig(value: RemoteToolPolicy['tools'][number]): void {
  if (!isRecord(value)) throw new Error('invalid remote tool configuration');
  const allowedKeys = new Set([
    'name',
    'provider',
    'apiKeyEnv',
    'maxConcurrency',
    'accountQuota',
    'accountQuotaWindowMs',
    'timeoutMs',
    'maxOutputBytes',
    'estimatedCostPerRequestUSD',
    'baseUrl',
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error('unknown remote tool configuration field');
  }
  if (!['web_search@1', 'read_web_page@1'].includes(value.name)) throw new Error('unsupported remote tool');
  if (!['brave', 'serper', 'parallel'].includes(value.provider) || (value.name === 'read_web_page@1' && value.provider !== 'parallel')) throw new Error('unsupported remote tool provider');
  if (!/^[A-Z][A-Z0-9_]*$/.test(value.apiKeyEnv)) throw new Error('invalid remote tool apiKeyEnv');
  for (const [key, max] of [
    ['maxConcurrency', 100],
    ['accountQuota', 1_000_000],
    ['accountQuotaWindowMs', 86_400_000],
    ['timeoutMs', 120_000],
    ['maxOutputBytes', 1_048_576],
  ] as const) {
    if (value[key] !== undefined && (
      !Number.isSafeInteger(value[key]) || value[key]! < 1 || value[key]! > max
    )) {
      throw new Error(`invalid remote tool ${key}`);
    }
  }
  if (value.estimatedCostPerRequestUSD !== undefined && (
    !Number.isFinite(value.estimatedCostPerRequestUSD) || value.estimatedCostPerRequestUSD < 0
  )) {
    throw new Error('invalid remote tool estimatedCostPerRequestUSD');
  }
  if (value.baseUrl !== undefined) {
    let baseUrl: URL;
    try {
      baseUrl = new URL(value.baseUrl);
    } catch {
      throw new Error('invalid remote tool baseUrl');
    }
    if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) {
      throw new Error('invalid remote tool baseUrl');
    }
  }
}

function validatePolicy(policy: RemoteToolPolicy | undefined): void {
  if (policy === undefined) return;
  if (!isRecord(policy) || Object.keys(policy).some((key) => key !== 'tools') || !Array.isArray(policy.tools)) {
    throw new Error('invalid remote tool policy');
  }
  if (policy.tools.length > 2) throw new Error('invalid remote tool policy');
}

function boundedString(value: JsonValue | undefined, max: number): void {
  if (typeof value !== 'string' || !value.trim() || new TextEncoder().encode(value).byteLength > max) {
    throw new GatewayError('invalid_params');
  }
}

function optionalString(value: JsonValue | undefined, max: number): void {
  if (value !== undefined) boundedString(value, max);
}

function boundedInteger(
  value: JsonValue | undefined,
  min: number,
  max: number,
  optional: boolean,
): void {
  if (value === undefined && optional) return;
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new GatewayError('invalid_params');
  }
}

function enumValue(value: JsonValue | undefined, allowed: string[]): void {
  if (value !== undefined && (typeof value !== 'string' || !allowed.includes(value))) {
    throw new GatewayError('invalid_params');
  }
}

function validateStringArray(
  value: JsonValue | undefined,
  maxItems: number,
  maxBytes: number,
): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > maxItems) throw new GatewayError('invalid_params');
  for (const item of value) boundedString(item, maxBytes);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => (
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>)
            .filter(([, nested]) => nested !== undefined)
            .sort(([left], [right]) => left.localeCompare(right)),
        )
      : entry
  ));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function createCoreRemoteToolProvider(config: RemoteToolPolicy['tools'][number], apiKey: string): Promise<RemoteToolProvider> {
  type CoreTool = {
    execute(input: JsonValue, context: unknown): Promise<JsonValue>;
    getAccounting?: (
      output: JsonValue,
      input: JsonValue,
      context: unknown,
    ) => { units: { requests: number }; estimatedCostUSD?: number } | undefined;
  };
  const moduleName = '@adaptive-agent/core';
  const core = await import(moduleName) as {
    createWebSearchTool(config: Record<string, unknown>): CoreTool;
    createReadWebPageTool(config: Record<string, unknown>): CoreTool;
  };
  return {
    provider: config.provider,
    operation: config.name,
    async execute(input, context) {
      // Core web tools cache full results per instance. Constructing one per call
      // prevents the gateway process from retaining page/search content.
      const tool = config.name === 'web_search@1'
        ? core.createWebSearchTool({
            provider: config.provider,
            apiKey,
            baseUrl: config.baseUrl,
            timeoutMs: config.timeoutMs,
            estimatedCostPerRequestUSD: config.estimatedCostPerRequestUSD,
          })
        : core.createReadWebPageTool({
            provider: 'parallel',
            apiKey,
            baseUrl: config.baseUrl,
            timeoutMs: config.timeoutMs,
            maxTextLength: 50_000,
            estimatedCostPerRequestUSD: config.estimatedCostPerRequestUSD,
          });
      const toolContext = {
        runId: context.idempotencyKey,
        rootRunId: context.idempotencyKey,
        delegationDepth: 0,
        stepId: 'gateway',
        toolCallId: context.idempotencyKey,
        idempotencyKey: context.idempotencyKey,
        timeoutMs: context.timeoutMs,
        signal: context.signal,
        emit: async () => {},
      } as never;
      const output = await tool.execute(input, toolContext);
      const accounting = tool.getAccounting?.(output, input, toolContext);
      return { output: output as JsonValue, units: accounting?.units.requests ?? 1, cost: accounting?.estimatedCostUSD };
    },
  };
}
