import type { Logger } from 'pino';

export type UUID = string;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type JsonSchema = Record<string, unknown>;

export type CaptureMode = 'full' | 'summary' | 'none';

export type RunStatus =
  | 'queued'
  | 'planning'
  | 'awaiting_approval'
  | 'awaiting_subagent'
  | 'running'
  | 'interrupted'
  | 'succeeded'
  | 'failed'
  | 'clarification_requested'
  | 'replan_required'
  | 'cancelled';

export type PlanStatus = 'draft' | 'approved' | 'archived';

export type PlanExecutionStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'succeeded'
  | 'failed'
  | 'replan_required'
  | 'cancelled';

export type FailurePolicy = 'stop' | 'skip' | 'replan';

export type EventType =
  | 'run.created'
  | 'run.status_changed'
  | 'run.interrupted'
  | 'run.resumed'
  | 'run.completed'
  | 'run.failed'
  | 'plan.created'
  | 'plan.execution_started'
  | 'step.started'
  | 'step.completed'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.failed'
  | 'delegate.spawned'
  | 'approval.requested'
  | 'approval.resolved'
  | 'clarification.requested'
  | 'usage.updated'
  | 'snapshot.created'
  | 'replan.required';

export interface UsageSummary {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  totalTokens?: number;
  estimatedCostUSD: number;
  provider?: string;
  model?: string;
}

export interface ModelCapabilities {
  toolCalling: boolean;
  jsonOutput: boolean;
  streaming: boolean;
  usage: boolean;
}

export interface AgentDefaults {
  maxSteps?: number;
  toolTimeoutMs?: number;
  modelTimeoutMs?: number;
  maxRetriesPerStep?: number;
  requireApprovalForWriteTools?: boolean;
  /** When true, tools with `requiresApproval` are executed without pausing for approval. */
  autoApproveAll?: boolean;
  capture?: CaptureMode;
}

export interface DelegationPolicy {
  maxDepth?: number;
  maxChildrenPerRun?: number;
  allowRecursiveDelegation?: boolean;
  childRunsMayRequestApproval?: boolean;
  childRunsMayRequestClarification?: boolean;
}

export interface RunRequest {
  goal: string;
  input?: JsonValue;
  context?: Record<string, JsonValue>;
  allowedTools?: string[];
  forbiddenTools?: string[];
  outputSchema?: JsonSchema;
  metadata?: Record<string, JsonValue>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  context?: Record<string, JsonValue>;
  outputSchema?: JsonSchema;
  metadata?: Record<string, JsonValue>;
}

export interface PlanRequest {
  goal: string;
  input?: JsonValue;
  context?: Record<string, JsonValue>;
  allowedTools?: string[];
  forbiddenTools?: string[];
  inputSchema?: JsonSchema;
  successCriteria?: JsonValue;
  metadata?: Record<string, JsonValue>;
}

export interface ExecutePlanRequest {
  planId: UUID;
  input?: JsonValue;
  context?: Record<string, JsonValue>;
  metadata?: Record<string, JsonValue>;
}

export interface ToolRedactionPolicy {
  inputPaths?: string[];
  outputPaths?: string[];
}

export interface DelegateDefinition {
  name: string;
  description: string;
  instructions?: string;
  allowedTools: string[];
  model?: ModelAdapter;
  defaults?: Partial<AgentDefaults>;
  /** Extra tools injected into the child run (e.g. from executable skill handlers). */
  handlerTools?: ToolDefinition[];
}

export interface DelegateToolInput {
  goal: string;
  input?: JsonValue;
  context?: Record<string, JsonValue>;
  outputSchema?: JsonSchema;
  metadata?: Record<string, JsonValue>;
}

export interface DelegateSpawnedPayload {
  toolName: string;
  delegateName: string;
  childRunId: UUID;
  parentRunId: UUID;
  parentStepId: string;
  rootRunId: UUID;
  delegationDepth: number;
}

export interface AdaptiveAgentOptions {
  model: ModelAdapter;
  tools: ToolDefinition[];
  delegates?: DelegateDefinition[];
  delegation?: DelegationPolicy;
  runStore: RunStore;
  eventStore?: EventStore;
  snapshotStore?: SnapshotStore;
  planStore?: PlanStore;
  eventSink?: EventSink;
  /** Optional structured runtime logger. Pino is the intended implementation. */
  logger?: Logger;
  defaults?: AgentDefaults;
  /** Optional system instructions injected into the system prompt. Used by delegate/skill child runs. */
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
  summarizeResult?: (output: O) => JsonValue;
  recoverError?: (error: unknown, input: I) => O | undefined;
  execute(input: I, context: ToolContext): Promise<O>;
}

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ModelToolCall[];
}

export interface ModelToolCall {
  id: string;
  name: string;
  input: JsonValue;
}

export interface ModelRequest {
  messages: ModelMessage[];
  tools?: Array<Pick<ToolDefinition, 'name' | 'description' | 'inputSchema'>>;
  outputSchema?: JsonSchema;
  signal?: AbortSignal;
  metadata?: Record<string, JsonValue>;
}

export interface ModelResponse {
  text?: string;
  structuredOutput?: JsonValue;
  toolCalls?: ModelToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error';
  usage?: UsageSummary;
  providerResponseId?: string;
  summary?: string;
}

export interface ModelStreamEvent {
  type: 'status' | 'summary' | 'usage';
  payload: JsonValue;
}

export interface ModelAdapter {
  provider: string;
  model: string;
  capabilities: ModelCapabilities;
  generate(request: ModelRequest): Promise<ModelResponse>;
  stream?(
    request: ModelRequest,
    onEvent: (event: ModelStreamEvent) => Promise<void> | void,
  ): Promise<ModelResponse>;
}

export type TemplateValue =
  | JsonValue
  | { $ref: `$input.${string}` }
  | { $ref: `$context.${string}` }
  | { $ref: `$steps.${string}` }
  | { $ref: `$steps.${string}.${string}` };

export interface PlanCondition {
  kind: 'exists' | 'equals' | 'not_equals';
  left: TemplateValue;
  right?: TemplateValue;
}

export interface PlanStep {
  id: string;
  title: string;
  toolName: string;
  inputTemplate: TemplateValue | { [key: string]: TemplateValue };
  outputKey?: string;
  preconditions?: PlanCondition[];
  onFailure: FailurePolicy;
  requiresApproval?: boolean;
}

export interface PlanArtifact {
  id: UUID;
  version: number;
  status: PlanStatus;
  goal: string;
  summary: string;
  inputSchema?: JsonSchema;
  successCriteria?: JsonValue;
  toolsetHash: string;
  plannerModel?: string;
  plannerPromptVersion?: string;
  createdFromRunId?: UUID;
  parentPlanId?: UUID;
  metadata?: Record<string, JsonValue>;
  steps: PlanStep[];
  createdAt: string;
  archivedAt?: string;
}

export interface AgentRun {
  id: UUID;
  rootRunId: UUID;
  parentRunId?: UUID;
  parentStepId?: string;
  delegateName?: string;
  delegationDepth: number;
  currentChildRunId?: UUID;
  goal: string;
  input?: JsonValue;
  context?: Record<string, JsonValue>;
  status: RunStatus;
  currentStepId?: string;
  currentPlanId?: UUID;
  currentPlanExecutionId?: UUID;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  heartbeatAt?: string;
  version: number;
  usage: UsageSummary;
  result?: JsonValue;
  errorCode?: string;
  errorMessage?: string;
  metadata?: Record<string, JsonValue>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface PlanExecution {
  id: UUID;
  planId: UUID;
  runId: UUID;
  attempt: number;
  status: PlanExecutionStatus;
  input?: JsonValue;
  context?: Record<string, JsonValue>;
  currentStepId?: string;
  currentStepIndex?: number;
  output?: JsonValue;
  replanReason?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface AgentEvent {
  id: string;
  runId: UUID;
  planExecutionId?: UUID;
  seq: number;
  type: EventType;
  stepId?: string;
  schemaVersion: number;
  payload: JsonValue;
  createdAt: string;
}

export interface RunSnapshot {
  id: UUID;
  runId: UUID;
  snapshotSeq: number;
  status: RunStatus;
  currentStepId?: string;
  currentPlanId?: UUID;
  currentPlanExecutionId?: UUID;
  summary: JsonValue;
  state: JsonValue;
  createdAt: string;
}

export interface EventSink {
  emit(event: Omit<AgentEvent, 'id' | 'seq' | 'createdAt'>): Promise<void> | void;
}

export interface RunStore {
  createRun(run: {
    id?: UUID;
    rootRunId?: UUID;
    parentRunId?: UUID;
    parentStepId?: string;
    delegateName?: string;
    delegationDepth?: number;
    currentChildRunId?: UUID;
    goal: string;
    input?: JsonValue;
    context?: Record<string, JsonValue>;
    metadata?: Record<string, JsonValue>;
    status: RunStatus;
  }): Promise<AgentRun>;

  getRun(runId: UUID): Promise<AgentRun | null>;

  updateRun(runId: UUID, patch: Partial<AgentRun>, expectedVersion?: number): Promise<AgentRun>;

  tryAcquireLease(params: {
    runId: UUID;
    owner: string;
    ttlMs: number;
    now: Date;
  }): Promise<boolean>;

  heartbeatLease(params: {
    runId: UUID;
    owner: string;
    ttlMs: number;
    now: Date;
  }): Promise<void>;

  releaseLease(runId: UUID, owner: string): Promise<void>;
}

export interface EventStore {
  append(event: Omit<AgentEvent, 'id' | 'seq' | 'createdAt'>): Promise<AgentEvent>;
  listByRun(runId: UUID, afterSeq?: number): Promise<AgentEvent[]>;
  /** Optional live subscription hook for persisted events. Returns an unsubscribe function. */
  subscribe?(listener: (event: AgentEvent) => void): () => void;
}

export interface SnapshotStore {
  save(snapshot: Omit<RunSnapshot, 'id' | 'createdAt'>): Promise<RunSnapshot>;
  getLatest(runId: UUID): Promise<RunSnapshot | null>;
}

export interface PlanStore {
  createPlan(plan: Omit<PlanArtifact, 'createdAt' | 'archivedAt'>): Promise<PlanArtifact>;
  getPlan(planId: UUID): Promise<PlanArtifact | null>;
  listSteps(planId: UUID): Promise<PlanStep[]>;

  createExecution(execution: Omit<PlanExecution, 'createdAt' | 'updatedAt'>): Promise<PlanExecution>;
  getExecution(executionId: UUID): Promise<PlanExecution | null>;
  updateExecution(executionId: UUID, patch: Partial<PlanExecution>): Promise<PlanExecution>;
}

export type RunFailureCode =
  | 'MAX_STEPS'
  | 'TOOL_ERROR'
  | 'MODEL_ERROR'
  | 'APPROVAL_REJECTED'
  | 'REPLAN_REQUIRED'
  | 'INTERRUPTED';

export type RunResult<T extends JsonValue = JsonValue> =
  | {
      status: 'success';
      runId: UUID;
      planId?: UUID;
      output: T;
      stepsUsed: number;
      usage: UsageSummary;
    }
  | {
      status: 'failure';
      runId: UUID;
      error: string;
      code: RunFailureCode;
      stepsUsed: number;
      usage: UsageSummary;
    }
  | {
      status: 'clarification_requested';
      runId: UUID;
      message: string;
      suggestedQuestions?: string[];
    }
  | {
      status: 'approval_requested';
      runId: UUID;
      message: string;
      toolName: string;
    };

export type ChatResult<T extends JsonValue = JsonValue> = RunResult<T>;
