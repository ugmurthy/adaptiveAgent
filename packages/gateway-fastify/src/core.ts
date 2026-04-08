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
  agent: unknown;
  runtime: {
    runStore: unknown;
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
