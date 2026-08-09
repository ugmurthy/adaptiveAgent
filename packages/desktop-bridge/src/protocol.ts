import type { ChatMessage, JsonValue, RuntimeDeletionTarget } from '@adaptive-agent/core';
import type { InferenceMode, InferenceTier, ProfileRef } from '@adaptive-agent/gateway-client';

export {
  ADAPTIVE_AGENT_CLI_COMMANDS,
  type AdaptiveAgentCliCommand,
} from '@adaptive-agent/agent-sdk/cli';

/** Keep versions as strings: JSON numbers cannot distinguish 1.10 from 1.1. */
export const DESKTOP_PROTOCOL_VERSION = '1.13' as const;
export const SUPPORTED_DESKTOP_PROTOCOL_VERSIONS = ['1.10', '1.11', '1.12', DESKTOP_PROTOCOL_VERSION] as const;
export const DESKTOP_BRIDGE_VERSION = '0.1.0';

export type DesktopProtocolVersion = (typeof SUPPORTED_DESKTOP_PROTOCOL_VERSIONS)[number];
export type RuntimeMode = 'memory' | 'sqlite' | 'postgres';
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
  /** Preserve settings/agent runtime and interaction choices for restricted desktop clients. */
  configurationDriven?: boolean;
  cwd?: string;
  agentConfigPath?: string;
  settingsConfigPath?: string;
  runtimeMode?: RuntimeMode;
  sqlitePath?: string;
  provider?: ProviderName;
  model?: string;
  approvalMode?: ApprovalMode;
  clarificationMode?: ClarificationMode;
  inferenceMode?: InferenceMode;
  inferenceTier?: InferenceTier;
  profileRef?: ProfileRef;
  gatewayUrl?: string;
  requireRunPermit?: boolean;
  managedAttachmentRoot?: string;
}

export type DesktopAttachmentKind = 'file' | 'image' | 'audio';
export type DesktopAudioFormat = 'wav' | 'mp3' | 'flac' | 'm4a' | 'ogg' | 'aac' | 'aiff' | 'pcm16' | 'pcm24';
export interface DesktopAttachmentInput {
  attachmentId: string;
  kind: DesktopAttachmentKind;
  stagedRelativePath: string;
  name: string;
  mimeType?: string;
  sizeBytes: number;
  sha256: string;
  audioFormat?: DesktopAudioFormat;
}

export interface EditableDesktopSettings {
  agent: { configPath?: string; id: string };
  inference: { mode: InferenceMode; tier: InferenceTier };
  workspace: { root: string; shellCwd: string };
  interaction: { approvalMode: ApprovalMode; clarificationMode: ClarificationMode };
}

export interface SettingsUpdateParams {
  settings: EditableDesktopSettings;
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
  runId?: string;
  executionId?: string;
  goal: string;
  sessionId?: string;
  input?: JsonValue;
  inferenceMode?: InferenceMode;
  inferenceTier?: InferenceTier;
  profileRef?: ProfileRef;
  attachments?: DesktopAttachmentInput[];
}

export interface ChatParams {
  runId?: string;
  executionId?: string;
  transcript: ChatMessage[] | DesktopChatMessage[];
  sessionId?: string;
  chatSessionId?: string;
  inferenceMode?: InferenceMode;
  inferenceTier?: InferenceTier;
  profileRef?: ProfileRef;
}

export interface DesktopChatMessage { role: 'user' | 'assistant'; text: string; attachments?: DesktopAttachmentInput[] }

export interface UpdateAccessTokenParams {
  accessToken: string;
}

export interface RunIdParams {
  runId: string;
}

export interface ContinueParams extends RunIdParams {
  continuationRunId?: string;
}

export interface RecoverParams extends RunIdParams {
  strategy?: 'auto' | 'same_run' | 'resume' | 'retry' | 'continue';
  dryRun?: boolean;
}

export interface SteerParams extends RunIdParams {
  message: string;
  role?: 'user' | 'system';
  metadata?: Record<string, JsonValue>;
}

export interface ApprovalParams extends RunIdParams {
  approvalId: string;
  approved: boolean;
}

export interface ClarificationParams extends RunIdParams {
  answer: string;
}

export interface HistoryDeletionParams {
  target: RuntimeDeletionTarget;
}

type RpcRequest<TMethod extends string, TParams> = JsonRpcRequest<TMethod, TParams>;
type RpcRequestWithoutParams<TMethod extends string> = JsonRpcRequest<TMethod, never>;

export type DesktopRpcRequest =
  | RpcRequest<'initialize', InitializeParams>
  | RpcRequest<'runtime/initialize', RuntimeInitializeParams>
  | RpcRequestWithoutParams<'runtime/info'>
  | RpcRequestWithoutParams<'runtime/shutdown'>
  | RpcRequest<'settings/update', SettingsUpdateParams>
  | RpcRequest<'auth/updateAccessToken', UpdateAccessTokenParams>
  | RpcRequest<'agent/run', RunParams>
  | RpcRequest<'agent/chat', ChatParams>
  | RpcRequest<'run/resume', RunIdParams>
  | RpcRequest<'run/retry', RunIdParams>
  | RpcRequest<'run/recover', RecoverParams>
  | RpcRequest<'run/continue', ContinueParams>
  | RpcRequest<'run/interrupt', RunIdParams>
  | RpcRequest<'run/inspect', RunIdParams>
  | RpcRequest<'run/replay', RunIdParams>
  | RpcRequest<'run/steer', SteerParams>
  | RpcRequest<'execution/inspect' | 'execution/interrupt' | 'execution/resume', { executionId: string }>
  | RpcRequest<'interaction/resolveApproval', ApprovalParams>
  | RpcRequest<'interaction/resolveClarification', ClarificationParams>
  | RpcRequest<'history/previewDeletion', HistoryDeletionParams>
  | RpcRequest<'history/delete', HistoryDeletionParams>
  | RpcRequestWithoutParams<'cli/commands'>
  | RpcRequest<'cli/execute', CliExecuteParams>;

export const DESKTOP_RPC_METHODS = [
  'initialize',
  'runtime/initialize',
  'runtime/info',
  'runtime/shutdown',
  'settings/update',
  'auth/updateAccessToken',
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
  'execution/inspect',
  'execution/interrupt',
  'execution/resume',
  'interaction/resolveApproval',
  'interaction/resolveClarification',
  'history/previewDeletion',
  'history/delete',
  'cli/commands',
  'cli/execute',
] as const satisfies readonly DesktopRpcRequest['method'][];

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
    case 'auth/updateAccessToken':
      requiredString(requiredParams(method, params), 'accessToken');
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
    case 'settings/update': {
      const request = requiredParams(method, params);
      requiredObject(request, 'settings');
      const settings = request.settings as Record<string, unknown>;
      requiredObject(settings, 'agent');
      const agent = settings.agent as Record<string, unknown>;
      optionalStringAllowEmpty(agent, 'configPath');
      requiredString(agent, 'id');
      requiredObject(settings, 'inference');
      const inference = settings.inference as Record<string, unknown>;
      optionalEnum(inference, 'mode', ['gateway', 'local', 'byok']);
      if (inference.mode === undefined) invalidParams('settings.inference.mode is required.');
      optionalEnum(inference, 'tier', ['low', 'medium', 'high', 'xtra-high']);
      if (inference.tier === undefined) invalidParams('settings.inference.tier is required.');
      requiredObject(settings, 'workspace');
      const workspace = settings.workspace as Record<string, unknown>;
      requiredString(workspace, 'root');
      requiredString(workspace, 'shellCwd');
      requiredObject(settings, 'interaction');
      const interaction = settings.interaction as Record<string, unknown>;
      optionalEnum(interaction, 'approvalMode', ['auto', 'manual', 'reject']);
      if (interaction.approvalMode === undefined) invalidParams('settings.interaction.approvalMode is required.');
      optionalEnum(interaction, 'clarificationMode', ['interactive', 'fail']);
      if (interaction.clarificationMode === undefined) invalidParams('settings.interaction.clarificationMode is required.');
      return;
    }
    case 'agent/run': {
      const value = requiredParams(method, params);
      if (value.executionId === undefined) requiredString(value, 'runId');
      else {
        requiredString(value, 'executionId');
        if (value.runId !== undefined) invalidParams('runId and executionId are mutually exclusive.');
      }
      requiredString(value, 'goal');
      optionalString(value, 'sessionId');
      validateExecutionSelection(value);
      optionalAttachments(value, 'attachments');
      return;
    }
    case 'agent/chat': {
      const value = requiredParams(method, params);
      if (value.executionId === undefined) {
        requiredString(value, 'runId');
        validateTranscript(value.transcript);
      } else {
        requiredString(value, 'executionId');
        if (value.runId !== undefined) invalidParams('runId and executionId are mutually exclusive.');
        requiredString(value, 'chatSessionId');
        if (value.sessionId !== undefined) invalidParams('sessionId and chatSessionId are mutually exclusive.');
        validateDesktopTranscript(value.transcript);
      }
      optionalString(value, 'sessionId');
      validateExecutionSelection(value);
      return;
    }
    case 'execution/inspect':
    case 'execution/interrupt':
    case 'execution/resume':
      requiredString(requiredParams(method, params), 'executionId');
      return;
    case 'run/resume':
    case 'run/retry':
    case 'run/interrupt':
    case 'run/inspect':
    case 'run/replay':
      requiredString(requiredParams(method, params), 'runId');
      return;
    case 'run/continue': {
      const value = requiredParams(method, params);
      requiredString(value, 'runId');
      optionalString(value, 'continuationRunId');
      return;
    }
    case 'run/recover': {
      const value = requiredParams(method, params);
      requiredString(value, 'runId');
      optionalEnum(value, 'strategy', ['auto', 'same_run', 'resume', 'retry', 'continue']);
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
      requiredString(value, 'approvalId');
      if (typeof value.approved !== 'boolean') invalidParams('approved must be a boolean.');
      return;
    }
    case 'interaction/resolveClarification': {
      const value = requiredParams(method, params);
      requiredString(value, 'runId');
      requiredString(value, 'answer');
      return;
    }
    case 'history/previewDeletion':
    case 'history/delete': {
      const value = requiredParams(method, params);
      requiredObject(value, 'target');
      const target = value.target as Record<string, unknown>;
      requiredString(target, 'kind');
      const kind = target.kind;
      if (kind === 'root-run') {
        requiredString(target, 'rootRunId');
      } else if (kind === 'session') {
        requiredString(target, 'sessionId');
      } else {
        invalidParams('target.kind must be root-run or session.');
      }
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

function validateTranscript(value: unknown): asserts value is ChatMessage[] {
  if (!Array.isArray(value) || value.length === 0) invalidParams('transcript must be a non-empty ChatMessage array.');
  for (const [index, message] of value.entries()) {
    if (!isRecord(message) || !['system', 'user', 'assistant'].includes(String(message.role))) {
      invalidParams(`transcript[${index}].role must be system, user, or assistant.`);
    }
    if (typeof message.content !== 'string' && !Array.isArray(message.content)) {
      invalidParams(`transcript[${index}].content must be a string or content-part array.`);
    }
    if (typeof message.content === 'string' && !message.content.trim()) {
      invalidParams(`transcript[${index}].content must not be empty.`);
    }
    if (Array.isArray(message.content) && (message.content.length === 0 || message.content.some((part) => !isRecord(part)))) {
      invalidParams(`transcript[${index}].content must contain valid content parts.`);
    }
    if (Array.isArray(message.content) && message.content.some((part) => isRecord(part) && (part.type === 'image' || part.type === 'audio'))) {
      invalidParams('Legacy agent/chat image and audio inputs are unavailable; use managed desktop attachments.');
    }
    if (message.images !== undefined && !Array.isArray(message.images)) {
      invalidParams(`transcript[${index}].images must be an array.`);
    }
    if (Array.isArray(message.images) && message.images.length > 0) {
      invalidParams('Legacy agent/chat image inputs are unavailable; use managed desktop attachments.');
    }
  }
}

function validateRuntimeInitializeParams(value: Record<string, unknown>): void {
  optionalBoolean(value, 'configurationDriven');
  optionalString(value, 'cwd');
  optionalString(value, 'agentConfigPath');
  optionalString(value, 'settingsConfigPath');
  optionalEnum(value, 'runtimeMode', ['memory', 'sqlite', 'postgres']);
  optionalString(value, 'sqlitePath');
  optionalEnum(value, 'provider', ['openrouter', 'ollama', 'mistral', 'mesh']);
  optionalString(value, 'model');
  optionalEnum(value, 'approvalMode', ['auto', 'manual', 'reject']);
  optionalEnum(value, 'clarificationMode', ['interactive', 'fail']);
  optionalEnum(value, 'inferenceMode', ['gateway', 'local', 'byok']);
  optionalEnum(value, 'inferenceTier', ['low', 'medium', 'high', 'xtra-high']);
  optionalProfileRef(value, 'profileRef');
  optionalString(value, 'gatewayUrl');
  optionalBoolean(value, 'requireRunPermit');
  optionalString(value, 'managedAttachmentRoot');
}

const ATTACHMENT_KEYS = new Set(['attachmentId', 'kind', 'stagedRelativePath', 'name', 'mimeType', 'sizeBytes', 'sha256', 'audioFormat']);
function optionalAttachments(value: Record<string, unknown>, field: string): void {
  if (value[field] === undefined) return;
  if (!Array.isArray(value[field]) || value[field].length > 8) invalidParams(`${field} must be an array of at most 8 attachments.`);
  const ids = new Set<string>();
  for (const [index, raw] of (value[field] as unknown[]).entries()) {
    if (!isRecord(raw)) invalidParams(`${field}[${index}] must be an object.`);
    for (const key of Object.keys(raw)) if (!ATTACHMENT_KEYS.has(key)) invalidParams(`${field}[${index}].${key} is not allowed.`);
    for (const key of ['attachmentId', 'stagedRelativePath', 'name', 'sha256']) requiredString(raw, key);
    optionalEnum(raw, 'kind', ['file', 'image', 'audio']);
    if (raw.kind === undefined) invalidParams(`${field}[${index}].kind is required.`);
    optionalString(raw, 'mimeType');
    optionalEnum(raw, 'audioFormat', ['wav', 'mp3', 'flac', 'm4a', 'ogg', 'aac', 'aiff', 'pcm16', 'pcm24']);
    if (raw.kind !== 'audio' && raw.audioFormat !== undefined) invalidParams(`${field}[${index}].audioFormat is valid only for audio.`);
    if (!Number.isSafeInteger(raw.sizeBytes) || (raw.sizeBytes as number) < 0 || (raw.sizeBytes as number) > 10 * 1024 * 1024) invalidParams(`${field}[${index}].sizeBytes is invalid.`);
    if (!/^[a-f0-9]{64}$/.test(String(raw.sha256))) invalidParams(`${field}[${index}].sha256 must be lowercase SHA-256 hex.`);
    if (ids.has(raw.attachmentId as string)) invalidParams(`Duplicate attachmentId: ${raw.attachmentId}.`);
    ids.add(raw.attachmentId as string);
  }
  const total = (value[field] as DesktopAttachmentInput[]).reduce((sum, item) => sum + item.sizeBytes, 0);
  if (total > 40 * 1024 * 1024) invalidParams(`${field} exceeds the submission byte limit.`);
}

function validateDesktopTranscript(value: unknown): asserts value is DesktopChatMessage[] {
  if (!Array.isArray(value) || value.length === 0) invalidParams('transcript must be non-empty.');
  const ids = new Set<string>();
  for (const [index, raw] of value.entries()) {
    if (!isRecord(raw)) invalidParams(`transcript[${index}] must be an object.`);
    for (const key of Object.keys(raw)) if (!['role', 'text', 'attachments'].includes(key)) invalidParams(`transcript[${index}].${key} is not allowed.`);
    optionalEnum(raw, 'role', ['user', 'assistant']);
    if (raw.role === undefined) invalidParams(`transcript[${index}].role is required.`);
    requiredString(raw, 'text');
    if (raw.role !== 'user' && raw.attachments !== undefined) invalidParams(`transcript[${index}] assistant messages cannot have attachments.`);
    optionalAttachments(raw, 'attachments');
    for (const attachment of (raw.attachments ?? []) as DesktopAttachmentInput[]) {
      if (ids.has(attachment.attachmentId)) invalidParams(`Duplicate attachmentId: ${attachment.attachmentId}.`);
      ids.add(attachment.attachmentId);
    }
  }
}

function validateExecutionSelection(value: Record<string, unknown>): void {
  optionalEnum(value, 'inferenceMode', ['gateway', 'local', 'byok']);
  optionalEnum(value, 'inferenceTier', ['low', 'medium', 'high', 'xtra-high']);
  optionalProfileRef(value, 'profileRef');
}

function optionalProfileRef(value: Record<string, unknown>, field: string): void {
  if (value[field] === undefined) return;
  if (!isRecord(value[field])) invalidParams(`${field} must be an object.`);
  const ref = value[field] as Record<string, unknown>;
  optionalEnum(ref, 'source', ['local', 'server']);
  if (ref.source === undefined) invalidParams(`${field}.source is required.`);
  for (const key of ['id', 'version', 'contentHash']) requiredString(ref, key);
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
