import type { OutboundFrame, AgentEventFrame, SessionOpenedFrame } from '../protocol.js';
import type { EventStreamMode } from '../local-ws-client.js';

export interface TuiClientState {
  sessionId?: string;
  runSessionId?: string;
  pendingApprovalRunId?: string;
  pendingClarificationRunId?: string;
  lastFailedRunId?: string;
  latestAgentEvent?: LiveAgentEventSummary;
  channel: string;
  tenantId?: string;
  roles: string[];
  eventMode: EventStreamMode;
  approvalSessionIds: Map<string, string>;
  clarificationSessionIds: Map<string, string>;
  failedRunSessionIds: Map<string, string>;
  connected: boolean;
}

export type FrameHandler = (frame: OutboundFrame) => void;

export interface TuiClientOptions {
  channel: string;
  sessionId?: string;
  subject: string;
  tenantId?: string;
  roles: string[];
  token?: string;
  verbose: boolean;
  host?: string;
  port?: number;
  path?: string;
}

export interface MessageEntry {
  type: 'user' | 'assistant' | 'run' | 'system' | 'event';
  content: string;
  timestamp: Date;
}

export interface LiveAgentEventSummary {
  eventType: string;
  compactText: string;
  runId?: string;
  seq?: number;
  status?: string;
  toolName?: string;
  detail?: string;
  timestamp: Date;
}

export interface ApprovalInfo {
  runId: string;
  toolName?: string;
  reason?: string;
  sessionId?: string;
}

export interface ClarificationInfo {
  runId: string;
  message: string;
  suggestedQuestions: string[];
  sessionId?: string;
}
