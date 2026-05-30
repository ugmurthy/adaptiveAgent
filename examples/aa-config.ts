import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';

import type { ModelAdapterConfig } from '../packages/core/src/adapters/create-model-adapter.js';
import {
  DEFAULT_LOG_DESTINATION,
  DEFAULT_LOG_LEVEL,
  type AdaptiveAgentLogDestination,
  type AdaptiveAgentLogLevel,
} from '../packages/core/src/logger.js';
import type { CaptureMode, ResearchPolicyName, ToolBudget } from '../packages/core/src/types.js';

type ModelProvider = ModelAdapterConfig['provider'];
type WebSearchProvider = 'brave' | 'duckduckgo';

export interface AaProviderConfig {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  siteUrl?: string;
  siteName?: string;
}

export interface AaConfigFile {
  provider?: ModelProvider;
  providers?: Partial<Record<ModelProvider, AaProviderConfig>>;
  paths?: {
    projectRoot?: string;
    skillsDir?: string;
    writeRoot?: string;
    shellCwd?: string;
    logDir?: string;
  };
  tools?: {
    webSearch?: {
      enabled?: boolean;
      provider?: WebSearchProvider;
      braveApiKey?: string;
      timeoutMs?: number;
    };
  };
  logging?: {
    destination?: AdaptiveAgentLogDestination;
    level?: AdaptiveAgentLogLevel;
    name?: string;
    fileName?: string;
  };
  agent?: {
    verbose?: boolean;
    autoApprove?: boolean;
    maxSteps?: number;
    toolTimeoutMs?: number;
    modelTimeoutMs?: number;
    capture?: CaptureMode;
    researchPolicy?: ResearchPolicyName;
    toolBudgets?: Record<string, ToolBudget>;
    delegation?: {
      maxDepth?: number;
      maxChildrenPerRun?: number;
    };
  };
}

export interface ResolvedAaConfig {
  configPath: string;
  provider: ModelProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  siteUrl?: string;
  siteName?: string;
  projectRoot: string;
  skillsDir: string;
  writeRoot: string;
  shellCwd: string;
  webSearch: {
    enabled: boolean;
    provider: WebSearchProvider;
    braveApiKey?: string;
    timeoutMs?: number;
  };
  logging: {
    destination: AdaptiveAgentLogDestination;
    level: AdaptiveAgentLogLevel;
    name: string;
    filePath: string;
  };
  agent: {
    verbose: boolean;
    autoApprove: boolean;
    maxSteps?: number;
    toolTimeoutMs: number;
    modelTimeoutMs?: number;
    capture: CaptureMode;
    researchPolicy?: ResearchPolicyName;
    toolBudgets?: Record<string, ToolBudget>;
    delegation: {
      maxDepth: number;
      maxChildrenPerRun: number;
    };
  };
}

const MODEL_PROVIDERS = ['ollama', 'openrouter', 'mistral', 'mesh'] as const satisfies readonly ModelProvider[];
const WEB_SEARCH_PROVIDERS = ['brave', 'duckduckgo'] as const satisfies readonly WebSearchProvider[];
const LOG_DESTINATIONS = ['console', 'file', 'both'] as const satisfies readonly AdaptiveAgentLogDestination[];
const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
const CAPTURE_MODES = ['full', 'summary', 'none'] as const satisfies readonly CaptureMode[];

const DEFAULT_PROVIDER: ModelProvider = 'ollama';
const DEFAULT_MODEL_BY_PROVIDER: Record<ModelProvider, string> = {
  ollama: 'qwen3.5',
  openrouter: 'anthropic/claude-sonnet-4',
  mistral: 'mistral-large-latest',
  mesh: 'openai/gpt-4o',
};

const DEFAULT_AGENT_TOOL_TIMEOUT_MS = 30_000;
const DEFAULT_LOG_FILE_NAME = 'aa.log';
const DEFAULT_LOGGER_NAME = 'aa';
export const DEFAULT_AA_CONFIG_PATH = resolve(homedir(), '.config', '.aa', 'config.json');

export async function loadAaConfig(options: { configPath?: string } = {}): Promise<{ path: string; config: AaConfigFile }> {
  const requestedPath = options.configPath ?? process.env.AA_CONFIG_PATH ?? DEFAULT_AA_CONFIG_PATH;
  const configPath = resolvePath(requestedPath, process.cwd());

  let rawConfig: string;
  try {
    rawConfig = await readFile(configPath, 'utf8');
  } catch (error) {
    throw new Error(
      `Unable to read aa config at ${configPath}. Create ~/.config/.aa/config.json (or set AA_CONFIG_PATH) before running aa.ts.`,
      { cause: error },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig);
  } catch (error) {
    throw new Error(`Invalid JSON in aa config at ${configPath}: ${(error as Error).message}`, { cause: error });
  }

  if (!isRecord(parsed)) {
    throw new Error(`Expected aa config at ${configPath} to contain a top-level JSON object.`);
  }

  return {
    path: configPath,
    config: parsed as AaConfigFile,
  };
}

export async function resolveAaConfig(options: { configPath?: string } = {}): Promise<ResolvedAaConfig> {
  const loadedConfig = await loadAaConfig(options);
  const config = loadedConfig.config;
  const configDir = dirname(loadedConfig.path);
  const defaultProjectRoot = resolve(import.meta.dir, '..');

  const provider = readEnum(config.provider, MODEL_PROVIDERS, 'provider', loadedConfig.path) ?? DEFAULT_PROVIDER;
  const providers = readRecord(config.providers, 'providers', loadedConfig.path);
  const providerConfig = readRecord(providers?.[provider], `providers.${provider}`, loadedConfig.path);

  const model =
    readNonEmptyString(providerConfig?.model, `providers.${provider}.model`, loadedConfig.path) ??
    DEFAULT_MODEL_BY_PROVIDER[provider];
  const apiKey = readNonEmptyString(providerConfig?.apiKey, `providers.${provider}.apiKey`, loadedConfig.path);
  const baseUrl = readNonEmptyString(providerConfig?.baseUrl, `providers.${provider}.baseUrl`, loadedConfig.path);
  const siteUrl = readNonEmptyString(providerConfig?.siteUrl, `providers.${provider}.siteUrl`, loadedConfig.path);
  const siteName = readNonEmptyString(providerConfig?.siteName, `providers.${provider}.siteName`, loadedConfig.path);

  if (provider !== 'ollama' && !apiKey) {
    throw new Error(`providers.${provider}.apiKey is required in ${loadedConfig.path} when provider='${provider}'.`);
  }

  const paths = readRecord(config.paths, 'paths', loadedConfig.path);
  const projectRoot = resolveConfiguredPath(paths?.projectRoot, defaultProjectRoot, configDir, 'paths.projectRoot', loadedConfig.path);
  const skillsDir = resolveConfiguredPath(
    paths?.skillsDir,
    resolve(defaultProjectRoot, 'examples', 'skills'),
    projectRoot,
    'paths.skillsDir',
    loadedConfig.path,
  );
  const writeRoot = resolveConfiguredPath(
    paths?.writeRoot,
    resolve(projectRoot, 'artifacts'),
    projectRoot,
    'paths.writeRoot',
    loadedConfig.path,
  );
  const shellCwd = resolveConfiguredPath(
    paths?.shellCwd,
    projectRoot,
    projectRoot,
    'paths.shellCwd',
    loadedConfig.path,
  );
  const logDir = resolveConfiguredPath(
    paths?.logDir,
    resolve(projectRoot, 'logs'),
    projectRoot,
    'paths.logDir',
    loadedConfig.path,
  );

  const tools = readRecord(config.tools, 'tools', loadedConfig.path);
  const webSearch = readRecord(tools?.webSearch, 'tools.webSearch', loadedConfig.path);
  const braveApiKey = readNonEmptyString(webSearch?.braveApiKey, 'tools.webSearch.braveApiKey', loadedConfig.path);
  const configuredWebSearchProvider = readEnum(
    webSearch?.provider,
    WEB_SEARCH_PROVIDERS,
    'tools.webSearch.provider',
    loadedConfig.path,
  );
  const webSearchProvider = configuredWebSearchProvider ?? (braveApiKey ? 'brave' : 'duckduckgo');
  const webSearchEnabled =
    readBoolean(webSearch?.enabled, 'tools.webSearch.enabled', loadedConfig.path) ??
    (configuredWebSearchProvider === 'duckduckgo' || Boolean(braveApiKey));
  const webSearchTimeoutMs = readInteger(
    webSearch?.timeoutMs,
    'tools.webSearch.timeoutMs',
    loadedConfig.path,
    { minimum: 1 },
  );

  if (webSearchEnabled && webSearchProvider === 'brave' && !braveApiKey) {
    throw new Error(
      `tools.webSearch.braveApiKey is required in ${loadedConfig.path} when tools.webSearch.provider='brave'.`,
    );
  }

  const agent = readRecord(config.agent, 'agent', loadedConfig.path);
  const verbose = readBoolean(agent?.verbose, 'agent.verbose', loadedConfig.path) ?? false;
  const autoApprove = readBoolean(agent?.autoApprove, 'agent.autoApprove', loadedConfig.path) ?? false;
  const maxSteps = readInteger(agent?.maxSteps, 'agent.maxSteps', loadedConfig.path, { minimum: 1 });
  const toolTimeoutMs =
    readInteger(agent?.toolTimeoutMs, 'agent.toolTimeoutMs', loadedConfig.path, { minimum: 0 }) ??
    DEFAULT_AGENT_TOOL_TIMEOUT_MS;
  const modelTimeoutMs = readInteger(agent?.modelTimeoutMs, 'agent.modelTimeoutMs', loadedConfig.path, { minimum: 0 });
  const capture =
    readEnum(agent?.capture, CAPTURE_MODES, 'agent.capture', loadedConfig.path) ?? (verbose ? 'full' : 'summary');
  const researchPolicy = readEnum(
    agent?.researchPolicy,
    ['none', 'light', 'standard', 'deep', 'gaia'] as const,
    'agent.researchPolicy',
    loadedConfig.path,
  );
  const toolBudgets = readToolBudgets(agent?.toolBudgets, 'agent.toolBudgets', loadedConfig.path);

  const delegation = readRecord(agent?.delegation, 'agent.delegation', loadedConfig.path);
  const maxDepth = readInteger(
    delegation?.maxDepth,
    'agent.delegation.maxDepth',
    loadedConfig.path,
    { minimum: 0 },
  ) ?? 1;
  const maxChildrenPerRun = readInteger(
    delegation?.maxChildrenPerRun,
    'agent.delegation.maxChildrenPerRun',
    loadedConfig.path,
    { minimum: 0 },
  ) ?? 7;

  const logging = readRecord(config.logging, 'logging', loadedConfig.path);
  const logDestination =
    readEnum(logging?.destination, LOG_DESTINATIONS, 'logging.destination', loadedConfig.path) ?? DEFAULT_LOG_DESTINATION;
  const logLevel =
    readEnum(logging?.level, LOG_LEVELS, 'logging.level', loadedConfig.path) ?? (verbose ? 'debug' : DEFAULT_LOG_LEVEL);
  const loggerName = readNonEmptyString(logging?.name, 'logging.name', loadedConfig.path) ?? DEFAULT_LOGGER_NAME;
  const logFileName = readNonEmptyString(logging?.fileName, 'logging.fileName', loadedConfig.path) ?? DEFAULT_LOG_FILE_NAME;

  return {
    configPath: loadedConfig.path,
    provider,
    model,
    apiKey,
    baseUrl,
    siteUrl,
    siteName,
    projectRoot,
    skillsDir,
    writeRoot,
    shellCwd,
    webSearch: {
      enabled: webSearchEnabled,
      provider: webSearchProvider,
      braveApiKey,
      timeoutMs: webSearchTimeoutMs,
    },
    logging: {
      destination: logDestination,
      level: logLevel,
      name: loggerName,
      filePath: resolve(logDir, logFileName),
    },
    agent: {
      verbose,
      autoApprove,
      maxSteps,
      toolTimeoutMs,
      modelTimeoutMs,
      capture,
      researchPolicy,
      toolBudgets,
      delegation: {
        maxDepth,
        maxChildrenPerRun,
      },
    },
  };
}

function resolveConfiguredPath(
  rawValue: unknown,
  fallback: string,
  baseDir: string,
  field: string,
  configPath: string,
): string {
  const value = readNonEmptyString(rawValue, field, configPath);
  if (!value) {
    return fallback;
  }

  return resolvePath(value, baseDir);
}

function resolvePath(value: string, baseDir: string): string {
  const expanded = expandHomeDirectory(value.trim());
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

function expandHomeDirectory(value: string): string {
  if (value === '~') {
    return homedir();
  }

  if (value.startsWith('~/')) {
    return resolve(homedir(), value.slice(2));
  }

  return value;
}

function readRecord(value: unknown, field: string, configPath: string): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error(`Expected ${field} in ${configPath} to be an object.`);
  }

  return value;
}

function readNonEmptyString(value: unknown, field: string, configPath: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Expected ${field} in ${configPath} to be a non-empty string.`);
  }

  return value.trim();
}

function readBoolean(value: unknown, field: string, configPath: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'boolean') {
    throw new Error(`Expected ${field} in ${configPath} to be a boolean.`);
  }

  return value;
}

function readInteger(
  value: unknown,
  field: string,
  configPath: string,
  options: { minimum: number },
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isInteger(value) || (value as number) < options.minimum) {
    throw new Error(`Expected ${field} in ${configPath} to be an integer >= ${options.minimum}.`);
  }

  return value as number;
}

function readToolBudgets(value: unknown, field: string, configPath: string): Record<string, ToolBudget> | undefined {
  const record = readRecord(value, field, configPath);
  if (!record) {
    return undefined;
  }

  const budgets: Record<string, ToolBudget> = {};
  for (const [groupName, rawBudget] of Object.entries(record)) {
    const budget = readRecord(rawBudget, `${field}.${groupName}`, configPath);
    if (!budget) {
      continue;
    }

    budgets[groupName] = {
      maxCalls: readInteger(budget.maxCalls, `${field}.${groupName}.maxCalls`, configPath, { minimum: 0 }),
      maxConsecutiveCalls: readInteger(
        budget.maxConsecutiveCalls,
        `${field}.${groupName}.maxConsecutiveCalls`,
        configPath,
        { minimum: 0 },
      ),
      checkpointAfter: readInteger(budget.checkpointAfter, `${field}.${groupName}.checkpointAfter`, configPath, { minimum: 0 }),
      onExhausted: readEnum(
        budget.onExhausted,
        ['fail', 'continue_with_warning', 'ask_model'] as const,
        `${field}.${groupName}.onExhausted`,
        configPath,
      ),
    };
  }

  return budgets;
}

function readEnum<T extends string>(
  value: unknown,
  choices: readonly T[],
  field: string,
  configPath: string,
): T | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || !choices.includes(value as T)) {
    throw new Error(`Expected ${field} in ${configPath} to be one of: ${choices.join(', ')}.`);
  }

  return value as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
