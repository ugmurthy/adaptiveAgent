import type { JsonObject } from '../core.js';

import { ConfigValidationError } from '../errors.js';
import {
  GATEWAY_HOOK_SLOTS,
  GATEWAY_STORE_KINDS,
  REQUEST_LOG_DESTINATIONS,
  type GatewayAuthConfig,
  type GatewayBinding,
  type GatewayBindingMatch,
  type GatewayChannelConfig,
  type GatewayConfig,
  type GatewayCronConfig,
  type GatewayCronFileSyncConfig,
  type GatewayHooksConfig,
  type GatewayRequestLogLevel,
  type GatewayServerConfig,
  type GatewayStoreConfig,
  type GatewayTranscriptConfig,
} from './types.js';
import {
  createDefaultHooksConfig,
  expectArray,
  expectBoolean,
  expectEnum,
  expectHttpPath,
  expectNonEmptyString,
  expectObject,
  expectOptionalBoolean,
  expectOptionalHttpPath,
  expectOptionalJsonObject,
  expectOptionalNonEmptyString,
  expectOptionalPositiveInteger,
  expectOptionalStringArray,
  expectPositiveInteger,
  parseGatewayAgentRuntimeLoggingConfig,
  parseGatewayRequestLoggingValue,
  parseHookFailurePolicy,
  parseOptionalInvocationModes,
  toJsonValue,
} from './parse-shared.js';

export function validateGatewayConfig(value: unknown, sourcePath: string): GatewayConfig {
  const issues: string[] = [];
  const root = expectObject(value, 'gateway', issues);

  const server = parseGatewayServerConfig(root?.server, 'server', issues);
  const stores = parseGatewayStoreConfig(root?.stores, 'stores', issues);
  const agentRuntimeLogging = parseGatewayAgentRuntimeLoggingConfig(
    root?.agentRuntimeLogging,
    'agentRuntimeLogging',
    issues,
  );
  const auth = parseGatewayAuthConfig(root?.auth, 'auth', issues);
  const cron = parseGatewayCronConfig(root?.cron, 'cron', issues);
  const transcript = parseGatewayTranscriptConfig(root?.transcript, 'transcript', issues);
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
    stores,
    agentRuntimeLogging,
    auth,
    cron,
    transcript,
    channels,
    bindings,
    defaultAgentId,
    hooks,
  };
}

export function resolveGatewayRequestLogLevel(
  requestLogging: boolean | GatewayRequestLogLevel | undefined,
): GatewayRequestLogLevel | undefined {
  if (requestLogging === undefined || requestLogging === false || requestLogging === 'silent') {
    return undefined;
  }

  if (requestLogging === true) {
    return 'info';
  }

  return requestLogging;
}

function parseGatewayStoreConfig(value: unknown, path: string, issues: string[]): GatewayStoreConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  const stores = expectObject(value, path, issues);
  const kind = expectEnum(stores?.kind, GATEWAY_STORE_KINDS, `${path}.kind`, issues);
  if (!kind) {
    return undefined;
  }

  if (kind === 'memory') {
    return { kind };
  }

  if (kind === 'file') {
    return {
      kind,
      baseDir: expectNonEmptyString(stores?.baseDir, `${path}.baseDir`, issues) ?? 'invalid-store-base-dir',
    };
  }

  return {
    kind,
    urlEnv: expectOptionalNonEmptyString(stores?.urlEnv, `${path}.urlEnv`, issues),
    connectionString: expectOptionalNonEmptyString(stores?.connectionString, `${path}.connectionString`, issues),
    ssl: expectOptionalBoolean(stores?.ssl, `${path}.ssl`, issues),
    autoMigrate: expectOptionalBoolean(stores?.autoMigrate, `${path}.autoMigrate`, issues),
  };
}

function parseGatewayServerConfig(value: unknown, path: string, issues: string[]): GatewayServerConfig {
  const server = expectObject(value, path, issues);

  return {
    host: expectNonEmptyString(server?.host, `${path}.host`, issues) ?? '0.0.0.0',
    port: expectPositiveInteger(server?.port, `${path}.port`, issues) ?? 0,
    websocketPath: expectHttpPath(server?.websocketPath, `${path}.websocketPath`, issues) ?? '/ws',
    healthPath: expectOptionalHttpPath(server?.healthPath, `${path}.healthPath`, issues),
    requestLogging: parseGatewayRequestLoggingValue(server?.requestLogging, `${path}.requestLogging`, issues),
    requestLoggingDestination:
      server?.requestLoggingDestination === undefined
        ? undefined
        : expectEnum(server.requestLoggingDestination, REQUEST_LOG_DESTINATIONS, `${path}.requestLoggingDestination`, issues),
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

function parseGatewayTranscriptConfig(value: unknown, path: string, issues: string[]): GatewayTranscriptConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  const transcript = expectObject(value, path, issues);

  return {
    recentMessageWindow:
      expectPositiveInteger(transcript?.recentMessageWindow, `${path}.recentMessageWindow`, issues) ?? 0,
    summaryTriggerWindow:
      expectPositiveInteger(transcript?.summaryTriggerWindow, `${path}.summaryTriggerWindow`, issues) ?? 0,
    summaryMaxMessages: expectPositiveInteger(transcript?.summaryMaxMessages, `${path}.summaryMaxMessages`, issues) ?? 0,
    summaryLineMaxLength:
      expectPositiveInteger(transcript?.summaryLineMaxLength, `${path}.summaryLineMaxLength`, issues) ?? 0,
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
    fileSync: parseGatewayCronFileSyncConfig(cron?.fileSync, `${path}.fileSync`, issues),
  };
}

function parseGatewayCronFileSyncConfig(
  value: unknown,
  path: string,
  issues: string[],
): GatewayCronFileSyncConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  const fileSync = expectObject(value, path, issues);

  return {
    enabled: expectOptionalBoolean(fileSync?.enabled, `${path}.enabled`, issues) ?? true,
    dir: expectOptionalNonEmptyString(fileSync?.dir, `${path}.dir`, issues),
    intervalMs: expectOptionalPositiveInteger(fileSync?.intervalMs, `${path}.intervalMs`, issues) ?? 60_000,
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
