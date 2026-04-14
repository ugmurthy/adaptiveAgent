import { join } from 'node:path';

import type { FastifyInstance, FastifyServerOptions } from 'fastify';

import {
  DEFAULT_AGENT_CONFIG_DIR,
  type AgentConfig,
  type GatewayConfig,
  loadAgentConfigs,
  loadGatewayConfig,
  type LoadedConfig,
} from './config.js';
import { AgentRegistry, createAgentRegistry, type AgentFactory } from './agent-registry.js';
import { createJwtAuthProvider } from './auth.js';
import { createAdaptiveAgentLogger, type AdaptiveAgentLogger } from './core.js';
import { createGatewayLogger, DEFAULT_GATEWAY_REQUEST_LOG_DIR } from './observability.js';
import { createGatewayServer } from './server.js';
import { createModuleRegistry, ModuleRegistry, type ResolvedGatewayModules } from './registries.js';
import { createSchedulerLoop, type SchedulerHandle, type SchedulerLoopOptions } from './scheduler.js';
import { createInMemoryGatewayStores, type GatewayStores } from './stores.js';

export interface BootstrapGatewayOptions {
  cwd?: string;
  gatewayConfigPath?: string;
  agentConfigDir?: string;
  logDir?: string;
  moduleRegistry?: ModuleRegistry;
  agentFactory?: AgentFactory;
  fastify?: FastifyServerOptions;
  stores?: GatewayStores;
  scheduler?: Pick<SchedulerLoopOptions, 'idFactory' | 'leaseOwner' | 'now' | 'onError' | 'pollIntervalMs'>;
}

export interface BootstrappedGateway {
  app: FastifyInstance;
  gatewayConfig: GatewayConfig;
  gatewayConfigPath: string;
  agentConfigs: Array<LoadedConfig<AgentConfig>>;
  agentRegistry: AgentRegistry;
  gatewayModules: ResolvedGatewayModules;
  stores: GatewayStores;
  scheduler?: SchedulerHandle;
}

export async function bootstrapGateway(options: BootstrapGatewayOptions = {}): Promise<BootstrappedGateway> {
  const loadedGatewayConfig = await loadGatewayConfig({
    cwd: options.cwd,
    configPath: options.gatewayConfigPath,
  });
  const loadedAgentConfigs = await loadAgentConfigs({
    cwd: options.cwd,
    dir: options.agentConfigDir ?? DEFAULT_AGENT_CONFIG_DIR,
  });
  const moduleRegistry = options.moduleRegistry ?? createModuleRegistry({
    authProviders: [createJwtAuthProvider()],
  });
  const gatewayModules = moduleRegistry.resolveGatewayModules(
    loadedGatewayConfig.config,
    `gateway config (${loadedGatewayConfig.path})`,
  );
  const agentRuntimeLogger = await createAgentRuntimeLogger(loadedGatewayConfig.config, options.logDir);
  const agentRegistry = createAgentRegistry({
    agents: loadedAgentConfigs,
    moduleRegistry,
    agentFactory: options.agentFactory,
    logger: agentRuntimeLogger,
  });
  const stores = options.stores ?? createInMemoryGatewayStores();
  const requestLogger = loadedGatewayConfig.config.server.requestLogging
    ? createGatewayLogger({
        destination: loadedGatewayConfig.config.server.requestLoggingDestination,
        logDir: options.logDir,
      })
    : undefined;

  validateRoutingReferences(loadedGatewayConfig.config, agentRegistry, loadedGatewayConfig.path);

  const app = await createGatewayServer(loadedGatewayConfig.config, {
    fastify: options.fastify,
    auth: gatewayModules.auth,
    hooks: gatewayModules.hooks,
    agentRegistry,
    stores,
    requestLogger,
  });
  let scheduler: SchedulerHandle | undefined;
  let startScheduler: (() => void) | undefined;

  if (loadedGatewayConfig.config.cron?.enabled) {
    startScheduler = () => {
      if (scheduler) {
        return;
      }

      scheduler = createSchedulerLoop({
        gatewayConfig: loadedGatewayConfig.config,
        agentRegistry,
        stores,
        logger: requestLogger,
        leaseDurationMs:
          loadedGatewayConfig.config.cron && loadedGatewayConfig.config.cron.schedulerLeaseMs > 0
            ? loadedGatewayConfig.config.cron.schedulerLeaseMs
            : undefined,
        leaseOwner: options.scheduler?.leaseOwner,
        now: options.scheduler?.now,
        idFactory: options.scheduler?.idFactory,
        onError: options.scheduler?.onError,
        pollIntervalMs: options.scheduler?.pollIntervalMs,
      });

      void scheduler.tick().catch(() => {
        // Startup should not fail just because an initial cron poll had a transient error.
      });
    };

    app.server.on('listening', startScheduler);
  }

  app.addHook('onClose', async () => {
    scheduler?.stop();
    scheduler = undefined;
    if (startScheduler) {
      app.server.off('listening', startScheduler);
    }
    agentRuntimeLogger?.flush?.();
    await requestLogger?.close();
  });

  return {
    app,
    gatewayConfig: loadedGatewayConfig.config,
    gatewayConfigPath: loadedGatewayConfig.path,
    agentConfigs: loadedAgentConfigs,
    agentRegistry,
    gatewayModules,
    stores,
    get scheduler() {
      return scheduler;
    },
  };
}

export async function startGateway(options: BootstrapGatewayOptions = {}): Promise<BootstrappedGateway> {
  const gateway = await bootstrapGateway(options);
  await gateway.app.listen({
    host: gateway.gatewayConfig.server.host,
    port: gateway.gatewayConfig.server.port,
  });

  return gateway;
}

async function createAgentRuntimeLogger(
  gatewayConfig: GatewayConfig,
  logDir?: string,
): Promise<AdaptiveAgentLogger | undefined> {
  const logging = gatewayConfig.agentRuntimeLogging;
  if (!logging?.enabled) {
    return undefined;
  }

  const destination = logging.destination ?? 'file';
  const filePath =
    destination === 'console'
      ? undefined
      : logging.filePath ?? join(logDir ?? DEFAULT_GATEWAY_REQUEST_LOG_DIR, 'agent-runtime.log');

  return createAdaptiveAgentLogger({
    name: 'adaptive-agent-gateway-runtime',
    level: logging.level ?? 'info',
    destination,
    filePath,
  });
}

function validateRoutingReferences(gatewayConfig: GatewayConfig, agentRegistry: AgentRegistry, gatewayConfigPath: string): void {
  if (gatewayConfig.defaultAgentId && !agentRegistry.has(gatewayConfig.defaultAgentId)) {
    throw new Error(
      `Gateway config ${gatewayConfigPath} references unknown defaultAgentId "${gatewayConfig.defaultAgentId}".`,
    );
  }

  for (const binding of gatewayConfig.bindings) {
    if (!agentRegistry.has(binding.agentId)) {
      throw new Error(
        `Gateway config ${gatewayConfigPath} references unknown binding agentId "${binding.agentId}".`,
      );
    }
  }
}
