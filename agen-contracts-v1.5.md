# AdaptiveAgent v1.5 Contracts And Postgres Schema

This document supersedes `agen-contracts-v1.4.md` for the currently implemented runtime surface.

Unless explicitly replaced here, the v1.4 contract and schema guidance still applies.

## 1. Updated TypeScript Contracts

```ts
export interface ModelCapabilities {
  toolCalling: boolean;
  jsonOutput: boolean;
  streaming: boolean;
  usage: boolean;
  imageInput?: boolean;
}

export type ImageDetail = 'auto' | 'low' | 'high';

export interface ImageInput {
  path: string;
  mimeType?: string;
  detail?: ImageDetail;
  name?: string;
}

export interface ModelTextContentPart {
  type: 'text';
  text: string;
}

export interface ModelImageContentPart {
  type: 'image';
  image: ImageInput;
}

export type ModelContentPart = ModelTextContentPart | ModelImageContentPart;
export type ModelMessageContent = string | ModelContentPart[];

export interface RunRequest {
  goal: string;
  input?: JsonValue;
  images?: ImageInput[];
  context?: Record<string, JsonValue>;
  allowedTools?: string[];
  forbiddenTools?: string[];
  outputSchema?: JsonSchema;
  metadata?: Record<string, JsonValue>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  images?: ImageInput[];
}

export interface DelegateToolInput {
  goal: string;
  input?: JsonValue;
  images?: ImageInput[];
  context?: Record<string, JsonValue>;
  outputSchema?: JsonSchema;
  metadata?: Record<string, JsonValue>;
}

export interface AgentDefaults {
  maxSteps?: number;
  toolTimeoutMs?: number;
  modelTimeoutMs?: number;
  maxRetriesPerStep?: number;
  requireApprovalForWriteTools?: boolean;
  autoApproveAll?: boolean;
  capture?: CaptureMode;
  toolBudgets?: Record<string, ToolBudget>;
  researchPolicy?: ResearchPolicyName | ResearchPolicy;
  injectToolManifest?: boolean;
}

export interface DelegateDefinition {
  name: string;
  description: string;
  instructions?: string;
  allowedTools: string[];
  model?: ModelAdapter;
  defaults?: Partial<AgentDefaults>;
  handlerTools?: ToolDefinition[];
}

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

export interface ToolRetryPolicy {
  retryable: boolean;
  retryOn?: FailureKind[];
}

export interface AdaptiveAgentOptions {
  model: ModelAdapter;
  tools: ToolDefinition[];
  delegates?: DelegateDefinition[];
  delegation?: DelegationPolicy;
  recovery?: RecoveryPolicy;
  runStore: RunStore;
  eventStore?: EventStore;
  snapshotStore?: SnapshotStore;
  planStore?: PlanStore;
  continuationStore?: ContinuationStore;
  toolExecutionStore?: ToolExecutionStore;
  transactionStore?: RuntimeTransactionStore;
  eventSink?: EventSink;
  logger?: Logger;
  defaults?: AgentDefaults;
  systemInstructions?: string;
}

export interface ToolContext {
  runId: UUID;
  rootRunId: UUID;
  parentRunId?: UUID;
  parentStepId?: string;
  delegateName?: string;
  delegationDepth: number;
  stepId: string;
  toolCallId: string;
  planId?: UUID;
  planExecutionId?: UUID;
  input?: JsonValue;
  context?: Record<string, JsonValue>;
  idempotencyKey: string;
  signal: AbortSignal;
  emit: (event: Omit<AgentEvent, 'id' | 'seq' | 'createdAt'>) => Promise<void>;
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
  retryPolicy?: ToolRetryPolicy;
  budgetGroup?: string;
  summarizeResult?: (output: O) => JsonValue;
  recoverError?: (error: unknown, input: I) => O | undefined;
  execute(input: I, context: ToolContext): Promise<O>;
}

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: ModelMessageContent;
  name?: string;
  toolCallId?: string;
  toolCalls?: ModelToolCall[];
  reasoning?: string;
  reasoningDetails?: JsonValue[];
}

export interface ModelRetryEvent {
  attempt: number;
  nextAttempt: number;
  statusCode: number;
  retryDelayMs: number;
  reason: 'rate_limit' | 'provider_error';
  phase: 'http_status';
  message: string;
}

export interface ModelRequest {
  messages: ModelMessage[];
  tools?: Array<Pick<ToolDefinition, 'name' | 'description' | 'inputSchema'>>;
  outputSchema?: JsonSchema;
  signal?: AbortSignal;
  metadata?: Record<string, JsonValue>;
  onRetry?: (event: ModelRetryEvent) => Promise<void> | void;
}

export interface ModelResponse {
  text?: string;
  structuredOutput?: JsonValue;
  toolCalls?: ModelToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error';
  usage?: UsageSummary;
  providerResponseId?: string;
  summary?: string;
  reasoning?: string;
  reasoningDetails?: JsonValue[];
}

export interface ModelAdapter {
  provider: string;
  model: string;
  capabilities: ModelCapabilities;
  formatToolName?(name: string): string;
  generate(request: ModelRequest): Promise<ModelResponse>;
  stream?(
    request: ModelRequest,
    onEvent: (event: ModelStreamEvent) => Promise<void> | void,
  ): Promise<ModelResponse>;
}
```

## 2. Provider Adapter Clarifications

Provider adapters own request and response normalization between internal contracts and provider SDK types.

This is especially important for:

- `toolCalls` vs `tool_calls`
- `toolCallId` vs `tool_call_id`
- `reasoningDetails` vs `reasoning_details`
- image content parts such as `imageUrl` vs `image_url`
- `responseFormat` vs `response_format`

Adapters must preserve current runtime semantics for:

- tool calling
- structured output
- usage accounting
- abort propagation
- retry observability
- resumability

## 3. Modality Boundary

v1.5 standardizes only:

- plain text message content
- structured `text` content parts
- structured `image` content parts

Provider-neutral `file`, `audio`, and `video` inputs remain out of scope for this version.
