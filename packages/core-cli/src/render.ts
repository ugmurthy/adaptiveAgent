import type { AgentEvent, AgentRun, JsonValue, RunResult } from '@adaptive-agent/core';

import type { LoadedAgentConfig } from './config.js';
import type { ResolvedLocalModules, RuntimeMode } from './local-modules.js';

export interface StartupSummary {
  loadedConfig: LoadedAgentConfig;
  modules: ResolvedLocalModules;
  workspaceRoot: string;
  runtimeMode: RuntimeMode;
  verbose?: boolean;
}

export function renderStartupSummary(summary: StartupSummary): string {
  const config = summary.loadedConfig.config;
  const lines = [
    `Agent config: ${summary.loadedConfig.path}`,
    `Agent: ${config.name} (${config.id})`,
    `Model: ${config.model.provider}/${config.model.model}`,
    `Workspace: ${summary.workspaceRoot}`,
    `Runtime: ${summary.runtimeMode}`,
    `Tools: ${formatNameList(summary.modules.tools.map((tool) => tool.name))}`,
    `Delegates: ${formatNameList(summary.modules.delegates.map((delegate) => delegate.name))}`,
  ];

  if (summary.verbose && config.routing) {
    lines.push('Verbose: ignoring gateway-only field "routing" in local CLI mode.');
  }

  return lines.join('\n');
}

export function renderConfigSummary(summary: StartupSummary): string {
  const config = summary.loadedConfig.config;
  return [
    `configPath: ${summary.loadedConfig.path}`,
    `id: ${config.id}`,
    `name: ${config.name}`,
    `invocationModes: ${config.invocationModes.join(', ')}`,
    `defaultInvocationMode: ${config.defaultInvocationMode}`,
    `model: ${config.model.provider}/${config.model.model}`,
    `workspaceRoot: ${summary.workspaceRoot}`,
    `runtime: ${summary.runtimeMode}`,
    `tools: ${formatNameList(summary.modules.tools.map((tool) => tool.name))}`,
    `delegates: ${formatNameList(summary.modules.delegates.map((delegate) => delegate.name))}`,
    `skillSearchDirs: ${formatNameList(summary.modules.skillSearchDirs)}`,
  ].join('\n');
}

export function renderRunResult(result: RunResult): string {
  switch (result.status) {
    case 'success':
      return formatJsonValue(result.output);
    case 'failure':
      return `Run ${result.runId} failed (${result.code}): ${result.error}`;
    case 'approval_requested':
      return `Run ${result.runId} requested approval for ${result.toolName}: ${result.message}`;
    case 'clarification_requested':
      return `Run ${result.runId} requested clarification: ${result.message}`;
  }
}

export function renderRunStatus(result: RunResult): string {
  switch (result.status) {
    case 'success':
      return `Run ${result.runId} succeeded in ${result.stepsUsed} step(s).`;
    case 'failure':
      return `Run ${result.runId} failed in ${result.stepsUsed} step(s).`;
    case 'approval_requested':
      return `Run ${result.runId} is awaiting approval.`;
    case 'clarification_requested':
      return `Run ${result.runId} is awaiting clarification.`;
  }
}

export function renderInspect(run: AgentRun, events: AgentEvent[]): string {
  const lines = [
    `Run: ${run.id}`,
    `Root run: ${run.rootRunId}`,
    `Status: ${run.status}`,
    `Goal: ${run.goal}`,
    `Steps: ${run.currentStepId ?? '(none)'}`,
    `Model: ${[run.modelProvider, run.modelName].filter(Boolean).join('/') || '(unknown)'}`,
    `Created: ${run.createdAt}`,
    `Updated: ${run.updatedAt}`,
  ];

  if (run.completedAt) lines.push(`Completed: ${run.completedAt}`);
  if (run.errorCode || run.errorMessage) lines.push(`Error: ${[run.errorCode, run.errorMessage].filter(Boolean).join(' - ')}`);
  if (run.result !== undefined) lines.push(`Result: ${formatJsonValue(run.result)}`);

  lines.push('', 'Events:');
  if (events.length === 0) {
    lines.push('(none)');
  } else {
    lines.push(...events.map((event) => renderEventLine(event)));
  }

  return lines.join('\n');
}

export function renderEventLine(event: AgentEvent): string {
  const prefix = `[${formatEventTime(event.createdAt)}] ${shortRunId(event.runId)} #${event.seq}`;
  const payload = asRecord(event.payload);

  switch (event.type) {
    case 'run.created':
      return `${prefix} run created`;
    case 'run.status_changed':
      return `${prefix} status ${readString(payload, 'fromStatus') ?? 'unknown'} -> ${readString(payload, 'toStatus') ?? 'unknown'}`;
    case 'run.completed':
      return `${prefix} run completed`;
    case 'run.failed':
      return `${prefix} run failed${readFailureText(payload) ? `: ${readFailureText(payload)}` : ''}`;
    case 'model.started':
      return `${prefix} model thinking ${[readString(payload, 'provider'), readString(payload, 'model')].filter(Boolean).join('/')}`.trim();
    case 'model.completed':
      return `${prefix} model completed${readString(payload, 'finishReason') ? ` finish=${readString(payload, 'finishReason')}` : ''}`;
    case 'model.retry': {
      const statusCode = readNumber(payload, 'statusCode');
      const retryDelayMs = readNumber(payload, 'retryDelayMs');
      const attempt = readNumber(payload, 'attempt');
      const nextAttempt = readNumber(payload, 'nextAttempt');
      return `${prefix} model retry${attempt !== undefined && nextAttempt !== undefined ? ` attempt=${attempt}->${nextAttempt}` : ''}${statusCode !== undefined ? ` status=${statusCode}` : ''}${retryDelayMs !== undefined ? ` delay=${retryDelayMs}ms` : ''}`;
    }
    case 'model.failed':
      return `${prefix} model failed${readFailureText(payload) ? `: ${readFailureText(payload)}` : ''}`;
    case 'tool.started':
      return formatToolLifecycle(prefix, payload ?? {}, 'started');
    case 'tool.completed':
      return formatToolLifecycle(prefix, payload ?? {}, 'completed');
    case 'tool.failed':
      return `${formatToolLifecycle(prefix, payload ?? {}, 'failed')}${readFailureText(payload) ? `: ${readFailureText(payload)}` : ''}`;
    case 'delegate.spawned':
      return `${prefix} delegate.${readString(payload, 'delegateName') ?? 'unknown'} spawned ${readString(payload, 'childRunId') ?? 'child run'}`;
    case 'approval.requested':
      return `${prefix} approval requested for ${readString(payload, 'toolName') ?? 'unknown'}`;
    case 'approval.resolved':
      return `${prefix} approval ${payload?.approved === true ? 'approved' : 'rejected'}${readString(payload, 'toolName') ? ` for ${readString(payload, 'toolName')}` : ''}`;
    case 'clarification.requested':
      return `${prefix} clarification requested${readString(payload, 'message') ? `: ${oneLine(readString(payload, 'message')!)}` : ''}`;
    case 'snapshot.created':
      return `${prefix} snapshot created${readString(payload, 'status') ? ` (${readString(payload, 'status')})` : ''}`;
    case 'replan.required':
      return `${prefix} replan required${readString(payload, 'reason') ? `: ${readString(payload, 'reason')}` : ''}`;
    default:
      return `${prefix} ${event.type}`;
  }
}

export function formatJsonValue(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function formatToolLifecycle(prefix: string, payload: Record<string, unknown>, status: string): string {
  const toolName = readString(payload, 'toolName') ?? 'unknown';
  const input = asRecord(parseMaybeJson(payload.input));
  const detail = input ? formatToolInputSummary(toolName, input) : undefined;
  return `${prefix} tool ${toolName}${detail ? ` ${detail}` : ''} ${status}`;
}

function formatToolInputSummary(toolName: string, input: Record<string, unknown>): string | undefined {
  if (toolName === 'read_file' || toolName === 'list_directory' || toolName === 'write_file') {
    return formatScalarField(input, 'path');
  }

  if (toolName === 'shell_exec') {
    return formatScalarField(input, 'command', 'cmd');
  }

  if (toolName === 'web_search') {
    return formatScalarField(input, 'query', 'q');
  }

  if (toolName === 'read_web_page') {
    return formatScalarField(input, 'url');
  }

  if (toolName.startsWith('delegate.')) {
    return formatScalarField(input, 'goal');
  }

  return undefined;
}

function formatScalarField(input: Record<string, unknown>, key: string, label = key): string | undefined {
  const value = input[key];
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return undefined;
  }

  return `${label}=${JSON.stringify(String(value).slice(0, 110))}`;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function readString(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === 'string' ? field : undefined;
}

function readNumber(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const field = value?.[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
}

function readFailureText(payload: Record<string, unknown> | undefined): string | undefined {
  return oneLine(readString(payload, 'error') ?? readString(payload, 'message') ?? readString(payload, 'errorMessage') ?? '');
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function formatEventTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '--:--:--';
  }

  return date.toISOString().slice(11, 19);
}

function shortRunId(value: string): string {
  return value.length > 8 ? `run:${value.slice(0, 8)}` : `run:${value}`;
}

function formatNameList(values: string[]): string {
  return values.length > 0 ? values.join(', ') : '(none)';
}
