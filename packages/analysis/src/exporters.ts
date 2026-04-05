import type { AnalysisBundle, AnomalyFinding, CohortComparison, CohortReport, ExtendedRunReport } from './compare.js'
import type { FailureClusterReport, RetrySignalReport, RunDrillDownReport, RunDrillDownTimelineEvent } from './report.js'

export type ReportView = 'overview' | 'failures' | 'bottlenecks' | 'compare'
export type ReportOutputFormat =
  | 'terminal'
  | 'json'
  | 'markdown'
  | 'html'
  | 'csv:runs'
  | 'csv:tools'
  | 'csv:failures'
  | 'csv:cohorts'

export interface RenderedOutput {
  format: ReportOutputFormat
  content: string
  defaultFileName: string
}

const CSV_OUTPUT_FORMATS: ReportOutputFormat[] = ['csv:runs', 'csv:tools', 'csv:failures', 'csv:cohorts']

export function parseOutputFormats(specs: string[]): ReportOutputFormat[] {
  const formats: ReportOutputFormat[] = []

  for (const spec of specs) {
    for (const rawToken of spec.split(',')) {
      const token = rawToken.trim().toLowerCase()
      if (!token) {
        continue
      }

      if (token === 'terminal' || token === 'json' || token === 'markdown' || token === 'html') {
        pushUnique(formats, token)
        continue
      }

      if (token === 'md') {
        pushUnique(formats, 'markdown')
        continue
      }

      if (token === 'csv') {
        for (const csvFormat of CSV_OUTPUT_FORMATS) {
          pushUnique(formats, csvFormat)
        }
        continue
      }

      if (CSV_OUTPUT_FORMATS.includes(token as ReportOutputFormat)) {
        pushUnique(formats, token as ReportOutputFormat)
        continue
      }

      throw new Error(`Unsupported format: ${rawToken}.`)
    }
  }

  return formats
}

export function renderAnalysisOutputs(
  bundle: AnalysisBundle,
  options: { formats: ReportOutputFormat[]; view: ReportView; drillDownReport?: RunDrillDownReport },
): RenderedOutput[] {
  return options.formats.map((format) => ({
    format,
    content: options.drillDownReport
      ? renderDrillDownOutput(format, options.drillDownReport)
      : renderBundleOutput(format, bundle, options.view),
    defaultFileName: getDefaultOutputFileName(format),
  }))
}

export function getDefaultOutputFileName(format: ReportOutputFormat): string {
  switch (format) {
    case 'terminal':
      return 'analysis.txt'
    case 'json':
      return 'analysis.json'
    case 'markdown':
      return 'analysis.md'
    case 'html':
      return 'analysis.html'
    case 'csv:runs':
      return 'runs.csv'
    case 'csv:tools':
      return 'tools.csv'
    case 'csv:failures':
      return 'failures.csv'
    case 'csv:cohorts':
      return 'cohorts.csv'
  }
}

function renderBundleOutput(format: ReportOutputFormat, bundle: AnalysisBundle, view: ReportView): string {
  switch (format) {
    case 'terminal':
      return formatTerminalBundle(bundle, view)
    case 'json':
      return JSON.stringify(bundle, null, 2)
    case 'markdown':
      return formatMarkdownBundle(bundle, view)
    case 'html':
      return formatHtmlBundle(bundle, view)
    case 'csv:runs':
      return formatRunsCsv(bundle.runs)
    case 'csv:tools':
      return formatToolsCsv(bundle)
    case 'csv:failures':
      return formatFailuresCsv(bundle.failures.clusters)
    case 'csv:cohorts':
      return formatCohortsCsv(bundle.cohorts)
  }
}

function renderDrillDownOutput(format: ReportOutputFormat, report: RunDrillDownReport): string {
  switch (format) {
    case 'terminal':
      return formatDrillDownTerminal(report)
    case 'json':
      return JSON.stringify(report, null, 2)
    case 'markdown':
      return formatDrillDownMarkdown(report)
    case 'html':
      return formatDrillDownHtml(report)
    default:
      throw new Error(`Format ${format} is not supported for drill-down output.`)
  }
}

function formatTerminalBundle(bundle: AnalysisBundle, view: ReportView): string {
  const lines = [
    'analysis analyze',
    '',
    `Inputs received: ${bundle.summary.inputCount}`,
    `Files matched: ${bundle.summary.fileCount}`,
    `Events parsed: ${bundle.summary.eventCount}`,
    `Malformed lines: ${bundle.summary.malformedLineCount}`,
    `Runs discovered: ${bundle.summary.runCount}`,
    `Successful runs: ${bundle.summary.successCount}`,
    `Failed runs: ${bundle.summary.failedCount}`,
  ]

  if (bundle.summary.unfinishedCount > 0) {
    lines.push(`Unfinished runs: ${bundle.summary.unfinishedCount}`)
  }

  lines.push(`Duration summary: ${formatDurationSummary(bundle)}`)

  if (view !== 'compare' && bundle.summary.topTools.length > 0) {
    lines.push('', 'Top tools:')
    for (const tool of bundle.summary.topTools) {
      lines.push(`- ${tool.toolName}: ${tool.invocationCount}`)
    }
  }

  if (view === 'overview' || view === 'failures') {
    lines.push('', 'Failure clusters:')
    if (bundle.failures.clusters.length === 0) {
      lines.push('- none')
    } else {
      for (const cluster of bundle.failures.clusters.slice(0, 8)) {
        lines.push(`- ${formatFailureCluster(cluster)}`)
      }
    }

    lines.push('', 'Retry signals:')
    if (bundle.failures.retrySignals.length === 0) {
      lines.push('- none')
    } else {
      for (const signal of bundle.failures.retrySignals.slice(0, 8)) {
        lines.push(`- ${formatRetrySignal(signal)}`)
      }
    }
  }

  if (view === 'overview' || view === 'bottlenecks') {
    lines.push('', 'Bottlenecks:')
    const bottlenecks = bundle.bottlenecks
    if (
      bottlenecks.slowestRuns.length === 0 &&
      bottlenecks.slowestSteps.length === 0 &&
      bottlenecks.longestInterEventGaps.length === 0 &&
      bottlenecks.waitingTime.totalEstimatedWaitMs === 0
    ) {
      lines.push('- none')
    } else {
      const slowestRun = bottlenecks.slowestRuns[0]
      if (slowestRun?.durationMs !== undefined) {
        lines.push(`- Slowest run: ${slowestRun.runId} (${formatDuration(slowestRun.durationMs)})`)
      }
      const slowestStep = bottlenecks.slowestSteps[0]
      if (slowestStep) {
        lines.push(`- Slowest step: ${slowestStep.runId}/${slowestStep.stepId} (${formatDuration(slowestStep.durationMs)})`)
      }
      const longestGap = bottlenecks.longestInterEventGaps[0]
      if (longestGap) {
        lines.push(
          `- Longest gap: ${longestGap.runId} ${longestGap.fromEvent} -> ${longestGap.toEvent} (${formatDuration(longestGap.gapMs)})`,
        )
      }
      if (bottlenecks.waitingTime.totalEstimatedWaitMs > 0) {
        lines.push(
          `- Estimated waiting: ${formatDuration(bottlenecks.waitingTime.totalEstimatedWaitMs)} total (${formatDuration(
            bottlenecks.waitingTime.delegationWaitMs,
          )} delegation, ${formatDuration(bottlenecks.waitingTime.statusWaitMs)} status)`,
        )
      }
    }
  }

  if (view === 'overview' || view === 'compare') {
    lines.push('', 'Cohorts:')
    if (bundle.cohorts.length === 0) {
      lines.push('- none')
    } else {
      for (const cohort of bundle.cohorts.slice(0, 8)) {
        lines.push(`- ${formatCohortLine(cohort)}`)
      }
    }

    lines.push('', 'Anomalies:')
    if (bundle.anomalies.length === 0) {
      lines.push('- none')
    } else {
      for (const anomaly of bundle.anomalies.slice(0, 8)) {
        lines.push(`- [${anomaly.severity}] ${anomaly.message}`)
      }
    }
  }

  if (bundle.summary.unassignedEventCount > 0) {
    lines.push('', `Unassigned events: ${bundle.summary.unassignedEventCount}`)
  }

  if (bundle.diagnostics.length > 0) {
    lines.push('', 'Diagnostics:')
    for (const diagnostic of bundle.diagnostics) {
      lines.push(`- ${formatDiagnostic(diagnostic)}`)
    }
  }

  return lines.join('\n')
}

function formatMarkdownBundle(bundle: AnalysisBundle, view: ReportView): string {
  const lines = ['# Analysis Report', '']

  lines.push('## Summary', '')
  lines.push(`- Inputs received: ${bundle.summary.inputCount}`)
  lines.push(`- Files matched: ${bundle.summary.fileCount}`)
  lines.push(`- Events parsed: ${bundle.summary.eventCount}`)
  lines.push(`- Malformed lines: ${bundle.summary.malformedLineCount}`)
  lines.push(`- Runs discovered: ${bundle.summary.runCount}`)
  lines.push(`- Successful runs: ${bundle.summary.successCount}`)
  lines.push(`- Failed runs: ${bundle.summary.failedCount}`)
  if (bundle.summary.unfinishedCount > 0) {
    lines.push(`- Unfinished runs: ${bundle.summary.unfinishedCount}`)
  }
  lines.push(`- Duration summary: ${formatDurationSummary(bundle)}`)
  lines.push('')

  if ((view === 'overview' || view === 'failures') && bundle.failures.clusters.length > 0) {
    lines.push('## Failure Clusters', '')
    lines.push('| Kind | Subject | Count | Error | Snippet |', '| --- | --- | ---: | --- | --- |')
    for (const cluster of bundle.failures.clusters) {
      lines.push(
        `| ${cluster.kind} | ${cluster.toolName ?? 'run'} | ${cluster.count} | ${escapeMarkdown(cluster.errorName)} | ${escapeMarkdown(
          cluster.errorValueSnippet,
        )} |`,
      )
    }
    lines.push('')
  }

  if ((view === 'overview' || view === 'bottlenecks') && bundle.bottlenecks.slowestRuns.length > 0) {
    lines.push('## Bottlenecks', '')
    lines.push('| Type | Subject | Detail |', '| --- | --- | --- |')
    const slowestRun = bundle.bottlenecks.slowestRuns[0]
    lines.push(`| Slowest run | ${slowestRun.runId} | ${formatDurationOrUnavailable(slowestRun.durationMs)} |`)
    const slowestStep = bundle.bottlenecks.slowestSteps[0]
    if (slowestStep) {
      lines.push(`| Slowest step | ${slowestStep.runId}/${slowestStep.stepId} | ${formatDuration(slowestStep.durationMs)} |`)
    }
    const longestGap = bundle.bottlenecks.longestInterEventGaps[0]
    if (longestGap) {
      lines.push(
        `| Longest gap | ${longestGap.runId} | ${escapeMarkdown(`${longestGap.fromEvent} -> ${longestGap.toEvent} (${formatDuration(longestGap.gapMs)})`)} |`,
      )
    }
    lines.push('')
  }

  if (view === 'overview' || view === 'compare') {
    lines.push('## Cohorts', '')
    lines.push(
      '| Provider | Model | Delegate | Window Start | Runs | Success Rate | Avg Duration | Avg Tokens | Avg Tools |',
      '| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |',
    )
    for (const cohort of bundle.cohorts) {
      lines.push(
        `| ${escapeMarkdown(cohort.provider)} | ${escapeMarkdown(cohort.model)} | ${escapeMarkdown(
          cohort.delegateName,
        )} | ${cohort.timeWindowStart ?? 'unknown'} | ${cohort.runCount} | ${formatPercentOrUnavailable(
          cohort.successRate,
        )} | ${formatNumberOrUnavailable(cohort.averageDurationMs)} | ${formatNumberOrUnavailable(
          cohort.averageTotalTokens,
        )} | ${formatNumberOrUnavailable(cohort.averageToolInvocationCount)} |`,
      )
    }
    lines.push('')

    lines.push('## Anomalies', '')
    if (bundle.anomalies.length === 0) {
      lines.push('No anomalies detected.', '')
    } else {
      for (const anomaly of bundle.anomalies) {
        lines.push(`- **${anomaly.severity}**: ${escapeMarkdown(anomaly.message)}`)
      }
      lines.push('')
    }
  }

  if (bundle.diagnostics.length > 0) {
    lines.push('## Diagnostics', '')
    for (const diagnostic of bundle.diagnostics) {
      lines.push(`- ${escapeMarkdown(formatDiagnostic(diagnostic))}`)
    }
    lines.push('')
  }

  return lines.join('\n').trimEnd()
}

function formatHtmlBundle(bundle: AnalysisBundle, view: ReportView): string {
  const sections = [
    `<section><h2>Summary</h2><ul>${[
      `Inputs received: ${bundle.summary.inputCount}`,
      `Files matched: ${bundle.summary.fileCount}`,
      `Events parsed: ${bundle.summary.eventCount}`,
      `Malformed lines: ${bundle.summary.malformedLineCount}`,
      `Runs discovered: ${bundle.summary.runCount}`,
      `Successful runs: ${bundle.summary.successCount}`,
      `Failed runs: ${bundle.summary.failedCount}`,
      `Duration summary: ${formatDurationSummary(bundle)}`,
    ]
      .map((item) => `<li>${escapeHtml(item)}</li>`)
      .join('')}</ul></section>`,
  ]

  if (view === 'overview' || view === 'failures') {
    sections.push(`
<section>
  <h2>Failure Clusters</h2>
  ${renderHtmlTable(
    ['Kind', 'Subject', 'Count', 'Error', 'Snippet'],
    bundle.failures.clusters.map((cluster) => [
      cluster.kind,
      cluster.toolName ?? 'run',
      String(cluster.count),
      cluster.errorName,
      cluster.errorValueSnippet,
    ]),
  )}
</section>`.trim())
  }

  if (view === 'overview' || view === 'bottlenecks') {
    sections.push(`
<section>
  <h2>Bottlenecks</h2>
  ${renderHtmlTable(
    ['Type', 'Subject', 'Detail'],
    [
      bundle.bottlenecks.slowestRuns[0]
        ? ['Slowest run', bundle.bottlenecks.slowestRuns[0].runId, formatDurationOrUnavailable(bundle.bottlenecks.slowestRuns[0].durationMs)]
        : undefined,
      bundle.bottlenecks.slowestSteps[0]
        ? [
            'Slowest step',
            `${bundle.bottlenecks.slowestSteps[0].runId}/${bundle.bottlenecks.slowestSteps[0].stepId}`,
            formatDuration(bundle.bottlenecks.slowestSteps[0].durationMs),
          ]
        : undefined,
      bundle.bottlenecks.longestInterEventGaps[0]
        ? [
            'Longest gap',
            bundle.bottlenecks.longestInterEventGaps[0].runId,
            `${bundle.bottlenecks.longestInterEventGaps[0].fromEvent} -> ${bundle.bottlenecks.longestInterEventGaps[0].toEvent} (${formatDuration(
              bundle.bottlenecks.longestInterEventGaps[0].gapMs,
            )})`,
          ]
        : undefined,
    ].filter((row): row is string[] => row !== undefined),
  )}
</section>`.trim())
  }

  if (view === 'overview' || view === 'compare') {
    sections.push(`
<section>
  <h2>Cohorts</h2>
  ${renderHtmlTable(
    ['Provider', 'Model', 'Delegate', 'Window Start', 'Runs', 'Success Rate', 'Avg Duration', 'Avg Tokens', 'Avg Tools'],
    bundle.cohorts.map((cohort) => [
      cohort.provider,
      cohort.model,
      cohort.delegateName,
      cohort.timeWindowStart ?? 'unknown',
      String(cohort.runCount),
      formatPercentOrUnavailable(cohort.successRate),
      formatNumberOrUnavailable(cohort.averageDurationMs),
      formatNumberOrUnavailable(cohort.averageTotalTokens),
      formatNumberOrUnavailable(cohort.averageToolInvocationCount),
    ]),
  )}
</section>`.trim())

    sections.push(`
<section>
  <h2>Anomalies</h2>
  ${
    bundle.anomalies.length === 0
      ? '<p>No anomalies detected.</p>'
      : `<ul>${bundle.anomalies.map((anomaly) => `<li><strong>${escapeHtml(anomaly.severity)}</strong>: ${escapeHtml(anomaly.message)}</li>`).join('')}</ul>`
  }
</section>`.trim())
  }

  if (bundle.diagnostics.length > 0) {
    sections.push(`
<section>
  <h2>Diagnostics</h2>
  <ul>${bundle.diagnostics.map((diagnostic) => `<li>${escapeHtml(formatDiagnostic(diagnostic))}</li>`).join('')}</ul>
</section>`.trim())
  }

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <title>Analysis Report</title>',
    '  <style>',
    '    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 32px; color: #14213d; background: #f7f7f2; }',
    '    h1, h2 { color: #0b3c49; }',
    '    table { border-collapse: collapse; width: 100%; margin-bottom: 24px; }',
    '    th, td { border: 1px solid #cfd8dc; padding: 8px 10px; text-align: left; vertical-align: top; }',
    '    th { background: #d9ead3; }',
    '    section { margin-bottom: 28px; }',
    '    ul { padding-left: 20px; }',
    '  </style>',
    '</head>',
    '<body>',
    '  <h1>Analysis Report</h1>',
    ...sections.map((section) => `  ${section}`),
    '</body>',
    '</html>',
  ].join('\n')
}

function formatRunsCsv(runs: ExtendedRunReport[]): string {
  return toCsv(
    [
      'runId',
      'rootRunId',
      'parentRunId',
      'delegateName',
      'status',
      'eventCount',
      'startTime',
      'endTime',
      'durationMs',
      'provider',
      'model',
      'promptTokens',
      'completionTokens',
      'reasoningTokens',
      'totalTokens',
      'estimatedCostUsd',
      'toolInvocationCount',
      'childRunIds',
    ],
    runs.map((run) => [
      run.runId,
      run.rootRunId,
      run.parentRunId ?? '',
      run.delegateName ?? '',
      run.status,
      String(run.eventCount),
      run.startTime ?? '',
      run.endTime ?? '',
      numberField(run.durationMs),
      run.provider,
      run.model,
      numberField(run.promptTokens),
      numberField(run.completionTokens),
      numberField(run.reasoningTokens),
      numberField(run.totalTokens),
      numberField(run.estimatedCostUsd),
      String(run.toolInvocationCount),
      run.childRunIds.join('|'),
    ]),
  )
}

function formatToolsCsv(bundle: AnalysisBundle): string {
  return toCsv(
    [
      'toolName',
      'toolKind',
      'invocationCount',
      'successCount',
      'failureCount',
      'unknownCount',
      'successRate',
      'latencySampleCount',
      'averageDurationMs',
      'minimumDurationMs',
      'maximumDurationMs',
    ],
    bundle.tools.map((tool) => [
      tool.toolName,
      tool.toolKind,
      String(tool.invocationCount),
      String(tool.successCount),
      String(tool.failureCount),
      String(tool.unknownCount),
      numberField(tool.successRate),
      String(tool.latencySampleCount),
      numberField(tool.averageDurationMs),
      numberField(tool.minimumDurationMs),
      numberField(tool.maximumDurationMs),
    ]),
  )
}

function formatFailuresCsv(clusters: FailureClusterReport[]): string {
  return toCsv(
    [
      'kind',
      'toolName',
      'errorName',
      'errorValueSnippet',
      'count',
      'runIds',
      'rootRunIds',
      'latestTime',
      'exampleRunId',
      'exampleStepId',
      'exampleChildRunId',
      'exampleSourceFile',
      'exampleLine',
    ],
    clusters.map((cluster) => [
      cluster.kind,
      cluster.toolName ?? '',
      cluster.errorName,
      cluster.errorValueSnippet,
      String(cluster.count),
      cluster.runIds.join('|'),
      cluster.rootRunIds.join('|'),
      cluster.latestTime ?? '',
      cluster.example.runId,
      cluster.example.stepId ?? '',
      cluster.example.childRunId ?? '',
      cluster.example.sourceFile,
      String(cluster.example.line),
    ]),
  )
}

function formatCohortsCsv(cohorts: CohortReport[]): string {
  return toCsv(
    [
      'cohortId',
      'provider',
      'model',
      'delegateName',
      'timeWindow',
      'timeWindowStart',
      'timeWindowEnd',
      'runCount',
      'successCount',
      'failureCount',
      'successRate',
      'averageDurationMs',
      'totalTokens',
      'averageTotalTokens',
      'averageToolInvocationCount',
      'overallDurationDeltaRatio',
      'overallSuccessRateDelta',
      'overallTokenDeltaRatio',
      'overallToolDeltaRatio',
      'previousWindowDurationDeltaRatio',
      'previousWindowSuccessRateDelta',
      'previousWindowTokenDeltaRatio',
      'previousWindowToolDeltaRatio',
    ],
    cohorts.map((cohort) => {
      const overall = findComparison(cohort, 'overall')
      const previousWindow = findComparison(cohort, 'previous_window')

      return [
        cohort.cohortId,
        cohort.provider,
        cohort.model,
        cohort.delegateName,
        cohort.timeWindow,
        cohort.timeWindowStart ?? '',
        cohort.timeWindowEnd ?? '',
        String(cohort.runCount),
        String(cohort.successCount),
        String(cohort.failureCount),
        numberField(cohort.successRate),
        numberField(cohort.averageDurationMs),
        numberField(cohort.totalTokens),
        numberField(cohort.averageTotalTokens),
        numberField(cohort.averageToolInvocationCount),
        numberField(overall?.averageDurationMsDeltaRatio),
        numberField(overall?.successRateDelta),
        numberField(overall?.averageTotalTokensDeltaRatio),
        numberField(overall?.averageToolInvocationCountDeltaRatio),
        numberField(previousWindow?.averageDurationMsDeltaRatio),
        numberField(previousWindow?.successRateDelta),
        numberField(previousWindow?.averageTotalTokensDeltaRatio),
        numberField(previousWindow?.averageToolInvocationCountDeltaRatio),
      ]
    }),
  )
}

function formatDrillDownTerminal(report: RunDrillDownReport): string {
  const lines = [
    'analysis analyze',
    '',
    `Selected run: ${report.run.runId}`,
    `Requested via: ${report.selection.mode}=${report.selection.requestedId}`,
    `Root run: ${report.run.rootRunId}`,
    `Status: ${report.run.status}`,
    `Duration: ${formatDurationOrUnavailable(report.run.durationMs)}`,
    '',
    'Timeline:',
  ]

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

function formatDrillDownMarkdown(report: RunDrillDownReport): string {
  return [
    '# Run Drill-Down',
    '',
    `- Selected run: ${report.run.runId}`,
    `- Requested via: ${report.selection.mode}=${report.selection.requestedId}`,
    `- Root run: ${report.run.rootRunId}`,
    `- Status: ${report.run.status}`,
    `- Duration: ${formatDurationOrUnavailable(report.run.durationMs)}`,
    '',
    '## Timeline',
    '',
    ...report.timeline.map((event) => `- ${escapeMarkdown(formatTimelineEvent(event))}`),
    '',
    '## Failures',
    '',
    ...(report.failures.length === 0 ? ['- none'] : report.failures.map((cluster) => `- ${escapeMarkdown(formatFailureCluster(cluster))}`)),
  ].join('\n')
}

function formatDrillDownHtml(report: RunDrillDownReport): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><title>Run Drill-Down</title></head>',
    '<body>',
    '  <h1>Run Drill-Down</h1>',
    `  <p><strong>Selected run:</strong> ${escapeHtml(report.run.runId)}</p>`,
    `  <p><strong>Requested via:</strong> ${escapeHtml(`${report.selection.mode}=${report.selection.requestedId}`)}</p>`,
    `  <p><strong>Status:</strong> ${escapeHtml(report.run.status)}</p>`,
    '  <h2>Timeline</h2>',
    `  <ul>${report.timeline.map((event) => `<li>${escapeHtml(formatTimelineEvent(event))}</li>`).join('')}</ul>`,
    '  <h2>Failures</h2>',
    report.failures.length === 0
      ? '  <p>none</p>'
      : `  <ul>${report.failures.map((cluster) => `<li>${escapeHtml(formatFailureCluster(cluster))}</li>`).join('')}</ul>`,
    '</body>',
    '</html>',
  ].join('\n')
}

function formatCohortLine(cohort: CohortReport): string {
  return [
    `${cohort.provider}/${cohort.model}`,
    `delegate=${cohort.delegateName}`,
    `window=${cohort.timeWindowStart ?? 'unknown'}`,
    `runs=${cohort.runCount}`,
    `success=${formatPercentOrUnavailable(cohort.successRate)}`,
    `avg-duration=${formatNumberOrUnavailable(cohort.averageDurationMs)}ms`,
    `avg-tokens=${formatNumberOrUnavailable(cohort.averageTotalTokens)}`,
    `avg-tools=${formatNumberOrUnavailable(cohort.averageToolInvocationCount)}`,
  ].join(', ')
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
  if (event.outcome) {
    parts.push(`outcome=${event.outcome}`)
  }
  if (event.durationMs !== undefined) {
    parts.push(`duration=${formatDuration(event.durationMs)}`)
  }
  if (event.errorName || event.errorValue) {
    parts.push(`error=${[event.errorName, event.errorValue].filter(Boolean).join(': ')}`)
  }

  return parts.join(' | ')
}

function findComparison(
  cohort: CohortReport,
  baselineKind: CohortComparison['baselineKind'],
): CohortComparison | undefined {
  return cohort.comparisons.find((comparison) => comparison.baselineKind === baselineKind)
}

function renderHtmlTable(headers: string[], rows: string[][]): string {
  if (rows.length === 0) {
    return '<p>none</p>'
  }

  return [
    '<table>',
    `  <thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead>`,
    `  <tbody>${rows
      .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
      .join('')}</tbody>`,
    '</table>',
  ].join('\n')
}

function toCsv(headers: string[], rows: string[][]): string {
  return [headers, ...rows]
    .map((row) => row.map((cell) => csvEscape(cell)).join(','))
    .join('\n')
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }

  return value
}

function pushUnique<T>(values: T[], value: T): void {
  if (!values.includes(value)) {
    values.push(value)
  }
}

function numberField(value: number | undefined): string {
  return value === undefined ? '' : String(value)
}

function formatDurationSummary(bundle: AnalysisBundle): string {
  if (
    bundle.summary.averageDurationMs === undefined ||
    bundle.summary.minimumDurationMs === undefined ||
    bundle.summary.maximumDurationMs === undefined
  ) {
    return 'unavailable'
  }

  return [
    `avg ${formatDuration(bundle.summary.averageDurationMs)}`,
    `min ${formatDuration(bundle.summary.minimumDurationMs)}`,
    `max ${formatDuration(bundle.summary.maximumDurationMs)}`,
  ].join(', ')
}

function formatDurationOrUnavailable(durationMs: number | undefined): string {
  return durationMs === undefined ? 'unavailable' : formatDuration(durationMs)
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

function formatPercentOrUnavailable(value: number | undefined): string {
  return value === undefined ? 'unavailable' : `${trimFixed(value * 100)}%`
}

function formatNumberOrUnavailable(value: number | undefined): string {
  return value === undefined ? 'unavailable' : trimFixed(value)
}

function trimFixed(value: number): string {
  return value.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')
}

function formatDiagnostic(diagnostic: AnalysisBundle['diagnostics'][number]): string {
  if (diagnostic.kind === 'discovery') {
    return `${diagnostic.input}: ${diagnostic.message}`
  }

  if (diagnostic.line !== undefined) {
    return `${diagnostic.sourceFile}:${diagnostic.line}: ${diagnostic.message}`
  }

  return `${diagnostic.sourceFile}: ${diagnostic.message}`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapeMarkdown(value: string): string {
  return value.replace(/\|/g, '\\|')
}
