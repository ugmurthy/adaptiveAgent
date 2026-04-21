import type { OutboundFrame, SessionUpdatedFrame } from '../protocol.js';

export type EventStreamMode = 'off' | 'compact' | 'verbose';

export interface ClientOptions {
  url?: string;
  host?: string;
  port?: number;
  path?: string;
  channel: string;
  sessionId?: string;
  subject: string;
  tenantId?: string;
  roles: string[];
  token?: string;
  message?: string;
  runGoal?: string;
  verbose: boolean;
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  isSettled: () => boolean;
}

export interface PendingApprovalTrackingState {
  pendingApprovalRunId?: string;
  approvalSessionIds: Map<string, string>;
}

export function parseCsv(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (Number.isInteger(port) && port > 0) {
    return port;
  }

  throw new Error(`Invalid port: ${value}`);
}

export function requireValue(flag: string, value: string | undefined): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }

  throw new Error(`Missing value for ${flag}.`);
}

export function normalizeConnectHost(host: string | undefined): string {
  if (!host || host === '0.0.0.0' || host === '::') {
    return '127.0.0.1';
  }

  return host;
}

export async function resolveSocketUrl(options: ClientOptions): Promise<string> {
  if (options.url) {
    return options.url;
  }

  return `ws://${options.host ?? '127.0.0.1'}:${options.port ?? 8959}${options.path ?? '/ws'}?channelId=${encodeURIComponent(options.channel)}`;
}

export function sendFrame(socket: WebSocket, frame: Record<string, unknown>): void {
  socket.send(JSON.stringify(frame));
}

export function parseFrame(raw: string | ArrayBuffer | Blob | Uint8Array): OutboundFrame {
  const text =
    typeof raw === 'string'
      ? raw
      : raw instanceof ArrayBuffer
        ? new TextDecoder().decode(raw)
        : raw instanceof Uint8Array
          ? new TextDecoder().decode(raw)
          : String(raw);

  return JSON.parse(text) as OutboundFrame;
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  let settled = false;

  const promise = new Promise<T>((res, rej) => {
    resolve = (value) => {
      settled = true;
      res(value);
    };
    reject = (reason) => {
      settled = true;
      rej(reason);
    };
  });

  return {
    promise,
    resolve,
    reject,
    isSettled: () => settled,
  };
}

export function resolveIfPending<T>(deferred: Deferred<T>, value: T): void {
  if (!deferred.isSettled()) {
    deferred.resolve(value);
  }
}

export function rejectIfPending<T>(deferred: Deferred<T>, reason: unknown): void {
  if (!deferred.isSettled()) {
    deferred.reject(reason);
  }
}

export function hydratePendingApprovalFromSessionUpdate(
  state: PendingApprovalTrackingState,
  frame: SessionUpdatedFrame,
): void {
  if (frame.status === 'awaiting_approval' && frame.activeRunId) {
    state.pendingApprovalRunId = frame.activeRunId;
    state.approvalSessionIds.set(frame.activeRunId, frame.sessionId);
    return;
  }

  if (state.pendingApprovalRunId && frame.status !== 'awaiting_approval') {
    state.approvalSessionIds.delete(state.pendingApprovalRunId);
    state.pendingApprovalRunId = undefined;
  }
}
