import type { AgentEvent, EventSink, EventStore, UUID } from './types.js';

function cloneEvent(event: AgentEvent): AgentEvent {
  return structuredClone(event);
}

export class InMemoryEventStore implements EventStore, EventSink {
  private readonly eventsByRun = new Map<UUID, AgentEvent[]>();

  async append(event: Omit<AgentEvent, 'id' | 'seq' | 'createdAt'>): Promise<AgentEvent> {
    const events = this.eventsByRun.get(event.runId) ?? [];
    const nextEvent: AgentEvent = {
      ...event,
      id: crypto.randomUUID(),
      seq: events.length + 1,
      createdAt: new Date().toISOString(),
    };

    events.push(nextEvent);
    this.eventsByRun.set(event.runId, events);
    return cloneEvent(nextEvent);
  }

  async listByRun(runId: UUID, afterSeq = 0): Promise<AgentEvent[]> {
    const events = this.eventsByRun.get(runId) ?? [];
    return events.filter((event) => event.seq > afterSeq).map(cloneEvent);
  }

  async emit(event: Omit<AgentEvent, 'id' | 'seq' | 'createdAt'>): Promise<void> {
    await this.append(event);
  }
}
