import type { JsonValue } from '@adaptive-agent/core';

export const DESKTOP_PROTOCOL_VERSION = 1 as const;
export const DESKTOP_BRIDGE_VERSION = '0.1.0';

export type RuntimeMode = 'memory' | 'postgres';

export type DesktopCommand =
  | { version: 1; id: string; type: 'hello' }
  | {
      version: 1;
      id: string;
      type: 'runtime.initialize';
      cwd?: string;
      agentConfigPath?: string;
      settingsConfigPath?: string;
      runtimeMode?: RuntimeMode;
    }
  | { version: 1; id: string; type: 'run.start'; goal: string; sessionId?: string; input?: JsonValue }
  | { version: 1; id: string; type: 'chat.send'; message: string; sessionId?: string }
  | { version: 1; id: string; type: 'run.resume'; runId: string }
  | { version: 1; id: string; type: 'run.retry'; runId: string }
  | { version: 1; id: string; type: 'run.interrupt'; runId: string }
  | { version: 1; id: string; type: 'run.inspect'; runId: string }
  | { version: 1; id: string; type: 'run.steer'; runId: string; message: string }
  | { version: 1; id: string; type: 'approval.resolve'; runId: string; approved: boolean }
  | { version: 1; id: string; type: 'clarification.resolve'; runId: string; answer: string }
  | { version: 1; id: string; type: 'runtime.shutdown' };

export interface DesktopReadyEvent {
  version: 1;
  type: 'runtime.ready';
  protocolVersion: 1;
  bridgeVersion: string;
  pid: number;
}

export interface DesktopAgentEvent {
  version: 1;
  type: 'agent.event';
  event: JsonValue;
}

export interface DesktopSuccessResponse {
  version: 1;
  id: string;
  type: 'response';
  ok: true;
  result: JsonValue;
}

export interface DesktopErrorResponse {
  version: 1;
  id: string;
  type: 'response';
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

export type DesktopMessage = DesktopReadyEvent | DesktopAgentEvent | DesktopSuccessResponse | DesktopErrorResponse;

export class DesktopProtocolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DesktopProtocolError';
  }
}

export function parseDesktopCommand(line: string): DesktopCommand {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new DesktopProtocolError('INVALID_JSON', 'Command must be valid JSON.');
  }
  if (!isRecord(value)) throw new DesktopProtocolError('INVALID_COMMAND', 'Command must be a JSON object.');
  if (value.version !== DESKTOP_PROTOCOL_VERSION) {
    throw new DesktopProtocolError('UNSUPPORTED_PROTOCOL_VERSION', `Protocol version ${String(value.version)} is not supported.`);
  }
  if (typeof value.id !== 'string' || !value.id.trim()) {
    throw new DesktopProtocolError('INVALID_COMMAND', 'Command id must be a non-empty string.');
  }
  if (typeof value.type !== 'string' || !value.type.trim()) {
    throw new DesktopProtocolError('INVALID_COMMAND', 'Command type must be a non-empty string.');
  }
  validateCommandFields(value);
  return value as DesktopCommand;
}

export function commandIdFromUnknownLine(line: string): string {
  try {
    const value = JSON.parse(line) as unknown;
    return isRecord(value) && typeof value.id === 'string' && value.id.trim() ? value.id : 'unknown';
  } catch {
    return 'unknown';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateCommandFields(value: Record<string, unknown>): void {
  switch (value.type) {
    case 'hello':
    case 'runtime.shutdown':
      return;
    case 'runtime.initialize':
      optionalString(value, 'cwd');
      optionalString(value, 'agentConfigPath');
      optionalString(value, 'settingsConfigPath');
      if (value.runtimeMode !== undefined && value.runtimeMode !== 'memory' && value.runtimeMode !== 'postgres') {
        throw new DesktopProtocolError('INVALID_COMMAND', 'runtimeMode must be memory or postgres.');
      }
      return;
    case 'run.start':
      requiredString(value, 'goal');
      optionalString(value, 'sessionId');
      return;
    case 'chat.send':
      requiredString(value, 'message');
      optionalString(value, 'sessionId');
      return;
    case 'run.resume':
    case 'run.retry':
    case 'run.interrupt':
    case 'run.inspect':
      requiredString(value, 'runId');
      return;
    case 'run.steer':
      requiredString(value, 'runId');
      requiredString(value, 'message');
      return;
    case 'approval.resolve':
      requiredString(value, 'runId');
      if (typeof value.approved !== 'boolean') throw new DesktopProtocolError('INVALID_COMMAND', 'approved must be a boolean.');
      return;
    case 'clarification.resolve':
      requiredString(value, 'runId');
      requiredString(value, 'answer');
      return;
    default:
      throw new DesktopProtocolError('UNKNOWN_COMMAND', `Unknown command type: ${String(value.type)}`);
  }
}

function requiredString(value: Record<string, unknown>, field: string): void {
  if (typeof value[field] !== 'string' || !value[field].trim()) {
    throw new DesktopProtocolError('INVALID_COMMAND', `${field} must be a non-empty string.`);
  }
}

function optionalString(value: Record<string, unknown>, field: string): void {
  if (value[field] !== undefined) requiredString(value, field);
}
