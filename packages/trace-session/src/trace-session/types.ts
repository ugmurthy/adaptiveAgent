export type EventType =
  | 'run.created'
  | 'run.status_changed'
  | 'run.interrupted'
  | 'run.steered'
  | 'run.resumed'
  | 'run.retry_started'
  | 'run.completed'
  | 'run.failed'
  | 'recovery.analyzed'
  | 'run.continuation_created'
  | 'context.refs.resolved'
  | 'plan.created'
  | 'plan.execution_started'
  | 'step.started'
  | 'step.completed'
  | 'model.started'
  | 'model.retry'
  | 'model.tool_call_rejected'
  | 'model.completed'
  | 'model.failed'
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

export type ReportView =
  | 'brief'
  | 'summary'
  | 'reliability'
  | 'operations'
  | 'overview'
  | 'output'
  | 'investigate'
  | 'policy'
  | 'performance'
  | 'milestones'
  | 'timeline'
  | 'delegates'
  | 'messages'
  | 'plans'
  | 'all';
export type MessageView = 'compact' | 'delta' | 'full';

export interface CliOptions {
  compareRunIds?: [string, string];
  sessionId?: string;
  rootRunId?: string;
  runId?: string;
  json: boolean;
  listSessions: boolean;
  listPerformance: boolean;
  listSessionless: boolean;
  deleteEmptyGoalSessions: boolean;
  usageOnly: boolean;
  includePlans: boolean;
  onlyDelegates: boolean;
  messages: boolean;
  reasoning?: boolean;
  systemOnly: boolean;
  view?: ReportView;
  messagesView?: MessageView;
  focusRunId?: string;
  previewChars?: number;
  goals?: string[];
  goalRegex?: RegExp;
  hasGoal?: boolean;
  noGoal?: boolean;
  statuses?: string[];
  limit?: number;
  types?: TraceListType[];
  swarmRole?: SwarmRole;
  groupBy?: TraceAggregateGroupBy;
  since?: string;
  until?: string;
  htmlPath?: string;
  configPath?: string;
  databaseUrl?: string;
  databaseUrlEnv?: string;
  pgssl?: boolean;
  fresh?: boolean;
  noCache?: boolean;
  cacheTtl?: number;
  help: boolean;
}

export type TraceListType = 'run' | 'chat' | 'swarm' | 'swarm-run';
export type SwarmRole = 'coordinator' | 'worker' | 'quality' | 'synthesizer';

export interface SessionOverview {
  sessionId: string;
  channelId: string | null;
  agentId: string | null;
  invocationMode: string | null;
  status: string;
  currentRunId: string | null;
  currentRootRunId: string | null;
  lastCompletedRootRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RootRun {
  rootRunId: string;
  runId: string;
  invocationKind: string;
  turnIndex: number | null;
  linkedAt: string;
  startedAt?: string | null;
  updatedAt?: string | null;
  completedAt?: string | null;
  status: string | null;
  goal: string | null;
  result: unknown;
  errorCode?: string | null;
  errorMessage?: string | null;
  modelProvider?: string | null;
  modelName?: string | null;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  heartbeatAt?: string | null;
}

export interface UsageSummary {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
  estimatedCostUSD: number;
}

export interface ProviderModelUsageSummary {
  provider: string;
  model: string;
  usage: UsageSummary;
  runCount?: number;
  toolCallCount?: number;
}

export interface SessionUsageSummary {
  total: UsageSummary;
  byRootRun: Array<{
    rootRunId: string;
    usage: UsageSummary;
  }>;
  byProviderModel?: ProviderModelUsageSummary[];
  toolOutputByProviderModel?: ProviderModelUsageSummary[];
  toolAccounting?: ToolAccountingSummary;
}

export interface SessionListItem {
  sessionId: string | null;
  startedAt: string;
  status?: string;
  goals: Array<{
    rootRunId: string;
    runId: string;
    status: string | null;
    startedAt: string | null;
    completedAt: string | null;
    goal: string | null;
    linkedAt: string;
    type?: TraceListType;
    swarmRole?: SwarmRole;
  }>;
}

export interface SessionlessRunListItem {
  sessionId?: string | null;
  rootRunId: string;
  startedAt: string;
  completedAt?: string | null;
  status?: string | null;
  goal: string | null;
  type?: TraceListType;
  swarmRole?: SwarmRole;
}

export interface SessionPerformanceListItem {
  sessionId: string | null;
  sessionStatus?: string;
  rootRunId: string;
  runId: string;
  runStatus: string | null;
  startedAt: string | null;
  completedAt: string | null;
  totalDurationMs: number | null;
  goal: string | null;
  type?: TraceListType;
  swarmRole?: SwarmRole;
  performance: PerformanceSummary;
}

export interface TraceRow {
  session_id: string;
  root_run_id: string;
  run_id: string;
  parent_run_id: string | null;
  parent_step_id: string | null;
  run_delegate_name: string | null;
  delegation_depth: number | null;
  run_status: string | null;
  current_step_id: string | null;
  current_child_run_id: string | null;
  goal: unknown;
  run_error_code: string | null;
  run_error_message: string | null;
  run_created_at: string | null;
  run_updated_at: string | null;
  run_completed_at: string | null;
  total_prompt_tokens?: string | number | null;
  total_completion_tokens?: string | number | null;
  total_reasoning_tokens?: string | number | null;
  estimated_cost_usd?: string | number | null;
  model_provider?: string | null;
  model_name?: string | null;
  run_result?: unknown;
  run_lease_owner?: string | null;
  run_lease_expires_at?: string | null;
  run_heartbeat_at?: string | null;
  event_id: string | null;
  event_seq: number | null;
  event_created_at: string | null;
  event_type: string | null;
  event_step_id: string | null;
  tool_call_id: string | null;
  payload: unknown;
  event_tool_name: string | null;
  resolved_input: unknown;
  ledger_tool_name: string | null;
  tool_execution_status: string | null;
  tool_started_at: string | null;
  tool_completed_at: string | null;
  tool_output: unknown;
  tool_error_code: string | null;
  tool_error_message: string | null;
  child_run_id: string | null;
  child_run_status: string | null;
  child_error_code: string | null;
  child_error_message: string | null;
  child_run_result: unknown;
}

export interface TimelineEntry {
  rootRunId: string;
  runId: string;
  depth: number;
  stepId: string | null;
  toolCallId: string | null;
  eventType: string | null;
  toolName: string | null;
  params: unknown;
  output: unknown;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  outcome: string;
  childRunId: string | null;
  eventSeq: number | null;
  accounting?: unknown;
}

export interface PerformanceBucketSummary {
  count: number;
  total: number;
  max: number;
  average: number;
}

export interface PerformanceSummary {
  events: {
    totalEvents: number;
    measuredEvents: number;
    payloadBytes: PerformanceBucketSummary;
    emitDurationMs: PerformanceBucketSummary;
  };
  model: {
    started: number;
    completed: number;
    failed: number;
    retries: number;
    requestBytes: PerformanceBucketSummary;
    responseBytes: PerformanceBucketSummary;
    durationMs: PerformanceBucketSummary;
    retryDelayMs: PerformanceBucketSummary;
    pendingToolCallCount: PerformanceBucketSummary;
    adapterGateWaitMs: PerformanceBucketSummary;
    adapterResponseLatencyMs: PerformanceBucketSummary;
    adapterRequestBytes: PerformanceBucketSummary;
    adapterResponseBytes: PerformanceBucketSummary;
    adapterAttemptCount: PerformanceBucketSummary;
    adapterRetryDelayMs: PerformanceBucketSummary;
    adapterStatusCodes: Record<string, number>;
  };
  tools: {
    started: number;
    completed: number;
    failed: number;
    inputBytes: PerformanceBucketSummary;
    eventInputBytes: PerformanceBucketSummary;
    rawOutputBytes: PerformanceBucketSummary;
    eventOutputBytes: PerformanceBucketSummary;
    modelOutputBytes: PerformanceBucketSummary;
    durationMs: PerformanceBucketSummary;
    childRunDurationMs: PerformanceBucketSummary;
    byTool: Array<{
      toolName: string;
      started: number;
      completed: number;
      failed: number;
      durationMs: PerformanceBucketSummary;
      rawOutputBytes: PerformanceBucketSummary;
      modelOutputBytes: PerformanceBucketSummary;
    }>;
  };
  snapshots: {
    created: number;
    stateBytes: PerformanceBucketSummary;
    messageBytes: PerformanceBucketSummary;
    messageCount: PerformanceBucketSummary;
    saveDurationMs: PerformanceBucketSummary;
    pendingToolCallBytes: PerformanceBucketSummary;
  };
}

export interface MilestoneEntry {
  rootRunId: string;
  runId: string;
  depth: number;
  eventType: EventType;
  stepId: string | null;
  toolCallId?: string | null;
  createdAt: string | null;
  eventSeq: number | null;
  snapshotSeq?: number | null;
  retryDelayMs?: number | null;
  text: string;
}

export interface RunTreeEntry {
  rootRunId: string;
  runId: string;
  parentRunId: string | null;
  delegateName: string | null;
  depth: number;
  status?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  completedAt?: string | null;
  result?: unknown;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  heartbeatAt?: string | null;
}

export interface RunSnapshotSummary {
  rootRunId: string;
  runId: string;
  delegateName: string | null;
  depth: number;
  latestSnapshotSeq: number | null;
  latestSnapshotCreatedAt: string | null;
  latestStepsUsed: number | null;
}

export interface DelegateRow {
  root_run_id: string;
  parent_run_id: string;
  parent_step_id: string | null;
  parent_status: string;
  child_run_id: string | null;
  snapshot_delegate_name: string | null;
  snapshot_child_run_id: string | null;
  child_delegate_name: string | null;
  child_status: string | null;
  child_parent_run_id: string | null;
  child_parent_step_id: string | null;
  child_heartbeat_at: string | null;
  child_lease_owner: string | null;
  child_lease_expires_at: string | null;
  child_updated_at: string | null;
  child_completed_at: string | null;
  child_error_code: string | null;
  child_error_message: string | null;
  child_result: unknown;
  delegate_reason: string;
  parent_last_event_type: string | null;
  parent_last_event_at: string | null;
  parent_last_event_payload: unknown;
  child_last_event_type: string | null;
  child_last_event_at: string | null;
  child_last_event_payload: unknown;
}

export interface PlanRow {
  root_run_id: string;
  run_id: string;
  plan_execution_id: string | null;
  plan_execution_status: string | null;
  attempt: number | null;
  current_step_id: string | null;
  current_step_index: number | null;
  replan_reason: string | null;
  plan_id: string | null;
  plan_goal: string | null;
  plan_summary: string | null;
  step_index: number | null;
  step_key: string | null;
  title: string | null;
  tool_name: string | null;
  failure_policy: string | null;
  requires_approval: boolean | null;
}

export type TraceMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface TraceToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface TraceMessage {
  position: number;
  persistence: 'persisted' | 'pending';
  role: TraceMessageRole;
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: TraceToolCall[];
  reasoning?: string;
  reasoningDetails?: unknown[];
  category:
    | 'initial-runtime-system'
    | 'gateway-chat-system-context'
    | 'runtime-injected-system'
    | 'runtime-injected-user'
    | 'user'
    | 'assistant'
    | 'tool';
}

export interface RunMessageTrace {
  rootRunId: string;
  runId: string;
  delegateName: string | null;
  depth: number;
  initialSnapshotSeq: number | null;
  initialSnapshotCreatedAt: string | null;
  latestSnapshotSeq: number | null;
  latestSnapshotCreatedAt: string | null;
  initialMessages?: TraceMessage[];
  latestStepsUsed?: number | null;
  effectiveMessages: TraceMessage[];
}

export type TraceFindingSeverity = 'info' | 'warning' | 'error';

export type TraceFindingCategory = 'failure' | 'blocked' | 'policy' | 'performance' | 'data-quality';

export type TraceFindingRole = 'primary-cause' | 'recovery' | 'consequence' | 'context';

export interface EvidenceRef {
  kind: 'run' | 'root-run' | 'event' | 'tool' | 'delegate' | 'message' | 'usage' | 'snapshot';
  label: string;
  rootRunId?: string;
  runId?: string;
  stepId?: string | null;
  toolCallId?: string | null;
  eventSeq?: number | null;
  eventType?: string | null;
  createdAt?: string | null;
  detail?: string;
}

export interface TraceFinding {
  id: string;
  severity: TraceFindingSeverity;
  category: TraceFindingCategory;
  role: TraceFindingRole;
  title: string;
  summary: string;
  evidence: EvidenceRef[];
  commands: SuggestedCommand[];
}

export interface SuggestedCommand {
  reason: string;
  command: string;
}

export interface TraceBrief {
  status: TraceReport['summary']['status'];
  headline: string;
  targetLabel: string;
  rootRunCount: number;
  runCount: number;
  totalSteps: number | null;
  wallDurationMs: number | null;
  cumulativeModelDurationMs: number;
  cumulativeToolDurationMs: number;
  cumulativeSnapshotSaveMs: number;
  cumulativeMeasuredDurationMs: number;
  parallelismFactor: number | null;
  modelCalls: number;
  failedModelCalls: number;
  toolCalls: number;
  failedToolCalls: number;
  totalTokens: number;
  estimatedCostUSD: number;
}

export interface TopRunUsage {
  rootRunId: string;
  runId: string;
  goal: string | null;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
  estimatedCostUSD: number;
}

export interface TopToolSpan {
  rootRunId: string;
  runId: string;
  stepId: string | null;
  toolCallId: string | null;
  toolName: string | null;
  outcome: string;
  durationMs: number;
  childRunId: string | null;
}

export interface TopToolMetric {
  toolName: string;
  started: number;
  completed: number;
  failed: number;
  durationMs: PerformanceBucketSummary;
  rawOutputBytes: PerformanceBucketSummary;
  modelOutputBytes: PerformanceBucketSummary;
}

export interface ToolAccountingSummary {
  totalRequests: number;
  billableRequests: number;
  cachedToolCalls: number;
  unpricedRequests: number;
  estimatedCostUSD: number;
  byProviderOperation: Array<{
    provider: string;
    operation: string;
    toolCalls: number;
    requests: number;
    billableRequests: number;
    cachedToolCalls: number;
    unpricedRequests: number;
    estimatedCostUSD: number;
  }>;
}

export interface PerformanceDigest {
  wallDurationMs: number | null;
  cumulativeModelDurationMs: number;
  cumulativeToolDurationMs: number;
  cumulativeSnapshotSaveMs: number;
  cumulativeMeasuredDurationMs: number;
  otherDurationMs: number | null;
  parallelismFactor: number | null;
  topToolSpans: TopToolSpan[];
  topToolsByDuration: TopToolMetric[];
  topToolsByModelOutput: TopToolMetric[];
  topRunsByUsage: TopRunUsage[];
  toolAccounting: ToolAccountingSummary;
  notes: string[];
}

export interface PolicyBudgetGroupSummary {
  budgetGroup: string;
  skippedCalls: number;
  toolNames: string[];
}

export interface PolicyDigest {
  budgetExhaustedToolCalls: number;
  budgetGroups: PolicyBudgetGroupSummary[];
  rejectedToolCalls: number;
  approvalRequests: number;
  approvalResolved: number;
  unresolvedApprovalRequests: number;
  runtimePolicyMessages: number;
  warnings: string[];
}

export type ReliabilityClassification = 'healthy' | 'recovered' | 'degraded' | 'failed' | 'blocked' | 'unknown';

export type ReliabilityDimensionStatus = ReliabilityClassification;

export interface ReliabilityDimension {
  status: ReliabilityDimensionStatus;
  summary: string;
  evidence: EvidenceRef[];
}

export type DataConfidenceLevel = 'high' | 'medium' | 'low' | 'unknown';

export interface DataConfidence {
  level: DataConfidenceLevel;
  requiredObservabilityAvailable: boolean;
  observedEvents: number;
  measuredPerformanceEvents: number;
  performanceCoverage: number | null;
  runsWithSnapshots: number;
  totalRuns: number;
  snapshotCoverage: number | null;
  pricedToolRequests: number;
  totalToolRequests: number;
  costCoverage: number | null;
  warnings: string[];
}

export interface RecoveryPressure {
  modelRetries: number;
  modelRetryDelayMs: number;
  runRetries: number;
  interruptions: number;
  resumes: number;
  continuations: number;
  replans: number;
  rejectedToolCalls: number;
  excessive: boolean;
}

export interface ReliabilityDiagnostics {
  classification: ReliabilityClassification;
  summary: string;
  dimensions: {
    outcomeIntegrity: ReliabilityDimension;
    lifecycleIntegrity: ReliabilityDimension;
    recoveryPressure: ReliabilityDimension;
    liveness: ReliabilityDimension;
    policyIntegrity: ReliabilityDimension;
    evidenceConfidence: ReliabilityDimension;
  };
  recovery: RecoveryPressure;
  dataConfidence: DataConfidence;
  outputQuality: {
    status: 'not-evaluated';
    summary: string;
  };
}

export interface TraceDiagnostics {
  brief: TraceBrief;
  reliability: ReliabilityDiagnostics;
  findings: TraceFinding[];
  performance: PerformanceDigest;
  policy: PolicyDigest;
  analysis: TraceAnalysis;
  suggestedNextViews: SuggestedCommand[];
}

export type ContextGrowthSource = 'snapshot' | 'model-request' | 'unavailable';

export interface RunAnalysis {
  rootRunId: string;
  runId: string;
  parentRunId: string | null;
  delegateName: string | null;
  depth: number;
  status: string | null;
  provider: string | null;
  model: string | null;
  durations: {
    wallMs: number | null;
    modelMs: number;
    toolMs: number;
    snapshotMs: number;
    cumulativeMeasuredMs: number;
    otherMs: number | null;
    unexplainedWallPercentage: number | null;
    parallelism: number | null;
    delegateWaitNote?: string;
  };
  modelCalls: {
    starts: number;
    runtimeRetries: number;
    adapterRetries: number;
    retries: number;
    retryDelayMs: number;
    attempts: number;
    logicalCalls: number;
    retryAmplification: number | null;
    failures: number;
    failureRate: number | null;
    slowestSpanMs: number | null;
  };
  toolCalls: {
    starts: number;
    failures: number;
    failureRate: number | null;
    slowestSpanMs: number | null;
    rawOutputBytes: number;
    modelVisibleOutputBytes: number;
    rawToModelRatio: number | null;
    reductionPercentage: number | null;
    byTool: PerformanceSummary['tools']['byTool'];
  };
  usage: {
    runModel: UsageSummary;
    nonDelegateToolOutput: UsageSummary;
    combined: UsageSummary;
    promptCompletionRatio: number | null;
  };
  costs: {
    modelEstimateUSD: number;
    toolOutputEstimateUSD: number;
    externalToolProviderEstimateUSD: number;
    estimatedGrandTotalUSD: number;
    unpricedProviderRequests: number;
  };
  contextGrowth: {
    source: ContextGrowthSource;
    samples: number;
    initialMessageBytes: number | null;
    latestMessageBytes: number | null;
    peakMessageBytes: number | null;
    messageBytesGrowth: number | null;
    messageBytesGrowthPercentage: number | null;
    initialMessageCount: number | null;
    latestMessageCount: number | null;
    peakMessageCount: number | null;
    messageCountGrowth: number | null;
    messageCountGrowthPercentage: number | null;
  };
  replanCount: number;
  approvalRequestCount: number;
  approvalResolvedCount: number;
  directChildFanOut: number;
  cumulativeDirectChildWallMs: number;
  outputBytes: number;
  coverage: {
    events: number;
    performance: number | null;
    snapshots: number;
    cost: number | null;
  };
  notes: string[];
}

export interface TraceAnalysis {
  runs: RunAnalysis[];
}

export interface ComparisonMetric {
  baseline: number | null;
  candidate: number | null;
  delta: number | null;
  percentageChange: number | null;
}

export interface ComparisonMixRow {
  label: string;
  baselineCount: number;
  candidateCount: number;
  deltaCount: number;
}

export interface TraceComparison {
  baseline: {
    runId: string;
    analysis: RunAnalysis | null;
  };
  candidate: {
    runId: string;
    analysis: RunAnalysis | null;
  };
  changes: {
    wall: ComparisonMetric;
    tokens: ComparisonMetric;
    cost: ComparisonMetric;
    retries: ComparisonMetric;
    failures: ComparisonMetric;
    contextBytes: ComparisonMetric;
    outputBytes: ComparisonMetric;
  };
  reliability: {
    baseline: ReliabilityClassification;
    candidate: ReliabilityClassification;
    change: string;
    scope: 'root-tree';
  };
  toolMix: ComparisonMixRow[];
  providerModelMix: ComparisonMixRow[];
  confidence: {
    baseline: DataConfidenceLevel;
    candidate: DataConfidenceLevel;
  };
  notes: string[];
}

export type TraceAggregateGroupBy = 'model' | 'status' | 'day';

export interface TraceAggregateDistribution {
  sampleCount: number;
  average: number | null;
  min: number | null;
  p50: number | null;
  p90: number | null;
  p95: number | null;
  max: number | null;
}

export interface TraceAggregateToolObservation {
  toolName: string;
  calls: number;
  failures: number;
}

export interface TraceAggregateRetryObservation {
  provider: string;
  model: string;
  runs: number;
  runsWithRetries: number;
  retries: number;
}

export interface TraceAggregateObservation {
  rootRunId: string;
  startedAt: string | null;
  completedAt: string | null;
  status: string | null;
  provider: string | null;
  model: string | null;
  wallDurationMs: number | null;
  totalTokens: number | null;
  modelAndToolOutputCostUSD: number | null;
  externalToolProviderCostUSD: number | null;
  estimatedGrandTotalUSD: number | null;
  hadRecovery: boolean;
  retries: number;
  modelFailures: number;
  toolCalls: number;
  toolFailures: number;
  contextGrowthBytes: number | null;
  peakContextBytes: number | null;
  dataConfidence: DataConfidenceLevel;
  retryByProviderModel: TraceAggregateRetryObservation[];
  tools: TraceAggregateToolObservation[];
  errorCodes: string[];
}

export interface TraceAggregateGroup {
  key: string;
  label: string;
  runCount: number;
  outcomes: {
    succeeded: number;
    recoveredSucceeded: number;
    failed: number;
    cancelled: number;
    activeOrBlocked: number;
    unknown: number;
    successRate: number | null;
    recoveredSuccessRate: number | null;
    failureRate: number | null;
  };
  wallDurationMs: TraceAggregateDistribution;
  successfulRuns: {
    count: number;
    averageTokens: number | null;
    averageModelAndToolOutputCostUSD: number | null;
    averageExternalToolProviderCostUSD: number | null;
    averageEstimatedGrandTotalUSD: number | null;
  };
  modelFailures: number;
  retries: {
    total: number;
    runsWithRetries: number;
    runFrequency: number | null;
    byProviderModel: TraceAggregateRetryObservation[];
  };
  tools: {
    calls: number;
    failures: number;
    failureRate: number | null;
    byTool: TraceAggregateToolObservation[];
  };
  context: {
    growthBytes: TraceAggregateDistribution;
    peakBytes: TraceAggregateDistribution;
  };
  confidence: Record<DataConfidenceLevel, number>;
  commonErrorCodes: Array<{
    code: string;
    count: number;
  }>;
}

export interface TraceAggregateReport {
  kind: 'trace-aggregate';
  groupBy: TraceAggregateGroupBy;
  generatedAt: string;
  population: {
    runCount: number;
    terminalRuns: number;
    activeRuns: number;
    missingDuration: number;
    missingUsage: number;
    missingCost: number;
    missingContext: number;
    earliestStartedAt: string | null;
    latestStartedAt: string | null;
    since: string | null;
    until: string | null;
    limit: number | null;
  };
  overall: TraceAggregateGroup;
  groups: TraceAggregateGroup[];
  notes: string[];
}

export interface SnapshotMessageRow {
  root_run_id: string;
  run_id: string;
  run_delegate_name: string | null;
  delegation_depth: number | null;
  initial_snapshot_seq: number | null;
  initial_snapshot_created_at: string | null;
  initial_snapshot_state: unknown;
  latest_snapshot_seq: number | null;
  latest_snapshot_created_at: string | null;
  latest_snapshot_state: unknown;
}

export interface TraceReport {
  target: TraceTarget;
  session: SessionOverview | null;
  rootRuns: RootRun[];
  usage: SessionUsageSummary;
  performance?: PerformanceSummary;
  timeline: TimelineEntry[];
  milestones?: MilestoneEntry[];
  llmMessages: RunMessageTrace[];
  runTree?: RunTreeEntry[];
  snapshotSummaries?: RunSnapshotSummary[];
  totalSteps?: number | null;
  delegates: DelegateRow[];
  plans: PlanRow[];
  summary: {
    status: 'succeeded' | 'failed' | 'blocked' | 'unknown';
    reason: string;
  };
  warnings: string[];
  diagnostics?: TraceDiagnostics;
}

export interface TraceTarget {
  kind: 'session' | 'root-run' | 'run';
  requestedId: string;
  resolvedRootRunId?: string;
}
