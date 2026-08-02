import type { SwarmRole, TraceAggregateGroupBy, TraceListType } from '../trace-session/types.js';

export const TRACE_SIDECAR_PROTOCOL_VERSION = '1.0' as const;
export const TRACE_SIDECAR_VERSION = '0.1.0';
export const TRACE_SIDECAR_DEFAULT_LIMIT = 100;
export const TRACE_SIDECAR_MAX_LIMIT = 500;
export const TRACE_SIDECAR_MAX_REQUEST_BYTES = 1024 * 1024;
export const TRACE_SIDECAR_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const TRACE_SIDECAR_QUERY_TIMEOUT_MS = 30_000;

export type JsonRpcId = string | number;

export interface JsonRpcRequest<TMethod extends string = string, TParams = Record<string, unknown>> {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: TMethod;
  params?: TParams;
}

export interface InitializeParams {
  protocolVersion: string;
  clientInfo: { name: string; version?: string };
}

export type TraceTarget =
  | { kind: 'session'; sessionId: string; rootRunId?: string }
  | { kind: 'root-run'; rootRunId: string }
  | { kind: 'run'; runId: string };

export interface TraceGetParams {
  target: TraceTarget;
  focusRunId?: string;
  include?: {
    plans?: boolean;
    messages?: boolean;
    reasoning?: boolean;
    rawToolPayloads?: boolean;
  };
}

export interface TraceListFilters {
  goals?: string[];
  hasGoal?: boolean;
  noGoal?: boolean;
  statuses?: string[];
  limit?: number;
  types?: TraceListType[];
  swarmRole?: SwarmRole;
  since?: string;
  until?: string;
}

export interface TraceUsageParams { target: TraceTarget }
export interface TraceCompareParams { baselineRunId: string; candidateRunId: string }
export interface TraceAggregateParams extends TraceListFilters { groupBy: TraceAggregateGroupBy }
export interface TraceListSessionlessParams { limit?: number }

type Request<TMethod extends string, TParams> = JsonRpcRequest<TMethod, TParams>;
type RequestWithoutParams<TMethod extends string> = JsonRpcRequest<TMethod, never>;

export type TraceSidecarRpcRequest =
  | Request<'initialize', InitializeParams>
  | RequestWithoutParams<'runtime/info'>
  | Request<'trace/get', TraceGetParams>
  | Request<'trace/listSessions', TraceListFilters>
  | Request<'trace/listSessionlessRuns', TraceListSessionlessParams>
  | Request<'trace/usage', TraceUsageParams>
  | Request<'trace/compare', TraceCompareParams>
  | Request<'trace/aggregate', TraceAggregateParams>
  | RequestWithoutParams<'shutdown'>;

export const TRACE_SIDECAR_RPC_METHODS = [
  'initialize',
  'runtime/info',
  'trace/get',
  'trace/listSessions',
  'trace/listSessionlessRuns',
  'trace/usage',
  'trace/compare',
  'trace/aggregate',
  'shutdown',
] as const satisfies readonly TraceSidecarRpcRequest['method'][];

export const JSON_RPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  notInitialized: -32002,
  alreadyInitialized: -32003,
  shuttingDown: -32004,
  sensitiveDataNotAllowed: -32020,
  resultTooLarge: -32021,
  unsupportedProtocol: -32022,
} as const;

export class TraceSidecarProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly jsonRpcCode: number,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'TraceSidecarProtocolError';
  }
}

export function parseTraceSidecarRpcRequest(line: string): TraceSidecarRpcRequest {
  if (Buffer.byteLength(line, 'utf8') > TRACE_SIDECAR_MAX_REQUEST_BYTES) {
    throw protocolError('INVALID_REQUEST', `Request exceeds the ${TRACE_SIDECAR_MAX_REQUEST_BYTES}-byte limit.`, JSON_RPC_ERROR_CODES.invalidRequest);
  }
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    throw protocolError('INVALID_JSON', 'Request must be valid JSON.', JSON_RPC_ERROR_CODES.parseError);
  }
  if (!isRecord(value) || Array.isArray(value)) invalidRequest('Request must be a JSON object.');
  const unexpectedEnvelopeKey = Object.keys(value).find((key) => !['jsonrpc', 'id', 'method', 'params'].includes(key));
  if (unexpectedEnvelopeKey) invalidRequest(`Request contains unsupported field: ${unexpectedEnvelopeKey}.`);
  if (value.jsonrpc !== '2.0') invalidRequest('jsonrpc must be exactly "2.0".');
  if (!isJsonRpcId(value.id)) invalidRequest('JSON-RPC request id must be a string or finite number.');
  if (typeof value.method !== 'string' || !value.method.trim()) invalidRequest('JSON-RPC method must be a non-empty string.');
  if (!TRACE_SIDECAR_RPC_METHODS.includes(value.method as TraceSidecarRpcRequest['method'])) {
    throw protocolError('METHOD_NOT_FOUND', `Unknown JSON-RPC method: ${value.method}`, JSON_RPC_ERROR_CODES.methodNotFound);
  }
  if (value.params !== undefined && !isRecord(value.params)) invalidParams('params must be an object.');
  validateParams(value.method as TraceSidecarRpcRequest['method'], value.params as Record<string, unknown> | undefined);
  return value as unknown as TraceSidecarRpcRequest;
}

export function rpcIdFromUnknownLine(line: string): JsonRpcId | null {
  try {
    const value = JSON.parse(line) as unknown;
    return isRecord(value) && isJsonRpcId(value.id) ? value.id : null;
  } catch {
    return null;
  }
}

function validateParams(method: TraceSidecarRpcRequest['method'], params: Record<string, unknown> | undefined): void {
  switch (method) {
    case 'runtime/info':
    case 'shutdown':
      noParams(method, params);
      return;
    case 'initialize': {
      const value = requiredParams(method, params);
      exactKeys(value, ['protocolVersion', 'clientInfo'], method);
      requiredString(value, 'protocolVersion');
      const clientInfo = requiredObject(value, 'clientInfo');
      exactKeys(clientInfo, ['name', 'version'], 'initialize.clientInfo');
      requiredString(clientInfo, 'name');
      optionalString(clientInfo, 'version');
      return;
    }
    case 'trace/get': {
      const value = requiredParams(method, params);
      exactKeys(value, ['target', 'focusRunId', 'include'], method);
      validateTarget(requiredObject(value, 'target'));
      optionalString(value, 'focusRunId');
      if (value.include !== undefined) {
        const include = requiredObject(value, 'include');
        exactKeys(include, ['plans', 'messages', 'reasoning', 'rawToolPayloads'], `${method}.include`);
        for (const key of ['plans', 'messages', 'reasoning', 'rawToolPayloads']) optionalBoolean(include, key);
      }
      return;
    }
    case 'trace/usage': {
      const value = requiredParams(method, params);
      exactKeys(value, ['target'], method);
      validateTarget(requiredObject(value, 'target'));
      return;
    }
    case 'trace/compare': {
      const value = requiredParams(method, params);
      exactKeys(value, ['baselineRunId', 'candidateRunId'], method);
      const baseline = requiredString(value, 'baselineRunId');
      const candidate = requiredString(value, 'candidateRunId');
      if (baseline === candidate) invalidParams('trace/compare requires two different run IDs.');
      return;
    }
    case 'trace/listSessions':
      validateListFilters(params ?? {}, method);
      return;
    case 'trace/listSessionlessRuns': {
      const value = params ?? {};
      exactKeys(value, ['limit'], method);
      optionalLimit(value);
      return;
    }
    case 'trace/aggregate': {
      const value = requiredParams(method, params);
      validateListFilters(value, method, ['groupBy']);
      enumValue(value, 'groupBy', ['model', 'status', 'day']);
      return;
    }
  }
}

function validateTarget(target: Record<string, unknown>): void {
  const kind = enumValue(target, 'kind', ['session', 'root-run', 'run']);
  if (kind === 'session') {
    exactKeys(target, ['kind', 'sessionId', 'rootRunId'], 'target');
    requiredString(target, 'sessionId');
    optionalString(target, 'rootRunId');
  } else if (kind === 'root-run') {
    exactKeys(target, ['kind', 'rootRunId'], 'target');
    requiredString(target, 'rootRunId');
  } else {
    exactKeys(target, ['kind', 'runId'], 'target');
    requiredString(target, 'runId');
  }
}

const STATUSES = ['queued', 'planning', 'awaiting_approval', 'awaiting_subagent', 'running', 'interrupted', 'succeeded', 'failed', 'clarification_requested', 'replan_required', 'cancelled'] as const;
const TYPES = ['run', 'chat', 'swarm', 'swarm-run'] as const;
const SWARM_ROLES = ['coordinator', 'worker', 'quality', 'synthesizer'] as const;

function validateListFilters(value: Record<string, unknown>, label: string, extraKeys: string[] = []): void {
  exactKeys(value, ['goals', 'hasGoal', 'noGoal', 'statuses', 'limit', 'types', 'swarmRole', 'since', 'until', ...extraKeys], label);
  optionalStringArray(value, 'goals');
  optionalBoolean(value, 'hasGoal');
  optionalBoolean(value, 'noGoal');
  optionalEnumArray(value, 'statuses', STATUSES);
  optionalLimit(value);
  optionalEnumArray(value, 'types', TYPES);
  optionalEnum(value, 'swarmRole', SWARM_ROLES);
  optionalTimeBoundary(value, 'since');
  optionalTimeBoundary(value, 'until');
  if (value.hasGoal === true && value.noGoal === true) invalidParams('hasGoal and noGoal cannot both be true.');
  if (value.noGoal === true && Array.isArray(value.goals) && value.goals.length > 0) invalidParams('noGoal cannot be combined with goals.');
  if (typeof value.since === 'string' && typeof value.until === 'string') {
    const now = Date.now();
    if (resolveTime(value.since, now) > resolveTime(value.until, now)) invalidParams('since must be earlier than or equal to until.');
  }
}

function noParams(method: string, params: Record<string, unknown> | undefined): void {
  if (params && Object.keys(params).length > 0) invalidParams(`${method} does not accept params.`);
}

function requiredParams(method: string, params: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!params) invalidParams(`${method} requires params.`);
  return params;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) invalidParams(`${label} contains unsupported field: ${unexpected}.`);
}

function requiredObject(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const item = value[key];
  if (!isRecord(item)) invalidParams(`${key} must be an object.`);
  return item;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const item = value[key];
  if (typeof item !== 'string' || !item.trim() || item.length > 4096) invalidParams(`${key} must be a non-empty string of at most 4096 characters.`);
  return item;
}

function optionalString(value: Record<string, unknown>, key: string): void {
  if (value[key] !== undefined) requiredString(value, key);
}

function optionalBoolean(value: Record<string, unknown>, key: string): void {
  if (value[key] !== undefined && typeof value[key] !== 'boolean') invalidParams(`${key} must be a boolean.`);
}

function optionalLimit(value: Record<string, unknown>): void {
  if (value.limit !== undefined && (!Number.isInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > TRACE_SIDECAR_MAX_LIMIT)) {
    invalidParams(`limit must be an integer from 1 through ${TRACE_SIDECAR_MAX_LIMIT}.`);
  }
}

function optionalStringArray(value: Record<string, unknown>, key: string): void {
  const item = value[key];
  if (item === undefined) return;
  if (!Array.isArray(item) || item.length > 20 || item.some((entry) => typeof entry !== 'string' || !entry.trim() || entry.length > 4096)) {
    invalidParams(`${key} must contain at most 20 non-empty strings.`);
  }
}

function enumValue<const T extends readonly string[]>(value: Record<string, unknown>, key: string, allowed: T): T[number] {
  const item = value[key];
  if (typeof item !== 'string' || !allowed.includes(item)) invalidParams(`${key} must be one of: ${allowed.join(', ')}.`);
  return item as T[number];
}

function optionalEnum<const T extends readonly string[]>(value: Record<string, unknown>, key: string, allowed: T): void {
  if (value[key] !== undefined) enumValue(value, key, allowed);
}

function optionalEnumArray<const T extends readonly string[]>(value: Record<string, unknown>, key: string, allowed: T): void {
  const item = value[key];
  if (item === undefined) return;
  if (!Array.isArray(item) || item.length > allowed.length || item.some((entry) => typeof entry !== 'string' || !allowed.includes(entry))) {
    invalidParams(`${key} must contain only: ${allowed.join(', ')}.`);
  }
}

function optionalTimeBoundary(value: Record<string, unknown>, key: string): void {
  const item = value[key];
  if (item === undefined) return;
  if (typeof item !== 'string' || !Number.isFinite(resolveTime(item, Date.now()))) invalidParams(`${key} must be an ISO timestamp or relative duration such as 1h or 7d.`);
}

function resolveTime(value: string, now: number): number {
  const relative = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/i.exec(value.trim());
  if (relative) {
    const factors: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
    return now - Number(relative[1]) * factors[relative[2]!.toLowerCase()]!;
  }
  return Date.parse(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function invalidRequest(message: string): never {
  throw protocolError('INVALID_REQUEST', message, JSON_RPC_ERROR_CODES.invalidRequest);
}

function invalidParams(message: string): never {
  throw protocolError('INVALID_PARAMS', message, JSON_RPC_ERROR_CODES.invalidParams);
}

function protocolError(code: string, message: string, jsonRpcCode: number): TraceSidecarProtocolError {
  return new TraceSidecarProtocolError(code, message, jsonRpcCode);
}
