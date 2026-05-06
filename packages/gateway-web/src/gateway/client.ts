import type {
  ApprovalRequestedFrame,
  OutboundFrame,
  RunOutputFrame,
  SessionOpenedFrame,
  SessionUpdatedFrame,
} from './protocol';

import { isClarificationRequestOutput } from './format';
import type { GatewayDefaults, GatewayImageInput, GatewayImageUploadResult, GatewayWebClientOptions, SocketState } from './types';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  isSettled: () => boolean;
}

interface ConnectOptions {
  openSession?: boolean;
}

interface PendingSessionRequest {
  mode: 'chat' | 'run';
  deferred: Deferred<SessionOpenedFrame>;
}

export class GatewayWebClient {
  private readonly socketUrl: string;
  private readonly channel: string;
  private readonly token: string;
  private readonly onFrame: GatewayWebClientOptions['onFrame'];
  private readonly onSocketStateChange: GatewayWebClientOptions['onSocketStateChange'];
  private readonly onSessionIdsChange: GatewayWebClientOptions['onSessionIdsChange'];
  private readonly approvalSessionIds = new Map<string, string>();
  private readonly clarificationSessionIds = new Map<string, string>();
  private readonly failedRunSessionIds = new Map<string, string>();
  private pendingApprovalRunId?: string;
  private socket?: WebSocket;
  private sessionId?: string;
  private runSessionId?: string;
  private pendingSessionRequests: PendingSessionRequest[] = [];

  constructor(options: GatewayWebClientOptions) {
    this.socketUrl = options.socketUrl;
    this.channel = options.identity.channel;
    this.token = options.token;
    this.onFrame = options.onFrame;
    this.onSocketStateChange = options.onSocketStateChange;
    this.onSessionIdsChange = options.onSessionIdsChange;
  }

  connect(options: ConnectOptions = {}): Promise<SessionOpenedFrame | void> {
    const openSession = options.openSession !== false;
    const socketOpened = createDeferred<void>();
    const initialSessionRequest = openSession ? createPendingSessionRequest('chat') : undefined;
    this.pendingSessionRequests = initialSessionRequest ? [initialSessionRequest] : [];
    this.notifySocketState('connecting');

    const socket = new WebSocket(buildUpgradeUrl(this.socketUrl, this.channel, this.token));
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.notifySocketState('connected');
      socketOpened.resolve();
      if (initialSessionRequest) {
        this.sendFrame({
          type: 'session.open',
          channelId: this.channel,
        });
      }
    });

    socket.addEventListener('message', (event) => {
      const frame = parseFrame(event.data);
      this.handleFrame(frame);
    });

    socket.addEventListener('error', () => {
      this.notifySocketState('error', 'WebSocket error encountered.');
    });

    socket.addEventListener('close', (event) => {
      const detail = event.reason ? `${event.code}: ${event.reason}` : `${event.code}`;
      this.notifySocketState('closed', detail);
      rejectIfPending(socketOpened, new Error('Socket closed before the connection was established.'));
      this.rejectPendingSessionRequests(new Error('Socket closed before the requested session was opened.'));
    });

    return initialSessionRequest ? initialSessionRequest.deferred.promise : socketOpened.promise;
  }

  disconnect(code = 1000, reason = 'client disconnected'): void {
    this.socket?.close(code, reason);
  }

  async sendChat(content: string, images?: GatewayImageInput[]): Promise<void> {
    const sessionId = await this.ensureChatSessionId();

    this.sendFrame({
      type: 'message.send',
      sessionId,
      content,
      images,
    });
  }

  async startRun(goal: string, images?: GatewayImageInput[]): Promise<void> {
    const sessionId = await this.ensureRunSessionId();
    this.sendFrame({
      type: 'run.start',
      sessionId,
      goal,
      images,
    });
  }

  async uploadImages(files: File[]): Promise<GatewayImageUploadResult[]> {
    if (files.length === 0) {
      return [];
    }

    const formData = new FormData();
    for (const file of files) {
      formData.append('images', file, file.name);
    }

    const response = await fetch('/api/images', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
      },
      body: formData,
    });
    const payload = (await response.json().catch(() => ({}))) as { images?: unknown; message?: unknown };
    if (!response.ok || !Array.isArray(payload.images)) {
      throw new Error(typeof payload.message === 'string' ? payload.message : `Image upload failed with ${response.status}.`);
    }

    return payload.images.map((entry) => normalizeImageUploadResult(entry));
  }

  retryRun(runId: string): void {
    const sessionId = this.failedRunSessionIds.get(runId) ?? this.runSessionId;
    if (!sessionId) {
      throw new Error(`No run session is tracked for run "${runId}".`);
    }

    this.sendFrame({
      type: 'run.retry',
      sessionId,
      runId,
    });
  }

  resolveApproval(runId: string, approved: boolean, sessionIdHint?: string): void {
    const sessionId = this.approvalSessionIds.get(runId) ?? sessionIdHint;
    if (!sessionId) {
      throw new Error(`No approval session is tracked for run "${runId}".`);
    }

    this.sendFrame({
      type: 'approval.resolve',
      sessionId,
      runId,
      approved,
    });
    this.approvalSessionIds.delete(runId);
    if (this.pendingApprovalRunId === runId) {
      this.pendingApprovalRunId = undefined;
    }
  }

  resolveClarification(runId: string, message: string): void {
    const sessionId = this.clarificationSessionIds.get(runId);
    if (!sessionId) {
      throw new Error(`No clarification session is tracked for run "${runId}".`);
    }

    this.sendFrame({
      type: 'clarification.resolve',
      sessionId,
      runId,
      message,
    });
    this.clarificationSessionIds.delete(runId);
  }

  private async ensureChatSessionId(): Promise<string> {
    if (this.sessionId) {
      return this.sessionId;
    }

    return this.requestSession('chat');
  }

  private async ensureRunSessionId(): Promise<string> {
    if (this.runSessionId) {
      return this.runSessionId;
    }

    return this.requestSession('run');
  }

  private async requestSession(mode: PendingSessionRequest['mode']): Promise<string> {
    const existing = this.pendingSessionRequests.find((request) => request.mode === mode && !request.deferred.isSettled());
    if (existing) {
      const frame = await existing.deferred.promise;
      return frame.sessionId;
    }

    const request = createPendingSessionRequest(mode);
    this.pendingSessionRequests.push(request);
    this.sendFrame({
      type: 'session.open',
      channelId: this.channel,
    });

    const frame = await request.deferred.promise;
    return frame.sessionId;
  }

  private handleFrame(frame: OutboundFrame): void {
    switch (frame.type) {
      case 'session.opened':
        this.trackSession(frame);
        break;
      case 'session.updated':
        this.trackSessionUpdate(frame);
        break;
      case 'approval.requested':
        this.trackApproval(frame);
        break;
      case 'run.output':
        this.trackRunOutput(frame);
        break;
      default:
        break;
    }

    this.onFrame(frame);
  }

  private trackSession(frame: SessionOpenedFrame): void {
    const request = this.pendingSessionRequests.shift();
    if (!request) {
      if (!this.sessionId) {
        this.sessionId = frame.sessionId;
      } else if (!this.runSessionId) {
        this.runSessionId = frame.sessionId;
      }
      this.notifySessionIds();
      return;
    }

    if (request.mode === 'chat') {
      this.sessionId = frame.sessionId;
    } else {
      this.runSessionId = frame.sessionId;
    }

    request.deferred.resolve(frame);
    this.notifySessionIds();
  }

  private trackApproval(frame: ApprovalRequestedFrame): void {
    this.pendingApprovalRunId = frame.runId;
    if (frame.sessionId) {
      this.approvalSessionIds.set(frame.runId, frame.sessionId);
    }
  }

  private trackSessionUpdate(frame: SessionUpdatedFrame): void {
    if (frame.status === 'awaiting_approval' && frame.activeRunId) {
      this.pendingApprovalRunId = frame.activeRunId;
      this.approvalSessionIds.set(frame.activeRunId, frame.sessionId);
      return;
    }

    if (this.pendingApprovalRunId && frame.status !== 'awaiting_approval') {
      this.approvalSessionIds.delete(this.pendingApprovalRunId);
      this.pendingApprovalRunId = undefined;
    }
  }

  private trackRunOutput(frame: RunOutputFrame): void {
    if (frame.status === 'failed' && frame.sessionId) {
      this.failedRunSessionIds.set(frame.runId, frame.sessionId);
    }

    if (isClarificationRequestOutput(frame.output) && frame.sessionId) {
      this.clarificationSessionIds.set(frame.runId, frame.sessionId);
      return;
    }

    this.clarificationSessionIds.delete(frame.runId);
  }

  private sendFrame(frame: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('The gateway socket is not connected.');
    }

    this.socket.send(JSON.stringify(frame));
  }

  private notifySocketState(state: SocketState, detail?: string): void {
    this.onSocketStateChange(state, detail);
  }

  private notifySessionIds(): void {
    this.onSessionIdsChange({
      sessionId: this.sessionId,
      runSessionId: this.runSessionId,
    });
  }

  private rejectPendingSessionRequests(reason: Error): void {
    for (const request of this.pendingSessionRequests) {
      rejectIfPending(request.deferred, reason);
    }
    this.pendingSessionRequests = [];
  }
}

export async function loadGatewayDefaults(): Promise<GatewayDefaults> {
  const response = await fetch('/api/gateway-defaults');
  if (!response.ok) {
    throw new Error(`Gateway defaults failed with ${response.status}.`);
  }

  return (await response.json()) as GatewayDefaults;
}

export async function mintDevToken(input: {
  subject: string;
  tenantId: string;
  roles: string[];
}): Promise<string> {
  const response = await fetch('/api/dev-token', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
  });

  const payload = (await response.json().catch(() => ({}))) as { token?: unknown; message?: unknown };
  if (!response.ok || typeof payload.token !== 'string') {
    throw new Error(typeof payload.message === 'string' ? payload.message : `Token request failed with ${response.status}.`);
  }

  return payload.token;
}

export function buildUpgradeUrl(socketUrl: string, channel: string, token: string): string {
  const url = new URL(socketUrl);
  url.searchParams.set('channelId', channel);
  url.searchParams.set('access_token', token);
  return url.toString();
}

function normalizeImageUploadResult(value: unknown): GatewayImageUploadResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Image upload response was invalid.');
  }

  const image = value as Partial<GatewayImageUploadResult>;
  if (typeof image.uploadId !== 'string' || typeof image.mimeType !== 'string' || typeof image.sizeBytes !== 'number') {
    throw new Error('Image upload response was invalid.');
  }

  return {
    uploadId: image.uploadId,
    mimeType: image.mimeType,
    ...(typeof image.name === 'string' ? { name: image.name } : {}),
    sizeBytes: image.sizeBytes,
  };
}

function parseFrame(raw: unknown): OutboundFrame {
  if (typeof raw === 'string') {
    return JSON.parse(raw) as OutboundFrame;
  }

  throw new Error('Unsupported WebSocket payload.');
}

function createDeferred<T>(): Deferred<T> {
  let settled = false;
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

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

function createPendingSessionRequest(mode: PendingSessionRequest['mode']): PendingSessionRequest {
  return {
    mode,
    deferred: createDeferred<SessionOpenedFrame>(),
  };
}

function rejectIfPending<T>(deferred: Deferred<T>, reason: Error): void {
  if (!deferred.isSettled()) {
    deferred.reject(reason);
  }
}
