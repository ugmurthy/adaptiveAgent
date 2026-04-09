export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type JsonSchema = Record<string, unknown>;
export type CaptureMode = 'full' | 'summary' | 'none';

interface CoreRuntimeModule {
  createAdaptiveAgent(options: CreateAdaptiveAgentOptions): unknown;
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
  errorMessage?: string;
  result?: JsonValue;
}

export interface RuntimeRunStore {
  getRun(runId: string): Promise<RuntimeRunRecord | null>;
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
  resume?(runId: string): Promise<RunResult>;
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
    eventStore: unknown;
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
}

export async function createAdaptiveAgent(options: CreateAdaptiveAgentOptions): Promise<CreatedAdaptiveAgent> {
  const coreRuntime = await loadCoreRuntime();
  return coreRuntime.createAdaptiveAgent(options) as CreatedAdaptiveAgent;
}

function loadCoreRuntime(): Promise<CoreRuntimeModule> {
  // @ts-expect-error The built core bundle is a runtime-only dependency without emitted declarations.
  coreRuntimePromise ??= import('../../core/dist/index.js') as Promise<CoreRuntimeModule>;
  return coreRuntimePromise;
}
