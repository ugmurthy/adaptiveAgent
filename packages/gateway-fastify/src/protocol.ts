import type { ContinuationStrategy, ImageDetail, ImageInput, JsonObject, JsonValue } from './core.js';
import type { InvocationMode } from './config.js';

export const INBOUND_FRAME_TYPES = [
  'session.open',
  'message.send',
  'run.start',
  'run.retry',
  'run.continue',
  'approval.resolve',
  'clarification.resolve',
  'channel.subscribe',
  'session.close',
  'ping',
] as const;

export const OUTBOUND_FRAME_TYPES = [
  'session.opened',
  'session.updated',
  'agent.event',
  'message.output',
  'run.output',
  'approval.requested',
  'error',
  'pong',
] as const;

export const PROTOCOL_ERROR_CODES = [
  'invalid_json',
  'invalid_frame',
  'unknown_frame_type',
  'unsupported_frame',
  'auth_required',
  'invalid_token',
  'token_expired',
  'session_not_found',
  'session_forbidden',
  'session_busy',
  'approval_required',
  'gateway_overloaded',
  'route_not_found',
  'run_failed',
] as const;

export type InboundFrameType = (typeof INBOUND_FRAME_TYPES)[number];
export type OutboundFrameType = (typeof OUTBOUND_FRAME_TYPES)[number];
export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];
export type SessionStatus = 'idle' | 'running' | 'awaiting_approval' | 'closed' | 'failed';

export interface SessionOpenFrame {
  type: 'session.open';
  sessionId?: string;
  rootRunId?: string;
  channelId: string;
  metadata?: JsonObject;
}

export interface MessageSendFrame {
  type: 'message.send';
  sessionId: string;
  content: string;
  images?: GatewayImageInput[];
  metadata?: JsonObject;
}

export interface RunStartFrame {
  type: 'run.start';
  sessionId?: string;
  agentId?: string;
  goal: string;
  input?: JsonValue;
  images?: GatewayImageInput[];
  context?: JsonObject;
  metadata?: JsonObject;
}

export interface UploadedImageInput {
  uploadId: string;
  mimeType?: string;
  detail?: ImageDetail;
  name?: string;
}

export type GatewayImageInput = ImageInput | UploadedImageInput;

export interface RunRetryFrame {
  type: 'run.retry';
  sessionId?: string;
  runId: string;
  metadata?: JsonObject;
}

export interface RunContinueFrame {
  type: 'run.continue';
  sessionId?: string;
  runId?: string;
  strategy?: ContinuationStrategy;
  provider?: string;
  model?: string;
  requireApproval?: boolean;
  metadata?: JsonObject;
}

export interface ApprovalResolveFrame {
  type: 'approval.resolve';
  sessionId: string;
  runId: string;
  approved: boolean;
  metadata?: JsonObject;
}

export interface ClarificationResolveFrame {
  type: 'clarification.resolve';
  sessionId: string;
  runId: string;
  message: string;
  metadata?: JsonObject;
}

export interface ChannelSubscribeFrame {
  type: 'channel.subscribe';
  channels: string[];
}

export interface SessionCloseFrame {
  type: 'session.close';
  sessionId: string;
}

export interface PingFrame {
  type: 'ping';
  id?: string;
}

export type InboundFrame =
  | SessionOpenFrame
  | MessageSendFrame
  | RunStartFrame
  | RunRetryFrame
  | RunContinueFrame
  | ApprovalResolveFrame
  | ClarificationResolveFrame
  | ChannelSubscribeFrame
  | SessionCloseFrame
  | PingFrame;

export interface SessionOpenedFrame {
  type: 'session.opened';
  sessionId: string;
  channelId: string;
  agentId?: string;
  invocationMode?: InvocationMode;
  status: SessionStatus;
}

export interface SessionUpdatedFrame {
  type: 'session.updated';
  sessionId: string;
  status: SessionStatus;
  invocationMode?: InvocationMode;
  transcriptVersion: number;
  activeRunId?: string;
  activeRootRunId?: string;
}

export interface AgentEventFrame {
  type: 'agent.event';
  eventType: string;
  data: JsonValue;
  seq?: number;
  stepId?: string;
  createdAt?: string;
  sessionId?: string;
  agentId?: string;
  runId?: string;
  rootRunId?: string;
  parentRunId?: string;
}

export interface MessageOutputFrame {
  type: 'message.output';
  sessionId: string;
  runId?: string;
  rootRunId?: string;
  message: {
    role: 'assistant';
    content: string;
  };
}

export interface RunOutputFrame {
  type: 'run.output';
  runId: string;
  rootRunId?: string;
  sessionId?: string;
  status: 'succeeded' | 'failed';
  output?: JsonValue;
  error?: string;
}

export interface ApprovalRequestedFrame {
  type: 'approval.requested';
  runId: string;
  rootRunId: string;
  sessionId?: string;
  toolName?: string;
  reason?: string;
}

export interface ErrorFrame {
  type: 'error';
  code: ProtocolErrorCode;
  message: string;
  requestType?: string;
  details?: JsonObject;
}

export interface PongFrame {
  type: 'pong';
  id?: string;
}

export type OutboundFrame =
  | SessionOpenedFrame
  | SessionUpdatedFrame
  | AgentEventFrame
  | MessageOutputFrame
  | RunOutputFrame
  | ApprovalRequestedFrame
  | ErrorFrame
  | PongFrame;

export class ProtocolValidationError extends Error {
  readonly code: ProtocolErrorCode;
  readonly requestType?: string;
  readonly details?: JsonObject;

  constructor(code: ProtocolErrorCode, message: string, options: { requestType?: string; details?: JsonObject } = {}) {
    super(message);
    this.name = 'ProtocolValidationError';
    this.code = code;
    this.requestType = options.requestType;
    this.details = options.details;
  }
}

export function parseInboundFrame(raw: unknown): InboundFrame {
  const text = decodeWebSocketPayload(raw);
  let parsedValue: unknown;

  try {
    parsedValue = JSON.parse(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProtocolValidationError('invalid_json', `Inbound WebSocket payload must be valid JSON: ${message}`);
  }

  return validateInboundFrame(parsedValue);
}

export function validateInboundFrame(value: unknown): InboundFrame {
  const issues: string[] = [];
  const frame = expectObject(value, 'frame', issues);
  const requestType = expectOptionalNonEmptyString(frame?.type, 'frame.type', issues);

  if (!frame || !requestType) {
    throw invalidFrameError(issues);
  }

  if (!INBOUND_FRAME_TYPES.includes(requestType as InboundFrameType)) {
    throw new ProtocolValidationError('unknown_frame_type', `Unknown inbound frame type "${requestType}".`, {
      requestType,
    });
  }

  switch (requestType as InboundFrameType) {
    case 'session.open': {
      return validateSessionOpenFrame(frame, issues);
    }
    case 'message.send': {
      return validateMessageSendFrame(frame, issues);
    }
    case 'run.start': {
      return validateRunStartFrame(frame, issues);
    }
    case 'run.retry': {
      return validateRunRetryFrame(frame, issues);
    }
    case 'run.continue': {
      return validateRunContinueFrame(frame, issues);
    }
    case 'approval.resolve': {
      return validateApprovalResolveFrame(frame, issues);
    }
    case 'clarification.resolve': {
      return validateClarificationResolveFrame(frame, issues);
    }
    case 'channel.subscribe': {
      return validateChannelSubscribeFrame(frame, issues);
    }
    case 'session.close': {
      return validateSessionCloseFrame(frame, issues);
    }
    case 'ping': {
      return validatePingFrame(frame, issues);
    }
  }
}

function validateRunRetryFrame(frame: Record<string, unknown>, issues: string[]): RunRetryFrame {
  const validatedFrame: RunRetryFrame = {
    type: 'run.retry',
    sessionId: expectOptionalNonEmptyString(frame.sessionId, 'frame.sessionId', issues),
    runId: expectNonEmptyString(frame.runId, 'frame.runId', issues) ?? 'invalid-run-id',
    metadata: expectOptionalJsonObject(frame.metadata, 'frame.metadata', issues),
  };

  return finalizeFrame(validatedFrame, issues);
}

function validateRunContinueFrame(frame: Record<string, unknown>, issues: string[]): RunContinueFrame {
  const sessionId = expectOptionalNonEmptyString(frame.sessionId, 'frame.sessionId', issues);
  const runId = expectOptionalNonEmptyString(frame.runId, 'frame.runId', issues);
  if (!sessionId && !runId) {
    issues.push('frame.sessionId or frame.runId must be provided.');
  }

  const validatedFrame: RunContinueFrame = {
    type: 'run.continue',
    sessionId,
    runId,
    strategy: expectOptionalContinuationStrategy(frame.strategy, 'frame.strategy', issues),
    provider: expectOptionalNonEmptyString(frame.provider, 'frame.provider', issues),
    model: expectOptionalNonEmptyString(frame.model, 'frame.model', issues),
    requireApproval: expectOptionalBoolean(frame.requireApproval, 'frame.requireApproval', issues),
    metadata: expectOptionalJsonObject(frame.metadata, 'frame.metadata', issues),
  };

  return finalizeFrame(validatedFrame, issues);
}

export function createPongFrame(frame: PingFrame): PongFrame {
  return {
    type: 'pong',
    id: frame.id,
  };
}

export function createProtocolErrorFrame(error: ProtocolValidationError): ErrorFrame {
  return {
    type: 'error',
    code: error.code,
    message: error.message,
    requestType: error.requestType,
    details: error.details,
  };
}

export function createUnsupportedFrameError(requestType: InboundFrameType): ProtocolValidationError {
  return new ProtocolValidationError(
    'unsupported_frame',
    `Inbound frame type "${requestType}" is valid but not implemented yet.`,
    { requestType },
  );
}

export function serializeOutboundFrame(frame: OutboundFrame): string {
  return JSON.stringify(frame);
}

function validateSessionOpenFrame(frame: Record<string, unknown>, issues: string[]): SessionOpenFrame {
  const validatedFrame: SessionOpenFrame = {
    type: 'session.open',
    sessionId: expectOptionalNonEmptyString(frame.sessionId, 'frame.sessionId', issues),
    rootRunId: expectOptionalNonEmptyString(frame.rootRunId, 'frame.rootRunId', issues),
    channelId: expectNonEmptyString(frame.channelId, 'frame.channelId', issues) ?? 'invalid-channel-id',
    metadata: expectOptionalJsonObject(frame.metadata, 'frame.metadata', issues),
  };

  return finalizeFrame(validatedFrame, issues);
}

function validateMessageSendFrame(frame: Record<string, unknown>, issues: string[]): MessageSendFrame {
  const validatedFrame: MessageSendFrame = {
    type: 'message.send',
    sessionId: expectNonEmptyString(frame.sessionId, 'frame.sessionId', issues) ?? 'invalid-session-id',
    content: expectNonEmptyString(frame.content, 'frame.content', issues) ?? 'invalid-content',
    images: expectOptionalImageInputs(frame.images, 'frame.images', issues),
    metadata: expectOptionalJsonObject(frame.metadata, 'frame.metadata', issues),
  };

  return finalizeFrame(validatedFrame, issues);
}

function validateRunStartFrame(frame: Record<string, unknown>, issues: string[]): RunStartFrame {
  const validatedFrame: RunStartFrame = {
    type: 'run.start',
    sessionId: expectOptionalNonEmptyString(frame.sessionId, 'frame.sessionId', issues),
    agentId: expectOptionalNonEmptyString(frame.agentId, 'frame.agentId', issues),
    goal: expectNonEmptyString(frame.goal, 'frame.goal', issues) ?? 'invalid-goal',
    input: expectOptionalJsonValue(frame.input, 'frame.input', issues),
    images: expectOptionalImageInputs(frame.images, 'frame.images', issues),
    context: expectOptionalJsonObject(frame.context, 'frame.context', issues),
    metadata: expectOptionalJsonObject(frame.metadata, 'frame.metadata', issues),
  };

  return finalizeFrame(validatedFrame, issues);
}

function validateApprovalResolveFrame(frame: Record<string, unknown>, issues: string[]): ApprovalResolveFrame {
  const validatedFrame: ApprovalResolveFrame = {
    type: 'approval.resolve',
    sessionId: expectNonEmptyString(frame.sessionId, 'frame.sessionId', issues) ?? 'invalid-session-id',
    runId: expectNonEmptyString(frame.runId, 'frame.runId', issues) ?? 'invalid-run-id',
    approved: expectBoolean(frame.approved, 'frame.approved', issues) ?? false,
    metadata: expectOptionalJsonObject(frame.metadata, 'frame.metadata', issues),
  };

  return finalizeFrame(validatedFrame, issues);
}

function validateClarificationResolveFrame(
  frame: Record<string, unknown>,
  issues: string[],
): ClarificationResolveFrame {
  const validatedFrame: ClarificationResolveFrame = {
    type: 'clarification.resolve',
    sessionId: expectNonEmptyString(frame.sessionId, 'frame.sessionId', issues) ?? 'invalid-session-id',
    runId: expectNonEmptyString(frame.runId, 'frame.runId', issues) ?? 'invalid-run-id',
    message: expectNonEmptyString(frame.message, 'frame.message', issues) ?? 'invalid-message',
    metadata: expectOptionalJsonObject(frame.metadata, 'frame.metadata', issues),
  };

  return finalizeFrame(validatedFrame, issues);
}

function validateChannelSubscribeFrame(frame: Record<string, unknown>, issues: string[]): ChannelSubscribeFrame {
  const channels = expectStringArray(frame.channels, 'frame.channels', issues) ?? [];
  if (channels.length === 0) {
    issues.push('frame.channels must contain at least one channel id.');
  }

  const validatedFrame: ChannelSubscribeFrame = {
    type: 'channel.subscribe',
    channels,
  };

  return finalizeFrame(validatedFrame, issues);
}

function validateSessionCloseFrame(frame: Record<string, unknown>, issues: string[]): SessionCloseFrame {
  const validatedFrame: SessionCloseFrame = {
    type: 'session.close',
    sessionId: expectNonEmptyString(frame.sessionId, 'frame.sessionId', issues) ?? 'invalid-session-id',
  };

  return finalizeFrame(validatedFrame, issues);
}

function validatePingFrame(frame: Record<string, unknown>, issues: string[]): PingFrame {
  const validatedFrame: PingFrame = {
    type: 'ping',
    id: expectOptionalNonEmptyString(frame.id, 'frame.id', issues),
  };

  return finalizeFrame(validatedFrame, issues);
}

function finalizeFrame<TFrame extends InboundFrame>(frame: TFrame, issues: string[]): TFrame {
  if (issues.length > 0) {
    throw invalidFrameError(issues, frame.type);
  }

  return frame;
}

function invalidFrameError(issues: string[], requestType?: string): ProtocolValidationError {
  return new ProtocolValidationError('invalid_frame', 'Inbound WebSocket frame failed validation.', {
    requestType,
    details: issues.length > 0 ? { issues } : undefined,
  });
}

function decodeWebSocketPayload(raw: unknown): string {
  if (typeof raw === 'string') {
    return raw;
  }

  if (Buffer.isBuffer(raw)) {
    return raw.toString('utf-8');
  }

  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString('utf-8');
  }

  if (ArrayBuffer.isView(raw)) {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf-8');
  }

  if (Array.isArray(raw) && raw.every(Buffer.isBuffer)) {
    return Buffer.concat(raw).toString('utf-8');
  }

  throw new ProtocolValidationError('invalid_frame', 'Inbound WebSocket payload must be sent as a text frame.');
}

function expectObject(value: unknown, path: string, issues: string[]): Record<string, unknown> | undefined {
  if (isRecord(value)) {
    return value;
  }

  issues.push(`${path} must be a JSON object.`);
  return undefined;
}

function expectBoolean(value: unknown, path: string, issues: string[]): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }

  issues.push(`${path} must be a boolean.`);
  return undefined;
}

function expectOptionalBoolean(value: unknown, path: string, issues: string[]): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  return expectBoolean(value, path, issues);
}

function expectNonEmptyString(value: unknown, path: string, issues: string[]): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }

  issues.push(`${path} must be a non-empty string.`);
  return undefined;
}

function expectOptionalNonEmptyString(value: unknown, path: string, issues: string[]): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return expectNonEmptyString(value, path, issues);
}

const CONTINUATION_STRATEGIES = new Set<ContinuationStrategy>([
  'hybrid_snapshot_then_step',
  'latest_snapshot',
  'last_successful_step',
  'failure_boundary',
  'manual_checkpoint',
]);

function expectOptionalContinuationStrategy(
  value: unknown,
  path: string,
  issues: string[],
): ContinuationStrategy | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === 'string' && CONTINUATION_STRATEGIES.has(value as ContinuationStrategy)) {
    return value as ContinuationStrategy;
  }

  issues.push(`${path} must be a supported continuation strategy.`);
  return undefined;
}

function expectStringArray(value: unknown, path: string, issues: string[]): string[] | undefined {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array.`);
    return undefined;
  }

  const items: string[] = [];
  for (const [index, entry] of value.entries()) {
    const item = expectNonEmptyString(entry, `${path}[${index}]`, issues);
    if (item) {
      items.push(item);
    }
  }

  return items;
}

function expectOptionalImageInputs(value: unknown, path: string, issues: string[]): GatewayImageInput[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array.`);
    return undefined;
  }

  const images: GatewayImageInput[] = [];
  for (const [index, entry] of value.entries()) {
    const image = expectImageInput(entry, `${path}[${index}]`, issues);
    if (image) {
      images.push(image);
    }
  }

  return images;
}

function expectImageInput(value: unknown, path: string, issues: string[]): GatewayImageInput | undefined {
  const image = expectObject(value, path, issues);
  if (!image) {
    return undefined;
  }

  const pathValue = expectOptionalNonEmptyString(image.path, `${path}.path`, issues);
  const uploadId = expectOptionalNonEmptyString(image.uploadId, `${path}.uploadId`, issues);
  const mimeType = expectOptionalNonEmptyString(image.mimeType, `${path}.mimeType`, issues);
  const detail = expectOptionalImageDetail(image.detail, `${path}.detail`, issues);
  const name = expectOptionalNonEmptyString(image.name, `${path}.name`, issues);
  if (!pathValue && !uploadId) {
    issues.push(`${path} must include either path or uploadId.`);
    return undefined;
  }
  if (pathValue && uploadId) {
    issues.push(`${path} cannot include both path and uploadId.`);
    return undefined;
  }

  if (uploadId) {
    return {
      uploadId,
      ...(mimeType ? { mimeType } : {}),
      ...(detail ? { detail } : {}),
      ...(name ? { name } : {}),
    };
  }

  return {
    path: pathValue!,
    ...(mimeType ? { mimeType } : {}),
    ...(detail ? { detail } : {}),
    ...(name ? { name } : {}),
  };
}

function expectOptionalImageDetail(value: unknown, path: string, issues: string[]): ImageInput['detail'] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === 'auto' || value === 'low' || value === 'high') {
    return value;
  }

  issues.push(`${path} must be one of "auto", "low", or "high".`);
  return undefined;
}

function expectOptionalJsonObject(value: unknown, path: string, issues: string[]): JsonObject | undefined {
  if (value === undefined) {
    return undefined;
  }

  const jsonValue = toJsonValue(value, path, issues);
  if (jsonValue && typeof jsonValue === 'object' && !Array.isArray(jsonValue)) {
    return jsonValue as JsonObject;
  }

  issues.push(`${path} must be a JSON object.`);
  return undefined;
}

function expectOptionalJsonValue(value: unknown, path: string, issues: string[]): JsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  return toJsonValue(value, path, issues);
}

function toJsonValue(value: unknown, path: string, issues: string[]): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const [index, entry] of value.entries()) {
      const jsonValue = toJsonValue(entry, `${path}[${index}]`, issues);
      if (jsonValue !== undefined) {
        result.push(jsonValue);
      }
    }
    return result;
  }

  if (isRecord(value)) {
    const result: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
      const jsonValue = toJsonValue(entry, `${path}.${key}`, issues);
      if (jsonValue !== undefined) {
        result[key] = jsonValue;
      }
    }
    return result;
  }

  issues.push(`${path} must contain only JSON-serializable values.`);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
