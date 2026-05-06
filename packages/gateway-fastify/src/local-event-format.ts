import type { AgentEventFrame } from './protocol.js';

const MAX_TOOL_DETAIL_LENGTH = 110;

const ASSISTANT_CONTENT_GATING_EVENT_TYPES = new Set([
  'tool.started',
  'approval.requested',
  'delegate.spawned',
]);

/**
 * Returns the trimmed `assistantContent` carried by the agent event when it
 * represents a model turn that produced text immediately before invoking a
 * tool, requesting approval, or spawning a delegate. Returns `undefined` for
 * other event types or when no assistant content is present.
 */
export function extractAssistantContentForEvent(frame: AgentEventFrame): string | undefined {
  if (!ASSISTANT_CONTENT_GATING_EVENT_TYPES.has(frame.eventType)) {
    return undefined;
  }
  const payload = asRecord(frame.data);
  const content = readString(payload, 'assistantContent');
  if (!content) {
    return undefined;
  }
  const trimmed = content.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function formatCompactAgentEventFrame(
  frame: AgentEventFrame,
  options: { includeSeq?: boolean; prefixStyle?: 'time-seq' | 'seq' } = {},
): string {
  const payload = asRecord(frame.data);
  const runPrefix = frame.runId ? shortRunId(frame.runId) : 'run:unknown';
  const seq = frame.seq ?? '?';
  const time = frame.createdAt ? formatEventTime(frame.createdAt) : '--:--:--';
  const prefix =
    options.includeSeq === false
      ? runPrefix
      : options.prefixStyle === 'seq'
        ? `[${seq}] ${runPrefix}`
        : frame.createdAt
        ? `[${time}] ${runPrefix} #${seq}`
        : `[${seq}] ${runPrefix}`;

  switch (frame.eventType) {
    case 'run.created':
      return `${prefix} run created`;
    case 'run.status_changed': {
      const fromStatus = readString(payload, 'fromStatus') ?? 'unknown';
      const toStatus = readString(payload, 'toStatus') ?? 'unknown';
      return `${prefix} status ${fromStatus} -> ${toStatus}`;
    }
    case 'run.interrupted':
      return `${prefix} run interrupted`;
    case 'run.resumed':
      return `${prefix} run resumed`;
    case 'run.retry_started':
      return `${prefix} retry started`;
    case 'run.completed':
      return `${prefix} run completed`;
    case 'run.failed': {
      const error = readFailureText(payload);
      return `${prefix} run failed${error ? `: ${oneLine(error)}` : ''}`;
    }
    case 'plan.created':
      return `${prefix} plan created`;
    case 'plan.execution_started':
      return `${prefix} plan execution started`;
    case 'step.started':
      return `${prefix} step ${frame.stepId ?? readString(payload, 'stepId') ?? 'unknown'} started`;
    case 'step.completed':
      return `${prefix} step ${frame.stepId ?? readString(payload, 'stepId') ?? 'unknown'} completed`;
    case 'model.started': {
      const provider = readString(payload, 'provider');
      const model = readString(payload, 'model');
      const timeoutMs = readNumber(payload, 'modelTimeoutMs');
      const target = [provider, model].filter((part): part is string => Boolean(part)).join('/');
      const timeoutPart = timeoutMs !== undefined ? ` (timeout ${formatDurationMs(timeoutMs)})` : '';
      return `${prefix} model thinking${target ? ` ${target}` : ''}${timeoutPart}`;
    }
    case 'model.completed': {
      const durationMs = readNumber(payload, 'durationMs');
      const finishReason = readString(payload, 'finishReason');
      const toolCallCount = readNumber(payload, 'toolCallCount');
      const parts: string[] = [];
      if (durationMs !== undefined) parts.push(formatDurationMs(durationMs));
      if (finishReason) parts.push(`finish=${finishReason}`);
      if (toolCallCount !== undefined && toolCallCount > 0) parts.push(`toolCalls=${toolCallCount}`);
      return `${prefix} model completed${parts.length > 0 ? ` (${parts.join(', ')})` : ''}`;
    }
    case 'model.retry': {
      const statusCode = readNumber(payload, 'statusCode');
      const attempt = readNumber(payload, 'attempt');
      const nextAttempt = readNumber(payload, 'nextAttempt');
      const retryDelayMs = readNumber(payload, 'retryDelayMs');
      const reason = readString(payload, 'reason');
      const parts: string[] = [];
      if (attempt !== undefined && nextAttempt !== undefined) parts.push(`attempt ${attempt}->${nextAttempt}`);
      if (statusCode !== undefined) parts.push(`status=${statusCode}`);
      if (retryDelayMs !== undefined) parts.push(`delay=${formatDurationMs(retryDelayMs)}`);
      if (reason) parts.push(`reason=${reason}`);
      return `${prefix} model retry${parts.length > 0 ? ` (${parts.join(', ')})` : ''}`;
    }
    case 'model.failed': {
      const durationMs = readNumber(payload, 'durationMs');
      const timedOut = payload.timedOut === true;
      const error = readFailureText(payload);
      const parts: string[] = [];
      if (durationMs !== undefined) parts.push(formatDurationMs(durationMs));
      if (timedOut) parts.push('timed out');
      const detail = error ? `: ${truncate(oneLine(error), MAX_TOOL_DETAIL_LENGTH)}` : '';
      return `${prefix} model failed${parts.length > 0 ? ` (${parts.join(', ')})` : ''}${detail}`;
    }
    case 'tool.started':
      return formatToolLifecycle(prefix, payload, 'started');
    case 'tool.completed':
      return formatToolLifecycle(prefix, payload, 'completed');
    case 'tool.failed': {
      const error = readFailureText(payload);
      return `${formatToolLifecycle(prefix, payload, 'failed')}${error ? `: ${truncate(oneLine(error), MAX_TOOL_DETAIL_LENGTH)}` : ''}`;
    }
    case 'delegate.spawned': {
      const delegateName = readString(payload, 'delegateName') ?? 'unknown';
      const childRunId = readString(payload, 'childRunId');
      return `${prefix} delegate.${delegateName} spawned ${childRunId ? shortRunId(childRunId) : 'child run'}`;
    }
    case 'approval.requested': {
      const toolName = readString(payload, 'toolName') ?? 'unknown';
      const detail = formatToolInputSummary(toolName, payload.input);
      return `${prefix} approval requested for ${toolName}${detail ? ` ${detail}` : ''}`;
    }
    case 'approval.resolved': {
      const toolName = readString(payload, 'toolName');
      const approved = payload.approved === true ? 'approved' : payload.approved === false ? 'rejected' : 'resolved';
      return `${prefix} approval ${approved}${toolName ? ` for ${toolName}` : ''}`;
    }
    case 'clarification.requested': {
      const message = readString(payload, 'message');
      return `${prefix} clarification requested${message ? `: ${oneLine(message)}` : ''}`;
    }
    case 'usage.updated': {
      const usage = asRecord(payload.usage);
      const promptTokens = readNumber(usage, 'promptTokens');
      const completionTokens = readNumber(usage, 'completionTokens');
      const totalTokens = readNumber(usage, 'totalTokens');
      const parts = [
        promptTokens === undefined ? undefined : `prompt=${promptTokens}`,
        completionTokens === undefined ? undefined : `completion=${completionTokens}`,
        totalTokens === undefined ? undefined : `total=${totalTokens}`,
      ].filter((part): part is string => part !== undefined);
      return `${prefix} usage updated${parts.length > 0 ? ` (${parts.join(', ')})` : ''}`;
    }
    case 'snapshot.created': {
      const status = readString(payload, 'status');
      return `${prefix} snapshot created${status ? ` (${status})` : ''}`;
    }
    case 'replan.required': {
      const reason = readString(payload, 'reason') ?? readString(payload, 'replanReason');
      return `${prefix} replan required${reason ? `: ${oneLine(reason)}` : ''}`;
    }
    default:
      return `${prefix} ${frame.eventType}`;
  }
}

function formatToolLifecycle(prefix: string, payload: Record<string, unknown>, status: string): string {
  const toolName = readString(payload, 'toolName') ?? 'unknown';
  const detail = formatToolInputSummary(toolName, payload.input);
  return `${prefix} tool ${toolName}${detail ? ` ${detail}` : ''} ${status}`;
}

function formatToolInputSummary(toolName: string, value: unknown): string | undefined {
  const input = unwrapSummaryRecord(parseMaybeJson(value));
  if (!input) {
    return undefined;
  }

  const toolSpecific = formatKnownToolInput(toolName, input);
  if (toolSpecific) {
    return truncate(toolSpecific, MAX_TOOL_DETAIL_LENGTH);
  }

  const generic = formatGenericToolInput(input);
  return generic ? truncate(generic, MAX_TOOL_DETAIL_LENGTH) : undefined;
}

function formatKnownToolInput(toolName: string, input: Record<string, unknown>): string | undefined {
  if (toolName === 'read_file' || toolName === 'list_directory') {
    return formatScalarField(input, 'path');
  }

  if (toolName === 'write_file') {
    return joinParts([formatScalarField(input, 'path'), formatContentSummary(input.content)]);
  }

  if (toolName === 'shell_exec') {
    return joinParts([formatScalarField(input, 'command', 'cmd', true), formatScalarField(input, 'cwd')]);
  }

  if (toolName === 'web_search') {
    return joinParts([formatScalarField(input, 'query', 'q', true), formatScalarField(input, 'maxResults', 'max')]);
  }

  if (toolName === 'read_web_page') {
    return formatScalarField(input, 'url');
  }

  if (toolName.startsWith('delegate.')) {
    return (
      formatScalarField(input, 'goal', undefined, true) ??
      formatScalarField(input, 'task', undefined, true) ??
      formatScalarField(input, 'prompt', undefined, true) ??
      formatScalarField(input, 'input', undefined, true)
    );
  }

  return undefined;
}

function formatGenericToolInput(input: Record<string, unknown>): string | undefined {
  const preferred = ['path', 'url', 'query', 'command', 'name', 'id', 'title', 'goal', 'task'];
  const parts: string[] = [];
  const seen = new Set<string>();

  for (const key of preferred) {
    const part = formatScalarField(input, key, key === 'query' ? 'q' : key, key === 'query' || key === 'goal' || key === 'task');
    if (part) {
      parts.push(part);
      seen.add(key);
    }
    if (parts.length >= 2) {
      return joinParts(parts);
    }
  }

  for (const [key, value] of Object.entries(input)) {
    if (seen.has(key) || key === 'content') {
      continue;
    }
    const scalar = scalarToString(value);
    if (scalar !== undefined) {
      parts.push(`${key}=${formatScalarValue(scalar, false)}`);
    }
    if (parts.length >= 2) {
      break;
    }
  }

  return joinParts(parts);
}

function formatScalarField(
  input: Record<string, unknown>,
  key: string,
  label = key,
  quote = false,
): string | undefined {
  const scalar = scalarToString(input[key]);
  return scalar === undefined ? undefined : `${label}=${formatScalarValue(scalar, quote)}`;
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

function formatScalarValue(value: string, quote: boolean): string {
  const truncated = truncate(value, quote ? 70 : 84);
  return quote ? JSON.stringify(truncated) : truncated;
}

function formatContentSummary(value: unknown): string | undefined {
  const unwrapped = unwrapSummaryValue(value);
  if (typeof unwrapped === 'string') {
    return `content=${stringByteLength(unwrapped)}B`;
  }
  const record = asRecord(value);
  const length = readNumber(record, 'length');
  return length === undefined ? undefined : `content=${length} chars`;
}

function unwrapSummaryRecord(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (record.type === 'object') {
    return asRecord(record.preview);
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

function joinParts(parts: Array<string | undefined>): string | undefined {
  const compact = parts.filter((part): part is string => typeof part === 'string' && part.length > 0);
  return compact.length > 0 ? compact.join(' ') : undefined;
}

function truncate(value: string, maxLength: number): string {
  const text = oneLine(value);
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 3))}...` : text;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stringByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}

function readFailureText(record: Record<string, unknown>): string | undefined {
  const error = record.error;
  if (typeof error === 'object' && error !== null && !Array.isArray(error)) {
    const errorRecord = error as Record<string, unknown>;
    return readString(errorRecord, 'message') ?? readString(errorRecord, 'name');
  }
  return readString(record, 'error') ?? readString(record, 'reason') ?? readString(record, 'message');
}

function shortRunId(runId: string): string {
  return `run:${runId.slice(0, 8)}`;
}

export function formatDurationMs(ms: number): string {
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

function formatEventTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '--:--:--';
  }
  return date.toISOString().slice(11, 19);
}
