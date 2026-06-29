import { formatCompactAgentEventFrame, type AgentEventFrame } from '../event-format.js';

import type {
  DelegateRow,
  EvidenceRef,
  EventType,
  MilestoneEntry,
  PerformanceBucketSummary,
  PerformanceDigest,
  PerformanceSummary,
  PolicyDigest,
  RootRun,
  RunSnapshotSummary,
  RunTreeEntry,
  SessionOverview,
  TopRunUsage,
  TopToolMetric,
  TimelineEntry,
  TraceDiagnostics,
  TraceFinding,
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
  'model.tool_call_rejected',
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

export function buildTraceDiagnostics(report: TraceReport): TraceDiagnostics {
  const performance = report.performance ?? emptyPerformanceSummaryForDiagnostics();
  const wallDurationMs = traceWallDurationMs(report.rootRuns, report.session);
  const performanceDigest = buildPerformanceDigest(report, performance, wallDurationMs);
  const policyDigest = buildPolicyDigest(report);
  const findings = buildTraceFindings(report, performance, performanceDigest, policyDigest);
  const brief = {
    status: report.summary.status,
    headline: report.summary.reason,
    targetLabel: traceTargetLabel(report),
    rootRunCount: report.rootRuns.length,
    runCount: runCount(report),
    totalSteps: report.totalSteps ?? null,
    wallDurationMs,
    cumulativeModelDurationMs: performance.model.durationMs.total,
    cumulativeToolDurationMs: performance.tools.durationMs.total,
    cumulativeSnapshotSaveMs: performance.snapshots.saveDurationMs.total,
    cumulativeMeasuredDurationMs: performanceDigest.cumulativeMeasuredDurationMs,
    parallelismFactor: performanceDigest.parallelismFactor,
    modelCalls: performance.model.started,
    failedModelCalls: performance.model.failed,
    toolCalls: performance.tools.started,
    failedToolCalls: performance.tools.failed,
    totalTokens: report.usage.total.totalTokens,
    estimatedCostUSD: report.usage.total.estimatedCostUSD,
  };

  return {
    brief,
    findings,
    performance: performanceDigest,
    policy: policyDigest,
    suggestedNextViews: buildSuggestedNextViews(report, findings, policyDigest, performanceDigest),
  };
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
  const toolCalls = new Map<string, ToolCallCountAccumulator>();
  const seenEvents = new Set<string>();
  let modelStarted = 0;
  let modelCompleted = 0;
  let modelFailed = 0;
  let modelRetries = 0;
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
    recordToolCall(row, eventKey);

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
        addNumber(toolInputBytes, readNumber(performance, 'inputBytes'));
        addNumber(toolEventInputBytes, readNumber(performance, 'eventInputBytes'));
        break;
      case 'tool.completed':
        addToolMetrics(row, performance);
        break;
      case 'tool.failed':
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

  const toolCounts = finishToolCallCounts();

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
      started: toolCounts.started,
      completed: toolCounts.completed,
      failed: toolCounts.failed,
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

  function toolAccumulator(row: TraceRow): ToolPerformanceAccumulator {
    return toolAccumulatorForName(traceToolName(row));
  }

  function toolAccumulatorForName(toolName: string): ToolPerformanceAccumulator {
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

  function recordToolCall(row: TraceRow, eventKey: string): void {
    if (!row.event_type?.startsWith('tool.')) {
      return;
    }

    const terminalStatus = normalizeToolTerminalStatus(row.tool_execution_status)
      ?? normalizeToolEventTerminalStatus(row.event_type);
    const key = row.tool_call_id
      ? `call:${row.run_id}:${row.tool_call_id}`
      : `event:${eventKey}`;
    const existing = toolCalls.get(key);
    const toolName = traceToolName(row);
    const call = existing ?? {
      toolName,
      started: false,
      terminalStatus: null,
    };

    if (call.toolName === 'unknown' && toolName !== 'unknown') {
      call.toolName = toolName;
    }
    if (row.event_type === 'tool.started' || row.tool_started_at || row.tool_execution_status || terminalStatus) {
      call.started = true;
    }
    if (terminalStatus) {
      call.terminalStatus = terminalStatus;
    }

    toolCalls.set(key, call);
  }

  function finishToolCallCounts(): { started: number; completed: number; failed: number } {
    let started = 0;
    let completed = 0;
    let failed = 0;

    for (const call of toolCalls.values()) {
      const tool = toolAccumulatorForName(call.toolName);
      if (call.started) {
        started += 1;
        tool.started += 1;
      }
      if (call.terminalStatus === 'completed') {
        completed += 1;
        tool.completed += 1;
      } else if (call.terminalStatus === 'failed') {
        failed += 1;
        tool.failed += 1;
      }
    }

    return { started, completed, failed };
  }
}

function buildPerformanceDigest(
  report: TraceReport,
  performance: PerformanceSummary,
  wallDurationMs: number | null,
): PerformanceDigest {
  const cumulativeMeasuredDurationMs = performance.model.durationMs.total
    + performance.tools.durationMs.total
    + performance.snapshots.saveDurationMs.total;
  const otherDurationMs = wallDurationMs === null ? null : Math.max(0, wallDurationMs - cumulativeMeasuredDurationMs);
  const parallelismFactor = wallDurationMs && wallDurationMs > 0
    ? cumulativeMeasuredDurationMs / wallDurationMs
    : null;
  const topToolSpans = report.timeline
    .filter((entry): entry is TimelineEntry & { durationMs: number } => entry.durationMs !== null && entry.durationMs > 0)
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, 5)
    .map((entry) => ({
      rootRunId: entry.rootRunId,
      runId: entry.runId,
      stepId: entry.stepId,
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
      outcome: entry.outcome,
      durationMs: entry.durationMs,
      childRunId: entry.childRunId,
    }));
  const topToolsByDuration = topToolMetrics(performance.tools.byTool, (tool) => tool.durationMs.total);
  const topToolsByModelOutput = topToolMetrics(performance.tools.byTool, (tool) => tool.modelOutputBytes.total);
  const topRunsByUsage = buildTopRunsByUsage(report);
  const notes: string[] = [];

  if (parallelismFactor !== null && parallelismFactor > 1.25) {
    notes.push('Cumulative measured time exceeds wall time; model/tool/snapshot totals represent parallel or nested work, not critical path latency.');
  }
  if (performance.snapshots.messageBytes.max > 0 && performance.model.requestBytes.max > 0) {
    notes.push('Compare largest snapshot message bytes with largest model request bytes to identify prompt-context growth.');
  }
  if (performance.tools.rawOutputBytes.total > performance.tools.modelOutputBytes.total) {
    notes.push('Tool raw output is larger than model-visible output; tool summarization/compression is reducing context load.');
  }

  return {
    wallDurationMs,
    cumulativeModelDurationMs: performance.model.durationMs.total,
    cumulativeToolDurationMs: performance.tools.durationMs.total,
    cumulativeSnapshotSaveMs: performance.snapshots.saveDurationMs.total,
    cumulativeMeasuredDurationMs,
    otherDurationMs,
    parallelismFactor,
    topToolSpans,
    topToolsByDuration,
    topToolsByModelOutput,
    topRunsByUsage,
    notes,
  };
}

function buildPolicyDigest(report: TraceReport): PolicyDigest {
  const budgetGroups = new Map<string, { skippedCalls: number; toolNames: Set<string> }>();
  let budgetExhaustedToolCalls = 0;

  for (const entry of report.timeline) {
    const budget = findBudgetExhaustedRecord(entry.output) ?? findBudgetExhaustedRecord(entry.params);
    if (!budget) {
      continue;
    }
    budgetExhaustedToolCalls += 1;
    const budgetGroup = readStringFromRecord(budget, 'budgetGroup') ?? 'unknown';
    const group = budgetGroups.get(budgetGroup) ?? { skippedCalls: 0, toolNames: new Set<string>() };
    group.skippedCalls += 1;
    if (entry.toolName) {
      group.toolNames.add(entry.toolName);
    }
    budgetGroups.set(budgetGroup, group);
  }

  const rejectedToolCalls = (report.milestones ?? []).filter((entry) => entry.eventType === 'model.tool_call_rejected').length;
  const approvalRequests = (report.milestones ?? []).filter((entry) => entry.eventType === 'approval.requested').length;
  const approvalResolved = (report.milestones ?? []).filter((entry) => entry.eventType === 'approval.resolved').length;
  const runtimePolicyMessages = report.llmMessages.reduce((total, trace) =>
    total + trace.effectiveMessages.filter((message) => isRuntimePolicyMessage(message.category, message.content)).length,
  0);
  const unresolvedApprovalRequests = Math.max(0, approvalRequests - approvalResolved);
  const warnings: string[] = [];

  if (budgetExhaustedToolCalls > 0) {
    warnings.push(`Observed ${budgetExhaustedToolCalls} tool calls skipped after a budget was exhausted.`);
  }
  if (rejectedToolCalls > 0) {
    warnings.push(`Observed ${rejectedToolCalls} rejected model tool calls.`);
  }
  if (unresolvedApprovalRequests > 0) {
    warnings.push(`Observed ${unresolvedApprovalRequests} approval requests without matching approval.resolved events.`);
  }
  if (runtimePolicyMessages > 0) {
    warnings.push(`Observed ${runtimePolicyMessages} runtime-injected policy or budget messages in LLM context.`);
  }

  return {
    budgetExhaustedToolCalls,
    budgetGroups: [...budgetGroups.entries()]
      .map(([budgetGroup, group]) => ({
        budgetGroup,
        skippedCalls: group.skippedCalls,
        toolNames: [...group.toolNames].sort((left, right) => left.localeCompare(right)),
      }))
      .sort((left, right) => right.skippedCalls - left.skippedCalls || left.budgetGroup.localeCompare(right.budgetGroup)),
    rejectedToolCalls,
    approvalRequests,
    approvalResolved,
    unresolvedApprovalRequests,
    runtimePolicyMessages,
    warnings,
  };
}

function buildTraceFindings(
  report: TraceReport,
  performance: PerformanceSummary,
  performanceDigest: PerformanceDigest,
  policyDigest: PolicyDigest,
): TraceFinding[] {
  const findings: TraceFinding[] = [];
  let nextId = 1;
  const pushFinding = (finding: Omit<TraceFinding, 'id'>): void => {
    findings.push({ id: `finding-${nextId}`, ...finding });
    nextId += 1;
  };

  if (report.summary.status === 'failed' || report.summary.status === 'blocked') {
    pushFinding({
      severity: report.summary.status === 'failed' ? 'error' : 'warning',
      category: report.summary.status === 'failed' ? 'failure' : 'blocked',
      title: report.summary.status === 'failed' ? 'Trace failed' : 'Trace is blocked',
      summary: report.summary.reason,
      evidence: primaryOutcomeEvidence(report),
    });
  }

  if (performance.model.failed > 0) {
    pushFinding({
      severity: 'error',
      category: 'failure',
      title: 'Model failures observed',
      summary: `${performance.model.failed} model lifecycle events ended in failure.`,
      evidence: modelFailureEvidence(report),
    });
  }

  if (performance.tools.failed > 0) {
    pushFinding({
      severity: 'error',
      category: 'failure',
      title: 'Tool failures observed',
      summary: `${performance.tools.failed} tool executions ended in failure.`,
      evidence: failedToolEvidence(report),
    });
  }

  if (performanceDigest.parallelismFactor !== null && performanceDigest.parallelismFactor > 1.25) {
    pushFinding({
      severity: performanceDigest.parallelismFactor >= 2 ? 'warning' : 'info',
      category: 'performance',
      title: 'Cumulative work exceeds wall time',
      summary: `Measured model/tool/snapshot time is ${performanceDigest.parallelismFactor.toFixed(2)}x wall time, so totals should be read as cumulative work rather than critical-path latency.`,
      evidence: [{
        kind: 'usage',
        label: 'duration split',
        detail: `wall=${performanceDigest.wallDurationMs ?? 'unknown'}ms cumulative=${performanceDigest.cumulativeMeasuredDurationMs}ms`,
      }],
    });
  }

  const topRun = performanceDigest.topRunsByUsage[0];
  if (topRun && report.usage.total.totalTokens > 0) {
    const share = topRun.totalTokens / report.usage.total.totalTokens;
    if (share >= 0.5) {
      pushFinding({
        severity: 'info',
        category: 'performance',
        title: 'Token usage is concentrated in one root run',
        summary: `Root run ${shortId(topRun.rootRunId)} accounts for ${(share * 100).toFixed(1)}% of total tokens.`,
        evidence: [{
          kind: 'usage',
          label: `root ${shortId(topRun.rootRunId)} usage`,
          rootRunId: topRun.rootRunId,
          runId: topRun.runId,
          detail: `${topRun.totalTokens} total tokens`,
        }],
      });
    }
  }

  for (const warning of policyDigest.warnings) {
    pushFinding({
      severity: 'warning',
      category: 'policy',
      title: policyFindingTitle(warning),
      summary: warning,
      evidence: policyEvidence(report, warning),
    });
  }

  for (const warning of report.warnings) {
    pushFinding({
      severity: 'warning',
      category: 'data-quality',
      title: 'Trace data warning',
      summary: warning,
      evidence: [{ kind: 'event', label: 'trace warning', detail: warning }],
    });
  }

  return findings;
}

function buildSuggestedNextViews(
  report: TraceReport,
  findings: TraceFinding[],
  policyDigest: PolicyDigest,
  performanceDigest: PerformanceDigest,
): TraceDiagnostics['suggestedNextViews'] {
  const suggestions = new Map<string, string>();
  const add = (reason: string, command: string): void => {
    if (!suggestions.has(command)) {
      suggestions.set(command, reason);
    }
  };
  const failingRunId = firstEvidenceRunId(findings.find((finding) => finding.severity === 'error'));

  if (failingRunId) {
    add('Inspect the failed run message context.', `trace-session --run ${failingRunId} --view messages --messages-view delta`);
    add('Inspect the failed run tool timeline.', `trace-session --run ${failingRunId} --view timeline`);
  }
  if (policyDigest.warnings.length > 0) {
    add('Review budget, rejected-call, and approval adherence.', `${traceTargetCommand(report)} --view policy`);
  }
  if (performanceDigest.topToolSpans.length > 0 || performanceDigest.topRunsByUsage.length > 0) {
    add('Review duration and token hotspots.', `${traceTargetCommand(report)} --view performance`);
  }
  if (suggestions.size === 0) {
    add('Review the concise trace overview.', `${traceTargetCommand(report)} --view overview`);
  }

  return [...suggestions.entries()].map(([command, reason]) => ({ reason, command }));
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

function topToolMetrics(
  tools: PerformanceSummary['tools']['byTool'],
  score: (tool: PerformanceSummary['tools']['byTool'][number]) => number,
): TopToolMetric[] {
  return [...tools]
    .filter((tool) => score(tool) > 0 || tool.started > 0 || tool.failed > 0)
    .sort((left, right) => score(right) - score(left) || left.toolName.localeCompare(right.toolName))
    .slice(0, 5)
    .map((tool) => ({
      toolName: tool.toolName,
      started: tool.started,
      completed: tool.completed,
      failed: tool.failed,
      durationMs: tool.durationMs,
      rawOutputBytes: tool.rawOutputBytes,
      modelOutputBytes: tool.modelOutputBytes,
    }));
}

function buildTopRunsByUsage(report: TraceReport): TopRunUsage[] {
  const rootRunsById = new Map(report.rootRuns.map((run) => [run.rootRunId, run]));
  return report.usage.byRootRun
    .map((item) => {
      const rootRun = rootRunsById.get(item.rootRunId);
      return {
        rootRunId: item.rootRunId,
        runId: rootRun?.runId ?? item.rootRunId,
        goal: rootRun?.goal ?? null,
        promptTokens: item.usage.promptTokens,
        completionTokens: item.usage.completionTokens,
        reasoningTokens: item.usage.reasoningTokens,
        totalTokens: item.usage.totalTokens,
        estimatedCostUSD: item.usage.estimatedCostUSD,
      };
    })
    .filter((item) => item.totalTokens > 0 || item.estimatedCostUSD > 0)
    .sort((left, right) => right.totalTokens - left.totalTokens || right.estimatedCostUSD - left.estimatedCostUSD)
    .slice(0, 5);
}

function traceWallDurationMs(rootRuns: RootRun[], session: SessionOverview | null): number | null {
  let earliestStart: number | null = null;
  let latestEnd: number | null = null;

  for (const run of rootRuns) {
    const start = parseTimestamp(run.startedAt ?? run.linkedAt);
    const end = parseTimestamp(run.completedAt ?? run.updatedAt ?? run.startedAt ?? run.linkedAt);
    if (start === null || end === null || end < start) {
      continue;
    }
    earliestStart = earliestStart === null ? start : Math.min(earliestStart, start);
    latestEnd = latestEnd === null ? end : Math.max(latestEnd, end);
  }

  if (earliestStart !== null && latestEnd !== null) {
    return latestEnd - earliestStart;
  }
  return session ? durationMs(session.createdAt, session.updatedAt) : null;
}

function runCount(report: TraceReport): number {
  const runIds = new Set<string>();
  for (const run of report.rootRuns) {
    runIds.add(run.runId);
  }
  for (const entry of report.runTree ?? []) {
    runIds.add(entry.runId);
  }
  for (const entry of report.timeline) {
    runIds.add(entry.runId);
  }
  for (const trace of report.llmMessages) {
    runIds.add(trace.runId);
  }
  return runIds.size;
}

function traceTargetLabel(report: TraceReport): string {
  switch (report.target.kind) {
    case 'session':
      return `session ${report.target.requestedId}`;
    case 'root-run':
      return `root run ${report.target.requestedId}`;
    case 'run':
      return report.target.resolvedRootRunId
        ? `run ${report.target.requestedId} in root ${report.target.resolvedRootRunId}`
        : `run ${report.target.requestedId}`;
  }
}

function traceTargetCommand(report: TraceReport): string {
  switch (report.target.kind) {
    case 'session':
      return `trace-session ${report.target.requestedId}`;
    case 'root-run':
      return `trace-session --root-run ${report.target.requestedId}`;
    case 'run':
      return `trace-session --run ${report.target.requestedId}`;
  }
}

function emptyPerformanceSummaryForDiagnostics(): PerformanceSummary {
  const bucket = (): PerformanceBucketSummary => ({ count: 0, total: 0, max: 0, average: 0 });
  return {
    events: {
      totalEvents: 0,
      measuredEvents: 0,
      payloadBytes: bucket(),
      emitDurationMs: bucket(),
    },
    model: {
      started: 0,
      completed: 0,
      failed: 0,
      retries: 0,
      requestBytes: bucket(),
      responseBytes: bucket(),
      durationMs: bucket(),
      retryDelayMs: bucket(),
      pendingToolCallCount: bucket(),
      adapterGateWaitMs: bucket(),
      adapterResponseLatencyMs: bucket(),
      adapterRequestBytes: bucket(),
      adapterResponseBytes: bucket(),
      adapterAttemptCount: bucket(),
      adapterRetryDelayMs: bucket(),
      adapterStatusCodes: {},
    },
    tools: {
      started: 0,
      completed: 0,
      failed: 0,
      inputBytes: bucket(),
      eventInputBytes: bucket(),
      rawOutputBytes: bucket(),
      eventOutputBytes: bucket(),
      modelOutputBytes: bucket(),
      durationMs: bucket(),
      childRunDurationMs: bucket(),
      byTool: [],
    },
    snapshots: {
      created: 0,
      stateBytes: bucket(),
      messageBytes: bucket(),
      messageCount: bucket(),
      saveDurationMs: bucket(),
      pendingToolCallBytes: bucket(),
    },
  };
}

function findBudgetExhaustedRecord(value: unknown, depth = 0, seen: Set<object> = new Set()): Record<string, unknown> | null {
  if (depth > 5 || value === null || value === undefined || typeof value !== 'object') {
    return null;
  }
  if (seen.has(value)) {
    return null;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findBudgetExhaustedRecord(item, depth + 1, seen);
      if (match) {
        return match;
      }
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  if (readStringFromRecord(record, 'reason') === 'budget_exhausted') {
    return record;
  }
  for (const item of Object.values(record)) {
    const match = findBudgetExhaustedRecord(item, depth + 1, seen);
    if (match) {
      return match;
    }
  }
  return null;
}

function readStringFromRecord(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isRuntimePolicyMessage(category: string, content: string): boolean {
  if (category !== 'runtime-injected-system' && category !== 'runtime-injected-user') {
    return false;
  }
  const normalized = content.toLowerCase();
  return normalized.includes('budget')
    || normalized.includes('policy')
    || normalized.includes('approval')
    || normalized.includes('tool call')
    || normalized.includes('tool_');
}

function primaryOutcomeEvidence(report: TraceReport): EvidenceRef[] {
  const failedDelegate = report.delegates.find((delegate) => delegate.child_status === 'failed');
  if (failedDelegate) {
    return [delegateEvidence(failedDelegate)];
  }

  const activeDelegate = report.delegates.find((delegate) =>
    ['queued', 'planning', 'running', 'awaiting_approval', 'awaiting_subagent', 'interrupted'].includes(delegate.child_status ?? ''),
  );
  if (activeDelegate) {
    return [delegateEvidence(activeDelegate)];
  }

  const failedRoot = report.rootRuns.find((run) => run.status === 'failed');
  if (failedRoot) {
    return [rootRunEvidence(failedRoot)];
  }

  const failedTimeline = report.timeline.find((entry) => entry.outcome.startsWith('failed'));
  if (failedTimeline) {
    return [toolEvidence(failedTimeline)];
  }

  const blockedRoot = report.rootRuns.find((run) => run.status && !['succeeded', 'failed', 'cancelled'].includes(run.status));
  if (blockedRoot) {
    return [rootRunEvidence(blockedRoot)];
  }

  return [{ kind: 'run', label: traceTargetLabel(report), detail: report.summary.reason }];
}

function modelFailureEvidence(report: TraceReport): EvidenceRef[] {
  const events = (report.milestones ?? [])
    .filter((entry) => entry.eventType === 'model.failed')
    .slice(0, 5)
    .map((entry): EvidenceRef => ({
      kind: 'event',
      label: `${shortId(entry.runId)} #${entry.eventSeq ?? '?'}`,
      rootRunId: entry.rootRunId,
      runId: entry.runId,
      stepId: entry.stepId,
      eventSeq: entry.eventSeq,
      eventType: entry.eventType,
      detail: entry.text,
    }));
  return events.length > 0 ? events : primaryOutcomeEvidence(report);
}

function failedToolEvidence(report: TraceReport): EvidenceRef[] {
  const tools = report.timeline
    .filter((entry) => entry.outcome.startsWith('failed'))
    .slice(0, 5)
    .map(toolEvidence);
  return tools.length > 0 ? tools : primaryOutcomeEvidence(report);
}

function policyEvidence(report: TraceReport, warning: string): EvidenceRef[] {
  if (warning.includes('runtime-injected')) {
    return runtimePolicyMessageEvidence(report);
  }
  if (warning.includes('budget')) {
    return report.timeline
      .filter((entry) => findBudgetExhaustedRecord(entry.output) ?? findBudgetExhaustedRecord(entry.params))
      .slice(0, 5)
      .map(toolEvidence);
  }
  if (warning.includes('rejected')) {
    return (report.milestones ?? [])
      .filter((entry) => entry.eventType === 'model.tool_call_rejected')
      .slice(0, 5)
      .map((entry): EvidenceRef => ({
        kind: 'event',
        label: `${shortId(entry.runId)} #${entry.eventSeq ?? '?'}`,
        rootRunId: entry.rootRunId,
        runId: entry.runId,
        stepId: entry.stepId,
        eventSeq: entry.eventSeq,
        eventType: entry.eventType,
        detail: entry.text,
      }));
  }
  if (warning.includes('approval')) {
    return (report.milestones ?? [])
      .filter((entry) => entry.eventType === 'approval.requested')
      .slice(0, 5)
      .map((entry): EvidenceRef => ({
        kind: 'event',
        label: `${shortId(entry.runId)} #${entry.eventSeq ?? '?'}`,
        rootRunId: entry.rootRunId,
        runId: entry.runId,
        stepId: entry.stepId,
        eventSeq: entry.eventSeq,
        eventType: entry.eventType,
        detail: entry.text,
      }));
  }
  return runtimePolicyMessageEvidence(report);
}

function runtimePolicyMessageEvidence(report: TraceReport): EvidenceRef[] {
  return report.llmMessages
    .flatMap((trace) => trace.effectiveMessages
      .filter((message) => isRuntimePolicyMessage(message.category, message.content))
      .slice(0, 2)
      .map((message): EvidenceRef => ({
        kind: 'message',
        label: `${shortId(trace.runId)} message ${message.position + 1}`,
        rootRunId: trace.rootRunId,
        runId: trace.runId,
        detail: oneLine(message.content),
      })))
    .slice(0, 5);
}

function policyFindingTitle(warning: string): string {
  if (warning.includes('budget')) {
    return 'Tool budget signal observed';
  }
  if (warning.includes('rejected')) {
    return 'Rejected tool call signal observed';
  }
  if (warning.includes('approval')) {
    return 'Approval signal requires inspection';
  }
  return 'Runtime policy message observed';
}

function delegateEvidence(delegate: DelegateRow): EvidenceRef {
  const childRunId = delegate.child_run_id ?? delegate.snapshot_child_run_id ?? undefined;
  return {
    kind: 'delegate',
    label: `${delegate.child_delegate_name ?? delegate.snapshot_delegate_name ?? 'delegate'} ${childRunId ? shortId(childRunId) : '(missing child)'}`,
    rootRunId: delegate.root_run_id,
    runId: childRunId ?? delegate.parent_run_id,
    stepId: delegate.parent_step_id,
    detail: delegate.child_error_message ?? delegate.child_error_code ?? delegate.delegate_reason,
  };
}

function rootRunEvidence(run: RootRun): EvidenceRef {
  return {
    kind: 'root-run',
    label: `${shortId(run.rootRunId)} ${run.status ?? 'unknown'}`,
    rootRunId: run.rootRunId,
    runId: run.runId,
    detail: run.errorMessage ?? run.errorCode ?? run.goal ?? undefined,
  };
}

function toolEvidence(entry: TimelineEntry): EvidenceRef {
  return {
    kind: 'tool',
    label: `${entry.toolName ?? entry.eventType ?? 'tool'} ${entry.stepId ?? '-'}`,
    rootRunId: entry.rootRunId,
    runId: entry.runId,
    stepId: entry.stepId,
    toolCallId: entry.toolCallId,
    eventSeq: entry.eventSeq,
    eventType: entry.eventType,
    detail: entry.outcome,
  };
}

function firstEvidenceRunId(finding: TraceFinding | undefined): string | null {
  if (!finding) {
    return null;
  }
  for (const evidence of finding.evidence) {
    if (evidence.runId) {
      return evidence.runId;
    }
  }
  return null;
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
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

interface ToolCallCountAccumulator {
  toolName: string;
  started: boolean;
  terminalStatus: 'completed' | 'failed' | null;
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

function traceToolName(row: TraceRow): string {
  return row.ledger_tool_name ?? row.event_tool_name ?? payloadString(row.payload, 'toolName') ?? 'unknown';
}

function normalizeToolTerminalStatus(status: string | null): 'completed' | 'failed' | null {
  switch (status) {
    case 'completed':
    case 'succeeded':
      return 'completed';
    case 'failed':
      return 'failed';
    default:
      return null;
  }
}

function normalizeToolEventTerminalStatus(eventType: string | null): 'completed' | 'failed' | null {
  switch (eventType) {
    case 'tool.completed':
      return 'completed';
    case 'tool.failed':
      return 'failed';
    default:
      return null;
  }
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
