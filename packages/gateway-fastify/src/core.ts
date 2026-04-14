export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type JsonSchema = Record<string, unknown>;
export type CaptureMode = 'full' | 'summary' | 'none';

interface CoreRuntimeModule {
  createAdaptiveAgent(options: CreateAdaptiveAgentOptions): unknown;
  createAdaptiveAgentLogger(options?: AdaptiveAgentLoggerOptions): AdaptiveAgentLogger;
  createReadFileTool(config?: { allowedRoot?: string; maxSizeBytes?: number }): ToolDefinition;
  createListDirectoryTool(config?: { allowedRoot?: string }): ToolDefinition;
  createWriteFileTool(config?: { allowedRoot?: string; createDirectories?: boolean }): ToolDefinition;
  createShellExecTool(config?: { cwd?: string; maxOutputBytes?: number; shell?: string }): ToolDefinition;
  createWebSearchTool(config: {
    provider?: 'brave' | 'duckduckgo';
    apiKey?: string;
    maxResults?: number;
    baseUrl?: string;
    timeoutMs?: number;
  }): ToolDefinition;
  createReadWebPageTool(config?: { maxSizeBytes?: number; maxTextLength?: number; timeoutMs?: number }): ToolDefinition;
  loadSkillFromDirectory(skillDir: string): Promise<LoadedSkillDefinition>;
  skillToDelegate(skill: LoadedSkillDefinition): DelegateDefinition;
}

let coreRuntimePromise: Promise<CoreRuntimeModule> | undefined;

export interface AgentDefaults {
  maxSteps?: number;
  toolTimeoutMs?: number;
  modelTimeoutMs?: number;
  maxRetriesPerStep?: number;
  requireApprovalForWriteTools?: boolean;
  autoApproveAll?: boolean;
  capture?: CaptureMode;
}

export interface ModelAdapterConfig {
  provider: 'openrouter' | 'ollama' | 'mistral' | 'mesh';
  model: string;
  apiKey?: string;
  baseUrl?: string;
  siteUrl?: string;
  siteName?: string;
}

export interface UsageSummary {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  totalTokens?: number;
  estimatedCostUSD: number;
  provider?: string;
  model?: string;
}

export type RunFailureCode =
  | 'MAX_STEPS'
  | 'TOOL_ERROR'
  | 'MODEL_ERROR'
  | 'APPROVAL_REJECTED'
  | 'REPLAN_REQUIRED'
  | 'INTERRUPTED';

export type FailureKind =
  | 'timeout'
  | 'network'
  | 'rate_limit'
  | 'provider_error'
  | 'not_found'
  | 'tool_error'
  | 'approval_rejected'
  | 'max_steps'
  | 'unknown';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  context?: JsonObject;
  outputSchema?: JsonSchema;
  metadata?: JsonObject;
}

export type RunResult<TOutput extends JsonValue = JsonValue> =
  | {
      status: 'success';
      runId: string;
      planId?: string;
      output: TOutput;
      stepsUsed: number;
      usage: UsageSummary;
    }
  | {
      status: 'failure';
      runId: string;
      error: string;
      code: RunFailureCode;
      stepsUsed: number;
      usage: UsageSummary;
    }
  | {
      status: 'clarification_requested';
      runId: string;
      message: string;
      suggestedQuestions?: string[];
    }
  | {
      status: 'approval_requested';
      runId: string;
      message: string;
      toolName: string;
    };

export type ChatResult<TOutput extends JsonValue = JsonValue> = RunResult<TOutput>;

export interface RuntimeRunRecord {
  id: string;
  rootRunId: string;
  parentRunId?: string;
  status: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  errorMessage?: string;
  result?: JsonValue;
  metadata?: JsonObject;
}

export interface RuntimeRunStore {
  getRun(runId: string): Promise<RuntimeRunRecord | null>;
}

export interface RuntimeAgentEvent {
  id: string;
  runId: string;
  seq: number;
  type: string;
  stepId?: string;
  payload: JsonValue;
  createdAt: string;
}

export interface RuntimeEventStore {
  subscribe?(listener: (event: RuntimeAgentEvent) => void): () => void;
}

export interface AdaptiveAgentHandle {
  chat(request: ChatRequest): Promise<ChatResult>;
  run?(request: {
    goal: string;
    input?: JsonValue;
    context?: JsonObject;
    metadata?: JsonObject;
  }): Promise<RunResult>;
  resolveApproval?(runId: string, approved: boolean): Promise<void>;
  resolveClarification?(runId: string, message: string): Promise<RunResult>;
  resume?(runId: string): Promise<RunResult>;
  retry?(runId: string): Promise<RunResult>;
}

export interface ToolContext {
  [key: string]: unknown;
}

export interface ToolRedactionPolicy {
  inputPaths?: string[];
  outputPaths?: string[];
}

export interface ToolDefinition<I extends JsonValue = JsonValue, O extends JsonValue = JsonValue> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  timeoutMs?: number;
  requiresApproval?: boolean;
  capture?: CaptureMode;
  retryPolicy?: {
    retryable: boolean;
    retryOn?: FailureKind[];
  };
  redact?: ToolRedactionPolicy;
  summarizeResult?: (output: O) => JsonValue;
  recoverError?: (error: unknown, input: I) => O | undefined;
  execute(input: I, context: ToolContext): Promise<O>;
}

export interface DelegateDefinition {
  name: string;
  description: string;
  instructions?: string;
  allowedTools: string[];
  defaults?: Partial<AgentDefaults>;
  handlerTools?: ToolDefinition[];
}

export interface CreatedAdaptiveAgent {
  agent: AdaptiveAgentHandle;
  runtime: {
    runStore: RuntimeRunStore;
    eventStore: RuntimeEventStore | unknown;
    snapshotStore: unknown;
    planStore: unknown;
  };
}

export interface CreateAdaptiveAgentOptions {
  model: ModelAdapterConfig;
  tools: ToolDefinition[];
  delegates?: DelegateDefinition[];
  defaults?: Partial<AgentDefaults>;
  systemInstructions?: string;
  logger?: AdaptiveAgentLogger;
}

export type AdaptiveAgentLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';
export type AdaptiveAgentLogDestination = 'console' | 'file' | 'both';

export interface AdaptiveAgentLogger {
  child(bindings: Record<string, unknown>): AdaptiveAgentLogger;
  flush?(): void;
}

export interface AdaptiveAgentLoggerOptions {
  level?: AdaptiveAgentLogLevel;
  destination?: AdaptiveAgentLogDestination;
  filePath?: string;
  name?: string;
  pretty?: boolean;
}

export interface LoadedSkillDefinition {
  name: string;
  description: string;
  instructions: string;
  allowedTools: string[];
  defaults?: Partial<AgentDefaults>;
  handler?: string;
  handlerTools?: ToolDefinition[];
}

export interface CreateBuiltinToolsOptions {
  rootDir?: string;
  webSearchProvider?: 'brave' | 'duckduckgo';
  braveSearchApiKey?: string;
  webToolTimeoutMs?: number;
}

export interface LoadedSkillDelegate {
  name: string;
  allowedTools: string[];
  delegate: DelegateDefinition;
}

export async function createAdaptiveAgent(options: CreateAdaptiveAgentOptions): Promise<CreatedAdaptiveAgent> {
  const coreRuntime = await loadCoreRuntime();
  return coreRuntime.createAdaptiveAgent(options) as CreatedAdaptiveAgent;
}

export async function createAdaptiveAgentLogger(
  options: AdaptiveAgentLoggerOptions = {},
): Promise<AdaptiveAgentLogger> {
  const coreRuntime = await loadCoreRuntime();
  return coreRuntime.createAdaptiveAgentLogger(options);
}

export async function createBuiltinTools(options: CreateBuiltinToolsOptions = {}): Promise<ToolDefinition[]> {
  const coreRuntime = await loadCoreRuntime();
  const rootDir = options.rootDir ?? process.cwd();
  const preferredWebSearchProvider = options.webSearchProvider ?? 'duckduckgo';
  const webSearchProvider =
    preferredWebSearchProvider === 'brave' && !options.braveSearchApiKey ? 'duckduckgo' : preferredWebSearchProvider;

  return [
    coreRuntime.createReadFileTool({ allowedRoot: rootDir }),
    coreRuntime.createListDirectoryTool({ allowedRoot: rootDir }),
    coreRuntime.createWriteFileTool({ allowedRoot: rootDir }),
    coreRuntime.createShellExecTool({ cwd: rootDir }),
    webSearchProvider === 'brave'
      ? coreRuntime.createWebSearchTool({
          provider: 'brave',
          apiKey: options.braveSearchApiKey,
          timeoutMs: options.webToolTimeoutMs,
        })
      : coreRuntime.createWebSearchTool({
          provider: 'duckduckgo',
          timeoutMs: options.webToolTimeoutMs,
        }),
    coreRuntime.createReadWebPageTool({ timeoutMs: options.webToolTimeoutMs }),
  ];
}

export async function loadSkillDelegateFromDirectory(skillDir: string): Promise<LoadedSkillDelegate> {
  const coreRuntime = await loadCoreRuntime();
  const skill = await coreRuntime.loadSkillFromDirectory(skillDir);

  return {
    name: skill.name,
    allowedTools: [...skill.allowedTools],
    delegate: coreRuntime.skillToDelegate(skill),
  };
}

function loadCoreRuntime(): Promise<CoreRuntimeModule> {
  // @ts-expect-error The built core bundle is a runtime-only dependency without emitted declarations.
  coreRuntimePromise ??= import('../../core/dist/index.js') as Promise<CoreRuntimeModule>;
  return coreRuntimePromise;
}
