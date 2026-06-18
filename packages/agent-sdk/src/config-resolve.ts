import { readdir } from 'node:fs/promises';
import { extname, isAbsolute, resolve } from 'node:path';

import type { ModelAdapterConfig } from '@adaptive-agent/core';

import type {
  AgentConfigFile,
  AgentSdkOptions,
  AgentSettingsFile,
  ResolvedAgentSdkConfig,
  TuiSettingsConfig,
} from './config-types.js';
import { validateAgent, validateSettings } from './config-validate.js';
import { AgentConfigValidationError, AgentSdkLookupError, AgentSettingsValidationError } from './errors.js';
import {
  adaptiveAgentHome,
  defaultApiKeyEnv,
  expandEnvironmentVariables,
  expandOptional,
  expandStrings,
  optionsString,
  pathExists,
  readJson,
  resolveAgentDirs,
  resolvePath,
  resolveSkillDirs,
} from './sdk-utils.js';

export interface ResolvedAgentSdkConfigWithSources {
  config: ResolvedAgentSdkConfig;
  agentPath: string;
  settingsPath?: string;
}

export async function resolveAgentSdkConfig(options: AgentSdkOptions): Promise<ResolvedAgentSdkConfig> {
  return (await resolveAgentSdkConfigWithSources(options)).config;
}

export async function resolveAgentSdkConfigWithSources(options: AgentSdkOptions): Promise<ResolvedAgentSdkConfigWithSources> {
  const cwd = options.cwd ?? process.cwd();
  const env = { ...(options.env ?? process.env) };
  const settingsLoaded = options.settingsConfig ? { path: '<inline settings>', value: options.settingsConfig } : await loadOptionalSettings(cwd, options.settingsConfigPath, env);
  const settings = validateSettings(expandStrings(settingsLoaded?.value ?? {}), settingsLoaded?.path ?? '<defaults>');
  Object.assign(env, settings.env ?? {});
  const agentDirs = resolveAgentDirs(cwd, settings.agents?.dirs, env);
  const agentLoaded = options.agentConfig ? { path: '<inline agent>', value: options.agentConfig } : await loadRequiredAgent(cwd, options.agentConfigPath ?? settings.agent?.configPath, env, agentDirs);
  const agent = validateAgent(expandStrings(agentLoaded.value), agentLoaded.path);
  if (settings.agent?.id && settings.agent.id !== agent.id) throw new AgentSettingsValidationError(settingsLoaded?.path ?? '<settings>', [`settings.agent.id (${settings.agent.id}) does not match agent.id (${agent.id})`]);

  const workspaceRoot = resolvePath(cwd, optionsString(settings.workspace?.overrideRoot) ?? optionsString(agent.workspace?.root) ?? optionsString(agent.workspaceRoot) ?? cwd);
  const shellCwd = resolvePath(workspaceRoot, optionsString(settings.workspace?.overrideShellCwd) ?? optionsString(agent.workspace?.shellCwd) ?? workspaceRoot);
  const provider = expandEnvironmentVariables(options.model?.provider ?? agent.model.provider ?? settings.model?.overrideProvider ?? '', env);
  const modelName = expandEnvironmentVariables(options.model?.model ?? agent.model.model ?? settings.model?.overrideModel ?? '', env);
  if (!provider || !modelName) throw new AgentConfigValidationError(agentLoaded.path, ['resolved model.provider and model.model are required']);
  const apiKeyEnv = expandEnvironmentVariables(options.model?.apiKeyEnv ?? settings.model?.overrideApiKeyEnv ?? agent.model.apiKeyEnv ?? defaultApiKeyEnv(provider) ?? '', env);
  const apiKey = apiKeyEnv ? env[apiKeyEnv] : agent.model.apiKey;
  const requestedMode = options.runtimeMode ?? settings.runtime?.mode ?? 'postgres';
  const postgresExplicit = Boolean(options.runtimeMode === 'postgres' || settings.runtime?.mode === 'postgres');
  const mode = requestedMode === 'postgres' && !env.DATABASE_URL && !postgresExplicit ? 'memory' : requestedMode;
  if (requestedMode === 'postgres' && !env.DATABASE_URL && postgresExplicit && !options.runtime) throw new AgentSettingsValidationError(settingsLoaded?.path ?? '<settings>', ['runtime.mode is postgres but DATABASE_URL is not set']);
  const config: ResolvedAgentSdkConfig = {
    agent,
    settings,
    workspaceRoot,
    shellCwd,
    model: {
      provider: provider as ModelAdapterConfig['provider'],
      model: modelName,
      baseUrl: expandOptional(options.model?.baseUrl ?? settings.model?.overrideBaseUrl ?? agent.model.baseUrl, env),
      maxConcurrentRequests: options.model?.maxConcurrentRequests ?? agent.model.maxConcurrentRequests,
      structuredOutputMode: options.model?.structuredOutputMode ?? settings.model?.overrideStructuredOutputMode ?? agent.model.structuredOutputMode ?? 'prompted',
      ...(apiKey ? { apiKey } : {}),
    },
    runtime: { requestedMode, mode, autoMigrate: settings.runtime?.autoMigrate ?? true },
    logging: { enabled: settings.logging?.enabled ?? false, level: settings.logging?.level ?? 'info', destination: settings.logging?.destination ?? 'console', filePath: expandOptional(settings.logging?.filePath, env), pretty: settings.logging?.pretty ?? true },
    interaction: { approvalMode: settings.interaction?.approvalMode ?? (settings.interaction?.autoApprove === false ? 'manual' : 'auto'), clarificationMode: settings.interaction?.clarificationMode ?? (settings.interaction?.interactive === false ? 'fail' : 'interactive') },
    events: { printLifecycle: settings.events?.printLifecycle ?? false, subscribe: settings.events?.subscribe ?? false, verbose: settings.events?.verbose ?? false },
    agents: { dirs: agentDirs },
    skills: { dirs: resolveSkillDirs(cwd, settings.skills?.dirs, settings.skills?.allowExampleSkills, env), allowExampleSkills: settings.skills?.allowExampleSkills ?? false },
    tui: normalizeTuiSettings(settings.tui),
  };

  return {
    config,
    agentPath: agentLoaded.path,
    ...(settingsLoaded?.path ? { settingsPath: settingsLoaded.path } : {}),
  };
}

function normalizeTuiSettings(settings: TuiSettingsConfig | undefined): TuiSettingsConfig {
  return settings ? { messages: settings.messages ?? {} } : { messages: {} };
}

async function loadOptionalSettings(cwd: string, explicitPath: string | undefined, env: NodeJS.ProcessEnv): Promise<{ path: string; value: AgentSettingsFile } | undefined> {
  const candidates = [explicitPath, env.ADAPTIVE_AGENT_SETTINGS, resolve(cwd, 'agent.settings.json'), resolve(adaptiveAgentHome(env), 'agent.settings.json')].filter(Boolean) as string[];
  for (const candidate of candidates) {
    const path = resolvePath(cwd, candidate);
    if (await pathExists(path)) return { path, value: await readJson(path) as AgentSettingsFile };
    if (candidate === explicitPath || candidate === env.ADAPTIVE_AGENT_SETTINGS) throw new AgentSdkLookupError('agent.settings.json', candidates.map((entry) => resolvePath(cwd, entry)));
  }
  return undefined;
}

async function loadRequiredAgent(cwd: string, explicitPath: string | undefined, env: NodeJS.ProcessEnv, agentDirs: string[]): Promise<{ path: string; value: AgentConfigFile }> {
  const candidates = [explicitPath, env.ADAPTIVE_AGENT_CONFIG, resolve(cwd, 'agent.json'), resolve(adaptiveAgentHome(env), 'agents', 'default-agent.json')].filter(Boolean) as string[];
  for (const candidate of candidates) {
    const path = resolvePath(cwd, candidate);
    if (await pathExists(path)) return { path, value: await readJson(path) as AgentConfigFile };
    const discovered = await resolveAgentConfigByName(candidate, agentDirs);
    if (discovered) return { path: discovered, value: await readJson(discovered) as AgentConfigFile };
    if (candidate === explicitPath || candidate === env.ADAPTIVE_AGENT_CONFIG) throw new AgentSdkLookupError('agent.json', candidates.map((entry) => resolvePath(cwd, entry)));
  }
  throw new AgentSdkLookupError('agent.json', candidates.map((entry) => resolvePath(cwd, entry)));
}

async function resolveAgentConfigByName(name: string, dirs: string[]): Promise<string | undefined> {
  if (!isAgentName(name)) return undefined;
  const fileNames = extname(name) ? [name] : [name, `${name}.json`];
  const matches: string[] = [];
  for (const dir of dirs) {
    if (!(await pathExists(dir))) continue;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !fileNames.includes(entry.name)) continue;
      matches.push(resolve(dir, entry.name));
    }
  }
  matches.sort();
  if (matches.length > 1) {
    throw new Error(`Ambiguous agent config "${name}". Matches:\n${matches.map((match) => `- ${match}`).join('\n')}`);
  }
  return matches[0];
}

function isAgentName(value: string): boolean {
  return Boolean(value.trim()) && !isAbsolute(value) && !/[\\/]/.test(value);
}
