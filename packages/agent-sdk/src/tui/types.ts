import type { RuntimeMode } from '../index.js';
import type { TuiSettingsConfig } from '../index.js';
import type { UsageSummary } from '@adaptive-agent/core';

export type EventStreamMode = 'progress' | 'compact' | 'verbose' | 'off';

export interface TuiClientState {
  agentId: string;
  agentName: string;
  provider?: string;
  model?: string;
  runtimeMode: RuntimeMode;
  invocationMode: 'run' | 'chat';
  currentRunId?: string;
  currentRunStartedAt?: Date;
  currentRunDurationMs?: number;
  currentRunUsage?: UsageSummary;
  pendingApprovalRunId?: string;
  pendingClarificationRunId?: string;
  lastFailedRunId?: string;
  latestAgentEvent?: LiveAgentEventSummary;
  eventMode: EventStreamMode;
  tui: TuiSettingsConfig;
  lastAssistantContentByRun: Map<string, string>;
  busy: boolean;
}

export interface MessageEntry {
  type: 'user' | 'assistant' | 'progress' | 'run' | 'system' | 'event';
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
}

export interface ClarificationInfo {
  runId: string;
  message: string;
  suggestedQuestions: string[];
}
