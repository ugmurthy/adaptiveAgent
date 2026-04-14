#!/usr/bin/env bun

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { AgentConfig, GatewayConfig, LoadedConfig } from './config.js';
import { startGateway } from './bootstrap.js';
import { loadAgentConfigs } from './config.js';
import {
  AGENT_CONFIG_DIR,
  DEFAULT_AGENT_CONFIG_PATH,
  DEFAULT_GATEWAY_JWT_SECRET,
  GATEWAY_CONFIG_PATH,
  GATEWAY_STORE_BASE_DIR,
} from './local-dev.js';
import { createLocalModuleRegistry } from './local-modules.js';
import { createFileGatewayStores } from './stores-file.js';

async function main(): Promise<void> {
  await mkdir(GATEWAY_STORE_BASE_DIR, { recursive: true });
  await mkdir(AGENT_CONFIG_DIR, { recursive: true });
  const logDir = join(GATEWAY_STORE_BASE_DIR, 'logs');

  const gatewayJwtSecret = process.env.GATEWAY_JWT_SECRET ?? DEFAULT_GATEWAY_JWT_SECRET;
  const gatewayConfigStatus = await ensureGatewayConfig(GATEWAY_CONFIG_PATH, gatewayJwtSecret);
  const defaultAgentStatus = await ensureDefaultAgentConfig(DEFAULT_AGENT_CONFIG_PATH);
  const loadedAgentConfigs = await loadAgentConfigs({ dir: AGENT_CONFIG_DIR });
  const moduleRegistry = await createLocalModuleRegistry({
    workspaceRoot: process.cwd(),
    requiredDelegateNames: collectDelegateNames(loadedAgentConfigs),
  });

  const gateway = await startGateway({
    gatewayConfigPath: GATEWAY_CONFIG_PATH,
    agentConfigDir: AGENT_CONFIG_DIR,
    logDir,
    moduleRegistry,
    stores: createFileGatewayStores({ baseDir: GATEWAY_STORE_BASE_DIR }),
  });

  console.log('AdaptiveAgent gateway is running.');
  console.log(`- URL: ws://${gateway.gatewayConfig.server.host}:${gateway.gatewayConfig.server.port}${gateway.gatewayConfig.server.websocketPath}`);
  if (gateway.gatewayConfig.server.healthPath) {
    console.log(`- Health: http://${gateway.gatewayConfig.server.host}:${gateway.gatewayConfig.server.port}${gateway.gatewayConfig.server.healthPath}`);
  }
  console.log(`- Gateway config: ${GATEWAY_CONFIG_PATH} (${gatewayConfigStatus})`);
  console.log(`- Agent config dir: ${AGENT_CONFIG_DIR}`);
  console.log(`- Default agent config: ${DEFAULT_AGENT_CONFIG_PATH} (${defaultAgentStatus})`);
  console.log(`- File-backed gateway stores: ${GATEWAY_STORE_BASE_DIR}`);
  console.log(`- Logs: ${logDir}`);
  console.log(`- Request logs: ${formatRequestLogDestination(gateway.gatewayConfig, logDir)}`);
  console.log(`- Runtime logs: ${formatRuntimeLogDestination(gateway.gatewayConfig, logDir)}`);
  console.log(`- Agents detected: ${gateway.agentConfigs.length}`);
  for (const agentLine of formatDetectedAgents(gateway.agentConfigs)) {
    console.log(`  - ${agentLine}`);
  }
  console.log(`- Cron: ${gateway.gatewayConfig.cron?.enabled ? 'enabled' : 'disabled'}`);
  console.log(
    `- Auth: jwt (${process.env.GATEWAY_JWT_SECRET ? 'secret from GATEWAY_JWT_SECRET' : 'using local dev default; set GATEWAY_JWT_SECRET to override'})`,
  );

  const shutdown = async (signal: NodeJS.Signals) => {
    console.log(`\nReceived ${signal}, shutting down gateway...`);
    await gateway.app.close();
    process.exit(0);
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

  const meshApiKey = process.env.MESH_API_KEY;
  if (!meshApiKey) {
    throw new Error(`MESH_API_KEY is required to create ${path}.`);
  }

  const defaultAgentConfig: AgentConfig = {
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

  await writeJsonFile(path, defaultAgentConfig);
  return 'created';
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
      requestLogging: true,
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

function collectDelegateNames(loadedAgentConfigs: Array<LoadedConfig<AgentConfig>>): string[] {
  return [...new Set(loadedAgentConfigs.flatMap((loadedAgentConfig) => loadedAgentConfig.config.delegates))].sort();
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

function formatRequestLogDestination(gatewayConfig: GatewayConfig, logDir: string): string {
  if (!gatewayConfig.server.requestLogging) {
    return 'disabled';
  }

  return formatLogDestination(gatewayConfig.server.requestLoggingDestination ?? 'console', logDir);
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

function formatLogDestination(destination: 'console' | 'file' | 'both', destinationPath: string): string {
  if (destination === 'console') {
    return 'console';
  }

  return `${destination} -> ${destinationPath}`;
}

await main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to start AdaptiveAgent gateway: ${message}`);
  process.exit(1);
});
