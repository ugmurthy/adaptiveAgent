import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { AgentDefaults, JsonObject, JsonValue, ModelAdapterConfig } from './core.js';

import { ConfigValidationError } from './errors.js';

export const DEFAULT_GATEWAY_CONFIG_PATH = 'config/gateway.json';
export const DEFAULT_AGENT_CONFIG_DIR = 'config/agents';
export const GATEWAY_HOOK_SLOTS = [
  'onAuthenticate',
  'onSessionResolve',
  'beforeRoute',
  'beforeInboundMessage',
  'beforeRunStart',
  'afterRunResult',
  'onAgentEvent',
  'beforeOutboundFrame',
  'onDisconnect',
  'onError',
] as const;

const INVOCATION_MODES = ['chat', 'run'] as const;
const CAPTURE_MODES = ['full', 'summary', 'none'] as const;
const HOOK_FAILURE_POLICIES = ['fail', 'warn', 'ignore'] as const;
const MODEL_PROVIDERS: ModelAdapterConfig['provider'][] = ['openrouter', 'ollama', 'mistral', 'mesh'];

export type InvocationMode = (typeof INVOCATION_MODES)[number];
export type HookFailurePolicy = (typeof HOOK_FAILURE_POLICIES)[number];
export type GatewayHookSlot = (typeof GATEWAY_HOOK_SLOTS)[number];

export interface LoadedConfig<TConfig> {
  path: string;
  config: TConfig;
}

export interface GatewayServerConfig {
  host: string;
  port: number;
  websocketPath: string;
  healthPath?: string;
}

export interface GatewayAuthConfig {
  provider: string;
  settings: JsonObject;
}

export interface GatewayCronConfig {
  enabled: boolean;
  schedulerLeaseMs: number;
  maxConcurrentJobs: number;
}

export interface GatewayChannelDefaults {
  sessionConcurrency: number;
}

export interface GatewayChannelConfig {
  id: string;
  name: string;
  isPublic?: boolean;
  allowedInvocationModes?: InvocationMode[];
  metadata?: JsonObject;
}

export interface GatewayBindingMatch {
  channelId?: string;
  tenantId?: string;
  roles?: string[];
}

export interface GatewayBinding {
  match: GatewayBindingMatch;
  agentId: string;
}

export interface GatewayHooksConfig {
  failurePolicy: HookFailurePolicy;
  modules: string[];
  onAuthenticate: string[];
  onSessionResolve: string[];
  beforeRoute: string[];
  beforeInboundMessage: string[];
  beforeRunStart: string[];
  afterRunResult: string[];
  onAgentEvent: string[];
  beforeOutboundFrame: string[];
  onDisconnect: string[];
  onError: string[];
}

export interface GatewayConfig {
  server: GatewayServerConfig;
  auth?: GatewayAuthConfig;
  cron?: GatewayCronConfig;
  channels?: {
    defaults: GatewayChannelDefaults;
    list: GatewayChannelConfig[];
  };
  bindings: GatewayBinding[];
  defaultAgentId?: string;
  hooks: GatewayHooksConfig;
}

export interface AgentRoutingConfig {
  allowedChannels?: string[];
  allowedTenants?: string[];
  requiredRoles?: string[];
}

export interface AgentConfig {
  id: string;
  name: string;
  invocationModes: InvocationMode[];
  defaultInvocationMode: InvocationMode;
  model: ModelAdapterConfig;
  systemInstructions?: string;
  tools: string[];
  delegates: string[];
  defaults?: Partial<AgentDefaults>;
  routing?: AgentRoutingConfig;
  metadata?: JsonObject;
}

export interface LoadGatewayConfigOptions {
  cwd?: string;
  configPath?: string;
}

export interface LoadAgentConfigOptions {
  cwd?: string;
  configPath: string;
}

export interface LoadAgentConfigsOptions {
  cwd?: string;
  dir?: string;
}

export async function loadGatewayConfig(options: LoadGatewayConfigOptions = {}): Promise<LoadedConfig<GatewayConfig>> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = resolve(cwd, options.configPath ?? DEFAULT_GATEWAY_CONFIG_PATH);
  const rawConfig = await readJsonFile(configPath, 'gateway');

  return {
    path: configPath,
    config: validateGatewayConfig(rawConfig, configPath),
  };
}

export async function loadAgentConfigFile(options: LoadAgentConfigOptions): Promise<LoadedConfig<AgentConfig>> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = resolve(cwd, options.configPath);
  const rawConfig = await readJsonFile(configPath, 'agent');

  return {
    path: configPath,
    config: validateAgentConfig(rawConfig, configPath),
  };
}

export async function loadAgentConfigs(options: LoadAgentConfigsOptions = {}): Promise<Array<LoadedConfig<AgentConfig>>> {
  const cwd = options.cwd ?? process.cwd();
  const directoryPath = resolve(cwd, options.dir ?? DEFAULT_AGENT_CONFIG_DIR);
  const directoryEntries = await readdir(directoryPath, { withFileTypes: true });
  const configEntries = directoryEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .sort((left, right) => left.name.localeCompare(right.name));

  const loadedConfigs = await Promise.all(
    configEntries.map((entry) =>
      loadAgentConfigFile({
        cwd: directoryPath,
        configPath: entry.name,
      }),
    ),
  );

  const seenAgentIds = new Map<string, string>();
  const duplicateIssues: string[] = [];

  for (const loadedConfig of loadedConfigs) {
    const existingPath = seenAgentIds.get(loadedConfig.config.id);
    if (existingPath) {
      duplicateIssues.push(
        `Duplicate agent id "${loadedConfig.config.id}" found in ${existingPath} and ${loadedConfig.path}.`,
      );
      continue;
    }

    seenAgentIds.set(loadedConfig.config.id, loadedConfig.path);
  }

  if (duplicateIssues.length > 0) {
    throw new ConfigValidationError('agent', directoryPath, duplicateIssues);
  }

  return loadedConfigs;
}

function validateGatewayConfig(value: unknown, sourcePath: string): GatewayConfig {
  const issues: string[] = [];
  const root = expectObject(value, 'gateway', issues);

  const server = parseGatewayServerConfig(root?.server, 'server', issues);
  const auth = parseGatewayAuthConfig(root?.auth, 'auth', issues);
  const cron = parseGatewayCronConfig(root?.cron, 'cron', issues);
  const channels = parseGatewayChannelsConfig(root?.channels, 'channels', issues);
  const bindings = parseGatewayBindings(root?.bindings, 'bindings', issues);
  const defaultAgentId = expectOptionalNonEmptyString(root?.defaultAgentId, 'defaultAgentId', issues);
  const hooks = parseGatewayHooksConfig(root?.hooks, 'hooks', issues);

  if (server.websocketPath && server.healthPath && server.websocketPath === server.healthPath) {
    issues.push('server.healthPath must be different from server.websocketPath.');
  }

  if (channels) {
    const channelIds = new Set(channels.list.map((channel) => channel.id));
    for (const binding of bindings) {
      if (binding.match.channelId && !channelIds.has(binding.match.channelId)) {
        issues.push(
          `bindings referencing channelId "${binding.match.channelId}" must match an entry in channels.list.`,
        );
      }
    }
  }

  if (issues.length > 0) {
    throw new ConfigValidationError('gateway', sourcePath, issues);
  }

  return {
    server,
    auth,
    cron,
    channels,
    bindings,
    defaultAgentId,
    hooks,
  };
}

function validateAgentConfig(value: unknown, sourcePath: string): AgentConfig {
  const issues: string[] = [];
  const root = expectObject(value, 'agent', issues);

  const id = expectNonEmptyString(root?.id, 'id', issues) ?? 'invalid-agent-id';
  const name = expectNonEmptyString(root?.name, 'name', issues) ?? 'Invalid Agent';
  const invocationModes = parseInvocationModes(root?.invocationModes, 'invocationModes', issues);
  const defaultInvocationMode = parseDefaultInvocationMode(
    root?.defaultInvocationMode,
    invocationModes,
    'defaultInvocationMode',
    issues,
  );
  const model = parseModelConfig(root?.model, 'model', issues);
  const systemInstructions = expectOptionalNonEmptyString(root?.systemInstructions, 'systemInstructions', issues);
  const tools = expectStringArray(root?.tools, 'tools', issues) ?? [];
  const delegates = expectStringArray(root?.delegates, 'delegates', issues) ?? [];
  const defaults = parseAgentDefaults(root?.defaults, 'defaults', issues);
  const routing = parseAgentRoutingConfig(root?.routing, 'routing', issues);
  const metadata = expectOptionalJsonObject(root?.metadata, 'metadata', issues);

  if (issues.length > 0) {
    throw new ConfigValidationError('agent', sourcePath, issues);
  }

  return {
    id,
    name,
    invocationModes,
    defaultInvocationMode,
    model,
    systemInstructions,
    tools,
    delegates,
    defaults,
    routing,
    metadata,
  };
}

async function readJsonFile(path: string, configType: 'gateway' | 'agent'): Promise<unknown> {
  let fileContents: string;

  try {
    fileContents = await readFile(path, 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigValidationError(configType, path, [`Unable to read config file: ${message}`]);
  }

  try {
    return JSON.parse(fileContents) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigValidationError(configType, path, [`Invalid JSON: ${message}`]);
  }
}

function parseGatewayServerConfig(value: unknown, path: string, issues: string[]): GatewayServerConfig {
  const server = expectObject(value, path, issues);

  return {
    host: expectNonEmptyString(server?.host, `${path}.host`, issues) ?? '0.0.0.0',
    port: expectPositiveInteger(server?.port, `${path}.port`, issues) ?? 0,
    websocketPath: expectHttpPath(server?.websocketPath, `${path}.websocketPath`, issues) ?? '/ws',
    healthPath: expectOptionalHttpPath(server?.healthPath, `${path}.healthPath`, issues),
  };
}

function parseGatewayAuthConfig(value: unknown, path: string, issues: string[]): GatewayAuthConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  const auth = expectObject(value, path, issues);
  const provider = expectNonEmptyString(auth?.provider, `${path}.provider`, issues) ?? 'invalid-auth-provider';
  const settings: JsonObject = {};

  if (auth) {
    for (const [key, entryValue] of Object.entries(auth)) {
      if (key === 'provider') {
        continue;
      }

      const jsonValue = toJsonValue(entryValue, `${path}.${key}`, issues);
      if (jsonValue !== undefined) {
        settings[key] = jsonValue;
      }
    }
  }

  return {
    provider,
    settings,
  };
}

function parseGatewayCronConfig(value: unknown, path: string, issues: string[]): GatewayCronConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  const cron = expectObject(value, path, issues);

  return {
    enabled: expectBoolean(cron?.enabled, `${path}.enabled`, issues) ?? false,
    schedulerLeaseMs: expectPositiveInteger(cron?.schedulerLeaseMs, `${path}.schedulerLeaseMs`, issues) ?? 0,
    maxConcurrentJobs: expectPositiveInteger(cron?.maxConcurrentJobs, `${path}.maxConcurrentJobs`, issues) ?? 0,
  };
}

function parseGatewayChannelsConfig(
  value: unknown,
  path: string,
  issues: string[],
): GatewayConfig['channels'] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const channels = expectObject(value, path, issues);
  const defaults = expectObject(channels?.defaults, `${path}.defaults`, issues);
  const channelEntries = expectArray(channels?.list, `${path}.list`, issues) ?? [];
  const list = channelEntries.map((entry, index) =>
    parseGatewayChannelConfig(entry, `${path}.list[${index}]`, issues),
  );
  const seenChannelIds = new Set<string>();

  for (const channel of list) {
    if (seenChannelIds.has(channel.id)) {
      issues.push(`Duplicate channel id "${channel.id}" in ${path}.list.`);
      continue;
    }

    seenChannelIds.add(channel.id);
  }

  return {
    defaults: {
      sessionConcurrency:
        expectPositiveInteger(defaults?.sessionConcurrency, `${path}.defaults.sessionConcurrency`, issues) ?? 1,
    },
    list,
  };
}

function parseGatewayChannelConfig(value: unknown, path: string, issues: string[]): GatewayChannelConfig {
  const channel = expectObject(value, path, issues);

  return {
    id: expectNonEmptyString(channel?.id, `${path}.id`, issues) ?? 'invalid-channel-id',
    name: expectNonEmptyString(channel?.name, `${path}.name`, issues) ?? 'Invalid Channel',
    isPublic: expectOptionalBoolean(channel?.isPublic, `${path}.isPublic`, issues),
    allowedInvocationModes: parseOptionalInvocationModes(channel?.allowedInvocationModes, `${path}.allowedInvocationModes`, issues),
    metadata: expectOptionalJsonObject(channel?.metadata, `${path}.metadata`, issues),
  };
}

function parseGatewayBindings(value: unknown, path: string, issues: string[]): GatewayBinding[] {
  if (value === undefined) {
    return [];
  }

  const bindings = expectArray(value, path, issues) ?? [];

  return bindings.map((entry, index) => parseGatewayBinding(entry, `${path}[${index}]`, issues));
}

function parseGatewayBinding(value: unknown, path: string, issues: string[]): GatewayBinding {
  const binding = expectObject(value, path, issues);
  const match = expectObject(binding?.match, `${path}.match`, issues);
  const parsedMatch: GatewayBindingMatch = {
    channelId: expectOptionalNonEmptyString(match?.channelId, `${path}.match.channelId`, issues),
    tenantId: expectOptionalNonEmptyString(match?.tenantId, `${path}.match.tenantId`, issues),
    roles: expectOptionalStringArray(match?.roles, `${path}.match.roles`, issues),
  };

  if (!parsedMatch.channelId && !parsedMatch.tenantId && (!parsedMatch.roles || parsedMatch.roles.length === 0)) {
    issues.push(`${path}.match must declare at least one of channelId, tenantId, or roles.`);
  }

  return {
    match: parsedMatch,
    agentId: expectNonEmptyString(binding?.agentId, `${path}.agentId`, issues) ?? 'invalid-agent-id',
  };
}

function parseGatewayHooksConfig(value: unknown, path: string, issues: string[]): GatewayHooksConfig {
  if (value === undefined) {
    return createDefaultHooksConfig();
  }

  const hooks = expectObject(value, path, issues);
  const config: GatewayHooksConfig = {
    failurePolicy: parseHookFailurePolicy(hooks?.failurePolicy, `${path}.failurePolicy`, issues),
    modules: expectOptionalStringArray(hooks?.modules, `${path}.modules`, issues) ?? [],
    onAuthenticate: [],
    onSessionResolve: [],
    beforeRoute: [],
    beforeInboundMessage: [],
    beforeRunStart: [],
    afterRunResult: [],
    onAgentEvent: [],
    beforeOutboundFrame: [],
    onDisconnect: [],
    onError: [],
  };

  for (const slot of GATEWAY_HOOK_SLOTS) {
    config[slot] = expectOptionalStringArray(hooks?.[slot], `${path}.${slot}`, issues) ?? [];
  }

  return config;
}

function createDefaultHooksConfig(): GatewayHooksConfig {
  return {
    failurePolicy: 'fail',
    modules: [],
    onAuthenticate: [],
    onSessionResolve: [],
    beforeRoute: [],
    beforeInboundMessage: [],
    beforeRunStart: [],
    afterRunResult: [],
    onAgentEvent: [],
    beforeOutboundFrame: [],
    onDisconnect: [],
    onError: [],
  };
}

function parseHookFailurePolicy(value: unknown, path: string, issues: string[]): HookFailurePolicy {
  if (value === undefined) {
    return 'fail';
  }

  return expectEnum(value, HOOK_FAILURE_POLICIES, path, issues) ?? 'fail';
}

function parseInvocationModes(value: unknown, path: string, issues: string[]): InvocationMode[] {
  const invocationModes = expectStringArray(value, path, issues) ?? [];

  if (invocationModes.length === 0) {
    issues.push(`${path} must include at least one invocation mode.`);
    return ['chat'];
  }

  const seen = new Set<InvocationMode>();
  const parsedModes: InvocationMode[] = [];

  for (const invocationMode of invocationModes) {
    const parsedMode = expectEnum(invocationMode, INVOCATION_MODES, path, issues);
    if (!parsedMode || seen.has(parsedMode)) {
      continue;
    }

    seen.add(parsedMode);
    parsedModes.push(parsedMode);
  }

  return parsedModes.length > 0 ? parsedModes : ['chat'];
}

function parseOptionalInvocationModes(value: unknown, path: string, issues: string[]): InvocationMode[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  return parseInvocationModes(value, path, issues);
}

function parseDefaultInvocationMode(
  value: unknown,
  invocationModes: InvocationMode[],
  path: string,
  issues: string[],
): InvocationMode {
  const defaultInvocationMode = expectEnum(value, INVOCATION_MODES, path, issues) ?? invocationModes[0] ?? 'chat';

  if (!invocationModes.includes(defaultInvocationMode)) {
    issues.push(`${path} must be included in invocationModes.`);
  }

  return defaultInvocationMode;
}

function parseModelConfig(value: unknown, path: string, issues: string[]): ModelAdapterConfig {
  const model = expectObject(value, path, issues);
  const provider = expectEnum(model?.provider, MODEL_PROVIDERS, `${path}.provider`, issues) ?? 'ollama';
  const modelName = expectNonEmptyString(model?.model, `${path}.model`, issues) ?? 'invalid-model';
  const apiKey = expectOptionalNonEmptyString(model?.apiKey, `${path}.apiKey`, issues);
  const baseUrl = expectOptionalNonEmptyString(model?.baseUrl, `${path}.baseUrl`, issues);
  const siteUrl = expectOptionalNonEmptyString(model?.siteUrl, `${path}.siteUrl`, issues);
  const siteName = expectOptionalNonEmptyString(model?.siteName, `${path}.siteName`, issues);

  return {
    provider,
    model: modelName,
    apiKey,
    baseUrl,
    siteUrl,
    siteName,
  };
}

function parseAgentDefaults(value: unknown, path: string, issues: string[]): Partial<AgentDefaults> | undefined {
  if (value === undefined) {
    return undefined;
  }

  const defaults = expectObject(value, path, issues);
  const parsedDefaults: Partial<AgentDefaults> = {};

  assignIfDefined(parsedDefaults, 'maxSteps', expectOptionalPositiveInteger(defaults?.maxSteps, `${path}.maxSteps`, issues));
  assignIfDefined(
    parsedDefaults,
    'toolTimeoutMs',
    expectOptionalPositiveInteger(defaults?.toolTimeoutMs, `${path}.toolTimeoutMs`, issues),
  );
  assignIfDefined(
    parsedDefaults,
    'modelTimeoutMs',
    expectOptionalPositiveInteger(defaults?.modelTimeoutMs, `${path}.modelTimeoutMs`, issues),
  );
  assignIfDefined(
    parsedDefaults,
    'maxRetriesPerStep',
    expectOptionalPositiveInteger(defaults?.maxRetriesPerStep, `${path}.maxRetriesPerStep`, issues),
  );
  assignIfDefined(
    parsedDefaults,
    'requireApprovalForWriteTools',
    expectOptionalBoolean(defaults?.requireApprovalForWriteTools, `${path}.requireApprovalForWriteTools`, issues),
  );
  assignIfDefined(parsedDefaults, 'autoApproveAll', expectOptionalBoolean(defaults?.autoApproveAll, `${path}.autoApproveAll`, issues));

  if (defaults?.capture !== undefined) {
    const capture = expectEnum(defaults.capture, CAPTURE_MODES, `${path}.capture`, issues);
    if (capture) {
      parsedDefaults.capture = capture;
    }
  }

  return Object.keys(parsedDefaults).length > 0 ? parsedDefaults : {};
}

function parseAgentRoutingConfig(value: unknown, path: string, issues: string[]): AgentRoutingConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  const routing = expectObject(value, path, issues);

  return {
    allowedChannels: expectOptionalStringArray(routing?.allowedChannels, `${path}.allowedChannels`, issues),
    allowedTenants: expectOptionalStringArray(routing?.allowedTenants, `${path}.allowedTenants`, issues),
    requiredRoles: expectOptionalStringArray(routing?.requiredRoles, `${path}.requiredRoles`, issues),
  };
}

function expectObject(value: unknown, path: string, issues: string[]): Record<string, unknown> | undefined {
  if (isRecord(value)) {
    return value;
  }

  issues.push(`${path} must be a JSON object.`);
  return undefined;
}

function expectArray(value: unknown, path: string, issues: string[]): unknown[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }

  issues.push(`${path} must be an array.`);
  return undefined;
}

function expectBoolean(value: unknown, path: string, issues: string[]): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }

  issues.push(`${path} must be a boolean.`);
  return undefined;
}

function expectOptionalBoolean(value: unknown, path: string, issues: string[]): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  return expectBoolean(value, path, issues);
}

function expectPositiveInteger(value: unknown, path: string, issues: string[]): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }

  issues.push(`${path} must be a positive integer.`);
  return undefined;
}

function expectOptionalPositiveInteger(value: unknown, path: string, issues: string[]): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  return expectPositiveInteger(value, path, issues);
}

function expectNonEmptyString(value: unknown, path: string, issues: string[]): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }

  issues.push(`${path} must be a non-empty string.`);
  return undefined;
}

function expectOptionalNonEmptyString(value: unknown, path: string, issues: string[]): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return expectNonEmptyString(value, path, issues);
}

function expectHttpPath(value: unknown, path: string, issues: string[]): string | undefined {
  const pathValue = expectNonEmptyString(value, path, issues);
  if (!pathValue) {
    return undefined;
  }

  if (!pathValue.startsWith('/')) {
    issues.push(`${path} must start with "/".`);
    return undefined;
  }

  return pathValue;
}

function expectOptionalHttpPath(value: unknown, path: string, issues: string[]): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return expectHttpPath(value, path, issues);
}

function expectStringArray(value: unknown, path: string, issues: string[]): string[] | undefined {
  const items = expectArray(value, path, issues);
  if (!items) {
    return undefined;
  }

  const values: string[] = [];
  for (const [index, item] of items.entries()) {
    const parsedItem = expectNonEmptyString(item, `${path}[${index}]`, issues);
    if (parsedItem) {
      values.push(parsedItem);
    }
  }

  return values;
}

function expectOptionalStringArray(value: unknown, path: string, issues: string[]): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  return expectStringArray(value, path, issues);
}

function expectEnum<TValue extends string>(
  value: unknown,
  allowedValues: readonly TValue[],
  path: string,
  issues: string[],
): TValue | undefined {
  if (typeof value === 'string' && allowedValues.includes(value as TValue)) {
    return value as TValue;
  }

  issues.push(`${path} must be one of: ${allowedValues.join(', ')}.`);
  return undefined;
}

function expectOptionalJsonObject(value: unknown, path: string, issues: string[]): JsonObject | undefined {
  if (value === undefined) {
    return undefined;
  }

  const jsonValue = toJsonValue(value, path, issues);
  if (jsonValue && typeof jsonValue === 'object' && !Array.isArray(jsonValue)) {
    return jsonValue as JsonObject;
  }

  issues.push(`${path} must be a JSON object.`);
  return undefined;
}

function toJsonValue(value: unknown, path: string, issues: string[]): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const [index, item] of value.entries()) {
      const jsonValue = toJsonValue(item, `${path}[${index}]`, issues);
      if (jsonValue !== undefined) {
        result.push(jsonValue);
      }
    }

    return result;
  }

  if (isRecord(value)) {
    const result: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      const jsonValue = toJsonValue(item, `${path}.${key}`, issues);
      if (jsonValue !== undefined) {
        result[key] = jsonValue;
      }
    }

    return result;
  }

  issues.push(`${path} must contain only JSON-serializable values.`);
  return undefined;
}

function assignIfDefined<TKey extends keyof AgentDefaults>(
  target: Partial<AgentDefaults>,
  key: TKey,
  value: AgentDefaults[TKey] | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
