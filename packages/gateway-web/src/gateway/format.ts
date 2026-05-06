import type { AgentEventFrame } from './protocol';

import type { ClarificationRequestOutput, LiveAgentEventSummary } from './types';

export function summarizeAgentEvent(frame: AgentEventFrame): LiveAgentEventSummary {
  const payload = asRecord(frame.data);
  const status = readString(payload, 'toStatus') ?? readString(payload, 'status');
  const toolName = readString(payload, 'toolName') ?? readString(payload, 'name');
  const assistantContent = readString(payload, 'assistantContent');
  const detail = readString(payload, 'message') ?? readString(payload, 'reason') ?? readString(payload, 'error');

  return {
    eventType: frame.eventType,
    compactText: formatCompactAgentEventFrame(frame),
    runId: frame.runId,
    rootRunId: frame.rootRunId,
    seq: frame.seq,
    status,
    toolName,
    input: payload.input,
    assistantContent,
    detail,
    timestamp: frame.createdAt ? new Date(frame.createdAt) : new Date(),
  };
}

export function formatCompactAgentEventFrame(frame: AgentEventFrame): string {
  const payload = asRecord(frame.data);

  switch (frame.eventType) {
    case 'model.started': {
      const provider = readString(payload, 'provider');
      const model = readString(payload, 'model');
      const timeoutMs = readNumber(payload, 'modelTimeoutMs');
      const target = [provider, model].filter((part): part is string => Boolean(part)).join('/');
      const timeoutPart = timeoutMs !== undefined ? ` (timeout ${formatDuration(timeoutMs)})` : '';
      return `model thinking${target ? ` ${target}` : ''}${timeoutPart}`;
    }
    case 'model.completed': {
      const durationMs = readNumber(payload, 'durationMs');
      const finishReason = readString(payload, 'finishReason');
      const toolCallCount = readNumber(payload, 'toolCallCount');
      const parts: string[] = [];
      if (durationMs !== undefined) parts.push(formatDuration(durationMs));
      if (finishReason) parts.push(`finish=${finishReason}`);
      if (toolCallCount !== undefined && toolCallCount > 0) parts.push(`toolCalls=${toolCallCount}`);
      return `model completed${parts.length > 0 ? ` (${parts.join(', ')})` : ''}`;
    }
    case 'model.retry': {
      const statusCode = readNumber(payload, 'statusCode');
      const attempt = readNumber(payload, 'attempt');
      const nextAttempt = readNumber(payload, 'nextAttempt');
      const retryDelayMs = readNumber(payload, 'retryDelayMs');
      const parts: string[] = [];
      if (attempt !== undefined && nextAttempt !== undefined) parts.push(`attempt ${attempt}->${nextAttempt}`);
      if (statusCode !== undefined) parts.push(`status=${statusCode}`);
      if (retryDelayMs !== undefined) parts.push(`delay=${formatDuration(retryDelayMs)}`);
      return `model retry${parts.length > 0 ? ` (${parts.join(', ')})` : ''}`;
    }
    case 'model.failed': {
      const durationMs = readNumber(payload, 'durationMs');
      const timedOut = payload.timedOut === true;
      const error =
        readString(asRecord(payload.error), 'message') ??
        readString(payload, 'error') ??
        readString(payload, 'reason') ??
        readString(payload, 'message');
      const parts: string[] = [];
      if (durationMs !== undefined) parts.push(formatDuration(durationMs));
      if (timedOut) parts.push('timed out');
      const detail = error ? `: ${truncate(oneLine(error), 110)}` : '';
      return `model failed${parts.length > 0 ? ` (${parts.join(', ')})` : ''}${detail}`;
    }
  }

  const pieces = [frame.eventType];
  const status = readString(payload, 'toStatus') ?? readString(payload, 'status');
  const toolName = readString(payload, 'toolName') ?? readString(payload, 'name');
  const durationMs = readNumber(payload, 'durationMs');

  if (frame.seq !== undefined) {
    pieces.push(`#${frame.seq}`);
  }
  if (frame.runId) {
    pieces.push(`run:${shortId(frame.runId)}`);
  }
  if (status) {
    pieces.push(status);
  }
  if (toolName) {
    pieces.push(toolName);
  }
  if (durationMs !== undefined) {
    pieces.push(formatDuration(durationMs));
  }

  return pieces.join(' · ');
}

export function formatRunOutput(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }

  if (output === undefined || output === null) {
    return '';
  }

  return JSON.stringify(output, null, 2);
}

export function isClarificationRequestOutput(value: unknown): value is ClarificationRequestOutput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const candidate = value as { status?: unknown; message?: unknown; suggestedQuestions?: unknown };
  return (
    candidate.status === 'clarification_requested' &&
    typeof candidate.message === 'string' &&
    Array.isArray(candidate.suggestedQuestions) &&
    candidate.suggestedQuestions.every((entry) => typeof entry === 'string')
  );
}

export function shortId(value: string | undefined): string {
  if (!value) {
    return 'none';
  }

  return value.length <= 10 ? value : value.slice(0, 8);
}

export function formatClockTime(value: Date): string {
  return value.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return `${ms}ms`;
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }

  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m${remainingSeconds}s`;
}

export function eventTone(eventType: string): 'good' | 'warn' | 'bad' | 'work' {
  if (eventType.includes('failed') || eventType.includes('error')) {
    return 'bad';
  }
  if (eventType === 'model.retry' || eventType === 'replan.required' || eventType.includes('approval') || eventType.includes('clarification')) {
    return 'warn';
  }
  if (eventType.includes('completed') || eventType.includes('succeeded') || eventType.includes('resolved')) {
    return 'good';
  }
  return 'work';
}

export function formatLiveProgressUpdate(frame: AgentEventFrame): string | undefined {
  const payload = asRecord(frame.data);

  switch (frame.eventType) {
    case 'run.created':
      return 'Started the run.';
    case 'run.status_changed': {
      const toStatus = readString(payload, 'toStatus');
      if (!toStatus || toStatus === 'running') {
        return undefined;
      }
      return `Status changed to \`${toStatus}\`.`;
    }
    case 'run.interrupted':
      return 'The run was interrupted.';
    case 'run.resumed':
      return 'Resumed the run.';
    case 'run.retry_started':
      return 'Retrying the run.';
    case 'plan.created':
      return 'Built a plan for this run.';
    case 'plan.execution_started':
      return 'Working through the plan.';
    case 'model.started': {
      const provider = readString(payload, 'provider');
      const model = readString(payload, 'model');
      const timeoutMs = readNumber(payload, 'modelTimeoutMs');
      const target = [provider, model].filter((part): part is string => Boolean(part)).join('/');
      const timeoutPart = timeoutMs !== undefined ? ` (timeout ${formatDuration(timeoutMs)})` : '';
      return target ? `Thinking with \`${target}\`${timeoutPart}.` : `Thinking${timeoutPart}.`;
    }
    case 'model.completed': {
      const durationMs = readNumber(payload, 'durationMs');
      const finishReason = readString(payload, 'finishReason');
      const toolCallCount = readNumber(payload, 'toolCallCount');
      const detailParts: string[] = [];
      if (durationMs !== undefined) detailParts.push(formatDuration(durationMs));
      if (finishReason) detailParts.push(`finish=${finishReason}`);
      if (toolCallCount !== undefined && toolCallCount > 0) detailParts.push(`toolCalls=${toolCallCount}`);
      return detailParts.length > 0 ? `Model completed (${detailParts.join(', ')}).` : 'Model completed.';
    }
    case 'model.retry': {
      const statusCode = readNumber(payload, 'statusCode');
      const attempt = readNumber(payload, 'attempt');
      const nextAttempt = readNumber(payload, 'nextAttempt');
      const retryDelayMs = readNumber(payload, 'retryDelayMs');
      const detailParts: string[] = [];
      if (attempt !== undefined && nextAttempt !== undefined) detailParts.push(`attempt ${attempt}->${nextAttempt}`);
      if (statusCode !== undefined) detailParts.push(`status=${statusCode}`);
      if (retryDelayMs !== undefined) detailParts.push(`delay=${formatDuration(retryDelayMs)}`);
      return detailParts.length > 0 ? `Model retrying (${detailParts.join(', ')}).` : 'Model retrying.';
    }
    case 'model.failed': {
      const durationMs = readNumber(payload, 'durationMs');
      const timedOut = payload.timedOut === true;
      const error =
        readString(asRecord(payload.error), 'message') ??
        readString(payload, 'error') ??
        readString(payload, 'reason') ??
        readString(payload, 'message');
      const detailParts: string[] = [];
      if (durationMs !== undefined) detailParts.push(formatDuration(durationMs));
      if (timedOut) detailParts.push('timed out');
      const head = detailParts.length > 0 ? `Model failed (${detailParts.join(', ')})` : 'Model failed';
      return error ? `${head}: ${oneLine(error)}.` : `${head}.`;
    }
    case 'tool.started': {
      const toolName = readString(payload, 'toolName') ?? 'tool';
      const detail = formatToolProgressDetail(toolName, payload.input);
      return detail ? `Running \`${toolName}\` with ${detail}.` : `Running \`${toolName}\`.`;
    }
    case 'tool.completed': {
      const toolName = readString(payload, 'toolName') ?? 'tool';
      const detail = formatToolProgressDetail(toolName, payload.input);
      return detail ? `Finished \`${toolName}\` with ${detail}.` : `Finished \`${toolName}\`.`;
    }
    case 'tool.failed': {
      const toolName = readString(payload, 'toolName') ?? 'tool';
      const error = readString(payload, 'error') ?? readString(payload, 'message') ?? 'The tool failed.';
      return `\`${toolName}\` failed: ${oneLine(error)}.`;
    }
    case 'delegate.spawned': {
      const delegateName = readString(payload, 'delegateName');
      return delegateName ? `Delegating to \`${delegateName}\`.` : 'Delegating to a child run.';
    }
    case 'approval.requested': {
      const toolName = readString(payload, 'toolName') ?? 'a tool';
      const detail = formatToolProgressDetail(toolName, payload.input);
      return detail
        ? `Waiting for approval to run \`${toolName}\` with ${detail}.`
        : `Waiting for approval to run \`${toolName}\`.`;
    }
    case 'approval.resolved': {
      const toolName = readString(payload, 'toolName');
      const approved = payload.approved === true ? 'Approval received' : payload.approved === false ? 'Approval rejected' : 'Approval resolved';
      return toolName ? `${approved} for \`${toolName}\`.` : `${approved}.`;
    }
    case 'clarification.requested': {
      const message = readString(payload, 'message');
      return message ? `Need clarification: ${oneLine(message)}` : 'Need clarification before continuing.';
    }
    case 'replan.required': {
      const reason = readString(payload, 'reason') ?? readString(payload, 'replanReason');
      return reason ? `Need to replan: ${oneLine(reason)}` : 'Need to replan before continuing.';
    }
    default:
      return undefined;
  }
}

export function formatToolProgressDetail(toolName: string, value: unknown): string | undefined {
  const input = unwrapSummaryRecord(parseMaybeJson(value));
  if (!input) {
    return undefined;
  }

  if (toolName === 'read_file' || toolName === 'list_directory' || toolName === 'write_file') {
    return formatPathBasename(input.path);
  }

  if (toolName === 'shell_exec') {
    return formatUnlabeledScalar(input.command, 110);
  }

  if (toolName === 'web_search') {
    const domain = formatUrlDomain(input.query ?? input.q);
    if (domain) {
      return domain;
    }

    const query = formatUnlabeledScalar(input.query ?? input.q, 90);
    return query ? JSON.stringify(query) : undefined;
  }

  if (toolName === 'read_web_page') {
    return formatUrlDomain(input.url);
  }

  if (toolName.startsWith('delegate.')) {
    const task = formatUnlabeledScalar(input.goal ?? input.task ?? input.prompt ?? input.input, 90);
    return task ? JSON.stringify(task) : undefined;
  }

  if (toolName === 'e2b_run_code') {
    const code = formatUnlabeledScalar(input.code, 90);
    return code ? JSON.stringify(code) : undefined;
  }

  return formatGenericToolProgressDetail(input);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function formatGenericToolProgressDetail(input: Record<string, unknown>): string | undefined {
  const url = findUrlDomain(input);
  if (url) {
    return url;
  }

  const path = formatPathBasename(input.path ?? input.file ?? input.filename ?? input.sourcePath ?? input.savePath);
  if (path) {
    return path;
  }

  const command = formatUnlabeledScalar(input.command ?? input.cmd, 110);
  if (command) {
    return command;
  }

  const query = formatUnlabeledScalar(input.query ?? input.q ?? input.goal ?? input.task ?? input.prompt, 90);
  if (query) {
    return JSON.stringify(query);
  }

  for (const value of Object.values(input)) {
    const scalar = formatUnlabeledScalar(value, 84);
    if (scalar) {
      return scalar;
    }
  }

  return undefined;
}

function findUrlDomain(input: Record<string, unknown>): string | undefined {
  for (const key of ['url', 'uri', 'href', 'link']) {
    const domain = formatUrlDomain(input[key]);
    if (domain) {
      return domain;
    }
  }

  for (const value of Object.values(input)) {
    const domain = formatUrlDomain(value);
    if (domain) {
      return domain;
    }
  }

  return undefined;
}

function formatUrlDomain(value: unknown): string | undefined {
  const scalar = scalarToString(value);
  if (!scalar) {
    return undefined;
  }

  const match = scalar.match(/https?:\/\/[^\s)]+/);
  const candidate = (match?.[0] ?? scalar).replace(/[.,;]+$/, '');

  try {
    const parsed = new URL(candidate);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

function formatPathBasename(value: unknown): string | undefined {
  const scalar = scalarToString(value);
  if (!scalar) {
    return undefined;
  }

  const trimmed = scalar.replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).pop() || trimmed;
}

function formatUnlabeledScalar(value: unknown, maxLength: number): string | undefined {
  const scalar = scalarToString(value);
  return scalar === undefined ? undefined : truncate(scalar, maxLength);
}

function scalarToString(value: unknown): string | undefined {
  const unwrapped = unwrapSummaryValue(value);
  if (typeof unwrapped === 'string') {
    return oneLine(unwrapped);
  }
  if (typeof unwrapped === 'number' || typeof unwrapped === 'boolean') {
    return String(unwrapped);
  }
  return undefined;
}

function unwrapSummaryRecord(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (record.type === 'object') {
    const preview = asRecord(record.preview);
    return Object.keys(preview).length > 0 ? preview : undefined;
  }
  return Object.keys(record).length > 0 ? record : undefined;
}

function unwrapSummaryValue(value: unknown): unknown {
  const record = asRecord(value);
  if (record.type === 'string') {
    return readString(record, 'preview') ?? readNumber(record, 'length')?.toString();
  }
  return value;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return value;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}...`;
}
