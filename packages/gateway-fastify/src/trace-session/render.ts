import chalk from 'chalk';
import { marked } from 'marked';
import TerminalRenderer from 'marked-terminal';

import { shortId } from './report.js';
import { DEFAULT_MESSAGE_PREVIEW_CHARS } from './constants.js';
import type {
  CliOptions,
  DelegateRow,
  MessageView,
  MilestoneEntry,
  PlanRow,
  ReportView,
  RootRun,
  RunMessageTrace,
  SessionListItem,
  SessionOverview,
  SessionUsageSummary,
  SessionlessRunListItem,
  TimelineEntry,
  TraceMessage,
  TraceMessageRole,
  TraceReport,
  UsageSummary,
} from './types.js';

marked.setOptions({
  renderer: new TerminalRenderer({
    code: chalk.gray,
    codespan: chalk.cyan,
    heading: chalk.bold,
  }) as never,
});

export function renderTraceReport(
  report: TraceReport,
  options: Pick<CliOptions, 'json' | 'includePlans' | 'onlyDelegates' | 'messages' | 'systemOnly'>
    & Partial<Pick<CliOptions, 'view' | 'messagesView' | 'previewChars'>>,
): string {
  if (options.json) {
    return JSON.stringify(report, null, 2);
  }

  const effectiveView = resolveReportView(options);
  const messageView = options.messagesView ?? 'compact';
  const previewChars = options.previewChars ?? DEFAULT_MESSAGE_PREVIEW_CHARS;
  const milestones = report.milestones ?? [];

  const lines: string[] = [];
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

  if (shouldRenderSection(effectiveView, 'milestones')) {
    lines.push('');
    lines.push(markdownBlock('# Milestones'));
    lines.push(renderMilestones(milestones));
  }

  if (shouldRenderSection(effectiveView, 'timeline')) {
    lines.push('');
    lines.push(markdownBlock(`# ${formatTimelineTitle(report.timeline, report.session)}`));
    lines.push(renderTimeline(report.timeline));
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
    lines.push(renderPlans(report.plans));
  }

  if (shouldRenderFinalOutput(effectiveView)) {
    lines.push('');
    lines.push(markdownBlock('# Final Output'));
    lines.push(renderFinalOutput(report.rootRuns));
  }

  return lines.join('\n');
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
      const lines = [`---- ${session.sessionId} : ${statusColor(sessionStatus)(sessionStatus)} : ${session.startedAt} ----`];
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
        const details = [run.runId === run.rootRunId ? run.runId : `${run.runId} root=${run.rootRunId}`];
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
  const deletableSessions = sessions.filter((session) => session.goals.length === 0 || session.goals.every((goal) => normalizeGoal(goal.goal) === null));

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

export function renderUsageReport(usage: SessionUsageSummary, options: Pick<CliOptions, 'json'>): string {
  if (options.json) {
    return JSON.stringify(usage, null, 2);
  }

  const lines = [formatUsageSummary(usage.total)];
  if (usage.byRootRun.length > 0) {
    lines.push('');
    for (const item of usage.byRootRun) {
      lines.push(`${item.rootRunId} : ${formatUsageSummary(item.usage)}`);
    }
  }
  return lines.join('\n');
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
      lines.push(`${chalk.magenta('session')} ${chalk.red('not found')}`);
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
  lines.push(renderUsage(report.usage));
  lines.push('');
  lines.push(markdownBlock('# Root Runs'));
  if (report.rootRuns.length === 0) {
    lines.push(chalk.gray('No root runs were found.'));
  } else {
    for (const run of report.rootRuns) {
      const parts = [run.rootRunId, statusColor(run.status ?? 'unknown')(run.status ?? 'unknown')];
      if (run.runId !== run.rootRunId) {
        parts.push(`linkedRun=${run.runId}`);
      }
      lines.push(`- ${parts.join('  ')}`);
    }
  }
  return lines.join('\n');
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

function renderUsage(usage: SessionUsageSummary): string {
  const lines = [`${chalk.cyan('usage')} ${formatUsageSummary(usage.total)}`];
  if (usage.byRootRun.length > 1) {
    for (const item of usage.byRootRun) {
      lines.push(`  ${chalk.green(item.rootRunId)} ${formatUsageSummary(item.usage)}`);
    }
  }
  return lines.join('\n');
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
  parts.push(`cost=$${usage.estimatedCostUSD.toFixed(6)}`);
  return parts.join('  ');
}

function renderTimeline(entries: TimelineEntry[]): string {
  if (entries.length === 0) {
    return chalk.gray('No migrated tool timeline rows were found.');
  }

  const rows = entries.map((entry) => [
    formatTimeOfDay(entry.startedAt),
    formatDuration(entry.durationMs),
    `${shortId(entry.rootRunId)}/${shortId(entry.runId)} d${entry.depth}`,
    entry.stepId ?? '-',
    toolColor(entry.toolName)(entry.toolName ?? entry.eventType ?? 'tool'),
    compactValue(entry.params ?? entry.output),
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

function renderPlans(plans: PlanRow[]): string {
  if (plans.length === 0) {
    return chalk.gray('No plan rows were found.');
  }
  const rows = plans.map((plan) => [
    shortId(plan.run_id),
    plan.plan_execution_id ? shortId(plan.plan_execution_id) : '-',
    statusColor(plan.plan_execution_status ?? 'unknown')(plan.plan_execution_status ?? 'unknown'),
    plan.step_index === null ? '-' : String(plan.step_index),
    plan.title ?? plan.step_key ?? '-',
    plan.tool_name ?? '-',
    plan.replan_reason ?? '-',
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
      if (message.category === 'runtime-injected-system') {
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
    && JSON.stringify(left.toolCalls ?? []) === JSON.stringify(right.toolCalls ?? []);
}

function resolveReportView(options: Pick<CliOptions, 'onlyDelegates'> & Partial<Pick<CliOptions, 'view'>>): ReportView {
  if (options.view) {
    return options.view;
  }
  if (options.onlyDelegates) {
    return 'delegates';
  }
  return 'all';
}

function shouldRenderSection(view: ReportView, section: Exclude<ReportView, 'overview' | 'all'>): boolean {
  return view === 'all' || view === section;
}

function shouldRenderFinalOutput(view: ReportView): boolean {
  return view === 'all' || view === 'overview';
}

function renderTable(headers: string[], rows: string[][], options?: { maxWidths?: number[] }): string {
  const widths = headers.map((header, index) =>
    Math.min(
      Math.max(
        header.length,
        ...rows.map((row) => stripAnsi(row[index] ?? '').length),
      ),
      options?.maxWidths?.[index] ?? (index === headers.length - 1 ? 80 : 36),
    ),
  );
  const line = (cells: string[]): string =>
    cells
      .map((cell, index) => padAnsi(truncateAnsi(cell, widths[index]!), widths[index]!))
      .join('  ');

  return [line(headers.map((header) => chalk.bold(header))), line(widths.map((width) => '-'.repeat(width))), ...rows.map(line)].join('\n');
}

function statusColor(status: string): (value: string) => string {
  if (['succeeded', 'returned successfully'].includes(status)) {
    return chalk.green;
  }
  if (status.includes('failed') || status === 'failed') {
    return chalk.red;
  }
  if (status.includes('blocked') || status.includes('waiting') || status.includes('awaiting') || status === 'running') {
    return chalk.yellow;
  }
  return chalk.white;
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

function compactValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '-';
  }
  if (typeof value === 'string') {
    return markdownInline(value);
  }
  return markdownInline(`\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``).replace(/\s+/g, ' ').trim();
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

function truncatePlain(value: string, width: number): string {
  return value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function truncateAnsi(value: string, width: number): string {
  const plain = stripAnsi(value);
  if (plain.length <= width) {
    return value;
  }
  const prefix = value.match(/^(?:\u001b\[[0-9;]*m)+/)?.[0] ?? '';
  const truncated = `${plain.slice(0, Math.max(0, width - 1))}…`;
  return prefix ? `${prefix}${truncated}\u001b[0m` : truncated;
}

function padAnsi(value: string, width: number): string {
  return value + ' '.repeat(Math.max(0, width - stripAnsi(value).length));
}
