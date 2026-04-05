import type { NormalizedLogEvent } from './normalize.js'
import { buildAnalysisReport, type AnalysisReport, type AnalysisReportOptions, type RunReport } from './report.js'
import type { ReconstructedRun } from './runs.js'

export type CohortTimeWindow = 'hour' | 'day'

export interface CompareThresholds {
  durationMultiplier: number
  successRateDrop: number
  tokenMultiplier: number
  toolCountMultiplier: number
  minimumBaselineRuns: number
}

export interface ComparisonOptions {
  timeWindow?: CohortTimeWindow
  thresholds?: Partial<CompareThresholds>
}

export interface ExtendedRunReport extends RunReport {
  provider: string
  model: string
  promptTokens?: number
  completionTokens?: number
  reasoningTokens?: number
  totalTokens?: number
  estimatedCostUsd?: number
  toolInvocationCount: number
}

export interface CohortComparison {
  baselineKind: 'overall' | 'previous_window'
  baselineRunCount: number
  averageDurationMsDelta?: number
  averageDurationMsDeltaRatio?: number
  successRateDelta?: number
  averageTotalTokensDelta?: number
  averageTotalTokensDeltaRatio?: number
  averageToolInvocationCountDelta?: number
  averageToolInvocationCountDeltaRatio?: number
}

export interface CohortReport {
  cohortId: string
  provider: string
  model: string
  delegateName: string
  timeWindow: CohortTimeWindow
  timeWindowStart?: string
  timeWindowEnd?: string
  runCount: number
  successCount: number
  failureCount: number
  successRate?: number
  averageDurationMs?: number
  totalTokens?: number
  averageTotalTokens?: number
  averageToolInvocationCount?: number
  comparisons: CohortComparison[]
}

export interface AnomalyFinding {
  severity: 'warning' | 'critical'
  kind: 'duration' | 'success_rate' | 'token_usage' | 'tool_count'
  baselineKind: 'overall' | 'previous_window'
  cohortId: string
  provider: string
  model: string
  delegateName: string
  timeWindowStart?: string
  runCount: number
  currentValue: number
  baselineValue: number
  message: string
}

export interface AnalysisBundle extends Omit<AnalysisReport, 'runs'> {
  runs: ExtendedRunReport[]
  cohorts: CohortReport[]
  anomalies: AnomalyFinding[]
}

interface CohortAccumulator {
  cohortId: string
  provider: string
  model: string
  delegateName: string
  timeWindow: CohortTimeWindow
  timeWindowStart?: string
  timeWindowEnd?: string
  timeWindowStartMs?: number
  runs: ExtendedRunReport[]
}

interface CohortMetrics {
  runCount: number
  successCount: number
  failureCount: number
  successRate?: number
  averageDurationMs?: number
  totalTokens?: number
  averageTotalTokens?: number
  averageToolInvocationCount?: number
}

interface UsageSummary {
  provider?: string
  model?: string
  promptTokens?: number
  completionTokens?: number
  reasoningTokens?: number
  totalTokens?: number
  estimatedCostUsd?: number
}

export const DEFAULT_COMPARE_THRESHOLDS: CompareThresholds = {
  durationMultiplier: 1.5,
  successRateDrop: 0.15,
  tokenMultiplier: 1.5,
  toolCountMultiplier: 1.5,
  minimumBaselineRuns: 1,
}

export function buildAnalysisBundle(
  options: AnalysisReportOptions,
  comparisonOptions: ComparisonOptions = {},
): AnalysisBundle {
  const baseReport = buildAnalysisReport(options)
  const runs = buildExtendedRunReports(options.runGraph.runs, baseReport.runs)
  const cohorts = buildCohortReports(runs, comparisonOptions.timeWindow ?? 'day')
  const anomalies = buildAnomalyFindings(cohorts, resolveCompareThresholds(comparisonOptions.thresholds))

  return {
    summary: baseReport.summary,
    runs,
    tools: baseReport.tools,
    failures: baseReport.failures,
    bottlenecks: baseReport.bottlenecks,
    cohorts,
    anomalies,
    diagnostics: baseReport.diagnostics,
  }
}

export function buildExtendedRunReports(runs: ReconstructedRun[], baseRuns: RunReport[]): ExtendedRunReport[] {
  const baseRunsById = new Map(baseRuns.map((run) => [run.runId, run]))
  const toolCountsByRun = countToolInvocationsByRun(runs)

  return runs.map((run) => {
    const baseRun = baseRunsById.get(run.runId)
    if (!baseRun) {
      throw new Error(`Missing base run report for ${run.runId}.`)
    }

    const usage = resolveUsageSummary(run.timeline)

    return {
      ...baseRun,
      provider: usage.provider ?? resolveLatestString(run.timeline, 'provider') ?? 'unknown',
      model: usage.model ?? resolveLatestString(run.timeline, 'model') ?? 'unknown',
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      reasoningTokens: usage.reasoningTokens,
      totalTokens: usage.totalTokens,
      estimatedCostUsd: usage.estimatedCostUsd,
      toolInvocationCount: toolCountsByRun.get(run.runId) ?? 0,
    }
  })
}

export function buildCohortReports(runs: ExtendedRunReport[], timeWindow: CohortTimeWindow): CohortReport[] {
  const cohorts = new Map<string, CohortAccumulator>()

  for (const run of runs) {
    const window = getTimeWindow(run.startTimeMs, timeWindow)
    const delegateName = run.delegateName ?? 'root'
    const cohortId = [run.provider, run.model, delegateName, window.timeWindowStart ?? 'unknown'].join('|')
    const cohort =
      cohorts.get(cohortId) ??
      ({
        cohortId,
        provider: run.provider,
        model: run.model,
        delegateName,
        timeWindow,
        timeWindowStart: window.timeWindowStart,
        timeWindowEnd: window.timeWindowEnd,
        timeWindowStartMs: window.timeWindowStartMs,
        runs: [],
      } satisfies CohortAccumulator)

    cohort.runs.push(run)
    cohorts.set(cohortId, cohort)
  }

  const orderedCohorts = [...cohorts.values()]
    .map((cohort) => ({ cohort, metrics: summarizeCohortMetrics(cohort.runs) }))
    .sort((left, right) => {
      if ((left.cohort.timeWindowStartMs ?? -1) !== (right.cohort.timeWindowStartMs ?? -1)) {
        return (left.cohort.timeWindowStartMs ?? -1) - (right.cohort.timeWindowStartMs ?? -1)
      }

      return left.cohort.cohortId.localeCompare(right.cohort.cohortId)
    })

  const overallMetrics = summarizeCohortMetrics(runs)
  const previousByDimension = new Map<string, { cohort: CohortAccumulator; metrics: CohortMetrics }>()

  return orderedCohorts.map(({ cohort, metrics }) => {
    const comparisons: CohortComparison[] = []
    const dimensionKey = [cohort.provider, cohort.model, cohort.delegateName].join('|')
    const previous = previousByDimension.get(dimensionKey)

    if (overallMetrics.runCount > 0) {
      comparisons.push(buildCohortComparison('overall', metrics, overallMetrics))
    }

    if (previous && previous.cohort.cohortId !== cohort.cohortId) {
      comparisons.push(buildCohortComparison('previous_window', metrics, previous.metrics))
    }

    previousByDimension.set(dimensionKey, { cohort, metrics })

    return {
      cohortId: cohort.cohortId,
      provider: cohort.provider,
      model: cohort.model,
      delegateName: cohort.delegateName,
      timeWindow: cohort.timeWindow,
      timeWindowStart: cohort.timeWindowStart,
      timeWindowEnd: cohort.timeWindowEnd,
      runCount: metrics.runCount,
      successCount: metrics.successCount,
      failureCount: metrics.failureCount,
      successRate: metrics.successRate,
      averageDurationMs: metrics.averageDurationMs,
      totalTokens: metrics.totalTokens,
      averageTotalTokens: metrics.averageTotalTokens,
      averageToolInvocationCount: metrics.averageToolInvocationCount,
      comparisons,
    }
  })
}

export function buildAnomalyFindings(cohorts: CohortReport[], thresholds: CompareThresholds): AnomalyFinding[] {
  const findings: AnomalyFinding[] = []

  for (const cohort of cohorts) {
    for (const comparison of cohort.comparisons) {
      if (comparison.baselineRunCount < thresholds.minimumBaselineRuns || cohort.runCount < thresholds.minimumBaselineRuns) {
        continue
      }

      if (
        cohort.averageDurationMs !== undefined &&
        comparison.averageDurationMsDeltaRatio !== undefined &&
        comparison.averageDurationMsDelta !== undefined &&
        comparison.averageDurationMsDelta > 0 &&
        1 + comparison.averageDurationMsDeltaRatio >= thresholds.durationMultiplier
      ) {
        findings.push({
          severity: 1 + comparison.averageDurationMsDeltaRatio >= thresholds.durationMultiplier * 1.5 ? 'critical' : 'warning',
          kind: 'duration',
          baselineKind: comparison.baselineKind,
          cohortId: cohort.cohortId,
          provider: cohort.provider,
          model: cohort.model,
          delegateName: cohort.delegateName,
          timeWindowStart: cohort.timeWindowStart,
          runCount: cohort.runCount,
          currentValue: cohort.averageDurationMs,
          baselineValue: cohort.averageDurationMs - comparison.averageDurationMsDelta,
          message: `${formatCohortLabel(cohort)} averaged ${formatNumber(cohort.averageDurationMs)}ms per run, ${formatSignedPercent(
            comparison.averageDurationMsDeltaRatio,
          )} slower than the ${formatBaselineKind(comparison.baselineKind)} baseline.`,
        })
      }

      if (
        cohort.successRate !== undefined &&
        comparison.successRateDelta !== undefined &&
        comparison.successRateDelta < 0 &&
        Math.abs(comparison.successRateDelta) >= thresholds.successRateDrop
      ) {
        findings.push({
          severity: Math.abs(comparison.successRateDelta) >= thresholds.successRateDrop * 2 ? 'critical' : 'warning',
          kind: 'success_rate',
          baselineKind: comparison.baselineKind,
          cohortId: cohort.cohortId,
          provider: cohort.provider,
          model: cohort.model,
          delegateName: cohort.delegateName,
          timeWindowStart: cohort.timeWindowStart,
          runCount: cohort.runCount,
          currentValue: cohort.successRate,
          baselineValue: cohort.successRate - comparison.successRateDelta,
          message: `${formatCohortLabel(cohort)} succeeded ${formatPercent(cohort.successRate)}, down ${formatPercent(
            Math.abs(comparison.successRateDelta),
          )} from the ${formatBaselineKind(comparison.baselineKind)} baseline.`,
        })
      }

      if (
        cohort.averageTotalTokens !== undefined &&
        comparison.averageTotalTokensDeltaRatio !== undefined &&
        comparison.averageTotalTokensDelta !== undefined &&
        comparison.averageTotalTokensDelta > 0 &&
        1 + comparison.averageTotalTokensDeltaRatio >= thresholds.tokenMultiplier
      ) {
        findings.push({
          severity: 1 + comparison.averageTotalTokensDeltaRatio >= thresholds.tokenMultiplier * 1.5 ? 'critical' : 'warning',
          kind: 'token_usage',
          baselineKind: comparison.baselineKind,
          cohortId: cohort.cohortId,
          provider: cohort.provider,
          model: cohort.model,
          delegateName: cohort.delegateName,
          timeWindowStart: cohort.timeWindowStart,
          runCount: cohort.runCount,
          currentValue: cohort.averageTotalTokens,
          baselineValue: cohort.averageTotalTokens - comparison.averageTotalTokensDelta,
          message: `${formatCohortLabel(cohort)} used ${formatNumber(cohort.averageTotalTokens)} average tokens per run, ${formatSignedPercent(
            comparison.averageTotalTokensDeltaRatio,
          )} above the ${formatBaselineKind(comparison.baselineKind)} baseline.`,
        })
      }

      if (
        cohort.averageToolInvocationCount !== undefined &&
        comparison.averageToolInvocationCountDeltaRatio !== undefined &&
        comparison.averageToolInvocationCountDelta !== undefined &&
        comparison.averageToolInvocationCountDelta > 0 &&
        1 + comparison.averageToolInvocationCountDeltaRatio >= thresholds.toolCountMultiplier
      ) {
        findings.push({
          severity: 1 + comparison.averageToolInvocationCountDeltaRatio >= thresholds.toolCountMultiplier * 1.5 ? 'critical' : 'warning',
          kind: 'tool_count',
          baselineKind: comparison.baselineKind,
          cohortId: cohort.cohortId,
          provider: cohort.provider,
          model: cohort.model,
          delegateName: cohort.delegateName,
          timeWindowStart: cohort.timeWindowStart,
          runCount: cohort.runCount,
          currentValue: cohort.averageToolInvocationCount,
          baselineValue: cohort.averageToolInvocationCount - comparison.averageToolInvocationCountDelta,
          message: `${formatCohortLabel(cohort)} averaged ${trimFixed(cohort.averageToolInvocationCount)} tool invocations per run, ${formatSignedPercent(
            comparison.averageToolInvocationCountDeltaRatio,
          )} above the ${formatBaselineKind(comparison.baselineKind)} baseline.`,
        })
      }
    }
  }

  return findings.sort((left, right) => {
    if (left.severity !== right.severity) {
      return left.severity === 'critical' ? -1 : 1
    }

    if (left.kind !== right.kind) {
      return left.kind.localeCompare(right.kind)
    }

    return left.cohortId.localeCompare(right.cohortId)
  })
}

export function resolveCompareThresholds(overrides: Partial<CompareThresholds> | undefined): CompareThresholds {
  return {
    ...DEFAULT_COMPARE_THRESHOLDS,
    ...overrides,
  }
}

function countToolInvocationsByRun(runs: ReconstructedRun[]): Map<string, number> {
  const keysByRun = new Map<string, Set<string>>()

  for (const run of runs) {
    const invocationKeys = keysByRun.get(run.runId) ?? new Set<string>()

    for (const event of run.timeline) {
      if (!event.toolName || !isToolInvocationEvent(event.event)) {
        continue
      }

      invocationKeys.add(getInvocationKey(run.runId, event))
    }

    keysByRun.set(run.runId, invocationKeys)
  }

  return new Map([...keysByRun.entries()].map(([runId, keys]) => [runId, keys.size]))
}

function resolveUsageSummary(timeline: NormalizedLogEvent[]): UsageSummary {
  const usageSummary: UsageSummary = {}

  for (const event of [...timeline].reverse()) {
    const usage = extractUsageSummary(event)

    if (!usageSummary.provider) {
      usageSummary.provider = usage.provider ?? event.provider
    }
    if (!usageSummary.model) {
      usageSummary.model = usage.model ?? event.model
    }
    if (usageSummary.promptTokens === undefined) {
      usageSummary.promptTokens = usage.promptTokens
    }
    if (usageSummary.completionTokens === undefined) {
      usageSummary.completionTokens = usage.completionTokens
    }
    if (usageSummary.reasoningTokens === undefined) {
      usageSummary.reasoningTokens = usage.reasoningTokens
    }
    if (usageSummary.totalTokens === undefined) {
      usageSummary.totalTokens = usage.totalTokens
    }
    if (usageSummary.estimatedCostUsd === undefined) {
      usageSummary.estimatedCostUsd = usage.estimatedCostUsd
    }
  }

  if (usageSummary.totalTokens === undefined) {
    const derivedTotal = [usageSummary.promptTokens, usageSummary.completionTokens, usageSummary.reasoningTokens]
      .filter((value): value is number => value !== undefined)
      .reduce((sum, value) => sum + value, 0)

    if (derivedTotal > 0) {
      usageSummary.totalTokens = derivedTotal
    }
  }

  return usageSummary
}

function extractUsageSummary(event: NormalizedLogEvent): UsageSummary {
  const usageCandidates = [
    readRecord(event.raw.usage),
    readRecord(readRecord(event.raw.result)?.usage),
    readRecord(readRecord(event.raw.output)?.usage),
  ].filter((value): value is Record<string, unknown> => value !== undefined)

  for (const usage of usageCandidates) {
    const promptTokens = readNumber(usage.promptTokens)
    const completionTokens = readNumber(usage.completionTokens)
    const reasoningTokens = readNumber(usage.reasoningTokens)
    const totalTokens = readNumber(usage.totalTokens)
    const estimatedCostUsd = readNumber(usage.estimatedCostUSD)

    if (
      promptTokens !== undefined ||
      completionTokens !== undefined ||
      reasoningTokens !== undefined ||
      totalTokens !== undefined ||
      estimatedCostUsd !== undefined ||
      readString(usage.provider) ||
      readString(usage.model)
    ) {
      return {
        provider: readString(usage.provider),
        model: readString(usage.model),
        promptTokens,
        completionTokens,
        reasoningTokens,
        totalTokens,
        estimatedCostUsd,
      }
    }
  }

  return {}
}

function resolveLatestString(timeline: NormalizedLogEvent[], key: 'provider' | 'model'): string | undefined {
  for (const event of [...timeline].reverse()) {
    const value = event[key]
    if (value) {
      return value
    }
  }

  return undefined
}

function summarizeCohortMetrics(runs: ExtendedRunReport[]): CohortMetrics {
  const successCount = runs.filter((run) => run.status === 'succeeded').length
  const failureCount = runs.filter((run) => run.status === 'failed' || run.status === 'replan_required').length
  const durationSamples = runs.map((run) => run.durationMs).filter((value): value is number => value !== undefined)
  const tokenSamples = runs.map((run) => run.totalTokens).filter((value): value is number => value !== undefined)
  const toolInvocationTotal = runs.reduce((sum, run) => sum + run.toolInvocationCount, 0)

  return {
    runCount: runs.length,
    successCount,
    failureCount,
    successRate: runs.length > 0 ? successCount / runs.length : undefined,
    averageDurationMs: durationSamples.length > 0 ? Math.round(average(durationSamples)) : undefined,
    totalTokens: tokenSamples.length > 0 ? tokenSamples.reduce((sum, value) => sum + value, 0) : undefined,
    averageTotalTokens: tokenSamples.length > 0 ? Math.round(average(tokenSamples)) : undefined,
    averageToolInvocationCount: runs.length > 0 ? Number((toolInvocationTotal / runs.length).toFixed(2)) : undefined,
  }
}

function buildCohortComparison(
  baselineKind: 'overall' | 'previous_window',
  current: CohortMetrics,
  baseline: CohortMetrics,
): CohortComparison {
  return {
    baselineKind,
    baselineRunCount: baseline.runCount,
    averageDurationMsDelta: diff(current.averageDurationMs, baseline.averageDurationMs),
    averageDurationMsDeltaRatio: ratioDelta(current.averageDurationMs, baseline.averageDurationMs),
    successRateDelta: diff(current.successRate, baseline.successRate),
    averageTotalTokensDelta: diff(current.averageTotalTokens, baseline.averageTotalTokens),
    averageTotalTokensDeltaRatio: ratioDelta(current.averageTotalTokens, baseline.averageTotalTokens),
    averageToolInvocationCountDelta: diff(current.averageToolInvocationCount, baseline.averageToolInvocationCount),
    averageToolInvocationCountDeltaRatio: ratioDelta(
      current.averageToolInvocationCount,
      baseline.averageToolInvocationCount,
    ),
  }
}

function getTimeWindow(
  startTimeMs: number | undefined,
  timeWindow: CohortTimeWindow,
): { timeWindowStart?: string; timeWindowEnd?: string; timeWindowStartMs?: number } {
  if (startTimeMs === undefined) {
    return {}
  }

  const bucketStart = new Date(startTimeMs)
  bucketStart.setUTCMinutes(0, 0, 0)

  if (timeWindow === 'day') {
    bucketStart.setUTCHours(0, 0, 0, 0)
  }

  const timeWindowStartMs = bucketStart.getTime()
  const timeWindowEndMs = timeWindowStartMs + (timeWindow === 'hour' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000)

  return {
    timeWindowStart: new Date(timeWindowStartMs).toISOString(),
    timeWindowEnd: new Date(timeWindowEndMs).toISOString(),
    timeWindowStartMs,
  }
}

function formatCohortLabel(cohort: CohortReport): string {
  const parts = [cohort.provider, cohort.model, cohort.delegateName]
  if (cohort.timeWindowStart) {
    parts.push(cohort.timeWindowStart)
  }

  return parts.join(' / ')
}

function formatBaselineKind(baselineKind: CohortComparison['baselineKind']): string {
  return baselineKind === 'overall' ? 'overall' : 'previous-window'
}

function formatNumber(value: number): string {
  return trimFixed(value)
}

function formatPercent(value: number): string {
  return `${trimFixed(value * 100)}%`
}

function formatSignedPercent(value: number): string {
  const sign = value >= 0 ? '+' : ''
  return `${sign}${trimFixed(value * 100)}%`
}

function trimFixed(value: number): string {
  return value.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function diff(current: number | undefined, baseline: number | undefined): number | undefined {
  if (current === undefined || baseline === undefined) {
    return undefined
  }

  return Number((current - baseline).toFixed(4))
}

function ratioDelta(current: number | undefined, baseline: number | undefined): number | undefined {
  if (current === undefined || baseline === undefined || baseline === 0) {
    return undefined
  }

  return Number((((current - baseline) / baseline)).toFixed(4))
}

function getInvocationKey(
  runId: string,
  event: { toolName?: string; stepId?: string; childRunId?: string; sourceFile: string; line: number },
): string {
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

function readRecord(value: unknown): Record<string, unknown> | undefined {
  const unwrapped = unwrapCapturedValue(value)
  if (typeof unwrapped !== 'object' || unwrapped === null || Array.isArray(unwrapped)) {
    return undefined
  }

  return unwrapped as Record<string, unknown>
}

function unwrapCapturedValue(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value
  }

  const record = value as Record<string, unknown>
  if ('preview' in record) {
    return unwrapCapturedValue(record.preview)
  }

  return value
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
