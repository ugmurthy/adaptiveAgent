import type { EventType } from '@adaptive-agent/core';

import { formatCompactAgentEventFrame } from '../local-event-format.js';
import type { AgentEventFrame } from '../protocol.js';

import type {
  DelegateRow,
  MilestoneEntry,
  PerformanceBucketSummary,
  PerformanceSummary,
  RootRun,
  RunSnapshotSummary,
  RunTreeEntry,
  SessionOverview,
  TimelineEntry,
  TraceReport,
  TraceRow,
} from './types.js';

const CORE_EVENT_TYPES: EventType[] = [
  'run.created',
  'run.status_changed',
  'run.interrupted',
  'run.resumed',
  'run.retry_started',
  'run.completed',
  'run.failed',
  'plan.created',
  'plan.execution_started',
  'step.started',
  'step.completed',
  'model.started',
  'model.retry',
  'model.completed',
  'model.failed',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'delegate.spawned',
  'approval.requested',
  'approval.resolved',
  'clarification.requested',
  'usage.updated',
  'snapshot.created',
  'replan.required',
];

const CORE_EVENT_TYPE_SET = new Set<string>(CORE_EVENT_TYPES);

export function buildTimeline(rows: TraceRow[], options: { onlyDelegates?: boolean } = {}): TimelineEntry[] {
  const entries = new Map<string, TimelineEntry>();
  const latestOutputsByStep = new Map<string, unknown>();

  for (const row of rows) {
    const toolName = row.ledger_tool_name ?? row.event_tool_name ?? payloadString(row.payload, 'toolName');
    const childRunId = row.child_run_id ?? payloadString(row.payload, 'childRunId');
    const stepId = row.event_step_id ?? row.current_step_id;
    const isToolLike = Boolean(toolName || row.tool_call_id || row.tool_started_at || row.tool_execution_status);
    if (!isToolLike) {
      continue;
    }
    if (options.onlyDelegates && !isDelegateTool(toolName, childRunId)) {
      continue;
    }

    const key = row.tool_call_id
      ? `${row.run_id}:${row.tool_call_id}`
      : `${row.run_id}:${row.event_seq ?? row.event_id ?? row.tool_started_at ?? row.event_created_at ?? entries.size}`;
    const existing = entries.get(key);
    const startedAt = row.tool_started_at ?? eventStartedAt(row) ?? existing?.startedAt ?? null;
    const completedAt = row.tool_completed_at ?? eventCompletedAt(row) ?? existing?.completedAt ?? null;
    const directOutput = row.tool_output ?? payloadValue(row.payload, 'output') ?? payloadValue(row.payload, 'result') ?? row.child_run_result;
    const carriedOutput = latestOutputsByStep.get(timelineStepKey(row.run_id, stepId, toolName));
    const output = directOutput ?? existing?.output ?? carriedOutput ?? null;
    const status = row.tool_execution_status ?? payloadString(row.payload, 'status') ?? row.child_run_status ?? row.event_type ?? 'observed';
    const outcome = terminalOutcome({
      status,
      errorCode: row.tool_error_code ?? row.child_error_code ?? row.run_error_code,
      errorMessage: row.tool_error_message ?? row.child_error_message ?? row.run_error_message,
      childStatus: row.child_run_status,
      eventType: row.event_type,
    });

    entries.set(key, {
      rootRunId: row.root_run_id,
      runId: row.run_id,
      depth: row.delegation_depth ?? 0,
      stepId,
      toolCallId: row.tool_call_id,
      eventType: row.event_type,
      toolName,
      params: row.resolved_input ?? payloadValue(row.payload, 'input') ?? existing?.params ?? null,
      output,
      startedAt,
      completedAt,
      durationMs: durationMs(startedAt, completedAt),
      outcome,
      childRunId,
      eventSeq: row.event_seq,
    });

    if (output !== null && output !== undefined) {
      latestOutputsByStep.set(timelineStepKey(row.run_id, stepId, toolName), output);
    }
  }

  return [...entries.values()].sort(compareTimelineEntries);
}

export function computeDelegateReason(row: Pick<DelegateRow, 'child_run_id' | 'parent_run_id' | 'child_parent_run_id' | 'child_status'>): string {
  if (!row.child_run_id) {
    return 'missing child row';
  }
  if (row.child_parent_run_id && row.child_parent_run_id !== row.parent_run_id) {
    return 'child linkage mismatch';
  }
  switch (row.child_status) {
    case 'queued':
    case 'planning':
    case 'running':
      return 'still running';
    case 'awaiting_approval':
      return 'awaiting approval';
    case 'awaiting_subagent':
      return 'waiting on its own child';
    case 'interrupted':
      return 'interrupted and needs resume';
    case 'succeeded':
      return 'returned successfully';
    case 'replan_required':
      return 'returned replan.required';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'state requires manual inspection';
  }
}

export function summarizeTrace(
  session: SessionOverview | null,
  rootRuns: RootRun[],
  timeline: TimelineEntry[],
  delegates: DelegateRow[],
): TraceReport['summary'] {
  const failedDelegate = delegates.find((delegate) => delegate.child_status === 'failed');
  if (failedDelegate) {
    return {
      status: 'failed',
      reason: `failed because delegate ${delegateLabel(failedDelegate)} failed: ${failedDelegate.child_error_message ?? failedDelegate.child_error_code ?? 'no error persisted'}`,
    };
  }

  const activeDelegate = delegates.find((delegate) =>
    ['queued', 'planning', 'running', 'awaiting_approval', 'awaiting_subagent', 'interrupted'].includes(delegate.child_status ?? ''),
  );
  if (activeDelegate) {
    return {
      status: 'blocked',
      reason: `blocked because delegate ${delegateLabel(activeDelegate)} is ${computeDelegateReason(activeDelegate)}`,
    };
  }

  const failedRoot = rootRuns.find((run) => run.status === 'failed');
  if (failedRoot) {
    const detail = failedRoot.errorMessage ?? failedRoot.errorCode;
    return {
      status: 'failed',
      reason: detail
        ? `failed because root run ${shortId(failedRoot.rootRunId)} failed: ${detail}`
        : `failed because root run ${shortId(failedRoot.rootRunId)} reached a failed terminal outcome`,
    };
  }

  const failedTimeline = timeline.find((entry) => entry.outcome.startsWith('failed'));
  if (failedTimeline) {
    const detail = detailFromTimelineOutcome(failedTimeline.outcome);
    const subject = failedTimeline.toolName
      ? `tool ${failedTimeline.toolName}`
      : `run ${shortId(failedTimeline.runId)}`;
    return {
      status: 'failed',
      reason: detail
        ? `failed because ${subject} failed: ${detail}`
        : `failed because ${subject} reached a failed terminal outcome`,
    };
  }

  if (rootRuns.length > 0 && rootRuns.every((run) => run.status === 'succeeded')) {
    return { status: 'succeeded', reason: 'succeeded because all linked root runs completed successfully' };
  }

  const blockedRun = rootRuns.find((run) => run.status && !['succeeded', 'failed', 'cancelled'].includes(run.status));
  if (blockedRun) {
    return { status: 'blocked', reason: `blocked because root run ${shortId(blockedRun.rootRunId)} is ${blockedRun.status}` };
  }

  if (session?.status === 'failed') {
    return { status: 'failed', reason: 'failed because the persisted session reached a failed terminal outcome' };
  }

  return { status: 'unknown', reason: 'not enough persisted trace data to determine the terminal reason' };
}

export function summarizePerformance(rows: TraceRow[]): PerformanceSummary {
  const eventPayloadBytes = createBucket();
  const eventEmitDurationMs = createBucket();
  const modelRequestBytes = createBucket();
  const modelResponseBytes = createBucket();
  const modelDurationMs = createBucket();
  const modelRetryDelayMs = createBucket();
  const modelPendingToolCallCount = createBucket();
  const adapterGateWaitMs = createBucket();
  const adapterResponseLatencyMs = createBucket();
  const adapterRequestBytes = createBucket();
  const adapterResponseBytes = createBucket();
  const adapterAttemptCount = createBucket();
  const adapterRetryDelayMs = createBucket();
  const adapterStatusCodes: Record<string, number> = {};
  const toolInputBytes = createBucket();
  const toolEventInputBytes = createBucket();
  const toolRawOutputBytes = createBucket();
  const toolEventOutputBytes = createBucket();
  const toolModelOutputBytes = createBucket();
  const toolDurationMs = createBucket();
  const toolChildRunDurationMs = createBucket();
  const snapshotStateBytes = createBucket();
  const snapshotMessageBytes = createBucket();
  const snapshotMessageCount = createBucket();
  const snapshotSaveDurationMs = createBucket();
  const snapshotPendingToolCallBytes = createBucket();
  const toolsByName = new Map<string, ToolPerformanceAccumulator>();
  const seenEvents = new Set<string>();
  let modelStarted = 0;
  let modelCompleted = 0;
  let modelFailed = 0;
  let modelRetries = 0;
  let toolsStarted = 0;
  let toolsCompleted = 0;
  let toolsFailed = 0;
  let snapshotsCreated = 0;
  let measuredEvents = 0;

  for (const row of rows) {
    if (!row.event_type) {
      continue;
    }

    const eventKey = row.event_id ?? `${row.run_id}:${row.event_seq ?? row.event_created_at ?? seenEvents.size}`;
    if (seenEvents.has(eventKey)) {
      continue;
    }
    seenEvents.add(eventKey);

    const performance = payloadPerformance(row.payload);
    if (!performance) {
      continue;
    }
    measuredEvents += 1;

    addNumber(eventPayloadBytes, readNumber(performance, 'eventPayloadBytes'));
    addNumber(eventEmitDurationMs, readNumber(performance, 'eventEmitDurationMs'));

    switch (row.event_type) {
      case 'model.started':
        modelStarted += 1;
        addNumber(modelRequestBytes, readNumber(performance, 'requestBytes'));
        break;
      case 'model.completed':
        modelCompleted += 1;
        addNumber(modelResponseBytes, readNumber(performance, 'responseBytes'));
        addNumber(modelDurationMs, readNumber(performance, 'durationMs'));
        addNumber(modelPendingToolCallCount, readNumber(performance, 'pendingToolCallCount'));
        addAdapterMetrics(performance);
        break;
      case 'model.failed':
        modelFailed += 1;
        addNumber(modelDurationMs, readNumber(performance, 'durationMs'));
        break;
      case 'model.retry':
        modelRetries += 1;
        addNumber(modelRetryDelayMs, readNumber(performance, 'retryDelayMs'));
        addNumber(modelDurationMs, readNumber(performance, 'durationMs'));
        addAdapterMetrics(performance);
        break;
      case 'tool.started':
        toolsStarted += 1;
        addToolCounts(row, 'started');
        addNumber(toolInputBytes, readNumber(performance, 'inputBytes'));
        addNumber(toolEventInputBytes, readNumber(performance, 'eventInputBytes'));
        break;
      case 'tool.completed':
        toolsCompleted += 1;
        addToolCounts(row, 'completed');
        addToolMetrics(row, performance);
        break;
      case 'tool.failed':
        toolsFailed += 1;
        addToolCounts(row, 'failed');
        addToolMetrics(row, performance);
        break;
      case 'snapshot.created':
        snapshotsCreated += 1;
        addNumber(snapshotStateBytes, readNumber(performance, 'stateBytes'));
        addNumber(snapshotMessageBytes, readNumber(performance, 'messageBytes'));
        addNumber(snapshotMessageCount, readNumber(performance, 'messageCount'));
        addNumber(snapshotSaveDurationMs, readNumber(performance, 'saveDurationMs'));
        addNumber(snapshotPendingToolCallBytes, readNumber(performance, 'pendingToolCallBytes'));
        break;
    }
  }

  return {
    events: {
      totalEvents: seenEvents.size,
      measuredEvents,
      payloadBytes: finishBucket(eventPayloadBytes),
      emitDurationMs: finishBucket(eventEmitDurationMs),
    },
    model: {
      started: modelStarted,
      completed: modelCompleted,
      failed: modelFailed,
      retries: modelRetries,
      requestBytes: finishBucket(modelRequestBytes),
      responseBytes: finishBucket(modelResponseBytes),
      durationMs: finishBucket(modelDurationMs),
      retryDelayMs: finishBucket(modelRetryDelayMs),
      pendingToolCallCount: finishBucket(modelPendingToolCallCount),
      adapterGateWaitMs: finishBucket(adapterGateWaitMs),
      adapterResponseLatencyMs: finishBucket(adapterResponseLatencyMs),
      adapterRequestBytes: finishBucket(adapterRequestBytes),
      adapterResponseBytes: finishBucket(adapterResponseBytes),
      adapterAttemptCount: finishBucket(adapterAttemptCount),
      adapterRetryDelayMs: finishBucket(adapterRetryDelayMs),
      adapterStatusCodes,
    },
    tools: {
      started: toolsStarted,
      completed: toolsCompleted,
      failed: toolsFailed,
      inputBytes: finishBucket(toolInputBytes),
      eventInputBytes: finishBucket(toolEventInputBytes),
      rawOutputBytes: finishBucket(toolRawOutputBytes),
      eventOutputBytes: finishBucket(toolEventOutputBytes),
      modelOutputBytes: finishBucket(toolModelOutputBytes),
      durationMs: finishBucket(toolDurationMs),
      childRunDurationMs: finishBucket(toolChildRunDurationMs),
      byTool: [...toolsByName.values()]
        .map((tool) => ({
          toolName: tool.toolName,
          started: tool.started,
          completed: tool.completed,
          failed: tool.failed,
          durationMs: finishBucket(tool.durationMs),
          rawOutputBytes: finishBucket(tool.rawOutputBytes),
          modelOutputBytes: finishBucket(tool.modelOutputBytes),
        }))
        .sort((left, right) => right.durationMs.total - left.durationMs.total || left.toolName.localeCompare(right.toolName)),
    },
    snapshots: {
      created: snapshotsCreated,
      stateBytes: finishBucket(snapshotStateBytes),
      messageBytes: finishBucket(snapshotMessageBytes),
      messageCount: finishBucket(snapshotMessageCount),
      saveDurationMs: finishBucket(snapshotSaveDurationMs),
      pendingToolCallBytes: finishBucket(snapshotPendingToolCallBytes),
    },
  };

  function addAdapterMetrics(performance: Record<string, unknown>): void {
    const adapter = asRecord(performance.adapter) ?? performance;
    addNumber(adapterGateWaitMs, readNumber(adapter, 'adapterGateWaitMs'));
    addNumber(adapterResponseLatencyMs, readNumber(adapter, 'adapterResponseLatencyMs'));
    addNumber(adapterRequestBytes, readNumber(adapter, 'adapterRequestBytes'));
    addNumber(adapterResponseBytes, readNumber(adapter, 'adapterResponseBytes'));
    addNumber(adapterAttemptCount, readNumber(adapter, 'adapterAttemptCount'));
    addNumber(adapterRetryDelayMs, readNumber(adapter, 'adapterRetryDelayMs') ?? readNumber(adapter, 'adapterTotalRetryDelayMs'));
    const statusCode = readNumber(adapter, 'adapterStatusCode');
    if (statusCode !== undefined) {
      const key = String(statusCode);
      adapterStatusCodes[key] = (adapterStatusCodes[key] ?? 0) + 1;
    }
  }

  function addToolMetrics(row: TraceRow, performance: Record<string, unknown>): void {
    addNumber(toolInputBytes, readNumber(performance, 'inputBytes'));
    addNumber(toolEventInputBytes, readNumber(performance, 'eventInputBytes'));
    addNumber(toolRawOutputBytes, readNumber(performance, 'rawOutputBytes'));
    addNumber(toolEventOutputBytes, readNumber(performance, 'eventOutputBytes'));
    addNumber(toolModelOutputBytes, readNumber(performance, 'modelOutputBytes'));
    addNumber(toolDurationMs, readNumber(performance, 'durationMs'));
    addNumber(toolChildRunDurationMs, readNumber(performance, 'childRunDurationMs'));

    const tool = toolAccumulator(row);
    addNumber(tool.durationMs, readNumber(performance, 'durationMs') ?? readNumber(performance, 'childRunDurationMs'));
    addNumber(tool.rawOutputBytes, readNumber(performance, 'rawOutputBytes'));
    addNumber(tool.modelOutputBytes, readNumber(performance, 'modelOutputBytes'));
  }

  function addToolCounts(row: TraceRow, kind: 'started' | 'completed' | 'failed'): void {
    const tool = toolAccumulator(row);
    tool[kind] += 1;
  }

  function toolAccumulator(row: TraceRow): ToolPerformanceAccumulator {
    const toolName = row.ledger_tool_name ?? row.event_tool_name ?? payloadString(row.payload, 'toolName') ?? 'unknown';
    const existing = toolsByName.get(toolName);
    if (existing) {
      return existing;
    }
    const created = {
      toolName,
      started: 0,
      completed: 0,
      failed: 0,
      durationMs: createBucket(),
      rawOutputBytes: createBucket(),
      modelOutputBytes: createBucket(),
    };
    toolsByName.set(toolName, created);
    return created;
  }
}


export function buildMilestones(rows: TraceRow[]): MilestoneEntry[] {
  const entries = new Map<string, MilestoneEntry>();

  for (const row of rows) {
    if (!row.event_type || !CORE_EVENT_TYPE_SET.has(row.event_type)) {
      continue;
    }

    const key = row.event_id ?? `${row.run_id}:${row.event_seq ?? row.event_created_at ?? entries.size}`;
    if (entries.has(key)) {
      continue;
    }

    const frame: AgentEventFrame = {
      type: 'agent.event',
      eventType: row.event_type as EventType,
      data: toEventData(row.payload),
      seq: row.event_seq ?? undefined,
      stepId: row.event_step_id ?? undefined,
      createdAt: row.event_created_at ?? undefined,
      runId: row.run_id,
      rootRunId: row.root_run_id,
      parentRunId: row.parent_run_id ?? undefined,
    };

    entries.set(key, {
      rootRunId: row.root_run_id,
      runId: row.run_id,
      depth: row.delegation_depth ?? 0,
      eventType: row.event_type as EventType,
      stepId: row.event_step_id,
      createdAt: row.event_created_at,
      eventSeq: row.event_seq,
      text: formatCompactAgentEventFrame(frame),
    });
  }

  return [...entries.values()].sort((left, right) =>
    compareTime(left.createdAt, right.createdAt)
    || left.rootRunId.localeCompare(right.rootRunId)
    || left.runId.localeCompare(right.runId)
    || (left.eventSeq ?? 0) - (right.eventSeq ?? 0),
  );
}

export function buildRunTreeEntries(rows: TraceRow[]): RunTreeEntry[] {
  const entries = new Map<string, RunTreeEntry>();

  for (const row of rows) {
    if (entries.has(row.run_id)) {
      continue;
    }
    entries.set(row.run_id, {
      rootRunId: row.root_run_id,
      runId: row.run_id,
      parentRunId: row.parent_run_id,
      delegateName: row.run_delegate_name,
      depth: row.delegation_depth ?? 0,
    });
  }

  return [...entries.values()].sort((left, right) =>
    left.depth - right.depth
    || left.rootRunId.localeCompare(right.rootRunId)
    || left.runId.localeCompare(right.runId),
  );
}

export function totalStepsFromSnapshotSummaries(summaries: RunSnapshotSummary[]): number | null {
  const knownSteps = summaries.filter((summary) => summary.latestStepsUsed !== null);
  if (knownSteps.length === 0) {
    return null;
  }
  return knownSteps.reduce((total, summary) => total + (summary.latestStepsUsed ?? 0), 0);
}

export function collectFocusedRunIds(runTree: RunTreeEntry[], focusRunId: string): Set<string> {
  if (!runTree.some((entry) => entry.runId === focusRunId)) {
    return new Set();
  }

  const childrenByParent = new Map<string, string[]>();
  for (const entry of runTree) {
    if (!entry.parentRunId) {
      continue;
    }
    const children = childrenByParent.get(entry.parentRunId) ?? [];
    children.push(entry.runId);
    childrenByParent.set(entry.parentRunId, children);
  }

  const focused = new Set<string>();
  const queue = [focusRunId];
  while (queue.length > 0) {
    const runId = queue.shift()!;
    if (focused.has(runId)) {
      continue;
    }
    focused.add(runId);
    for (const childRunId of childrenByParent.get(runId) ?? []) {
      queue.push(childRunId);
    }
  }
  return focused;
}

export function filterReportForFocusedRun(report: TraceReport, focusedRunIds: Set<string>): TraceReport {
  const focusedRootRunIds = new Set((report.runTree ?? [])
    .filter((entry) => focusedRunIds.has(entry.runId))
    .map((entry) => entry.rootRunId));

  return {
    ...report,
    rootRuns: report.rootRuns.filter((run) => focusedRootRunIds.has(run.rootRunId)),
    timeline: report.timeline.filter((entry) => focusedRunIds.has(entry.runId)),
    milestones: (report.milestones ?? []).filter((entry) => focusedRunIds.has(entry.runId)),
    llmMessages: report.llmMessages.filter((trace) => focusedRunIds.has(trace.runId)),
    runTree: (report.runTree ?? []).filter((entry) => focusedRunIds.has(entry.runId)),
    snapshotSummaries: (report.snapshotSummaries ?? []).filter((summary) => focusedRunIds.has(summary.runId)),
    delegates: report.delegates.filter((delegate) => focusedRunIds.has(delegate.parent_run_id) || (delegate.child_run_id !== null && focusedRunIds.has(delegate.child_run_id))),
    plans: report.plans.filter((plan) => focusedRunIds.has(plan.run_id)),
  };
}

function toEventData(value: unknown): AgentEventFrame['data'] {
  return value as AgentEventFrame['data'];
}

function terminalOutcome(input: {
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  childStatus: string | null;
  eventType: string | null;
}): string {
  if (input.errorCode || input.errorMessage) {
    return `failed: ${input.errorCode ?? input.errorMessage}`;
  }
  if (input.childStatus) {
    return `child ${input.childStatus}`;
  }
  if (input.status) {
    return input.status;
  }
  return input.eventType ?? 'observed';
}

function detailFromTimelineOutcome(outcome: string): string | null {
  const prefix = 'failed: ';
  return outcome.startsWith(prefix) ? outcome.slice(prefix.length) : null;
}

export function isHistoricalTrace(rows: TraceRow[]): boolean {
  const toolRows = rows.filter((row) => row.ledger_tool_name || row.event_tool_name || payloadString(row.payload, 'toolName'));
  return toolRows.length > 0 && toolRows.every((row) => !row.tool_call_id && row.child_run_id === null);
}

function eventStartedAt(row: TraceRow): string | null {
  if (row.event_type?.includes('started') || row.event_type?.includes('requested')) {
    return row.event_created_at;
  }
  return row.tool_started_at ?? row.event_created_at;
}

function eventCompletedAt(row: TraceRow): string | null {
  if (row.event_type?.includes('completed') || row.event_type?.includes('failed')) {
    return row.event_created_at;
  }
  return row.tool_completed_at;
}

function compareTimelineEntries(left: TimelineEntry, right: TimelineEntry): number {
  return (
    compareTime(left.startedAt, right.startedAt) ||
    left.rootRunId.localeCompare(right.rootRunId) ||
    left.runId.localeCompare(right.runId) ||
    (left.eventSeq ?? 0) - (right.eventSeq ?? 0)
  );
}

function compareTime(left: string | null, right: string | null): number {
  if (!left && !right) {
    return 0;
  }
  if (!left) {
    return 1;
  }
  if (!right) {
    return -1;
  }
  return Date.parse(left) - Date.parse(right);
}

function earliestTimelineStart(entries: TimelineEntry[]): string | null {
  let earliest: string | null = null;
  for (const entry of entries) {
    if (compareTime(entry.startedAt, earliest) < 0) {
      earliest = entry.startedAt;
    }
  }
  return earliest;
}

function timelineStepKey(runId: string, stepId: string | null, toolName: string | null): string {
  return `${runId}:${stepId ?? '-'}:${toolName ?? '-'}`;
}

function durationMs(startedAt: string | null, completedAt: string | null): number | null {
  if (!startedAt || !completedAt) {
    return null;
  }
  const duration = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}


function payloadValue(payload: unknown, key: string): unknown {
  if (payload && typeof payload === 'object' && key in payload) {
    return (payload as Record<string, unknown>)[key];
  }
  return undefined;
}

interface PerformanceBucketAccumulator {
  count: number;
  total: number;
  max: number;
}

interface ToolPerformanceAccumulator {
  toolName: string;
  started: number;
  completed: number;
  failed: number;
  durationMs: PerformanceBucketAccumulator;
  rawOutputBytes: PerformanceBucketAccumulator;
  modelOutputBytes: PerformanceBucketAccumulator;
}

function createBucket(): PerformanceBucketAccumulator {
  return { count: 0, total: 0, max: 0 };
}

function addNumber(bucket: PerformanceBucketAccumulator, value: number | undefined): void {
  if (value === undefined || !Number.isFinite(value)) {
    return;
  }
  bucket.count += 1;
  bucket.total += value;
  bucket.max = Math.max(bucket.max, value);
}

function finishBucket(bucket: PerformanceBucketAccumulator): PerformanceBucketSummary {
  return {
    count: bucket.count,
    total: bucket.total,
    max: bucket.max,
    average: bucket.count === 0 ? 0 : bucket.total / bucket.count,
  };
}

function payloadPerformance(payload: unknown): Record<string, unknown> | null {
  return asRecord(payloadValue(payload, 'performance'));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function payloadString(payload: unknown, key: string): string | null {
  const value = payloadValue(payload, key);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncatePlain(value: string, width: number): string {
  return value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value;
}

function isDelegateTool(toolName: string | null, childRunId: string | null): boolean {
  return Boolean(childRunId || toolName?.startsWith('delegate.'));
}

export function shortId(value: string): string {
  return value.length > 12 ? value.slice(0, 8) : value;
}

function delegateLabel(delegate: DelegateRow): string {
  return `${delegate.child_delegate_name ?? delegate.snapshot_delegate_name ?? 'delegate'} (${delegate.child_run_id ? shortId(delegate.child_run_id) : 'missing child'})`;
}
