import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

import type { AgentDefaults, JsonObject, JsonValue, ModelAdapterConfig } from '@adaptive-agent/core';

export const INVOCATION_MODES = ['chat', 'run'] as const;
export const MODEL_PROVIDERS = ['openrouter', 'ollama', 'mistral', 'mesh'] as const;
export const CAPTURE_MODES = ['full', 'summary', 'none'] as const;
export const RESEARCH_POLICIES = ['none', 'light', 'standard', 'deep'] as const;
export const TOOL_BUDGET_EXHAUSTED_ACTIONS = ['fail', 'continue_with_warning', 'ask_model'] as const;

export type InvocationMode = (typeof INVOCATION_MODES)[number];

export interface LocalModelAdapterConfig extends ModelAdapterConfig {
  apiKeyEnv?: string;
}

export interface AgentConfig {
  id: string;
  name: string;
  invocationModes: InvocationMode[];
  defaultInvocationMode: InvocationMode;
  model: LocalModelAdapterConfig;
  workspaceRoot?: string;
  systemInstructions?: string;
  tools: string[];
  delegates: string[];
  defaults?: Partial<AgentDefaults>;
  metadata?: JsonObject;
  routing?: JsonObject;
}

export interface LoadedAgentConfig {
  path: string;
  config: AgentConfig;
}

export interface LoadAgentConfigOptions {
  cwd?: string;
  explicitPath?: string;
  env?: NodeJS.ProcessEnv;
}

export class ConfigValidationError extends Error {
  constructor(
    readonly sourcePath: string,
    readonly issues: string[],
  ) {
    super(`Invalid agent config at ${sourcePath}:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
    this.name = 'ConfigValidationError';
  }
}

export class ConfigLookupError extends Error {
  constructor(readonly candidates: string[]) {
    super(formatMissingConfigMessage(candidates));
    this.name = 'ConfigLookupError';
  }
}

export async function loadAgentConfig(options: LoadAgentConfigOptions = {}): Promise<LoadedAgentConfig> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const selectedPath = await selectAgentConfigPath({ cwd, explicitPath: options.explicitPath, env });
  const rawConfig = await readJsonFile(selectedPath);

  return {
    path: selectedPath,
    config: validateAgentConfig(rawConfig, selectedPath),
  };
}

export async function selectAgentConfigPath(options: LoadAgentConfigOptions = {}): Promise<string> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const candidates = agentConfigCandidates(cwd, options.explicitPath, env);
  const selectedCandidate = candidates.find((candidate) => candidate.enabled);

  if (selectedCandidate?.required) {
    const path = resolvePath(cwd, selectedCandidate.path);
    if (!(await pathExists(path))) {
      throw new Error(`Agent config file not found: ${path}`);
    }

    return path;
  }

  for (const candidate of candidates) {
    const path = resolvePath(cwd, candidate.path);
    if (await pathExists(path)) {
      return path;
    }
  }

  throw new ConfigLookupError(candidates.map((candidate) => resolvePath(cwd, candidate.path)));
}

export function validateAgentConfig(value: unknown, sourcePath: string): AgentConfig {
  const issues: string[] = [];
  const root = expectObject(value, 'agent', issues);
  const id = expectNonEmptyString(root?.id, 'id', issues) ?? 'invalid-agent-id';
  const name = expectNonEmptyString(root?.name, 'name', issues) ?? 'Invalid Agent';
  const invocationModes = parseInvocationModes(root?.invocationModes, 'invocationModes', issues);
  const defaultInvocationMode = parseDefaultInvocationMode(
    root?.defaultInvocationMode,
    invocationModes,
    'defaultInvocationMode',
    issues,
  );
  const model = parseModelConfig(root?.model, 'model', issues);
  const workspaceRoot = expectOptionalNonEmptyString(root?.workspaceRoot, 'workspaceRoot', issues);
  const systemInstructions = expectOptionalNonEmptyString(root?.systemInstructions, 'systemInstructions', issues);
  const tools = expectStringArray(root?.tools, 'tools', issues) ?? [];
  const delegates = expectStringArray(root?.delegates, 'delegates', issues) ?? [];
  const defaults = parseAgentDefaults(root?.defaults, 'defaults', issues);
  const metadata = expectOptionalJsonObject(root?.metadata, 'metadata', issues);
  const routing = expectOptionalJsonObject(root?.routing, 'routing', issues);

  if (issues.length > 0) {
    throw new ConfigValidationError(sourcePath, issues);
  }

  return {
    id,
    name,
    invocationModes,
    defaultInvocationMode,
    model,
    workspaceRoot,
    systemInstructions,
    tools,
    delegates,
    defaults,
    metadata,
    routing,
  };
}

export function resolveWorkspaceRoot(value: string | undefined, cwd = process.cwd()): string {
  return resolvePath(cwd, expandEnvironmentVariables(value ?? cwd));
}

export function resolveModelConfig(model: LocalModelAdapterConfig, env: NodeJS.ProcessEnv = process.env): ModelAdapterConfig {
  const apiKey = model.apiKey ?? readModelApiKey(model, env);
  const resolved: ModelAdapterConfig = {
    provider: model.provider,
    model: model.model,
    baseUrl: model.baseUrl,
    siteUrl: model.siteUrl,
    siteName: model.siteName,
    maxConcurrentRequests: model.maxConcurrentRequests,
  };

  if (apiKey) {
    resolved.apiKey = apiKey;
  }

  return resolved;
}

export function expandEnvironmentVariables(value: string): string {
  return value.replace(/\$(\w+)|\$\{([^}]+)\}/g, (match, bareName: string | undefined, bracedName: string | undefined) => {
    const variableName = bareName ?? bracedName;
    if (variableName === 'HOME') {
      return process.env.HOME ?? homedir();
    }

    return variableName ? (process.env[variableName] ?? match) : match;
  });
}

function agentConfigCandidates(cwd: string, explicitPath: string | undefined, env: NodeJS.ProcessEnv): Array<{ path: string; enabled: boolean; required: boolean }> {
  return [
    { path: explicitPath ?? '', enabled: Boolean(explicitPath), required: Boolean(explicitPath) },
    { path: env.ADAPTIVE_AGENT_CONFIG ?? '', enabled: Boolean(env.ADAPTIVE_AGENT_CONFIG), required: Boolean(env.ADAPTIVE_AGENT_CONFIG) },
    { path: resolve(cwd, 'agent.json'), enabled: true, required: false },
    { path: resolve(homedir(), '.adaptiveAgent', 'agents', 'default-agent.json'), enabled: true, required: false },
  ].filter((candidate) => candidate.enabled || candidate.path);
}

function formatMissingConfigMessage(candidates: string[]): string {
  return [
    'No agent config file found.',
    'Lookup order:',
    ...candidates.map((candidate, index) => `${index + 1}. ${candidate}`),
    '',
    'Example minimal config:',
    JSON.stringify(
      {
        id: 'local-agent',
        name: 'Local Agent',
        invocationModes: ['chat', 'run'],
        defaultInvocationMode: 'run',
        model: { provider: 'ollama', model: 'qwen3.5' },
        workspaceRoot: '$HOME/project',
        tools: ['read_file', 'list_directory'],
        delegates: [],
      },
      null,
      2,
    ),
  ].join('\n');
}

async function readJsonFile(path: string): Promise<unknown> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigValidationError(path, [`Unable to read config file: ${message}`]);
  }

  try {
    return JSON.parse(contents) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigValidationError(path, [`Invalid JSON: ${message}`]);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function resolvePath(cwd: string, value: string): string {
  const expanded = expandEnvironmentVariables(value);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function parseInvocationModes(value: unknown, path: string, issues: string[]): InvocationMode[] {
  const values = expectStringArray(value, path, issues) ?? [];
  if (values.length === 0) {
    issues.push(`${path} must include at least one invocation mode.`);
    return ['chat'];
  }

  const modes: InvocationMode[] = [];
  const seen = new Set<InvocationMode>();
  for (const value of values) {
    const mode = expectEnum(value, INVOCATION_MODES, path, issues);
    if (mode && !seen.has(mode)) {
      seen.add(mode);
      modes.push(mode);
    }
  }

  return modes.length > 0 ? modes : ['chat'];
}

function parseDefaultInvocationMode(value: unknown, invocationModes: InvocationMode[], path: string, issues: string[]): InvocationMode {
  const mode = expectEnum(value, INVOCATION_MODES, path, issues) ?? invocationModes[0] ?? 'chat';
  if (!invocationModes.includes(mode)) {
    issues.push(`${path} must be included in invocationModes.`);
  }

  return mode;
}

function parseModelConfig(value: unknown, path: string, issues: string[]): LocalModelAdapterConfig {
  const model = expectObject(value, path, issues);
  return {
    provider: expectEnum(model?.provider, MODEL_PROVIDERS, `${path}.provider`, issues) ?? 'ollama',
    model: expectNonEmptyString(model?.model, `${path}.model`, issues) ?? 'invalid-model',
    apiKey: expectOptionalNonEmptyString(model?.apiKey, `${path}.apiKey`, issues),
    apiKeyEnv: expectOptionalNonEmptyString(model?.apiKeyEnv, `${path}.apiKeyEnv`, issues),
    baseUrl: expectOptionalNonEmptyString(model?.baseUrl, `${path}.baseUrl`, issues),
    siteUrl: expectOptionalNonEmptyString(model?.siteUrl, `${path}.siteUrl`, issues),
    siteName: expectOptionalNonEmptyString(model?.siteName, `${path}.siteName`, issues),
    maxConcurrentRequests: expectOptionalPositiveInteger(model?.maxConcurrentRequests, `${path}.maxConcurrentRequests`, issues),
  };
}

function parseAgentDefaults(value: unknown, path: string, issues: string[]): Partial<AgentDefaults> | undefined {
  if (value === undefined) {
    return undefined;
  }

  const defaults = expectObject(value, path, issues);
  const parsed: Partial<AgentDefaults> = {};
  assignIfDefined(parsed, 'maxSteps', expectOptionalPositiveInteger(defaults?.maxSteps, `${path}.maxSteps`, issues));
  assignIfDefined(parsed, 'toolTimeoutMs', expectOptionalPositiveInteger(defaults?.toolTimeoutMs, `${path}.toolTimeoutMs`, issues));
  assignIfDefined(parsed, 'modelTimeoutMs', expectOptionalPositiveInteger(defaults?.modelTimeoutMs, `${path}.modelTimeoutMs`, issues));
  assignIfDefined(parsed, 'maxRetriesPerStep', expectOptionalPositiveInteger(defaults?.maxRetriesPerStep, `${path}.maxRetriesPerStep`, issues));
  assignIfDefined(parsed, 'requireApprovalForWriteTools', expectOptionalBoolean(defaults?.requireApprovalForWriteTools, `${path}.requireApprovalForWriteTools`, issues));
  assignIfDefined(parsed, 'autoApproveAll', expectOptionalBoolean(defaults?.autoApproveAll, `${path}.autoApproveAll`, issues));
  assignIfDefined(parsed, 'injectToolManifest', expectOptionalBoolean(defaults?.injectToolManifest, `${path}.injectToolManifest`, issues));

  if (defaults?.capture !== undefined) {
    const capture = expectEnum(defaults.capture, CAPTURE_MODES, `${path}.capture`, issues);
    if (capture) parsed.capture = capture;
  }

  if (defaults?.researchPolicy !== undefined) {
    parsed.researchPolicy = parseResearchPolicy(defaults.researchPolicy, `${path}.researchPolicy`, issues);
  }

  if (defaults?.toolBudgets !== undefined) {
    parsed.toolBudgets = parseToolBudgets(defaults.toolBudgets, `${path}.toolBudgets`, issues);
  }

  return parsed;
}

function parseResearchPolicy(value: unknown, path: string, issues: string[]): AgentDefaults['researchPolicy'] | undefined {
  if (typeof value === 'string') {
    return expectEnum(value, RESEARCH_POLICIES, path, issues);
  }

  const policy = expectObject(value, path, issues);
  const mode = expectEnum(policy?.mode, RESEARCH_POLICIES, `${path}.mode`, issues);
  if (!mode) {
    return undefined;
  }

  return {
    mode,
    maxSearches: expectOptionalNonNegativeInteger(policy?.maxSearches, `${path}.maxSearches`, issues),
    maxPagesRead: expectOptionalNonNegativeInteger(policy?.maxPagesRead, `${path}.maxPagesRead`, issues),
    checkpointAfter: expectOptionalNonNegativeInteger(policy?.checkpointAfter, `${path}.checkpointAfter`, issues),
    requirePurpose: expectOptionalBoolean(policy?.requirePurpose, `${path}.requirePurpose`, issues),
  };
}

function parseToolBudgets(value: unknown, path: string, issues: string[]): NonNullable<AgentDefaults['toolBudgets']> | undefined {
  const rawBudgets = expectObject(value, path, issues);
  if (!rawBudgets) {
    return undefined;
  }

  const parsed: NonNullable<AgentDefaults['toolBudgets']> = {};
  for (const [groupName, rawBudget] of Object.entries(rawBudgets)) {
    const budget = expectObject(rawBudget, `${path}.${groupName}`, issues);
    if (!budget) continue;

    parsed[groupName] = {
      maxCalls: expectOptionalNonNegativeInteger(budget.maxCalls, `${path}.${groupName}.maxCalls`, issues),
      maxConsecutiveCalls: expectOptionalNonNegativeInteger(budget.maxConsecutiveCalls, `${path}.${groupName}.maxConsecutiveCalls`, issues),
      checkpointAfter: expectOptionalNonNegativeInteger(budget.checkpointAfter, `${path}.${groupName}.checkpointAfter`, issues),
      onExhausted:
        budget.onExhausted === undefined
          ? undefined
          : expectEnum(budget.onExhausted, TOOL_BUDGET_EXHAUSTED_ACTIONS, `${path}.${groupName}.onExhausted`, issues),
    };
  }

  return parsed;
}

function readModelApiKey(model: LocalModelAdapterConfig, env: NodeJS.ProcessEnv): string | undefined {
  if (model.apiKeyEnv) {
    const value = env[model.apiKeyEnv];
    if (!value) {
      throw new Error(`Model config requires environment variable ${model.apiKeyEnv}.`);
    }

    return value;
  }

  const envNameByProvider: Partial<Record<LocalModelAdapterConfig['provider'], string>> = {
    openrouter: 'OPENROUTER_API_KEY',
    mistral: 'MISTRAL_API_KEY',
    mesh: 'MESH_API_KEY',
  };
  const envName = envNameByProvider[model.provider];
  return envName ? env[envName] : undefined;
}

function expectObject(value: unknown, path: string, issues: string[]): Record<string, unknown> | undefined {
  if (isRecord(value)) {
    return value;
  }

  issues.push(`${path} must be a JSON object.`);
  return undefined;
}

function expectArray(value: unknown, path: string, issues: string[]): unknown[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }

  issues.push(`${path} must be an array.`);
  return undefined;
}

function expectStringArray(value: unknown, path: string, issues: string[]): string[] | undefined {
  const items = expectArray(value, path, issues);
  if (!items) {
    return undefined;
  }

  const values: string[] = [];
  for (const [index, item] of items.entries()) {
    const parsed = expectNonEmptyString(item, `${path}[${index}]`, issues);
    if (parsed) values.push(parsed);
  }

  return values;
}

function expectBoolean(value: unknown, path: string, issues: string[]): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }

  issues.push(`${path} must be a boolean.`);
  return undefined;
}

function expectOptionalBoolean(value: unknown, path: string, issues: string[]): boolean | undefined {
  return value === undefined ? undefined : expectBoolean(value, path, issues);
}

function expectNonEmptyString(value: unknown, path: string, issues: string[]): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }

  issues.push(`${path} must be a non-empty string.`);
  return undefined;
}

function expectOptionalNonEmptyString(value: unknown, path: string, issues: string[]): string | undefined {
  return value === undefined ? undefined : expectNonEmptyString(value, path, issues);
}

function expectOptionalPositiveInteger(value: unknown, path: string, issues: string[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  issues.push(`${path} must be a positive integer.`);
  return undefined;
}

function expectOptionalNonNegativeInteger(value: unknown, path: string, issues: string[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  issues.push(`${path} must be a non-negative integer.`);
  return undefined;
}

function expectEnum<TValue extends string>(value: unknown, allowedValues: readonly TValue[], path: string, issues: string[]): TValue | undefined {
  if (typeof value === 'string' && allowedValues.includes(value as TValue)) {
    return value as TValue;
  }

  issues.push(`${path} must be one of: ${allowedValues.join(', ')}.`);
  return undefined;
}

function expectOptionalJsonObject(value: unknown, path: string, issues: string[]): JsonObject | undefined {
  if (value === undefined) {
    return undefined;
  }

  const jsonValue = toJsonValue(value, path, issues);
  if (isRecord(jsonValue)) {
    return jsonValue as JsonObject;
  }

  issues.push(`${path} must be a JSON object.`);
  return undefined;
}

function toJsonValue(value: unknown, path: string, issues: string[]): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const [index, item] of value.entries()) {
      const jsonValue = toJsonValue(item, `${path}[${index}]`, issues);
      if (jsonValue !== undefined) result.push(jsonValue);
    }
    return result;
  }

  if (isRecord(value)) {
    const result: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      const jsonValue = toJsonValue(item, `${path}.${key}`, issues);
      if (jsonValue !== undefined) result[key] = jsonValue;
    }
    return result;
  }

  issues.push(`${path} must contain only JSON-serializable values.`);
  return undefined;
}

function assignIfDefined<TKey extends keyof AgentDefaults>(target: Partial<AgentDefaults>, key: TKey, value: AgentDefaults[TKey] | undefined): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
