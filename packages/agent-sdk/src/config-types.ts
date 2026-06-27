import {
  createAdaptiveAgentLogger,
  type AdaptiveAgentRuntimeOptions,
  type AgentDefaults,
  type AgentEvent,
  type ChatRequest,
  type ContinuationStore,
  type ContinuationStrategy,
  type DelegateDefinition,
  type EventStore,
  type FailureClass,
  type JsonObject,
  type JsonValue,
  type ModelAdapterConfig,
  type PlanStore,
  type RunRequest,
  type RunStore,
  type SnapshotStore,
  type ToolDefinition,
} from '@adaptive-agent/core';

export type InvocationMode = 'run' | 'chat';
export type RuntimeMode = 'memory' | 'postgres';
export type ApprovalMode = 'manual' | 'auto' | 'reject';
export type ClarificationMode = 'interactive' | 'fail';
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';
export type LogDestination = 'console' | 'file' | 'both';
export type TuiMessageType = 'user' | 'assistant' | 'progress' | 'run' | 'system' | 'event';
export type TuiTextStyleName = 'default' | 'dim' | 'bold' | 'italic' | 'underline' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white' | 'gray';
export type WeekdayName = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';

export type SupportedModality = 'text' | 'image' | 'file' | 'audio';

export interface AgentCapabilityConfig {
  modalitiesSupported?: SupportedModality[];
  modalitiesPreferred?: SupportedModality[];
  modalityRoles?: Partial<Record<SupportedModality, 'ingest' | 'analyze' | 'summarize' | 'synthesize'>>;
  subjectsPreferred?: string[];
}

export interface TuiMessageStyleConfig {
  showPrefix?: boolean;
  prefix?: TuiTextStyleName | TuiTextStyleName[];
  body?: TuiTextStyleName | TuiTextStyleName[];
}

export interface TuiSettingsConfig {
  messages?: Partial<Record<TuiMessageType, TuiMessageStyleConfig>>;
}

export interface GroundTruthSettingsConfig {
  enabled?: boolean;
  timezone?: string;
  locale?: string;
  weekStartsOn?: WeekdayName;
  fiscalYearStartMonth?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;
  fiscalQuarterNaming?: 'startYear' | 'endYear';
  businessDays?: WeekdayName[];
}

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
  model: { provider?: string; model?: string; apiKeyEnv?: string; apiKey?: string; baseUrl?: string; maxConcurrentRequests?: number; structuredOutputMode?: ModelAdapterConfig['structuredOutputMode'] };
  systemInstructions?: string;
  tools: string[];
  delegates?: string[];
  defaults?: Partial<AgentDefaults>;
  delegation?: { maxDepth?: number; maxChildrenPerRun?: number; allowRecursiveDelegation?: boolean; childRunsMayRequestApproval?: boolean; childRunsMayRequestClarification?: boolean };
  recovery?: { continuation?: { enabled?: boolean; defaultStrategy?: ContinuationStrategy; requireUserApproval?: boolean }; retryableErrorCodes?: string[]; fallbackModels?: Array<{ provider: string; model: string; whenFailureClass?: FailureClass[]; whenErrorCode?: string[] }> };
  metadata?: JsonObject;
  routing?: JsonObject;
  capabilities?: AgentCapabilityConfig;
}

export interface AgentSettingsFile {
  $schema?: string;
  version?: 1;
  agent?: { configPath?: string; id?: string };
  agents?: { dirs?: string[] };
  runtime?: { mode?: RuntimeMode; autoMigrate?: boolean };
  logging?: { enabled?: boolean; level?: LogLevel; destination?: LogDestination; filePath?: string; pretty?: boolean };
  interaction?: { autoApprove?: boolean; interactive?: boolean; approvalMode?: ApprovalMode; clarificationMode?: ClarificationMode };
  events?: { printLifecycle?: boolean; subscribe?: boolean; verbose?: boolean };
  skills?: { dirs?: string[]; allowExampleSkills?: boolean };
  workspace?: { overrideRoot?: string; overrideShellCwd?: string };
  model?: { overrideProvider?: string; overrideModel?: string; overrideBaseUrl?: string; overrideApiKeyEnv?: string; overrideStructuredOutputMode?: ModelAdapterConfig['structuredOutputMode'] };
  defaults?: Partial<AgentDefaults>;
  env?: Record<string, string>;
  tui?: TuiSettingsConfig;
  groundTruth?: GroundTruthSettingsConfig;
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
  agents: { dirs: string[] };
  skills: { dirs: string[]; allowExampleSkills: boolean };
  tui: TuiSettingsConfig;
  groundTruth: Required<Pick<GroundTruthSettingsConfig, 'enabled'>> & GroundTruthSettingsConfig;
}

export interface ResolvedAgentSdkModuleInspection {
  config: ResolvedAgentSdkConfig;
  tools: Array<Pick<ToolDefinition<JsonValue, JsonValue>, 'name' | 'description' | 'inputSchema' | 'requiresApproval'>>;
  delegates: Array<Pick<DelegateDefinition, 'name' | 'description' | 'allowedTools'>>;
  registeredTools: Array<Pick<ToolDefinition<JsonValue, JsonValue>, 'name' | 'description' | 'inputSchema' | 'requiresApproval'>>;
  registeredToolNames: string[];
}

export interface AgentSdkCatalogAgent {
  id: string;
  name: string;
  description?: string;
  path: string;
  active: boolean;
  invocationModes: InvocationMode[];
  defaultInvocationMode: InvocationMode;
  provider?: string;
  model?: string;
  tools: string[];
  delegates: string[];
  capabilities?: AgentCapabilityConfig;
}

export interface AgentSdkCatalogTool extends Pick<ToolDefinition<JsonValue, JsonValue>, 'name' | 'description' | 'inputSchema' | 'requiresApproval'> {
  configured: boolean;
}

export interface AgentSdkCatalogDelegate {
  name: string;
  description: string;
  path: string;
  configured: boolean;
  allowedTools: string[];
  triggers?: string[];
  handler?: string;
}

export interface AgentSdkCatalogInspection {
  config: ResolvedAgentSdkConfig;
  agentPath: string;
  settingsPath?: string;
  agents: AgentSdkCatalogAgent[];
  tools: AgentSdkCatalogTool[];
  delegates: AgentSdkCatalogDelegate[];
}

export interface AgentSdkOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  agentConfig?: AgentConfigFile;
  agentConfigPath?: string;
  settingsConfig?: AgentSettingsFile;
  settingsOverrides?: AgentSettingsFile;
  settingsConfigPath?: string;
  model?: Partial<ModelAdapterConfig> & { apiKeyEnv?: string };
  runtimeMode?: RuntimeMode;
  runtime?: AdaptiveAgentRuntimeOptions<RunStore, EventStore, SnapshotStore, PlanStore | undefined, ContinuationStore>;
  tools?: Array<ToolDefinition<any, any>>;
  delegates?: DelegateDefinition[];
  logger?: ReturnType<typeof createAdaptiveAgentLogger>;
  eventListener?: (event: AgentEvent) => void;
  clock?: () => Date;
}

export interface AgentSdkRunOptions extends Omit<RunRequest, 'goal' | 'metadata'> { metadata?: JsonObject }
export interface AgentSdkChatOptions extends Omit<ChatRequest, 'messages' | 'metadata'> { metadata?: JsonObject }
