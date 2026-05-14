import type { EventType } from '@adaptive-agent/core';
export type ReportView = 'overview' | 'milestones' | 'timeline' | 'delegates' | 'messages' | 'plans' | 'all';
export type MessageView = 'compact' | 'delta' | 'full';

export interface CliOptions {
  sessionId?: string;
  rootRunId?: string;
  runId?: string;
  json: boolean;
  listSessions: boolean;
  listSessionless: boolean;
  deleteEmptyGoalSessions: boolean;
  usageOnly: boolean;
  includePlans: boolean;
  onlyDelegates: boolean;
  messages: boolean;
  systemOnly: boolean;
  view?: ReportView;
  messagesView?: MessageView;
  focusRunId?: string;
  previewChars?: number;
  configPath?: string;
  help: boolean;
}

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
}

export interface UsageSummary {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
  estimatedCostUSD: number;
}

export interface SessionUsageSummary {
  total: UsageSummary;
  byRootRun: Array<{
    rootRunId: string;
    usage: UsageSummary;
  }>;
}

export interface SessionListItem {
  sessionId: string;
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
  }>;
}

export interface SessionlessRunListItem {
  rootRunId: string;
  startedAt: string;
  status?: string | null;
  goal: string | null;
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
}

export interface MilestoneEntry {
  rootRunId: string;
  runId: string;
  depth: number;
  eventType: EventType;
  stepId: string | null;
  createdAt: string | null;
  eventSeq: number | null;
  text: string;
}

export interface RunTreeEntry {
  rootRunId: string;
  runId: string;
  parentRunId: string | null;
  delegateName: string | null;
  depth: number;
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
  category:
    | 'initial-runtime-system'
    | 'gateway-chat-system-context'
    | 'runtime-injected-system'
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
  kind: 'session' | 'root-run' | 'run';
  requestedId: string;
  resolvedRootRunId?: string;
}

const CORE_EVENT_TYPES: EventType[] = [
  'run.created',
