export interface ActivityEvent {
  eventId: string;
  rootRunId: string;
  runId: string;
  seq: number;
  kind: string;
  message: string;
  createdAt: string;
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
