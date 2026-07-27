/** Transport-neutral wire contracts for AdaptiveAgent's capability gateway. */
export const PROTOCOL_VERSION = '1.0' as const;

/** Conservative wire limits. Transports may impose lower limits. */
export const PROTOCOL_LIMITS = {
  maxFrameBytes: 1_048_576,
  maxStringBytes: 262_144,
  maxIdentifierBytes: 256,
  maxArrayItems: 128,
  maxObjectKeys: 128,
  maxJsonDepth: 24,
  maxProfiles: 64,
  maxMessages: 128,
  maxTools: 64,
  maxUrlBytes: 4096,
} as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type JsonRpcId = string | number;

export interface JsonRpcRequest<M extends GatewayRequestMethod = GatewayRequestMethod> {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: M;
  params: MethodParams[M];
}

export interface JsonRpcNotification<M extends string = string, P = JsonValue> {
  jsonrpc: '2.0';
  method: M;
  params: P;
}

export interface JsonRpcSuccess<R = JsonValue> {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: R;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  error: JsonRpcError;
}

export type JsonRpcResponse<R = JsonValue> = JsonRpcSuccess<R> | JsonRpcErrorResponse;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: PublicGatewayError;
}

export const GATEWAY_REQUEST_METHODS = [
  'initialize',
  'profile/list',
  'profile/get',
  'run/authorize',
  'model/generate',
  'tool/execute',
  'request/cancel',
  'account/usage',
] as const;

export type GatewayRequestMethod = typeof GATEWAY_REQUEST_METHODS[number];
export type InferenceMode = 'gateway' | 'local' | 'byok';
export const INFERENCE_TIERS = ['low', 'medium', 'high', 'xtra-high'] as const;
export type InferenceTier = typeof INFERENCE_TIERS[number];
export type ProfileSource = 'local' | 'server';

export interface ProfileRef {
  source: ProfileSource;
  id: string;
  version: string;
  contentHash: string;
}

export interface InitializeParams {
  protocolVersion: typeof PROTOCOL_VERSION;
  clientName: string;
  clientVersion: string;
}

export interface RemoteToolDescriptor {
  name: string;
  schemaVersion: string;
}

export interface InitializeResult {
  protocolVersion: typeof PROTOCOL_VERSION;
  serverVersion: string;
  inferenceTiers: InferenceTier[];
  streamEventVersions: string[];
  profileSchemaVersions: string[];
  remoteTools: RemoteToolDescriptor[];
  structuredOutput: boolean;
  cancellation: boolean;
  limits: {
    maxAttachmentBytes: number;
    maxMessages: number;
  };
  account: {
    permittedModes: InferenceMode[];
    tierCeiling?: InferenceTier;
  };
}

export interface ProfileListParams {
  schemaVersion?: string;
}

export interface ProfileSummary {
  ref: ProfileRef;
  name: string;
  description?: string;
  allowedTiers: InferenceTier[];
  remoteCapabilities: string[];
}

export interface ProfileListResult {
  profiles: ProfileSummary[];
}

export interface ProfileGetParams {
  ref: ProfileRef;
}

export interface DeclarativeDelegate {
  id: string;
  instructions?: string;
  tools?: string[];
  delegates?: DeclarativeDelegate[];
  metadata?: JsonObject;
}

export interface DeclarativeProfileBundle {
  ref: ProfileRef;
  schemaVersion: string;
  name: string;
  instructions: string;
  tools?: string[];
  allowedTools?: string[];
  defaults?: JsonObject;
  limits?: JsonObject;
  recoveryPolicy?: JsonObject;
  routingMetadata?: JsonObject;
  capabilities?: string[];
  delegates?: DeclarativeDelegate[];
}

export interface ProfileGetResult {
  bundle: DeclarativeProfileBundle;
}

export interface RunAuthorizeParams {
  runId: string;
  inferenceMode: InferenceMode;
  requestedTier?: InferenceTier;
  profileRefs: ProfileRef[];
}

export interface RunAuthorizeResult {
  permitId: string;
  inferenceMode: InferenceMode;
  inferenceTier?: InferenceTier;
  routePolicyVersion: string;
  remoteCapabilities: string[];
  expiresAt: string;
}

export interface ModelInvocationIdentity {
  runId: string;
  rootRunId: string;
  stepId: string;
  purpose: 'agent_turn' | 'output_repair';
  callId: string;
  attempt: number;
}

export interface ModelToolCall {
  id: string;
  name: string;
  input: JsonValue;
}

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ModelToolCall[];
}

export interface ModelTool {
  name: string;
  description?: string;
  inputSchema: JsonObject;
}

/** Provider and model are intentionally absent: routing is server-owned. */
export interface ModelGenerateParams {
  permitId: string;
  tier: InferenceTier;
  invocation: ModelInvocationIdentity;
  messages: ModelMessage[];
  tools?: ModelTool[];
  responseSchema?: JsonObject;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface UsageSummary {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost?: number;
}

export interface ModelGenerateTimings {
  gatewayDurationMs: number;
  providerDurationMs: number;
  routeAttempts: number;
}

export interface ModelGenerateResult {
  callId: string;
  text?: string;
  structuredOutput?: JsonValue;
  toolCalls?: ModelToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error';
  usage: UsageSummary;
  providerResponseId?: string;
  summary?: string;
  routePolicyVersion: string;
  timings: ModelGenerateTimings;
}

export interface ToolExecuteParams {
  permitId: string;
  idempotencyKey: string;
  toolName: string;
  input: JsonObject;
  timeoutMs?: number;
}

export interface ToolExecuteResult {
  idempotencyKey: string;
  output: JsonValue;
  usage?: {
    units: number;
    cost?: number;
  };
  providerRequestId?: string;
  cacheHit?: boolean;
}

export interface RequestCancelParams {
  callId?: string;
  idempotencyKey?: string;
}

export interface RequestCancelResult {
  cancelled: boolean;
}

export interface AccountUsageParams {
  from: string;
  to: string;
  cursor?: string;
  limit?: number;
}

export interface AccountUsageItem {
  capability: string;
  units: number;
  cost: number;
  occurredAt: string;
}

export interface AccountUsageResult {
  items: AccountUsageItem[];
  nextCursor?: string;
}

export interface MethodParams {
  initialize: InitializeParams;
  'profile/list': ProfileListParams;
  'profile/get': ProfileGetParams;
  'run/authorize': RunAuthorizeParams;
  'model/generate': ModelGenerateParams;
  'tool/execute': ToolExecuteParams;
  'request/cancel': RequestCancelParams;
  'account/usage': AccountUsageParams;
}

export interface MethodResults {
  initialize: InitializeResult;
  'profile/list': ProfileListResult;
  'profile/get': ProfileGetResult;
  'run/authorize': RunAuthorizeResult;
  'model/generate': ModelGenerateResult;
  'tool/execute': ToolExecuteResult;
  'request/cancel': RequestCancelResult;
  'account/usage': AccountUsageResult;
}

export interface StreamStartEvent {
  type: 'start';
}

export interface StreamTextDeltaEvent {
  type: 'text_delta';
  delta: string;
}

export interface StreamToolCallStartEvent {
  type: 'tool_call_start';
  toolCallId: string;
  name: string;
}

export interface StreamToolCallDeltaEvent {
  type: 'tool_call_delta';
  toolCallId: string;
  argumentsDelta: string;
}

export interface StreamToolCallEndEvent {
  type: 'tool_call_end';
  toolCall: ModelToolCall;
}

export interface StreamSummaryEvent {
  type: 'summary';
  summary: string;
}

export interface StreamUsageEvent {
  type: 'usage';
  usage: UsageSummary;
}

export interface StreamDoneEvent {
  type: 'done';
}

export interface StreamErrorEvent {
  type: 'error';
  error: PublicGatewayError;
}

export type ModelStreamEvent =
  | StreamStartEvent
  | StreamTextDeltaEvent
  | StreamToolCallStartEvent
  | StreamToolCallDeltaEvent
  | StreamToolCallEndEvent
  | StreamSummaryEvent
  | StreamUsageEvent
  | StreamDoneEvent
  | StreamErrorEvent;

/** Sequence numbers start at zero and are contiguous for each call ID. */
export interface ModelStreamEnvelope {
  callId: string;
  seq: number;
  event: ModelStreamEvent;
}

export type ModelStreamNotification = JsonRpcNotification<'model/stream', ModelStreamEnvelope>;

export const PUBLIC_GATEWAY_ERROR_CODES = [
  'unauthenticated',
  'token_expired',
  'forbidden',
  'tier_not_entitled',
  'capability_not_entitled',
  'invalid_params',
  'idempotency_conflict',
  'quota_exceeded',
  'rate_limited',
  'provider_unavailable',
  'provider_timeout',
  'cancelled',
  'internal_error',
] as const;

export type PublicGatewayErrorCode = typeof PUBLIC_GATEWAY_ERROR_CODES[number];

export interface PublicGatewayError {
  gatewayCode: PublicGatewayErrorCode;
  retryable: boolean;
  retryAfterMs?: number;
  callId?: string;
  idempotencyKey?: string;
  traceId: string;
}

export class ProtocolValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolValidationError';
  }
}

const textEncoder = new TextEncoder();

function fail(message: string): never {
  throw new ProtocolValidationError(message);
}

function record(value: unknown, at: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${at} must be an object`);
  }

  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    fail(`${at} must not contain binary data`);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${at} must be a plain JSON object`);
  }

  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], at: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail(`${at} contains unknown field ${key}`);
    }
  }
}

function boundedString(
  value: unknown,
  at: string,
  options: { max?: number; allowEmpty?: boolean } = {},
): string {
  const max = options.max ?? PROTOCOL_LIMITS.maxIdentifierBytes;
  if (
    typeof value !== 'string' ||
    (!options.allowEmpty && value.length === 0) ||
    textEncoder.encode(value).length > max
  ) {
    fail(`${at} must be a${options.allowEmpty ? '' : ' non-empty'} bounded string`);
  }
  return value as string;
}

function safeInteger(value: unknown, at: string, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) {
    fail(`${at} must be a safe integer >= ${min}`);
  }
  return value as number;
}

function finiteNumber(value: unknown, at: string, min?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (min !== undefined && value < min)) {
    fail(`${at} must be a finite number${min === undefined ? '' : ` >= ${min}`}`);
  }
  return value;
}

function boolean(value: unknown, at: string): boolean {
  if (typeof value !== 'boolean') {
    fail(`${at} must be boolean`);
  }
  return value as boolean;
}

function inferenceMode(value: unknown, at: string): InferenceMode {
  if (value !== 'gateway' && value !== 'local' && value !== 'byok') {
    fail(`${at} is an unknown inference mode`);
  }
  return value;
}

function inferenceTier(value: unknown, at: string): InferenceTier {
  if (!INFERENCE_TIERS.includes(value as InferenceTier)) {
    fail(`${at} is an unknown tier`);
  }
  return value as InferenceTier;
}

function boundedArray(
  value: unknown,
  at: string,
  max: number = PROTOCOL_LIMITS.maxArrayItems,
): unknown[] {
  if (!Array.isArray(value) || value.length > max) {
    fail(`${at} must be a bounded array`);
  }
  return value;
}

function validateStringArray(
  value: unknown,
  at: string,
  max: number = PROTOCOL_LIMITS.maxArrayItems,
): void {
  boundedArray(value, at, max).forEach((entry, index) => {
    boundedString(entry, `${at}[${index}]`);
  });
}

function validateJsonValue(
  value: unknown,
  at: string,
  depth = 0,
  ancestors: Set<object> = new Set(),
): void {
  if (depth > PROTOCOL_LIMITS.maxJsonDepth) {
    fail(`${at} exceeds JSON depth`);
  }

  if (value === null || typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'string') {
    boundedString(value, at, { max: PROTOCOL_LIMITS.maxStringBytes, allowEmpty: true });
    return;
  }
  if (typeof value === 'number') {
    finiteNumber(value, at);
    return;
  }
  if (typeof value !== 'object') {
    fail(`${at} contains a non-JSON value`);
  }
  if (ancestors.has(value)) {
    fail(`${at} contains a cycle`);
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    boundedArray(value, at).forEach((entry, index) => {
      validateJsonValue(entry, `${at}[${index}]`, depth + 1, ancestors);
    });
  } else {
    const object = record(value, at);
    if (Object.keys(object).length > PROTOCOL_LIMITS.maxObjectKeys) {
      fail(`${at} object is oversized`);
    }
    for (const [key, entry] of Object.entries(object)) {
      boundedString(key, `${at} key`, { allowEmpty: true });
      validateJsonValue(entry, `${at}.${key}`, depth + 1, ancestors);
    }
  }
  ancestors.delete(value);
}

function validateFrame(value: unknown, at: string): void {
  validateJsonValue(value, at);
  if (textEncoder.encode(JSON.stringify(value)).length > PROTOCOL_LIMITS.maxFrameBytes) {
    fail(`${at} exceeds frame limit`);
  }
}

function validateRpcId(value: unknown, at: string, allowNull = false): void {
  if (allowNull && value === null) {
    return;
  }
  if (typeof value === 'string') {
    boundedString(value, at);
    return;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return;
  }
  fail(`${at} is invalid`);
}

function validateProfileRef(value: unknown, at: string): void {
  const ref = record(value, at);
  exactKeys(ref, ['source', 'id', 'version', 'contentHash'], at);
  if (ref.source !== 'local' && ref.source !== 'server') {
    fail(`${at}.source is invalid`);
  }
  boundedString(ref.id, `${at}.id`);
  boundedString(ref.version, `${at}.version`);
  boundedString(ref.contentHash, `${at}.contentHash`);
}

function validateModelInvocation(value: unknown, at: string): void {
  const invocation = record(value, at);
  exactKeys(invocation, ['runId', 'rootRunId', 'stepId', 'purpose', 'callId', 'attempt'], at);
  boundedString(invocation.runId, `${at}.runId`);
  boundedString(invocation.rootRunId, `${at}.rootRunId`);
  boundedString(invocation.stepId, `${at}.stepId`);
  boundedString(invocation.callId, `${at}.callId`);
  if (invocation.purpose !== 'agent_turn' && invocation.purpose !== 'output_repair') {
    fail(`${at}.purpose is invalid`);
  }
  safeInteger(invocation.attempt, `${at}.attempt`, 1);
}

function validateModelToolCall(value: unknown, at: string): void {
  const toolCall = record(value, at);
  exactKeys(toolCall, ['id', 'name', 'input'], at);
  boundedString(toolCall.id, `${at}.id`);
  boundedString(toolCall.name, `${at}.name`);
  validateJsonValue(toolCall.input, `${at}.input`);
}

function validateUsage(value: unknown, at: string): void {
  const usage = record(value, at);
  exactKeys(usage, ['provider', 'model', 'inputTokens', 'outputTokens', 'totalTokens', 'cost'], at);
  boundedString(usage.provider, `${at}.provider`);
  boundedString(usage.model, `${at}.model`);
  safeInteger(usage.inputTokens, `${at}.inputTokens`);
  safeInteger(usage.outputTokens, `${at}.outputTokens`);
  safeInteger(usage.totalTokens, `${at}.totalTokens`);
  if (usage.cost !== undefined) {
    finiteNumber(usage.cost, `${at}.cost`, 0);
  }
}

function validateRequestParams(method: GatewayRequestMethod, value: unknown): void {
  const params = record(value, 'params');
  const allowedFields: Record<GatewayRequestMethod, readonly string[]> = {
    initialize: ['protocolVersion', 'clientName', 'clientVersion'],
    'profile/list': ['schemaVersion'],
    'profile/get': ['ref'],
    'run/authorize': ['runId', 'inferenceMode', 'requestedTier', 'profileRefs'],
    'model/generate': [
      'permitId',
      'tier',
      'invocation',
      'messages',
      'tools',
      'responseSchema',
      'temperature',
      'maxOutputTokens',
    ],
    'tool/execute': ['permitId', 'idempotencyKey', 'toolName', 'input', 'timeoutMs'],
    'request/cancel': ['callId', 'idempotencyKey'],
    'account/usage': ['from', 'to', 'cursor', 'limit'],
  };
  exactKeys(params, allowedFields[method], 'params');

  switch (method) {
    case 'initialize':
      if (params.protocolVersion !== PROTOCOL_VERSION) {
        fail('unsupported protocol version');
      }
      boundedString(params.clientName, 'params.clientName');
      boundedString(params.clientVersion, 'params.clientVersion');
      return;
    case 'profile/list':
      if (params.schemaVersion !== undefined) {
        boundedString(params.schemaVersion, 'params.schemaVersion');
      }
      return;
    case 'profile/get':
      validateProfileRef(params.ref, 'params.ref');
      return;
    case 'run/authorize':
      boundedString(params.runId, 'params.runId');
      inferenceMode(params.inferenceMode, 'params.inferenceMode');
      if (params.requestedTier !== undefined) {
        inferenceTier(params.requestedTier, 'params.requestedTier');
      }
      boundedArray(params.profileRefs, 'params.profileRefs', PROTOCOL_LIMITS.maxProfiles)
        .forEach((entry, index) => validateProfileRef(entry, `params.profileRefs[${index}]`));
      return;
    case 'model/generate':
      validateModelGenerateParams(params);
      return;
    case 'tool/execute':
      boundedString(params.permitId, 'params.permitId');
      boundedString(params.idempotencyKey, 'params.idempotencyKey');
      boundedString(params.toolName, 'params.toolName');
      record(params.input, 'params.input');
      if (params.timeoutMs !== undefined) {
        safeInteger(params.timeoutMs, 'params.timeoutMs');
      }
      return;
    case 'request/cancel':
      if (params.callId === undefined && params.idempotencyKey === undefined) {
        fail('cancellation requires an identifier');
      }
      if (params.callId !== undefined) {
        boundedString(params.callId, 'params.callId');
      }
      if (params.idempotencyKey !== undefined) {
        boundedString(params.idempotencyKey, 'params.idempotencyKey');
      }
      return;
    case 'account/usage':
      boundedString(params.from, 'params.from');
      boundedString(params.to, 'params.to');
      if (params.cursor !== undefined) {
        boundedString(params.cursor, 'params.cursor');
      }
      if (params.limit !== undefined) {
        const limit = safeInteger(params.limit, 'params.limit', 1);
        if (limit > PROTOCOL_LIMITS.maxArrayItems) {
          fail('params.limit is oversized');
        }
      }
  }
}

function validateModelGenerateParams(params: Record<string, unknown>): void {
  boundedString(params.permitId, 'params.permitId');
  inferenceTier(params.tier, 'params.tier');
  validateModelInvocation(params.invocation, 'params.invocation');
  boundedArray(params.messages, 'params.messages', PROTOCOL_LIMITS.maxMessages)
    .forEach((entry, index) => validateModelMessage(entry, `params.messages[${index}]`));
  if ((params.messages as unknown[]).length === 0) {
    fail('params.messages must not be empty');
  }

  if (params.tools !== undefined) {
    boundedArray(params.tools, 'params.tools', PROTOCOL_LIMITS.maxTools)
      .forEach((entry, index) => validateModelTool(entry, `params.tools[${index}]`));
  }
  if (params.responseSchema !== undefined) {
    record(params.responseSchema, 'params.responseSchema');
  }
  if (params.temperature !== undefined) {
    finiteNumber(params.temperature, 'params.temperature');
  }
  if (params.maxOutputTokens !== undefined) {
    safeInteger(params.maxOutputTokens, 'params.maxOutputTokens', 1);
  }
}

function validateModelMessage(value: unknown, at: string): void {
  const message = record(value, at);
  exactKeys(message, ['role', 'content', 'name', 'toolCallId', 'toolCalls'], at);
  if (message.role !== 'system' && message.role !== 'user' && message.role !== 'assistant' && message.role !== 'tool') {
    fail(`${at}.role is invalid`);
  }
  boundedString(message.content, `${at}.content`, {
    max: PROTOCOL_LIMITS.maxStringBytes,
    allowEmpty: true,
  });
  if (message.name !== undefined) {
    boundedString(message.name, `${at}.name`);
  }
  if (message.toolCallId !== undefined) {
    boundedString(message.toolCallId, `${at}.toolCallId`);
  }
  if (message.toolCalls !== undefined) {
    boundedArray(message.toolCalls, `${at}.toolCalls`, PROTOCOL_LIMITS.maxTools)
      .forEach((entry, index) => validateModelToolCall(entry, `${at}.toolCalls[${index}]`));
  }
}

function validateModelTool(value: unknown, at: string): void {
  const tool = record(value, at);
  exactKeys(tool, ['name', 'description', 'inputSchema'], at);
  boundedString(tool.name, `${at}.name`);
  if (tool.description !== undefined) {
    boundedString(tool.description, `${at}.description`, { max: PROTOCOL_LIMITS.maxStringBytes });
  }
  record(tool.inputSchema, `${at}.inputSchema`);
  validateJsonValue(tool.inputSchema, `${at}.inputSchema`);
}

/** Validates an already-decoded single request. Batches and binary-equivalent inputs are rejected. */
export function validateRpcRequest(value: unknown): JsonRpcRequest {
  const request = record(value, 'request');
  exactKeys(request, ['jsonrpc', 'id', 'method', 'params'], 'request');
  if (request.jsonrpc !== '2.0') {
    fail('request.jsonrpc must be 2.0');
  }
  validateRpcId(request.id, 'request.id');
  const method = boundedString(request.method, 'request.method') as GatewayRequestMethod;
  if (!GATEWAY_REQUEST_METHODS.includes(method)) {
    fail('request method is unsupported');
  }
  validateRequestParams(method, request.params);
  validateFrame(value, 'request');
  return value as JsonRpcRequest;
}

/** Validates a terminal JSON-RPC response using the originating request method. */
export function validateRpcResponse<M extends GatewayRequestMethod>(
  method: M,
  value: unknown,
): JsonRpcResponse<MethodResults[M]> {
  const response = record(value, 'response');
  if (response.jsonrpc !== '2.0') {
    fail('response.jsonrpc must be 2.0');
  }

  if (Object.prototype.hasOwnProperty.call(response, 'result')) {
    exactKeys(response, ['jsonrpc', 'id', 'result'], 'response');
    validateRpcId(response.id, 'response.id');
    validateMethodResult(method, response.result);
  } else {
    exactKeys(response, ['jsonrpc', 'id', 'error'], 'response');
    validateRpcId(response.id, 'response.id', true);
    validateJsonRpcError(response.error, 'response.error');
  }

  validateFrame(value, 'response');
  return value as JsonRpcResponse<MethodResults[M]>;
}

function validateJsonRpcError(value: unknown, at: string): void {
  const error = record(value, at);
  exactKeys(error, ['code', 'message', 'data'], at);
  if (!Number.isSafeInteger(error.code)) {
    fail(`${at}.code must be a safe integer`);
  }
  boundedString(error.message, `${at}.message`, { max: PROTOCOL_LIMITS.maxStringBytes });
  if (error.data !== undefined) {
    validatePublicGatewayError(error.data);
  }
}

function validateMethodResult(method: GatewayRequestMethod, value: unknown): void {
  switch (method) {
    case 'initialize':
      validateInitializeResult(value);
      return;
    case 'profile/list':
      validateProfileListResult(value);
      return;
    case 'profile/get': {
      const result = record(value, 'result');
      exactKeys(result, ['bundle'], 'result');
      validateDeclarativeProfileBundle(result.bundle);
      return;
    }
    case 'run/authorize':
      validateRunAuthorizeResult(value);
      return;
    case 'model/generate':
      validateModelGenerateResult(value);
      return;
    case 'tool/execute':
      validateToolExecuteResult(value);
      return;
    case 'request/cancel': {
      const result = record(value, 'result');
      exactKeys(result, ['cancelled'], 'result');
      boolean(result.cancelled, 'result.cancelled');
      return;
    }
    case 'account/usage':
      validateAccountUsageResult(value);
  }
}

function validateInitializeResult(value: unknown): void {
  const result = record(value, 'result');
  exactKeys(result, [
    'protocolVersion',
    'serverVersion',
    'inferenceTiers',
    'streamEventVersions',
    'profileSchemaVersions',
    'remoteTools',
    'structuredOutput',
    'cancellation',
    'limits',
    'account',
  ], 'result');
  if (result.protocolVersion !== PROTOCOL_VERSION) {
    fail('result.protocolVersion is unsupported');
  }
  boundedString(result.serverVersion, 'result.serverVersion');
  boundedArray(result.inferenceTiers, 'result.inferenceTiers')
    .forEach((entry, index) => inferenceTier(entry, `result.inferenceTiers[${index}]`));
  validateStringArray(result.streamEventVersions, 'result.streamEventVersions');
  validateStringArray(result.profileSchemaVersions, 'result.profileSchemaVersions');
  boundedArray(result.remoteTools, 'result.remoteTools', PROTOCOL_LIMITS.maxTools).forEach((entry, index) => {
    const tool = record(entry, `result.remoteTools[${index}]`);
    exactKeys(tool, ['name', 'schemaVersion'], `result.remoteTools[${index}]`);
    boundedString(tool.name, `result.remoteTools[${index}].name`);
    boundedString(tool.schemaVersion, `result.remoteTools[${index}].schemaVersion`);
  });
  boolean(result.structuredOutput, 'result.structuredOutput');
  boolean(result.cancellation, 'result.cancellation');
  const limits = record(result.limits, 'result.limits');
  exactKeys(limits, ['maxAttachmentBytes', 'maxMessages'], 'result.limits');
  safeInteger(limits.maxAttachmentBytes, 'result.limits.maxAttachmentBytes');
  safeInteger(limits.maxMessages, 'result.limits.maxMessages');
  const account = record(result.account, 'result.account');
  exactKeys(account, ['permittedModes', 'tierCeiling'], 'result.account');
  boundedArray(account.permittedModes, 'result.account.permittedModes').forEach((entry, index) => {
    inferenceMode(entry, `result.account.permittedModes[${index}]`);
  });
  if (account.tierCeiling !== undefined) {
    inferenceTier(account.tierCeiling, 'result.account.tierCeiling');
  }
}

function validateProfileListResult(value: unknown): void {
  const result = record(value, 'result');
  exactKeys(result, ['profiles'], 'result');
  boundedArray(result.profiles, 'result.profiles', PROTOCOL_LIMITS.maxProfiles).forEach((entry, index) => {
    const profile = record(entry, `result.profiles[${index}]`);
    exactKeys(profile, ['ref', 'name', 'description', 'allowedTiers', 'remoteCapabilities'], `result.profiles[${index}]`);
    validateProfileRef(profile.ref, `result.profiles[${index}].ref`);
    boundedString(profile.name, `result.profiles[${index}].name`);
    if (profile.description !== undefined) {
      boundedString(profile.description, `result.profiles[${index}].description`, {
        max: PROTOCOL_LIMITS.maxStringBytes,
      });
    }
    boundedArray(profile.allowedTiers, `result.profiles[${index}].allowedTiers`).forEach((tier, tierIndex) => {
      inferenceTier(tier, `result.profiles[${index}].allowedTiers[${tierIndex}]`);
    });
    validateStringArray(profile.remoteCapabilities, `result.profiles[${index}].remoteCapabilities`);
  });
}

function validateRunAuthorizeResult(value: unknown): void {
  const result = record(value, 'result');
  exactKeys(result, [
    'permitId',
    'inferenceMode',
    'inferenceTier',
    'routePolicyVersion',
    'remoteCapabilities',
    'expiresAt',
  ], 'result');
  boundedString(result.permitId, 'result.permitId');
  inferenceMode(result.inferenceMode, 'result.inferenceMode');
  if (result.inferenceTier !== undefined) {
    inferenceTier(result.inferenceTier, 'result.inferenceTier');
  }
  boundedString(result.routePolicyVersion, 'result.routePolicyVersion');
  validateStringArray(result.remoteCapabilities, 'result.remoteCapabilities');
  boundedString(result.expiresAt, 'result.expiresAt');
}

function validateModelGenerateResult(value: unknown): void {
  const result = record(value, 'result');
  exactKeys(result, [
    'callId',
    'text',
    'structuredOutput',
    'toolCalls',
    'finishReason',
    'usage',
    'providerResponseId',
    'summary',
    'routePolicyVersion',
    'timings',
  ], 'result');
  boundedString(result.callId, 'result.callId');
  if (result.text !== undefined) {
    boundedString(result.text, 'result.text', { max: PROTOCOL_LIMITS.maxStringBytes, allowEmpty: true });
  }
  if (result.structuredOutput !== undefined) {
    validateJsonValue(result.structuredOutput, 'result.structuredOutput');
  }
  if (result.toolCalls !== undefined) {
    boundedArray(result.toolCalls, 'result.toolCalls', PROTOCOL_LIMITS.maxTools)
      .forEach((entry, index) => validateModelToolCall(entry, `result.toolCalls[${index}]`));
  }
  if (!['stop', 'tool_calls', 'length', 'content_filter', 'error'].includes(result.finishReason as string)) {
    fail('result.finishReason is invalid');
  }
  validateUsage(result.usage, 'result.usage');
  if (result.providerResponseId !== undefined) {
    boundedString(result.providerResponseId, 'result.providerResponseId');
  }
  if (result.summary !== undefined) {
    boundedString(result.summary, 'result.summary', { max: PROTOCOL_LIMITS.maxStringBytes });
  }
  boundedString(result.routePolicyVersion, 'result.routePolicyVersion');
  const timings = record(result.timings, 'result.timings');
  exactKeys(timings, ['gatewayDurationMs', 'providerDurationMs', 'routeAttempts'], 'result.timings');
  finiteNumber(timings.gatewayDurationMs, 'result.timings.gatewayDurationMs', 0);
  finiteNumber(timings.providerDurationMs, 'result.timings.providerDurationMs', 0);
  safeInteger(timings.routeAttempts, 'result.timings.routeAttempts', 1);
}

function validateToolExecuteResult(value: unknown): void {
  const result = record(value, 'result');
  exactKeys(result, ['idempotencyKey', 'output', 'usage', 'providerRequestId', 'cacheHit'], 'result');
  boundedString(result.idempotencyKey, 'result.idempotencyKey');
  validateJsonValue(result.output, 'result.output');
  if (result.usage !== undefined) {
    const usage = record(result.usage, 'result.usage');
    exactKeys(usage, ['units', 'cost'], 'result.usage');
    finiteNumber(usage.units, 'result.usage.units', 0);
    if (usage.cost !== undefined) {
      finiteNumber(usage.cost, 'result.usage.cost', 0);
    }
  }
  if (result.providerRequestId !== undefined) {
    boundedString(result.providerRequestId, 'result.providerRequestId');
  }
  if (result.cacheHit !== undefined) {
    boolean(result.cacheHit, 'result.cacheHit');
  }
}

function validateAccountUsageResult(value: unknown): void {
  const result = record(value, 'result');
  exactKeys(result, ['items', 'nextCursor'], 'result');
  boundedArray(result.items, 'result.items').forEach((entry, index) => {
    const item = record(entry, `result.items[${index}]`);
    exactKeys(item, ['capability', 'units', 'cost', 'occurredAt'], `result.items[${index}]`);
    boundedString(item.capability, `result.items[${index}].capability`);
    finiteNumber(item.units, `result.items[${index}].units`, 0);
    finiteNumber(item.cost, `result.items[${index}].cost`, 0);
    boundedString(item.occurredAt, `result.items[${index}].occurredAt`);
  });
  if (result.nextCursor !== undefined) {
    boundedString(result.nextCursor, 'result.nextCursor');
  }
}

export function validatePublicGatewayError(value: unknown): PublicGatewayError {
  const error = record(value, 'error');
  exactKeys(error, [
    'gatewayCode',
    'retryable',
    'retryAfterMs',
    'callId',
    'idempotencyKey',
    'traceId',
  ], 'error');
  if (!PUBLIC_GATEWAY_ERROR_CODES.includes(error.gatewayCode as PublicGatewayErrorCode)) {
    fail('unknown public gateway error');
  }
  boolean(error.retryable, 'error.retryable');
  boundedString(error.traceId, 'error.traceId');
  if (error.retryAfterMs !== undefined) {
    safeInteger(error.retryAfterMs, 'error.retryAfterMs');
  }
  if (error.callId !== undefined) {
    boundedString(error.callId, 'error.callId');
  }
  if (error.idempotencyKey !== undefined) {
    boundedString(error.idempotencyKey, 'error.idempotencyKey');
  }
  return value as PublicGatewayError;
}

export function validateModelStreamEnvelope(value: unknown): ModelStreamEnvelope {
  const envelope = record(value, 'stream');
  exactKeys(envelope, ['callId', 'seq', 'event'], 'stream');
  boundedString(envelope.callId, 'stream.callId');
  safeInteger(envelope.seq, 'stream.seq');
  validateModelStreamEvent(envelope.event);
  validateFrame(value, 'stream');
  return value as ModelStreamEnvelope;
}

function validateModelStreamEvent(value: unknown): void {
  const event = record(value, 'stream.event');
  const fields: Record<ModelStreamEvent['type'], readonly string[]> = {
    start: ['type'],
    text_delta: ['type', 'delta'],
    tool_call_start: ['type', 'toolCallId', 'name'],
    tool_call_delta: ['type', 'toolCallId', 'argumentsDelta'],
    tool_call_end: ['type', 'toolCall'],
    summary: ['type', 'summary'],
    usage: ['type', 'usage'],
    done: ['type'],
    error: ['type', 'error'],
  };
  if (typeof event.type !== 'string' || !(event.type in fields)) {
    fail('unknown stream event');
  }
  exactKeys(event, fields[event.type as ModelStreamEvent['type']], 'stream.event');

  switch (event.type) {
    case 'text_delta':
      boundedString(event.delta, 'stream.event.delta', {
        max: PROTOCOL_LIMITS.maxStringBytes,
        allowEmpty: true,
      });
      return;
    case 'tool_call_start':
      boundedString(event.toolCallId, 'stream.event.toolCallId');
      boundedString(event.name, 'stream.event.name');
      return;
    case 'tool_call_delta':
      boundedString(event.toolCallId, 'stream.event.toolCallId');
      boundedString(event.argumentsDelta, 'stream.event.argumentsDelta', {
        max: PROTOCOL_LIMITS.maxStringBytes,
        allowEmpty: true,
      });
      return;
    case 'tool_call_end':
      validateModelToolCall(event.toolCall, 'stream.event.toolCall');
      return;
    case 'summary':
      boundedString(event.summary, 'stream.event.summary', { max: PROTOCOL_LIMITS.maxStringBytes });
      return;
    case 'usage':
      validateUsage(event.usage, 'stream.event.usage');
      return;
    case 'error':
      validatePublicGatewayError(event.error);
  }
}

export function validateModelStreamNotification(value: unknown): ModelStreamNotification {
  const notification = record(value, 'notification');
  exactKeys(notification, ['jsonrpc', 'method', 'params'], 'notification');
  if (notification.jsonrpc !== '2.0') {
    fail('notification.jsonrpc must be 2.0');
  }
  if (notification.method !== 'model/stream') {
    fail('notification method is unsupported');
  }
  validateModelStreamEnvelope(notification.params);
  validateFrame(value, 'notification');
  return value as ModelStreamNotification;
}

export class StreamSequenceValidator {
  private nextSequence = 0;
  private terminal = false;
  private usageSeen = false;
  private readonly activeToolCalls = new Set<string>();

  constructor(private readonly callId: string) {
    boundedString(callId, 'callId');
  }

  accept(value: unknown): ModelStreamEnvelope {
    const envelope = validateModelStreamEnvelope(value);
    if (this.terminal) {
      fail('stream already terminated');
    }
    if (envelope.callId !== this.callId) {
      fail('stream callId changed');
    }
    if (envelope.seq !== this.nextSequence) {
      fail(`stream sequence must be contiguous at ${this.nextSequence}`);
    }
    if (this.nextSequence === 0 && envelope.event.type !== 'start') {
      fail('stream must start with start');
    }
    if (this.nextSequence > 0 && envelope.event.type === 'start') {
      fail('duplicate stream start');
    }

    this.validateEventOrder(envelope.event);
    this.nextSequence += 1;
    if (envelope.event.type === 'done' || envelope.event.type === 'error') {
      this.terminal = true;
    }
    return envelope;
  }

  assertTerminal(): void {
    if (!this.terminal) {
      fail('stream has no terminal done or error event');
    }
  }

  private validateEventOrder(event: ModelStreamEvent): void {
    if (event.type === 'tool_call_start') {
      if (this.activeToolCalls.has(event.toolCallId)) {
        fail(`tool call ${event.toolCallId} already started`);
      }
      this.activeToolCalls.add(event.toolCallId);
      return;
    }
    if (event.type === 'tool_call_delta') {
      if (!this.activeToolCalls.has(event.toolCallId)) {
        fail(`tool call ${event.toolCallId} has not started`);
      }
      return;
    }
    if (event.type === 'tool_call_end') {
      if (!this.activeToolCalls.delete(event.toolCall.id)) {
        fail(`tool call ${event.toolCall.id} has not started`);
      }
      return;
    }
    if (event.type === 'usage') {
      if (this.usageSeen) {
        fail('stream usage may be emitted only once');
      }
      this.usageSeen = true;
      return;
    }
    if (event.type === 'done' && this.activeToolCalls.size > 0) {
      fail('stream ended with incomplete tool calls');
    }
  }
}

const forbiddenDeclarativeFields = new Set([
  'handler',
  'handlertools',
  'module',
  'modulepath',
  'executablemodule',
  'install',
  'installcommand',
  'scripts',
  'hooks',
  'credentials',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'token',
]);

/** Validates declarative profile data and recursively rejects executable or credential fields. */
export function validateDeclarativeProfileBundle(value: unknown): DeclarativeProfileBundle {
  const profile = record(value, 'profile');
  validateFrame(value, 'profile');
  exactKeys(profile, [
    'ref',
    'schemaVersion',
    'name',
    'instructions',
    'tools',
    'allowedTools',
    'defaults',
    'limits',
    'recoveryPolicy',
    'routingMetadata',
    'capabilities',
    'delegates',
  ], 'profile');
  validateProfileRef(profile.ref, 'profile.ref');
  boundedString(profile.schemaVersion, 'profile.schemaVersion');
  boundedString(profile.name, 'profile.name');
  boundedString(profile.instructions, 'profile.instructions', { max: PROTOCOL_LIMITS.maxStringBytes });
  validateOptionalStringArray(profile.tools, 'profile.tools');
  validateOptionalStringArray(profile.allowedTools, 'profile.allowedTools');
  validateOptionalStringArray(profile.capabilities, 'profile.capabilities');
  validateOptionalJsonObject(profile.defaults, 'profile.defaults');
  validateOptionalJsonObject(profile.limits, 'profile.limits');
  validateOptionalJsonObject(profile.recoveryPolicy, 'profile.recoveryPolicy');
  validateOptionalJsonObject(profile.routingMetadata, 'profile.routingMetadata');
  if (profile.delegates !== undefined) {
    boundedArray(profile.delegates, 'profile.delegates')
      .forEach((entry, index) => validateDeclarativeDelegate(entry, `profile.delegates[${index}]`));
  }
  rejectForbiddenDeclarativeFields(value, 'profile');
  return value as DeclarativeProfileBundle;
}

function validateDeclarativeDelegate(value: unknown, at: string): void {
  const delegate = record(value, at);
  exactKeys(delegate, ['id', 'instructions', 'tools', 'delegates', 'metadata'], at);
  boundedString(delegate.id, `${at}.id`);
  if (delegate.instructions !== undefined) {
    boundedString(delegate.instructions, `${at}.instructions`, { max: PROTOCOL_LIMITS.maxStringBytes });
  }
  validateOptionalStringArray(delegate.tools, `${at}.tools`);
  validateOptionalJsonObject(delegate.metadata, `${at}.metadata`);
  if (delegate.delegates !== undefined) {
    boundedArray(delegate.delegates, `${at}.delegates`)
      .forEach((entry, index) => validateDeclarativeDelegate(entry, `${at}.delegates[${index}]`));
  }
}

function validateOptionalStringArray(value: unknown, at: string): void {
  if (value !== undefined) {
    validateStringArray(value, at);
  }
}

function validateOptionalJsonObject(value: unknown, at: string): void {
  if (value !== undefined) {
    record(value, at);
    validateJsonValue(value, at);
  }
}

function rejectForbiddenDeclarativeFields(value: unknown, at: string, depth = 0): void {
  if (depth > PROTOCOL_LIMITS.maxJsonDepth || value === null || typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectForbiddenDeclarativeFields(entry, `${at}[${index}]`, depth + 1));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (forbiddenDeclarativeFields.has(normalizedKey)) {
      fail(`${at}.${key} is prohibited`);
    }
    rejectForbiddenDeclarativeFields(entry, `${at}.${key}`, depth + 1);
  }
}
