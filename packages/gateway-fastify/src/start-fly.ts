#!/usr/bin/env bun

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { startGateway } from './bootstrap.js';

type ModelProvider = 'openrouter' | 'ollama' | 'mistral' | 'mesh';
type RequestLogging = boolean | 'debug' | 'info' | 'warn' | 'silent';

const MODEL_PROVIDERS = ['openrouter', 'ollama', 'mistral', 'mesh'] as const;
const REQUEST_LOGGING_LEVELS = ['debug', 'info', 'warn', 'silent'] as const;

async function main(): Promise<void> {
  const runtimeDir = resolve(readEnv('GATEWAY_RUNTIME_DIR') ?? join(process.cwd(), '.runtime', 'gateway'));
  const configDir = join(runtimeDir, 'config');
  const agentConfigDir = join(configDir, 'agents');
  const logDir = resolve(readEnv('GATEWAY_LOG_DIR') ?? join(runtimeDir, 'logs'));
  const workspaceRoot = resolve(readEnv('GATEWAY_WORKSPACE_ROOT') ?? join(runtimeDir, 'workspace'));
  const gatewayConfigPath = join(configDir, 'gateway.json');
  const defaultAgentConfigPath = join(agentConfigDir, 'default-agent.json');

  ensureRequiredEnv('DATABASE_URL');
  await mkdir(agentConfigDir, { recursive: true });
  await mkdir(logDir, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  await writeJsonFile(gatewayConfigPath, createGatewayConfig());
  await writeJsonFile(defaultAgentConfigPath, createDefaultAgentConfig(workspaceRoot));

  const gateway = await startGateway({
    gatewayConfigPath,
    agentConfigDir,
    logDir,
    onShutdownProgress: (message) => console.log(message),
  });

  console.log('AdaptiveAgent gateway is running on Fly-compatible config.');
  console.log(`- Health: ${formatHttpUrl(gateway.gatewayConfig.server)}`);
  console.log(`- WebSocket path: ${gateway.gatewayConfig.server.websocketPath}`);
  console.log(`- Runtime dir: ${runtimeDir}`);
  console.log(`- Stores: postgres (${readEnv('DATABASE_URL') ? 'DATABASE_URL set' : 'DATABASE_URL missing'})`);
  console.log(`- Model: ${readEnv('GATEWAY_MODEL_PROVIDER') ?? 'mesh'}/${readEnv('GATEWAY_MODEL') ?? defaultModelName(readModelProvider())}`);

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal: NodeJS.Signals): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      console.log(`Received ${signal}, shutting down gateway...`);
      try {
        await gateway.app.close();
        process.exitCode = signal === 'SIGINT' ? 130 : 0;
      } catch (error) {
        process.exitCode = 1;
        console.error('Gateway shutdown failed.', error instanceof Error ? error.message : String(error));
      }
    })();

    return shutdownPromise;
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

function createGatewayConfig(): Record<string, unknown> {
  return {
    server: {
      host: readEnv('HOST') ?? '0.0.0.0',
      port: readPositiveInteger('PORT', 8080),
      websocketPath: readEnv('GATEWAY_WEBSOCKET_PATH') ?? '/ws',
      healthPath: readEnv('GATEWAY_HEALTH_PATH') ?? '/health',
      requestLogger: readBoolean('GATEWAY_REQUEST_LOGGER', true),
      requestLogging: readRequestLogging(),
      requestLoggingDestination: 'console',
    },
    stores: {
      kind: 'postgres',
      urlEnv: 'DATABASE_URL',
      ssl: readBoolean('GATEWAY_POSTGRES_SSL', true),
      autoMigrate: true,
    },
    agentRuntimeLogging: {
      enabled: readBoolean('GATEWAY_RUNTIME_LOGGING', false),
      level: readEnv('GATEWAY_RUNTIME_LOG_LEVEL') ?? 'info',
      destination: 'console',
    },
    auth: createAuthConfig(),
    bindings: [],
    defaultAgentId: 'default-agent',
    hooks: {
      failurePolicy: 'warn',
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
    },
  };
}

function createAuthConfig(): Record<string, unknown> {
  const auth: Record<string, unknown> = {
    provider: 'jwt',
    secret: readRequiredEnv('GATEWAY_JWT_SECRET'),
  };
  const issuer = readEnv('GATEWAY_JWT_ISSUER');
  const audience = readCsvEnv('GATEWAY_JWT_AUDIENCE');
  const tenantIdClaim = readEnv('GATEWAY_JWT_TENANT_ID_CLAIM');
  const rolesClaim = readEnv('GATEWAY_JWT_ROLES_CLAIM');

  if (issuer) {
    auth.issuer = issuer;
  }
  if (audience.length === 1) {
    auth.audience = audience[0];
  } else if (audience.length > 1) {
    auth.audience = audience;
  }
  if (tenantIdClaim) {
    auth.tenantIdClaim = tenantIdClaim;
  }
  if (rolesClaim) {
    auth.rolesClaim = rolesClaim;
  }

  return auth;
}

function createDefaultAgentConfig(workspaceRoot: string): Record<string, unknown> {
  const provider = readModelProvider();
  const modelApiKey = readModelApiKey(provider);
  const model: Record<string, unknown> = {
    provider,
    model: readEnv('GATEWAY_MODEL') ?? defaultModelName(provider),
  };
  const baseUrl = readEnv('GATEWAY_MODEL_BASE_URL');
  const siteUrl = readEnv('GATEWAY_MODEL_SITE_URL');
  const siteName = readEnv('GATEWAY_MODEL_SITE_NAME');

  if (modelApiKey) {
    model.apiKey = modelApiKey;
  }
  if (baseUrl) {
    model.baseUrl = baseUrl;
  }
  if (siteUrl) {
    model.siteUrl = siteUrl;
  }
  if (siteName) {
    model.siteName = siteName;
  }

  return {
    id: 'default-agent',
    name: readEnv('GATEWAY_AGENT_NAME') ?? 'Hosted Gateway Agent',
    invocationModes: ['chat', 'run'],
    defaultInvocationMode: readEnv('GATEWAY_DEFAULT_INVOCATION_MODE') ?? 'chat',
    model,
    workspaceRoot,
    systemInstructions:
      readEnv('GATEWAY_SYSTEM_INSTRUCTIONS') ?? 'You are a helpful assistant running behind the hosted AdaptiveAgent gateway.',
    tools: readCsvEnv('GATEWAY_TOOLS'),
    delegates: [],
  };
}

function readModelProvider(): ModelProvider {
  const provider = readEnv('GATEWAY_MODEL_PROVIDER') ?? 'mesh';
  if (isModelProvider(provider)) {
    return provider;
  }

  throw new Error(`GATEWAY_MODEL_PROVIDER must be one of: ${MODEL_PROVIDERS.join(', ')}.`);
}

function readModelApiKey(provider: ModelProvider): string | undefined {
  const key = readEnv('GATEWAY_MODEL_API_KEY') ?? readEnv(providerApiKeyEnv(provider));
  if (!key && provider !== 'ollama') {
    throw new Error(`Set GATEWAY_MODEL_API_KEY or ${providerApiKeyEnv(provider)} for provider "${provider}".`);
  }

  return key;
}

function providerApiKeyEnv(provider: ModelProvider): string {
  switch (provider) {
    case 'mesh':
      return 'MESH_API_KEY';
    case 'openrouter':
      return 'OPENROUTER_API_KEY';
    case 'mistral':
      return 'MISTRAL_API_KEY';
    case 'ollama':
      return 'OLLAMA_API_KEY';
  }
}

function defaultModelName(provider: ModelProvider): string {
  switch (provider) {
    case 'mesh':
      return 'qwen/qwen3.5-27b';
    case 'openrouter':
      return 'openai/gpt-4o-mini';
    case 'mistral':
      return 'mistral-small-latest';
    case 'ollama':
      return 'llama3.2';
  }
}

function readRequestLogging(): RequestLogging {
  const value = readEnv('GATEWAY_REQUEST_LOGGING');
  if (!value) {
    return 'info';
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  if (REQUEST_LOGGING_LEVELS.includes(value as (typeof REQUEST_LOGGING_LEVELS)[number])) {
    return value as RequestLogging;
  }

  throw new Error(`GATEWAY_REQUEST_LOGGING must be true, false, or one of: ${REQUEST_LOGGING_LEVELS.join(', ')}.`);
}

async function writeJsonFile(path: string, contents: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(contents, null, 2)}\n`, 'utf-8');
}

function readPositiveInteger(name: string, fallback: number): number {
  const rawValue = readEnv(name);
  if (!rawValue) {
    return fallback;
  }

  const value = Number.parseInt(rawValue, 10);
  if (Number.isInteger(value) && value > 0) {
    return value;
  }

  throw new Error(`${name} must be a positive integer.`);
}

function readBoolean(name: string, fallback: boolean): boolean {
  const value = readEnv(name);
  if (!value) {
    return fallback;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }

  throw new Error(`${name} must be "true" or "false".`);
}

function readCsvEnv(name: string): string[] {
  const value = readEnv(name);
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function ensureRequiredEnv(name: string): void {
  readRequiredEnv(name);
}

function readRequiredEnv(name: string): string {
  const value = readEnv(name);
  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function isModelProvider(value: string): value is ModelProvider {
  return MODEL_PROVIDERS.includes(value as ModelProvider);
}

function formatHttpUrl(server: { host: string; port: number; healthPath?: string }): string {
  return `http://${server.host}:${server.port}${server.healthPath ?? '/health'}`;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
