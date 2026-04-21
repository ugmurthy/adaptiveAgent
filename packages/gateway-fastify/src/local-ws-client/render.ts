import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

import type { AgentEventFrame } from '../protocol.js';

marked.use(markedTerminal() as never);

export function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  return JSON.stringify(value, null, 2) ?? String(value);
}

export function renderMarkedValue(value: unknown): string {
  return marked.parse(formatValue(value)) as string;
}

export function formatVerboseAgentEventFrame(frame: AgentEventFrame): string {
  const correlation = [
    frame.sessionId ? `session=${frame.sessionId}` : undefined,
    frame.runId ? `run=${frame.runId}` : undefined,
    frame.rootRunId ? `root=${frame.rootRunId}` : undefined,
    frame.parentRunId ? `parent=${frame.parentRunId}` : undefined,
    frame.agentId ? `agent=${frame.agentId}` : undefined,
  ].filter((value): value is string => typeof value === 'string');

  const prefix = correlation.length > 0 ? `event> ${frame.eventType} (${correlation.join(', ')})` : `event> ${frame.eventType}`;

  if (frame.data === null || typeof frame.data === 'undefined') {
    return prefix;
  }

  const formattedData = formatValue(frame.data);
  if (formattedData.includes('\n')) {
    return `${prefix}\ndata: ${formattedData}`;
  }

  return `${prefix} data=${formattedData}`;
}

export function shortRunId(runId: string): string {
  return `run:${runId.slice(0, 8)}`;
}

export function isClarificationRequestOutput(
  value: unknown,
): value is { status: 'clarification_requested'; message: string; suggestedQuestions: string[] } {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as {
    status?: unknown;
    message?: unknown;
    suggestedQuestions?: unknown;
  };
  return (
    candidate.status === 'clarification_requested' &&
    typeof candidate.message === 'string' &&
    Array.isArray(candidate.suggestedQuestions) &&
    candidate.suggestedQuestions.every((entry) => typeof entry === 'string')
  );
}
