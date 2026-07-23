import type { JsonValue } from '@adaptive-agent/core';

/** Keep 1.10 as a string: JSON numbers cannot distinguish 1.10 from 1.1. */
export const DESKTOP_PROTOCOL_VERSION = '1.10' as const;
export const SUPPORTED_DESKTOP_PROTOCOL_VERSIONS = [DESKTOP_PROTOCOL_VERSION] as const;
export const DESKTOP_BRIDGE_VERSION = '0.1.0';

export type DesktopProtocolVersion = (typeof SUPPORTED_DESKTOP_PROTOCOL_VERSIONS)[number];
export type RuntimeMode = 'memory' | 'postgres';
export type ProviderName = 'openrouter' | 'ollama' | 'mistral' | 'mesh';
export type ApprovalMode = 'auto' | 'manual' | 'reject';
export type ClarificationMode = 'interactive' | 'fail';

export type JsonRpcId = string | number;

export interface JsonRpcRequest<TMethod extends string = string, TParams = Record<string, unknown>> {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: TMethod;
  params?: TParams;
}

export interface JsonRpcNotification<TMethod extends string = string, TParams = JsonValue> {
  jsonrpc: '2.0';
  method: TMethod;
  params?: TParams;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: JsonValue;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: JsonValue;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  error: JsonRpcErrorObject;
}

export const JSON_RPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  notInitialized: -32002,
  alreadyInitialized: -32003,
  shuttingDown: -32004,
  commandRejected: -32010,
  commandFailed: -32011,
} as const;

export interface DesktopClientInfo {
  name: string;
  version?: string;
}

export interface RuntimeInitializeParams {
  cwd?: string;
  agentConfigPath?: string;
  settingsConfigPath?: string;
  runtimeMode?: RuntimeMode;
  provider?: ProviderName;
  model?: string;
  approvalMode?: ApprovalMode;
  clarificationMode?: ClarificationMode;
}

export interface InitializeParams {
  protocolVersion: string;
  clientInfo: DesktopClientInfo;
  capabilities?: Record<string, JsonValue>;
}

export interface CliExecuteParams {
  /** Arguments after the `adaptive-agent` executable name. No shell is used. */
  argv: string[];
  /** Optional piped stdin. Environment overrides are deliberately unsupported. */
  stdin?: string;
  timeoutMs?: number;
}

export interface RunParams {
  goal: string;
  sessionId?: string;
  input?: JsonValue;
}

export interface ChatParams {
  message: string;
  sessionId?: string;
}

export interface RunIdParams {
  runId: string;
}

export interface RecoverParams extends RunIdParams {
  strategy?: 'auto' | 'resume' | 'retry' | 'continue';
  dryRun?: boolean;
}

export interface SteerParams extends RunIdParams {
  message: string;
  role?: 'user' | 'system';
  metadata?: Record<string, JsonValue>;
}

export interface ApprovalParams extends RunIdParams {
  approved: boolean;
}

export interface ClarificationParams extends RunIdParams {
  answer: string;
}

type RpcRequest<TMethod extends string, TParams> = JsonRpcRequest<TMethod, TParams>;
type RpcRequestWithoutParams<TMethod extends string> = JsonRpcRequest<TMethod, never>;

export type DesktopRpcRequest =
  | RpcRequest<'initialize', InitializeParams>
  | RpcRequest<'runtime/initialize', RuntimeInitializeParams>
  | RpcRequestWithoutParams<'runtime/info'>
  | RpcRequestWithoutParams<'runtime/shutdown'>
  | RpcRequest<'agent/run', RunParams>
  | RpcRequest<'agent/chat', ChatParams>
  | RpcRequest<'run/resume', RunIdParams>
  | RpcRequest<'run/retry', RunIdParams>
  | RpcRequest<'run/recover', RecoverParams>
  | RpcRequest<'run/continue', RunIdParams>
  | RpcRequest<'run/interrupt', RunIdParams>
  | RpcRequest<'run/inspect', RunIdParams>
  | RpcRequest<'run/replay', RunIdParams>
  | RpcRequest<'run/steer', SteerParams>
  | RpcRequest<'interaction/resolveApproval', ApprovalParams>
  | RpcRequest<'interaction/resolveClarification', ClarificationParams>
  | RpcRequestWithoutParams<'cli/commands'>
  | RpcRequest<'cli/execute', CliExecuteParams>;

export const DESKTOP_RPC_METHODS = [
  'initialize',
  'runtime/initialize',
  'runtime/info',
  'runtime/shutdown',
  'agent/run',
  'agent/chat',
  'run/resume',
  'run/retry',
  'run/recover',
  'run/continue',
  'run/interrupt',
  'run/inspect',
  'run/replay',
  'run/steer',
  'interaction/resolveApproval',
  'interaction/resolveClarification',
  'cli/commands',
  'cli/execute',
] as const satisfies readonly DesktopRpcRequest['method'][];

export const ADAPTIVE_AGENT_CLI_COMMANDS = [
  'run',
  'chat',
  'spec',
  'swarm-run',
  'ambient',
  'retry',
  'inspect',
  'resume',
  'recover',
  'continue',
  'interrupt',
  'replay',
  'eval',
  'config',
  'catalog',
  'init',
  'doctor',
  'update',
  'uninstall',
  'agent-create',
  'context',
  'version',
] as const;

export type AdaptiveAgentCliCommand = (typeof ADAPTIVE_AGENT_CLI_COMMANDS)[number];

export type DesktopMessage = JsonRpcNotification | JsonRpcSuccessResponse | JsonRpcErrorResponse;

export class DesktopProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly jsonRpcCode = jsonRpcCodeForProtocolError(code),
    readonly data?: JsonValue,
  ) {
    super(message);
    this.name = 'DesktopProtocolError';
  }
}

export function parseDesktopRpcRequest(line: string): DesktopRpcRequest {
  const value = parseJson(line);
  if (Array.isArray(value)) {
    throw new DesktopProtocolError('INVALID_REQUEST', 'JSON-RPC batch requests are not supported.', JSON_RPC_ERROR_CODES.invalidRequest);
  }
  if (!isRecord(value)) {
    throw new DesktopProtocolError('INVALID_REQUEST', 'Request must be a JSON object.', JSON_RPC_ERROR_CODES.invalidRequest);
  }
  return parseDesktopRpcRequestValue(value);
}

export function rpcIdFromUnknownLine(line: string): JsonRpcId | null {
  try {
    const value = JSON.parse(line) as unknown;
    if (!isRecord(value)) return null;
    return isJsonRpcId(value.id) ? value.id : null;
  } catch {
    return null;
  }
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    throw new DesktopProtocolError('INVALID_JSON', 'Request must be valid JSON.', JSON_RPC_ERROR_CODES.parseError);
  }
}

function parseDesktopRpcRequestValue(value: Record<string, unknown>): DesktopRpcRequest {
  if (value.jsonrpc !== '2.0') {
    throw new DesktopProtocolError('INVALID_REQUEST', 'jsonrpc must be exactly "2.0".', JSON_RPC_ERROR_CODES.invalidRequest);
  }
  if (!isJsonRpcId(value.id)) {
    throw new DesktopProtocolError('INVALID_REQUEST', 'JSON-RPC request id must be a string or finite number.', JSON_RPC_ERROR_CODES.invalidRequest);
  }
  if (typeof value.method !== 'string' || !value.method.trim()) {
    throw new DesktopProtocolError('INVALID_REQUEST', 'JSON-RPC method must be a non-empty string.', JSON_RPC_ERROR_CODES.invalidRequest);
  }
  if (!DESKTOP_RPC_METHODS.includes(value.method as DesktopRpcRequest['method'])) {
    throw new DesktopProtocolError('METHOD_NOT_FOUND', `Unknown JSON-RPC method: ${value.method}`, JSON_RPC_ERROR_CODES.methodNotFound);
  }
  if (value.params !== undefined && !isRecord(value.params)) {
    throw new DesktopProtocolError('INVALID_PARAMS', 'JSON-RPC params must be an object.', JSON_RPC_ERROR_CODES.invalidParams);
  }
  validateRpcParams(value.method as DesktopRpcRequest['method'], value.params as Record<string, unknown> | undefined);
  return value as unknown as DesktopRpcRequest;
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateRpcParams(method: DesktopRpcRequest['method'], params: Record<string, unknown> | undefined): void {
  switch (method) {
    case 'runtime/info':
    case 'runtime/shutdown':
    case 'cli/commands':
      if (params && Object.keys(params).length > 0) invalidParams(`${method} does not accept params.`);
      return;
    case 'initialize': {
      const value = requiredParams(method, params);
      requiredString(value, 'protocolVersion');
      requiredObject(value, 'clientInfo');
      requiredString(value.clientInfo as Record<string, unknown>, 'name');
      optionalString(value.clientInfo as Record<string, unknown>, 'version');
      optionalObject(value, 'capabilities');
      return;
    }
    case 'runtime/initialize':
      validateRuntimeInitializeParams(params ?? {});
      return;
    case 'agent/run': {
      const value = requiredParams(method, params);
      requiredString(value, 'goal');
      optionalString(value, 'sessionId');
      return;
    }
    case 'agent/chat': {
      const value = requiredParams(method, params);
      requiredString(value, 'message');
      optionalString(value, 'sessionId');
      return;
    }
    case 'run/resume':
    case 'run/retry':
    case 'run/continue':
    case 'run/interrupt':
    case 'run/inspect':
    case 'run/replay':
      requiredString(requiredParams(method, params), 'runId');
      return;
    case 'run/recover': {
      const value = requiredParams(method, params);
      requiredString(value, 'runId');
      optionalEnum(value, 'strategy', ['auto', 'resume', 'retry', 'continue']);
      optionalBoolean(value, 'dryRun');
      return;
    }
    case 'run/steer': {
      const value = requiredParams(method, params);
      requiredString(value, 'runId');
      requiredString(value, 'message');
      optionalEnum(value, 'role', ['user', 'system']);
      optionalObject(value, 'metadata');
      return;
    }
    case 'interaction/resolveApproval': {
      const value = requiredParams(method, params);
      requiredString(value, 'runId');
      if (typeof value.approved !== 'boolean') invalidParams('approved must be a boolean.');
      return;
    }
    case 'interaction/resolveClarification': {
      const value = requiredParams(method, params);
      requiredString(value, 'runId');
      requiredString(value, 'answer');
      return;
    }
    case 'cli/execute': {
      const value = requiredParams(method, params);
      if (!Array.isArray(value.argv) || value.argv.length === 0 || value.argv.some((argument) => typeof argument !== 'string')) {
        invalidParams('argv must be a non-empty array of strings.');
      }
      optionalStringAllowEmpty(value, 'stdin');
      if (value.timeoutMs !== undefined && (!Number.isSafeInteger(value.timeoutMs) || (value.timeoutMs as number) < 1 || (value.timeoutMs as number) > 86_400_000)) {
        invalidParams('timeoutMs must be an integer between 1 and 86400000.');
      }
      return;
    }
  }
}

function validateRuntimeInitializeParams(value: Record<string, unknown>): void {
  optionalString(value, 'cwd');
  optionalString(value, 'agentConfigPath');
  optionalString(value, 'settingsConfigPath');
  optionalEnum(value, 'runtimeMode', ['memory', 'postgres']);
  optionalEnum(value, 'provider', ['openrouter', 'ollama', 'mistral', 'mesh']);
  optionalString(value, 'model');
  optionalEnum(value, 'approvalMode', ['auto', 'manual', 'reject']);
  optionalEnum(value, 'clarificationMode', ['interactive', 'fail']);
}

function requiredParams(method: string, params: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!params) invalidParams(`${method} requires params.`);
  return params!;
}

function requiredString(value: Record<string, unknown>, field: string): void {
  if (typeof value[field] !== 'string' || !value[field].trim()) {
    invalidParams(`${field} must be a non-empty string.`);
  }
}

function optionalString(value: Record<string, unknown>, field: string): void {
  if (value[field] !== undefined) requiredString(value, field);
}

function optionalStringAllowEmpty(value: Record<string, unknown>, field: string): void {
  if (value[field] !== undefined && typeof value[field] !== 'string') invalidParams(`${field} must be a string.`);
}

function requiredObject(value: Record<string, unknown>, field: string): void {
  if (!isRecord(value[field])) invalidParams(`${field} must be an object.`);
}

function optionalObject(value: Record<string, unknown>, field: string): void {
  if (value[field] !== undefined) requiredObject(value, field);
}

function optionalBoolean(value: Record<string, unknown>, field: string): void {
  if (value[field] !== undefined && typeof value[field] !== 'boolean') invalidParams(`${field} must be a boolean.`);
}

function optionalEnum(value: Record<string, unknown>, field: string, allowed: readonly string[]): void {
  if (value[field] !== undefined && (typeof value[field] !== 'string' || !allowed.includes(value[field]))) {
    invalidParams(`${field} must be one of: ${allowed.join(', ')}.`);
  }
}

function invalidParams(message: string): never {
  throw new DesktopProtocolError('INVALID_PARAMS', message, JSON_RPC_ERROR_CODES.invalidParams);
}

function jsonRpcCodeForProtocolError(code: string): number {
  switch (code) {
    case 'INVALID_JSON':
      return JSON_RPC_ERROR_CODES.parseError;
    case 'INVALID_REQUEST':
      return JSON_RPC_ERROR_CODES.invalidRequest;
    case 'UNKNOWN_COMMAND':
    case 'METHOD_NOT_FOUND':
      return JSON_RPC_ERROR_CODES.methodNotFound;
    case 'INVALID_COMMAND':
    case 'INVALID_PARAMS':
    case 'UNSUPPORTED_PROTOCOL_VERSION':
      return JSON_RPC_ERROR_CODES.invalidParams;
    case 'NOT_INITIALIZED':
      return JSON_RPC_ERROR_CODES.notInitialized;
    case 'ALREADY_INITIALIZED':
      return JSON_RPC_ERROR_CODES.alreadyInitialized;
    case 'SHUTTING_DOWN':
      return JSON_RPC_ERROR_CODES.shuttingDown;
    case 'COMMAND_REJECTED':
      return JSON_RPC_ERROR_CODES.commandRejected;
    case 'COMMAND_FAILED':
      return JSON_RPC_ERROR_CODES.commandFailed;
    default:
      return JSON_RPC_ERROR_CODES.internalError;
  }
}
