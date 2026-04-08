// @ts-expect-error The built core bundle is used as a runtime dependency, but it does not ship declarations yet.
import * as coreRuntime from '../../core/dist/index.js';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type JsonSchema = Record<string, unknown>;
export type CaptureMode = 'full' | 'summary' | 'none';

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

export const createAdaptiveAgent = coreRuntime.createAdaptiveAgent as (
  options: CreateAdaptiveAgentOptions,
) => CreatedAdaptiveAgent;
