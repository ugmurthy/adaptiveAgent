import type { JsonObject, JsonValue } from './core.js';

export const INBOUND_FRAME_TYPES = [
  'session.open',
  'message.send',
  'run.start',
  'approval.resolve',
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
] as const;

export type InboundFrameType = (typeof INBOUND_FRAME_TYPES)[number];
export type OutboundFrameType = (typeof OUTBOUND_FRAME_TYPES)[number];
export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];
export type SessionStatus = 'idle' | 'running' | 'awaiting_approval' | 'closed' | 'failed';

export interface SessionOpenFrame {
  type: 'session.open';
  sessionId?: string;
  channelId: string;
  metadata?: JsonObject;
}

export interface MessageSendFrame {
  type: 'message.send';
  sessionId: string;
  content: string;
  metadata?: JsonObject;
}

export interface RunStartFrame {
  type: 'run.start';
  sessionId?: string;
  agentId?: string;
  goal: string;
  input?: JsonValue;
  context?: JsonObject;
  metadata?: JsonObject;
}

export interface ApprovalResolveFrame {
  type: 'approval.resolve';
  sessionId: string;
  runId: string;
  approved: boolean;
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
  | ApprovalResolveFrame
  | ChannelSubscribeFrame
  | SessionCloseFrame
  | PingFrame;

export interface SessionOpenedFrame {
  type: 'session.opened';
  sessionId: string;
  channelId: string;
  agentId?: string;
  status: SessionStatus;
}

export interface SessionUpdatedFrame {
  type: 'session.updated';
  sessionId: string;
  status: SessionStatus;
  transcriptVersion: number;
  activeRunId?: string;
  activeRootRunId?: string;
}

export interface AgentEventFrame {
  type: 'agent.event';
  eventType: string;
  data: JsonValue;
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
    case 'approval.resolve': {
      return validateApprovalResolveFrame(frame, issues);
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
