import { access, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, resolve } from 'node:path';
import { stdin, stderr } from 'node:process';

import Ajv, { type ErrorObject } from 'ajv';
import { Pool, types } from 'pg';
import {
  createAdaptiveAgent,
  createAdaptiveAgentLogger,
  createAdaptiveAgentRuntime,
  createListDirectoryTool,
  createPostgresRuntimeStores,
  createReadFileTool,
  createReadWebPageTool,
  createShellExecTool,
  createWebSearchTool,
  createWriteFileTool,
  loadSkillFromDirectory,
  POSTGRES_RUNTIME_MIGRATIONS,
  skillToDelegate,
  type AdaptiveAgent,
  type AdaptiveAgentRuntimeOptions,
  type AgentDefaults,
  type AgentEvent,
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
  type ContinueRunOptions,
  type ContinueRunResult,
  type ContinuationStore,
  type ContinuationStrategy,
  type CreatedAdaptiveAgent,
  type DelegateDefinition,
  type EventStore,
  type FailureClass,
  type JsonObject,
  type JsonValue,
  type ModelAdapterConfig,
  type PlanStore,
  type PostgresClient,
  type PostgresMigrationDefinition,
  type PostgresPoolClient,
  type PostgresRuntimeStoreBundle,
  type PostgresTransactionClient,
  type RunRecoveryOptions,
  type RunRequest,
  type RunResult,
  type RunStore,
  type SnapshotStore,
  type ToolDefinition,
  type UUID,
} from '@adaptive-agent/core';

export type InvocationMode = 'run' | 'chat';
export type RuntimeMode = 'memory' | 'postgres';
export type ApprovalMode = 'manual' | 'auto' | 'reject';
export type ClarificationMode = 'interactive' | 'fail';
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';
export type LogDestination = 'console' | 'file' | 'both';

export interface AgentConfigFile {
  $schema?: string;
  version?: 1;
  id: string;
  name: string;
  description?: string;
  invocationModes: InvocationMode[];
  defaultInvocationMode: InvocationMode;
  workspace?: { root?: string; shellCwd?: string };
  workspaceRoot?: string;
  model: { provider?: string; model?: string; apiKeyEnv?: string; apiKey?: string; baseUrl?: string; maxConcurrentRequests?: number };
  systemInstructions?: string;
  tools: string[];
  delegates?: string[];
  defaults?: Partial<AgentDefaults>;
  delegation?: { maxDepth?: number; maxChildrenPerRun?: number; allowRecursiveDelegation?: boolean; childRunsMayRequestApproval?: boolean; childRunsMayRequestClarification?: boolean };
  recovery?: { continuation?: { enabled?: boolean; defaultStrategy?: ContinuationStrategy; requireUserApproval?: boolean }; retryableErrorCodes?: string[]; fallbackModels?: Array<{ provider: string; model: string; whenFailureClass?: FailureClass[]; whenErrorCode?: string[] }> };
  metadata?: JsonObject;
  routing?: JsonObject;
}

export interface AgentSettingsFile {
  $schema?: string;
  version?: 1;
  agent?: { configPath?: string; id?: string };
  runtime?: { mode?: RuntimeMode; autoMigrate?: boolean };
  logging?: { enabled?: boolean; level?: LogLevel; destination?: LogDestination; filePath?: string; pretty?: boolean };
  interaction?: { autoApprove?: boolean; interactive?: boolean; approvalMode?: ApprovalMode; clarificationMode?: ClarificationMode };
  events?: { printLifecycle?: boolean; subscribe?: boolean; verbose?: boolean };
  skills?: { dirs?: string[]; allowExampleSkills?: boolean };
  workspace?: { overrideRoot?: string; overrideShellCwd?: string };
  model?: { overrideProvider?: string; overrideModel?: string; overrideBaseUrl?: string; overrideApiKeyEnv?: string };
  defaults?: Partial<AgentDefaults>;
  env?: Record<string, string>;
}

export interface ResolvedAgentSdkConfig {
  agent: AgentConfigFile;
  settings: AgentSettingsFile;
  workspaceRoot: string;
  shellCwd: string;
  model: ModelAdapterConfig;
  runtime: { requestedMode: RuntimeMode; mode: RuntimeMode; autoMigrate: boolean };
  logging: { enabled: boolean; level: LogLevel; destination: LogDestination; filePath?: string; pretty: boolean };
  interaction: { approvalMode: ApprovalMode; clarificationMode: ClarificationMode };
  events: { printLifecycle: boolean; subscribe: boolean; verbose: boolean };
  skills: { dirs: string[]; allowExampleSkills: boolean };
}

export interface AgentSdkOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  agentConfig?: AgentConfigFile;
  agentConfigPath?: string;
  settingsConfig?: AgentSettingsFile;
  settingsConfigPath?: string;
  model?: Partial<ModelAdapterConfig> & { apiKeyEnv?: string };
  runtimeMode?: RuntimeMode;
  runtime?: AdaptiveAgentRuntimeOptions<RunStore, EventStore, SnapshotStore, PlanStore | undefined, ContinuationStore>;
  tools?: Array<ToolDefinition<any, any>>;
  delegates?: DelegateDefinition[];
  logger?: ReturnType<typeof createAdaptiveAgentLogger>;
  eventListener?: (event: AgentEvent) => void;
}

export class AgentConfigValidationError extends Error {
  constructor(readonly sourcePath: string, readonly issues: string[]) {
    super(`Invalid agent config at ${sourcePath}:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
    this.name = 'AgentConfigValidationError';
  }
}

export class AgentSettingsValidationError extends Error {
  constructor(readonly sourcePath: string, readonly issues: string[]) {
    super(`Invalid agent settings at ${sourcePath}:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
    this.name = 'AgentSettingsValidationError';
  }
}

export class AgentSdkLookupError extends Error {
  constructor(kind: string, readonly candidates: string[]) {
    super(`No ${kind} file found. Lookup order:\n${candidates.map((candidate, index) => `${index + 1}. ${candidate}`).join('\n')}`);
    this.name = 'AgentSdkLookupError';
  }
}

export interface AgentSdkRunOptions extends Omit<RunRequest, 'goal' | 'metadata'> { metadata?: JsonObject }
export interface AgentSdkChatOptions extends Omit<ChatRequest, 'messages' | 'metadata'> { metadata?: JsonObject }

export class AgentSdk {
  readonly agent: AdaptiveAgent;
  readonly created: CreatedAdaptiveAgent<RunStore, EventStore, SnapshotStore, PlanStore | undefined, ContinuationStore>;
  readonly config: ResolvedAgentSdkConfig;
  readonly metadata: JsonObject;
  readonly registeredToolNames: string[];
  private readonly closeRuntime?: () => Promise<void>;
  private unsubscribe?: () => void;

  private constructor(args: { created: CreatedAdaptiveAgent<RunStore, EventStore, SnapshotStore, PlanStore | undefined, ContinuationStore>; config: ResolvedAgentSdkConfig; metadata: JsonObject; registeredToolNames: string[]; closeRuntime?: () => Promise<void>; unsubscribe?: () => void }) {
    this.created = args.created;
    this.agent = args.created.agent;
    this.config = args.config;
    this.metadata = args.metadata;
    this.registeredToolNames = args.registeredToolNames;
    this.closeRuntime = args.closeRuntime;
    this.unsubscribe = args.unsubscribe;
  }

  static async create(options: AgentSdkOptions = {}): Promise<AgentSdk> {
    const config = await resolveAgentSdkConfig(options);
    const runtime = options.runtime ? { mode: config.runtime.mode, runtime: options.runtime } : await resolveRuntimeBundle(config.runtime.mode, config.runtime.autoMigrate, options.env);
    const modules = await resolveToolsAndDelegates(config, options);
    const logger = options.logger ?? (config.logging.enabled ? createAdaptiveAgentLogger(config.logging) : undefined);
    const metadata: JsonObject = { agentId: config.agent.id, agentName: config.agent.name, runtimeMode: config.runtime.mode, ...(config.agent.metadata ?? {}) };
    const created = createAdaptiveAgent({
      model: config.model,
      tools: modules.tools,
      delegates: modules.delegates.length > 0 ? modules.delegates : undefined,
      delegation: config.agent.delegation,
      recovery: normalizeRecovery(config.agent.recovery),
      defaults: { ...(config.agent.defaults ?? {}), ...(config.settings.defaults ?? {}), autoApproveAll: config.interaction.approvalMode === 'auto' || config.settings.defaults?.autoApproveAll === true },
      systemInstructions: config.agent.systemInstructions,
      runtime: runtime.runtime,
      eventSink: options.eventListener ? { emit: options.eventListener } : undefined,
      logger,
    });
    const unsubscribe = config.events.subscribe && created.runtime.eventStore.subscribe ? created.runtime.eventStore.subscribe((event) => options.eventListener?.(event)) : undefined;
    return new AgentSdk({ created, config, metadata, registeredToolNames: modules.registeredToolNames, closeRuntime: runtime.close, unsubscribe });
  }

  async run(goal: string, options: AgentSdkRunOptions = {}): Promise<RunResult> {
    return this.resolveInteractions(await this.agent.run({ ...options, goal, metadata: mergeMetadata(this.metadata, options.metadata) }));
  }

  async chat(messageOrMessages: string | ChatMessage[], options: AgentSdkChatOptions = {}): Promise<ChatResult> {
    const messages = typeof messageOrMessages === 'string' ? [{ role: 'user' as const, content: messageOrMessages }] : messageOrMessages;
    return this.resolveInteractions(await this.agent.chat({ ...options, messages, metadata: mergeMetadata(this.metadata, options.metadata) }));
  }

  async resume(runId: UUID): Promise<RunResult> { return this.resolveInteractions(await this.agent.resume(runId)); }
  async retry(runId: UUID): Promise<RunResult> { return this.resolveInteractions(await this.agent.retry(runId)); }
  async getRecoveryOptions(runId: UUID): Promise<RunRecoveryOptions> { return this.agent.getRecoveryOptions(runId); }
  async createContinuationRun(options: ContinueRunOptions): Promise<ContinueRunResult> { return this.agent.createContinuationRun(options); }
  async continueRun(options: ContinueRunOptions): Promise<RunResult> { return this.resolveInteractions(await this.agent.continueRun(options)); }
  async interrupt(runId: UUID): Promise<void> { await this.agent.interrupt(runId); }
  async steer(runId: UUID, message: Parameters<AdaptiveAgent['steer']>[1]): Promise<void> { await this.agent.steer(runId, message); }
  async inspect(runId: UUID): Promise<{ run: Awaited<ReturnType<RunStore['getRun']>>; events: AgentEvent[] }> { return { run: await this.created.runtime.runStore.getRun(runId), events: await this.created.runtime.eventStore.listByRun(runId) }; }
  subscribe(listener: (event: AgentEvent) => void): () => void { return this.created.runtime.eventStore.subscribe?.(listener) ?? (() => undefined); }
  async close(): Promise<void> { this.unsubscribe?.(); this.unsubscribe = undefined; await this.closeRuntime?.(); }

  private async resolveInteractions<T extends RunResult | ChatResult>(initial: T): Promise<T> {
    let result: RunResult | ChatResult = initial;
    while (result.status === 'approval_requested' || result.status === 'clarification_requested') {
      if (result.status === 'approval_requested') {
        if (this.config.interaction.approvalMode === 'reject') {
          await this.agent.resolveApproval(result.runId, false);
          result = await this.agent.resume(result.runId);
        } else if (this.config.interaction.approvalMode === 'auto') {
          await this.agent.resolveApproval(result.runId, true);
          result = await this.agent.resume(result.runId);
        } else {
          const approved = await promptYesNo(`Approve tool "${result.toolName}"? [y/N] `);
          await this.agent.resolveApproval(result.runId, approved);
          result = await this.agent.resume(result.runId);
        }
        continue;
      }
      if (this.config.interaction.clarificationMode === 'fail') throw new Error(`Run ${result.runId} requested clarification: ${result.message}`);
      const answer = await promptText(`${result.message}\nClarification answer: `);
      result = await this.agent.resolveClarification(result.runId, answer);
    }
    return result as T;
  }
}

export async function createAgentSdk(options: AgentSdkOptions = {}): Promise<AgentSdk> { return AgentSdk.create(options); }
export async function loadAgentSdkConfig(options: AgentSdkOptions = {}): Promise<ResolvedAgentSdkConfig> { return resolveAgentSdkConfig(options); }

async function resolveAgentSdkConfig(options: AgentSdkOptions): Promise<ResolvedAgentSdkConfig> {
  const cwd = options.cwd ?? process.cwd();
  const env = { ...(options.env ?? process.env) };
  const settingsLoaded = options.settingsConfig ? { path: '<inline settings>', value: options.settingsConfig } : await loadOptionalSettings(cwd, options.settingsConfigPath, env);
  const settings = validateSettings(expandStrings(settingsLoaded?.value ?? {}), settingsLoaded?.path ?? '<defaults>');
  Object.assign(env, settings.env ?? {});
  const agentLoaded = options.agentConfig ? { path: '<inline agent>', value: options.agentConfig } : await loadRequiredAgent(cwd, options.agentConfigPath ?? settings.agent?.configPath, env);
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
  return {
    agent,
    settings,
    workspaceRoot,
    shellCwd,
    model: { provider: provider as ModelAdapterConfig['provider'], model: modelName, baseUrl: expandOptional(options.model?.baseUrl ?? settings.model?.overrideBaseUrl ?? agent.model.baseUrl, env), maxConcurrentRequests: options.model?.maxConcurrentRequests ?? agent.model.maxConcurrentRequests, ...(apiKey ? { apiKey } : {}) },
    runtime: { requestedMode, mode, autoMigrate: settings.runtime?.autoMigrate ?? true },
    logging: { enabled: settings.logging?.enabled ?? false, level: settings.logging?.level ?? 'info', destination: settings.logging?.destination ?? 'console', filePath: expandOptional(settings.logging?.filePath, env), pretty: settings.logging?.pretty ?? true },
    interaction: { approvalMode: settings.interaction?.approvalMode ?? (settings.interaction?.autoApprove === false ? 'manual' : 'auto'), clarificationMode: settings.interaction?.clarificationMode ?? (settings.interaction?.interactive === false ? 'fail' : 'interactive') },
    events: { printLifecycle: settings.events?.printLifecycle ?? false, subscribe: settings.events?.subscribe ?? false, verbose: settings.events?.verbose ?? false },
    skills: { dirs: resolveSkillDirs(cwd, settings.skills?.dirs, settings.skills?.allowExampleSkills, env), allowExampleSkills: settings.skills?.allowExampleSkills ?? false },
  };
}

async function resolveToolsAndDelegates(config: ResolvedAgentSdkConfig, options: AgentSdkOptions): Promise<{ tools: Array<ToolDefinition<any, any>>; delegates: DelegateDefinition[]; registeredToolNames: string[] }> {
  const builtins = createBuiltinTools(config.workspaceRoot, config.shellCwd, options.env ?? process.env);
  const providedTools = new Map((options.tools ?? []).map((tool) => [tool.name, tool]));
  const registry = new Map([...builtins, ...providedTools]);
  const registeredToolNames = [...registry.keys()].sort();
  const missing = config.agent.tools.filter((name) => !registry.has(name));
  if (missing.length) throw new Error(`Unknown tool reference(s): ${missing.join(', ')}. Registered tools: ${registeredToolNames.join(', ') || '(none)'}.`);
  const tools = config.agent.tools.map((name) => registry.get(name)!);
  const delegates = [...(options.delegates ?? []), ...(await loadDelegates(config.agent.delegates ?? [], config.skills.dirs, new Set(tools.map((tool) => tool.name))))];
  return { tools, delegates, registeredToolNames };
}

function createBuiltinTools(workspaceRoot: string, shellCwd: string, env: NodeJS.ProcessEnv): Map<string, ToolDefinition<any, any>> {
  const tools = new Map<string, ToolDefinition<any, any>>();
  tools.set('read_file', createReadFileTool({ allowedRoot: workspaceRoot }));
  tools.set('list_directory', createListDirectoryTool({ allowedRoot: workspaceRoot }));
  tools.set('write_file', createWriteFileTool({ allowedRoot: workspaceRoot }));
  tools.set('shell_exec', createShellExecTool({ cwd: shellCwd }));
  const timeoutMs = parsePositiveInteger(env.WEB_TOOL_TIMEOUT_MS);
  if (env.WEB_SEARCH_PROVIDER === 'brave' && env.BRAVE_SEARCH_API_KEY) tools.set('web_search', createWebSearchTool({ provider: 'brave', apiKey: env.BRAVE_SEARCH_API_KEY, timeoutMs }));
  else tools.set('web_search', createWebSearchTool({ provider: 'duckduckgo', timeoutMs }));
  tools.set('read_web_page', createReadWebPageTool({ timeoutMs }));
  return tools;
}

async function loadDelegates(names: string[], dirs: string[], availableTools: Set<string>): Promise<DelegateDefinition[]> {
  const delegates = new Map<string, DelegateDefinition>();
  for (const dir of dirs) {
    if (!(await pathExists(dir))) continue;
    for (const name of names) {
      if (delegates.has(name)) continue;
      const skillDir = resolve(dir, name);
      if (!(await pathExists(skillDir))) continue;
      const delegate = skillToDelegate(await loadSkillFromDirectory(skillDir));
      if (delegate.name !== name) throw new Error(`Delegate "${name}" loaded from ${skillDir} declared skill name "${delegate.name}".`);
      const missing = delegate.allowedTools.filter((tool) => !availableTools.has(tool));
      if (missing.length) throw new Error(`Delegate "${name}" requires unavailable tool(s): ${missing.join(', ')}.`);
      delegates.set(name, delegate);
    }
  }
  const missing = names.filter((name) => !delegates.has(name));
  if (missing.length) throw new Error(`Unable to load delegate(s): ${missing.join(', ')}. Skill search dirs: ${dirs.join(', ') || '(none)'}.`);
  return names.map((name) => delegates.get(name)!);
}

async function loadOptionalSettings(cwd: string, explicitPath: string | undefined, env: NodeJS.ProcessEnv): Promise<{ path: string; value: AgentSettingsFile } | undefined> {
  const candidates = [explicitPath, env.ADAPTIVE_AGENT_SETTINGS, resolve(cwd, 'agent.settings.json'), resolve(homedir(), '.adaptiveAgent', 'agent.settings.json')].filter(Boolean) as string[];
  for (const candidate of candidates) {
    const path = resolvePath(cwd, candidate);
    if (await pathExists(path)) return { path, value: await readJson(path) as AgentSettingsFile };
    if (candidate === explicitPath || candidate === env.ADAPTIVE_AGENT_SETTINGS) throw new AgentSdkLookupError('agent.settings.json', candidates.map((entry) => resolvePath(cwd, entry)));
  }
  return undefined;
}

async function loadRequiredAgent(cwd: string, explicitPath: string | undefined, env: NodeJS.ProcessEnv): Promise<{ path: string; value: AgentConfigFile }> {
  const candidates = [explicitPath, env.ADAPTIVE_AGENT_CONFIG, resolve(cwd, 'agent.json'), resolve(homedir(), '.adaptiveAgent', 'agents', 'default-agent.json')].filter(Boolean) as string[];
  for (const candidate of candidates) {
    const path = resolvePath(cwd, candidate);
    if (await pathExists(path)) return { path, value: await readJson(path) as AgentConfigFile };
    if (candidate === explicitPath || candidate === env.ADAPTIVE_AGENT_CONFIG) throw new AgentSdkLookupError('agent.json', candidates.map((entry) => resolvePath(cwd, entry)));
  }
  throw new AgentSdkLookupError('agent.json', candidates.map((entry) => resolvePath(cwd, entry)));
}

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
const agentValidator = ajv.compile({ type: 'object', required: ['id', 'name', 'invocationModes', 'defaultInvocationMode', 'model', 'tools'], additionalProperties: true, properties: { id: { type: 'string', minLength: 1 }, name: { type: 'string', minLength: 1 }, invocationModes: { type: 'array', items: { enum: ['run', 'chat'] }, minItems: 1 }, defaultInvocationMode: { enum: ['run', 'chat'] }, model: { type: 'object', additionalProperties: true }, tools: { type: 'array', items: { type: 'string', minLength: 1 } }, delegates: { type: 'array', items: { type: 'string' }, nullable: true }, metadata: { type: 'object', nullable: true }, routing: { type: 'object', nullable: true } } });
const settingsValidator = ajv.compile({ type: 'object', additionalProperties: true, properties: { runtime: { type: 'object', additionalProperties: true, nullable: true, properties: { mode: { type: 'string', enum: ['memory', 'postgres'], nullable: true }, autoMigrate: { type: 'boolean', nullable: true } } }, logging: { type: 'object', additionalProperties: true, nullable: true, properties: { destination: { type: 'string', enum: ['console', 'file', 'both'], nullable: true } } } } });

function validateAgent(value: unknown, path: string): AgentConfigFile {
  if (!agentValidator(value)) throw new AgentConfigValidationError(path, formatAjvErrors('agent', agentValidator.errors));
  const config = value as AgentConfigFile;
  if (!config.invocationModes.includes(config.defaultInvocationMode)) throw new AgentConfigValidationError(path, ['agent.defaultInvocationMode must be included in agent.invocationModes']);
  return { ...config, delegates: config.delegates ?? [] };
}

function validateSettings(value: unknown, path: string): AgentSettingsFile {
  if (!settingsValidator(value)) throw new AgentSettingsValidationError(path, formatAjvErrors('settings', settingsValidator.errors));
  const settings = value as AgentSettingsFile;
  if ((settings.logging?.destination === 'file' || settings.logging?.destination === 'both') && !settings.logging.filePath) throw new AgentSettingsValidationError(path, ['settings.logging.filePath is required when logging.destination is "file" or "both"']);
  return settings;
}

function formatAjvErrors(prefix: string, errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => `${prefix}${error.instancePath.replaceAll('/', '.')} ${error.message ?? 'is invalid'}`);
}

async function resolveRuntimeBundle(mode: RuntimeMode, autoMigrate: boolean, env: NodeJS.ProcessEnv = process.env): Promise<{ mode: RuntimeMode; runtime?: AdaptiveAgentRuntimeOptions<RunStore, EventStore, SnapshotStore, PlanStore | undefined, ContinuationStore>; close?: () => Promise<void> }> {
  if (mode === 'memory') return { mode, runtime: createAdaptiveAgentRuntime<RunStore, EventStore, SnapshotStore, PlanStore | undefined>() };
  const pool = createPostgresPool(env);
  if (autoMigrate) await runPostgresRuntimeMigrations(pool);
  const stores = createPostgresRuntimeStores({ client: pool });
  return { mode, runtime: postgresStoresToRuntime(stores), close: () => pool.end() };
}

type CorePool = PostgresPoolClient & { end(): Promise<void> };
const TIMESTAMP_OIDS = [1082, 1114, 1184] as const;
let pgTypesConfigured = false;
function createPostgresPool(env: NodeJS.ProcessEnv): CorePool {
  if (!env.DATABASE_URL) throw new Error('Postgres runtime requires DATABASE_URL.');
  if (!pgTypesConfigured) { for (const oid of TIMESTAMP_OIDS) types.setTypeParser(oid, (value) => value); pgTypesConfigured = true; }
  return new Pool({ connectionString: env.DATABASE_URL, ssl: readBooleanEnv(env.PGSSL) ? { rejectUnauthorized: false } : undefined }) as unknown as CorePool;
}
function postgresStoresToRuntime(stores: PostgresRuntimeStoreBundle): AdaptiveAgentRuntimeOptions<RunStore, EventStore, SnapshotStore, PlanStore | undefined, ContinuationStore> { return { runStore: stores.runStore, eventStore: stores.eventStore, snapshotStore: stores.snapshotStore, planStore: stores.planStore, continuationStore: stores.continuationStore, toolExecutionStore: stores.toolExecutionStore, transactionStore: stores }; }
const CREATE_MIGRATION_TABLE_SQL = `create table if not exists adaptive_agent_migrations (name text primary key, applied_at timestamptz not null default now())`;
async function runPostgresRuntimeMigrations(client: PostgresClient | PostgresPoolClient): Promise<void> { await runWithPostgresTransaction(client, async (tx) => { await tx.query(CREATE_MIGRATION_TABLE_SQL); for (const migration of POSTGRES_RUNTIME_MIGRATIONS) await runMigrationIfNeeded(tx, migration); }); }
async function runMigrationIfNeeded(client: PostgresClient, migration: PostgresMigrationDefinition): Promise<void> { const existing = await client.query<{ name: string }>('SELECT name FROM adaptive_agent_migrations WHERE name = $1', [migration.name]); if (existing.rowCount) return; await client.query(migration.sql); await client.query('INSERT INTO adaptive_agent_migrations (name) VALUES ($1)', [migration.name]); }
async function runWithPostgresTransaction<T>(client: PostgresClient | PostgresPoolClient, operation: (client: PostgresClient) => Promise<T>): Promise<T> { const tx = isPool(client) ? await client.connect() : client; const release = isTx(tx); try { await tx.query('BEGIN'); const result = await operation(tx); await tx.query('COMMIT'); return result; } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { if (release) tx.release(); } }
function isPool(client: PostgresClient | PostgresPoolClient): client is PostgresPoolClient { return typeof (client as PostgresPoolClient).connect === 'function'; }
function isTx(client: PostgresClient): client is PostgresTransactionClient { return typeof (client as PostgresTransactionClient).release === 'function'; }

async function readJson(path: string): Promise<unknown> { try { return JSON.parse(await readFile(path, 'utf-8')) as unknown; } catch (error) { throw new AgentConfigValidationError(path, [`Unable to read or parse JSON: ${error instanceof Error ? error.message : String(error)}`]); } }
async function pathExists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
function resolvePath(cwd: string, value: string): string { const expanded = expandEnvironmentVariables(value, process.env); return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded); }
function expandStrings<T>(value: T, env: NodeJS.ProcessEnv = process.env): T { if (typeof value === 'string') return expandEnvironmentVariables(value, env) as T; if (Array.isArray(value)) return value.map((entry) => expandStrings(entry, env)) as T; if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expandStrings(entry, env)])) as T; return value; }
export function expandEnvironmentVariables(value: string, env: NodeJS.ProcessEnv = process.env): string { return value.replace(/\$(\w+)|\$\{([^}]+)\}|^~(?=\/|$)/g, (match, bare: string | undefined, braced: string | undefined) => { if (match === '~') return env.HOME ?? homedir(); const name = bare ?? braced; return name === 'HOME' ? env.HOME ?? homedir() : name ? env[name] ?? match : match; }); }
function expandOptional(value: string | undefined, env: NodeJS.ProcessEnv): string | undefined { return value ? expandEnvironmentVariables(value, env) : undefined; }
function optionsString(value: string | undefined): string | undefined { return value && value.trim() ? value : undefined; }
function defaultApiKeyEnv(provider: string): string | undefined { const normalized = provider.toLowerCase(); if (normalized === 'openrouter') return 'OPENROUTER_API_KEY'; if (normalized === 'mistral') return 'MISTRAL_API_KEY'; if (normalized === 'mesh') return 'MESH_API_KEY'; return undefined; }
function resolveSkillDirs(cwd: string, dirs: string[] | undefined, allowExamples: boolean | undefined, env: NodeJS.ProcessEnv): string[] { const selected = dirs?.length ? dirs : env.ADAPTIVE_AGENT_SKILLS_DIR ? env.ADAPTIVE_AGENT_SKILLS_DIR.split(delimiter).filter(Boolean) : ['./skills', '~/.adaptiveAgent/skills']; const resolved = selected.map((dir) => resolvePath(cwd, expandEnvironmentVariables(dir, env))); if (allowExamples) resolved.push(resolve(cwd, 'examples', 'skills')); return resolved; }
function normalizeRecovery(recovery: AgentConfigFile['recovery']) { return recovery ? { ...recovery, continuation: recovery.continuation ? { enabled: recovery.continuation.enabled ?? true, defaultStrategy: recovery.continuation.defaultStrategy, requireUserApproval: recovery.continuation.requireUserApproval } : undefined } : undefined; }
function mergeMetadata(base: JsonObject, extra: JsonObject | undefined): JsonObject { return { ...base, ...(extra ?? {}) }; }
function parsePositiveInteger(value: string | undefined): number | undefined { const parsed = value ? Number.parseInt(value, 10) : NaN; return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined; }
function readBooleanEnv(value: string | undefined): boolean { return value === '1' || value === 'true' || value === 'yes'; }
async function promptYesNo(question: string): Promise<boolean> { return ['y', 'yes'].includes((await promptText(question)).trim().toLowerCase()); }
async function promptText(question: string): Promise<string> { const rl = createInterface({ input: stdin, output: stderr }); try { return await rl.question(question); } finally { rl.close(); } }
