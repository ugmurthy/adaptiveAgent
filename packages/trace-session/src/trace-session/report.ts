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
  RecoveryPressure,
  ReliabilityDiagnostics,
  RootRun,
  RunSnapshotSummary,
  RunTreeEntry,
  SessionOverview,
  ToolAccountingSummary,
  TopRunUsage,
  TopToolMetric,
  TimelineEntry,
  TraceDiagnostics,
  TraceAggregateDistribution,
  TraceAggregateGroup,
  TraceAggregateGroupBy,
  TraceAggregateObservation,
  TraceAggregateReport,
  TraceFinding,
  TraceFindingRole,
  TraceFindingSeverity,
  TraceReport,
  TraceRow,
  ComparisonMetric,
  RunAnalysis,
  TraceComparison,
  UsageSummary,
} from './types.js';

const CORE_EVENT_TYPES: EventType[] = [
  'run.created',
  'run.status_changed',
  'run.interrupted',
  'run.steered',
  'run.resumed',
  'run.retry_started',
  'run.completed',
  'run.failed',
  'recovery.analyzed',
  'run.continuation_created',
  'context.refs.resolved',
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
const STALE_RUN_MS = 5 * 60_000;
const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'replan_required']);
const ACTIVE_RUN_STATUSES = new Set(['queued', 'planning', 'running', 'awaiting_subagent']);

type FindingDraft = Omit<TraceFinding, 'id' | 'commands'>;

interface ReliabilitySignals {
  outcomeIssues: FindingDraft[];
  lifecycleIssues: FindingDraft[];
  livenessIssues: FindingDraft[];
  recoveryIssues: FindingDraft[];
  dataIssues: FindingDraft[];
  recovery: RecoveryPressure;
}

export function buildTimeline(rows: TraceRow[], options: { onlyDelegates?: boolean } = {}): TimelineEntry[] {
  const entries = new Map<string, TimelineEntry>();
  const latestOutputsByStep = new Map<string, unknown>();

  for (const row of rows) {
    // delegate.spawned links an already-started delegate tool call to its child
    // run. It is a milestone, not a second tool operation.
    if (row.event_type === 'delegate.spawned') {
      continue;
    }
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
      accounting: payloadValue(row.payload, 'accounting') ?? existing?.accounting,
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

export function buildTraceDiagnostics(report: TraceReport, traceRows: TraceRow[] = []): TraceDiagnostics {
  const performance = report.performance ?? emptyPerformanceSummaryForDiagnostics();
  const wallDurationMs = traceWallDurationMs(report.rootRuns, report.session);
  const performanceDigest = buildPerformanceDigest(report, performance, wallDurationMs);
  const policyDigest = buildPolicyDigest(report);
  const signals = buildReliabilitySignals(report, performance, performanceDigest, policyDigest);
  const reliability = buildReliabilityDiagnostics(report, performance, performanceDigest, policyDigest, signals);
  const findings = buildTraceFindings(report, performance, performanceDigest, policyDigest, signals);
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
    reliability,
    findings,
    performance: performanceDigest,
    policy: policyDigest,
    analysis: { runs: buildRunAnalysis(report, traceRows) },
    suggestedNextViews: buildSuggestedNextViews(report, findings, policyDigest, performanceDigest),
  };
}

export function buildTraceComparison(
  baselineReport: TraceReport,
  candidateReport: TraceReport,
  baselineRunId: string,
  candidateRunId: string,
): TraceComparison {
  const baselineDiagnostics = baselineReport.diagnostics ?? buildTraceDiagnostics(baselineReport);
  const candidateDiagnostics = candidateReport.diagnostics ?? buildTraceDiagnostics(candidateReport);
  const notes: string[] = [];

  const baseline = selectComparisonRun(baselineDiagnostics, baselineRunId, 'baseline', notes);
  const candidate = selectComparisonRun(candidateDiagnostics, candidateRunId, 'candidate', notes);
  const changes = {
    wall: comparisonMetric(baseline?.durations.wallMs, candidate?.durations.wallMs),
    tokens: comparisonMetric(baselineReport.usage.total.totalTokens, candidateReport.usage.total.totalTokens),
    cost: comparisonMetric(
      comparisonRootTreeCost(baselineReport, baselineDiagnostics),
      comparisonRootTreeCost(candidateReport, candidateDiagnostics),
    ),
    retries: comparisonMetric(baseline?.modelCalls.retries, candidate?.modelCalls.retries),
    failures: comparisonMetric(totalFailures(baseline), totalFailures(candidate)),
    contextBytes: comparisonMetric(baseline?.contextGrowth.messageBytesGrowth, candidate?.contextGrowth.messageBytesGrowth),
    outputBytes: comparisonMetric(baseline?.outputBytes, candidate?.outputBytes),
  };
  const toolMix = comparisonToolMix(baseline);
  const candidateToolMix = comparisonToolMix(candidate);
  const providerModelMix = comparisonProviderModelMix(baseline);
  const candidateProviderModelMix = comparisonProviderModelMix(candidate);

  for (const [name, metric] of Object.entries(changes)) {
    if (metric.baseline === null || metric.candidate === null) {
      notes.push(`${name}: comparison is unavailable because one or both runs lack the required measurement.`);
    }
  }
  if (providerModelMix.size === 0 || candidateProviderModelMix.size === 0) {
    notes.push('Provider/model mix is unavailable where persisted or event-backed model identity is absent.');
  }
  notes.push('Token and cost metrics use the resolved root-run tree, matching the usage command; other metrics describe the requested run.');

  return {
    baseline: { runId: baselineRunId, analysis: baseline },
    candidate: { runId: candidateRunId, analysis: candidate },
    changes,
    reliability: {
      baseline: baselineDiagnostics.reliability.classification,
      candidate: candidateDiagnostics.reliability.classification,
      change: `${baselineDiagnostics.reliability.classification} -> ${candidateDiagnostics.reliability.classification}`,
      scope: 'root-tree',
    },
    toolMix: comparisonMixRows(toolMix, candidateToolMix),
    providerModelMix: comparisonMixRows(providerModelMix, candidateProviderModelMix),
    confidence: {
      baseline: baselineDiagnostics.reliability.dataConfidence.level,
      candidate: candidateDiagnostics.reliability.dataConfidence.level,
    },
    notes: [...new Set(notes)],
  };
}

function comparisonRootTreeCost(report: TraceReport, diagnostics: TraceDiagnostics): number {
  return report.usage.total.estimatedCostUSD + diagnostics.performance.toolAccounting.estimatedCostUSD;
}

function selectComparisonRun(
  diagnostics: TraceDiagnostics,
  runId: string,
  side: 'baseline' | 'candidate',
  notes: string[],
): RunAnalysis | null {
  const analysis = diagnostics.analysis.runs.find((run) => run.runId === runId) ?? null;
  if (!analysis) {
    notes.push(`${side}: analysis is unavailable for requested run ${runId}.`);
    return null;
  }
  for (const note of analysis.notes) {
    notes.push(`${side}: ${note}`);
  }
  return analysis;
}

function comparisonMetric(
  baselineValue: number | null | undefined,
  candidateValue: number | null | undefined,
): ComparisonMetric {
  const baseline = baselineValue ?? null;
  const candidate = candidateValue ?? null;
  const delta = baseline === null || candidate === null ? null : candidate - baseline;
  return {
    baseline,
    candidate,
    delta,
    percentageChange: delta === null || baseline === null || baseline === 0
      ? null
      : delta / baseline * 100,
  };
}

function totalFailures(run: RunAnalysis | null): number | null {
  return run ? run.modelCalls.failures + run.toolCalls.failures : null;
}

function comparisonToolMix(run: RunAnalysis | null): Map<string, number> {
  return new Map((run?.toolCalls.byTool ?? []).map((tool) => [tool.toolName, tool.started]));
}

function comparisonProviderModelMix(run: RunAnalysis | null): Map<string, number> {
  if (!run || (!run.provider && !run.model)) {
    return new Map();
  }
  return new Map([[`${run.provider ?? 'unknown'}/${run.model ?? 'unknown'}`, run.modelCalls.starts]]);
}

function comparisonMixRows(baseline: Map<string, number>, candidate: Map<string, number>): TraceComparison['toolMix'] {
  return [...new Set([...baseline.keys(), ...candidate.keys()])]
    .sort()
    .map((label) => ({
      label,
      baselineCount: baseline.get(label) ?? 0,
      candidateCount: candidate.get(label) ?? 0,
      deltaCount: (candidate.get(label) ?? 0) - (baseline.get(label) ?? 0),
    }));
}

export function buildTraceAggregateReport(
  observations: TraceAggregateObservation[],
  groupBy: TraceAggregateGroupBy,
  options: {
    since?: string;
    until?: string;
    limit?: number;
    generatedAt?: string;
  } = {},
): TraceAggregateReport {
  const grouped = new Map<string, TraceAggregateObservation[]>();
  for (const observation of observations) {
    const key = aggregateGroupKey(observation, groupBy);
    const group = grouped.get(key) ?? [];
    group.push(observation);
    grouped.set(key, group);
  }

  const groups = [...grouped.entries()]
    .map(([key, group]) => aggregateObservationGroup(key, key, group))
    .sort((left, right) => groupBy === 'day'
      ? compareDayGroups(left.key, right.key)
      : right.runCount - left.runCount || left.label.localeCompare(right.label));
  const startedTimes = observations
    .map((observation) => parseTimestamp(observation.startedAt))
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);
  const terminal = observations.filter((observation) => isAggregateTerminal(observation));

  return {
    kind: 'trace-aggregate',
    groupBy,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    population: {
      runCount: observations.length,
      terminalRuns: terminal.length,
      activeRuns: observations.length - terminal.length,
      missingDuration: terminal.filter((observation) => observation.wallDurationMs === null).length,
      missingUsage: observations.filter((observation) => observation.totalTokens === null).length,
      missingCost: observations.filter((observation) => observation.estimatedGrandTotalUSD === null).length,
      missingContext: observations.filter((observation) => observation.contextGrowthBytes === null).length,
      earliestStartedAt: startedTimes.length ? new Date(startedTimes[0]!).toISOString() : null,
      latestStartedAt: startedTimes.length ? new Date(startedTimes.at(-1)!).toISOString() : null,
      since: options.since ?? null,
      until: options.until ?? null,
      limit: options.limit ?? null,
    },
    overall: aggregateObservationGroup('all', 'All selected runs', observations),
    groups,
    notes: [
      'Wall-duration percentiles use nearest-rank p50/p90/p95 and include only terminal roots with completed timestamps.',
      'Recovered success means a persisted succeeded root with retry, failure-recovery, resume, replan, or rejected-call activity; it does not evaluate answer quality.',
      'Token and model/tool-output cost totals use the same root-tree accounting as the usage command; external tool-provider cost remains separate.',
      ...(observations.some((observation) => observation.totalTokens === null) ? ['Token averages exclude roots without persisted usage measurements.'] : []),
      ...(observations.some((observation) => observation.estimatedGrandTotalUSD === null) ? ['Cost averages exclude roots with missing model pricing or unpriced external provider requests.'] : []),
      ...(observations.some((observation) => observation.contextGrowthBytes === null) ? ['Context-growth distributions exclude roots without persisted context-size samples.'] : []),
      ...(options.limit === undefined ? [] : ['Aggregates describe the filtered population after --limit was applied.']),
      ...(groupBy === 'day' ? ['Day groups use the root start timestamp normalized to UTC.'] : []),
    ],
  };
}

function aggregateGroupKey(observation: TraceAggregateObservation, groupBy: TraceAggregateGroupBy): string {
  switch (groupBy) {
    case 'model':
      return `${normalizedAggregateLabel(observation.provider)}/${normalizedAggregateLabel(observation.model)}`;
    case 'status':
      return normalizedAggregateLabel(observation.status);
    case 'day': {
      const startedAt = parseTimestamp(observation.startedAt);
      return startedAt === null ? 'unknown' : new Date(startedAt).toISOString().slice(0, 10);
    }
  }
}

function aggregateObservationGroup(
  key: string,
  label: string,
  observations: TraceAggregateObservation[],
): TraceAggregateGroup {
  const runCount = observations.length;
  const succeeded = observations.filter((observation) => observation.status === 'succeeded');
  const recoveredSucceeded = succeeded.filter((observation) => observation.hadRecovery).length;
  const failed = observations.filter((observation) => observation.status === 'failed').length;
  const cancelled = observations.filter((observation) => observation.status === 'cancelled').length;
  const unknown = observations.filter((observation) => !observation.status).length;
  const activeOrBlocked = runCount - succeeded.length - failed - cancelled - unknown;
  const terminalDurations = observations
    .filter((observation) => isAggregateTerminal(observation) && observation.completedAt && observation.wallDurationMs !== null)
    .map((observation) => observation.wallDurationMs!);
  const retryByProviderModel = mergeRetryObservations(observations.flatMap((observation) => observation.retryByProviderModel));
  const toolsByName = mergeToolObservations(observations.flatMap((observation) => observation.tools));
  const errorCodes = countAggregateLabels(observations.flatMap((observation) => observation.errorCodes));

  return {
    key,
    label,
    runCount,
    outcomes: {
      succeeded: succeeded.length,
      recoveredSucceeded,
      failed,
      cancelled,
      activeOrBlocked,
      unknown,
      successRate: aggregateRate(succeeded.length, runCount),
      recoveredSuccessRate: aggregateRate(recoveredSucceeded, runCount),
      failureRate: aggregateRate(failed, runCount),
    },
    wallDurationMs: aggregateDistribution(terminalDurations),
    successfulRuns: {
      count: succeeded.length,
      averageTokens: aggregateAverage(measuredAggregateValues(succeeded.map((observation) => observation.totalTokens))),
      averageModelAndToolOutputCostUSD: aggregateAverage(measuredAggregateValues(succeeded.map((observation) => observation.modelAndToolOutputCostUSD))),
      averageExternalToolProviderCostUSD: aggregateAverage(measuredAggregateValues(succeeded.map((observation) => observation.externalToolProviderCostUSD))),
      averageEstimatedGrandTotalUSD: aggregateAverage(measuredAggregateValues(succeeded.map((observation) => observation.estimatedGrandTotalUSD))),
    },
    modelFailures: observations.reduce((total, observation) => total + observation.modelFailures, 0),
    retries: {
      total: observations.reduce((total, observation) => total + observation.retries, 0),
      runsWithRetries: observations.filter((observation) => observation.retries > 0).length,
      runFrequency: aggregateRate(observations.filter((observation) => observation.retries > 0).length, runCount),
      byProviderModel: retryByProviderModel,
    },
    tools: {
      calls: observations.reduce((total, observation) => total + observation.toolCalls, 0),
      failures: observations.reduce((total, observation) => total + observation.toolFailures, 0),
      failureRate: aggregateRate(
        observations.reduce((total, observation) => total + observation.toolFailures, 0),
        observations.reduce((total, observation) => total + observation.toolCalls, 0),
      ),
      byTool: toolsByName,
    },
    context: {
      growthBytes: aggregateDistribution(observations.flatMap((observation) => observation.contextGrowthBytes === null ? [] : [observation.contextGrowthBytes])),
      peakBytes: aggregateDistribution(observations.flatMap((observation) => observation.peakContextBytes === null ? [] : [observation.peakContextBytes])),
    },
    confidence: {
      high: observations.filter((observation) => observation.dataConfidence === 'high').length,
      medium: observations.filter((observation) => observation.dataConfidence === 'medium').length,
      low: observations.filter((observation) => observation.dataConfidence === 'low').length,
      unknown: observations.filter((observation) => observation.dataConfidence === 'unknown').length,
    },
    commonErrorCodes: errorCodes.map(({ label: code, count }) => ({ code, count })),
  };
}

function aggregateDistribution(values: number[]): TraceAggregateDistribution {
  if (values.length === 0) {
    return { sampleCount: 0, average: null, min: null, p50: null, p90: null, p95: null, max: null };
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    sampleCount: sorted.length,
    average: aggregateAverage(sorted),
    min: sorted[0]!,
    p50: nearestRank(sorted, 50),
    p90: nearestRank(sorted, 90),
    p95: nearestRank(sorted, 95),
    max: sorted.at(-1)!,
  };
}

function nearestRank(sorted: number[], percentile: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.max(0, Math.ceil(percentile / 100 * sorted.length) - 1);
  return sorted[Math.min(index, sorted.length - 1)]!;
}

function aggregateAverage(values: number[]): number | null {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function measuredAggregateValues(values: Array<number | null>): number[] {
  return values.filter((value): value is number => value !== null);
}

function aggregateRate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function mergeRetryObservations(
  observations: TraceAggregateObservation['retryByProviderModel'],
): TraceAggregateObservation['retryByProviderModel'] {
  const groups = new Map<string, TraceAggregateObservation['retryByProviderModel'][number]>();
  for (const observation of observations) {
    const key = `${observation.provider}\n${observation.model}`;
    const current = groups.get(key) ?? {
      provider: observation.provider,
      model: observation.model,
      runs: 0,
      runsWithRetries: 0,
      retries: 0,
    };
    current.runs += observation.runs;
    current.runsWithRetries += observation.runsWithRetries;
    current.retries += observation.retries;
    groups.set(key, current);
  }
  return [...groups.values()].sort((left, right) =>
    right.retries - left.retries
    || right.runsWithRetries - left.runsWithRetries
    || left.provider.localeCompare(right.provider)
    || left.model.localeCompare(right.model)
  );
}

function mergeToolObservations(
  observations: TraceAggregateObservation['tools'],
): TraceAggregateObservation['tools'] {
  const groups = new Map<string, TraceAggregateObservation['tools'][number]>();
  for (const observation of observations) {
    const current = groups.get(observation.toolName) ?? { toolName: observation.toolName, calls: 0, failures: 0 };
    current.calls += observation.calls;
    current.failures += observation.failures;
    groups.set(observation.toolName, current);
  }
  return [...groups.values()].sort((left, right) =>
    right.failures - left.failures
    || right.calls - left.calls
    || left.toolName.localeCompare(right.toolName)
  );
}

function countAggregateLabels(labels: string[]): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return [...counts].map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
    .slice(0, 10);
}

function isAggregateTerminal(observation: TraceAggregateObservation): boolean {
  return Boolean(observation.status && TERMINAL_RUN_STATUSES.has(observation.status));
}

function normalizedAggregateLabel(value: string | null): string {
  return value && value.trim() ? value : 'unknown';
}

function compareDayGroups(left: string, right: string): number {
  if (left === 'unknown') return right === 'unknown' ? 0 : 1;
  if (right === 'unknown') return -1;
  return left.localeCompare(right);
}

function buildRunAnalysis(report: TraceReport, rows: TraceRow[]): RunAnalysis[] {
  if (!rows.length) {
    return report.rootRuns.map((root) => coarseRunAnalysis(root));
  }

  const groups = new Map<string, TraceRow[]>();
  for (const row of rows) {
    const group = groups.get(row.run_id) ?? [];
    group.push(row);
    groups.set(row.run_id, group);
  }

  const wallByRun = new Map([...groups].map(([runId, runRows]) => [runId, rowWall(runRows[0]!) ?? 0]));
  return [...groups.values()].map((runRows) => {
    const first = runRows[0]!;
    const performance = summarizePerformance(runRows);
    const events = dedupeEvents(runRows);
    const wallMs = rowWall(first);
    const modelSpans = events
      .filter((row) => row.event_type === 'model.completed' || row.event_type === 'model.failed')
      .map((row) =>
        payloadNestedNumber(row.payload, 'performance', 'durationMs')
        ?? payloadNumber(row.payload, 'durationMs')
      )
      .filter((value): value is number => value !== null);
    const modelMs = modelSpans.reduce((total, duration) => total + duration, 0);
    const toolMs = performance.tools.durationMs.total;
    const snapshotMs = performance.snapshots.saveDurationMs.total;
    const cumulativeMeasuredMs = modelMs + toolMs + snapshotMs;
    const modelStarts = events.filter((row) => row.event_type === 'model.started').length;
    const modelFailures = events.filter((row) => row.event_type === 'model.failed').length;
    const runtimeRetries = events.filter((row) =>
      row.event_type === 'model.retry' && payloadString(row.payload, 'phase') === 'runtime'
    ).length;
    const adapterRetries = events.filter((row) =>
      row.event_type === 'model.retry' && payloadString(row.payload, 'phase') !== 'runtime'
    ).length;
    const retries = runtimeRetries + adapterRetries;
    const logicalCalls = Math.max(0, modelStarts - runtimeRetries);
    const attempts = modelStarts + adapterRetries;
    const retryDelayMs = events
      .filter((row) => row.event_type === 'model.retry')
      .reduce((total, row) => total + (
        payloadNumber(row.payload, 'retryDelayMs')
        ?? payloadNestedNumber(row.payload, 'performance', 'retryDelayMs')
        ?? 0
      ), 0);
    const persistedUsage = createUsageSummary(
      first.total_prompt_tokens,
      first.total_completion_tokens,
      first.total_reasoning_tokens,
      first.estimated_cost_usd,
    );
    const latestUsageEvent = [...events].reverse().find((row) => row.event_type === 'usage.updated');
    const fallbackUsage = usageFromPayload(latestUsageEvent?.payload);
    const runUsage = createUsageSummary(
      persistedUsage.promptTokens || fallbackUsage.promptTokens,
      persistedUsage.completionTokens || fallbackUsage.completionTokens,
      persistedUsage.reasoningTokens || fallbackUsage.reasoningTokens,
      persistedUsage.estimatedCostUSD || fallbackUsage.estimatedCostUSD,
    );
    const toolUsage = completedToolUsage(runRows);
    const combined = addUsage(runUsage, toolUsage);
    const context = contextGrowth(events);
    const external = buildToolAccountingSummary(report.timeline.filter((entry) => entry.runId === first.run_id));
    const children = [...groups.values()].map((group) => group[0]!).filter((row) => row.parent_run_id === first.run_id);
    const rawOutputBytes = performance.tools.rawOutputBytes.total;
    const modelVisibleOutputBytes = performance.tools.modelOutputBytes.total;
    const latestModelEvent = [...events].reverse().find((row) =>
      row.event_type === 'model.started'
      || row.event_type === 'model.completed'
      || row.event_type === 'model.failed'
      || row.event_type === 'model.retry'
    );
    const latestUsagePayload = asRecord(payloadValue(latestUsageEvent?.payload, 'usage'));
    const provider = nonEmptyString(first.model_provider)
      ?? payloadString(latestModelEvent?.payload, 'provider')
      ?? nonEmptyString(latestUsagePayload?.provider);
    const model = nonEmptyString(first.model_name)
      ?? payloadString(latestModelEvent?.payload, 'model')
      ?? nonEmptyString(latestUsagePayload?.model);
    const performanceCoverage = events.length ? performance.events.measuredEvents / events.length : null;
    const costCoverage = external.totalRequests
      ? (external.totalRequests - external.unpricedRequests) / external.totalRequests
      : null;
    const notes: string[] = [];
    if (events.length === 0) notes.push('Per-run event analysis is unavailable; only persisted run fields are shown.');
    if (performanceCoverage !== null && performanceCoverage < 1) notes.push(`Performance payload coverage is ${Math.round(performanceCoverage * 100)}%.`);
    if (context.source === 'unavailable') notes.push('Context growth is unavailable because no message size/count samples were persisted.');
    if (!provider && !model) notes.push('Provider/model identity is unavailable.');
    if (external.unpricedRequests > 0) notes.push(`${external.unpricedRequests} external provider request(s) are unpriced.`);

    return {
      rootRunId: first.root_run_id,
      runId: first.run_id,
      parentRunId: first.parent_run_id,
      delegateName: first.run_delegate_name,
      depth: first.delegation_depth ?? 0,
      status: first.run_status,
      provider,
      model,
      durations: {
        wallMs,
        modelMs,
        toolMs,
        snapshotMs,
        cumulativeMeasuredMs,
        otherMs: wallMs === null ? null : Math.max(0, wallMs - cumulativeMeasuredMs),
        unexplainedWallPercentage: wallMs && wallMs > 0
          ? Math.max(0, wallMs - cumulativeMeasuredMs) / wallMs * 100
          : null,
        parallelism: wallMs && wallMs > 0 ? cumulativeMeasuredMs / wallMs : null,
        ...(first.run_status === 'awaiting_subagent'
          ? { delegateWaitNote: 'Wall time may include awaiting_subagent delegate wait; child work is reported separately.' }
          : {}),
      },
      modelCalls: {
        starts: modelStarts,
        runtimeRetries,
        adapterRetries,
        retries,
        retryDelayMs,
        attempts,
        logicalCalls,
        retryAmplification: logicalCalls > 0 ? attempts / logicalCalls : null,
        failures: modelFailures,
        failureRate: modelStarts ? modelFailures / modelStarts : null,
        slowestSpanMs: modelSpans.length ? Math.max(...modelSpans) : null,
      },
      toolCalls: {
        starts: performance.tools.started,
        failures: performance.tools.failed,
        failureRate: performance.tools.started ? performance.tools.failed / performance.tools.started : null,
        slowestSpanMs: performance.tools.durationMs.count ? performance.tools.durationMs.max : null,
        rawOutputBytes,
        modelVisibleOutputBytes,
        rawToModelRatio: modelVisibleOutputBytes ? rawOutputBytes / modelVisibleOutputBytes : null,
        reductionPercentage: rawOutputBytes ? (rawOutputBytes - modelVisibleOutputBytes) / rawOutputBytes * 100 : null,
        byTool: performance.tools.byTool,
      },
      usage: {
        runModel: runUsage,
        nonDelegateToolOutput: toolUsage,
        combined,
        promptCompletionRatio: combined.completionTokens ? combined.promptTokens / combined.completionTokens : null,
      },
      costs: {
        modelEstimateUSD: runUsage.estimatedCostUSD,
        toolOutputEstimateUSD: toolUsage.estimatedCostUSD,
        externalToolProviderEstimateUSD: external.estimatedCostUSD,
        estimatedGrandTotalUSD: combined.estimatedCostUSD + external.estimatedCostUSD,
        unpricedProviderRequests: external.unpricedRequests,
      },
      contextGrowth: context,
      replanCount: events.filter((row) => row.event_type === 'replan.required').length,
      approvalRequestCount: events.filter((row) => row.event_type === 'approval.requested').length,
      approvalResolvedCount: events.filter((row) => row.event_type === 'approval.resolved').length,
      directChildFanOut: children.length,
      cumulativeDirectChildWallMs: children.reduce((total, child) => total + (wallByRun.get(child.run_id) ?? 0), 0),
      outputBytes: byteLength(first.run_result),
      coverage: {
        events: events.length,
        performance: performanceCoverage,
        snapshots: performance.snapshots.created,
        cost: costCoverage,
      },
      notes,
    };
  }).sort((left, right) => left.depth - right.depth || left.runId.localeCompare(right.runId));
}

function dedupeEvents(rows: TraceRow[]): TraceRow[] {
  const seen = new Set<string>();
  return rows
    .filter((row, index) => {
      if (!row.event_type) return false;
      const key = row.event_id ?? `${row.run_id}:${row.event_seq ?? row.event_created_at ?? index}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) =>
      (left.event_seq ?? Infinity) - (right.event_seq ?? Infinity)
      || compareTime(left.event_created_at, right.event_created_at)
    );
}

function rowWall(row: TraceRow): number | null {
  return durationMs(row.run_created_at, row.run_completed_at ?? row.run_updated_at);
}

function byteLength(value: unknown): number {
  if (value === null || value === undefined) return 0;
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text === undefined ? 0 : Buffer.byteLength(text);
  } catch {
    return 0;
  }
}

function createUsageSummary(prompt: unknown, completion: unknown, reasoning: unknown, cost: unknown): UsageSummary {
  const promptTokens = finiteNumber(prompt) ?? 0;
  const completionTokens = finiteNumber(completion) ?? 0;
  const reasoningTokens = finiteNumber(reasoning) ?? 0;
  return {
    promptTokens,
    completionTokens,
    reasoningTokens,
    totalTokens: promptTokens + completionTokens + reasoningTokens,
    estimatedCostUSD: finiteNumber(cost) ?? 0,
  };
}

function usageFromPayload(payload: unknown): UsageSummary {
  const outer = asRecord(payload) ?? {};
  const usagePayload = asRecord(outer.usage) ?? outer;
  const completionDetails = asRecord(usagePayload.completionTokensDetails)
    ?? asRecord(usagePayload.completion_tokens_details);
  const costDetails = asRecord(usagePayload.costDetails) ?? asRecord(usagePayload.cost_details);
  const costBreakdown = asRecord(usagePayload.costBreakdown) ?? asRecord(usagePayload.cost_breakdown);
  const splitCost = sumFiniteNumbers(
    firstFiniteNumber(costDetails?.upstream_inference_prompt_cost, costBreakdown?.prompt_cost),
    firstFiniteNumber(
      costDetails?.upstream_inference_completions_cost,
      costBreakdown?.completion_cost,
      costBreakdown?.completions_cost,
    ),
  );
  const cost = firstNonZeroFiniteNumber(
    usagePayload.estimatedCostUSD,
    usagePayload.estimated_cost_usd,
    usagePayload.costUSD,
    usagePayload.cost_usd,
    usagePayload.totalCostUSD,
    usagePayload.total_cost_usd,
    usagePayload.cost,
    usagePayload.total_cost,
    costDetails?.upstream_inference_cost,
    splitCost,
    outer.estimatedCostUSD,
    outer.estimated_cost_usd,
    outer.costUSD,
    outer.cost_usd,
    outer.totalCostUSD,
    outer.total_cost_usd,
    outer.cost,
    outer.total_cost,
  );
  return createUsageSummary(
    usagePayload.promptTokens ?? usagePayload.prompt_tokens ?? usagePayload.inputTokens ?? usagePayload.input_tokens,
    usagePayload.completionTokens ?? usagePayload.completion_tokens ?? usagePayload.outputTokens ?? usagePayload.output_tokens,
    usagePayload.reasoningTokens ?? usagePayload.reasoning_tokens
      ?? completionDetails?.reasoningTokens ?? completionDetails?.reasoning_tokens,
    cost,
  );
}

function addUsage(left: UsageSummary, right: UsageSummary): UsageSummary {
  return createUsageSummary(
    left.promptTokens + right.promptTokens,
    left.completionTokens + right.completionTokens,
    (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0),
    left.estimatedCostUSD + right.estimatedCostUSD,
  );
}

function completedToolUsage(rows: TraceRow[]): UsageSummary {
  const seen = new Set<string>();
  let total = createUsageSummary(0, 0, 0, 0);
  for (const row of rows) {
    const key = `${row.run_id}:${row.tool_call_id}`;
    if (
      !row.tool_call_id
      || seen.has(key)
      || row.child_run_id
      || row.tool_execution_status !== 'completed'
    ) {
      continue;
    }
    seen.add(key);
    total = addUsage(total, usageFromPayload(row.tool_output));
  }
  return total;
}

function contextGrowth(events: TraceRow[]): RunAnalysis['contextGrowth'] {
  const snapshots = events.filter((event) =>
    event.event_type === 'snapshot.created' && asRecord(payloadValue(event.payload, 'performance'))
  );
  const selected = snapshots.length > 0
    ? snapshots
    : events.filter((event) =>
        event.event_type === 'model.started' && asRecord(payloadValue(event.payload, 'performance'))
      );
  const samples = selected
    .map((event) => {
      const performance = asRecord(payloadValue(event.payload, 'performance'))!;
      return {
        bytes: nullableFiniteNumber(performance.messageBytes ?? performance.message_bytes),
        count: nullableFiniteNumber(performance.messageCount ?? performance.message_count),
      };
    })
    .filter((sample) => sample.bytes !== null || sample.count !== null);
  const bytes = samples.flatMap((sample) => sample.bytes === null ? [] : [sample.bytes]);
  const counts = samples.flatMap((sample) => sample.count === null ? [] : [sample.count]);
  const initialBytes = bytes[0] ?? null;
  const latestBytes = bytes.at(-1) ?? null;
  const initialCount = counts[0] ?? null;
  const latestCount = counts.at(-1) ?? null;

  return {
    source: samples.length > 0 ? (snapshots.length > 0 ? 'snapshot' : 'model-request') : 'unavailable',
    samples: samples.length,
    initialMessageBytes: initialBytes,
    latestMessageBytes: latestBytes,
    peakMessageBytes: bytes.length ? Math.max(...bytes) : null,
    messageBytesGrowth: growth(initialBytes, latestBytes),
    messageBytesGrowthPercentage: growthPercentage(initialBytes, latestBytes),
    initialMessageCount: initialCount,
    latestMessageCount: latestCount,
    peakMessageCount: counts.length ? Math.max(...counts) : null,
    messageCountGrowth: growth(initialCount, latestCount),
    messageCountGrowthPercentage: growthPercentage(initialCount, latestCount),
  };
}

function growth(initial: number | null | undefined, latest: number | null | undefined): number | null {
  return initial === null || initial === undefined || latest === null || latest === undefined
    ? null
    : latest - initial;
}

function growthPercentage(initial: number | null | undefined, latest: number | null | undefined): number | null {
  const delta = growth(initial, latest);
  return delta === null || !initial ? null : delta / initial * 100;
}

function nullableFiniteNumber(value: unknown): number | null {
  return value === null || value === undefined || value === '' ? null : finiteNumber(value);
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const parsed = finiteNumber(value);
    if (parsed !== null) return parsed;
  }
  return undefined;
}

function firstNonZeroFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = finiteNumber(value);
    if (parsed !== null && parsed !== 0) return parsed;
  }
  return undefined;
}

function sumFiniteNumbers(...values: unknown[]): number | undefined {
  let total = 0;
  let found = false;
  for (const value of values) {
    const parsed = finiteNumber(value);
    if (parsed === null) continue;
    total += parsed;
    found = true;
  }
  return found ? total : undefined;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function coarseRunAnalysis(root: RootRun): RunAnalysis {
  const row = {
    root_run_id: root.rootRunId,
    run_id: root.runId,
    parent_run_id: null,
    run_delegate_name: null,
    delegation_depth: 0,
    run_status: root.status,
    run_created_at: root.startedAt ?? null,
    run_updated_at: root.updatedAt ?? null,
    run_completed_at: root.completedAt ?? null,
    run_result: root.result,
    model_provider: root.modelProvider,
    model_name: root.modelName,
  } as TraceRow;
  return buildRunAnalysis({ rootRuns: [], timeline: [] } as unknown as TraceReport, [row])[0]!;
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
  const toolAccounting = buildToolAccountingSummary(report.timeline);
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
  if (toolAccounting.unpricedRequests > 0) {
    notes.push(`${toolAccounting.unpricedRequests} provider request(s) did not have configured per-request pricing, so tool cost is under-estimated.`);
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
    toolAccounting,
    notes,
  };
}

function buildToolAccountingSummary(timeline: TimelineEntry[]): ToolAccountingSummary {
  const groups = new Map<string, ToolAccountingSummary['byProviderOperation'][number]>();
  let totalRequests = 0;
  let billableRequests = 0;
  let cachedToolCalls = 0;
  let unpricedRequests = 0;
  let estimatedCostUSD = 0;

  for (const entry of timeline) {
    const accounting = readToolAccounting(entry.accounting);
    if (!accounting) {
      continue;
    }

    const key = `${accounting.provider}\n${accounting.operation}`;
    const group = groups.get(key) ?? {
      provider: accounting.provider,
      operation: accounting.operation,
      toolCalls: 0,
      requests: 0,
      billableRequests: 0,
      cachedToolCalls: 0,
      unpricedRequests: 0,
      estimatedCostUSD: 0,
    };

    group.toolCalls += 1;
    group.requests += accounting.requests;
    totalRequests += accounting.requests;

    if (accounting.billable) {
      group.billableRequests += accounting.requests;
      billableRequests += accounting.requests;
    }
    if (accounting.cached) {
      group.cachedToolCalls += 1;
      cachedToolCalls += 1;
    }
    if (accounting.estimatedCostUSD === undefined && accounting.requests > 0) {
      group.unpricedRequests += accounting.requests;
      unpricedRequests += accounting.requests;
    } else if (accounting.estimatedCostUSD !== undefined) {
      group.estimatedCostUSD += accounting.estimatedCostUSD;
      estimatedCostUSD += accounting.estimatedCostUSD;
    }

    groups.set(key, group);
  }

  return {
    totalRequests,
    billableRequests,
    cachedToolCalls,
    unpricedRequests,
    estimatedCostUSD,
    byProviderOperation: [...groups.values()].sort((left, right) =>
      right.estimatedCostUSD - left.estimatedCostUSD
      || right.requests - left.requests
      || left.provider.localeCompare(right.provider)
      || left.operation.localeCompare(right.operation),
    ),
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
  const unresolvedApprovalRequests = unresolvedApprovalEvents(report).length;
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
  signals: ReliabilitySignals,
): TraceFinding[] {
  const findings: FindingDraft[] = [
    ...signals.outcomeIssues,
    ...signals.lifecycleIssues,
    ...signals.livenessIssues,
    ...signals.recoveryIssues,
    ...signals.dataIssues,
  ];
  const pushFinding = (finding: FindingDraft): void => {
    findings.push(finding);
  };
  const modelFailures = Math.max(performance.model.failed, countMilestones(report, 'model.failed'));
  const toolFailures = Math.max(performance.tools.failed, report.timeline.filter((entry) => entry.outcome.startsWith('failed')).length);
  const terminalSuccess = report.summary.status === 'succeeded';

  if (modelFailures > 0) {
    pushFinding({
      severity: terminalSuccess ? 'warning' : 'error',
      category: 'failure',
      role: terminalSuccess ? 'recovery' : 'primary-cause',
      title: 'Model failures observed',
      summary: `${modelFailures} model lifecycle events ended in failure${terminalSuccess ? ' before the trace ultimately succeeded' : ''}.`,
      evidence: modelFailureEvidence(report),
    });
  }

  if (toolFailures > 0) {
    pushFinding({
      severity: terminalSuccess ? 'warning' : 'error',
      category: 'failure',
      role: terminalSuccess ? 'recovery' : 'primary-cause',
      title: 'Tool failures observed',
      summary: `${toolFailures} tool executions ended in failure${terminalSuccess ? ' before the trace ultimately succeeded' : ''}.`,
      evidence: failedToolEvidence(report),
    });
  }

  if (report.summary.status === 'failed' || report.summary.status === 'blocked') {
    const hasSpecificCause = findings.some((finding) => finding.role === 'primary-cause' && finding.category !== 'data-quality');
    pushFinding({
      severity: report.summary.status === 'failed' ? 'error' : 'warning',
      category: report.summary.status === 'failed' ? 'failure' : 'blocked',
      role: hasSpecificCause ? 'consequence' : 'primary-cause',
      title: report.summary.status === 'failed' ? 'Trace failed' : 'Trace is blocked',
      summary: report.summary.reason,
      evidence: primaryOutcomeEvidence(report),
    });
  }

  if (performanceDigest.parallelismFactor !== null && performanceDigest.parallelismFactor > 1.25) {
    pushFinding({
      severity: performanceDigest.parallelismFactor >= 2 ? 'warning' : 'info',
      category: 'performance',
      role: 'context',
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
        role: 'context',
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
      role: warning.includes('without matching approval.resolved') && report.summary.status === 'blocked'
        ? 'primary-cause'
        : warning.includes('runtime-injected') ? 'context' : 'consequence',
      title: policyFindingTitle(warning),
      summary: warning,
      evidence: policyEvidence(report, warning),
    });
  }

  for (const warning of report.warnings) {
    pushFinding({
      severity: 'warning',
      category: 'data-quality',
      role: 'context',
      title: 'Trace data warning',
      summary: warning,
      evidence: [{ kind: 'event', label: 'trace warning', detail: warning }],
    });
  }

  const roleOrder: Record<TraceFindingRole, number> = {
    'primary-cause': 0,
    recovery: 1,
    consequence: 2,
    context: 3,
  };
  const severityOrder: Record<TraceFindingSeverity, number> = { error: 0, warning: 1, info: 2 };
  return findings
    .sort((left, right) =>
      roleOrder[left.role] - roleOrder[right.role]
      || severityOrder[left.severity] - severityOrder[right.severity]
      || left.title.localeCompare(right.title),
    )
    .map((finding, index) => ({
      id: `finding-${index + 1}`,
      ...finding,
      commands: inspectionCommands(report, finding),
    }));
}

function buildReliabilitySignals(
  report: TraceReport,
  performance: PerformanceSummary,
  performanceDigest: PerformanceDigest,
  policyDigest: PolicyDigest,
): ReliabilitySignals {
  const recovery = buildRecoveryPressure(report, performance, policyDigest);
  const outcomeIssues = detectOutcomeIssues(report);
  const lifecycleIssues = detectLifecycleIssues(report);
  const livenessIssues = detectLivenessIssues(report);
  const recoveryIssues = detectRecoveryIssues(report, recovery);
  const dataConfidence = buildDataConfidence(report, performance, performanceDigest);
  const confidenceIssues: FindingDraft[] = dataConfidence.level === 'high' || (dataConfidence.level === 'unknown' && dataConfidence.totalRuns === 0)
    ? []
    : [{
        severity: dataConfidence.level === 'low' ? 'warning' : 'info',
        category: 'data-quality',
        role: 'context',
        title: `${capitalize(dataConfidence.level)} evidence confidence`,
        summary: dataConfidenceSummary(dataConfidence),
        evidence: dataConfidenceEvidence(report, dataConfidence),
      }];
  const dataIssues = [...confidenceIssues, ...detectContextIssues(report)];

  return { outcomeIssues, lifecycleIssues, livenessIssues, recoveryIssues, dataIssues, recovery };
}

function buildReliabilityDiagnostics(
  report: TraceReport,
  performance: PerformanceSummary,
  performanceDigest: PerformanceDigest,
  policyDigest: PolicyDigest,
  signals: ReliabilitySignals,
): ReliabilityDiagnostics {
  const dataConfidence = buildDataConfidence(report, performance, performanceDigest);
  const hasRecovery = recoveryActivityCount(signals.recovery) > 0
    || performance.model.failed > 0
    || performance.tools.failed > 0;
  const lifecycleStatus = signals.lifecycleIssues.length > 0
    ? 'degraded'
    : dataConfidence.observedEvents === 0 && dataConfidence.totalRuns > 0 ? 'unknown' : 'healthy';
  const policyStatus = policyDigest.unresolvedApprovalRequests > 0
    ? 'blocked'
    : policyDigest.budgetExhaustedToolCalls > 0 ? 'degraded'
      : policyDigest.rejectedToolCalls > 0 ? 'recovered' : 'healthy';
  const evidenceStatus = dataConfidence.level === 'high'
    ? 'healthy'
    : dataConfidence.level === 'unknown' ? 'unknown' : 'degraded';
  const outcomeStatus = report.summary.status === 'succeeded'
    ? signals.outcomeIssues.length > 0 ? 'degraded' : 'healthy'
    : report.summary.status;
  const recoveryStatus = signals.recovery.excessive
    ? 'degraded'
    : hasRecovery ? 'recovered' : 'healthy';
  const livenessStatus = signals.livenessIssues.length > 0 || report.summary.status === 'blocked'
    ? 'blocked'
    : 'healthy';

  let classification: ReliabilityDiagnostics['classification'];
  if (report.summary.status === 'failed') {
    classification = 'failed';
  } else if (report.summary.status === 'blocked' || signals.livenessIssues.length > 0) {
    classification = 'blocked';
  } else if (report.summary.status === 'unknown') {
    classification = 'unknown';
  } else if (
    signals.outcomeIssues.length > 0
    || signals.lifecycleIssues.length > 0
    || signals.recovery.excessive
    || policyDigest.unresolvedApprovalRequests > 0
    || policyDigest.budgetExhaustedToolCalls > 0
    || dataConfidence.level !== 'high'
  ) {
    classification = 'degraded';
  } else if (hasRecovery) {
    classification = 'recovered';
  } else {
    classification = 'healthy';
  }

  return {
    classification,
    summary: reliabilityClassificationSummary(classification, report),
    dimensions: {
      outcomeIntegrity: {
        status: outcomeStatus,
        summary: outcomeDimensionSummary(report, signals.outcomeIssues),
        evidence: findingEvidence(signals.outcomeIssues),
      },
      lifecycleIntegrity: {
        status: lifecycleStatus,
        summary: lifecycleStatus === 'healthy'
          ? 'Observed model, tool, step, run, and snapshot lifecycle evidence is coherent.'
          : lifecycleStatus === 'unknown' ? 'No runtime lifecycle events were available to verify operation pairing.'
            : `${signals.lifecycleIssues.length} lifecycle integrity issue(s) require inspection.`,
        evidence: findingEvidence(signals.lifecycleIssues),
      },
      recoveryPressure: {
        status: recoveryStatus,
        summary: recoveryPressureSummary(signals.recovery),
        evidence: findingEvidence(signals.recoveryIssues),
      },
      liveness: {
        status: livenessStatus,
        summary: signals.livenessIssues.length > 0
          ? `${signals.livenessIssues.length} stale or expired active-run condition(s) were detected.`
          : report.summary.status === 'blocked' ? 'The trace has non-terminal work requiring operator or user action.'
            : 'No stale heartbeat or expired lease evidence was detected.',
        evidence: findingEvidence(signals.livenessIssues),
      },
      policyIntegrity: {
        status: policyStatus,
        summary: policyDimensionSummary(policyDigest),
        evidence: policyDigest.unresolvedApprovalRequests > 0
          ? unresolvedApprovalEvents(report).map(milestoneEvidence).slice(0, 5)
          : [],
      },
      evidenceConfidence: {
        status: evidenceStatus,
        summary: dataConfidenceSummary(dataConfidence),
        evidence: dataConfidenceEvidence(report, dataConfidence),
      },
    },
    recovery: signals.recovery,
    dataConfidence,
    outputQuality: {
      status: 'not-evaluated',
      summary: 'Output quality was not evaluated; runtime reliability does not establish answer quality.',
    },
  };
}

function buildRecoveryPressure(
  report: TraceReport,
  performance: PerformanceSummary,
  policyDigest: PolicyDigest,
): RecoveryPressure {
  const retryEvents = (report.milestones ?? []).filter((entry) => entry.eventType === 'model.retry');
  const modelRetries = Math.max(retryEvents.length, performance.model.retries);
  const eventRetryDelayMs = retryEvents.reduce((total, entry) => total + (entry.retryDelayMs ?? 0), 0);
  const runRetries = countMilestones(report, 'run.retry_started');
  const interruptions = countMilestones(report, 'run.interrupted');
  const resumes = countMilestones(report, 'run.resumed');
  const continuations = countMilestones(report, 'run.continuation_created');
  const replans = countMilestones(report, 'replan.required');
  return {
    modelRetries,
    modelRetryDelayMs: eventRetryDelayMs > 0 ? eventRetryDelayMs : performance.model.retryDelayMs.total,
    runRetries,
    interruptions,
    resumes,
    continuations,
    replans,
    rejectedToolCalls: policyDigest.rejectedToolCalls,
    excessive: modelRetries >= 3 || runRetries >= 2 || resumes >= 3 || replans >= 2,
  };
}

function detectOutcomeIssues(report: TraceReport): FindingDraft[] {
  const findings: FindingDraft[] = [];
  const missingResults = report.rootRuns.filter((run) => run.status === 'succeeded' && (run.result === null || run.result === undefined));
  if (missingResults.length > 0) {
    findings.push({
      severity: 'warning',
      category: 'data-quality',
      role: 'consequence',
      title: 'Succeeded root run has no result',
      summary: `${missingResults.length} succeeded root run(s) have no persisted result.`,
      evidence: missingResults.slice(0, 5).map(rootRunEvidence),
    });
  }

  const conflicts = new Map<string, EvidenceRef>();
  for (const delegate of report.delegates) {
    if (delegate.parent_status === 'succeeded' && delegate.child_status === 'failed') {
      conflicts.set(`${delegate.parent_run_id}:${delegate.child_run_id}`, delegateEvidence(delegate));
    }
  }
  const runs = report.runTree ?? [];
  const runsById = new Map(runs.map((run) => [run.runId, run]));
  for (const child of runs) {
    const parent = child.parentRunId ? runsById.get(child.parentRunId) : undefined;
    if (child.status === 'failed' && parent?.status === 'succeeded') {
      conflicts.set(`${parent.runId}:${child.runId}`, runTreeEvidence(child, 'failed child of succeeded parent'));
    }
  }
  if (conflicts.size > 0) {
    findings.push({
      severity: 'error',
      category: 'failure',
      role: 'primary-cause',
      title: 'Parent and child outcomes conflict',
      summary: `${conflicts.size} failed child run(s) are attached to apparently succeeded parents.`,
      evidence: [...conflicts.values()].slice(0, 5),
    });
  }
  return findings;
}

function detectLifecycleIssues(report: TraceReport): FindingDraft[] {
  const findings: FindingDraft[] = [];
  const incomplete: EvidenceRef[] = [];
  const impossible: EvidenceRef[] = [];
  const milestones = report.milestones ?? [];

  detectEventPairs('model.started', new Set<EventType>(['model.completed', 'model.failed']));
  detectEventPairs('step.started', new Set<EventType>(['step.completed']));

  for (const entry of report.timeline) {
    if (entry.startedAt && !entry.completedAt && !entry.outcome.startsWith('failed')) {
      incomplete.push(toolEvidence(entry));
    }
  }

  if (milestones.length > 0) {
    for (const run of reliabilityRuns(report)) {
      if (!run.status || !TERMINAL_RUN_STATUSES.has(run.status) || run.status === 'cancelled') {
        continue;
      }
      const expectedEvent = run.status === 'succeeded' ? 'run.completed'
        : run.status === 'failed' ? 'run.failed' : 'replan.required';
      if (!milestones.some((entry) => entry.runId === run.runId && entry.eventType === expectedEvent)) {
        incomplete.push(runRecordEvidence(run, `status=${run.status}; missing ${expectedEvent}`));
      }
    }
  }

  if (incomplete.length > 0 || impossible.length > 0) {
    findings.push({
      severity: 'warning',
      category: 'data-quality',
      role: 'context',
      title: 'Incomplete lifecycle evidence',
      summary: `${incomplete.length} started or terminal operations lack matching lifecycle evidence${impossible.length > 0 ? `; ${impossible.length} terminal events appeared without a matching start` : ''}.`,
      evidence: [...incomplete, ...impossible].slice(0, 10),
    });
  }

  const snapshotProblems = detectSnapshotSequenceProblems(report);
  if (snapshotProblems.length > 0) {
    findings.push({
      severity: 'warning',
      category: 'data-quality',
      role: 'consequence',
      title: 'Snapshot sequence integrity issue',
      summary: `${snapshotProblems.length} snapshot sequence gap or regression condition(s) were detected.`,
      evidence: snapshotProblems,
    });
  }

  const resumedWithoutSnapshot = detectResumesWithoutSnapshots(report);
  if (resumedWithoutSnapshot.length > 0) {
    findings.push({
      severity: 'warning',
      category: 'data-quality',
      role: 'recovery',
      title: 'Resume lacks prior snapshot evidence',
      summary: `${resumedWithoutSnapshot.length} resume event(s) do not have a preceding snapshot in the persisted event stream.`,
      evidence: resumedWithoutSnapshot,
    });
  }

  return findings;

  function detectEventPairs(startType: EventType, terminalTypes: Set<EventType>): void {
    const open = new Map<string, MilestoneEntry[]>();
    for (const entry of milestones) {
      const key = `${entry.runId}:${entry.stepId ?? '-'}`;
      if (entry.eventType === startType) {
        const pending = open.get(key) ?? [];
        pending.push(entry);
        open.set(key, pending);
      } else if (terminalTypes.has(entry.eventType)) {
        const pending = (open.get(key) ?? [])
          .filter((started) => !operationWasSupersededByRecovery(started, milestones, entry));
        open.set(key, pending);
        const started = pending?.shift();
        if (!started) {
          impossible.push(milestoneEvidence(entry));
        }
      }
    }
    for (const pending of open.values()) {
      incomplete.push(...pending
        .filter((started) => !operationWasSupersededByRecovery(started, milestones))
        .map(milestoneEvidence));
    }
  }
}

function detectContextIssues(report: TraceReport): FindingDraft[] {
  const missingToolContext = detectMissingToolContext(report);
  if (missingToolContext.length === 0) {
    return [];
  }
  return [{
    severity: 'warning',
    category: 'data-quality',
    role: 'context',
    title: 'Tool output is absent from model context',
    summary: `${missingToolContext.length} completed tool output(s) were not found in the loaded snapshot-backed model context.`,
    evidence: missingToolContext,
  }];
}

function detectLivenessIssues(report: TraceReport): FindingDraft[] {
  const stale: EvidenceRef[] = [];
  const now = Date.now();
  for (const run of reliabilityRuns(report)) {
    if (!run.status || TERMINAL_RUN_STATUSES.has(run.status)) {
      continue;
    }
    const leaseExpiry = parseTimestamp(run.leaseExpiresAt);
    const heartbeat = parseTimestamp(run.heartbeatAt);
    const updatedAt = parseTimestamp(run.updatedAt);
    const expiredLease = Boolean(run.leaseOwner && leaseExpiry !== null && leaseExpiry <= now);
    const heartbeatReference = heartbeat ?? updatedAt;
    const staleHeartbeat = run.status === 'running'
      && heartbeatReference !== null
      && now - heartbeatReference >= STALE_RUN_MS;
    const staleActiveState = ACTIVE_RUN_STATUSES.has(run.status)
      && updatedAt !== null
      && now - updatedAt >= STALE_RUN_MS
      && !run.leaseOwner;
    if (expiredLease || staleHeartbeat || staleActiveState) {
      stale.push(runRecordEvidence(run, expiredLease
        ? `lease expired at ${run.leaseExpiresAt}`
        : staleHeartbeat ? `heartbeat stale since ${run.heartbeatAt ?? run.updatedAt}`
          : `active status unchanged since ${run.updatedAt}`));
    }
  }
  if (stale.length === 0) {
    return [];
  }
  return [{
    severity: 'warning',
    category: 'blocked',
    role: 'primary-cause',
    title: 'Stale active run detected',
    summary: `${stale.length} non-terminal run(s) have an expired lease, stale heartbeat, or stale active status.`,
    evidence: stale.slice(0, 10),
  }];
}

function detectRecoveryIssues(report: TraceReport, recovery: RecoveryPressure): FindingDraft[] {
  const findings: FindingDraft[] = [];
  const recoveryEvidence = (report.milestones ?? [])
    .filter((entry) => ['model.retry', 'run.retry_started', 'run.interrupted', 'run.resumed', 'run.continuation_created', 'replan.required', 'model.tool_call_rejected'].includes(entry.eventType))
    .map(milestoneEvidence)
    .slice(0, 10);
  if (recoveryActivityCount(recovery) > 0) {
    findings.push({
      severity: recovery.excessive ? 'warning' : 'info',
      category: 'failure',
      role: 'recovery',
      title: recovery.excessive ? 'High recovery pressure' : 'Recovery activity observed',
      summary: recoveryPressureSummary(recovery),
      evidence: recoveryEvidence,
    });
  }

  const repeatedFailures = detectRepeatedFailures(report);
  if (repeatedFailures.length > 0) {
    findings.push({
      severity: 'warning',
      category: 'failure',
      role: report.summary.status === 'failed' ? 'primary-cause' : 'recovery',
      title: 'Repeated identical failures',
      summary: `${repeatedFailures.length} repeated model/tool failure pattern(s) were detected.`,
      evidence: repeatedFailures,
    });
  }

  if (report.summary.status === 'failed' && recovery.modelRetries > 0) {
    const latestModelEvent = [...(report.milestones ?? [])]
      .reverse()
      .find((entry) => entry.eventType === 'model.completed' || entry.eventType === 'model.failed');
    if (latestModelEvent?.eventType === 'model.failed') {
      findings.push({
        severity: 'error',
        category: 'failure',
        role: 'primary-cause',
        title: 'Model retry exhaustion',
        summary: `${recovery.modelRetries} model retry event(s) were followed by a terminal model failure.`,
        evidence: [milestoneEvidence(latestModelEvent), ...recoveryEvidence].slice(0, 5),
      });
    }
  }

  const replanGroups = groupMilestones(report, 'replan.required');
  const replanLoops = [...replanGroups.values()].filter((events) => events.length >= 2);
  if (replanLoops.length > 0) {
    findings.push({
      severity: 'warning',
      category: 'blocked',
      role: 'recovery',
      title: 'Replan loop detected',
      summary: `${replanLoops.length} run(s) emitted replan.required at least twice.`,
      evidence: replanLoops.flat().slice(0, 10).map(milestoneEvidence),
    });
  }
  return findings;
}

function buildDataConfidence(
  report: TraceReport,
  performance: PerformanceSummary,
  performanceDigest: PerformanceDigest,
): ReliabilityDiagnostics['dataConfidence'] {
  const totalRuns = reliabilityRuns(report).length;
  const runsWithSnapshots = new Set((report.snapshotSummaries ?? [])
    .filter((snapshot) => snapshot.latestSnapshotSeq !== null)
    .map((snapshot) => snapshot.runId)).size;
  const observedEvents = performance.events.totalEvents;
  const measuredPerformanceEvents = performance.events.measuredEvents;
  const requiredObservabilityAvailable = !report.warnings.some((warning) =>
    warning.includes('core:002_tool_observability') || warning.includes('pre-observability historical data'));
  const totalToolRequests = performanceDigest.toolAccounting.totalRequests;
  const pricedToolRequests = Math.max(0, totalToolRequests - performanceDigest.toolAccounting.unpricedRequests);
  const warnings: string[] = [];
  if (!requiredObservabilityAvailable) warnings.push('Required tool observability data is unavailable or historical.');
  if (totalRuns > 0 && observedEvents === 0) warnings.push('No runtime events were available for the traced runs.');
  if (totalRuns > 0 && runsWithSnapshots < totalRuns) warnings.push(`${totalRuns - runsWithSnapshots} run(s) have no available snapshot summary.`);
  if (performanceDigest.toolAccounting.unpricedRequests > 0) warnings.push(`${performanceDigest.toolAccounting.unpricedRequests} tool-provider request(s) are unpriced.`);
  warnings.push(...report.warnings.filter((warning) => !warnings.includes(warning)));

  let level: ReliabilityDiagnostics['dataConfidence']['level'];
  if (totalRuns === 0 && observedEvents === 0) {
    level = 'unknown';
  } else if (!requiredObservabilityAvailable || observedEvents === 0) {
    level = 'low';
  } else if (runsWithSnapshots < totalRuns || report.warnings.length > 0) {
    level = 'medium';
  } else {
    level = 'high';
  }

  return {
    level,
    requiredObservabilityAvailable,
    observedEvents,
    measuredPerformanceEvents,
    performanceCoverage: observedEvents > 0 ? measuredPerformanceEvents / observedEvents : null,
    runsWithSnapshots,
    totalRuns,
    snapshotCoverage: totalRuns > 0 ? runsWithSnapshots / totalRuns : null,
    pricedToolRequests,
    totalToolRequests,
    costCoverage: totalToolRequests > 0 ? pricedToolRequests / totalToolRequests : null,
    warnings,
  };
}

function unresolvedApprovalEvents(report: TraceReport): MilestoneEntry[] {
  const pending = new Map<string, MilestoneEntry[]>();
  for (const entry of report.milestones ?? []) {
    if (entry.eventType !== 'approval.requested' && entry.eventType !== 'approval.resolved') {
      continue;
    }
    const key = `${entry.runId}:${entry.stepId ?? '-'}`;
    if (entry.eventType === 'approval.requested') {
      const requests = pending.get(key) ?? [];
      requests.push(entry);
      pending.set(key, requests);
      continue;
    }
    const requests = pending.get(key);
    if (requests && requests.length > 0) {
      requests.shift();
      continue;
    }
    const fallback = [...pending.entries()].find(([candidate, events]) => candidate.startsWith(`${entry.runId}:`) && events.length > 0);
    fallback?.[1].shift();
  }
  return [...pending.values()].flat();
}

function detectSnapshotSequenceProblems(report: TraceReport): EvidenceRef[] {
  const byRun = new Map<string, MilestoneEntry[]>();
  for (const entry of report.milestones ?? []) {
    if (entry.eventType !== 'snapshot.created') {
      continue;
    }
    const snapshots = byRun.get(entry.runId) ?? [];
    snapshots.push(entry);
    byRun.set(entry.runId, snapshots);
  }

  const evidence: EvidenceRef[] = [];
  for (const snapshots of byRun.values()) {
    let previous: MilestoneEntry | undefined;
    let interveningUnnumbered = 0;
    for (const current of snapshots) {
      if (current.snapshotSeq === null || current.snapshotSeq === undefined) {
        if (previous) interveningUnnumbered += 1;
        continue;
      }
      if (!previous) {
        previous = current;
        interveningUnnumbered = 0;
        continue;
      }
      if (current.snapshotSeq! <= previous.snapshotSeq!) {
        evidence.push({
          ...milestoneEvidence(current),
          detail: `snapshot sequence regressed from ${previous.snapshotSeq} to ${current.snapshotSeq}`,
        });
      } else if (current.snapshotSeq! > previous.snapshotSeq! + interveningUnnumbered + 1) {
        evidence.push({
          ...milestoneEvidence(current),
          detail: `snapshot sequence jumped from ${previous.snapshotSeq} to ${current.snapshotSeq}`,
        });
      }
      previous = current;
      interveningUnnumbered = 0;
    }
  }
  return evidence.slice(0, 10);
}

function detectResumesWithoutSnapshots(report: TraceReport): EvidenceRef[] {
  const snapshotsByRun = groupMilestones(report, 'snapshot.created');
  return (report.milestones ?? [])
    .filter((entry) => entry.eventType === 'run.resumed')
    .filter((resume) => !(snapshotsByRun.get(resume.runId) ?? []).some((snapshot) => eventPrecedes(snapshot, resume)))
    .slice(0, 10)
    .map(milestoneEvidence);
}

function operationWasSupersededByRecovery(
  started: MilestoneEntry,
  milestones: MilestoneEntry[],
  before?: MilestoneEntry,
): boolean {
  const recoveryEvents = new Set<EventType>([
    'run.interrupted',
    'run.resumed',
    'run.retry_started',
    'run.continuation_created',
    'replan.required',
  ]);
  return milestones.some((entry) =>
    entry.runId === started.runId
    && recoveryEvents.has(entry.eventType)
    && eventPrecedes(started, entry)
    && (!before || eventPrecedes(entry, before)),
  );
}

function detectMissingToolContext(report: TraceReport): EvidenceRef[] {
  if (report.llmMessages.length === 0) {
    return [];
  }
  const tracesByRun = new Map(report.llmMessages.map((trace) => [trace.runId, trace]));
  const latestSnapshotEventSeqByRun = new Map<string, number>();
  for (const entry of report.milestones ?? []) {
    if (entry.eventType !== 'snapshot.created' || entry.eventSeq === null) {
      continue;
    }
    latestSnapshotEventSeqByRun.set(entry.runId, Math.max(latestSnapshotEventSeqByRun.get(entry.runId) ?? 0, entry.eventSeq));
  }
  return report.timeline
    .filter((entry) => {
      const latestSnapshotEventSeq = latestSnapshotEventSeqByRun.get(entry.runId);
      return entry.toolCallId
        && entry.completedAt
        && entry.output !== null
        && entry.output !== undefined
        && entry.eventSeq !== null
        && latestSnapshotEventSeq !== undefined
        && entry.eventSeq <= latestSnapshotEventSeq;
    })
    .filter((entry) => {
      const trace = tracesByRun.get(entry.runId);
      return trace && !trace.effectiveMessages.some((message) => message.role === 'tool' && message.toolCallId === entry.toolCallId);
    })
    .slice(0, 10)
    .map(toolEvidence);
}

function detectRepeatedFailures(report: TraceReport): EvidenceRef[] {
  const groups = new Map<string, EvidenceRef[]>();
  for (const entry of report.milestones ?? []) {
    if (entry.eventType !== 'model.failed') {
      continue;
    }
    const signature = oneLine(entry.text).replace(/^.*?model\.failed\s*/i, '').replace(/\b\d+(?:\.\d+)?(?:ms|s)?\b/g, '#');
    const key = `model:${entry.runId}:${entry.stepId ?? '-'}:${signature}`;
    const evidence = groups.get(key) ?? [];
    evidence.push(milestoneEvidence(entry));
    groups.set(key, evidence);
  }
  for (const entry of report.timeline) {
    if (!entry.outcome.startsWith('failed')) {
      continue;
    }
    const key = `tool:${entry.runId}:${entry.toolName ?? '-'}:${entry.outcome}`;
    const evidence = groups.get(key) ?? [];
    evidence.push(toolEvidence(entry));
    groups.set(key, evidence);
  }
  return [...groups.values()]
    .filter((evidence) => evidence.length >= 2)
    .flatMap((evidence) => evidence.slice(0, 3))
    .slice(0, 10);
}

function groupMilestones(report: TraceReport, eventType: EventType): Map<string, MilestoneEntry[]> {
  const groups = new Map<string, MilestoneEntry[]>();
  for (const entry of report.milestones ?? []) {
    if (entry.eventType !== eventType) {
      continue;
    }
    const events = groups.get(entry.runId) ?? [];
    events.push(entry);
    groups.set(entry.runId, events);
  }
  return groups;
}

function countMilestones(report: TraceReport, eventType: EventType): number {
  return (report.milestones ?? []).filter((entry) => entry.eventType === eventType).length;
}

function eventPrecedes(left: MilestoneEntry, right: MilestoneEntry): boolean {
  if (left.eventSeq !== null && right.eventSeq !== null) {
    return left.eventSeq < right.eventSeq;
  }
  const leftTime = parseTimestamp(left.createdAt);
  const rightTime = parseTimestamp(right.createdAt);
  return leftTime !== null && rightTime !== null && leftTime <= rightTime;
}

interface ReliabilityRunRecord {
  rootRunId: string;
  runId: string;
  parentRunId?: string | null;
  status?: string | null;
  updatedAt?: string | null;
  completedAt?: string | null;
  result?: unknown;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  heartbeatAt?: string | null;
}

function reliabilityRuns(report: TraceReport): ReliabilityRunRecord[] {
  const runs = new Map<string, ReliabilityRunRecord>();
  for (const run of report.rootRuns) {
    runs.set(run.rootRunId, {
      rootRunId: run.rootRunId,
      runId: run.rootRunId,
      status: run.status,
      updatedAt: run.updatedAt,
      completedAt: run.completedAt,
      result: run.result,
      leaseOwner: run.leaseOwner,
      leaseExpiresAt: run.leaseExpiresAt,
      heartbeatAt: run.heartbeatAt,
    });
  }
  for (const run of report.runTree ?? []) {
    const existing = runs.get(run.runId);
    runs.set(run.runId, {
      rootRunId: run.rootRunId,
      runId: run.runId,
      parentRunId: run.parentRunId,
      status: run.status ?? existing?.status,
      updatedAt: run.updatedAt ?? existing?.updatedAt,
      completedAt: run.completedAt ?? existing?.completedAt,
      result: run.result ?? existing?.result,
      leaseOwner: run.leaseOwner ?? existing?.leaseOwner,
      leaseExpiresAt: run.leaseExpiresAt ?? existing?.leaseExpiresAt,
      heartbeatAt: run.heartbeatAt ?? existing?.heartbeatAt,
    });
  }
  for (const delegate of report.delegates) {
    if (!delegate.child_run_id || runs.has(delegate.child_run_id)) {
      continue;
    }
    runs.set(delegate.child_run_id, {
      rootRunId: delegate.root_run_id,
      runId: delegate.child_run_id,
      parentRunId: delegate.parent_run_id,
      status: delegate.child_status,
      updatedAt: delegate.child_updated_at,
      completedAt: delegate.child_completed_at,
      result: delegate.child_result,
      leaseOwner: delegate.child_lease_owner,
      leaseExpiresAt: delegate.child_lease_expires_at,
      heartbeatAt: delegate.child_heartbeat_at,
    });
  }
  return [...runs.values()];
}

function runRecordEvidence(run: ReliabilityRunRecord, detail?: string): EvidenceRef {
  return {
    kind: run.runId === run.rootRunId ? 'root-run' : 'run',
    label: `${run.runId === run.rootRunId ? 'root run' : 'run'} ${run.status ?? 'unknown'}`,
    rootRunId: run.rootRunId,
    runId: run.runId,
    createdAt: run.completedAt ?? run.updatedAt,
    detail,
  };
}

function runTreeEvidence(run: RunTreeEntry, detail?: string): EvidenceRef {
  return runRecordEvidence({
    rootRunId: run.rootRunId,
    runId: run.runId,
    parentRunId: run.parentRunId,
    status: run.status,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
  }, detail);
}

function milestoneEvidence(entry: MilestoneEntry): EvidenceRef {
  return {
    kind: 'event',
    label: `event #${entry.eventSeq ?? '?'} ${entry.eventType}`,
    rootRunId: entry.rootRunId,
    runId: entry.runId,
    stepId: entry.stepId,
    toolCallId: entry.toolCallId,
    eventSeq: entry.eventSeq,
    eventType: entry.eventType,
    createdAt: entry.createdAt,
    detail: entry.text,
  };
}

function inspectionCommands(report: TraceReport, finding: FindingDraft): TraceFinding['commands'] {
  const commands = new Map<string, string>();
  const add = (reason: string, command: string): void => {
    if (!commands.has(command)) commands.set(command, reason);
  };
  const runId = finding.evidence.find((evidence) => evidence.runId)?.runId;
  if (runId) {
    add('Inspect the referenced run lifecycle and tool activity.', `trace-session view run ${runId} --report timeline`);
    if (finding.category === 'failure' || finding.role === 'recovery' || finding.title.includes('Tool output')) {
      add('Inspect the referenced run model context.', `trace-session view run ${runId} --report messages --messages-view delta`);
    }
  }
  if (finding.category === 'policy') {
    add('Inspect policy and approval evidence.', `${traceTargetCommand(report)} --report policy`);
  }
  if (finding.category === 'data-quality' || finding.category === 'blocked') {
    add('Inspect all reliability dimensions and data coverage.', `${traceTargetCommand(report)} --report reliability`);
  }
  if (commands.size === 0) {
    add('Inspect the causal investigation report.', `${traceTargetCommand(report)} --report investigate`);
  }
  return [...commands.entries()].slice(0, 3).map(([command, reason]) => ({ reason, command }));
}

function findingEvidence(findings: FindingDraft[]): EvidenceRef[] {
  return findings.flatMap((finding) => finding.evidence).slice(0, 5);
}

function recoveryActivityCount(recovery: RecoveryPressure): number {
  return recovery.modelRetries
    + recovery.runRetries
    + recovery.interruptions
    + recovery.resumes
    + recovery.continuations
    + recovery.replans
    + recovery.rejectedToolCalls;
}

function recoveryPressureSummary(recovery: RecoveryPressure): string {
  if (recoveryActivityCount(recovery) === 0) {
    return 'No retries, interruptions, resumes, continuations, replans, or rejected tool calls were observed.';
  }
  const parts = [
    recovery.modelRetries > 0 ? `${recovery.modelRetries} model retries (${recovery.modelRetryDelayMs}ms delay)` : undefined,
    recovery.runRetries > 0 ? `${recovery.runRetries} run retries` : undefined,
    recovery.interruptions > 0 ? `${recovery.interruptions} interruptions` : undefined,
    recovery.resumes > 0 ? `${recovery.resumes} resumes` : undefined,
    recovery.continuations > 0 ? `${recovery.continuations} continuations` : undefined,
    recovery.replans > 0 ? `${recovery.replans} replans` : undefined,
    recovery.rejectedToolCalls > 0 ? `${recovery.rejectedToolCalls} rejected tool calls` : undefined,
  ].filter((part): part is string => part !== undefined);
  return `${parts.join(', ')}${recovery.excessive ? '; recovery pressure is high' : ''}.`;
}

function reliabilityClassificationSummary(
  classification: ReliabilityDiagnostics['classification'],
  report: TraceReport,
): string {
  switch (classification) {
    case 'healthy': return 'Terminal success with coherent lifecycle evidence and no material runtime or policy findings.';
    case 'recovered': return 'Terminal success after retry, interruption, resume, replan, rejection, or transient failure activity.';
    case 'degraded': return 'Terminal success with integrity, policy, recovery-pressure, or evidence-confidence gaps.';
    case 'failed': return `Terminal failure: ${report.summary.reason}`;
    case 'blocked': return `Non-terminal work requires user or operator action: ${report.summary.reason}`;
    case 'unknown': return 'Persisted evidence is insufficient to classify runtime reliability.';
  }
}

function outcomeDimensionSummary(report: TraceReport, issues: FindingDraft[]): string {
  if (issues.length > 0) return `${issues.length} root/child outcome integrity issue(s) were detected.`;
  if (report.summary.status === 'succeeded') return 'Root and child outcomes are coherent and terminal success is persisted.';
  return report.summary.reason;
}

function policyDimensionSummary(policy: PolicyDigest): string {
  if (policy.unresolvedApprovalRequests > 0) return `${policy.unresolvedApprovalRequests} approval request(s) remain unresolved.`;
  if (policy.budgetExhaustedToolCalls > 0) return `${policy.budgetExhaustedToolCalls} tool call(s) were skipped after budget exhaustion.`;
  if (policy.rejectedToolCalls > 0) return `${policy.rejectedToolCalls} rejected tool call(s) were observed and execution continued.`;
  return 'No unresolved approvals, budget exhaustion, or rejected tool calls were detected.';
}

function dataConfidenceSummary(confidence: ReliabilityDiagnostics['dataConfidence']): string {
  const performance = confidence.performanceCoverage === null ? 'performance unknown'
    : `${Math.round(confidence.performanceCoverage * 100)}% performance payload coverage`;
  const snapshots = confidence.snapshotCoverage === null ? 'snapshot coverage unknown'
    : `${confidence.runsWithSnapshots}/${confidence.totalRuns} runs with snapshots`;
  const cost = confidence.costCoverage === null ? 'no priced tool requests expected'
    : `${confidence.pricedToolRequests}/${confidence.totalToolRequests} tool requests priced`;
  return `${confidence.level} · ${confidence.observedEvents} events available · ${performance} · ${snapshots} · ${cost}.`;
}

function dataConfidenceEvidence(
  report: TraceReport,
  confidence: ReliabilityDiagnostics['dataConfidence'],
): EvidenceRef[] {
  const evidence: EvidenceRef[] = report.warnings.slice(0, 3).map((warning) => ({
    kind: 'event',
    label: 'trace data warning',
    detail: warning,
  }));
  if (confidence.totalRuns > confidence.runsWithSnapshots) {
    evidence.push({
      kind: 'snapshot',
      label: 'snapshot coverage',
      detail: `${confidence.runsWithSnapshots}/${confidence.totalRuns} runs have snapshots`,
    });
  }
  if (confidence.totalToolRequests > confidence.pricedToolRequests) {
    evidence.push({
      kind: 'usage',
      label: 'tool cost coverage',
      detail: `${confidence.pricedToolRequests}/${confidence.totalToolRequests} requests priced`,
    });
  }
  return evidence.slice(0, 5);
}

function capitalize(value: string): string {
  return value.length > 0 ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;
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

  for (const finding of findings.slice(0, 3)) {
    for (const suggestion of finding.commands) {
      add(suggestion.reason, suggestion.command);
    }
  }

  if (failingRunId && suggestions.size === 0) {
    add('Inspect the failed run message context.', `trace-session view run ${failingRunId} --report messages --messages-view delta`);
    add('Inspect the failed run tool timeline.', `trace-session view run ${failingRunId} --report timeline`);
  }
  if (policyDigest.warnings.length > 0) {
    add('Review budget, rejected-call, and approval adherence.', `${traceTargetCommand(report)} --report policy`);
  }
  if (performanceDigest.topToolSpans.length > 0 || performanceDigest.topRunsByUsage.length > 0) {
    add('Review duration and token hotspots.', `${traceTargetCommand(report)} --report performance`);
  }
  if (suggestions.size === 0) {
    add('Review the reliability dimensions and their evidence.', `${traceTargetCommand(report)} --report reliability`);
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
      toolCallId: row.tool_call_id,
      createdAt: row.event_created_at,
      eventSeq: row.event_seq,
      snapshotSeq: row.event_type === 'snapshot.created' ? payloadNumber(row.payload, 'snapshotSeq') : null,
      retryDelayMs: row.event_type === 'model.retry'
        ? payloadNumber(row.payload, 'retryDelayMs') ?? payloadNestedNumber(row.payload, 'performance', 'retryDelayMs')
        : null,
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
      status: row.run_status,
      createdAt: row.run_created_at,
      updatedAt: row.run_updated_at,
      completedAt: row.run_completed_at,
      result: row.run_result,
      leaseOwner: row.run_lease_owner,
      leaseExpiresAt: row.run_lease_expires_at,
      heartbeatAt: row.run_heartbeat_at,
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
      return `trace-session view session ${report.target.requestedId}`;
    case 'root-run':
      return `trace-session view root-run ${report.target.requestedId}`;
    case 'run':
      return `trace-session view run ${report.target.requestedId}`;
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
    .map(milestoneEvidence);
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
      .map(milestoneEvidence);
  }
  if (warning.includes('approval')) {
    return unresolvedApprovalEvents(report)
      .slice(0, 5)
      .map(milestoneEvidence);
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
    createdAt: delegate.child_completed_at ?? delegate.child_updated_at,
    detail: delegate.child_error_message ?? delegate.child_error_code ?? delegate.delegate_reason,
  };
}

function rootRunEvidence(run: RootRun): EvidenceRef {
  return {
    kind: 'root-run',
    label: `root run ${run.status ?? 'unknown'}`,
    rootRunId: run.rootRunId,
    runId: run.rootRunId,
    createdAt: run.completedAt ?? run.updatedAt,
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
    createdAt: entry.completedAt ?? entry.startedAt,
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

function payloadNumber(payload: unknown, key: string): number | null {
  const value = payloadValue(payload, key);
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function payloadNestedNumber(payload: unknown, parentKey: string, key: string): number | null {
  const parent = asRecord(payloadValue(payload, parentKey));
  return parent ? readNumber(parent, key) ?? null : null;
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

function readToolAccounting(value: unknown): {
  provider: string;
  operation: string;
  billable: boolean;
  cached: boolean;
  requests: number;
  estimatedCostUSD?: number;
} | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const provider = typeof record.provider === 'string' && record.provider ? record.provider : undefined;
  const operation = typeof record.operation === 'string' && record.operation ? record.operation : undefined;
  const units = asRecord(record.units);
  const requests = units ? readNumber(units, 'requests') : undefined;
  if (!provider || !operation || requests === undefined || requests < 0) {
    return null;
  }

  return {
    provider,
    operation,
    billable: record.billable === true,
    cached: record.cached === true,
    requests,
    estimatedCostUSD: readNumber(record, 'estimatedCostUSD'),
  };
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
