import type { InputDiscoveryDiagnostic } from './discovery.js'
import type { NormalizedLogEvent } from './normalize.js'
import type { ParseDiagnostic } from './parser.js'
import type { ReconstructedRun, RunGraph } from './runs.js'

export type ToolKind = 'direct' | 'delegate'

export interface OverviewReportSummary {
  runCount: number
  successCount: number
  failedCount: number
  unfinishedCount: number
  averageDurationMs?: number
  minimumDurationMs?: number
  maximumDurationMs?: number
  topTools: Array<{ toolName: string; invocationCount: number; toolKind: ToolKind }>
}

export interface AnalysisReportSummary extends OverviewReportSummary {
  inputCount: number
  fileCount: number
  eventCount: number
  malformedLineCount: number
  unassignedEventCount: number
}

export interface ToolReport {
  toolName: string
  toolKind: ToolKind
  invocationCount: number
  successCount: number
  failureCount: number
  unknownCount: number
  successRate?: number
  latencySampleCount: number
  averageDurationMs?: number
  minimumDurationMs?: number
  maximumDurationMs?: number
}

export interface RunReport {
  runId: string
  rootRunId: string
  parentRunId?: string
  delegateName?: string
  childRunIds: string[]
  status: 'succeeded' | 'failed' | 'replan_required' | 'running' | 'unknown'
  eventCount: number
  startTime?: string
  startTimeMs?: number
  endTime?: string
  endTimeMs?: number
  durationMs?: number
}

export interface FailureClusterReport {
  kind: 'tool' | 'run'
  toolName?: string
  errorName: string
  errorValueSnippet: string
  count: number
  runIds: string[]
  rootRunIds: string[]
  latestTime?: string
  latestTimeMs?: number
  example: {
    runId: string
    rootRunId: string
    stepId?: string
    childRunId?: string
    event: string
    sourceFile: string
    line: number
  }
}

export interface RetrySignalReport {
  signalType: 'tool' | 'step'
  runId: string
  rootRunId: string
  toolName: string
  stepId?: string
  attemptCount: number
  failureCount: number
  successCount: number
  outcome: 'failed' | 'recovered' | 'ongoing'
  firstAttemptTime?: string
  lastAttemptTime?: string
  latestErrorValueSnippet?: string
}

export interface FailureReport {
  clusters: FailureClusterReport[]
  retrySignals: RetrySignalReport[]
}

export interface StepBottleneckReport {
  runId: string
  rootRunId: string
  stepId: string
  toolNames: string[]
  eventCount: number
  startTime?: string
  endTime?: string
  durationMs: number
}

export interface InterEventGapReport {
  runId: string
  rootRunId: string
  fromEvent: string
  toEvent: string
  fromTime?: string
  toTime?: string
  fromStepId?: string
  toStepId?: string
  fromToolName?: string
  toToolName?: string
  gapMs: number
}

export interface WaitingSegmentReport {
  waitKind: 'delegation' | 'status'
  runId: string
  rootRunId: string
  subject: string
  durationMs: number
  startTime?: string
  endTime?: string
  childRunId?: string
}

export interface WaitingTimeReport {
  delegationWaitMs: number
  statusWaitMs: number
  totalEstimatedWaitMs: number
  slowestDelegations: WaitingSegmentReport[]
  slowestStatusTransitions: WaitingSegmentReport[]
}

export interface BottleneckReport {
  slowestRuns: RunReport[]
  slowestSteps: StepBottleneckReport[]
  longestInterEventGaps: InterEventGapReport[]
  waitingTime: WaitingTimeReport
}

export type ReportDiagnostic =
  | {
      kind: 'discovery'
      input: string
      message: string
    }
  | {
      kind: 'parse'
      sourceFile: string
      line?: number
      message: string
    }

export interface AnalysisReport {
  summary: AnalysisReportSummary
  runs: RunReport[]
  tools: ToolReport[]
  failures: FailureReport
  bottlenecks: BottleneckReport
  diagnostics: ReportDiagnostic[]
}

export interface RunSelection {
  mode: 'runId' | 'rootRunId'
  value: string
}

export interface RunDrillDownTimelineEvent {
  time?: string
  event: string
  stepId?: string
  toolName?: string
  delegateName?: string
  childRunId?: string
  fromStatus?: string
  toStatus?: string
  durationMs?: number
  outcome?: 'success' | 'failure'
  errorName?: string
  errorValue?: string
}

export interface RunDrillDownReport {
  selection: {
    mode: 'runId' | 'rootRunId'
    requestedId: string
    resolvedRunId: string
  }
  run: RunReport
  relatedRuns: RunReport[]
  timeline: RunDrillDownTimelineEvent[]
  failures: FailureClusterReport[]
}

export interface AnalysisReportOptions {
  inputCount: number
  fileCount: number
  eventCount: number
  malformedLineCount: number
  diagnostics: Array<InputDiscoveryDiagnostic | ParseDiagnostic>
  runGraph: RunGraph
}

interface ToolInvocationRecord {
  runId: string
  rootRunId: string
  toolName: string
  toolKind: ToolKind
  stepId?: string
  childRunId?: string
  startTime?: string
  startTimeMs?: number
  endTime?: string
  endTimeMs?: number
  durationMs?: number
  outcome: 'succeeded' | 'failed' | 'unknown'
  errorValueSnippet?: string
}

interface FailureOccurrence {
  kind: 'tool' | 'run'
  runId: string
  rootRunId: string
  toolName?: string
  stepId?: string
  childRunId?: string
  event: string
  sourceFile: string
  line: number
  time?: string
  timeMs?: number
  errorName: string
  errorValueSnippet: string
}

interface WaitingState {
  subject: string
  startTime?: string
  startTimeMs?: number
}

const WAITING_STATUSES = new Set(['awaiting_subagent', 'awaiting_approval', 'awaiting_clarification', 'interrupted'])

export function summarizeOverview(runGraph: RunGraph): OverviewReportSummary {
  const runSummaries = runGraph.runs.map((run) => run.summary)
  const successCount = runSummaries.filter((run) => run.status === 'succeeded').length
  const failedCount = runSummaries.filter((run) => run.status === 'failed' || run.status === 'replan_required').length
  const unfinishedCount = runSummaries.filter((run) => run.status === 'running' || run.status === 'unknown').length
  const durations = runSummaries
    .map((run) => run.durationMs)
    .filter((durationMs): durationMs is number => durationMs !== undefined)
    .sort((left, right) => left - right)
  const tools = summarizeTools(runGraph)

  return {
    runCount: runSummaries.length,
    successCount,
    failedCount,
    unfinishedCount,
    averageDurationMs:
      durations.length > 0 ? Math.round(durations.reduce((sum, durationMs) => sum + durationMs, 0) / durations.length) : undefined,
    minimumDurationMs: durations[0],
    maximumDurationMs: durations.at(-1),
    topTools: tools.slice(0, 5).map((tool) => ({
      toolName: tool.toolName,
      invocationCount: tool.invocationCount,
      toolKind: tool.toolKind,
    })),
  }
}

export function buildAnalysisReport(options: AnalysisReportOptions): AnalysisReport {
  const overview = summarizeOverview(options.runGraph)
  const failures = buildFailureReport(options.runGraph)
  const bottlenecks = buildBottleneckReport(options.runGraph)

  return {
    summary: {
      inputCount: options.inputCount,
      fileCount: options.fileCount,
      eventCount: options.eventCount,
      malformedLineCount: options.malformedLineCount,
      unassignedEventCount: options.runGraph.unassignedEvents.length,
      ...overview,
    },
    runs: options.runGraph.runs.map((run) => toRunReport(run)),
    tools: summarizeTools(options.runGraph),
    failures,
    bottlenecks,
    diagnostics: options.diagnostics.map((diagnostic) => toReportDiagnostic(diagnostic)),
  }
}

export function buildFailureReport(runGraph: RunGraph): FailureReport {
  const runs = runGraph.runs
  const clusters = summarizeFailureClusters(runs)
  const retrySignals = summarizeRetrySignals(runs)

  return {
    clusters,
    retrySignals,
  }
}

export function buildBottleneckReport(runGraph: RunGraph): BottleneckReport {
  const slowestRuns = [...runGraph.runs]
    .filter((run) => run.summary.durationMs !== undefined)
    .sort((left, right) => compareNumbers(right.summary.durationMs, left.summary.durationMs, left.runId.localeCompare(right.runId)))
    .slice(0, 5)
    .map((run) => toRunReport(run))

  const slowestSteps = summarizeStepBottlenecks(runGraph.runs).slice(0, 5)
  const longestInterEventGaps = summarizeInterEventGaps(runGraph.runs).slice(0, 5)
  const waitingSegments = summarizeWaitingSegments(runGraph.runs)

  return {
    slowestRuns,
    slowestSteps,
    longestInterEventGaps,
    waitingTime: {
      delegationWaitMs: waitingSegments.delegations.reduce((sum, segment) => sum + segment.durationMs, 0),
      statusWaitMs: waitingSegments.statusTransitions.reduce((sum, segment) => sum + segment.durationMs, 0),
      totalEstimatedWaitMs:
        waitingSegments.delegations.reduce((sum, segment) => sum + segment.durationMs, 0) +
        waitingSegments.statusTransitions.reduce((sum, segment) => sum + segment.durationMs, 0),
      slowestDelegations: waitingSegments.delegations.slice(0, 5),
      slowestStatusTransitions: waitingSegments.statusTransitions.slice(0, 5),
    },
  }
}

export function buildRunDrillDownReport(runGraph: RunGraph, selection: RunSelection): RunDrillDownReport | undefined {
  const selectedRun = resolveSelectedRun(runGraph, selection)
  if (!selectedRun) {
    return undefined
  }

  const relatedRuns =
    selection.mode === 'rootRunId'
      ? runGraph.runs.filter((run) => run.rootRunId === selectedRun.rootRunId)
      : collectSubtreeRuns(runGraph, selectedRun.runId)

  return {
    selection: {
      mode: selection.mode,
      requestedId: selection.value,
      resolvedRunId: selectedRun.runId,
    },
    run: toRunReport(selectedRun),
    relatedRuns: sortRelatedRuns(selectedRun.runId, relatedRuns.map((run) => toRunReport(run))),
    timeline: selectedRun.timeline.map((event) => ({
      time: event.time,
      event: event.event,
      stepId: event.stepId,
      toolName: event.toolName,
      delegateName: event.delegateName,
      childRunId: event.childRunId,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      durationMs: event.durationMs,
      outcome: event.outcome,
      errorName: event.errorName,
      errorValue: event.errorValue,
    })),
    failures: summarizeFailureClusters(relatedRuns),
  }
}

export function formatOverviewReport(options: AnalysisReportOptions): string {
  const report = buildAnalysisReport(options)
  const { summary } = report
  const lines = [
    'analysis analyze',
    '',
    `Inputs received: ${summary.inputCount}`,
    `Files matched: ${summary.fileCount}`,
    `Events parsed: ${summary.eventCount}`,
    `Malformed lines: ${summary.malformedLineCount}`,
    `Runs discovered: ${summary.runCount}`,
    `Successful runs: ${summary.successCount}`,
    `Failed runs: ${summary.failedCount}`,
  ]

  if (summary.unfinishedCount > 0) {
    lines.push(`Unfinished runs: ${summary.unfinishedCount}`)
  }

  lines.push(`Duration summary: ${formatDurationSummary(summary)}`)

  if (summary.topTools.length > 0) {
    lines.push('', 'Top tools:')
    for (const tool of summary.topTools) {
      lines.push(`- ${tool.toolName}: ${tool.invocationCount}`)
    }
  }

  if (report.failures.clusters.length > 0) {
    lines.push('', 'Failure clusters:')
    for (const cluster of report.failures.clusters.slice(0, 5)) {
      lines.push(`- ${formatFailureCluster(cluster)}`)
    }
  }

  if (report.failures.retrySignals.length > 0) {
    lines.push('', 'Retry signals:')
    for (const signal of report.failures.retrySignals.slice(0, 5)) {
      lines.push(`- ${formatRetrySignal(signal)}`)
    }
  }

  const bottlenecks = report.bottlenecks
  if (
    bottlenecks.slowestRuns.length > 0 ||
    bottlenecks.slowestSteps.length > 0 ||
    bottlenecks.longestInterEventGaps.length > 0 ||
    bottlenecks.waitingTime.totalEstimatedWaitMs > 0
  ) {
    lines.push('', 'Bottlenecks:')

    const slowestRun = bottlenecks.slowestRuns[0]
    if (slowestRun?.durationMs !== undefined) {
      lines.push(`- Slowest run: ${slowestRun.runId} (${formatDuration(slowestRun.durationMs)})`)
    }

    const slowestStep = bottlenecks.slowestSteps[0]
    if (slowestStep) {
      const toolLabel = slowestStep.toolNames.length > 0 ? ` [${slowestStep.toolNames.join(', ')}]` : ''
      lines.push(
        `- Slowest step: ${slowestStep.runId}/${slowestStep.stepId}${toolLabel} (${formatDuration(slowestStep.durationMs)})`,
      )
    }

    const longestGap = bottlenecks.longestInterEventGaps[0]
    if (longestGap) {
      lines.push(
        `- Longest inter-event gap: ${longestGap.runId} ${longestGap.fromEvent} -> ${longestGap.toEvent} (${formatDuration(longestGap.gapMs)})`,
      )
    }

    if (bottlenecks.waitingTime.totalEstimatedWaitMs > 0) {
      lines.push(
        `- Estimated waiting: total ${formatDuration(bottlenecks.waitingTime.totalEstimatedWaitMs)} (delegation ${formatDuration(
          bottlenecks.waitingTime.delegationWaitMs,
        )}, status ${formatDuration(bottlenecks.waitingTime.statusWaitMs)})`,
      )
    }
  }

  if (summary.unassignedEventCount > 0) {
    lines.push('', `Unassigned events: ${summary.unassignedEventCount}`)
  }

  if (report.diagnostics.length > 0) {
    lines.push('', 'Diagnostics:')
    for (const diagnostic of report.diagnostics) {
      lines.push(`- ${formatDiagnostic(diagnostic)}`)
    }
  }

  return lines.join('\n')
}

export function formatRunDrillDownReport(report: RunDrillDownReport): string {
  const lines = [
    'analysis analyze',
    '',
    `Selected run: ${report.run.runId}`,
    `Requested via: ${report.selection.mode}=${report.selection.requestedId}`,
    `Root run: ${report.run.rootRunId}`,
    `Status: ${report.run.status}`,
    `Duration: ${report.run.durationMs !== undefined ? formatDuration(report.run.durationMs) : 'unavailable'}`,
    `Events in focus run: ${report.run.eventCount}`,
  ]

  if (report.run.parentRunId) {
    lines.push(`Parent run: ${report.run.parentRunId}`)
  }

  if (report.relatedRuns.length > 1 || report.run.childRunIds.length > 0) {
    lines.push('', 'Run tree:')
    for (const treeLine of buildRunTreeLines(report.relatedRuns, report.run.runId)) {
      lines.push(treeLine)
    }
  }

  lines.push('', 'Timeline:')
  for (const event of report.timeline) {
    lines.push(`- ${formatTimelineEvent(event)}`)
  }

  lines.push('', 'Failures:')
  if (report.failures.length === 0) {
    lines.push('- none')
  } else {
    for (const cluster of report.failures) {
      lines.push(`- ${formatFailureCluster(cluster)}`)
    }
  }

  return lines.join('\n')
}

export function formatJsonReport(options: AnalysisReportOptions): string {
  return JSON.stringify(buildAnalysisReport(options), null, 2)
}

export function formatRunDrillDownJson(report: RunDrillDownReport): string {
  return JSON.stringify(report, null, 2)
}

export function summarizeTools(runGraph: RunGraph): ToolReport[] {
  const aggregatedTools = new Map<string, ToolAggregationAccumulator>()

  for (const invocation of collectToolInvocations(runGraph.runs)) {
    const toolAggregation = aggregatedTools.get(invocation.toolName) ?? {
      toolName: invocation.toolName,
      toolKind: invocation.toolKind,
      invocationCount: 0,
      successCount: 0,
      failureCount: 0,
      unknownCount: 0,
      durations: [],
    }

    toolAggregation.invocationCount += 1
    if (invocation.outcome === 'succeeded') {
      toolAggregation.successCount += 1
    } else if (invocation.outcome === 'failed') {
      toolAggregation.failureCount += 1
    } else {
      toolAggregation.unknownCount += 1
    }

    if (invocation.durationMs !== undefined) {
      toolAggregation.durations.push(invocation.durationMs)
    }

    aggregatedTools.set(invocation.toolName, toolAggregation)
  }

  return [...aggregatedTools.values()]
    .map((toolAggregation) => toToolReport(toolAggregation))
    .sort((left, right) => {
      if (left.invocationCount !== right.invocationCount) {
        return right.invocationCount - left.invocationCount
      }

      return left.toolName.localeCompare(right.toolName)
    })
}

interface ToolAggregationAccumulator {
  toolName: string
  toolKind: ToolKind
  invocationCount: number
  successCount: number
  failureCount: number
  unknownCount: number
  durations: number[]
}

function toToolReport(toolAggregation: ToolAggregationAccumulator): ToolReport {
  const durations = [...toolAggregation.durations].sort((left, right) => left - right)
  const settledCount = toolAggregation.successCount + toolAggregation.failureCount

  return {
    toolName: toolAggregation.toolName,
    toolKind: toolAggregation.toolKind,
    invocationCount: toolAggregation.invocationCount,
    successCount: toolAggregation.successCount,
    failureCount: toolAggregation.failureCount,
    unknownCount: toolAggregation.unknownCount,
    successRate: settledCount > 0 ? toolAggregation.successCount / settledCount : undefined,
    latencySampleCount: durations.length,
    averageDurationMs:
      durations.length > 0 ? Math.round(durations.reduce((sum, durationMs) => sum + durationMs, 0) / durations.length) : undefined,
    minimumDurationMs: durations[0],
    maximumDurationMs: durations.at(-1),
  }
}

function collectToolInvocations(runs: ReconstructedRun[]): ToolInvocationRecord[] {
  const toolInvocations = new Map<string, ToolInvocationRecord>()

  for (const run of runs) {
    for (const event of run.timeline) {
      if (!event.toolName || !isToolInvocationEvent(event.event)) {
        continue
      }

      const invocationKey = getInvocationKey(run.runId, event)
      const invocation =
        toolInvocations.get(invocationKey) ??
        ({
          runId: run.runId,
          rootRunId: run.rootRunId,
          toolName: event.toolName,
          toolKind: getToolKind(event.toolName),
          stepId: event.stepId,
          childRunId: event.childRunId,
          outcome: 'unknown',
        } satisfies ToolInvocationRecord)

      if (!invocation.stepId && event.stepId) {
        invocation.stepId = event.stepId
      }
      if (!invocation.childRunId && event.childRunId) {
        invocation.childRunId = event.childRunId
      }

      if (event.event === 'tool.started') {
        if (event.timeMs !== undefined && (invocation.startTimeMs === undefined || event.timeMs < invocation.startTimeMs)) {
          invocation.startTimeMs = event.timeMs
          invocation.startTime = event.time
        }
      } else if (event.timeMs !== undefined && (invocation.endTimeMs === undefined || event.timeMs > invocation.endTimeMs)) {
        invocation.endTimeMs = event.timeMs
        invocation.endTime = event.time
      }

      if (event.event === 'tool.failed' || (event.event === 'tool.completed' && event.outcome === 'failure')) {
        invocation.outcome = 'failed'
        invocation.errorValueSnippet = summarizeErrorValue(event.errorValue)
      } else if (event.event === 'tool.completed' && invocation.outcome !== 'failed') {
        invocation.outcome = 'succeeded'
      }

      if (event.durationMs !== undefined) {
        invocation.durationMs = event.durationMs
      }

      toolInvocations.set(invocationKey, invocation)
    }
  }

  return [...toolInvocations.values()]
    .map((invocation) => ({
      ...invocation,
      durationMs:
        invocation.durationMs ??
        inferDurationMs(
          invocation.startTimeMs,
          invocation.endTimeMs,
        ),
    }))
    .sort((left, right) => {
      if (left.runId !== right.runId) {
        return left.runId.localeCompare(right.runId)
      }

      if (left.startTimeMs !== undefined && right.startTimeMs !== undefined && left.startTimeMs !== right.startTimeMs) {
        return left.startTimeMs - right.startTimeMs
      }

      return left.toolName.localeCompare(right.toolName)
    })
}

function summarizeFailureClusters(runs: ReconstructedRun[]): FailureClusterReport[] {
  const clusters = new Map<string, FailureClusterAccumulator>()

  for (const occurrence of collectFailureOccurrences(runs)) {
    const clusterKey = [occurrence.kind, occurrence.toolName ?? 'run', occurrence.errorName, occurrence.errorValueSnippet].join('|')
    const cluster =
      clusters.get(clusterKey) ??
      ({
        kind: occurrence.kind,
        toolName: occurrence.toolName,
        errorName: occurrence.errorName,
        errorValueSnippet: occurrence.errorValueSnippet,
        count: 0,
        runIds: new Set<string>(),
        rootRunIds: new Set<string>(),
        latestTime: occurrence.time,
        latestTimeMs: occurrence.timeMs,
        example: {
          runId: occurrence.runId,
          rootRunId: occurrence.rootRunId,
          stepId: occurrence.stepId,
          childRunId: occurrence.childRunId,
          event: occurrence.event,
          sourceFile: occurrence.sourceFile,
          line: occurrence.line,
        },
      } satisfies FailureClusterAccumulator)

    cluster.count += 1
    cluster.runIds.add(occurrence.runId)
    cluster.rootRunIds.add(occurrence.rootRunId)

    if ((occurrence.timeMs ?? -1) >= (cluster.latestTimeMs ?? -1)) {
      cluster.latestTime = occurrence.time
      cluster.latestTimeMs = occurrence.timeMs
      cluster.example = {
        runId: occurrence.runId,
        rootRunId: occurrence.rootRunId,
        stepId: occurrence.stepId,
        childRunId: occurrence.childRunId,
        event: occurrence.event,
        sourceFile: occurrence.sourceFile,
        line: occurrence.line,
      }
    }

    clusters.set(clusterKey, cluster)
  }

  return [...clusters.values()]
    .map((cluster) => ({
      kind: cluster.kind,
      toolName: cluster.toolName,
      errorName: cluster.errorName,
      errorValueSnippet: cluster.errorValueSnippet,
      count: cluster.count,
      runIds: [...cluster.runIds].sort((left, right) => left.localeCompare(right)),
      rootRunIds: [...cluster.rootRunIds].sort((left, right) => left.localeCompare(right)),
      latestTime: cluster.latestTime,
      latestTimeMs: cluster.latestTimeMs,
      example: cluster.example,
    }))
    .sort((left, right) => {
      if (left.count !== right.count) {
        return right.count - left.count
      }

      if ((left.latestTimeMs ?? -1) !== (right.latestTimeMs ?? -1)) {
        return (right.latestTimeMs ?? -1) - (left.latestTimeMs ?? -1)
      }

      return formatFailureCluster(left).localeCompare(formatFailureCluster(right))
    })
}

interface FailureClusterAccumulator {
  kind: 'tool' | 'run'
  toolName?: string
  errorName: string
  errorValueSnippet: string
  count: number
  runIds: Set<string>
  rootRunIds: Set<string>
  latestTime?: string
  latestTimeMs?: number
  example: FailureClusterReport['example']
}

function collectFailureOccurrences(runs: ReconstructedRun[]): FailureOccurrence[] {
  const failures: FailureOccurrence[] = []

  for (const run of runs) {
    for (const event of run.timeline) {
      if (!isFailureEvent(event)) {
        continue
      }

      failures.push({
        kind: event.event.startsWith('tool.') ? 'tool' : 'run',
        runId: run.runId,
        rootRunId: run.rootRunId,
        toolName: event.toolName,
        stepId: event.stepId,
        childRunId: event.childRunId,
        event: event.event,
        sourceFile: event.sourceFile,
        line: event.line,
        time: event.time,
        timeMs: event.timeMs,
        errorName: event.errorName ?? defaultFailureName(event),
        errorValueSnippet: summarizeErrorValue(event.errorValue) ?? defaultFailureValue(event),
      })
    }
  }

  return failures
}

function summarizeRetrySignals(runs: ReconstructedRun[]): RetrySignalReport[] {
  const invocations = collectToolInvocations(runs)
  const signals: RetrySignalReport[] = []

  const stepSignals = new Map<string, ToolInvocationRecord[]>()
  for (const invocation of invocations) {
    if (!invocation.stepId) {
      continue
    }

    const key = [invocation.runId, invocation.stepId, invocation.toolName].join('|')
    const group = stepSignals.get(key) ?? []
    group.push(invocation)
    stepSignals.set(key, group)
  }

  for (const group of stepSignals.values()) {
    if (group.length < 2) {
      continue
    }

    signals.push(toRetrySignal('step', group))
  }

  const toolSignals = new Map<string, ToolInvocationRecord[]>()
  for (const invocation of invocations) {
    const key = [invocation.runId, invocation.toolName].join('|')
    const group = toolSignals.get(key) ?? []
    group.push(invocation)
    toolSignals.set(key, group)
  }

  for (const group of toolSignals.values()) {
    const uniqueSteps = new Set(group.map((invocation) => invocation.stepId ?? invocation.childRunId ?? invocation.toolName))
    const failureCount = group.filter((invocation) => invocation.outcome === 'failed').length
    if (group.length < 2 || failureCount === 0 || uniqueSteps.size < 2) {
      continue
    }

    signals.push(toRetrySignal('tool', group))
  }

  return signals.sort((left, right) => {
    if (left.attemptCount !== right.attemptCount) {
      return right.attemptCount - left.attemptCount
    }

    if (left.failureCount !== right.failureCount) {
      return right.failureCount - left.failureCount
    }

    return `${left.runId}:${left.toolName}:${left.stepId ?? ''}`.localeCompare(`${right.runId}:${right.toolName}:${right.stepId ?? ''}`)
  })
}

function toRetrySignal(signalType: 'tool' | 'step', group: ToolInvocationRecord[]): RetrySignalReport {
  const sortedGroup = [...group].sort((left, right) => {
    if ((left.startTimeMs ?? -1) !== (right.startTimeMs ?? -1)) {
      return (left.startTimeMs ?? -1) - (right.startTimeMs ?? -1)
    }

    return left.toolName.localeCompare(right.toolName)
  })
  const failureCount = sortedGroup.filter((invocation) => invocation.outcome === 'failed').length
  const successCount = sortedGroup.filter((invocation) => invocation.outcome === 'succeeded').length
  const lastInvocation = sortedGroup.at(-1)
  const latestError = [...sortedGroup].reverse().find((invocation) => invocation.errorValueSnippet)?.errorValueSnippet

  return {
    signalType,
    runId: sortedGroup[0].runId,
    rootRunId: sortedGroup[0].rootRunId,
    toolName: sortedGroup[0].toolName,
    stepId: signalType === 'step' ? sortedGroup[0].stepId : undefined,
    attemptCount: sortedGroup.length,
    failureCount,
    successCount,
    outcome:
      lastInvocation?.outcome === 'succeeded'
        ? 'recovered'
        : lastInvocation?.outcome === 'failed'
          ? 'failed'
          : 'ongoing',
    firstAttemptTime: sortedGroup[0].startTime ?? sortedGroup[0].endTime,
    lastAttemptTime: lastInvocation?.endTime ?? lastInvocation?.startTime,
    latestErrorValueSnippet: latestError,
  }
}

function summarizeStepBottlenecks(runs: ReconstructedRun[]): StepBottleneckReport[] {
  const bottlenecks: StepBottleneckReport[] = []

  for (const run of runs) {
    const steps = new Map<string, NormalizedLogEvent[]>()

    for (const event of run.timeline) {
      if (!event.stepId) {
        continue
      }

      const stepEvents = steps.get(event.stepId) ?? []
      stepEvents.push(event)
      steps.set(event.stepId, stepEvents)
    }

    for (const [stepId, stepEvents] of steps) {
      const timedEvents = stepEvents.filter((event) => event.timeMs !== undefined)
      const startEvent = timedEvents[0]
      const endEvent = timedEvents.at(-1)
      const explicitDuration = [...stepEvents]
        .reverse()
        .find((event) => event.event === 'step.completed' && event.durationMs !== undefined)
        ?.durationMs
      const durationMs =
        explicitDuration ??
        inferDurationMs(startEvent?.timeMs, endEvent?.timeMs) ??
        [...stepEvents].reverse().find((event) => event.durationMs !== undefined)?.durationMs

      if (durationMs === undefined) {
        continue
      }

      bottlenecks.push({
        runId: run.runId,
        rootRunId: run.rootRunId,
        stepId,
        toolNames: [...new Set(stepEvents.map((event) => event.toolName).filter((toolName): toolName is string => Boolean(toolName)))],
        eventCount: stepEvents.length,
        startTime: startEvent?.time,
        endTime: endEvent?.time,
        durationMs,
      })
    }
  }

  return bottlenecks.sort((left, right) => {
    if (left.durationMs !== right.durationMs) {
      return right.durationMs - left.durationMs
    }

    if (left.runId !== right.runId) {
      return left.runId.localeCompare(right.runId)
    }

    return left.stepId.localeCompare(right.stepId)
  })
}

function summarizeInterEventGaps(runs: ReconstructedRun[]): InterEventGapReport[] {
  const gaps: InterEventGapReport[] = []

  for (const run of runs) {
    const timedEvents = run.timeline.filter((event) => event.timeMs !== undefined)

    for (let index = 1; index < timedEvents.length; index += 1) {
      const previous = timedEvents[index - 1]
      const current = timedEvents[index]
      const gapMs = current.timeMs! - previous.timeMs!
      if (gapMs <= 0) {
        continue
      }

      gaps.push({
        runId: run.runId,
        rootRunId: run.rootRunId,
        fromEvent: previous.event,
        toEvent: current.event,
        fromTime: previous.time,
        toTime: current.time,
        fromStepId: previous.stepId,
        toStepId: current.stepId,
        fromToolName: previous.toolName,
        toToolName: current.toolName,
        gapMs,
      })
    }
  }

  return gaps.sort((left, right) => {
    if (left.gapMs !== right.gapMs) {
      return right.gapMs - left.gapMs
    }

    if (left.runId !== right.runId) {
      return left.runId.localeCompare(right.runId)
    }

    return left.fromEvent.localeCompare(right.fromEvent)
  })
}

function summarizeWaitingSegments(runs: ReconstructedRun[]): {
  delegations: WaitingSegmentReport[]
  statusTransitions: WaitingSegmentReport[]
} {
  const delegations: WaitingSegmentReport[] = []
  const statusTransitions: WaitingSegmentReport[] = []

  for (const run of runs) {
    const pendingDelegations = new Map<string, WaitingState>()
    let activeStatusWait: WaitingState | undefined

    for (const event of run.timeline) {
      if (event.event === 'tool.started' && event.toolName?.startsWith('delegate.')) {
        pendingDelegations.set(getInvocationKey(run.runId, event), {
          subject: event.delegateName ?? event.toolName,
          startTime: event.time,
          startTimeMs: event.timeMs,
        })
      }

      if ((event.event === 'tool.completed' || event.event === 'tool.failed') && event.toolName?.startsWith('delegate.')) {
        const key = getInvocationKey(run.runId, event)
        const pendingDelegation = pendingDelegations.get(key)
        const durationMs =
          event.durationMs ??
          inferDurationMs(pendingDelegation?.startTimeMs, event.timeMs)

        if (pendingDelegation && durationMs !== undefined) {
          delegations.push({
            waitKind: 'delegation',
            runId: run.runId,
            rootRunId: run.rootRunId,
            subject: pendingDelegation.subject,
            durationMs,
            startTime: pendingDelegation.startTime,
            endTime: event.time,
            childRunId: event.childRunId,
          })
        }

        pendingDelegations.delete(key)
      }

      if (activeStatusWait && closesStatusWait(activeStatusWait.subject, event)) {
        const durationMs = inferDurationMs(activeStatusWait.startTimeMs, event.timeMs)
        if (durationMs !== undefined) {
          statusTransitions.push({
            waitKind: 'status',
            runId: run.runId,
            rootRunId: run.rootRunId,
            subject: activeStatusWait.subject,
            durationMs,
            startTime: activeStatusWait.startTime,
            endTime: event.time,
          })
        }

        activeStatusWait = undefined
      }

      const openedStatusWait = opensStatusWait(event)
      if (openedStatusWait && event.timeMs !== undefined) {
        activeStatusWait = {
          subject: openedStatusWait,
          startTime: event.time,
          startTimeMs: event.timeMs,
        }
      }
    }
  }

  return {
    delegations: delegations.sort((left, right) => right.durationMs - left.durationMs),
    statusTransitions: statusTransitions.sort((left, right) => right.durationMs - left.durationMs),
  }
}

function opensStatusWait(event: NormalizedLogEvent): string | undefined {
  if (event.event === 'approval.requested') {
    return 'approval'
  }

  if (event.event === 'clarification.requested') {
    return 'clarification'
  }

  if (event.event === 'run.interrupted') {
    return 'interrupted'
  }

  if (event.event === 'run.status_changed' && event.toStatus && WAITING_STATUSES.has(event.toStatus)) {
    return event.toStatus
  }

  return undefined
}

function closesStatusWait(activeStatus: string, event: NormalizedLogEvent): boolean {
  if (activeStatus === 'approval' && event.event === 'approval.resolved') {
    return true
  }

  if (activeStatus === 'clarification' && event.event === 'run.resumed') {
    return true
  }

  if (activeStatus === 'interrupted' && event.event === 'run.resumed') {
    return true
  }

  if (event.event === 'run.status_changed' && event.fromStatus === activeStatus && event.toStatus !== activeStatus) {
    return true
  }

  return false
}

function resolveSelectedRun(runGraph: RunGraph, selection: RunSelection): ReconstructedRun | undefined {
  if (selection.mode === 'runId') {
    return runGraph.runs.find((run) => run.runId === selection.value)
  }

  return (
    runGraph.runs.find((run) => run.runId === selection.value) ??
    runGraph.runs.find((run) => run.rootRunId === selection.value && !run.parentRunId) ??
    runGraph.runs.find((run) => run.rootRunId === selection.value)
  )
}

function collectSubtreeRuns(runGraph: RunGraph, rootRunId: string): ReconstructedRun[] {
  const runsById = new Map(runGraph.runs.map((run) => [run.runId, run]))
  const visited = new Set<string>()
  const orderedRuns: ReconstructedRun[] = []
  const queue = [rootRunId]

  while (queue.length > 0) {
    const runId = queue.shift()
    if (!runId || visited.has(runId)) {
      continue
    }

    visited.add(runId)
    const run = runsById.get(runId)
    if (!run) {
      continue
    }

    orderedRuns.push(run)
    queue.push(...run.childRunIds)
  }

  return orderedRuns
}

function sortRelatedRuns(selectedRunId: string, runs: RunReport[]): RunReport[] {
  return [...runs].sort((left, right) => {
    if (left.runId === selectedRunId) {
      return -1
    }

    if (right.runId === selectedRunId) {
      return 1
    }

    if ((left.parentRunId ?? '') !== (right.parentRunId ?? '')) {
      return (left.parentRunId ?? '').localeCompare(right.parentRunId ?? '')
    }

    return left.runId.localeCompare(right.runId)
  })
}

function toRunReport(run: ReconstructedRun): RunReport {
  return {
    runId: run.runId,
    rootRunId: run.rootRunId,
    parentRunId: run.parentRunId,
    delegateName: run.delegateName,
    childRunIds: [...run.childRunIds],
    status: run.summary.status,
    eventCount: run.summary.eventCount,
    startTime: run.summary.startTime,
    startTimeMs: run.summary.startTimeMs,
    endTime: run.summary.endTime,
    endTimeMs: run.summary.endTimeMs,
    durationMs: run.summary.durationMs,
  }
}

function buildRunTreeLines(runs: RunReport[], selectedRunId: string): string[] {
  const childrenByParent = new Map<string, RunReport[]>()
  const roots: RunReport[] = []
  const selectedRootRun = runs.find((run) => run.runId === selectedRunId)

  for (const run of runs) {
    if (run.parentRunId && runs.some((candidate) => candidate.runId === run.parentRunId)) {
      const siblings = childrenByParent.get(run.parentRunId) ?? []
      siblings.push(run)
      childrenByParent.set(run.parentRunId, siblings)
      continue
    }

    roots.push(run)
  }

  roots.sort((left, right) => {
    if (left.runId === selectedRootRun?.runId) {
      return -1
    }

    if (right.runId === selectedRootRun?.runId) {
      return 1
    }

    return left.runId.localeCompare(right.runId)
  })

  const lines: string[] = []
  for (const root of roots) {
    appendRunTreeLine(lines, childrenByParent, root, 0)
  }

  return lines
}

function appendRunTreeLine(
  lines: string[],
  childrenByParent: Map<string, RunReport[]>,
  run: RunReport,
  depth: number,
): void {
  const prefix = `${'  '.repeat(depth)}- `
  const extras = [`status=${run.status}`]
  if (run.delegateName) {
    extras.push(`delegate=${run.delegateName}`)
  }
  if (run.durationMs !== undefined) {
    extras.push(`duration=${formatDuration(run.durationMs)}`)
  }

  lines.push(`${prefix}${run.runId} (${extras.join(', ')})`)

  for (const child of [...(childrenByParent.get(run.runId) ?? [])].sort((left, right) => left.runId.localeCompare(right.runId))) {
    appendRunTreeLine(lines, childrenByParent, child, depth + 1)
  }
}

function formatTimelineEvent(event: RunDrillDownTimelineEvent): string {
  const parts = [event.time ?? 'unknown-time', event.event]

  if (event.stepId) {
    parts.push(`step=${event.stepId}`)
  }

  if (event.toolName) {
    parts.push(`tool=${event.toolName}`)
  }

  if (event.delegateName) {
    parts.push(`delegate=${event.delegateName}`)
  }

  if (event.childRunId) {
    parts.push(`child=${event.childRunId}`)
  }

  if (event.fromStatus || event.toStatus) {
    parts.push(`status=${event.fromStatus ?? '?'}->${event.toStatus ?? '?'}`)
  }

  if (event.outcome) {
    parts.push(`outcome=${event.outcome}`)
  }

  if (event.durationMs !== undefined) {
    parts.push(`duration=${formatDuration(event.durationMs)}`)
  }

  if (event.errorName || event.errorValue) {
    parts.push(`error=${[event.errorName, summarizeErrorValue(event.errorValue)].filter(Boolean).join(': ')}`)
  }

  return parts.join(' | ')
}

function formatFailureCluster(cluster: FailureClusterReport): string {
  const subject = cluster.kind === 'tool' ? cluster.toolName ?? 'unknown tool' : 'run'
  return `${subject} x${cluster.count}: ${cluster.errorName} (${cluster.errorValueSnippet})`
}

function formatRetrySignal(signal: RetrySignalReport): string {
  const base =
    signal.signalType === 'step' && signal.stepId
      ? `${signal.runId} ${signal.toolName} retried ${signal.attemptCount} times in ${signal.stepId}`
      : `${signal.runId} ${signal.toolName} retried ${signal.attemptCount} times`

  const details = [`${signal.failureCount} failures`, `outcome=${signal.outcome}`]
  if (signal.latestErrorValueSnippet) {
    details.push(`latest=${signal.latestErrorValueSnippet}`)
  }

  return `${base} (${details.join(', ')})`
}

function toReportDiagnostic(diagnostic: InputDiscoveryDiagnostic | ParseDiagnostic): ReportDiagnostic {
  if ('input' in diagnostic) {
    return {
      kind: 'discovery',
      input: diagnostic.input,
      message: diagnostic.message,
    }
  }

  return {
    kind: 'parse',
    sourceFile: diagnostic.sourceFile,
    line: diagnostic.line,
    message: diagnostic.message,
  }
}

function getToolKind(toolName: string): ToolKind {
  return toolName.startsWith('delegate.') ? 'delegate' : 'direct'
}

function getInvocationKey(runId: string, event: { toolName?: string; stepId?: string; childRunId?: string; sourceFile: string; line: number }): string {
  return [
    runId,
    event.stepId ?? event.childRunId ?? `${event.sourceFile}:${event.line}`,
    event.toolName ?? 'unknown',
    event.childRunId ?? '',
  ].join('|')
}

function isToolInvocationEvent(eventName: string): boolean {
  return eventName === 'tool.started' || eventName === 'tool.completed' || eventName === 'tool.failed'
}

function isFailureEvent(event: NormalizedLogEvent): boolean {
  if (event.event === 'tool.failed' || event.event === 'run.failed' || event.event === 'replan.required') {
    return true
  }

  return event.outcome === 'failure' && (event.event === 'tool.completed' || event.event === 'run.completed')
}

function defaultFailureName(event: NormalizedLogEvent): string {
  if (event.event === 'replan.required') {
    return 'REPLAN_REQUIRED'
  }

  if (event.event.startsWith('tool.')) {
    return 'ToolFailure'
  }

  return 'RunFailure'
}

function defaultFailureValue(event: NormalizedLogEvent): string {
  if (event.event === 'replan.required') {
    return 'Run requires replan before execution can continue.'
  }

  return event.outcome === 'failure' ? 'Structured completion reported failure.' : 'Failure recorded without a structured error payload.'
}

function formatDurationSummary(summary: OverviewReportSummary): string {
  if (
    summary.averageDurationMs === undefined ||
    summary.minimumDurationMs === undefined ||
    summary.maximumDurationMs === undefined
  ) {
    return 'unavailable'
  }

  return [
    `avg ${formatDuration(summary.averageDurationMs)}`,
    `min ${formatDuration(summary.minimumDurationMs)}`,
    `max ${formatDuration(summary.maximumDurationMs)}`,
  ].join(', ')
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`
  }

  if (durationMs < 60_000) {
    return `${trimFixed(durationMs / 1000)}s`
  }

  return `${trimFixed(durationMs / 60_000)}m`
}

function trimFixed(value: number): string {
  return value.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')
}

function formatDiagnostic(diagnostic: ReportDiagnostic): string {
  if (diagnostic.kind === 'discovery') {
    return `${diagnostic.input}: ${diagnostic.message}`
  }

  if (diagnostic.line !== undefined) {
    return `${diagnostic.sourceFile}:${diagnostic.line}: ${diagnostic.message}`
  }

  return `${diagnostic.sourceFile}: ${diagnostic.message}`
}

function summarizeErrorValue(errorValue: string | undefined): string | undefined {
  if (!errorValue) {
    return undefined
  }

  const collapsed = errorValue.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= 96) {
    return collapsed
  }

  return `${collapsed.slice(0, 93)}...`
}

function inferDurationMs(startTimeMs?: number, endTimeMs?: number): number | undefined {
  if (startTimeMs === undefined || endTimeMs === undefined) {
    return undefined
  }

  return Math.max(0, endTimeMs - startTimeMs)
}

function compareNumbers(left: number | undefined, right: number | undefined, fallback: number): number {
  if (left === undefined && right === undefined) {
    return fallback
  }

  if (left === undefined) {
    return 1
  }

  if (right === undefined) {
    return -1
  }

  return left - right || fallback
}
