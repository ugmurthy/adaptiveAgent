import type { TraceReport } from '@adaptive-agent/trace-session';

export function formatDuration(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'unknown';
  if (value < 1_000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(1)}s`;
  return `${(value / 60_000).toFixed(1)}m`;
}

export function formatCost(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '$0.000000';
  return `$${value.toFixed(value >= 1 ? 2 : 6)}`;
}

export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
  if (Math.abs(value) < 1_024) return `${Math.round(value)} B`;
  if (Math.abs(value) < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}

export function formatRatio(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
  return `${value.toFixed(2)}x`;
}

export function formatPercentage(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
  return `${value.toFixed(1)}%`;
}

export function compactId(value: string | null | undefined): string {
  if (!value) return 'unknown';
  return value.length <= 12 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`;
}

export function oneLine(value: unknown, fallback = 'No goal persisted'): string {
  if (value === null || value === undefined || value === '') return fallback;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.replace(/\s+/g, ' ').trim();
}

export function buildTraceMarkdown(report: TraceReport | null): string {
  if (!report) return '# AdaptiveAgent trace\n\nSelect a run to generate a trace narrative.';
  const brief = report.diagnostics?.brief;
  const usage = report.usage.total;
  const toolAccounting = report.usage.toolAccounting ?? report.diagnostics?.performance.toolAccounting;
  const toolCostUSD = toolAccounting?.estimatedCostUSD ?? 0;
  const totalCostUSD = usage.estimatedCostUSD + toolCostUSD;
  const rootRun = report.rootRuns[0];
  const findings = report.diagnostics?.findings ?? [];
  const topTools = report.diagnostics?.performance.topToolsByDuration ?? [];
  const runAnalysis = report.diagnostics?.analysis?.runs ?? [];
  const finalOutputLines = formatFinalOutputs(report.rootRuns);

  return [
    `# AdaptiveAgent trace: ${brief?.targetLabel ?? rootRun?.rootRunId ?? report.target.requestedId}`,
    '',
    `**Outcome:** ${report.summary.status}`,
    '',
    report.summary.reason,
    '',
    '## Goal',
    '',
    stringifyGoal(rootRun?.goal),
    '',
    '## Final output',
    '',
    ...finalOutputLines,
    '',
    '## Resource ledger',
    '',
    `- Wall time: ${formatDuration(brief?.wallDurationMs)}`,
    `- Model time: ${formatDuration(brief?.cumulativeModelDurationMs)}`,
    `- Tool time: ${formatDuration(brief?.cumulativeToolDurationMs)}`,
    `- Tokens: ${usage.totalTokens.toLocaleString()} total (${usage.promptTokens.toLocaleString()} prompt / ${usage.completionTokens.toLocaleString()} completion${usage.reasoningTokens ? ` / ${usage.reasoningTokens.toLocaleString()} reasoning` : ''})`,
    `- Estimated model cost: ${formatCost(usage.estimatedCostUSD)}`,
    `- Estimated tool provider cost: ${formatCost(toolCostUSD)}`,
    `- Estimated total cost: ${formatCost(totalCostUSD)}`,
    `- Tool provider requests: ${(toolAccounting?.totalRequests ?? 0).toLocaleString()} total / ${(toolAccounting?.billableRequests ?? 0).toLocaleString()} billable / ${(toolAccounting?.cachedToolCalls ?? 0).toLocaleString()} cached / ${(toolAccounting?.unpricedRequests ?? 0).toLocaleString()} unpriced`,
    '',
    '## Tool provider accounting',
    '',
    ...(toolAccounting?.byProviderOperation.length
      ? [
          '| Provider | Operation | Tool calls | Requests | Billable | Cached | Unpriced | Cost |',
          '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
          ...toolAccounting.byProviderOperation.map((row) => `| ${row.provider} | ${row.operation} | ${row.toolCalls.toLocaleString()} | ${row.requests.toLocaleString()} | ${row.billableRequests.toLocaleString()} | ${row.cachedToolCalls.toLocaleString()} | ${row.unpricedRequests.toLocaleString()} | ${formatCost(row.estimatedCostUSD)} |`),
        ]
      : ['No tool accounting payloads were available for this trace.']),
    '',
    '## Per-run efficiency and context',
    '',
    ...formatRunAnalysis(runAnalysis),
    '',
    '## Steps the agent took',
    '',
    ...(report.timeline.length > 0
      ? report.timeline.map((entry, index) => `${index + 1}. ${entry.toolName ?? entry.eventType ?? 'step'} - ${entry.outcome} - ${formatDuration(entry.durationMs)}`)
      : ['No tool-like timeline entries were found.']),
    '',
    '## Diagnostic findings',
    '',
    ...(findings.length > 0 ? findings.map((finding) => `- **${finding.severity}: ${finding.title}** - ${finding.summary}`) : ['- No failure, policy, or performance findings were derived from this trace.']),
    '',
    '## Top tools by duration',
    '',
    ...(topTools.length > 0 ? topTools.map((tool) => `- ${tool.toolName}: ${formatDuration(tool.durationMs.total)} across ${tool.started} calls`) : ['- No measured tool spans found.']),
    '',
    '## Warnings',
    '',
    ...(report.warnings.length > 0 ? report.warnings.map((warning) => `- ${warning}`) : ['- None']),
    '',
  ].join('\n');
}

function formatRunAnalysis(runs: NonNullable<TraceReport['diagnostics']>['analysis']['runs']): string[] {
  if (runs.length === 0) return ['_No per-run analysis was attached to this report._'];
  const executionRows = runs.map((run) => [
    run.runId,
    run.status ?? 'unknown',
    run.provider || run.model ? `${run.provider ?? 'unknown'}/${run.model ?? 'unknown'}` : 'unknown',
    formatDuration(run.durations.wallMs),
    formatDuration(run.durations.cumulativeMeasuredMs),
    formatRatio(run.durations.parallelism),
    `${run.modelCalls.logicalCalls}/${run.modelCalls.attempts}`,
    run.modelCalls.retries.toLocaleString(),
    formatRatio(run.modelCalls.retryAmplification),
    run.modelCalls.failures.toLocaleString(),
    `${run.toolCalls.starts}/${run.toolCalls.failures}`,
    formatPercentage(run.toolCalls.reductionPercentage),
    run.usage.combined.totalTokens.toLocaleString(),
    formatCost(run.costs.estimatedGrandTotalUSD),
  ]);
  const contextRows = runs.map((run) => [
    run.runId,
    `${run.contextGrowth.source}/${run.contextGrowth.samples}`,
    [run.contextGrowth.initialMessageBytes, run.contextGrowth.latestMessageBytes, run.contextGrowth.peakMessageBytes, run.contextGrowth.messageBytesGrowth].map(formatBytes).join(' / '),
    [run.contextGrowth.initialMessageCount, run.contextGrowth.latestMessageCount, run.contextGrowth.peakMessageCount, run.contextGrowth.messageCountGrowth].map((value) => value === null ? 'n/a' : value.toLocaleString()).join(' / '),
    run.directChildFanOut.toLocaleString(),
    formatDuration(run.cumulativeDirectChildWallMs),
    formatBytes(run.outputBytes),
    run.coverage.events.toLocaleString(),
    formatCoverage(run.coverage.performance),
    run.coverage.snapshots.toLocaleString(),
    formatCoverage(run.coverage.cost),
  ]);
  const notes = runs.flatMap((run) => run.notes.map((note) => `- **${escapeMarkdownCell(run.runId)}:** ${escapeMarkdownCell(note)}`));
  return [
    '### Execution efficiency',
    '',
    markdownTable(
      ['Run', 'Status', 'Provider/model', 'Wall', 'Measured', 'Parallelism', 'Model logical/attempts', 'Retries', 'Amplification', 'Model failures', 'Tools/failed', 'Output reduction', 'Tokens', 'Grand cost'],
      executionRows,
    ),
    '',
    '### Context growth and evidence coverage',
    '',
    markdownTable(
      ['Run', 'Context source/samples', 'Bytes initial/latest/peak/growth', 'Messages initial/latest/peak/growth', 'Children', 'Child wall', 'Output', 'Events', 'Performance', 'Snapshots', 'Provider cost'],
      contextRows,
    ),
    ...(notes.length > 0 ? ['', '### Data notes', '', ...notes] : []),
  ];
}

function markdownTable(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.map(escapeMarkdownCell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(escapeMarkdownCell).join(' | ')} |`),
  ].join('\n');
}

function escapeMarkdownCell(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('|', '\\|')
    .replace(/\r?\n/g, ' ');
}

function formatCoverage(value: number | null): string {
  return value === null ? 'n/a' : formatPercentage(value * 100);
}

function stringifyGoal(goal: unknown): string {
  if (goal === null || goal === undefined) return '_No goal persisted._';
  if (typeof goal === 'string') return goal;
  return `\`\`\`json\n${JSON.stringify(goal, null, 2)}\n\`\`\``;
}

function formatFinalOutputs(rootRuns: TraceReport['rootRuns']): string[] {
  const outputs = rootRuns.filter((rootRun) => rootRun.result !== null && rootRun.result !== undefined);
  if (outputs.length === 0) return ['_No final output was persisted for this trace._'];
  return outputs.flatMap((rootRun) => [
    outputs.length > 1 ? `### Run ${rootRun.rootRunId}` : '',
    stringifyResult(rootRun.result),
  ]).filter((line) => line !== '');
}

function stringifyResult(result: unknown): string {
  if (typeof result === 'string') return result;
  return `\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;
}
