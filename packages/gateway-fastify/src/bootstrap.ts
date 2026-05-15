import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import type { FastifyInstance, FastifyServerOptions } from 'fastify';

import {
  DEFAULT_AGENT_CONFIG_DIR,
  type AgentConfig,
  type GatewayConfig,
  loadAgentConfigs,
  loadGatewayConfig,
  type LoadedConfig,
  resolveGatewayRequestLogLevel,
} from './config.js';
import { AgentRegistry, createAgentRegistry, type AgentFactory } from './agent-registry.js';
import { createJwtAuthProvider } from './auth.js';
import { createAdaptiveAgentLogger, type AdaptiveAgentLogger } from './core.js';
import { createGatewayLogger, DEFAULT_GATEWAY_REQUEST_LOG_DIR, GATEWAY_LOG_EVENTS, type GatewayLogger } from './observability.js';
import { createGatewayServer } from './server.js';
import { createModuleRegistry, ModuleRegistry, type ResolvedGatewayModules } from './registries.js';
import { createCronFileSyncLoop, type CronFileSyncHandle } from './cron-file-sync.js';
import { createSchedulerLoop, type SchedulerHandle, type SchedulerLoopOptions } from './scheduler.js';
import type { PostgresPoolClient, PostgresRuntimeStoreBundle } from '@adaptive-agent/core';
import { resolveGatewayStoreBundle, type ResolvedStoreBundle } from './store-factory.js';
import type { PostgresClient } from './stores-postgres.js';
import type { GatewayStores } from './stores.js';

export interface BootstrapGatewayOptions {
  cwd?: string;
  gatewayConfigPath?: string;
  agentConfigDir?: string;
  logDir?: string;
  moduleRegistry?: ModuleRegistry;
  agentFactory?: AgentFactory;
  fastify?: FastifyServerOptions;
  stores?: GatewayStores;
  postgresClient?: PostgresClient | PostgresPoolClient;
  scheduler?: Pick<SchedulerLoopOptions, 'idFactory' | 'leaseOwner' | 'now' | 'onError' | 'pollIntervalMs'>;
  onShutdownProgress?: (message: string) => void | Promise<void>;
}

export interface BootstrappedGateway {
  app: FastifyInstance;
  gatewayConfig: GatewayConfig;
  gatewayConfigPath: string;
  agentConfigs: Array<LoadedConfig<AgentConfig>>;
  agentRegistry: AgentRegistry;
  gatewayModules: ResolvedGatewayModules;
  stores: GatewayStores;
  runtimeStores?: PostgresRuntimeStoreBundle;
  scheduler?: SchedulerHandle;
  bootId: string;
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
  let requestLogger: GatewayLogger | undefined;
  let agentRuntimeLogger: AdaptiveAgentLogger | undefined;
  let storeBundle: ResolvedStoreBundle | undefined;
  const bootId = randomUUID();
  const bootStartedAtMs = Date.now();

  try {
    storeBundle = await resolveGatewayStoreBundle({
      storesConfig: loadedGatewayConfig.config.stores,
      gatewayStoresOverride: options.stores,
      postgresClient: options.postgresClient,
    });
    agentRuntimeLogger = await createAgentRuntimeLogger(loadedGatewayConfig.config, options.logDir);
    const agentRegistry = createAgentRegistry({
      agents: loadedAgentConfigs,
      moduleRegistry,
      agentFactory: options.agentFactory,
      logger: agentRuntimeLogger,
      runtime: storeBundle.runtimeStores,
    });
    const stores = storeBundle.gatewayStores;
    const requestLogLevel = resolveGatewayRequestLogLevel(loadedGatewayConfig.config.server.requestLogging);
    requestLogger = requestLogLevel
      ? createGatewayLogger({
          destination: loadedGatewayConfig.config.server.requestLoggingDestination,
          level: requestLogLevel,
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
      traceClient: storeBundle.postgresClient,
      requestLogger,
      imageUploadDir: resolve(options.logDir ?? DEFAULT_GATEWAY_REQUEST_LOG_DIR, '..', 'uploads', 'images'),
      staleLeaseHeartbeatBefore: new Date(bootStartedAtMs),
    });
    let scheduler: SchedulerHandle | undefined;
    let cronFileSync: CronFileSyncHandle | undefined;
    let startScheduler: (() => void) | undefined;
    let cronServicesStarting = false;
    let loggedStarted = false;

    const logGatewayStarted = () => {
      if (loggedStarted) {
        return;
      }

      loggedStarted = true;
      const address = app.server.address();
      const listenAddress = formatListenAddress(address);
      requestLogger?.info(GATEWAY_LOG_EVENTS.gateway_started, 'Gateway server started', {
        bootId,
        pid: process.pid,
        host: listenAddress.host ?? loadedGatewayConfig.config.server.host,
        port: listenAddress.port ?? loadedGatewayConfig.config.server.port,
        websocketPath: loadedGatewayConfig.config.server.websocketPath,
        ...(loadedGatewayConfig.config.server.healthPath ? { healthPath: loadedGatewayConfig.config.server.healthPath } : {}),
        storesKind: loadedGatewayConfig.config.stores?.kind ?? 'memory',
        agentCount: loadedAgentConfigs.length,
        availableTools: moduleRegistry.listToolNames(),
        availableDelegates: moduleRegistry.listDelegateNames(),
        cronEnabled: loadedGatewayConfig.config.cron?.enabled ?? false,
        ...(options.logDir ? { logDir: options.logDir } : {}),
      });
    };

    app.server.on('listening', logGatewayStarted);

    if (loadedGatewayConfig.config.cron?.enabled) {
      startScheduler = () => {
        if (scheduler) {
          return;
        }

        void startCronServices().catch((error) => {
          requestLogger?.warn(GATEWAY_LOG_EVENTS.cron_file_sync_failed, 'Cron startup sync failed', {
            error: error instanceof Error ? error.message : 'Cron startup sync failed.',
          });
        });
      };

      app.server.on('listening', startScheduler);
    }

    async function startCronServices(): Promise<void> {
      if (scheduler || cronServicesStarting) {
        return;
      }

      cronServicesStarting = true;
      const fileSyncOptions = resolveCronFileSyncOptions(loadedGatewayConfig);
      try {
        if (fileSyncOptions.enabled) {
          cronFileSync = createCronFileSyncLoop({
            dir: fileSyncOptions.dir,
            stores,
            logger: requestLogger,
            intervalMs: fileSyncOptions.intervalMs,
            now: options.scheduler?.now,
          });
          try {
            await cronFileSync.tick();
          } catch (error) {
            requestLogger?.warn(GATEWAY_LOG_EVENTS.cron_file_sync_failed, 'Cron startup sync failed', {
              dir: fileSyncOptions.dir,
              error: error instanceof Error ? error.message : 'Cron startup sync failed.',
            });
          }
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
      } finally {
        cronServicesStarting = false;
      }

      void scheduler.tick().catch(() => {
        // Startup should not fail just because an initial cron poll had a transient error.
      });
    }

    app.addHook('onClose', async () => {
      requestLogger?.info(GATEWAY_LOG_EVENTS.gateway_stopping, 'Gateway server stopping', {
        bootId,
        pid: process.pid,
      });
      await emitShutdownProgress(options.onShutdownProgress, 'Draining in-flight background work...');
      await scheduler?.stop();
      scheduler = undefined;
      await cronFileSync?.stop();
      cronFileSync = undefined;
      if (startScheduler) {
        app.server.off('listening', startScheduler);
      }
      app.server.off('listening', logGatewayStarted);
      await emitShutdownProgress(options.onShutdownProgress, 'Flushing runtime logs...');
      await flushAdaptiveAgentLogger(agentRuntimeLogger);
      requestLogger?.info(GATEWAY_LOG_EVENTS.gateway_stopped, 'Gateway server stopped', {
        bootId,
        pid: process.pid,
        durationMs: Date.now() - bootStartedAtMs,
      });
      await emitShutdownProgress(options.onShutdownProgress, 'Closing request logs and persistence stores...');
      await requestLogger?.close();
      await storeBundle?.close?.();
      await emitShutdownProgress(options.onShutdownProgress, 'Gateway shutdown complete.');
    });

    return {
      app,
      gatewayConfig: loadedGatewayConfig.config,
      gatewayConfigPath: loadedGatewayConfig.path,
      agentConfigs: loadedAgentConfigs,
      agentRegistry,
      gatewayModules,
      stores,
      runtimeStores: storeBundle.runtimeStores,
      bootId,
      get scheduler() {
        return scheduler;
      },
    };
  } catch (error) {
    await flushAdaptiveAgentLogger(agentRuntimeLogger);
    await requestLogger?.close();
    await storeBundle?.close?.();
    throw error;
  }
}

async function flushAdaptiveAgentLogger(logger: AdaptiveAgentLogger | undefined): Promise<void> {
  if (!logger || typeof logger.flush !== 'function') {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const finish = (error?: Error | null) => {
      if (settled) {
        return;
      }

      settled = true;
      if (error) {
        reject(error);
        return;
      }

      resolve();
    };

    try {
      logger.flush((error?: Error | null) => {
        if (isIgnorableLoggerFlushError(error)) {
          finish();
          return;
        }

        finish(error);
      });
    } catch (error) {
      if (isIgnorableLoggerFlushError(error)) {
        resolve();
        return;
      }

      reject(error);
    }
  });
}

function isIgnorableLoggerFlushError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('sonic boom is not ready yet');
}

async function emitShutdownProgress(
  callback: BootstrapGatewayOptions['onShutdownProgress'],
  message: string,
): Promise<void> {
  await callback?.(message);
}

function resolveCronFileSyncOptions(loadedGatewayConfig: LoadedConfig<GatewayConfig>): {
  enabled: boolean;
  dir: string;
  intervalMs: number;
} {
  const storesKind = loadedGatewayConfig.config.stores?.kind ?? 'memory';
  const fileSync = loadedGatewayConfig.config.cron?.fileSync;
  const enabled = storesKind === 'postgres' && (fileSync?.enabled ?? true);
  const defaultDir = resolve(dirname(loadedGatewayConfig.path), '..', 'data', 'gateway', 'cron-jobs');

  return {
    enabled,
    dir: resolve(fileSync?.dir ?? defaultDir),
    intervalMs: fileSync?.intervalMs ?? 60_000,
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

function formatListenAddress(address: string | AddressInfo | null): {
  host?: string;
  port?: number;
} {
  if (!address || typeof address === 'string') {
    return {};
  }

  return {
    host: address.address,
    port: address.port,
  };
}
