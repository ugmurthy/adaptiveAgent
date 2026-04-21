import type {
  AdaptiveAgentLogDestination,
  AdaptiveAgentLogLevel,
  AgentDefaults,
  JsonObject,
  ModelAdapterConfig,
} from '../core.js';

export const DEFAULT_GATEWAY_CONFIG_PATH = 'config/gateway.json';
export const DEFAULT_AGENT_CONFIG_DIR = 'config/agents';
export const GATEWAY_HOOK_SLOTS = [
  'onAuthenticate',
  'onSessionResolve',
  'beforeRoute',
  'beforeInboundMessage',
  'beforeRunStart',
  'afterRunResult',
  'onAgentEvent',
  'beforeOutboundFrame',
  'onDisconnect',
  'onError',
] as const;

export const INVOCATION_MODES = ['chat', 'run'] as const;
export const CAPTURE_MODES = ['full', 'summary', 'none'] as const;
export const HOOK_FAILURE_POLICIES = ['fail', 'warn', 'ignore'] as const;
export const REQUEST_LOG_DESTINATIONS = ['console', 'file', 'both'] as const;
export const REQUEST_LOG_LEVELS = ['debug', 'info', 'warn', 'silent'] as const;
export const AGENT_RUNTIME_LOG_DESTINATIONS = ['console', 'file', 'both'] as const satisfies readonly AdaptiveAgentLogDestination[];
export const AGENT_RUNTIME_LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const satisfies readonly AdaptiveAgentLogLevel[];
export const MODEL_PROVIDERS: ModelAdapterConfig['provider'][] = ['openrouter', 'ollama', 'mistral', 'mesh'];
export const GATEWAY_STORE_KINDS = ['memory', 'file', 'postgres'] as const;
export const RESEARCH_POLICIES = ['none', 'light', 'standard', 'deep'] as const;
export const TOOL_BUDGET_EXHAUSTED_ACTIONS = ['fail', 'continue_with_warning', 'ask_model'] as const;

export type InvocationMode = (typeof INVOCATION_MODES)[number];
export type HookFailurePolicy = (typeof HOOK_FAILURE_POLICIES)[number];
export type GatewayHookSlot = (typeof GATEWAY_HOOK_SLOTS)[number];
export type GatewayRequestLoggingDestination = (typeof REQUEST_LOG_DESTINATIONS)[number];
export type GatewayRequestLogLevel = (typeof REQUEST_LOG_LEVELS)[number];

export interface LoadedConfig<TConfig> {
  path: string;
  config: TConfig;
}

export interface GatewayServerConfig {
  host: string;
  port: number;
  websocketPath: string;
  healthPath?: string;
  requestLogging?: boolean | GatewayRequestLogLevel;
  requestLoggingDestination?: GatewayRequestLoggingDestination;
}

export interface GatewayAuthConfig {
  provider: string;
  settings: JsonObject;
}

export type GatewayStoreConfig =
  | { kind: 'memory' }
  | { kind: 'file'; baseDir: string }
  | {
      kind: 'postgres';
      urlEnv?: string;
      connectionString?: string;
      ssl?: boolean;
      autoMigrate?: boolean;
    };

export interface GatewayCronConfig {
  enabled: boolean;
  schedulerLeaseMs: number;
  maxConcurrentJobs: number;
  fileSync?: GatewayCronFileSyncConfig;
}

export interface GatewayCronFileSyncConfig {
  enabled: boolean;
  dir?: string;
  intervalMs: number;
}

export interface GatewayTranscriptConfig {
  recentMessageWindow: number;
  summaryTriggerWindow: number;
  summaryMaxMessages: number;
  summaryLineMaxLength: number;
}

export interface GatewayChannelDefaults {
  sessionConcurrency: number;
}

export interface GatewayChannelConfig {
  id: string;
  name: string;
  isPublic?: boolean;
  allowedInvocationModes?: InvocationMode[];
  metadata?: JsonObject;
}

export interface GatewayBindingMatch {
  channelId?: string;
  tenantId?: string;
  roles?: string[];
}

export interface GatewayBinding {
  match: GatewayBindingMatch;
  agentId: string;
}

export interface GatewayHooksConfig {
  failurePolicy: HookFailurePolicy;
  modules: string[];
  onAuthenticate: string[];
  onSessionResolve: string[];
  beforeRoute: string[];
  beforeInboundMessage: string[];
  beforeRunStart: string[];
  afterRunResult: string[];
  onAgentEvent: string[];
  beforeOutboundFrame: string[];
  onDisconnect: string[];
  onError: string[];
}

export interface GatewayConfig {
  server: GatewayServerConfig;
  stores?: GatewayStoreConfig;
  agentRuntimeLogging?: GatewayAgentRuntimeLoggingConfig;
  auth?: GatewayAuthConfig;
  cron?: GatewayCronConfig;
  transcript?: GatewayTranscriptConfig;
  channels?: {
    defaults: GatewayChannelDefaults;
    list: GatewayChannelConfig[];
  };
  bindings: GatewayBinding[];
  defaultAgentId?: string;
  hooks: GatewayHooksConfig;
}

export interface GatewayAgentRuntimeLoggingConfig {
  enabled: boolean;
  level?: AdaptiveAgentLogLevel;
  destination?: AdaptiveAgentLogDestination;
  filePath?: string;
}

export interface AgentRoutingConfig {
  allowedChannels?: string[];
  allowedTenants?: string[];
  requiredRoles?: string[];
}

export interface AgentConfig {
  id: string;
  name: string;
  invocationModes: InvocationMode[];
  defaultInvocationMode: InvocationMode;
  model: ModelAdapterConfig;
  systemInstructions?: string;
  tools: string[];
  delegates: string[];
  defaults?: Partial<AgentDefaults>;
  routing?: AgentRoutingConfig;
  metadata?: JsonObject;
}

export interface LoadGatewayConfigOptions {
  cwd?: string;
  configPath?: string;
}

export interface LoadAgentConfigOptions {
  cwd?: string;
  configPath: string;
}

export interface LoadAgentConfigsOptions {
  cwd?: string;
  dir?: string;
}
