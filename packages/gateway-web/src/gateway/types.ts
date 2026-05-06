import type { AgentEventFrame, OutboundFrame, SessionStatus } from './protocol';

export type SocketState = 'idle' | 'connecting' | 'connected' | 'closed' | 'error';
export type ComposerMode = 'chat' | 'run';
export type FeedKind = 'assistant' | 'user' | 'run' | 'system' | 'event';
export type TraceView = 'overview' | 'timeline' | 'delegates' | 'messages' | 'plans';
export type ImageDetail = 'auto' | 'low' | 'high';

export interface GatewayLocalImageInput {
  path: string;
  mimeType?: string;
  detail?: ImageDetail;
  name?: string;
}

export interface GatewayUploadedImageInput {
  uploadId: string;
  mimeType?: string;
  detail?: ImageDetail;
  name?: string;
}

export type GatewayImageInput = GatewayLocalImageInput | GatewayUploadedImageInput;

export interface GatewayImageUploadResult {
  uploadId: string;
  mimeType: string;
  name?: string;
  sizeBytes: number;
}

export interface GatewayDefaults {
  socketUrl: string;
  channel: string;
  subject: string;
  tenantId: string;
  roles: string[];
}

export interface GatewayIdentity {
  channel: string;
  subject: string;
  tenantId: string;
  roles: string[];
}

export interface FeedEntry {
  id: string;
  kind: FeedKind;
  content: string;
  timestamp: Date;
  runId?: string;
}

export interface RunActivity {
  runId: string;
  rootRunId?: string;
  sessionId?: string;
  status: 'running' | 'awaiting_approval' | 'succeeded' | 'failed' | 'unknown';
  goal?: string;
  latestEvent?: LiveAgentEventSummary;
  eventCount: number;
  startedAt: Date;
  updatedAt: Date;
  output?: string;
  error?: string;
}

export interface PendingApproval {
  runId: string;
  rootRunId?: string;
  sessionId?: string;
  toolName?: string;
  reason?: string;
}

export interface PendingClarification {
  runId: string;
  sessionId?: string;
  message: string;
  suggestedQuestions: string[];
}

export interface LiveAgentEventSummary {
  eventType: string;
  compactText: string;
  runId?: string;
  rootRunId?: string;
  seq?: number;
  status?: string;
  toolName?: string;
  input?: unknown;
  assistantContent?: string;
  detail?: string;
  timestamp: Date;
}

export interface ClarificationRequestOutput {
  status: 'clarification_requested';
  message: string;
  suggestedQuestions: string[];
}

export interface SessionSnapshot {
  sessionId?: string;
  runSessionId?: string;
  status: SessionStatus;
  activeRunId?: string;
  activeRootRunId?: string;
}

export interface ModelActivitySnapshot {
  status: 'thinking' | 'completed' | 'failed';
  runId?: string;
  target?: string;
  startedAt: Date;
  completedAt?: Date;
  durationMs?: number;
  timeoutMs?: number;
  finishReason?: string;
  toolCallCount?: number;
  timedOut?: boolean;
  error?: string;
}

export interface LiveGatewayState {
  socketState: SocketState;
  socketDetail: string;
  session: SessionSnapshot;
  feed: FeedEntry[];
  events: LiveAgentEventSummary[];
  runs: RunActivity[];
  pendingApproval?: PendingApproval;
  pendingClarification?: PendingClarification;
  modelActivity?: ModelActivitySnapshot;
}

export interface GatewayWebClientOptions {
  socketUrl: string;
  identity: GatewayIdentity;
  token: string;
  onFrame: (frame: OutboundFrame) => void;
  onSocketStateChange: (state: SocketState, detail?: string) => void;
  onSessionIdsChange: (sessionIds: { sessionId?: string; runSessionId?: string }) => void;
}

export type EventFrameHandler = (frame: AgentEventFrame) => void;
