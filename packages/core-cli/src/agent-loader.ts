import {
  createAdaptiveAgent,
  type AgentDefaults,
  type ContinuationStore,
  type CreatedAdaptiveAgent,
  type EventStore,
  type JsonObject,
  type PlanStore,
  type RunStore,
  type SnapshotStore,
} from '@adaptive-agent/core';

import type { AgentConfig, LoadedAgentConfig } from './config.js';
import { resolveModelConfig, resolveWorkspaceRoot } from './config.js';
import type { ResolvedLocalModules, RuntimeBundle } from './local-modules.js';

export interface LoadedLocalAgent {
  created: CreatedAdaptiveAgent<RunStore, EventStore, SnapshotStore, PlanStore | undefined, ContinuationStore>;
  metadata: JsonObject;
}

export interface CreateLocalAgentOptions {
  loadedConfig: LoadedAgentConfig;
  modules: ResolvedLocalModules;
  runtime: RuntimeBundle;
  cwd?: string;
  autoApprove?: boolean;
  env?: NodeJS.ProcessEnv;
}

export function agentRunMetadata(config: AgentConfig): JsonObject {
  return {
    agentId: config.id,
    agentName: config.name,
    ...(config.metadata ?? {}),
  };
}

export function createLocalAgent(options: CreateLocalAgentOptions): LoadedLocalAgent {
  const config = options.loadedConfig.config;
  const defaults: Partial<AgentDefaults> = {
    ...(config.defaults ?? {}),
    ...(options.autoApprove ? { autoApproveAll: true } : {}),
  };

  const created = createAdaptiveAgent({
    model: resolveModelConfig(config.model, options.env),
    tools: options.modules.tools,
    delegates: options.modules.delegates.length > 0 ? options.modules.delegates : undefined,
    defaults,
    systemInstructions: config.systemInstructions,
    runtime: options.runtime.runtime,
  });

  return {
    created,
    metadata: agentRunMetadata(config),
  };
}

export function resolveLoadedWorkspaceRoot(loadedConfig: LoadedAgentConfig, cwd = process.cwd()): string {
  return resolveWorkspaceRoot(loadedConfig.config.workspaceRoot, cwd);
}
