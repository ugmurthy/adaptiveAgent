import { createAdaptiveAgent, type CreatedAdaptiveAgent } from './core.js';

import type { AgentConfig, InvocationMode, LoadedConfig } from './config.js';
import { ModuleRegistry, type ResolvedAgentModules } from './registries.js';

export interface AgentCapabilitiesMetadata {
  agentId: string;
  name: string;
  invocationModes: InvocationMode[];
  defaultInvocationMode: InvocationMode;
  routing?: AgentConfig['routing'];
}

export interface RegisteredAgentDefinition extends AgentCapabilitiesMetadata {
  sourcePath?: string;
  config: AgentConfig;
  toolNames: string[];
  delegateNames: string[];
}

export interface AgentRegistryEntry {
  definition: RegisteredAgentDefinition;
  modules: ResolvedAgentModules;
}

export type AgentFactory = (entry: AgentRegistryEntry) => Promise<CreatedAdaptiveAgent> | CreatedAdaptiveAgent;

export interface CreateAgentRegistryOptions {
  agents: Array<LoadedConfig<AgentConfig>>;
  moduleRegistry: ModuleRegistry;
  agentFactory?: AgentFactory;
}

export class AgentRegistry {
  private readonly entries = new Map<string, AgentRegistryEntry>();
  private readonly materializedAgents = new Map<string, Promise<CreatedAdaptiveAgent>>();
  private readonly agentFactory: AgentFactory;

  constructor(options: CreateAgentRegistryOptions) {
    this.agentFactory = options.agentFactory ?? defaultAgentFactory;

    for (const loadedAgent of options.agents) {
      const modules = options.moduleRegistry.resolveAgentModules(
        loadedAgent.config,
        `agent "${loadedAgent.config.id}" (${loadedAgent.path})`,
      );
      const definition: RegisteredAgentDefinition = {
        agentId: loadedAgent.config.id,
        name: loadedAgent.config.name,
        invocationModes: loadedAgent.config.invocationModes,
        defaultInvocationMode: loadedAgent.config.defaultInvocationMode,
        routing: loadedAgent.config.routing,
        sourcePath: loadedAgent.path,
        config: loadedAgent.config,
        toolNames: modules.tools.map((tool) => tool.name),
        delegateNames: modules.delegates.map((delegate) => delegate.name),
      };

      if (this.entries.has(definition.agentId)) {
        throw new Error(`Duplicate agent id "${definition.agentId}".`);
      }

      this.entries.set(definition.agentId, {
        definition,
        modules,
      });
    }
  }

  has(agentId: string): boolean {
    return this.entries.has(agentId);
  }

  listAgentIds(): string[] {
    return [...this.entries.keys()].sort();
  }

  listAgents(): RegisteredAgentDefinition[] {
    return this.listAgentIds().map((agentId) => this.getEntry(agentId).definition);
  }

  getMetadata(agentId: string): AgentCapabilitiesMetadata {
    const entry = this.getEntry(agentId);

    return {
      agentId: entry.definition.agentId,
      name: entry.definition.name,
      invocationModes: [...entry.definition.invocationModes],
      defaultInvocationMode: entry.definition.defaultInvocationMode,
      routing: entry.definition.routing,
    };
  }

  getDefinition(agentId: string): RegisteredAgentDefinition {
    return this.getEntry(agentId).definition;
  }

  async getAgent(agentId: string): Promise<CreatedAdaptiveAgent> {
    const existingAgent = this.materializedAgents.get(agentId);
    if (existingAgent) {
      return existingAgent;
    }

    const entry = this.getEntry(agentId);
    const pendingAgent = Promise.resolve(this.agentFactory(entry)).catch((error) => {
      this.materializedAgents.delete(agentId);
      throw error;
    });

    this.materializedAgents.set(agentId, pendingAgent);
    return pendingAgent;
  }

  private getEntry(agentId: string): AgentRegistryEntry {
    const entry = this.entries.get(agentId);
    if (entry) {
      return entry;
    }

    const availableAgents = this.listAgentIds();
    const availableText = availableAgents.length > 0 ? availableAgents.join(', ') : '(none loaded)';
    throw new Error(`Unknown agent id "${agentId}". Loaded agents: ${availableText}.`);
  }
}

export function createAgentRegistry(options: CreateAgentRegistryOptions): AgentRegistry {
  return new AgentRegistry(options);
}

const defaultAgentFactory: AgentFactory = (entry) =>
  createAdaptiveAgent({
    model: entry.definition.config.model,
    tools: entry.modules.tools,
    delegates: entry.modules.delegates.length > 0 ? entry.modules.delegates : undefined,
    defaults: entry.definition.config.defaults,
    systemInstructions: entry.definition.config.systemInstructions,
  });
