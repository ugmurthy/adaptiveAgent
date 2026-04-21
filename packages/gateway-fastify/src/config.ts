import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { ConfigValidationError } from './errors.js';
import { validateAgentConfig } from './config/parse-agent.js';
import { resolveGatewayRequestLogLevel, validateGatewayConfig } from './config/parse-gateway.js';
import {
  DEFAULT_AGENT_CONFIG_DIR,
  DEFAULT_GATEWAY_CONFIG_PATH,
  GATEWAY_HOOK_SLOTS,
  type AgentConfig,
  type AgentRoutingConfig,
  type GatewayAgentRuntimeLoggingConfig,
  type GatewayAuthConfig,
  type GatewayBinding,
  type GatewayBindingMatch,
  type GatewayChannelConfig,
  type GatewayChannelDefaults,
  type GatewayConfig,
  type GatewayCronConfig,
  type GatewayCronFileSyncConfig,
  type GatewayHookSlot,
  type GatewayHooksConfig,
  type GatewayRequestLogLevel,
  type GatewayRequestLoggingDestination,
  type GatewayServerConfig,
  type GatewayStoreConfig,
  type GatewayTranscriptConfig,
  type HookFailurePolicy,
  type InvocationMode,
  type LoadedConfig,
  type LoadAgentConfigOptions,
  type LoadAgentConfigsOptions,
  type LoadGatewayConfigOptions,
} from './config/types.js';

export {
  DEFAULT_AGENT_CONFIG_DIR,
  DEFAULT_GATEWAY_CONFIG_PATH,
  GATEWAY_HOOK_SLOTS,
  resolveGatewayRequestLogLevel,
};
export type {
  AgentConfig,
  AgentRoutingConfig,
  GatewayAgentRuntimeLoggingConfig,
  GatewayAuthConfig,
  GatewayBinding,
  GatewayBindingMatch,
  GatewayChannelConfig,
  GatewayChannelDefaults,
  GatewayConfig,
  GatewayCronConfig,
  GatewayCronFileSyncConfig,
  GatewayHookSlot,
  GatewayHooksConfig,
  GatewayRequestLogLevel,
  GatewayRequestLoggingDestination,
  GatewayServerConfig,
  GatewayStoreConfig,
  GatewayTranscriptConfig,
  HookFailurePolicy,
  InvocationMode,
  LoadedConfig,
  LoadAgentConfigOptions,
  LoadAgentConfigsOptions,
  LoadGatewayConfigOptions,
};

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
