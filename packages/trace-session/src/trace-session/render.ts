import chalk from 'chalk';
import Table from 'cli-table3';
import { marked } from 'marked';
import TerminalRenderer from 'marked-terminal';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';

import { buildTraceDiagnostics, shortId } from './report.js';
import { DEFAULT_MESSAGE_PREVIEW_CHARS } from './constants.js';
import type {
  CliOptions,
  DelegateRow,
  EvidenceRef,
  MessageView,
  MilestoneEntry,
  PerformanceBucketSummary,
  PerformanceDigest,
  PerformanceSummary,
  PlanRow,
  ProviderModelUsageSummary,
  ReportView,
  RootRun,
  RunMessageTrace,
  SessionListItem,
  SessionPerformanceListItem,
  SessionOverview,
  SessionUsageSummary,
  SessionlessRunListItem,
  TimelineEntry,
  ToolAccountingSummary,
  TraceAggregateGroup,
  TraceAggregateReport,
  TraceDiagnostics,
  TraceFinding,
  TraceMessage,
  TraceMessageRole,
  TraceReport,
  TraceComparison,
  UsageSummary,
} from './types.js';

const TERMINAL_RENDERER_OPTIONS = {
  code: chalk.gray,
  codespan: chalk.cyan,
  heading: chalk.bold,
};
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

marked.setOptions({
  renderer: new TerminalRenderer(TERMINAL_RENDERER_OPTIONS) as never,
});

type HtmlTraceRenderOptions = Partial<Pick<CliOptions, 'includePlans' | 'messages' | 'systemOnly' | 'previewChars'>> & {
  generatedAt?: string;
};

type HtmlTableCell = string | { value: string | number; className?: string };
type HtmlTableCellKind = 'numeric' | 'descriptive' | 'compact';

export function traceTargetNotFoundMessage(report: TraceReport): string | undefined {
  if (report.rootRuns.length > 0) return undefined;
  if (report.target.kind === 'session') {
    return report.session === null
      ? `Session "${report.target.requestedId}" was not found in the database.`
      : undefined;
  }
  return `Run "${report.target.requestedId}" was not found in the database.`;
}

export function renderTraceReport(
  report: TraceReport,
  options: Pick<CliOptions, 'json' | 'includePlans' | 'onlyDelegates' | 'messages' | 'systemOnly'>
    & Partial<Pick<CliOptions, 'view' | 'messagesView' | 'previewChars'>>,
): string {
  const notFoundMessage = traceTargetNotFoundMessage(report);
  if (notFoundMessage) {
    return options.json
      ? JSON.stringify({ error: notFoundMessage, target: report.target }, null, 2)
      : chalk.yellow(notFoundMessage);
  }

  const diagnostics = report.diagnostics ?? buildTraceDiagnostics(report);
  if (options.json) {
    return JSON.stringify(report.diagnostics ? report : { ...report, diagnostics }, null, 2);
  }

  const effectiveView = resolveReportView(options);
  const messageView = options.messagesView ?? 'compact';
  const previewChars = options.previewChars ?? DEFAULT_MESSAGE_PREVIEW_CHARS;
  const milestones = report.milestones ?? [];

  if (effectiveView === 'summary' || effectiveView === 'overview') {
    return renderDecisionSummary(report, diagnostics, previewChars);
  }

  const lines: string[] = [];
  if (shouldRenderDiagnosticLead(effectiveView, options.onlyDelegates)) {
    lines.push(markdownBlock('# Trace Brief'));
    lines.push(renderTraceBrief(diagnostics));
  }

  if (effectiveView === 'brief') {
    return lines.join('\n');
  }

  if (effectiveView === 'output') {
    return renderFinalOutput(report.rootRuns);
  }

  if (effectiveView === 'reliability') {
    lines.push('');
    lines.push(markdownBlock('# Reliability'));
    lines.push(renderReliabilityDiagnostics(diagnostics, previewChars));
    return lines.join('\n');
  }

  if (effectiveView === 'investigate') {
    lines.push('');
    lines.push(markdownBlock('# Investigation'));
    lines.push(renderInvestigation(report, diagnostics, previewChars));
    return lines.join('\n');
  }

  if (effectiveView === 'policy') {
    lines.push('');
    lines.push(markdownBlock('# Policy Adherence'));
    lines.push(renderPolicyDiagnostics(diagnostics, previewChars));
    return lines.join('\n');
  }

  if (lines.length > 0) {
    lines.push('');
  }
  lines.push(markdownBlock('# Goal'));
  lines.push(renderGoal(report.rootRuns));
  lines.push('');
  lines.push(renderTraceSummary(report));

  if (report.warnings.length > 0) {
    lines.push('');
    lines.push(chalk.yellow.bold('Warnings'));
    for (const warning of report.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  if (shouldRenderSection(effectiveView, 'performance')) {
    lines.push('');
    lines.push(markdownBlock('# Performance'));
    lines.push(renderPerformance(report.performance ?? emptyPerformanceSummary(), traceDurationMs(report), diagnostics.performance, report.usage, report.rootRuns, previewChars));
    lines.push('', markdownBlock('## Per-run efficiency and context'), renderRunAnalysisTable(diagnostics, previewChars));
  }

  if (shouldRenderSection(effectiveView, 'milestones')) {
    lines.push('');
    lines.push(markdownBlock('# Milestones'));
    lines.push(renderMilestones(milestones));
  }

  if (shouldRenderSection(effectiveView, 'timeline')) {
    lines.push('');
    lines.push(markdownBlock(`# ${formatTimelineTitle(report.timeline, report.session)}`));
    lines.push(renderTimeline(report.timeline, previewChars));
  }

  if ((options.messages || options.systemOnly || effectiveView === 'messages') && shouldRenderSection(effectiveView, 'messages')) {
    lines.push('');
    lines.push(markdownBlock(options.systemOnly ? '# LLM System Messages' : '# LLM Message Context'));
    lines.push(renderLlmMessages(report.llmMessages, {
      systemOnly: options.systemOnly,
      messagesView: messageView,
      previewChars,
    }));
  }

  if (shouldRenderSection(effectiveView, 'delegates')) {
    lines.push('');
    lines.push(markdownBlock('# Delegate Diagnostics'));
    lines.push(renderDelegates(report.delegates));
  }

  if (options.includePlans && shouldRenderSection(effectiveView, 'plans')) {
    lines.push('');
    lines.push(chalk.bold('Plans'));
    lines.push(renderPlans(report.plans, previewChars));
  }

  if (shouldRenderFinalOutput(effectiveView)) {
    lines.push('');
    lines.push(markdownBlock('# Final Output'));
    lines.push(renderFinalOutput(report.rootRuns));
  }

  return lines.join('\n');
}

export function renderTraceComparison(comparison: TraceComparison, options: { json?: boolean } = {}): string {
  if (options.json) {
    return JSON.stringify(comparison, null, 2);
  }

  const baselineStatus = comparison.baseline.analysis?.status ?? 'unknown';
  const candidateStatus = comparison.candidate.analysis?.status ?? 'unknown';
  const sections = [
    markdownBlock('# Trace comparison'),
    markdownBlock('_Changes are candidate minus baseline._'),
    renderMarkdownTable(
      ['Side', 'Run ID', 'Status', 'Reliability (root-tree)', 'Confidence'],
      [
        ['Baseline', comparison.baseline.runId, baselineStatus, comparison.reliability.baseline, comparison.confidence.baseline],
        ['Candidate', comparison.candidate.runId, candidateStatus, comparison.reliability.candidate, comparison.confidence.candidate],
      ],
      ['left', 'left', 'left', 'left', 'left'],
    ),
    '',
    ...renderComparisonMixSection('Provider/model mix', comparison.providerModelMix),
    '',
    markdownBlock('## Metric changes'),
    renderMarkdownTable(
      ['Metric', 'Baseline', 'Candidate', 'Delta/change', '% change'],
      comparisonMetricRows(comparison).map(({ label, kind, metric }) => [
        label,
        formatComparisonValue(kind, metric.baseline),
        formatComparisonValue(kind, metric.candidate),
        formatComparisonValue(kind, metric.delta, true),
        formatComparisonPercentage(metric.percentageChange),
      ]),
      ['left', 'right', 'right', 'right', 'right'],
    ),
    '',
    ...renderComparisonMixSection('Tool mix', comparison.toolMix),
    '',
    markdownBlock('## Data notes'),
    comparison.notes.length > 0
      ? markdownBlock(comparison.notes.map((note) => `- ${escapeMarkdownTableCell(note)}`).join('\n'))
      : markdownBlock('_No comparison data warnings._'),
  ];
  return sections.join('\n');
}

function renderComparisonMixSection(title: string, values: TraceComparison['toolMix']): string[] {
  return [
    markdownBlock(`## ${title}`),
    values.length > 0
      ? renderMarkdownTable(
          ['Label', 'Baseline', 'Candidate', 'Delta'],
          values.map((row) => [row.label, formatNumber(row.baselineCount), formatNumber(row.candidateCount), formatSignedNumber(row.deltaCount)]),
          ['left', 'right', 'right', 'right'],
        )
      : markdownBlock('_No measured calls._'),
  ];
}

export function renderTraceComparisonHtml(comparison: TraceComparison): string {
  const rows = comparisonMetricRows(comparison)
    .map(({ label, kind, metric }) =>
      `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(formatComparisonValue(kind, metric.baseline))}</td><td>${escapeHtml(formatComparisonValue(kind, metric.candidate))}</td><td>${escapeHtml(formatComparisonValue(kind, metric.delta, true))}</td><td>${escapeHtml(formatComparisonPercentage(metric.percentageChange))}</td></tr>`
    )
    .join('');
  const mixTable = (values: TraceComparison['toolMix']) => {
    const body = values.length
      ? values.map((value) => `<tr><th>${escapeHtml(value.label)}</th><td>${value.baselineCount}</td><td>${value.candidateCount}</td><td>${escapeHtml(formatSignedNumber(value.deltaCount))}</td></tr>`).join('')
      : '<tr><td colspan="4">No measured calls</td></tr>';
    return `<table><thead><tr><th>Label</th><th>Baseline</th><th>Candidate</th><th>Delta</th></tr></thead><tbody>${body}</tbody></table>`;
  };
  const baselineStatus = comparison.baseline.analysis?.status ?? 'unknown';
  const candidateStatus = comparison.candidate.analysis?.status ?? 'unknown';
  const notes = comparison.notes.length
    ? `<ul>${comparison.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul>`
    : '<p>No comparison data warnings.</p>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Trace comparison</title><style>body{font:14px system-ui;max-width:1000px;margin:2rem auto;padding:0 1rem}table{border-collapse:collapse;width:100%}th,td{padding:.5rem;border:1px solid #ccc;text-align:right}th:first-child{text-align:left}</style></head><body><h1>Trace comparison</h1><p>Changes are candidate minus baseline.</p><p><b>Baseline:</b> ${escapeHtml(comparison.baseline.runId)} (${escapeHtml(baselineStatus)})<br><b>Candidate:</b> ${escapeHtml(comparison.candidate.runId)} (${escapeHtml(candidateStatus)})</p><p><b>Reliability (root-tree):</b> ${escapeHtml(comparison.reliability.change)}</p><table><thead><tr><th>Metric</th><th>Baseline</th><th>Candidate</th><th>Delta/change</th><th>% change</th></tr></thead><tbody>${rows}</tbody></table><h2>Tool mix</h2>${mixTable(comparison.toolMix)}<h2>Provider/model mix</h2>${mixTable(comparison.providerModelMix)}<h2>Confidence</h2><p>${escapeHtml(comparison.confidence.baseline)} -&gt; ${escapeHtml(comparison.confidence.candidate)}</p><h2>Data notes</h2>${notes}</body></html>`;
}

export function renderTraceAggregate(report: TraceAggregateReport, options: { json?: boolean } = {}): string {
  if (options.json) return JSON.stringify(report, null, 2);

  const lines = [
    markdownBlock(`# Trace aggregate by ${report.groupBy}`),
    markdownBlock([
      `- **Population:** ${formatNumber(report.population.runCount)} root traces${renderAggregateWindow(report)}`,
      `- **Coverage gaps:** duration ${formatNumber(report.population.missingDuration)}, usage ${formatNumber(report.population.missingUsage)}, cost ${formatNumber(report.population.missingCost)}, context ${formatNumber(report.population.missingContext)}`,
      `- **Generated:** ${report.generatedAt}`,
    ].join('\n')),
  ];

  if (report.groups.length === 0) {
    lines.push('', markdownBlock('_No matching root traces._'));
  } else {
    lines.push(
      '',
      markdownBlock('## Outcomes'),
      renderMarkdownTable(
        ['Group', 'Traces', 'Success', 'Failed', 'Recovered', 'Retry', 'Confidence'],
        report.groups.map((group) => [
          group.label,
          formatNumber(group.runCount),
          formatAggregateRate(group.outcomes.successRate),
          formatAggregateRate(group.outcomes.failureRate),
          formatAggregateRate(group.outcomes.recoveredSuccessRate),
          formatAggregateRate(group.retries.runFrequency),
          aggregateConfidenceSummary(group),
        ]),
        ['left', 'right', 'right', 'right', 'right', 'right', 'left'],
      ),
      '',
      markdownBlock('## Efficiency'),
      renderMarkdownTable(
        ['Group', 'Duration p50', 'p90', 'p95', 'Avg tokens*', 'Avg cost*', 'Context growth p50', 'p95'],
        report.groups.map((group) => [
          group.label,
          formatAggregateDuration(group.wallDurationMs.p50),
          formatAggregateDuration(group.wallDurationMs.p90),
          formatAggregateDuration(group.wallDurationMs.p95),
          formatAggregateNumber(group.successfulRuns.averageTokens),
          formatAggregateCost(group.successfulRuns.averageEstimatedGrandTotalUSD),
          formatAggregateBytes(group.context.growthBytes.p50),
          formatAggregateBytes(group.context.growthBytes.p95),
        ]),
        ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
      ),
      markdownBlock('_* Token and cost averages include successful traces with measured values only._'),
      '',
      markdownBlock('## Operational signals'),
      renderMarkdownTable(
        ['Group', 'Model failures', 'Tool failures', 'Failed tools', 'Common errors'],
        report.groups.map((group) => {
          const failedTools = group.tools.byTool.filter((tool) => tool.failures > 0);
          return [
            group.label,
            formatNumber(group.modelFailures),
            formatNumber(group.tools.failures),
            failedTools.length > 0
              ? failedTools.map((tool) => `${tool.toolName} (${tool.failures})`).join(', ')
              : 'none',
            group.commonErrorCodes.length > 0
              ? group.commonErrorCodes.map((error) => `${error.code} (${error.count})`).join(', ')
              : 'none',
          ];
        }),
        ['left', 'right', 'right', 'left', 'left'],
      ),
    );
  }
  if (report.notes.length > 0) {
    lines.push(
      '',
      markdownBlock('## Data notes'),
      markdownBlock(report.notes.map((note) => `- ${escapeMarkdownTableCell(note)}`).join('\n')),
    );
  }
  return lines.join('\n');
}

export function renderTraceAggregateHtml(report: TraceAggregateReport): string {
  const rows = report.groups.map((group) => `<tr><th>${escapeHtml(group.label)}</th><td>${formatNumber(group.runCount)}</td><td>${escapeHtml(formatAggregateRate(group.outcomes.successRate))}</td><td>${escapeHtml(formatAggregateRate(group.outcomes.failureRate))}</td><td>${escapeHtml(formatAggregateRate(group.outcomes.recoveredSuccessRate))}</td><td>${escapeHtml(formatAggregateRate(group.retries.runFrequency))}</td><td>${escapeHtml(formatAggregateDuration(group.wallDurationMs.p50))}</td><td>${escapeHtml(formatAggregateDuration(group.wallDurationMs.p90))}</td><td>${escapeHtml(formatAggregateDuration(group.wallDurationMs.p95))}</td><td>${escapeHtml(formatAggregateNumber(group.successfulRuns.averageTokens))}</td><td>${escapeHtml(formatAggregateCost(group.successfulRuns.averageEstimatedGrandTotalUSD))}</td><td>${escapeHtml(aggregateConfidenceSummary(group))}</td></tr>`).join('');
  const details = report.groups.map((group) => {
    const failedTools = group.tools.byTool.filter((tool) => tool.failures > 0);
    const tools = failedTools.length > 0
      ? `<ul>${failedTools.map((tool) => `<li>${escapeHtml(tool.toolName)}: ${formatNumber(tool.failures)}</li>`).join('')}</ul>`
      : '<p>No measured tool failures.</p>';
    const errors = group.commonErrorCodes.length > 0
      ? `<ul>${group.commonErrorCodes.map((error) => `<li>${escapeHtml(error.code)} (${formatNumber(error.count)})</li>`).join('')}</ul>`
      : '<p>No common persisted errors.</p>';
    return `<section><h3>${escapeHtml(group.label)}</h3><p>Context growth p50/p95: ${escapeHtml(formatAggregateBytes(group.context.growthBytes.p50))} / ${escapeHtml(formatAggregateBytes(group.context.growthBytes.p95))}. Model/tool failures: ${formatNumber(group.modelFailures)} / ${formatNumber(group.tools.failures)}. Confidence: ${escapeHtml(aggregateConfidence(group))}.</p><h4>Tool failures</h4>${tools}<h4>Common errors</h4>${errors}</section>`;
  }).join('');
  const notes = report.notes.length > 0
    ? `<ul>${report.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul>`
    : '<p>No aggregate data warnings.</p>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Trace aggregate by ${escapeHtml(report.groupBy)}</title><style>body{font:14px system-ui;max-width:1200px;margin:2rem auto;padding:0 1rem;color:#1f2937}table{border-collapse:collapse;width:100%;overflow:auto}th,td{padding:.55rem;border:1px solid #d1d5db;text-align:right;white-space:nowrap}th:first-child{text-align:left}section{border-top:1px solid #e5e7eb;margin-top:1.25rem}code{background:#f3f4f6;padding:.1rem .25rem}small{color:#6b7280}</style></head><body><h1>Trace aggregate by ${escapeHtml(report.groupBy)}</h1><p>${formatNumber(report.population.runCount)} root traces${escapeHtml(renderAggregateWindow(report))}. Generated ${escapeHtml(report.generatedAt)}.</p><p>Coverage gaps: duration ${formatNumber(report.population.missingDuration)}, usage ${formatNumber(report.population.missingUsage)}, cost ${formatNumber(report.population.missingCost)}, context ${formatNumber(report.population.missingContext)}.</p><table><thead><tr><th>Group</th><th>Traces</th><th>Success</th><th>Failed</th><th>Recovered</th><th>Retry</th><th>Duration p50</th><th>Duration p90</th><th>Duration p95</th><th>Avg tokens*</th><th>Avg cost*</th><th>Confidence</th></tr></thead><tbody>${rows || '<tr><td colspan="12">No matching root traces</td></tr>'}</tbody></table><p><small>* Token and cost averages include successful traces with measured values only.</small></p><h2>Operational signals</h2>${details || '<p>No matching groups.</p>'}<h2>Data notes</h2>${notes}</body></html>`;
}

function renderAggregateWindow(report: TraceAggregateReport): string {
  if (!report.population.since && !report.population.until) return '';
  return `; window ${report.population.since ?? 'unbounded'} to ${report.population.until ?? 'unbounded'}`;
}

function formatAggregateRate(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function aggregateConfidence(group: TraceAggregateGroup): string {
  if (group.confidence.unknown > 0) return 'unknown';
  if (group.confidence.low > 0) return 'low';
  if (group.confidence.medium > 0) return 'medium';
  return group.confidence.high > 0 ? 'high' : 'unknown';
}

function aggregateConfidenceSummary(group: TraceAggregateGroup): string {
  return `${aggregateConfidence(group)} (h${group.confidence.high}/m${group.confidence.medium}/l${group.confidence.low}/u${group.confidence.unknown})`;
}

function formatAggregateDuration(value: number | null): string {
  return value === null ? 'n/a' : formatDuration(value);
}

function formatAggregateNumber(value: number | null): string {
  return value === null ? 'n/a' : formatNumber(Math.round(value));
}

function formatAggregateCost(value: number | null): string {
  return value === null ? 'n/a' : formatCost(value);
}

function formatAggregateBytes(value: number | null): string {
  return value === null ? 'n/a' : formatBytes(value);
}

type MarkdownTableAlignment = 'left' | 'right' | 'center';
type TerminalTableProfile = 'boxed' | 'compact';

const COMPACT_TABLE_CHARS = {
  top: '',
  'top-mid': '',
  'top-left': '',
  'top-right': '',
  bottom: '',
  'bottom-mid': '',
  'bottom-left': '',
  'bottom-right': '',
  left: '',
  'left-mid': '',
  mid: '-',
  'mid-mid': ' ',
  right: '',
  'right-mid': '',
  middle: ' ',
} as const;

function renderMarkdownTable(
  headers: string[],
  rows: string[][],
  alignments: MarkdownTableAlignment[] = [],
): string {
  return renderTerminalTable(headers, rows, {
    profile: 'boxed',
    alignments,
  });
}

function escapeMarkdownTableCell(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replace(/\r?\n/g, ' ');
}

type ComparisonValueKind = 'duration' | 'number' | 'cost' | 'bytes';

function comparisonMetricRows(comparison: TraceComparison): Array<{
  label: string;
  kind: ComparisonValueKind;
  metric: TraceComparison['changes'][keyof TraceComparison['changes']];
}> {
  return [
    { label: 'wall duration', kind: 'duration', metric: comparison.changes.wall },
    { label: 'tokens', kind: 'number', metric: comparison.changes.tokens },
    { label: 'estimated cost', kind: 'cost', metric: comparison.changes.cost },
    { label: 'model retries', kind: 'number', metric: comparison.changes.retries },
    { label: 'model/tool failures', kind: 'number', metric: comparison.changes.failures },
    { label: 'context byte growth', kind: 'bytes', metric: comparison.changes.contextBytes },
    { label: 'output size', kind: 'bytes', metric: comparison.changes.outputBytes },
  ];
}

function formatComparisonValue(kind: ComparisonValueKind, value: number | null, signed = false): string {
  if (value === null) return 'n/a';
  const absolute = Math.abs(value);
  const formatted = kind === 'duration'
    ? formatDuration(absolute)
    : kind === 'cost'
      ? formatCost(absolute)
      : kind === 'bytes'
        ? formatBytes(absolute)
        : formatNumber(absolute);
  if (!signed || value === 0) return formatted;
  return `${value > 0 ? '+' : '-'}${formatted}`;
}

function formatComparisonPercentage(value: number | null): string {
  if (value === null) return 'n/a';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function formatSignedNumber(value: number): string {
  return `${value > 0 ? '+' : ''}${formatNumber(value)}`;
}

export function renderTraceHtml(report: TraceReport, options: HtmlTraceRenderOptions = {}): string {
  const diagnostics = report.diagnostics ?? buildTraceDiagnostics(report);
  const reportWithDiagnostics: TraceReport = report.diagnostics ? report : { ...report, diagnostics };
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const title = `Trace Report: ${diagnostics.brief.targetLabel}`;

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    `  <title>${escapeHtml(title)}</title>`,
    `  <style>${traceHtmlStyles()}</style>`,
    '</head>',
    '<body>',
    '  <div class="page-shell">',
    renderHtmlHero(report, diagnostics, generatedAt),
    renderHtmlNav(),
    '    <main>',
    renderHtmlBrief(diagnostics),
    renderHtmlReliability(diagnostics),
    renderHtmlFindings(diagnostics),
    renderHtmlPolicy(diagnostics),
    renderHtmlPerformance(report, diagnostics),
    renderHtmlWorkflow(report),
    renderHtmlDelegates(report.delegates),
    renderHtmlMessages(report, options),
    renderHtmlFinalOutputs(report.rootRuns),
    renderHtmlRawJson(reportWithDiagnostics),
    '    </main>',
    '  </div>',
    '</body>',
    '</html>',
  ].join('\n');
}

export function renderSessionList(sessions: SessionListItem[], options: Pick<CliOptions, 'json'> & Partial<Pick<CliOptions, 'previewChars'>>): string {
  if (options.json) {
    return JSON.stringify(sessions, null, 2);
  }
  if (sessions.length === 0) {
    return chalk.gray('No sessions were found.');
  }

  const previewChars = options.previewChars ?? DEFAULT_MESSAGE_PREVIEW_CHARS;
  return sessions
    .map((session) => {
      const sessionStatus = session.status ?? 'unknown';
      const sessionLabel = session.sessionId ?? `sessionless:${session.goals[0]?.rootRunId ?? 'unknown'}`;
      const lines = [`---- ${sessionLabel} : ${statusColor(sessionStatus)(sessionStatus)} : ${session.startedAt} ----`];
      const visibleGoals = session.goals.filter((goal) => normalizeGoal(goal.goal) !== null);
      if (visibleGoals.length === 0) {
        lines.push('  Goal: (none)');
      } else {
        lines.push(`  Goal: ${truncatePlain(oneLine(visibleGoals[0]!.goal!), previewChars)}`);
      }
      if (session.goals.length === 0) {
        lines.push('  Runs: (none)');
      }
      for (const run of session.goals) {
        const runStatus = run.status ?? 'unknown';
        const details = [session.sessionId === null ? `run=${run.runId}` : run.runId === run.rootRunId ? run.runId : `${run.runId} root=${run.rootRunId}`];
        details.push(statusColor(runStatus)(runStatus));
        if (run.startedAt) {
          details.push(`started=${formatTime(run.startedAt)}`);
        }
        if (run.runId !== run.rootRunId) {
          details.push('child');
        }
        const elapsed = durationMs(run.startedAt, run.completedAt);
        if (elapsed !== null) {
          details.push(`elapsed=${formatDuration(elapsed)}`);
        }
        lines.push(`  - ${details.join('  ')}`);
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

export function renderSessionPerformanceList(
  items: SessionPerformanceListItem[],
  options: Pick<CliOptions, 'json'> & Partial<Pick<CliOptions, 'previewChars'>>,
): string {
  if (options.json) {
    return JSON.stringify(items, null, 2);
  }
  if (items.length === 0) {
    return chalk.gray('No session run performance rows were found.');
  }

  const previewChars = options.previewChars ?? DEFAULT_MESSAGE_PREVIEW_CHARS;
  return items.map((item) => {
    const split = durationSplitParts(item.performance, item.totalDurationMs);
    const status = statusColor(item.runStatus ?? item.sessionStatus ?? 'unknown')(item.runStatus ?? item.sessionStatus ?? 'unknown');
    const goal = normalizeGoal(item.goal);
    return [
      `session  ${item.sessionId ?? '(none)'}`,
      `run  ${item.runId}`,
      `root  ${item.rootRunId}`,
      `type  ${item.type ?? 'run'}`,
      item.swarmRole ? `role  ${item.swarmRole}` : undefined,
      `status  ${status}`,
      `timestamp  ${item.startedAt ?? '(unknown)'}`,
      `duration  total ${formatDuration(split.totalDurationMs)}  model ${formatDuration(split.modelDurationMs)}  tools ${formatDuration(split.toolDurationMs)}  snapshot ${formatDuration(split.snapshotSaveMs)}  other ${formatDuration(split.otherDurationMs)}`,
      `goal  ${goal ? truncatePlain(oneLine(goal), previewChars) : '(none)'}`,
    ].filter((line): line is string => line !== undefined).join('\n');
  }).join('\n\n');
}

export function renderSessionlessRunList(runs: SessionlessRunListItem[], options: Pick<CliOptions, 'json'>): string {
  if (options.json) {
    return JSON.stringify(runs, null, 2);
  }
  if (runs.length === 0) {
    return chalk.gray('No session-less root runs were found.');
  }

  return runs
    .map((run) => {
      const startedAt = run.status === 'succeeded' ? chalk.green(run.startedAt) : chalk.red(run.startedAt);
      return `${run.rootRunId} : ${startedAt}\nGoal : ${normalizeGoal(run.goal) ?? '(none)'}`;
    })
    .join('\n\n-----\n\n');
}

export function renderDeleteEmptyGoalSessionsSql(sessions: SessionListItem[], options: Pick<CliOptions, 'json'>): string {
  const deletableSessions = sessions.filter(isDeletableGatewaySession);

  if (options.json) {
    return JSON.stringify({
      sessionIds: deletableSessions.map((session) => session.sessionId),
      sql: deletableSessions.map((session) => `delete from gateway_sessions where id = '${escapeSqlString(session.sessionId)}';`),
    }, null, 2);
  }

  if (deletableSessions.length === 0) {
    return '-- No sessions found with empty or null goals.';
  }

  const lines = [
    '-- Sessions with only empty or null goals.',
    '-- Review before running.',
    'begin;',
    ...deletableSessions.map((session) => `delete from gateway_sessions where id = '${escapeSqlString(session.sessionId)}';`),
    'commit;',
  ];
  return lines.join('\n');
}

function isDeletableGatewaySession(session: SessionListItem): session is SessionListItem & { sessionId: string } {
  return session.sessionId !== null
    && (session.goals.length === 0 || session.goals.every((goal) => normalizeGoal(goal.goal) === null));
}

export function renderUsageReport(usage: SessionUsageSummary, options: Pick<CliOptions, 'json'>): string {
  if (options.json) {
    return JSON.stringify(usage, null, 2);
  }

  const modelTotal = sumProviderModelUsage(usage.byProviderModel ?? []);
  const toolOutputTotal = sumProviderModelUsage(usage.toolOutputByProviderModel ?? []);
  const toolAccounting = usage.toolAccounting;
  const grandTotalCostUSD = usage.total.estimatedCostUSD + (toolAccounting?.estimatedCostUSD ?? 0);
  const lines = [
    markdownBlock('# Usage'),
    markdownBlock('## Model and tool-output usage'),
    renderMarkdownTable(
      ['Category', 'Tokens', 'Prompt', 'Completion', 'Reasoning', 'Estimated cost'],
      [
        usageSummaryMarkdownRow('Model', modelTotal),
        usageSummaryMarkdownRow('Tool output', toolOutputTotal),
        usageSummaryMarkdownRow('Combined model/tool-output', usage.total),
      ],
      ['left', 'right', 'right', 'right', 'right', 'right'],
    ),
    '',
    markdownBlock('## Tool-provider accounting'),
    renderMarkdownTable(
      ['Requests', 'Billable', 'Cached', 'Unpriced', 'Estimated cost'],
      [[
        formatNumber(toolAccounting?.totalRequests ?? 0),
        formatNumber(toolAccounting?.billableRequests ?? 0),
        formatNumber(toolAccounting?.cachedToolCalls ?? 0),
        formatNumber(toolAccounting?.unpricedRequests ?? 0),
        formatCost(toolAccounting?.estimatedCostUSD ?? 0),
      ]],
      ['right', 'right', 'right', 'right', 'right'],
    ),
    '',
    markdownBlock('## Cost summary'),
    renderMarkdownTable(
      ['Component', 'Estimated cost'],
      [
        ['Model/tool-output', formatCost(usage.total.estimatedCostUSD)],
        ['External tool providers', formatCost(toolAccounting?.estimatedCostUSD ?? 0)],
        ['Estimated grand total', formatCost(grandTotalCostUSD)],
      ],
      ['left', 'right'],
    ),
  ];
  if (usage.byRootRun.length > 0) {
    lines.push(
      '',
      markdownBlock('## Run usage by root run'),
      renderMarkdownTable(
        ['Root run', 'Tokens', 'Prompt', 'Completion', 'Reasoning', 'Estimated cost'],
        usage.byRootRun.map((item) => [
          item.rootRunId,
          formatNumber(item.usage.totalTokens),
          formatNumber(item.usage.promptTokens),
          formatNumber(item.usage.completionTokens),
          formatNumber(item.usage.reasoningTokens ?? 0),
          formatCost(item.usage.estimatedCostUSD),
        ]),
        ['left', 'right', 'right', 'right', 'right', 'right'],
      ),
    );
  }
  appendMarkdownProviderModelUsage(lines, 'Model usage by provider/model', usage.byProviderModel ?? [], 'Runs');
  appendMarkdownProviderModelUsage(lines, 'Tool-output usage by provider/model', usage.toolOutputByProviderModel ?? [], 'Tool calls');
  if (toolAccounting?.byProviderOperation.length) {
    lines.push(
      '',
      markdownBlock('## Tool-provider usage by provider/operation'),
      renderMarkdownTable(
        ['Provider', 'Operation', 'Tool calls', 'Requests', 'Billable', 'Cached', 'Unpriced', 'Estimated cost'],
        toolAccounting.byProviderOperation.map((row) => [
          row.provider,
          row.operation,
          formatNumber(row.toolCalls),
          formatNumber(row.requests),
          formatNumber(row.billableRequests),
          formatNumber(row.cachedToolCalls),
          formatNumber(row.unpricedRequests),
          formatCost(row.estimatedCostUSD),
        ]),
        ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right'],
      ),
    );
  }
  return lines.join('\n');
}

function usageSummaryMarkdownRow(label: string, usage: UsageSummary): string[] {
  return [
    label,
    formatNumber(usage.totalTokens),
    formatNumber(usage.promptTokens),
    formatNumber(usage.completionTokens),
    formatNumber(usage.reasoningTokens ?? 0),
    formatCost(usage.estimatedCostUSD),
  ];
}

function appendMarkdownProviderModelUsage(
  lines: string[],
  title: string,
  rows: ProviderModelUsageSummary[],
  countLabel: 'Runs' | 'Tool calls',
): void {
  if (rows.length === 0) return;
  lines.push(
    '',
    markdownBlock(`## ${title}`),
    renderMarkdownTable(
      ['Provider', 'Model', countLabel, 'Tokens', 'Prompt', 'Completion', 'Reasoning', 'Estimated cost'],
      rows.map((row) => [
        row.provider,
        row.model,
        formatNumber(countLabel === 'Runs' ? row.runCount ?? 0 : row.toolCallCount ?? 0),
        formatNumber(row.usage.totalTokens),
        formatNumber(row.usage.promptTokens),
        formatNumber(row.usage.completionTokens),
        formatNumber(row.usage.reasoningTokens ?? 0),
        formatCost(row.usage.estimatedCostUSD),
      ]),
      ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right'],
    ),
  );
}

function traceHtmlStyles(): string {
  return `
:root {
  color-scheme: light;
  --bg: #f6f7fb;
  --panel: #ffffff;
  --panel-soft: #f9fafb;
  --ink: #172033;
  --muted: #667085;
  --line: #d9e0ea;
  --accent: #315efb;
  --accent-soft: #e8edff;
  --good: #087443;
  --good-soft: #e8f6ee;
  --warn: #a15c00;
  --warn-soft: #fff4df;
  --bad: #b42318;
  --bad-soft: #fff0ed;
  --info: #026aa2;
  --info-soft: #eaf6ff;
  --code-bg: #111827;
  --code-ink: #e5e7eb;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: radial-gradient(circle at top left, #eef3ff 0, #f6f7fb 30rem, #f6f7fb 100%);
  color: var(--ink);
  font: 14px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.page-shell { max-width: 1180px; margin: 0 auto; padding: 32px 20px 56px; }
.hero, .toc, .section {
  background: rgba(255, 255, 255, 0.92);
  border: 1px solid var(--line);
  border-radius: 22px;
  box-shadow: 0 16px 50px rgba(23, 32, 51, 0.08);
}
.hero { padding: 22px 26px; }
.eyebrow { margin: 0; color: var(--accent); font-size: 12px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; white-space: nowrap; }
.hero-title { display: flex; gap: 16px; align-items: center; justify-content: space-between; }
.hero-heading { min-width: 0; display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: baseline; }
h1, h2, h3 { line-height: 1.18; margin: 0; }
h1 { font-size: clamp(20px, 2.1vw, 28px); font-weight: 800; max-width: 100%; overflow-wrap: anywhere; }
h2 { font-size: 24px; }
h3 { font-size: 17px; }
.lead { max-width: 980px; margin: 10px 0 0; color: #344054; font-size: 15px; }
.hero-meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); column-gap: 28px; row-gap: 2px; margin: 16px 0 0; padding-top: 10px; border-top: 1px solid #edf0f5; }
.meta-item { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 10px; align-items: baseline; padding: 4px 0; }
.metric-card {
  background: var(--panel-soft);
  border: 1px solid #edf0f5;
  border-radius: 16px;
  padding: 14px 16px;
}
.meta-label { color: var(--muted); font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
.meta-value { min-width: 0; font-size: 14px; font-weight: 700; overflow-wrap: anywhere; }
.meta-label, .metric-label { display: block; color: var(--muted); font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
.metric-value { display: block; margin-top: 4px; font-size: 18px; font-weight: 800; overflow-wrap: anywhere; }
.metric-note { margin: 8px 0 0; color: var(--muted); font-size: 13px; }
.toc { display: flex; flex-wrap: wrap; gap: 10px; margin: 18px 0; padding: 14px; position: sticky; top: 0; z-index: 2; }
.toc a { color: var(--accent); background: var(--accent-soft); border-radius: 999px; font-weight: 700; padding: 8px 12px; text-decoration: none; }
.section { margin: 18px 0 0; padding: 24px; }
.section-header { display: flex; gap: 12px; align-items: flex-start; justify-content: space-between; margin-bottom: 18px; }
.section-description { margin: 6px 0 0; color: var(--muted); max-width: 820px; }
.metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
.finding-list, .message-list { display: grid; gap: 12px; }
.finding-card, .message-run, .message-card, .details-card {
  border: 1px solid var(--line);
  border-radius: 16px;
  background: var(--panel);
  padding: 16px;
}
.finding-card.error { border-color: #ffb4aa; background: var(--bad-soft); }
.finding-card.warning { border-color: #fedf89; background: var(--warn-soft); }
.finding-card.info { border-color: #b9e6fe; background: var(--info-soft); }
.finding-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 8px; }
.badge {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: #fff;
  color: #344054;
  font-size: 12px;
  font-weight: 800;
  line-height: 1;
  padding: 6px 9px;
  text-transform: uppercase;
}
.badge.status-succeeded, .badge.status-returned-successfully, .badge.status-healthy, .badge.status-recovered { background: var(--good-soft); border-color: #abefc6; color: var(--good); }
.badge.status-failed, .badge.status-error { background: var(--bad-soft); border-color: #ffb4aa; color: var(--bad); }
.badge.status-blocked, .badge.status-running, .badge.status-awaiting-subagent, .badge.status-waiting, .badge.status-degraded { background: var(--warn-soft); border-color: #fedf89; color: var(--warn); }
.badge.severity-error { background: var(--bad-soft); border-color: #ffb4aa; color: var(--bad); }
.badge.severity-warning { background: var(--warn-soft); border-color: #fedf89; color: var(--warn); }
.badge.severity-info { background: var(--info-soft); border-color: #b9e6fe; color: var(--info); }
.warning-list, .evidence-list, .command-list { margin: 10px 0 0; padding-left: 20px; }
.command-list code { color: var(--accent); font-weight: 800; }
.table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 16px; background: var(--panel); }
table { border-collapse: collapse; min-width: 100%; }
th, td { border-bottom: 1px solid #edf0f5; padding: 10px 12px; text-align: left; vertical-align: top; }
th { background: #f3f5f9; color: #475467; font-size: 12px; letter-spacing: .05em; text-transform: uppercase; white-space: nowrap; }
tr:last-child td { border-bottom: 0; }
td { white-space: nowrap; overflow-wrap: normal; }
th.num-cell, td.num-cell { text-align: right; font-variant-numeric: tabular-nums; }
td.text-cell { min-width: 260px; white-space: normal; overflow-wrap: break-word; }
.status-cell.status-succeeded, .status-cell.status-returned-successfully { color: var(--good); font-weight: 800; }
.status-cell.status-failed, .status-cell.status-error { color: var(--bad); font-weight: 800; }
.status-cell.status-blocked, .status-cell.status-running, .status-cell.status-awaiting-subagent, .status-cell.status-waiting { color: var(--warn); font-weight: 800; }
.stack { display: grid; gap: 14px; }
.subsection { margin-top: 18px; }
details { margin-top: 10px; }
summary { cursor: pointer; font-weight: 800; }
pre {
  background: var(--code-bg);
  border-radius: 14px;
  color: var(--code-ink);
  overflow-x: auto;
  padding: 14px;
  white-space: pre-wrap;
}
code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
.empty { color: var(--muted); font-style: italic; }
.message-card summary { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.message-preview { color: var(--muted); font-weight: 500; }
.message-meta { color: var(--muted); margin: 6px 0 10px; }
@media print {
  body { background: #fff; }
  .toc { position: static; }
  .hero, .toc, .section { box-shadow: none; }
}
`.trim();
}

function renderHtmlHero(report: TraceReport, diagnostics: TraceDiagnostics, generatedAt: string): string {
  const brief = diagnostics.brief;
  const modelLabels = [...new Set(report.rootRuns.map(formatRunModel).filter((label): label is string => label !== null))];
  return `
    <header class="hero">
      <div class="hero-title">
        <div class="hero-heading">
          <p class="eyebrow">Adaptive Agent Trace Report</p>
          <h1>${escapeHtml(brief.targetLabel)}</h1>
        </div>
        ${htmlBadge(diagnostics.reliability.classification, `status-${classToken(diagnostics.reliability.classification)}`)}
      </div>
      <p class="lead">${escapeHtml(brief.headline)}</p>
      <div class="hero-meta">
        ${htmlMetaItem('Generated', formatTime(generatedAt))}
        ${htmlMetaItem('Target', `${report.target.kind} ${report.target.requestedId}`)}
        ${htmlMetaItem('Roots / runs', `${formatNumber(brief.rootRunCount)} / ${formatNumber(brief.runCount)}`)}
        ${htmlMetaItem('Provider / model', modelLabels.length > 0 ? modelLabels.join(', ') : 'unknown')}
      </div>
      ${renderHtmlWarnings(report.warnings)}
    </header>`;
}

function renderHtmlNav(): string {
  const links = [
    ['#brief', 'Brief'],
    ['#reliability', 'Reliability'],
    ['#findings', 'Findings'],
    ['#policy', 'Policy'],
    ['#performance', 'Performance'],
    ['#workflow', 'Workflow'],
    ['#delegates', 'Delegates'],
    ['#messages', 'Messages'],
    ['#final-output', 'Final Output'],
    ['#raw-json', 'Raw JSON'],
  ];
  return `
    <nav class="toc" aria-label="Trace report sections">
      ${links.map(([href, label]) => `<a href="${href}">${label}</a>`).join('\n      ')}
    </nav>`;
}

function renderHtmlBrief(diagnostics: TraceDiagnostics): string {
  const brief = diagnostics.brief;
  return htmlSection(
    'brief',
    'Trace Brief',
    'High-level outcome, scale, duration, and usage for fast triage.',
    htmlMetricGrid([
      ['Verdict', diagnostics.reliability.classification, diagnostics.reliability.summary],
      ['Outcome', brief.status, diagnostics.brief.headline],
      ['Runs', `${formatNumber(brief.rootRunCount)} roots / ${formatNumber(brief.runCount)} total`, `steps=${brief.totalSteps === null ? 'unknown' : formatNumber(brief.totalSteps)}`],
      ['Wall duration', formatDuration(brief.wallDurationMs), 'Elapsed time across root runs.'],
      ['Cumulative measured', formatDuration(brief.cumulativeMeasuredDurationMs), 'Model + tool + snapshot save time.'],
      ['Parallelism', formatRatio(brief.parallelismFactor), 'Measured cumulative time divided by wall time.'],
      ['Model calls', `${formatNumber(brief.modelCalls)} total / ${formatNumber(brief.failedModelCalls)} failed`, 'Model lifecycle events.'],
      ['Tool calls', `${formatNumber(brief.toolCalls)} total / ${formatNumber(brief.failedToolCalls)} failed`, 'Durable tool execution outcomes.'],
      ['Usage', `${formatNumber(brief.totalTokens)} tokens`, `${formatCost(brief.estimatedCostUSD)} estimated cost`],
    ]),
  );
}

function renderHtmlReliability(diagnostics: TraceDiagnostics): string {
  const reliability = diagnostics.reliability;
  const dimensions = reliability.dimensions;
  return htmlSection(
    'reliability',
    'Reliability',
    'Explainable runtime classification across outcome, lifecycle, recovery, liveness, policy, and evidence dimensions.',
    [
      htmlMetricGrid([
        ['Verdict', reliability.classification, reliability.summary],
        ['Outcome integrity', dimensions.outcomeIntegrity.status, dimensions.outcomeIntegrity.summary],
        ['Lifecycle integrity', dimensions.lifecycleIntegrity.status, dimensions.lifecycleIntegrity.summary],
        ['Recovery pressure', dimensions.recoveryPressure.status, dimensions.recoveryPressure.summary],
        ['Liveness', dimensions.liveness.status, dimensions.liveness.summary],
        ['Policy integrity', dimensions.policyIntegrity.status, dimensions.policyIntegrity.summary],
        ['Data confidence', reliability.dataConfidence.level, dimensions.evidenceConfidence.summary],
        ['Output quality', reliability.outputQuality.status, reliability.outputQuality.summary],
      ]),
    ].join('\n'),
  );
}

function renderHtmlFindings(diagnostics: TraceDiagnostics): string {
  const findings = diagnostics.findings.length > 0 ? diagnostics.findings : [{
    id: 'finding-0',
    severity: 'info' as const,
    category: 'data-quality' as const,
    role: 'context' as const,
    title: 'No diagnostic findings',
    summary: 'No failure, policy, or performance findings were derived from the persisted trace.',
    evidence: [],
    commands: [],
  }];

  const body = [
    `<div class="finding-list">${findings.map(renderHtmlFinding).join('\n')}</div>`,
    renderHtmlSuggestedCommands(diagnostics),
  ].join('\n');
  return htmlSection('findings', 'Findings', 'Derived explanations and evidence for failures, policy issues, data-quality gaps, and performance risks.', body);
}

function renderHtmlFinding(finding: TraceFinding): string {
  const evidence = finding.evidence.length === 0
    ? '<p class="empty">No direct evidence rows were attached to this finding.</p>'
    : `<ul class="evidence-list">${finding.evidence.map((item) => `<li>${escapeHtml(formatEvidenceRef(item))}</li>`).join('\n')}</ul>`;

  const commands = finding.commands.length === 0
    ? ''
    : `<details><summary>Inspect (${formatNumber(finding.commands.length)})</summary><ul class="command-list">${finding.commands.map((command) => `<li>${escapeHtml(command.reason)}<br><code>$ ${escapeHtml(command.command)}</code></li>`).join('\n')}</ul></details>`;
  return `
      <article class="finding-card ${classToken(finding.severity)}">
        <div class="finding-head">
          ${htmlBadge(finding.severity, `severity-${classToken(finding.severity)}`)}
          ${htmlBadge(finding.role)}
          ${htmlBadge(finding.category)}
        </div>
        <h3>${escapeHtml(finding.title)}</h3>
        <p>${escapeHtml(finding.summary)}</p>
        <details>
          <summary>Evidence (${formatNumber(finding.evidence.length)})</summary>
          ${evidence}
        </details>
        ${commands}
      </article>`;
}

function renderHtmlPolicy(diagnostics: TraceDiagnostics): string {
  const policy = diagnostics.policy;
  const policyFindings = diagnostics.findings.filter((finding) => finding.category === 'policy');
  const budgetGroups = policy.budgetGroups.length === 0
    ? '<p class="empty">No budget exhaustion groups were observed.</p>'
    : htmlTable(
      ['Budget group', 'Skipped calls', 'Tools'],
      policy.budgetGroups.map((group) => [
        group.budgetGroup,
        formatNumber(group.skippedCalls),
        group.toolNames.length > 0 ? group.toolNames.join(', ') : '-',
      ]),
    );
  const warnings = policy.warnings.length === 0
    ? '<p class="empty">No policy warnings were derived.</p>'
    : `<ul class="warning-list">${policy.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('\n')}</ul>`;
  const findings = policyFindings.length === 0
    ? '<p class="empty">No policy adherence findings were derived from this trace.</p>'
    : `<div class="finding-list">${policyFindings.map(renderHtmlFinding).join('\n')}</div>`;

  return htmlSection(
    'policy',
    'Policy Adherence',
    'Tool budget, rejected-call, approval, and runtime-injected policy signals.',
    [
      htmlMetricGrid([
        ['Budget exhausted', formatNumber(policy.budgetExhaustedToolCalls), 'Tool calls skipped because a budget was already exhausted.'],
        ['Rejected tool calls', formatNumber(policy.rejectedToolCalls), '`model.tool_call_rejected` events emitted by core.'],
        ['Approval lifecycle', `${formatNumber(policy.approvalRequests)} requested / ${formatNumber(policy.approvalResolved)} resolved`, `${formatNumber(policy.unresolvedApprovalRequests)} unresolved.`],
        ['Runtime policy messages', formatNumber(policy.runtimePolicyMessages), 'Runtime-injected budget or policy guidance found in LLM messages.'],
      ]),
      htmlSubsection('Budget groups', budgetGroups),
      htmlSubsection('Policy warnings', warnings),
      htmlSubsection('Policy findings', findings),
    ].join('\n'),
  );
}

function renderHtmlPerformance(report: TraceReport, diagnostics: TraceDiagnostics): string {
  const performance = report.performance ?? emptyPerformanceSummary();
  const digest = diagnostics.performance;
  const split = durationSplitParts(performance, traceDurationMs(report));
  const statusCodes = Object.entries(performance.model.adapterStatusCodes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status}:${count}`)
    .join(', ') || '-';

  return htmlSection(
    'performance',
    'Performance',
    'Quantitative view of model latency, tool time, snapshot overhead, bytes, retries, and high-volume contributors.',
    [
      htmlMetricGrid([
        ['Wall time', formatDuration(digest.wallDurationMs), 'Elapsed time across root runs.'],
        ['Cumulative measured', formatDuration(digest.cumulativeMeasuredDurationMs), 'Model + tool + snapshot save time.'],
        ['Model / tools / snapshots', `${formatDuration(digest.cumulativeModelDurationMs)} / ${formatDuration(digest.cumulativeToolDurationMs)} / ${formatDuration(digest.cumulativeSnapshotSaveMs)}`, 'Main measured duration buckets.'],
        ['Other wall time', formatDuration(digest.otherDurationMs), 'Wall time not explained by measured buckets.'],
        ['Parallelism factor', formatRatio(digest.parallelismFactor), 'Cumulative measured time divided by wall time.'],
        ['Tool provider cost', formatCost(digest.toolAccounting.estimatedCostUSD), `${formatNumber(digest.toolAccounting.totalRequests)} requests, ${formatNumber(digest.toolAccounting.unpricedRequests)} unpriced.`],
        ['Duration split', `total=${formatDuration(split.totalDurationMs)}`, `model=${formatDuration(split.modelDurationMs)}, tools=${formatDuration(split.toolDurationMs)}, snapshot=${formatDuration(split.snapshotSaveMs)}, other=${formatDuration(split.otherDurationMs)}`],
      ]),
      renderHtmlUsageBreakdown(report.usage),
      htmlSubsection('Per-run efficiency and context', htmlTable(
        ['Run', 'Status', 'Provider/model', 'Wall', 'Measured', 'Parallelism', 'Model attempts', 'Retries', 'Tool calls', 'Tokens', 'Cost', 'Context samples', 'Context latest/peak/growth'],
        diagnostics.analysis.runs.map((run) => [
          shortId(run.runId),
          run.status ?? 'unknown',
          run.provider || run.model ? `${run.provider ?? 'unknown'}/${run.model ?? 'unknown'}` : '-',
          formatDuration(run.durations.wallMs),
          formatDuration(run.durations.cumulativeMeasuredMs),
          formatRatio(run.durations.parallelism),
          formatNumber(run.modelCalls.attempts),
          formatNumber(run.modelCalls.retries),
          formatNumber(run.toolCalls.starts),
          formatNumber(run.usage.combined.totalTokens),
          formatCost(run.costs.estimatedGrandTotalUSD),
          `${run.contextGrowth.source}/${formatNumber(run.contextGrowth.samples)}`,
          [run.contextGrowth.latestMessageBytes, run.contextGrowth.peakMessageBytes, run.contextGrowth.messageBytesGrowth]
            .map((value) => value === null ? '-' : formatBytes(value))
            .join(' / '),
        ]),
      )),
      htmlSubsection('Tool provider accounting', digest.toolAccounting.byProviderOperation.length === 0 ? '<p class="empty">No tool accounting payloads were available.</p>' : htmlTable(
        ['Provider', 'Operation', 'Tool calls', 'Requests', 'Billable', 'Cached', 'Unpriced', 'Cost'],
        digest.toolAccounting.byProviderOperation.map((row) => [
          row.provider,
          row.operation,
          formatNumber(row.toolCalls),
          formatNumber(row.requests),
          formatNumber(row.billableRequests),
          formatNumber(row.cachedToolCalls),
          formatNumber(row.unpricedRequests),
          formatCost(row.estimatedCostUSD),
        ]),
      )),
      renderHtmlPerformanceNotes(digest),
      htmlSubsection('Model metrics', htmlTable(['Metric', 'Value', 'Meaning'], [
        ['Calls', `started=${formatNumber(performance.model.started)} completed=${formatNumber(performance.model.completed)} failed=${formatNumber(performance.model.failed)}`, 'Model lifecycle counts.'],
        ['Duration', formatBucketDuration(performance.model.durationMs), 'Wall-clock model call time measured by core.'],
        ['Request bytes', formatBucketBytes(performance.model.requestBytes), 'Serialized model request size before adapter conversion.'],
        ['Response bytes', formatBucketBytes(performance.model.responseBytes), 'Serialized model response size after parsing.'],
        ['Retries', `${formatNumber(performance.model.retries)} events, delay ${formatBucketDuration(performance.model.retryDelayMs)}`, 'Adapter or provider retry activity.'],
        ['Adapter latency', formatBucketDuration(performance.model.adapterResponseLatencyMs), 'Provider SDK or HTTP response latency.'],
        ['Adapter gate wait', formatBucketDuration(performance.model.adapterGateWaitMs), 'Time waiting for adapter request admission.'],
        ['Adapter status', statusCodes, 'HTTP status codes observed by adapters.'],
      ])),
      htmlSubsection('Tool metrics', htmlTable(['Metric', 'Value', 'Meaning'], [
        ['Calls', `started=${formatNumber(performance.tools.started)} completed=${formatNumber(performance.tools.completed)} failed=${formatNumber(performance.tools.failed)}`, 'Durable tool execution call counts.'],
        ['Duration', formatBucketDuration(performance.tools.durationMs), 'Host tool execution time.'],
        ['Child duration', formatBucketDuration(performance.tools.childRunDurationMs), 'Synthetic delegate child-run wall time, not added to duration split.'],
        ['Input bytes', formatBucketBytes(performance.tools.inputBytes), 'Raw tool input size.'],
        ['Raw output bytes', formatBucketBytes(performance.tools.rawOutputBytes), 'Raw tool output size.'],
        ['Model output bytes', formatBucketBytes(performance.tools.modelOutputBytes), 'Tool output size visible to the model.'],
      ])),
      htmlSubsection('Snapshot metrics', htmlTable(['Metric', 'Value', 'Meaning'], [
        ['Created', formatNumber(performance.snapshots.created), 'Snapshot events observed in the trace.'],
        ['State bytes', formatBucketBytes(performance.snapshots.stateBytes), 'Serialized snapshot state size.'],
        ['Message bytes', formatBucketBytes(performance.snapshots.messageBytes), 'Serialized persisted message context size.'],
        ['Message count', formatBucketNumber(performance.snapshots.messageCount), 'Messages persisted in snapshots.'],
        ['Pending tool bytes', formatBucketBytes(performance.snapshots.pendingToolCallBytes), 'Serialized pending tool call state.'],
        ['Save time', formatBucketDuration(performance.snapshots.saveDurationMs), 'Snapshot store write time when measured.'],
      ])),
      htmlSubsection('Top token runs', digest.topRunsByUsage.length === 0 ? '<p class="empty">No usage rows were available.</p>' : htmlTable(
        ['Root', 'Run', 'Tokens', 'Prompt', 'Completion', 'Cost', 'Goal'],
        digest.topRunsByUsage.map((run) => [
          shortId(run.rootRunId),
          shortId(run.runId),
          formatNumber(run.totalTokens),
          formatNumber(run.promptTokens),
          formatNumber(run.completionTokens),
          formatCost(run.estimatedCostUSD),
          run.goal ? truncatePlain(oneLine(run.goal), 120) : '-',
        ]),
      )),
      htmlSubsection('Slowest tool spans', digest.topToolSpans.length === 0 ? '<p class="empty">No measured tool spans were available.</p>' : htmlTable(
        ['Duration', 'Root/run', 'Step', 'Tool', 'Outcome'],
        digest.topToolSpans.map((span) => [
          formatDuration(span.durationMs),
          `${shortId(span.rootRunId)}/${shortId(span.runId)}`,
          span.stepId ?? '-',
          span.toolName ?? 'tool',
          statusCell(span.outcome),
        ]),
      )),
      htmlSubsection('Top tools by duration', digest.topToolsByDuration.length === 0 ? '<p class="empty">No tool duration aggregates were available.</p>' : htmlTable(
        ['Tool', 'Calls', 'Duration', 'Model output'],
        digest.topToolsByDuration.map((tool) => [
          tool.toolName,
          `${formatNumber(tool.completed)} completed / ${formatNumber(tool.failed)} failed`,
          formatBucketDuration(tool.durationMs),
          formatBucketBytes(tool.modelOutputBytes),
        ]),
      )),
      htmlSubsection('Largest model-visible tool outputs', digest.topToolsByModelOutput.length === 0 ? '<p class="empty">No model-visible tool output measurements were available.</p>' : htmlTable(
        ['Tool', 'Calls', 'Model output', 'Raw output'],
        digest.topToolsByModelOutput.map((tool) => [
          tool.toolName,
          `${formatNumber(tool.completed)} completed / ${formatNumber(tool.failed)} failed`,
          formatBucketBytes(tool.modelOutputBytes),
          formatBucketBytes(tool.rawOutputBytes),
        ]),
      )),
    ].join('\n'),
  );
}

function renderHtmlPerformanceNotes(digest: PerformanceDigest): string {
  if (digest.notes.length === 0) {
    return '';
  }
  return htmlSubsection('Digest notes', `<ul class="warning-list">${digest.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('\n')}</ul>`);
}

function renderHtmlUsageBreakdown(usage: SessionUsageSummary): string {
  const sections: string[] = [];
  const modelUsageRows = usage.byProviderModel ?? [];
  const toolOutputUsageRows = usage.toolOutputByProviderModel ?? [];

  if (modelUsageRows.length > 0) {
    sections.push(htmlSubsection('Model usage by provider/model', renderHtmlProviderModelUsageTable(modelUsageRows, 'runs')));
  }
  if (toolOutputUsageRows.length > 0) {
    sections.push(htmlSubsection('Tool-output usage by provider/model', renderHtmlProviderModelUsageTable(toolOutputUsageRows, 'tool calls')));
  }

  return sections.join('\n');
}

function renderHtmlProviderModelUsageTable(
  rows: ProviderModelUsageSummary[],
  countLabel: 'runs' | 'tool calls',
): string {
  return htmlTable(
    ['Provider', 'Model', countLabel === 'runs' ? 'Runs' : 'Tool calls', 'Tokens', 'Prompt', 'Completion', 'Reasoning', 'Cost'],
    rows.map((row) => [
      row.provider,
      row.model,
      formatNumber(countLabel === 'runs' ? row.runCount ?? 0 : row.toolCallCount ?? 0),
      formatNumber(row.usage.totalTokens),
      formatNumber(row.usage.promptTokens),
      formatNumber(row.usage.completionTokens),
      formatNumber(row.usage.reasoningTokens ?? 0),
      formatCost(row.usage.estimatedCostUSD),
    ]),
  );
}

function renderHtmlWorkflow(report: TraceReport): string {
  const rootRows = report.rootRuns.map((run) => [
    shortId(run.rootRunId),
    shortId(run.runId),
    statusCell(run.status ?? 'unknown'),
    formatDuration(durationMs(run.startedAt ?? null, run.completedAt ?? run.updatedAt ?? null)),
    formatRunModel(run) ?? 'unknown',
    run.errorMessage ?? run.errorCode ?? run.goal ?? '-',
  ]);
  const runTree = report.runTree && report.runTree.length > 0
    ? htmlSubsection('Run tree', htmlTable(
      ['Depth', 'Root', 'Run', 'Parent', 'Delegate'],
      report.runTree.map((entry) => [
        String(entry.depth),
        shortId(entry.rootRunId),
        shortId(entry.runId),
        entry.parentRunId ? shortId(entry.parentRunId) : '-',
        entry.delegateName ?? '-',
      ]),
    ))
    : '';
  const snapshots = report.snapshotSummaries && report.snapshotSummaries.length > 0
    ? htmlSubsection('Snapshots', htmlTable(
      ['Depth', 'Root/run', 'Delegate', 'Latest seq', 'Created at', 'Steps used'],
      report.snapshotSummaries.map((snapshot) => [
        String(snapshot.depth),
        `${shortId(snapshot.rootRunId)}/${shortId(snapshot.runId)}`,
        snapshot.delegateName ?? '-',
        snapshot.latestSnapshotSeq === null ? '-' : String(snapshot.latestSnapshotSeq),
        formatTime(snapshot.latestSnapshotCreatedAt),
        snapshot.latestStepsUsed === null || snapshot.latestStepsUsed === undefined ? '-' : formatNumber(snapshot.latestStepsUsed),
      ]),
    ))
    : '';
  const timeline = report.timeline.length === 0
    ? '<p class="empty">No migrated tool timeline rows were found.</p>'
    : htmlTable(
      ['Started', 'Duration', 'Run/depth', 'Step', 'Tool/event', 'Outcome', 'Preview'],
      report.timeline.map((entry) => [
        formatTimeOfDay(entry.startedAt),
        formatDuration(entry.durationMs),
        `${shortId(entry.rootRunId)}/${shortId(entry.runId)} d${entry.depth}`,
        entry.stepId ?? '-',
        entry.toolName ?? entry.eventType ?? 'tool',
        statusCell(entry.outcome),
        previewUnknown(entry.params ?? entry.output, 160),
      ]),
    );

  return htmlSection(
    'workflow',
    'Workflow',
    'Root runs, child-run shape, snapshots, and tool timeline for studying how the agent executed the objective.',
    [
      htmlSubsection('Root runs', rootRows.length === 0 ? '<p class="empty">No root runs were found.</p>' : htmlTable(['Root', 'Linked run', 'Status', 'Duration', 'Model', 'Goal/error'], rootRows)),
      runTree,
      snapshots,
      htmlSubsection(formatTimelineTitle(report.timeline, report.session), timeline),
    ].filter(Boolean).join('\n'),
  );
}

function renderHtmlDelegates(delegates: DelegateRow[]): string {
  const body = delegates.length === 0
    ? '<p class="empty">No delegate chains were found.</p>'
    : htmlTable(
      ['Parent', 'Delegate', 'Child', 'Child status', 'Heartbeat', 'Lease expiry', 'Last event', 'Reason'],
      delegates.map((delegate) => [
        shortId(delegate.parent_run_id),
        delegate.child_delegate_name ?? delegate.snapshot_delegate_name ?? 'delegate',
        delegate.child_run_id ? shortId(delegate.child_run_id) : '-',
        statusCell(delegate.child_status ?? 'missing'),
        formatTime(delegate.child_heartbeat_at),
        formatTime(delegate.child_lease_expires_at),
        delegate.child_last_event_type ?? '-',
        statusCell(delegate.delegate_reason),
      ]),
    );
  return htmlSection('delegates', 'Delegates', 'Delegate handoff evidence, including child status, lease freshness, last event, and derived reason.', body);
}

function renderHtmlMessages(report: TraceReport, options: HtmlTraceRenderOptions): string {
  const previewChars = options.previewChars ?? DEFAULT_MESSAGE_PREVIEW_CHARS;
  const visibleRuns = report.llmMessages
    .map((trace) => ({
      trace,
      messages: trace.effectiveMessages.filter((message) => !options.systemOnly || message.role === 'system'),
    }))
    .filter((item) => item.messages.length > 0);

  if (visibleRuns.length === 0) {
    const message = options.messages || options.systemOnly
      ? 'No snapshot-backed LLM messages were found for the traced runs.'
      : 'LLM message context was not loaded for this report. Re-run with --messages --html <path> to include snapshot-backed prompts and tool messages.';
    return htmlSection('messages', options.systemOnly ? 'LLM System Messages' : 'LLM Message Context', 'Prompt, assistant, tool, and runtime-injected messages when loaded from run snapshots.', `<p class="empty">${escapeHtml(message)}</p>`);
  }

  const body = `<div class="message-list">${visibleRuns.map(({ trace, messages }) => renderHtmlMessageRun(trace, messages, previewChars)).join('\n')}</div>`;
  return htmlSection('messages', options.systemOnly ? 'LLM System Messages' : 'LLM Message Context', 'Snapshot-backed model context for prompt analysis, policy injection checks, and tool-result study.', body);
}

function renderHtmlMessageRun(trace: RunMessageTrace, messages: TraceMessage[], previewChars: number): string {
  const counts = summarizeMessages(messages);
  const runLabel = `${shortId(trace.rootRunId)}/${shortId(trace.runId)} d${trace.depth}${trace.delegateName ? ` ${trace.delegateName}` : ''}`;
  return `
      <article class="message-run">
        <h3>${escapeHtml(runLabel)}</h3>
        <p class="message-meta">initial ${escapeHtml(String(trace.initialSnapshotSeq ?? '-'))} @ ${escapeHtml(formatTime(trace.initialSnapshotCreatedAt))} · latest ${escapeHtml(String(trace.latestSnapshotSeq ?? '-'))} @ ${escapeHtml(formatTime(trace.latestSnapshotCreatedAt))} · persisted=${formatNumber(counts.persisted)} pending=${formatNumber(counts.pending)} system=${formatNumber(counts.system)} runtime-injected=${formatNumber(counts.runtimeInjected)} user=${formatNumber(counts.user)} assistant=${formatNumber(counts.assistant)} tool=${formatNumber(counts.tool)}</p>
        <div class="message-list">
          ${messages.map((message) => renderHtmlMessageCard(message, previewChars)).join('\n')}
        </div>
      </article>`;
}

function renderHtmlMessageCard(message: TraceMessage, previewChars: number): string {
  const preview = formatMessagePreview(message, previewChars);
  const metadata = [
    message.name ? `name=${message.name}` : undefined,
    message.toolCallId ? `toolCallId=${message.toolCallId}` : undefined,
    message.reasoning !== undefined ? `reasoning=${message.reasoning.length} chars` : undefined,
    message.reasoningDetails !== undefined ? `reasoningDetails=${message.reasoningDetails.length}` : undefined,
  ].filter((part): part is string => part !== undefined);
  const toolCalls = message.toolCalls && message.toolCalls.length > 0
    ? `<details><summary>Tool calls (${formatNumber(message.toolCalls.length)})</summary><pre><code>${escapeHtml(stringifyJson(message.toolCalls))}</code></pre></details>`
    : '';
  const reasoning = message.reasoning !== undefined
    ? `<details><summary>Reasoning</summary><pre><code>${escapeHtml(message.reasoning)}</code></pre></details>`
    : '';
  const reasoningDetails = message.reasoningDetails !== undefined
    ? `<details><summary>Reasoning details (${formatNumber(message.reasoningDetails.length)})</summary><pre><code>${escapeHtml(stringifyJson(message.reasoningDetails))}</code></pre></details>`
    : '';

  return `
          <details class="message-card role-${classToken(message.role)}">
            <summary>
              ${htmlBadge(`#${message.position + 1}`)}
              ${htmlBadge(message.persistence)}
              ${htmlBadge(message.role)}
              ${htmlBadge(humanMessageCategoryPlain(message.category))}
              <span class="message-preview">${escapeHtml(preview)}</span>
            </summary>
            ${metadata.length > 0 ? `<p class="message-meta">${escapeHtml(metadata.join(' · '))}</p>` : ''}
            ${toolCalls}
            ${reasoning}
            ${reasoningDetails}
            <pre><code>${escapeHtml(message.content || '(empty)')}</code></pre>
          </details>`;
}

function renderHtmlFinalOutputs(rootRuns: RootRun[]): string {
  const rootsWithOutput = rootRuns.filter((run) => run.result !== null && run.result !== undefined);
  const body = rootsWithOutput.length === 0
    ? '<p class="empty">No final output was found for the linked root runs.</p>'
    : `<div class="stack">${rootsWithOutput.map((run) => `
      <article class="details-card">
        <h3>${escapeHtml(shortId(run.rootRunId))}</h3>
        <pre><code>${escapeHtml(typeof run.result === 'string' ? run.result : stringifyJson(run.result))}</code></pre>
      </article>`).join('\n')}</div>`;
  return htmlSection('final-output', 'Final Output', 'Persisted root-run result values.', body);
}

function renderHtmlRawJson(report: TraceReport): string {
  return htmlSection(
    'raw-json',
    'Raw Trace JSON',
    'Escaped source report for exact machine-readable inspection. Includes derived diagnostics when they were not already present on the report.',
    `<details class="details-card"><summary>Open raw JSON</summary><pre><code>${escapeHtml(stringifyJson(report))}</code></pre></details>`,
  );
}

function renderHtmlWarnings(warnings: string[]): string {
  if (warnings.length === 0) {
    return '';
  }
  return `<ul class="warning-list">${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('\n')}</ul>`;
}

function renderHtmlSuggestedCommands(diagnostics: TraceDiagnostics): string {
  if (diagnostics.suggestedNextViews.length === 0) {
    return htmlSubsection('Suggested next views', '<p class="empty">No follow-up views were suggested.</p>');
  }
  return htmlSubsection(
    'Suggested next views',
    `<ul class="command-list">${diagnostics.suggestedNextViews.map((suggestion) => `<li>${escapeHtml(suggestion.reason)}<br><code>$ ${escapeHtml(suggestion.command)}</code></li>`).join('\n')}</ul>`,
  );
}

function htmlSection(id: string, title: string, description: string, body: string): string {
  return `
      <section class="section" id="${escapeHtml(id)}">
        <div class="section-header">
          <div>
            <h2>${escapeHtml(title)}</h2>
            <p class="section-description">${escapeHtml(description)}</p>
          </div>
        </div>
        ${body}
      </section>`;
}

function htmlSubsection(title: string, body: string): string {
  return `
        <div class="subsection">
          <h3>${escapeHtml(title)}</h3>
          ${body}
        </div>`;
}

function htmlMetricGrid(items: Array<[label: string, value: string, note?: string]>): string {
  return `<div class="metric-grid">${items.map(([label, value, note]) => `
        <div class="metric-card">
          <span class="metric-label">${escapeHtml(label)}</span>
          <span class="metric-value">${escapeHtml(value)}</span>
          ${note ? `<p class="metric-note">${escapeHtml(note)}</p>` : ''}
        </div>`).join('\n')}
      </div>`;
}

function htmlMetaItem(label: string, value: string): string {
  return `
        <div class="meta-item">
          <span class="meta-label">${escapeHtml(label)}</span>
          <span class="meta-value">${escapeHtml(value)}</span>
        </div>`;
}

function htmlTable(headers: string[], rows: HtmlTableCell[][]): string {
  if (rows.length === 0) {
    return '<p class="empty">No rows.</p>';
  }
  const cellKinds = headers.map((header, index) => inferHtmlTableCellKind(header, rows.map((row) => row[index])));
  return `
        <div class="table-wrap">
          <table>
            <thead><tr>${headers.map((header, index) => `<th${cellKinds[index] === 'numeric' ? ' class="num-cell"' : ''}>${escapeHtml(header)}</th>`).join('')}</tr></thead>
            <tbody>
              ${rows.map((row) => `<tr>${row.map((cell, index) => htmlTableCell(cell, cellKinds[index] ?? 'compact')).join('')}</tr>`).join('\n              ')}
            </tbody>
          </table>
        </div>`;
}

function htmlTableCell(cell: HtmlTableCell, kind: HtmlTableCellKind): string {
  const value = typeof cell === 'string' ? cell : String(cell.value);
  const explicitClassName = typeof cell === 'string' ? undefined : cell.className;
  const classNames = [
    explicitClassName,
    kind === 'numeric' ? 'num-cell' : undefined,
    kind === 'descriptive' ? 'text-cell' : undefined,
  ].filter((item): item is string => item !== undefined).join(' ');
  const className = classNames ? ` class="${escapeHtml(classNames)}"` : '';
  const escapedValue = kind === 'compact' ? escapeHtmlWithSlashBreaks(value) : escapeHtml(value);
  return `<td${className}>${escapedValue}</td>`;
}

function inferHtmlTableCellKind(header: string, cells: Array<HtmlTableCell | undefined>): HtmlTableCellKind {
  if (isDescriptiveHtmlHeader(header)) {
    return 'descriptive';
  }
  if (isNumericHtmlHeader(header) || cells.some((cell) => cell !== undefined && isNumericHtmlTableValue(cell))) {
    return 'numeric';
  }
  return 'compact';
}

function isDescriptiveHtmlHeader(header: string): boolean {
  const normalized = header.toLowerCase();
  return /goal|error|message|preview|params|output|meaning|reason|summary|title|detail|evidence|command|policy|replan/.test(normalized);
}

function isNumericHtmlHeader(header: string): boolean {
  const normalized = header.toLowerCase();
  return /\b(tokens?|prompt|completion|reasoning|cost|duration|latency|wait|bytes?|calls?|runs?|skipped|depth|step|attempt|seq|created|failed|completed|started|total|average|avg|max|count)\b/.test(normalized)
    && !/created at|started$|started at|provider|model|tool|status|root|run|parent|delegate|outcome/.test(normalized);
}

function isNumericHtmlTableValue(cell: HtmlTableCell): boolean {
  const value = typeof cell === 'string' ? cell : String(cell.value);
  const trimmed = stripAnsi(value).trim();
  if (trimmed === '-' || trimmed.length === 0 || /[a-z]/i.test(trimmed.replace(/ms|s|b|kib|mib|total|max|avg|x/gi, ''))) {
    return false;
  }
  return /^\$?\d[\d,]*(?:\.\d+)?(?:ms|s|B|KiB|MiB|x)?(?:\s|$)/.test(trimmed);
}

function escapeHtmlWithSlashBreaks(value: string): string {
  return escapeHtml(value).replaceAll('/', '/<wbr>');
}

function htmlBadge(value: string, className?: string): string {
  const classes = ['badge', className].filter((item): item is string => item !== undefined).join(' ');
  return `<span class="${escapeHtml(classes)}">${escapeHtml(value)}</span>`;
}

function statusCell(status: string): HtmlTableCell {
  return { value: status, className: `status-cell status-${classToken(status)}` };
}

function classToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function previewUnknown(value: unknown, width: number): string {
  if (value === null || value === undefined) {
    return '-';
  }
  const raw = typeof value === 'string' ? value : stringifyJson(value);
  return truncatePlain(oneLine(raw), width);
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}



function renderTraceBrief(diagnostics: TraceDiagnostics): string {
  const brief = diagnostics.brief;
  const lines: string[] = [
    `${chalk.cyan('outcome')} ${statusColor(brief.status)(brief.status)}`,
    `${chalk.cyan('reason')} ${brief.headline}`,
    `${chalk.cyan('target')} ${brief.targetLabel}`,
    `${chalk.cyan('runs')} roots=${formatNumber(brief.rootRunCount)} total=${formatNumber(brief.runCount)} steps=${brief.totalSteps === null ? 'unknown' : formatNumber(brief.totalSteps)}`,
    `${chalk.cyan('duration')} wall=${formatDuration(brief.wallDurationMs)} cumulative=${formatDuration(brief.cumulativeMeasuredDurationMs)} parallelism=${formatRatio(brief.parallelismFactor)}`,
    `${chalk.cyan('model')} calls=${formatNumber(brief.modelCalls)} failed=${formatNumber(brief.failedModelCalls)}  ${chalk.cyan('tools')} calls=${formatNumber(brief.toolCalls)} failed=${formatNumber(brief.failedToolCalls)}`,
    `${chalk.cyan('usage')} tokens=${formatNumber(brief.totalTokens)} cost=${formatCost(brief.estimatedCostUSD)}`,
  ];
  const notableFindings = diagnostics.findings
    .filter((finding) => finding.severity !== 'info')
    .slice(0, 3);
  if (notableFindings.length > 0) {
    lines.push('');
    lines.push(chalk.bold('Top findings'));
    for (const finding of notableFindings) {
      lines.push(`- ${findingSeverityColor(finding.severity)(finding.severity)} ${finding.title}`);
      lines.push(...wrapPlain(finding.summary, 112).map((line) => `  ${line}`));
    }
  }
  if (diagnostics.suggestedNextViews.length > 0) {
    lines.push('');
    lines.push(chalk.bold('Suggested next views'));
    lines.push(renderSuggestedNextViews(diagnostics, { limit: 3 }));
  }
  return lines.join('\n');
}

function renderDecisionSummary(report: TraceReport, diagnostics: TraceDiagnostics, previewChars: number): string {
  const modelCost = report.usage.total.estimatedCostUSD;
  const toolCost = diagnostics.performance.toolAccounting.estimatedCostUSD;
  const findings = diagnostics.findings.length ? renderDiagnosticFindings(diagnostics.findings.slice(0, 5)) : chalk.gray('No diagnostic findings.');
  const models = [...new Set(report.rootRuns.map((run) => [run.modelProvider, run.modelName].filter(Boolean).join('/')).filter(Boolean))];
  const identityLines = [
    `${chalk.cyan('target')} ${report.target.kind}`,
    report.target.kind === 'session' ? `${chalk.cyan('session')}  ${report.target.requestedId}` : undefined,
    report.target.kind === 'run' ? `${chalk.cyan('run')}  ${report.target.requestedId}` : undefined,
    report.target.kind === 'root-run' ? `${chalk.cyan('root')}  ${report.target.requestedId}` : undefined,
    ...report.rootRuns
      .filter((run) => run.rootRunId !== report.target.requestedId)
      .map((run) => `${chalk.cyan('root')}  ${run.rootRunId}`),
  ].filter((line): line is string => line !== undefined);
  const lines = [
    markdownBlock('# Identity'),
    ...identityLines,
    `${chalk.cyan('runs')} roots=${formatNumber(diagnostics.brief.rootRunCount)} total=${formatNumber(diagnostics.brief.runCount)}`,
    `${chalk.cyan('provider / model')} ${models.join(', ') || 'unknown'}`,
    '', markdownBlock('# Verdict'),
    `${chalk.cyan('VERDICT')} ${statusColor(diagnostics.reliability.classification)(diagnostics.reliability.classification.toUpperCase())}`,
    `${chalk.cyan('status')} ${statusColor(diagnostics.brief.status)(diagnostics.brief.status)}`,
    `${chalk.cyan('reason')} ${diagnostics.reliability.summary}`,
    '', markdownBlock('# Reliability'),
    renderReliabilityDimensionRows(diagnostics, previewChars),
    '', markdownBlock('# Operations'),
    `${chalk.cyan('duration')} wall=${formatDuration(diagnostics.brief.wallDurationMs)} model=${formatDuration(diagnostics.performance.cumulativeModelDurationMs)} tools=${formatDuration(diagnostics.performance.cumulativeToolDurationMs)}`,
    `${chalk.cyan('model/tool-output cost')} ${formatCost(modelCost)}`,
    `${chalk.cyan('tool-provider cost')} ${formatCost(toolCost)}`,
    `${chalk.cyan('total cost')} ${formatCost(modelCost + toolCost)}`,
    `${chalk.cyan('usage')} ${formatUsageSummary(report.usage.total)}`,
    '', markdownBlock('# Findings'), findings,
    '', markdownBlock('# Goal / Final Output'), renderGoal(report.rootRuns), '', renderFinalOutput(report.rootRuns),
  ];
  if (report.warnings.length) lines.push('', chalk.yellow.bold('Data warnings'), ...report.warnings.map((warning) => `- ${warning}`));
  if (diagnostics.suggestedNextViews.length) lines.push('', chalk.bold('Suggested next commands'), renderSuggestedNextViews(diagnostics, { limit: 3 }));
  return lines.join('\n');
}

function renderReliabilityDiagnostics(diagnostics: TraceDiagnostics, previewChars: number): string {
  const reliability = diagnostics.reliability;
  const lines = [
    `${chalk.cyan('VERDICT')} ${statusColor(reliability.classification)(reliability.classification.toUpperCase())}`,
    ...wrapPlain(reliability.summary, 112),
    '',
    renderReliabilityDimensionRows(diagnostics, previewChars),
  ];
  const dimensionEvidence = Object.values(reliability.dimensions).flatMap((dimension) => dimension.evidence);
  if (dimensionEvidence.length > 0) {
    lines.push('', markdownBlock('## Evidence'));
    for (const evidence of dimensionEvidence.slice(0, 8)) {
      const evidenceLines = renderEvidenceRefLines(evidence);
      lines.push(`- ${evidenceLines[0] ?? '-'}`);
      lines.push(...evidenceLines.slice(1).map((line) => `  ${line}`));
    }
  }
  lines.push('', `${chalk.cyan('Output quality')} ${reliability.outputQuality.status}`);
  lines.push(...wrapPlain(reliability.outputQuality.summary, 112));
  if (diagnostics.suggestedNextViews.length > 0) {
    lines.push('', markdownBlock('## Suggested next commands'), renderSuggestedNextViews(diagnostics));
  }
  return lines.join('\n');
}

function renderReliabilityDimensionRows(diagnostics: TraceDiagnostics, previewChars: number): string {
  const reliability = diagnostics.reliability;
  const dimensions = reliability.dimensions;
  return renderMetricTable([
    ['Outcome integrity', statusColor(dimensions.outcomeIntegrity.status)(dimensions.outcomeIntegrity.status), dimensions.outcomeIntegrity.summary],
    ['Lifecycle integrity', statusColor(dimensions.lifecycleIntegrity.status)(dimensions.lifecycleIntegrity.status), dimensions.lifecycleIntegrity.summary],
    ['Recovery pressure', statusColor(dimensions.recoveryPressure.status)(dimensions.recoveryPressure.status), dimensions.recoveryPressure.summary],
    ['Liveness', statusColor(dimensions.liveness.status)(dimensions.liveness.status), dimensions.liveness.summary],
    ['Policy integrity', statusColor(dimensions.policyIntegrity.status)(dimensions.policyIntegrity.status), dimensions.policyIntegrity.summary],
    ['Data confidence', statusColor(dimensions.evidenceConfidence.status)(reliability.dataConfidence.level), dimensions.evidenceConfidence.summary],
  ], previewChars);
}

function renderInvestigation(report: TraceReport, diagnostics: TraceDiagnostics, previewChars: number): string {
  const lines: string[] = [];
  lines.push(markdownBlock('## Verdict'));
  lines.push(`${chalk.cyan('VERDICT')} ${statusColor(diagnostics.reliability.classification)(diagnostics.reliability.classification.toUpperCase())}`);
  lines.push(...wrapPlain(diagnostics.reliability.summary, 112));

  const groups: Array<[title: string, role: TraceFinding['role'], empty: string]> = [
    ['Primary cause', 'primary-cause', 'No primary cause was attributable from persisted evidence.'],
    ['Recovery', 'recovery', 'No retries, resumes, replans, or other recovery attempts were observed.'],
    ['Consequences', 'consequence', 'No downstream consequences were derived.'],
    ['Context and data gaps', 'context', 'No additional context or data-quality findings were derived.'],
  ];
  for (const [title, role, empty] of groups) {
    const findings = diagnostics.findings.filter((finding) => finding.role === role);
    lines.push('', markdownBlock(`## ${title}`));
    lines.push(findings.length > 0 ? renderDiagnosticFindings(findings) : chalk.gray(empty));
  }

  const nonSucceededRoots = report.rootRuns.filter((run) => run.status && run.status !== 'succeeded');
  if (nonSucceededRoots.length > 0) {
    lines.push('');
    lines.push(markdownBlock('## Non-succeeded root runs'));
    lines.push(renderTable(
      ['root', 'status', 'detail'],
      nonSucceededRoots.map((run) => [
        shortId(run.rootRunId),
        statusColor(run.status ?? 'unknown')(run.status ?? 'unknown'),
        run.errorMessage
          ? previewText(run.errorMessage, previewChars)
          : run.errorCode ?? (run.goal ? previewText(run.goal, previewChars) : '-'),
      ]),
    ));
  }

  const suspiciousDelegates = report.delegates.filter((delegate) => delegate.delegate_reason !== 'returned successfully');
  if (suspiciousDelegates.length > 0) {
    lines.push('');
    lines.push(markdownBlock('## Delegate chain evidence'));
    lines.push(renderDelegates(suspiciousDelegates));
  }

  lines.push('');
  lines.push(markdownBlock('## Suggested next views'));
  lines.push(renderSuggestedNextViews(diagnostics));
  return lines.join('\n');
}

function renderPolicyDiagnostics(diagnostics: TraceDiagnostics, previewChars: number): string {
  const policy = diagnostics.policy;
  const lines: string[] = [];
  lines.push(markdownBlock('## Summary'));
  lines.push(renderMetricTable([
    ['budget exhausted', formatNumber(policy.budgetExhaustedToolCalls), 'Tool calls skipped because a budget was already exhausted.'],
    ['rejected tool calls', formatNumber(policy.rejectedToolCalls), '`model.tool_call_rejected` events emitted by core.'],
    ['approval requests', `${formatNumber(policy.approvalRequests)} requested / ${formatNumber(policy.approvalResolved)} resolved`, 'Approval lifecycle events observed in the trace.'],
    ['runtime policy messages', formatNumber(policy.runtimePolicyMessages), 'Runtime-injected budget/policy guidance found in LLM messages.'],
  ], previewChars));

  if (policy.budgetGroups.length > 0) {
    lines.push('');
    lines.push(markdownBlock('## Budget groups'));
    lines.push(renderTable(
      ['budget group', 'skipped calls', 'tools'],
      policy.budgetGroups.map((group) => [
        group.budgetGroup,
        formatNumber(group.skippedCalls),
        group.toolNames.length > 0 ? group.toolNames.join(', ') : '-',
      ]),
    ));
  }

  const policyFindings = diagnostics.findings.filter((finding) => finding.category === 'policy');
  if (policyFindings.length > 0) {
    lines.push('');
    lines.push(markdownBlock('## Policy findings'));
    lines.push(renderDiagnosticFindings(policyFindings));
  } else {
    lines.push('');
    lines.push(chalk.gray('No policy adherence findings were derived from this trace.'));
  }

  lines.push('');
  lines.push(markdownBlock('## Suggested next views'));
  lines.push(renderSuggestedNextViews(diagnostics));
  return lines.join('\n');
}

function renderDiagnosticFindings(findings: TraceFinding[]): string {
  return findings.map((finding, index) => renderDiagnosticFinding(finding, index)).join('\n\n');
}

function renderDiagnosticFinding(finding: TraceFinding, index: number): string {
  const severity = findingSeverityColor(finding.severity)(finding.severity.toUpperCase());
  const lines = [
    `${chalk.bold(`${index + 1}.`)} ${severity} ${chalk.gray(finding.role)} ${chalk.gray(finding.category)} ${chalk.bold(finding.title)}`,
    ...wrapPlain(finding.summary, 112).map((line) => `   ${line}`),
  ];

  if (finding.evidence.length > 0) {
    lines.push(`   ${chalk.cyan('Evidence')}`);
    for (const evidence of finding.evidence.slice(0, 4)) {
      const evidenceLines = renderEvidenceRefLines(evidence);
      lines.push(`   - ${evidenceLines[0] ?? '-'}`);
      for (const continuation of evidenceLines.slice(1)) {
        lines.push(`     ${continuation}`);
      }
    }
    if (finding.evidence.length > 4) {
      lines.push(`   - ${chalk.gray(`+${finding.evidence.length - 4} more evidence items`)}`);
    }
  }

  if (finding.commands.length > 0) {
    lines.push(`   ${chalk.cyan('Inspect')}`);
    for (const command of finding.commands) {
      lines.push(`   ${chalk.cyan(`$ ${command.command}`)}`);
    }
  }

  return lines.join('\n');
}

function formatEvidenceRef(item: EvidenceRef): string {
  const location = [
    item.runId ? `run ${item.runId}` : undefined,
    item.stepId ? `step ${item.stepId}` : undefined,
    item.toolCallId ? `tool call ${item.toolCallId}` : undefined,
    item.eventSeq !== undefined && item.eventSeq !== null ? `event #${item.eventSeq} ${item.eventType ?? ''}`.trim() : undefined,
    item.createdAt ? `at ${item.createdAt}` : undefined,
  ].filter((part): part is string => part !== undefined).join(' · ');
  const detail = item.detail ? ` - ${oneLine(item.detail)}` : '';
  return `${item.label}${location ? ` (${location})` : ''}${detail}`;
}

function renderEvidenceRefLines(item: EvidenceRef): string[] {
  const eventLabel = item.eventSeq !== undefined && item.eventSeq !== null
    ? `event #${item.eventSeq}  ${item.eventType ?? item.label}`
    : item.label;
  const lines = [eventLabel];
  if (item.createdAt) lines.push(`at ${item.createdAt}`);
  if (item.rootRunId && item.rootRunId !== item.runId) lines.push('root run', `  ${item.rootRunId}`);
  if (item.runId) lines.push('run', `  ${item.runId}`);
  if (item.stepId) lines.push(`step ${item.stepId}`);
  if (item.toolCallId) lines.push('tool call', `  ${item.toolCallId}`);
  if (item.detail) lines.push(...wrapPlain(`detail ${oneLine(item.detail)}`, 104));
  return lines;
}

function renderSuggestedNextViews(diagnostics: TraceDiagnostics, options: { limit?: number } = {}): string {
  if (diagnostics.suggestedNextViews.length === 0) {
    return chalk.gray('No follow-up views were suggested.');
  }
  const suggestions = options.limit === undefined
    ? diagnostics.suggestedNextViews
    : diagnostics.suggestedNextViews.slice(0, options.limit);
  return suggestions
    .map((suggestion) => `- ${suggestion.reason}\n  ${chalk.cyan(`$ ${suggestion.command}`)}`)
    .join('\n');
}


function normalizeGoal(goal: string | null): string | null {
  if (typeof goal !== 'string') {
    return null;
  }
  const trimmed = goal.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function escapeSqlString(value: string): string {
  return value.replaceAll("'", "''");
}

function renderTraceSummary(report: TraceReport): string {
  const session = report.session;
  const lines: string[] = [];
  lines.push(markdownBlock('# Trace Summary'));
  lines.push(`${chalk.cyan('status')} ${statusColor(report.summary.status)(report.summary.status)}`);
  lines.push(`${chalk.cyan('reason')} ${report.summary.reason}`);
  if (report.target.kind === 'session') {
    if (!session) {
      if (report.rootRuns.length > 0) {
        lines.push(`${chalk.magenta('session')} ${report.target.requestedId} ${chalk.gray('(agent_runs.session_id)')}`);
        lines.push(renderModelSummary(report.rootRuns));
        lines.push(`${chalk.cyan('session duration')} ${formatDuration(sessionRunDurationMs(report.rootRuns))}`);
      } else {
        lines.push(`${chalk.magenta('session')} ${chalk.red('not found')}`);
      }
    } else {
      lines.push(`${chalk.magenta('session')} ${session.sessionId}`);
      lines.push(`${chalk.cyan('agent')} ${session.agentId ?? 'unknown'}  ${chalk.cyan('channel')} ${session.channelId ?? 'unknown'}`);
      lines.push(renderModelSummary(report.rootRuns));
      lines.push(`${chalk.cyan('status')} ${statusColor(session.status)(session.status)}  ${chalk.cyan('current')} ${session.currentRunId ?? 'none'}`);
      lines.push(`${chalk.cyan('session duration')} ${formatDuration(sessionRunDurationMs(report.rootRuns) ?? durationMs(session.createdAt, session.updatedAt))}`);
    }
  } else {
    lines.push(`${chalk.magenta('target')} ${report.target.kind} ${report.target.requestedId}`);
    if (report.target.resolvedRootRunId && report.target.resolvedRootRunId !== report.target.requestedId) {
      lines.push(`${chalk.cyan('root')} ${report.target.resolvedRootRunId}`);
    }
    lines.push(renderModelSummary(report.rootRuns));
  }
  lines.push(`${chalk.cyan('total steps')} ${report.totalSteps ?? 'unknown'}`);
  lines.push(renderUsage(report.usage, report.rootRuns));

  const rootRunsWithoutUsage = rootRunsNotCoveredByUsage(report.rootRuns, report.usage);
  if (rootRunsWithoutUsage.length > 0 || report.usage.byRootRun.length === 0) {
    const visibleRootRuns = report.usage.byRootRun.length === 0 ? report.rootRuns : rootRunsWithoutUsage;
    lines.push('');
    lines.push(markdownBlock('# Root Runs'));
    if (visibleRootRuns.length === 0) {
      lines.push(chalk.gray('No root runs were found.'));
    } else {
      lines.push(renderRootRunStatusList(visibleRootRuns));
    }
  }
  return lines.join('\n');
}

function rootRunsNotCoveredByUsage(rootRuns: RootRun[], usage: SessionUsageSummary): RootRun[] {
  const usageRootRunIds = new Set(usage.byRootRun.map((item) => item.rootRunId));
  return rootRuns.filter((run) => !usageRootRunIds.has(run.rootRunId));
}

function renderRootRunStatusList(rootRuns: RootRun[]): string {
  return rootRuns.map((run) => {
    const parts = [run.rootRunId, statusColor(run.status ?? 'unknown')(run.status ?? 'unknown')];
    if (run.runId !== run.rootRunId) {
      parts.push(`linkedRun=${run.runId}`);
    }
    return `- ${parts.join('  ')}`;
  }).join('\n');
}

function renderModelSummary(rootRuns: RootRun[]): string {
  const labels = [...new Set(rootRuns.map(formatRunModel).filter((label) => label !== null))];
  if (labels.length === 0) {
    return `${chalk.cyan('provider')} unknown  ${chalk.cyan('model')} unknown`;
  }
  if (labels.length === 1) {
    const run = rootRuns.find((candidate) => formatRunModel(candidate) === labels[0]);
    return `${chalk.cyan('provider')} ${run?.modelProvider ?? 'unknown'}  ${chalk.cyan('model')} ${run?.modelName ?? 'unknown'}`;
  }
  return `${chalk.cyan('provider/model')} ${labels.join(', ')}`;
}

function formatRunModel(run: RootRun): string | null {
  if (!run.modelProvider && !run.modelName) {
    return null;
  }
  return `${run.modelProvider ?? 'unknown'}/${run.modelName ?? 'unknown'}`;
}

function sessionRunDurationMs(rootRuns: RootRun[]): number | null {
  let earliestStart: number | null = null;
  let latestEnd: number | null = null;

  for (const run of rootRuns) {
    const start = parseTime(run.startedAt);
    const end = parseTime(run.completedAt ?? run.updatedAt);
    if (start === null || end === null || end < start) {
      continue;
    }
    earliestStart = earliestStart === null ? start : Math.min(earliestStart, start);
    latestEnd = latestEnd === null ? end : Math.max(latestEnd, end);
  }

  return earliestStart !== null && latestEnd !== null ? latestEnd - earliestStart : null;
}

function traceDurationMs(report: TraceReport): number | null {
  const runDuration = sessionRunDurationMs(report.rootRuns);
  if (runDuration !== null) {
    return runDuration;
  }
  return report.session ? durationMs(report.session.createdAt, report.session.updatedAt) : null;
}

function renderUsage(usage: SessionUsageSummary, rootRuns: RootRun[] = []): string {
  const lines = [`${chalk.cyan('usage')} ${formatUsageSummary(usage.total)}`];
  if (usage.byRootRun.length > 1 || (usage.byRootRun.length > 0 && rootRuns.length > 0)) {
    lines.push('');
    lines.push(renderRootRunUsageTable(usage.byRootRun, { rootRuns }));
  }
  return lines.join('\n');
}

function renderRootRunUsageTable(items: SessionUsageSummary['byRootRun'], options: { rootRuns?: RootRun[] } = {}): string {
  const rootRuns = options.rootRuns ?? [];
  const runByRootRunId = new Map(rootRuns.map((run) => [run.rootRunId, run]));
  const includeStatus = rootRuns.length > 0;
  const includeLinkedRun = rootRuns.some((run) => run.runId !== run.rootRunId);
  const headers = [
    'root run',
    ...(includeStatus ? ['status'] : []),
    ...(includeLinkedRun ? ['linked run'] : []),
    'tokens',
    'prompt',
    'completion',
    'reasoning',
    'cost',
  ];

  return renderTable(
    headers,
    items.map((item) => {
      const run = runByRootRunId.get(item.rootRunId);
      return [
        item.rootRunId,
        ...(includeStatus ? [statusColor(run?.status ?? 'unknown')(run?.status ?? 'unknown')] : []),
        ...(includeLinkedRun ? [run && run.runId !== run.rootRunId ? run.runId : '-'] : []),
        formatNumber(item.usage.totalTokens),
        formatNumber(item.usage.promptTokens),
        formatNumber(item.usage.completionTokens),
        formatNumber(item.usage.reasoningTokens ?? 0),
        formatCost(item.usage.estimatedCostUSD),
      ];
    }),
  );
}

function sumProviderModelUsage(rows: ProviderModelUsageSummary[]): UsageSummary {
  return rows.reduce<UsageSummary>(
    (acc, row) => {
      const reasoningTokens = (acc.reasoningTokens ?? 0) + (row.usage.reasoningTokens ?? 0);
      return {
        promptTokens: acc.promptTokens + row.usage.promptTokens,
        completionTokens: acc.completionTokens + row.usage.completionTokens,
        reasoningTokens: reasoningTokens > 0 ? reasoningTokens : undefined,
        totalTokens: acc.totalTokens + row.usage.totalTokens,
        estimatedCostUSD: acc.estimatedCostUSD + row.usage.estimatedCostUSD,
      };
    },
    { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUSD: 0 },
  );
}

function renderProviderModelUsageSections(usage: SessionUsageSummary): string | null {
  const sections: string[] = [];
  const modelUsageRows = usage.byProviderModel ?? [];
  const toolOutputUsageRows = usage.toolOutputByProviderModel ?? [];

  if (modelUsageRows.length > 0) {
    sections.push(markdownBlock('### Model Usage by Provider / Model'));
    sections.push(renderProviderModelUsageTable(modelUsageRows, 'runs'));
  }
  if (toolOutputUsageRows.length > 0) {
    if (sections.length > 0) {
      sections.push('');
    }
    sections.push(markdownBlock('### Tool-Output Usage by Provider / Model'));
    sections.push(renderProviderModelUsageTable(toolOutputUsageRows, 'tool calls'));
  }

  return sections.length === 0 ? null : sections.join('\n');
}

function renderPerformanceUsageSections(usage: SessionUsageSummary, rootRuns: RootRun[]): string {
  const sections: string[] = [];

  sections.push(markdownBlock('## Usage'));
  sections.push(`${chalk.cyan('total')} ${formatUsageSummary(usage.total)}`);

  if (usage.byRootRun.length > 0) {
    sections.push('');
    sections.push(markdownBlock('### Run Usage by Root Run'));
    sections.push(renderRootRunUsageTable(usage.byRootRun, { rootRuns }));
  }

  const providerModelSections = renderProviderModelUsageSections(usage);
  if (providerModelSections) {
    sections.push('');
    sections.push(providerModelSections);
  }

  return sections.join('\n');
}

function renderProviderModelUsageTable(
  rows: ProviderModelUsageSummary[],
  countLabel: 'runs' | 'tool calls',
): string {
  return renderTable(
    ['provider', 'model', countLabel, 'tokens', 'prompt', 'completion', 'reasoning', 'cost'],
    rows.map((row) => [
      row.provider,
      row.model,
      formatNumber(countLabel === 'runs' ? row.runCount ?? 0 : row.toolCallCount ?? 0),
      formatNumber(row.usage.totalTokens),
      formatNumber(row.usage.promptTokens),
      formatNumber(row.usage.completionTokens),
      formatNumber(row.usage.reasoningTokens ?? 0),
      formatCost(row.usage.estimatedCostUSD),
    ]),
  );
}

function renderRunAnalysisTable(diagnostics: TraceDiagnostics, previewChars: number): string {
  if (!diagnostics.analysis.runs.length) return chalk.gray('No run analysis is available.');
  return renderMetricTable(diagnostics.analysis.runs.flatMap((run) => {
    const prefix = `${'  '.repeat(run.depth)}${shortId(run.runId)}`;
    const identity = run.provider || run.model ? `${run.provider ?? 'unknown'}/${run.model ?? 'unknown'}` : 'model unknown';
    const contextBytes = [
      run.contextGrowth.initialMessageBytes,
      run.contextGrowth.latestMessageBytes,
      run.contextGrowth.peakMessageBytes,
      run.contextGrowth.messageBytesGrowth,
    ].map((value) => value === null ? '-' : formatBytes(value));
    const contextCounts = [
      run.contextGrowth.initialMessageCount,
      run.contextGrowth.latestMessageCount,
      run.contextGrowth.peakMessageCount,
      run.contextGrowth.messageCountGrowth,
    ].map((value) => value === null ? '-' : formatNumber(value));
    const rows: Array<[string, string, string]> = [
      [
        prefix,
        `status=${run.status ?? 'unknown'} ${identity}`,
        `wall=${formatDuration(run.durations.wallMs)} model=${formatDuration(run.durations.modelMs)} tools=${formatDuration(run.durations.toolMs)} snapshot=${formatDuration(run.durations.snapshotMs)} other=${formatDuration(run.durations.otherMs)} parallel=${formatRatio(run.durations.parallelism)}`,
      ],
      [
        `${prefix} calls`,
        `model=${formatNumber(run.modelCalls.logicalCalls)} logical/${formatNumber(run.modelCalls.attempts)} attempts retries=${formatNumber(run.modelCalls.retries)} failed=${formatNumber(run.modelCalls.failures)}`,
        `tools=${formatNumber(run.toolCalls.starts)} failed=${formatNumber(run.toolCalls.failures)} reduction=${formatOptionalPercentage(run.toolCalls.reductionPercentage)}`,
      ],
      [
        `${prefix} usage`,
        `${formatNumber(run.usage.combined.totalTokens)} tokens ${formatCost(run.costs.estimatedGrandTotalUSD)}`,
        `model=${formatCost(run.costs.modelEstimateUSD)} tool-output=${formatCost(run.costs.toolOutputEstimateUSD)} providers=${formatCost(run.costs.externalToolProviderEstimateUSD)}`,
      ],
      [
        `${prefix} context`,
        `${run.contextGrowth.source}/${formatNumber(run.contextGrowth.samples)} samples`,
        `bytes initial/latest/peak/growth=${contextBytes.join('/')} count=${contextCounts.join('/')}`,
      ],
      [
        `${prefix} coverage`,
        `events=${formatNumber(run.coverage.events)} performance=${formatOptionalPercentage(run.coverage.performance === null ? null : run.coverage.performance * 100)}`,
        `snapshots=${formatNumber(run.coverage.snapshots)} provider-cost=${formatOptionalPercentage(run.coverage.cost === null ? null : run.coverage.cost * 100)} children=${formatNumber(run.directChildFanOut)} output=${formatBytes(run.outputBytes)}`,
      ],
    ];
    if (run.notes.length > 0) {
      rows.push([`${prefix} notes`, previewText(run.notes.join(' '), previewChars), 'Data limitations for this run.']);
    }
    return rows;
  }));
}

function renderPerformance(
  performance: PerformanceSummary,
  totalDurationMs: number | null,
  digest: PerformanceDigest,
  usage: SessionUsageSummary,
  rootRuns: RootRun[],
  previewChars: number,
): string {
  const lines: string[] = [];
  const statusCodes = Object.entries(performance.model.adapterStatusCodes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status}:${count}`)
    .join(', ') || '-';

  if (performance.events.measuredEvents === 0) {
    lines.push(chalk.gray('No Phase 0 performance payloads were found for this trace.'));
  }

  lines.push(markdownBlock('## Digest'));
  lines.push(renderPerformanceDigest(digest, performance.events.totalEvents > 0, previewChars));

  lines.push('');
  lines.push(renderPerformanceUsageSections(usage, rootRuns));

  lines.push('');
  lines.push(markdownBlock('## Overview'));
  lines.push(renderMetricTable([
    ['events', `${formatNumber(performance.events.measuredEvents)} measured / ${formatNumber(performance.events.totalEvents)} total`, 'Events carrying `payload.performance`.'],
    ['event payload bytes', formatBucketBytes(performance.events.payloadBytes), 'Persisted runtime event payload size.'],
    ['event emit time', formatBucketDuration(performance.events.emitDurationMs), 'Time spent appending or forwarding measured events.'],
  ], previewChars));

  lines.push('');
  lines.push(markdownBlock('## Model'));
  lines.push(renderMetricTable([
    ['calls', `started=${formatNumber(performance.model.started)} completed=${formatNumber(performance.model.completed)} failed=${formatNumber(performance.model.failed)}`, 'Model lifecycle counts.'],
    ['duration', formatBucketDuration(performance.model.durationMs), 'Wall-clock model call time measured by core.'],
    ['request bytes', formatBucketBytes(performance.model.requestBytes), 'Serialized model request size before adapter conversion.'],
    ['response bytes', formatBucketBytes(performance.model.responseBytes), 'Serialized model response size after parsing.'],
    ['pending tool calls', formatBucketNumber(performance.model.pendingToolCallCount), 'Tool calls returned by model responses.'],
    ['retries', `${formatNumber(performance.model.retries)} events, delay ${formatBucketDuration(performance.model.retryDelayMs)}`, 'Adapter or provider retry activity.'],
    ['adapter latency', formatBucketDuration(performance.model.adapterResponseLatencyMs), 'Provider SDK or HTTP response latency.'],
    ['adapter gate wait', formatBucketDuration(performance.model.adapterGateWaitMs), 'Time waiting for adapter request admission.'],
    ['adapter attempts', formatBucketNumber(performance.model.adapterAttemptCount), 'Attempts reported by adapters.'],
    ['adapter bytes', `request ${formatBucketBytes(performance.model.adapterRequestBytes)} / response ${formatBucketBytes(performance.model.adapterResponseBytes)}`, 'Serialized provider-specific request and response sizes.'],
    ['adapter status', statusCodes, 'HTTP status codes observed by adapters.'],
  ], previewChars));

  lines.push('');
  lines.push(markdownBlock('## Tools'));
  lines.push(renderMetricTable([
    ['calls', `started=${formatNumber(performance.tools.started)} completed=${formatNumber(performance.tools.completed)} failed=${formatNumber(performance.tools.failed)}`, 'Tool execution call counts.'],
    ['duration', formatBucketDuration(performance.tools.durationMs), 'Host tool execution time.'],
    ['child duration', formatBucketDuration(performance.tools.childRunDurationMs), 'Synthetic delegate child-run wall time; not added to the duration split to avoid double counting child spans.'],
    ['input bytes', formatBucketBytes(performance.tools.inputBytes), 'Raw tool input size.'],
    ['event input bytes', formatBucketBytes(performance.tools.eventInputBytes), 'Input size after event capture/redaction.'],
    ['raw output bytes', formatBucketBytes(performance.tools.rawOutputBytes), 'Raw tool output size.'],
    ['event output bytes', formatBucketBytes(performance.tools.eventOutputBytes), 'Output size persisted in lifecycle events.'],
    ['model output bytes', formatBucketBytes(performance.tools.modelOutputBytes), 'Tool output size visible to the model.'],
  ], previewChars));

  const visibleTools = performance.tools.byTool
    .filter((tool) => tool.durationMs.count > 0 || tool.rawOutputBytes.count > 0 || tool.started > 0)
    .slice(0, 8);
  if (visibleTools.length > 0) {
    lines.push('');
    lines.push(markdownBlock('### Top Tools'));
    lines.push(renderTable(
      ['tool', 'started', 'completed', 'failed', 'duration', 'raw output', 'model output'],
      visibleTools.map((tool) => [
        toolColor(tool.toolName)(tool.toolName),
        formatNumber(tool.started),
        formatNumber(tool.completed),
        formatNumber(tool.failed),
        formatBucketDuration(tool.durationMs),
        formatBucketBytes(tool.rawOutputBytes),
        formatBucketBytes(tool.modelOutputBytes),
      ]),
    ));
  }

  lines.push('');
  lines.push(markdownBlock('## Snapshots'));
  lines.push(renderDurationSplit(performance, totalDurationMs));
  lines.push(renderMetricTable([
    ['created', formatNumber(performance.snapshots.created), 'Snapshot events observed in the trace.'],
    ['state bytes', formatBucketBytes(performance.snapshots.stateBytes), 'Serialized snapshot state size.'],
    ['message bytes', formatBucketBytes(performance.snapshots.messageBytes), 'Serialized persisted message context size.'],
    ['message count', formatBucketNumber(performance.snapshots.messageCount), 'Messages persisted in snapshots.'],
    ['pending tool bytes', formatBucketBytes(performance.snapshots.pendingToolCallBytes), 'Serialized pending tool call state.'],
    ['save time', formatBucketDuration(performance.snapshots.saveDurationMs), 'Snapshot store write time when measured.'],
  ], previewChars));

  lines.push('');
  lines.push(markdownBlock('## Notes'));
  lines.push('- `total` shows cumulative volume or time across measured events; `max` points to the largest single event.');
  lines.push('- Request and snapshot bytes usually explain prompt or persistence bloat; adapter latency usually explains provider wait.');
  lines.push('- `raw output` versus `model output` shows whether tool results are being compressed before returning to the model.');

  return lines.join('\n');
}

function renderPerformanceDigest(digest: PerformanceDigest, includeTimelineSpans: boolean, previewChars: number): string {
  const lines: string[] = [];
  lines.push(renderMetricTable([
    ['wall time', formatDuration(digest.wallDurationMs), 'Elapsed time across root runs; falls back to session duration when run timing is unavailable.'],
    ['cumulative measured', formatDuration(digest.cumulativeMeasuredDurationMs), 'Model + tool + snapshot save time. May exceed wall time when work is parallel or nested.'],
    ['model / tools / snapshots', `${formatDuration(digest.cumulativeModelDurationMs)} / ${formatDuration(digest.cumulativeToolDurationMs)} / ${formatDuration(digest.cumulativeSnapshotSaveMs)}`, 'Main cumulative duration buckets.'],
    ['other wall time', formatDuration(digest.otherDurationMs), 'Wall time not explained by measured model/tool/snapshot buckets.'],
    ['parallelism factor', formatRatio(digest.parallelismFactor), 'Cumulative measured time divided by wall time.'],
    ['tool provider cost', `${formatCost(digest.toolAccounting.estimatedCostUSD)} estimated / ${formatNumber(digest.toolAccounting.totalRequests)} requests`, 'Call-count based tool provider cost from event accounting payloads.'],
  ], previewChars));

  if (digest.toolAccounting.byProviderOperation.length > 0) {
    lines.push('');
    lines.push(markdownBlock('### Tool Provider Accounting'));
    lines.push(renderTable(
      ['provider', 'operation', 'tool calls', 'requests', 'billable', 'cached', 'unpriced', 'cost'],
      digest.toolAccounting.byProviderOperation.map((row) => [
        row.provider,
        row.operation,
        formatNumber(row.toolCalls),
        formatNumber(row.requests),
        formatNumber(row.billableRequests),
        formatNumber(row.cachedToolCalls),
        formatNumber(row.unpricedRequests),
        formatCost(row.estimatedCostUSD),
      ]),
    ));
  }

  if (digest.topRunsByUsage.length > 0) {
    lines.push('');
    lines.push(markdownBlock('### Top Token Runs'));
    lines.push(renderTable(
      ['root', 'tokens', 'prompt', 'completion', 'cost', 'goal'],
      digest.topRunsByUsage.map((run) => [
        shortId(run.rootRunId),
        formatNumber(run.totalTokens),
        formatNumber(run.promptTokens),
        formatNumber(run.completionTokens),
        formatCost(run.estimatedCostUSD),
        run.goal ? previewText(run.goal, previewChars) : '-',
      ]),
    ));
  }

  if (includeTimelineSpans && digest.topToolSpans.length > 0) {
    lines.push('');
    lines.push(markdownBlock('### Slowest Tool Spans'));
    lines.push(renderTable(
      ['duration', 'run/depth', 'step', 'tool', 'outcome'],
      digest.topToolSpans.map((span) => [
        formatDuration(span.durationMs),
        `${shortId(span.rootRunId)}/${shortId(span.runId)}`,
        span.stepId ?? '-',
        span.toolName ?? 'tool',
        statusColor(span.outcome)(span.outcome),
      ]),
    ));
  }

  if (digest.topToolsByModelOutput.length > 0) {
    lines.push('');
    lines.push(markdownBlock('### Largest Model-Visible Tool Outputs'));
    lines.push(renderTable(
      ['tool', 'calls', 'model output', 'raw output'],
      digest.topToolsByModelOutput.map((tool) => [
        toolColor(tool.toolName)(tool.toolName),
        `${formatNumber(tool.completed)} completed / ${formatNumber(tool.failed)} failed`,
        formatBucketBytes(tool.modelOutputBytes),
        formatBucketBytes(tool.rawOutputBytes),
      ]),
    ));
  }

  if (digest.notes.length > 0) {
    lines.push('');
    lines.push(markdownBlock('### Digest Notes'));
    for (const note of digest.notes) {
      lines.push(`- ${note}`);
    }
  }

  return lines.join('\n');
}

function emptyPerformanceSummary(): PerformanceSummary {
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

function renderDurationSplit(performance: PerformanceSummary, totalDurationMs: number | null): string {
  const split = durationSplitParts(performance, totalDurationMs);
  return [
    chalk.cyan('Duration split:'),
    `total=${formatDuration(split.totalDurationMs)}`,
    `model=${formatDuration(split.modelDurationMs)}`,
    `tools=${formatDuration(split.toolDurationMs)}`,
    `snapshot save=${formatDuration(split.snapshotSaveMs)}`,
    `other=${formatDuration(split.otherDurationMs)}`,
  ].join('  ');
}

function durationSplitParts(performance: PerformanceSummary, totalDurationMs: number | null): {
  totalDurationMs: number | null;
  modelDurationMs: number;
  toolDurationMs: number;
  snapshotSaveMs: number;
  otherDurationMs: number | null;
} {
  const modelDurationMs = performance.model.durationMs.total;
  const toolDurationMs = performance.tools.durationMs.total;
  const snapshotSaveMs = performance.snapshots.saveDurationMs.total;
  const measuredMs = modelDurationMs + toolDurationMs + snapshotSaveMs;
  const otherDurationMs = totalDurationMs === null ? null : Math.max(0, totalDurationMs - measuredMs);
  return {
    totalDurationMs,
    modelDurationMs,
    toolDurationMs,
    snapshotSaveMs,
    otherDurationMs,
  };
}

function renderGoal(rootRuns: RootRun[]): string {
  const rootsWithGoals = rootRuns.filter((run) => run.goal);
  if (rootsWithGoals.length === 0) {
    return chalk.gray('No root run goal was found.');
  }
  if (rootsWithGoals.length === 1) {
    return markdownInline(rootsWithGoals[0]!.goal!);
  }
  return rootsWithGoals.map((run) => `${chalk.green(shortId(run.rootRunId))}: ${markdownInline(run.goal!)}`).join('\n');
}

function renderFinalOutput(rootRuns: RootRun[]): string {
  const rootsWithOutput = rootRuns.filter((run) => run.result !== null && run.result !== undefined);
  if (rootsWithOutput.length === 0) {
    return chalk.gray('No final output was found for the linked root runs.');
  }
  if (rootsWithOutput.length === 1) {
    return renderOutputValue(rootsWithOutput[0]!.result);
  }
  return rootsWithOutput.map((run) => `${chalk.green(shortId(run.rootRunId))}\n${renderOutputValue(run.result)}`).join('\n\n');
}

function renderOutputValue(value: unknown): string {
  if (typeof value === 'string') {
    return markdownBlock(value);
  }
  return markdownBlock(`\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``);
}

function formatUsageSummary(usage: UsageSummary): string {
  const parts = [
    `prompt=${formatNumber(usage.promptTokens)}`,
    `completion=${formatNumber(usage.completionTokens)}`,
  ];
  if (usage.reasoningTokens !== undefined) {
    parts.push(`reasoning=${formatNumber(usage.reasoningTokens)}`);
  }
  parts.push(`total=${formatNumber(usage.totalTokens)}`);
  parts.push(`cost=${formatCost(usage.estimatedCostUSD)}`);
  return parts.join('  ');
}

function renderTimeline(entries: TimelineEntry[], previewChars: number): string {
  if (entries.length === 0) {
    return chalk.gray('No migrated tool timeline rows were found.');
  }

  const rows = entries.map((entry) => [
    formatTimeOfDay(entry.startedAt),
    formatDuration(entry.durationMs),
    `${shortId(entry.rootRunId)}/${shortId(entry.runId)} d${entry.depth}`,
    entry.stepId ?? '-',
    toolColor(entry.toolName)(entry.toolName ?? entry.eventType ?? 'tool'),
    compactValue(entry.params ?? entry.output, previewChars),
    statusColor(entry.outcome)(entry.outcome),
  ]);
  return renderTable(['started-time', 'duration', 'run/depth', 'step', 'tool', 'params', 'outcome'], rows);
}

function formatTimelineTitle(entries: TimelineEntry[], session: SessionOverview | null): string {
  const startedAt = earliestTimelineStart(entries) ?? session?.createdAt ?? null;
  return startedAt ? `Tool Timeline: ${formatTime(startedAt)}` : 'Tool Timeline';
}

function renderMilestones(entries: MilestoneEntry[]): string {
  if (entries.length === 0) {
    return chalk.gray('No persisted milestone events were found.');
  }
  return entries.map((entry) => entry.text).join('\n');
}

function renderLlmMessages(
  traces: RunMessageTrace[],
  options: Pick<CliOptions, 'systemOnly'> & { messagesView: MessageView; previewChars: number },
): string {
  switch (options.messagesView) {
    case 'delta':
      return renderLlmMessageDelta(traces, options);
    case 'full':
      return renderLlmMessageFull(traces, options);
    case 'compact':
      return renderLlmMessageCompact(traces, options);
  }
}

function renderLlmMessageCompact(
  traces: RunMessageTrace[],
  options: Pick<CliOptions, 'systemOnly'> & { previewChars: number },
): string {
  const sections = traces
    .map((trace) => {
      const visibleMessages = trace.effectiveMessages.filter((message) => !options.systemOnly || message.role === 'system');
      if (visibleMessages.length === 0) {
        return null;
      }

      const runHeader = `${chalk.green(shortId(trace.rootRunId))}/${shortId(trace.runId)} d${trace.depth}${trace.delegateName ? ` ${chalk.magenta(trace.delegateName)}` : ''}`;
      const snapshotSummary = `${chalk.cyan('initial')} ${trace.initialSnapshotSeq ?? '-'} @ ${formatTime(trace.initialSnapshotCreatedAt)}  ${chalk.cyan('latest')} ${trace.latestSnapshotSeq ?? '-'} @ ${formatTime(trace.latestSnapshotCreatedAt)}`;
      const counts = summarizeMessages(visibleMessages);
      const lines = [
        runHeader,
        snapshotSummary,
        `counts: persisted=${counts.persisted} pending=${counts.pending} system=${counts.system} runtime-injected=${counts.runtimeInjected} user=${counts.user} assistant=${counts.assistant} tool=${counts.tool}`,
        renderTable(
          ['#', 'state', 'role', 'category', 'preview'],
          visibleMessages.map((message) => {
            const color = messageRoleColor(message.role);
            return [
              color(String(message.position + 1)),
              color(message.persistence),
              color(message.role),
              color(humanMessageCategoryPlain(message.category)),
              color(formatMessagePreview(message, options.previewChars)),
            ];
          }),
          { maxWidths: [36, 36, 36, 36, options.previewChars] },
        ),
      ];

      return lines.join('\n');
    })
    .filter((section): section is string => section !== null);

  if (sections.length === 0) {
    return chalk.gray('No snapshot-backed LLM messages were found.');
  }

  return sections.join('\n\n');
}

function renderLlmMessageDelta(
  traces: RunMessageTrace[],
  options: Pick<CliOptions, 'systemOnly'> & { previewChars: number },
): string {
  const sections = traces
    .map((trace) => {
      const deltaRows = buildMessageDeltaRows(trace)
        .filter((row) => !options.systemOnly || row.message.role === 'system');
      if (deltaRows.length === 0) {
        return null;
      }

      const runHeader = `${chalk.green(shortId(trace.rootRunId))}/${shortId(trace.runId)} d${trace.depth}${trace.delegateName ? ` ${chalk.magenta(trace.delegateName)}` : ''}`;
      const snapshotSummary = `${chalk.cyan('initial')} ${trace.initialSnapshotSeq ?? '-'} @ ${formatTime(trace.initialSnapshotCreatedAt)}  ${chalk.cyan('latest')} ${trace.latestSnapshotSeq ?? '-'} @ ${formatTime(trace.latestSnapshotCreatedAt)}`;
      const counts = {
        added: deltaRows.filter((row) => row.kind === 'added').length,
        changed: deltaRows.filter((row) => row.kind === 'changed').length,
        pending: deltaRows.filter((row) => row.kind === 'pending').length,
      };
      const rows = deltaRows.map((row) => [
        messageRoleColor(row.message.role)(row.kind),
        messageRoleColor(row.message.role)(String(row.message.position + 1)),
        messageRoleColor(row.message.role)(row.message.persistence),
        messageRoleColor(row.message.role)(row.message.role),
        messageRoleColor(row.message.role)(humanMessageCategoryPlain(row.message.category)),
        messageRoleColor(row.message.role)(formatMessagePreview(row.message, options.previewChars)),
      ]);

      return [
        runHeader,
        snapshotSummary,
        `delta: added=${counts.added} changed=${counts.changed} pending=${counts.pending}`,
        renderTable(['delta', '#', 'state', 'role', 'category', 'preview'], rows, {
          maxWidths: [36, 36, 36, 36, 36, options.previewChars],
        }),
      ].join('\n');
    })
    .filter((section): section is string => section !== null);

  if (sections.length === 0) {
    return chalk.gray('No message deltas were found for the traced runs.');
  }

  return sections.join('\n\n');
}

function renderLlmMessageFull(
  traces: RunMessageTrace[],
  options: Pick<CliOptions, 'systemOnly'>,
): string {
  const sections = traces
    .map((trace) => {
      const visibleMessages = trace.effectiveMessages.filter((message) => !options.systemOnly || message.role === 'system');
      if (visibleMessages.length === 0) {
        return null;
      }

      const runHeader = `${chalk.green(shortId(trace.rootRunId))}/${shortId(trace.runId)} d${trace.depth}${trace.delegateName ? ` ${chalk.magenta(trace.delegateName)}` : ''}`;
      const snapshotSummary = `${chalk.cyan('initial')} ${trace.initialSnapshotSeq ?? '-'} @ ${formatTime(trace.initialSnapshotCreatedAt)}  ${chalk.cyan('latest')} ${trace.latestSnapshotSeq ?? '-'} @ ${formatTime(trace.latestSnapshotCreatedAt)}`;
      const lines = [runHeader, snapshotSummary];

      for (const message of visibleMessages) {
        const color = messageRoleColor(message.role);
        lines.push('');
        lines.push(color(`${message.position + 1}. ${message.persistence === 'pending' ? '[pending]' : '[persisted]'} ${message.role} ${humanMessageCategoryPlain(message.category)}`));
        if (message.name) {
          lines.push(`name: ${message.name}`);
        }
        if (message.toolCallId) {
          lines.push(`toolCallId: ${message.toolCallId}`);
        }
        if (message.toolCalls && message.toolCalls.length > 0) {
          lines.push(markdownBlock(`\`\`\`json\n${JSON.stringify(message.toolCalls, null, 2)}\n\`\`\``));
        }
        if (message.reasoning !== undefined) {
          lines.push('reasoning:');
          lines.push(markdownBlock(`\`\`\`text\n${message.reasoning}\n\`\`\``));
        }
        if (message.reasoningDetails !== undefined) {
          lines.push('reasoningDetails:');
          lines.push(markdownBlock(`\`\`\`json\n${JSON.stringify(message.reasoningDetails, null, 2)}\n\`\`\``));
        }
        lines.push(markdownBlock(`\`\`\`text\n${message.content}\n\`\`\``));
      }

      return lines.join('\n');
    })
    .filter((section): section is string => section !== null);

  if (sections.length === 0) {
    return chalk.gray('No snapshot-backed LLM messages were found.');
  }

  return sections.join('\n\n');
}

function renderDelegates(delegates: DelegateRow[]): string {
  const activeOrSuspicious = delegates.filter((delegate) => delegate.delegate_reason !== 'returned successfully');
  const rowsToShow = activeOrSuspicious.length > 0 ? activeOrSuspicious : delegates;
  if (rowsToShow.length === 0) {
    return chalk.gray('No active or suspicious delegate chains were found.');
  }

  const rows = rowsToShow.map((delegate) => [
    shortId(delegate.parent_run_id),
    delegate.child_delegate_name ?? delegate.snapshot_delegate_name ?? 'delegate',
    delegate.child_run_id ? shortId(delegate.child_run_id) : '-',
    statusColor(delegate.child_status ?? 'missing')(delegate.child_status ?? 'missing'),
    formatTime(delegate.child_heartbeat_at),
    formatTime(delegate.child_lease_expires_at),
    delegate.child_last_event_type ?? '-',
    statusColor(delegate.delegate_reason)(delegate.delegate_reason),
  ]);
  return renderTable(['parent', 'delegate', 'child', 'child status', 'heartbeat', 'lease expiry', 'last event', 'reason'], rows);
}

function renderPlans(plans: PlanRow[], previewChars: number): string {
  if (plans.length === 0) {
    return chalk.gray('No plan rows were found.');
  }
  const rows = plans.map((plan) => [
    shortId(plan.run_id),
    plan.plan_execution_id ? shortId(plan.plan_execution_id) : '-',
    statusColor(plan.plan_execution_status ?? 'unknown')(plan.plan_execution_status ?? 'unknown'),
    plan.step_index === null ? '-' : String(plan.step_index),
    plan.title ? previewText(plan.title, previewChars) : plan.step_key ?? '-',
    plan.tool_name ?? '-',
    plan.replan_reason ? previewText(plan.replan_reason, previewChars) : '-',
  ]);
  return renderTable(['run', 'execution', 'status', 'step', 'title', 'tool', 'replan'], rows);
}

function humanMessageCategory(category: TraceMessage['category']): string {
  switch (category) {
    case 'initial-runtime-system':
      return chalk.cyan('initial runtime system prompt');
    case 'gateway-chat-system-context':
      return chalk.cyan('gateway/chat system context');
    case 'runtime-injected-system':
      return chalk.yellow('runtime-injected system prompt');
    case 'runtime-injected-user':
      return chalk.yellow('runtime-injected user message');
    case 'user':
      return chalk.white('user message');
    case 'assistant':
      return chalk.white('assistant message');
    case 'tool':
      return chalk.white('tool message');
  }
}

function humanMessageCategoryPlain(category: TraceMessage['category']): string {
  switch (category) {
    case 'initial-runtime-system':
      return 'initial-runtime-system';
    case 'gateway-chat-system-context':
      return 'gateway-chat-system-context';
    case 'runtime-injected-system':
      return 'runtime-injected-system';
    case 'runtime-injected-user':
      return 'runtime-injected-user';
    case 'user':
      return 'user';
    case 'assistant':
      return 'assistant';
    case 'tool':
      return 'tool';
  }
}

function summarizeMessages(messages: TraceMessage[]): {
  persisted: number;
  pending: number;
  system: number;
  runtimeInjected: number;
  user: number;
  assistant: number;
  tool: number;
} {
  return messages.reduce(
    (counts, message) => {
      if (message.persistence === 'persisted') {
        counts.persisted += 1;
      } else {
        counts.pending += 1;
      }
      if (message.role === 'system') {
        counts.system += 1;
      }
      if (message.category === 'runtime-injected-system' || message.category === 'runtime-injected-user') {
        counts.runtimeInjected += 1;
      }
      if (message.role === 'user') {
        counts.user += 1;
      }
      if (message.role === 'assistant') {
        counts.assistant += 1;
      }
      if (message.role === 'tool') {
        counts.tool += 1;
      }
      return counts;
    },
    { persisted: 0, pending: 0, system: 0, runtimeInjected: 0, user: 0, assistant: 0, tool: 0 },
  );
}

function formatMessagePreview(message: TraceMessage, previewChars: number): string {
  const parts: string[] = [];
  if (message.name) {
    parts.push(`name=${message.name}`);
  }
  if (message.toolCallId) {
    parts.push(`toolCallId=${message.toolCallId}`);
  }
  if (message.toolCalls && message.toolCalls.length > 0) {
    parts.push(`toolCalls=${message.toolCalls.length} [${message.toolCalls.map((toolCall) => toolCall.name).join(', ')}]`);
  }
  if (message.reasoning !== undefined) {
    parts.push(`reasoning=${message.reasoning.length} chars`);
  }
  if (message.reasoningDetails !== undefined) {
    parts.push(`reasoningDetails=${message.reasoningDetails.length}`);
  }
  const content = oneLine(message.content).trim();
  if (content.length > 0) {
    parts.push(truncatePlain(content, previewChars));
  }
  return parts.length > 0 ? parts.join(' | ') : '(empty)';
}

function buildMessageDeltaRows(trace: RunMessageTrace): Array<{ kind: 'added' | 'changed' | 'pending'; message: TraceMessage }> {
  const initialMessages = trace.initialMessages ?? [];
  const latestPersistedMessages = trace.effectiveMessages.filter((message) => message.persistence === 'persisted');
  const pendingMessages = trace.effectiveMessages.filter((message) => message.persistence === 'pending');
  const rows: Array<{ kind: 'added' | 'changed' | 'pending'; message: TraceMessage }> = [];

  for (let index = 0; index < latestPersistedMessages.length; index += 1) {
    const message = latestPersistedMessages[index]!;
    if (index >= initialMessages.length) {
      rows.push({ kind: 'added', message });
      continue;
    }
    if (!messagesEquivalent(initialMessages[index]!, message)) {
      rows.push({ kind: 'changed', message });
    }
  }

  for (const message of pendingMessages) {
    rows.push({ kind: 'pending', message });
  }

  return rows;
}

function messagesEquivalent(left: TraceMessage, right: TraceMessage): boolean {
  return left.role === right.role
    && left.content === right.content
    && left.name === right.name
    && left.toolCallId === right.toolCallId
    && JSON.stringify(left.toolCalls ?? []) === JSON.stringify(right.toolCalls ?? [])
    && left.reasoning === right.reasoning
    && JSON.stringify(left.reasoningDetails ?? []) === JSON.stringify(right.reasoningDetails ?? []);
}

function resolveReportView(options: Pick<CliOptions, 'onlyDelegates'> & Partial<Pick<CliOptions, 'view' | 'messages' | 'systemOnly' | 'includePlans'>>): ReportView {
  if (options.view) {
    if (options.view === 'overview') return 'summary';
    if (options.view === 'performance' || options.view === 'operations') return 'performance';
    return options.view;
  }
  if (options.onlyDelegates) {
    return 'delegates';
  }
  return options.messages || options.systemOnly || options.includePlans ? 'all' : 'summary';
}

function shouldRenderDiagnosticLead(view: ReportView, onlyDelegates: boolean): boolean {
  if (onlyDelegates) {
    return false;
  }
  return view === 'all'
    || view === 'overview'
    || view === 'brief'
    || view === 'investigate'
    || view === 'policy';
}

function shouldRenderSection(
  view: ReportView,
  section: 'performance' | 'milestones' | 'timeline' | 'delegates' | 'messages' | 'plans',
): boolean {
  return view === 'all' || view === section;
}

function shouldRenderFinalOutput(view: ReportView): boolean {
  return view === 'all' || view === 'overview';
}

function renderTable(headers: string[], rows: string[][], options?: { maxWidths?: number[] }): string {
  return renderTerminalTable(headers, rows, {
    profile: 'compact',
    maximumWidths: options?.maxWidths,
  });
}

function renderTerminalTable(
  headers: string[],
  rows: string[][],
  options: {
    profile: TerminalTableProfile;
    alignments?: MarkdownTableAlignment[];
    maximumWidths?: number[];
  },
): string {
  const boxed = options.profile === 'boxed';
  const cellPadding = boxed ? 2 : 1;
  const separatorWidth = boxed ? headers.length + 1 : Math.max(0, headers.length - 1);
  const widths = fitColumnWidths(headers, rows, {
    availableWidth: terminalWidth() - separatorWidth,
    cellPadding,
    maximumWidths: options.maximumWidths?.map((width) => width + cellPadding),
    minimumWidth: boxed ? 5 : 4,
  });
  const table = new Table({
    head: headers.map((header, index) => wrapAnsi(
      boxed ? header : chalk.bold(header),
      Math.max(1, widths[index]! - cellPadding),
      { hard: true, wordWrap: false, trim: false },
    )),
    colWidths: widths,
    colAligns: headers.map((_, index) => boxed ? options.alignments?.[index] ?? 'left' : 'left'),
    // Cells are pre-wrapped with wrap-ansi. cli-table3's hard-wrap path counts
    // raw ANSI bytes and can split escape sequences into visible text.
    wordWrap: false,
    ...(boxed
      ? {}
      : {
          chars: COMPACT_TABLE_CHARS,
          style: {
            'padding-left': 0,
            'padding-right': 1,
            head: [],
            border: [],
            compact: true,
          },
        }),
  });
  table.push(...rows.map((row) => headers.map((_, index) => wrapAnsi(
    row[index] ?? '',
    Math.max(1, widths[index]! - cellPadding),
    { hard: true, wordWrap: false, trim: false },
  ))));
  return table.toString();
}

function renderMetricTable(
  rows: Array<[metric: string, value: string, explanation: string]>,
  previewChars?: number,
): string {
  return renderTable(['metric', 'value', 'meaning'], rows.map(([metric, value, explanation]) => [
    chalk.cyan(metric),
    value,
    previewChars === undefined ? explanation : previewText(explanation, previewChars),
  ]));
}

function statusColor(status: string): (value: string) => string {
  if (['succeeded', 'returned successfully', 'healthy', 'recovered', 'high'].includes(status)) {
    return chalk.green;
  }
  if (status.includes('failed') || status === 'failed') {
    return chalk.red;
  }
  if (status.includes('blocked') || status.includes('waiting') || status.includes('awaiting') || status === 'running' || status === 'degraded' || status === 'medium' || status === 'low') {
    return chalk.yellow;
  }
  return chalk.white;
}

function findingSeverityColor(severity: TraceFinding['severity']): (value: string) => string {
  switch (severity) {
    case 'error':
      return chalk.red;
    case 'warning':
      return chalk.yellow;
    case 'info':
      return chalk.cyan;
  }
}

function messageRoleColor(role: TraceMessageRole): (value: string) => string {
  switch (role) {
    case 'user':
      return chalk.blueBright;
    case 'assistant':
      return chalk.cyanBright;
    case 'tool':
      return chalk.greenBright;
    case 'system':
      return chalk.yellowBright;
  }
}

function toolColor(toolName: string | null): (value: string) => string {
  if (!toolName) {
    return chalk.white;
  }
  if (toolName.startsWith('delegate.')) {
    return chalk.magenta;
  }
  return chalk.blue;
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

function durationMs(startedAt: string | null, completedAt: string | null): number | null {
  if (!startedAt || !completedAt) {
    return null;
  }
  const start = parseTime(startedAt);
  const end = parseTime(completedAt);
  if (start === null || end === null) {
    return null;
  }
  const duration = end - start;
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function formatDuration(ms: number | null): string {
  if (ms === null) {
    return '-';
  }
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatTime(value: string | null): string {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

function formatTimeOfDay(value: string | null): string {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toISOString().slice(11, -1);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatCost(value: number): string {
  return `$${value.toFixed(6)}`;
}

function formatRatio(value: number | null): string {
  return value === null ? '-' : `${value.toFixed(2)}x`;
}

function formatOptionalPercentage(value: number | null): string {
  return value === null ? '-' : `${value.toFixed(1)}%`;
}

function formatBucketBytes(bucket: PerformanceBucketSummary): string {
  if (bucket.count === 0) {
    return '-';
  }
  return `${formatBytes(bucket.total)} total/${formatBytes(bucket.max)} max/${formatBytes(bucket.average)} avg`;
}

function formatBucketDuration(bucket: PerformanceBucketSummary): string {
  if (bucket.count === 0) {
    return '-';
  }
  return `${formatDuration(bucket.total)} total/${formatDuration(bucket.max)} max/${formatDuration(bucket.average)} avg`;
}

function formatBucketNumber(bucket: PerformanceBucketSummary): string {
  if (bucket.count === 0) {
    return '-';
  }
  return `${formatNumber(bucket.total)} total/${formatNumber(bucket.max)} max/${formatNumber(Number(bucket.average.toFixed(2)))} avg`;
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${formatNumber(Math.round(value))}B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)}KiB`;
  }
  return `${(value / (1024 * 1024)).toFixed(2)}MiB`;
}

function compactValue(value: unknown, previewChars: number): string {
  if (value === null || value === undefined) {
    return '-';
  }
  const source = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return markdownInline(previewText(source, previewChars));
}

function markdownInline(source: string): string {
  return marked(source, { async: false }).trim();
}

function markdownBlock(source: string): string {
  return marked(`${source}\n`, { async: false }).trimEnd();
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function previewText(value: string, previewChars: number): string {
  return truncatePlain(oneLine(value), previewChars);
}

function wrapPlain(value: string, width: number): string[] {
  const normalized = oneLine(value);
  if (normalized.length === 0) {
    return [''];
  }

  const lines: string[] = [];
  let current = '';
  for (const word of normalized.split(' ')) {
    if (current.length === 0) {
      current = word;
      continue;
    }
    if (current.length + 1 + word.length <= width) {
      current += ` ${word}`;
      continue;
    }
    lines.push(current);
    current = word;
  }
  if (current.length > 0) {
    lines.push(current);
  }
  return lines;
}

function terminalWidth(): number {
  const environmentWidth = Number.parseInt(process.env.COLUMNS ?? '', 10);
  const width = Number.isFinite(environmentWidth) ? environmentWidth : (process.stdout.columns ?? 120);
  return Math.max(60, width);
}

function fitColumnWidths(
  headers: string[],
  rows: string[][],
  options: {
    availableWidth: number;
    cellPadding?: number;
    maximumWidths?: number[];
    minimumWidth: number;
  },
): number[] {
  const padding = options.cellPadding ?? 0;
  const natural = headers.map((header, index) => Math.min(
    Math.max(
      visibleLength(header) + padding,
      ...rows.map((row) => visibleLength(row[index] ?? '') + padding),
    ),
    options.maximumWidths?.[index] ?? Number.POSITIVE_INFINITY,
  ));
  const widths = [...natural];
  const minimums = headers.map((_, index) => Math.min(
    natural[index]!,
    Math.max(
      options.minimumWidth,
      index === 0 ? 32 : 0,
      headers[index]?.toLowerCase() === 'value' ? 40 : 0,
      ['meaning', 'params', 'preview', 'goal', 'title', 'replan', 'detail'].includes(headers[index]?.toLowerCase() ?? '') ? 24 : 0,
      Math.min(longestCommaSeparatedItem(rows.map((row) => row[index] ?? '')) + padding, 32),
    ),
  ));
  const budget = Math.max(headers.length * options.minimumWidth, options.availableWidth);

  while (widths.reduce((total, width) => total + width, 0) > budget) {
    let candidate = -1;
    let largestSlack = 0;
    for (let index = 0; index < widths.length; index += 1) {
      const slack = widths[index]! - minimums[index]!;
      if (slack > largestSlack) {
        candidate = index;
        largestSlack = slack;
      }
    }
    if (candidate === -1) {
      const widest = widths.reduce((best, width, index) => width > widths[best]! ? index : best, 0);
      if (widths[widest]! <= options.minimumWidth) break;
      widths[widest]!--;
    } else {
      widths[candidate]!--;
    }
  }
  return widths;
}

function longestCommaSeparatedItem(values: string[]): number {
  return Math.max(0, ...values.flatMap((value) =>
    value.includes(',')
      ? stripAnsi(value).split(/,\s*/).map((item) => stringWidth(item))
      : [0],
  ));
}

function visibleLength(value: string): number {
  return Math.max(...stripAnsi(value).split(/\r?\n/).map((line) => stringWidth(line)));
}

function truncatePlain(value: string, width: number): string {
  const graphemes = [...GRAPHEME_SEGMENTER.segment(value)]
    .map((part) => part.segment);
  return graphemes.length > width
    ? `${graphemes.slice(0, Math.max(0, width - 1)).join('').trimEnd()}…`
    : value;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}
