import type { AgentEvent, JsonObject, JsonValue } from '@adaptive-agent/core';

export interface AgentEventSummary {
  type: string;
  runId: string;
  roleLabel?: string;
  stepId?: string;
  toolCallId?: string;
  toolName?: string;
  status?: string;
  message?: string;
  timestamp: Date;
}

interface AgentEventLike {
  type: string;
  runId: string;
  stepId?: string;
  toolCallId?: string;
  payload: JsonValue;
  createdAt: string;
}

export class AgentEventLabelRegistry {
  private readonly labelsByRunId = new Map<string, string>();

  summarize(event: AgentEventLike): AgentEventSummary {
    const payload = asObject(event.payload);
    const orchestrationLabel = payload ? labelFromOrchestration(payload.orchestration) : undefined;
    if (orchestrationLabel) {
      this.labelsByRunId.set(event.runId, orchestrationLabel);
    }
    const roleLabel = orchestrationLabel ?? this.labelsByRunId.get(event.runId);
    return {
      type: event.type,
      runId: event.runId,
      roleLabel,
      ...(event.stepId ? { stepId: event.stepId } : {}),
      ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
      ...(payload ? readEventPayloadSummary(event.type, payload) : {}),
      timestamp: readEventTimestamp(event.createdAt),
    };
  }

  labelFor(runId: string | undefined): string | undefined {
    return runId ? this.labelsByRunId.get(runId) : undefined;
  }

  displayLabelFor(runId: string | undefined): string | undefined {
    if (!runId) return undefined;
    return this.labelsByRunId.get(runId) ?? shortRunId(runId);
  }
}

export function summarizeAgentEvent(
  event: AgentEventLike,
  registry?: AgentEventLabelRegistry,
): AgentEventSummary {
  return (registry ?? defaultRegistry).summarize(event);
}

export function formatAgentEventSummary(summary: AgentEventSummary): string {
  const parts = [summary.roleLabel ?? shortRunId(summary.runId), summary.type];
  if (summary.stepId) parts.push(`step=${shortRunId(summary.stepId)}`);
  if (summary.toolCallId) parts.push(`toolCall=${shortRunId(summary.toolCallId)}`);
  if (summary.toolName) parts.push(`tool=${summary.toolName}`);
  if (summary.status) parts.push(`status=${summary.status}`);
  if (summary.message) parts.push(summary.message);
  return parts.join(' | ');
}

export function agentEventProgressPrefix(
  event: Pick<AgentEvent, 'runId'>,
  registry?: AgentEventLabelRegistry,
): string {
  const label = (registry ?? defaultRegistry).displayLabelFor(event.runId) ?? shortRunId(event.runId);
  return `[${label}]`;
}

export function agentEventColorKey(
  event: Pick<AgentEvent, 'runId' | 'payload'>,
  registry?: AgentEventLabelRegistry,
): string | undefined {
  const payload = asObject(event.payload);
  const parentRunId = typeof payload?.parentRunId === 'string' ? payload.parentRunId : undefined;
  const runId = parentRunId ?? event.runId;
  return (registry ?? defaultRegistry).labelFor(runId) ?? runId;
}

function readEventPayloadSummary(type: string, payload: JsonObject): Pick<AgentEventSummary, 'toolName' | 'status' | 'message'> {
  if (type === 'context.refs.resolved') {
    const resolved = Array.isArray(payload.resolved) ? payload.resolved : [];
    const truncated = resolved.filter((entry) => asObject(entry)?.truncated === true).length;
    const totalBytes = typeof payload.totalBytes === 'number' ? payload.totalBytes : 0;
    return { message: `refs=${resolved.length} bytes=${totalBytes} truncated=${truncated}` };
  }
  return {
    ...(readString(payload, 'toolName') ? { toolName: readString(payload, 'toolName') } : {}),
    ...(readString(payload, 'status') ?? readString(payload, 'toStatus') ? { status: readString(payload, 'status') ?? readString(payload, 'toStatus') } : {}),
    ...(readString(payload, 'message') ?? readString(payload, 'error') ? { message: readString(payload, 'message') ?? readString(payload, 'error') } : {}),
  };
}

function labelFromOrchestration(value: JsonValue | undefined): string | undefined {
  const orchestration = asObject(value);
  if (!orchestration || orchestration.kind !== 'swarm') return undefined;
  const role = readString(orchestration, 'role');
  if (role === 'worker') {
    const subtaskId = readString(orchestration, 'subtaskId');
    return subtaskId ? `worker:${subtaskId}` : 'worker';
  }
  if (role === 'coordinator' || role === 'quality' || role === 'synthesizer') return role;
  return undefined;
}

function readEventTimestamp(createdAt: string): Date {
  const timestamp = new Date(createdAt);
  return Number.isFinite(timestamp.getTime()) ? timestamp : new Date();
}

function readString(value: JsonObject, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
}

function shortRunId(runId: string): string {
  return runId.length > 8 ? runId.slice(0, 8) : runId;
}

const defaultRegistry = new AgentEventLabelRegistry();
