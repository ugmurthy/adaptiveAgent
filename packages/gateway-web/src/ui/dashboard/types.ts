export type DashboardTab = 'overview' | 'output' | 'messages' | 'timeline' | 'plans';
export type DashboardExplorerMode = 'cards' | 'table';
export type DashboardMessagesView = 'compact' | 'delta' | 'full';
export type DashboardSavedView = 'all' | 'needs_approval' | 'failed' | 'running' | 'sessionless';

export interface DashboardFilters {
  from: string;
  to: string;
  status: string;
  session: 'any' | 'linked' | 'sessionless';
  requiresApproval: '' | 'true' | 'false';
  q: string;
  sort: 'created_desc' | 'updated_desc' | 'duration_desc' | 'cost_desc';
  limit: number;
  offset: number;
}

export interface DashboardRunListResult {
  items: DashboardRunListItem[];
  limit: number;
  offset: number;
  nextOffset: number | null;
}

export interface DashboardRunListItem {
  rootRunId: string;
  sessionId: string | null;
  status: string | null;
  goal: string | null;
  goalPreview: string | null;
  agentId: string | null;
  modelProvider: string | null;
  modelName: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  childRunCount: number;
  toolCallCount: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalReasoningTokens: number | null;
  estimatedCostUSD: number;
  pendingApproval: DashboardPendingApproval | null;
}

export interface DashboardPendingApproval {
  runId: string;
  rootRunId: string;
  sessionId: string | null;
  toolName?: string;
  reason?: string;
}

export interface DashboardError {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

export interface TraceReport {
  target: TraceTarget;
  session: SessionOverview | null;
  rootRuns: RootRun[];
  usage: SessionUsageSummary;
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
}

export interface TraceTarget {
  sessionId?: string | null;
  rootRunId?: string | null;
  runId?: string | null;
  focusRunId?: string | null;
}

export interface SessionOverview {
  sessionId?: string;
  status?: string;
  channelId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface RootRun {
  runId?: string;
  rootRunId?: string;
  goal?: string | null;
  status?: string | null;
  output?: unknown;
  error?: string | null;
  modelProvider?: string | null;
  modelName?: string | null;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
  [key: string]: unknown;
}

export interface SessionUsageSummary {
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number | null;
  estimatedCostUSD?: number;
  [key: string]: unknown;
}

export interface TimelineEntry {
  runId?: string;
  rootRunId?: string;
  eventType?: string;
  toolName?: string;
  status?: string;
  startedAt?: string;
  completedAt?: string | null;
  timestamp?: string;
  durationMs?: number | null;
  detail?: string;
  error?: string | null;
  [key: string]: unknown;
}

export interface MilestoneEntry {
  label?: string;
  timestamp?: string;
  detail?: string;
  [key: string]: unknown;
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
  [key: string]: unknown;
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
  category:
    | 'initial-runtime-system'
    | 'gateway-chat-system-context'
    | 'runtime-injected-system'
    | 'user'
    | 'assistant'
    | 'tool';
}

export interface RunTreeEntry {
  runId?: string;
  parentRunId?: string | null;
  rootRunId?: string;
  status?: string;
  goal?: string | null;
  [key: string]: unknown;
}

export interface RunSnapshotSummary {
  runId?: string;
  status?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface DelegateRow {
  runId?: string;
  delegateName?: string;
  status?: string;
  [key: string]: unknown;
}

export interface PlanRow {
  planId?: string;
  runId?: string;
  status?: string;
  title?: string;
  objective?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface DashboardMessagesResponse {
  target: TraceTarget;
  warnings: string[];
  messages: RunMessageTrace[];
}

export interface DashboardTimelineResponse {
  target: TraceTarget;
  warnings: string[];
  timeline: TimelineEntry[];
}

export interface DashboardPlansResponse {
  target: TraceTarget;
  warnings: string[];
  plans: PlanRow[];
}

export interface DashboardDeleteRunResult {
  rootRunId: string;
  deletedRuns: number;
  deletedPlans: number;
  deletedCronRuns: number;
  deletedRunAdmissions: number;
}

export interface DashboardReplayRunResult {
  sessionId: string;
  rootRunId: string;
  runId: string | null;
  status: string;
  policy: string;
  replayedFrameType: string | null;
  pendingApproval: DashboardPendingApproval | null;
}

export interface DashboardRetryRunResult {
  type: 'run.output' | 'approval.requested';
  runId: string;
  rootRunId?: string;
  sessionId?: string;
  status?: string;
}
