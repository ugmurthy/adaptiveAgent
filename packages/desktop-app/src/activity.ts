export interface ActivityEvent {
  eventId: string;
  rootRunId: string;
  runId: string;
  seq: number;
  kind: string;
  message: string;
  createdAt: string;
  stepId?: string;
  toolCallId?: string;
  toolName?: string;
  toolContext?: string;
  assistantContent?: string;
  approved?: boolean;
  startedAt?: string;
  callId?: string;
  provider?: string;
  model?: string;
  delegateName?: string;
  durationMs?: number;
  attempt?: number;
  maxAttempts?: number;
  nextAttempt?: number;
  retryDelayMs?: number;
  retryable?: boolean;
}

export type ToolActivityState = 'Approval' | 'Running' | 'Done' | 'Failed' | 'Skipped';

export type ActivityItem =
  | { key: string; type: 'assistant'; actor: string; content: string; durationMs?: number }
  | { key: string; type: 'tool'; actor: string; toolName: string; toolContext?: string; state: ToolActivityState; durationMs?: number }
  | { key: string; type: 'event'; actor: string; content: string; durationMs?: number };

export interface ModelTiming {
  current?: {
    runId: string;
    provider?: string;
    model?: string;
    delegateName?: string;
    elapsedMs: number;
  };
  completedMs: number;
}

export function addActivity(
  activity: Record<string, ActivityEvent[]>,
  event: ActivityEvent,
): Record<string, ActivityEvent[]> {
  const current = activity[event.rootRunId] ?? [];
  if (current.some((candidate) => candidate.eventId === event.eventId)) return activity;

  const next = [...current];
  const successor = next.findIndex(
    (candidate) => candidate.runId === event.runId && candidate.seq > event.seq,
  );
  if (successor >= 0) {
    next.splice(successor, 0, event);
  } else {
    const predecessor = next.findLastIndex(
      (candidate) => candidate.runId === event.runId && candidate.seq < event.seq,
    );
    next.splice(predecessor >= 0 ? predecessor + 1 : next.length, 0, event);
  }

  return { ...activity, [event.rootRunId]: next };
}

const HIDDEN_NARRATIVE_EVENTS = new Set([
  'model.started',
  'model.completed',
  'model.failed',
  'step.started',
  'step.completed',
  'usage.updated',
  'snapshot.created',
]);

export function activityItems(events: ActivityEvent[]): ActivityItem[] {
  const items: ActivityItem[] = [];
  const itemIndex = new Map<string, number>();
  const assistantIndex = new Map<string, number>();

  for (const event of events) {
    const actor = event.runId === event.rootRunId ? 'Agent' : event.delegateName ?? 'Delegate';
    const assistantContent = event.assistantContent?.trim();
    if (assistantContent) {
      const assistantKey = event.stepId
        ? `${event.runId}:${event.stepId}`
        : `${event.runId}:${assistantContent}`;
      const existingIndex = assistantIndex.get(assistantKey);
      if (existingIndex === undefined) {
        assistantIndex.set(assistantKey, items.length);
        items.push({ key: `assistant:${assistantKey}`, type: 'assistant', actor, content: assistantContent });
      } else {
        items[existingIndex] = { key: `assistant:${assistantKey}`, type: 'assistant', actor, content: assistantContent };
      }
    }

    if (event.toolCallId && toolState(event)) {
      const key = `tool:${event.runId}:${event.toolCallId}`;
      const next: ActivityItem = {
        key,
        type: 'tool',
        actor,
        toolName: canonicalToolName(event.toolName ?? 'tool'),
        ...(event.toolContext ? { toolContext: event.toolContext } : {}),
        state: toolState(event)!,
        ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
      };
      const existingIndex = itemIndex.get(key);
      if (existingIndex === undefined) {
        itemIndex.set(key, items.length);
        items.push(next);
      } else {
        const existing = items[existingIndex];
        if (existing?.type === 'tool') {
          items[existingIndex] = {
            ...existing,
            ...next,
            toolName: next.toolName === 'tool' ? existing.toolName : next.toolName,
            toolContext: next.toolContext ?? existing.toolContext,
          };
        }
      }
      continue;
    }

    if (!HIDDEN_NARRATIVE_EVENTS.has(event.kind)) {
      items.push({
        key: `event:${event.eventId}`,
        type: 'event',
        actor,
        content: event.message,
        ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
      });
    }
  }
  return items;
}

export function toolSymbol(toolName: string): string {
  if (toolName === 'web_search') return '⌕';
  if (toolName === 'read_web_page' || toolName === 'fetch_page') return '↗';
  if (toolName === 'shell_exec') return '›_';
  if (/(?:^|_)(?:read|write|edit|file|directory)(?:_|$)/.test(toolName) || toolName === 'apply_patch') return '▤';
  return '◆';
}

function canonicalToolName(toolName: string): string {
  return toolName.replace(/@\d+$/, '');
}

function toolState(event: ActivityEvent): ToolActivityState | undefined {
  if (event.kind === 'approval.requested') return 'Approval';
  if (event.kind === 'approval.resolved') return event.approved === false ? 'Skipped' : 'Running';
  if (event.kind === 'tool.started') return 'Running';
  if (event.kind === 'tool.completed') return 'Done';
  if (event.kind === 'tool.failed') return 'Failed';
  if (event.kind === 'model.tool_call_rejected') return 'Skipped';
  return undefined;
}

export function modelTiming(events: ActivityEvent[], now: number): ModelTiming {
  const spans = new Map<string, {
    started: ActivityEvent;
    completed?: ActivityEvent;
  }>();
  const delegates = new Map<string, string>();

  for (const event of events) {
    if (event.delegateName) delegates.set(event.runId, event.delegateName);
    if (!event.callId) continue;
    const key = `${event.runId}:${event.callId}`;
    if (event.kind === 'model.started') {
      if (!spans.has(key)) spans.set(key, { started: event });
    } else if (
      (event.kind === 'model.completed' || event.kind === 'model.failed')
      && spans.has(key)
      && !spans.get(key)!.completed
    ) {
      spans.get(key)!.completed = event;
    }
  }

  let completedMs = 0;
  let current: ModelTiming['current'];
  for (const span of spans.values()) {
    const startedAt = modelStartTimestamp(span.started);
    if (startedAt === undefined) continue;
    if (span.completed) {
      const completedAt = eventTimestamp(span.completed);
      if (span.completed.durationMs === undefined && completedAt === undefined) continue;
      completedMs += span.completed.durationMs
        ?? Math.max(0, completedAt! - startedAt);
      continue;
    }
    current = {
      runId: span.started.runId,
      provider: span.started.provider,
      model: span.started.model,
      delegateName: delegates.get(span.started.runId),
      elapsedMs: Math.max(0, now - startedAt),
    };
  }
  return { current, completedMs };
}

function eventTimestamp(event: ActivityEvent): number | undefined {
  const value = Date.parse(event.createdAt);
  return Number.isFinite(value) ? value : undefined;
}

function modelStartTimestamp(event: ActivityEvent): number | undefined {
  const startedAt = Date.parse(event.startedAt ?? '');
  return Number.isFinite(startedAt) ? startedAt : eventTimestamp(event);
}

export function formatDuration(durationMs: number): string {
  const ms = Math.max(0, Math.round(durationMs));
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 10_000) return `${(ms / 1_000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  const totalSeconds = Math.floor(ms / 1_000);
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m ${String(totalSeconds % 60).padStart(2, '0')}s`;
  }
  return `${Math.floor(totalMinutes / 60)}h ${String(totalMinutes % 60).padStart(2, '0')}m`;
}
