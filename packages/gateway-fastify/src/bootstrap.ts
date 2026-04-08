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
import { createGatewayServer } from './server.js';
import { createModuleRegistry, ModuleRegistry, type ResolvedGatewayModules } from './registries.js';
import { createInMemoryGatewayStores, type GatewayStores } from './stores.js';

export interface BootstrapGatewayOptions {
  cwd?: string;
  gatewayConfigPath?: string;
  agentConfigDir?: string;
  moduleRegistry?: ModuleRegistry;
  agentFactory?: AgentFactory;
  fastify?: FastifyServerOptions;
  stores?: GatewayStores;
}

export interface BootstrappedGateway {
  app: FastifyInstance;
  gatewayConfig: GatewayConfig;
  gatewayConfigPath: string;
  agentConfigs: Array<LoadedConfig<AgentConfig>>;
  agentRegistry: AgentRegistry;
  gatewayModules: ResolvedGatewayModules;
  stores: GatewayStores;
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
  const agentRegistry = createAgentRegistry({
    agents: loadedAgentConfigs,
    moduleRegistry,
    agentFactory: options.agentFactory,
  });
  const stores = options.stores ?? createInMemoryGatewayStores();

  validateRoutingReferences(loadedGatewayConfig.config, agentRegistry, loadedGatewayConfig.path);

  const app = await createGatewayServer(loadedGatewayConfig.config, {
    fastify: options.fastify,
    auth: gatewayModules.auth,
    stores,
  });

  return {
    app,
    gatewayConfig: loadedGatewayConfig.config,
    gatewayConfigPath: loadedGatewayConfig.path,
    agentConfigs: loadedAgentConfigs,
    agentRegistry,
    gatewayModules,
    stores,
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
