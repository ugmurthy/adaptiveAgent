import type { GatewayConfig } from './config.js';
import type { ChatMessage } from './core.js';
import type { GatewaySessionRecord, TranscriptMessageRecord } from './stores.js';

export interface GatewayTranscriptPolicy {
  recentMessageWindow: number;
  summaryTriggerWindow: number;
  summaryMaxMessages: number;
  summaryLineMaxLength: number;
}

const DEFAULT_TRANSCRIPT_POLICY: GatewayTranscriptPolicy = {
  recentMessageWindow: 6,
  summaryTriggerWindow: 6,
  summaryMaxMessages: 12,
  summaryLineMaxLength: 160,
};

export function resolveGatewayTranscriptPolicy(config: Pick<GatewayConfig, 'transcript'>): GatewayTranscriptPolicy {
  return {
    recentMessageWindow: config.transcript?.recentMessageWindow ?? DEFAULT_TRANSCRIPT_POLICY.recentMessageWindow,
    summaryTriggerWindow: config.transcript?.summaryTriggerWindow ?? DEFAULT_TRANSCRIPT_POLICY.summaryTriggerWindow,
    summaryMaxMessages: config.transcript?.summaryMaxMessages ?? DEFAULT_TRANSCRIPT_POLICY.summaryMaxMessages,
    summaryLineMaxLength: config.transcript?.summaryLineMaxLength ?? DEFAULT_TRANSCRIPT_POLICY.summaryLineMaxLength,
  };
}

export function buildTranscriptReplayEnvelope(
  session: GatewaySessionRecord,
  transcriptMessages: TranscriptMessageRecord[],
  policy: GatewayTranscriptPolicy,
): ChatMessage[] {
  const summary = session.transcriptSummary ?? buildTranscriptSummary(transcriptMessages, policy);
  const recentMessages = transcriptMessages.slice(-policy.recentMessageWindow).map(toChatMessage);

  return summary
    ? [
        {
          role: 'system',
          content: `Conversation summary:\n${summary}`,
        },
        ...recentMessages,
      ]
    : recentMessages;
}

export function buildTranscriptSummary(
  transcriptMessages: TranscriptMessageRecord[],
  policy: GatewayTranscriptPolicy,
): string | undefined {
  if (transcriptMessages.length <= policy.summaryTriggerWindow) {
    return undefined;
  }

  const olderMessages = transcriptMessages.slice(0, Math.max(0, transcriptMessages.length - policy.recentMessageWindow));
  if (olderMessages.length === 0) {
    return undefined;
  }

  return olderMessages
    .slice(-policy.summaryMaxMessages)
    .map((message) => formatSummaryLine(message, policy.summaryLineMaxLength))
    .join('\n');
}

function formatSummaryLine(message: TranscriptMessageRecord, maxLength: number): string {
  return `${summaryRoleLabel(message.role)}: ${truncateSummaryText(message.content, maxLength)}`;
}

function truncateSummaryText(content: string, maxLength: number): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function summaryRoleLabel(role: TranscriptMessageRecord['role']): string {
  switch (role) {
    case 'assistant':
      return 'Assistant';
    case 'system':
      return 'System';
    case 'tool':
      return 'Tool';
    case 'user':
    default:
      return 'User';
  }
}

function toChatMessage(message: TranscriptMessageRecord): ChatMessage {
  if (message.role === 'tool') {
    return {
      role: 'system',
      content: `Tool output: ${message.content}`,
    };
  }

  return {
    role: message.role,
    content: message.content,
  };
}
