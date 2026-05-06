#!/usr/bin/env bun

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { AgentConfig, GatewayConfig, LoadedConfig } from './config.js';
import { startGateway } from './bootstrap.js';
import { loadAgentConfigs, resolveGatewayRequestLogLevel } from './config.js';
import { BUILTIN_LOCAL_TOOL_NAMES } from './core.js';
import {
  AGENT_CONFIG_DIR,
  DEFAULT_AGENT_CONFIG_PATH,
  ADAPTIVE_AGENT_ARTIFACTS_DIR,
  DEFAULT_GATEWAY_JWT_SECRET,
  GATEWAY_CONFIG_PATH,
  GATEWAY_STORE_BASE_DIR,
  LOG_AGENT_CONFIG_PATH,
} from './local-dev.js';
import { createLocalModuleRegistry } from './local-modules.js';

async function main(): Promise<void> {
  await mkdir(GATEWAY_STORE_BASE_DIR, { recursive: true });
  await mkdir(ADAPTIVE_AGENT_ARTIFACTS_DIR, { recursive: true });
  await mkdir(AGENT_CONFIG_DIR, { recursive: true });
  const logDir = join(GATEWAY_STORE_BASE_DIR, 'logs');

  const gatewayJwtSecret = process.env.GATEWAY_JWT_SECRET ?? DEFAULT_GATEWAY_JWT_SECRET;
  const gatewayConfigStatus = await ensureGatewayConfig(GATEWAY_CONFIG_PATH, gatewayJwtSecret);
  const defaultAgentStatus = await ensureDefaultAgentConfig(DEFAULT_AGENT_CONFIG_PATH);
  const logAgentStatus = await ensureLogAgentConfig(LOG_AGENT_CONFIG_PATH, DEFAULT_AGENT_CONFIG_PATH);
  const loadedAgentConfigs = await loadAgentConfigs({ dir: AGENT_CONFIG_DIR });
  const moduleRegistry = await createLocalModuleRegistry({
    workspaceRoot: ADAPTIVE_AGENT_ARTIFACTS_DIR,
  });

  const gateway = await startGateway({
    gatewayConfigPath: GATEWAY_CONFIG_PATH,
    agentConfigDir: AGENT_CONFIG_DIR,
    logDir,
    moduleRegistry,
    onShutdownProgress: (message) => writeConsoleLine(message),
  });

  console.log('AdaptiveAgent gateway is running.');
  console.log(`- URL: ws://${gateway.gatewayConfig.server.host}:${gateway.gatewayConfig.server.port}${gateway.gatewayConfig.server.websocketPath}`);
  if (gateway.gatewayConfig.server.healthPath) {
    console.log(`- Health: http://${gateway.gatewayConfig.server.host}:${gateway.gatewayConfig.server.port}${gateway.gatewayConfig.server.healthPath}`);
  }
  console.log(`- Gateway config: ${GATEWAY_CONFIG_PATH} (${gatewayConfigStatus})`);
  console.log(`- Agent config dir: ${AGENT_CONFIG_DIR}`);
  console.log(`- Configured default agent: ${formatConfiguredDefaultAgent(gateway.gatewayConfig, gateway.agentConfigs)}`);
  console.log(`- Conventional default-agent config: ${DEFAULT_AGENT_CONFIG_PATH} (${defaultAgentStatus})`);
  console.log(`- Conventional log-agent config: ${LOG_AGENT_CONFIG_PATH} (${logAgentStatus})`);
  console.log(`- Gateway stores: ${formatStoreMode(gateway.gatewayConfig)}`);
  console.log(`- File tool root: ${ADAPTIVE_AGENT_ARTIFACTS_DIR}`);
  console.log(`- Logs: ${logDir}`);
  console.log(`- Request logs: ${formatRequestLogDestination(gateway.gatewayConfig, logDir)}`);
  console.log(`- Runtime logs: ${formatRuntimeLogDestination(gateway.gatewayConfig, logDir)}`);
  console.log(`- Available tools: ${formatNameList(moduleRegistry.listToolNames())}`);
  console.log(`- Available delegates: ${formatNameList(moduleRegistry.listDelegateNames())}`);
  console.log(`- Agents detected: ${gateway.agentConfigs.length}`);
  for (const agentLine of formatDetectedAgents(gateway.agentConfigs)) {
    console.log(`  - ${agentLine}`);
  }
  console.log(`- Cron: ${gateway.gatewayConfig.cron?.enabled ? 'enabled' : 'disabled'}`);
  console.log(
    `- Auth: jwt (${process.env.GATEWAY_JWT_SECRET ? 'secret from GATEWAY_JWT_SECRET' : 'using local dev default; set GATEWAY_JWT_SECRET to override'})`,
  );

  let shutdownPromise: Promise<void> | undefined;

  const shutdown = (signal: NodeJS.Signals): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      await writeConsoleLine(`\nReceived ${signal}, shutting down gateway...`);

      try {
        await gateway.app.close();
        process.exitCode = signal === 'SIGINT' ? 130 : 0;
      } catch (error) {
        process.exitCode = 1;
        await writeErrorLine(
          'Gateway shutdown failed.',
          error instanceof Error ? error.message : 'Unknown shutdown error.',
        );
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

async function ensureDefaultAgentConfig(path: string): Promise<'created' | 'existing'> {
  if (existsSync(path)) {
    return 'existing';
  }

  await writeJsonFile(path, createDefaultAgentConfig());
  return 'created';
}

async function ensureLogAgentConfig(path: string, defaultAgentPath: string): Promise<'created' | 'existing'> {
  if (existsSync(path)) {
    return 'existing';
  }

  const defaultAgentConfig = validateLocalAgentTemplate(await readJsonFile(defaultAgentPath), defaultAgentPath);
  const logAgentConfig: AgentConfig = {
    ...defaultAgentConfig,
    id: 'log-agent',
    name: 'Log Agent',
    workspaceRoot: '$HOME/.adaptiveAgent',
    tools: [...BUILTIN_LOCAL_TOOL_NAMES],
  };

  await writeJsonFile(path, logAgentConfig);
  return 'created';
}

function validateLocalAgentTemplate(value: unknown, path: string): AgentConfig {
  if (!isRecord(value)) {
    throw new Error(`Expected ${path} to contain an agent config object.`);
  }

  return value as unknown as AgentConfig;
}

function createDefaultAgentConfig(): AgentConfig {
  const meshApiKey = process.env.MESH_API_KEY;
  if (!meshApiKey) {
    throw new Error('MESH_API_KEY is required to create local agent configs.');
  }

  return {
    id: 'default-agent',
    name: 'Default Agent',
    invocationModes: ['chat', 'run'],
    defaultInvocationMode: 'chat',
    model: {
      provider: 'mesh',
      model: 'qwen/qwen3.5-27b',
      apiKey: meshApiKey,
    },
    systemInstructions: 'You are a helpful assistant and you names is adaptiveAgent ',
    tools: [],
    delegates: [],
  };
}

async function ensureGatewayConfig(path: string, gatewayJwtSecret: string): Promise<'created' | 'existing' | 'updated'> {
  const generatedGatewayConfig = createGatewayConfig(gatewayJwtSecret);

  if (existsSync(path)) {
    const rawConfig = await readJsonFile(path);
    if (!isRecord(rawConfig)) {
      return 'existing';
    }

    const nextConfig = structuredClone(rawConfig);
    let changed = false;

    if (!isRecord(nextConfig.auth)) {
      nextConfig.auth = generatedGatewayConfig.auth;
      changed = true;
    } else {
      const authConfig = nextConfig.auth;
      const nestedSettings = isRecord(authConfig.settings) ? authConfig.settings : undefined;

      if (typeof authConfig.provider !== 'string' || authConfig.provider.trim().length === 0) {
        authConfig.provider = 'jwt';
        changed = true;
      }

      if (authConfig.provider === 'jwt') {
        if (nestedSettings) {
          for (const [key, value] of Object.entries(nestedSettings)) {
            if (!(key in authConfig)) {
              authConfig[key] = value;
              changed = true;
            }
          }

          delete authConfig.settings;
          changed = true;
        }

        if (typeof authConfig.secret !== 'string' || authConfig.secret.trim().length === 0) {
          authConfig.secret = gatewayJwtSecret;
          changed = true;
        }
      }
    }

    if (changed) {
      await writeJsonFile(path, nextConfig);
      return 'updated';
    }

    return 'existing';
  }

  await writeJsonFile(path, generatedGatewayConfig);
  return 'created';
}

function createGatewayConfig(gatewayJwtSecret: string): Record<string, unknown> {
  return {
    server: {
      host: '0.0.0.0',
      port: 8959,
      websocketPath: '/ws',
      healthPath: '/health',
      requestLogging: 'info',
    },
    agentRuntimeLogging: {
      enabled: false,
      level: 'info',
      destination: 'file',
    },
    auth: {
      provider: 'jwt',
      secret: gatewayJwtSecret,
    },
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

async function writeJsonFile(path: string, contents: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(contents, null, 2)}\n`, 'utf-8');
}

async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf-8')) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatNameList(names: string[]): string {
  return names.length > 0 ? names.join(', ') : '(none)';
}

function formatDetectedAgents(loadedAgentConfigs: Array<LoadedConfig<AgentConfig>>): string[] {
  if (loadedAgentConfigs.length === 0) {
    return ['(none)'];
  }

  return loadedAgentConfigs
    .map((loadedAgentConfig) => {
      const agent = loadedAgentConfig.config;
      return `${agent.id} (${agent.name}) - ${loadedAgentConfig.path}`;
    })
    .sort();
}

function formatConfiguredDefaultAgent(
  gatewayConfig: GatewayConfig,
  loadedAgentConfigs: Array<LoadedConfig<AgentConfig>>,
): string {
  if (!gatewayConfig.defaultAgentId) {
    return '(none)';
  }

  const matchedAgent = loadedAgentConfigs.find((loadedAgentConfig) => loadedAgentConfig.config.id === gatewayConfig.defaultAgentId);
  if (!matchedAgent) {
    return `${gatewayConfig.defaultAgentId} (configured, but no matching agent config loaded)`;
  }

  return `${matchedAgent.config.id} (${matchedAgent.config.name}) - ${matchedAgent.path}`;
}

function formatRequestLogDestination(gatewayConfig: GatewayConfig, logDir: string): string {
  const requestLogLevel = resolveGatewayRequestLogLevel(gatewayConfig.server.requestLogging);
  if (!requestLogLevel) {
    return 'disabled';
  }

  const destination = formatLogDestination(gatewayConfig.server.requestLoggingDestination ?? 'console', logDir);
  return `${requestLogLevel} (${destination})`;
}

function formatRuntimeLogDestination(gatewayConfig: GatewayConfig, logDir: string): string {
  const runtimeLogging = gatewayConfig.agentRuntimeLogging;
  if (!runtimeLogging?.enabled) {
    return 'disabled';
  }

  return formatLogDestination(
    runtimeLogging.destination ?? 'file',
    runtimeLogging.filePath ?? join(logDir, 'agent-runtime.log'),
  );
}

function formatStoreMode(gatewayConfig: GatewayConfig): string {
  const stores = gatewayConfig.stores;
  if (stores?.kind === 'postgres') {
    const source = stores.connectionString ? 'stores.connectionString' : stores.urlEnv ?? 'DATABASE_URL';
    return `postgres (${source})`;
  }

  if (stores?.kind === 'file') {
    return `file (${stores.baseDir})`;
  }

  return 'memory';
}

function formatLogDestination(destination: 'console' | 'file' | 'both', destinationPath: string): string {
  if (destination === 'console') {
    return 'console';
  }

  return `${destination} -> ${destinationPath}`;
}

async function writeConsoleLine(message: string): Promise<void> {
  await writeLine(process.stdout, message);
}

async function writeErrorLine(...parts: string[]): Promise<void> {
  await writeLine(process.stderr, parts.join(' '));
}

async function writeLine(
  stream: NodeJS.WriteStream,
  message: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(`${message}\n`, (error?: Error | null) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

await main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to start AdaptiveAgent gateway: ${message}`);
  process.exit(1);
});
