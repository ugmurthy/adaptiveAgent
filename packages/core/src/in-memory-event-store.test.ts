import { describe, expect, it } from 'vitest';

import { InMemoryEventStore } from './in-memory-event-store.js';
import type { AgentEvent } from './types.js';

describe('InMemoryEventStore', () => {
  it('publishes persisted events to subscribers and supports unsubscribe', async () => {
    const store = new InMemoryEventStore();
    const received: AgentEvent[] = [];

    const unsubscribe = store.subscribe((event) => {
      received.push(event);
    });

    const persisted = await store.append({
      runId: 'run-1',
      type: 'run.created',
      schemaVersion: 1,
      payload: {},
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(persisted);

    received[0].type = 'run.failed';
    expect((await store.listByRun('run-1'))[0]?.type).toBe('run.created');

    unsubscribe();

    await store.append({
      runId: 'run-1',
      type: 'run.completed',
      schemaVersion: 1,
      payload: {},
    });

    expect(received).toHaveLength(1);
  });
});
