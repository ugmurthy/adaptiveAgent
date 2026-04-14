import { describe, expect, it } from 'vitest';

import {
  type FailedRunTrackingState,
  formatCompactAgentEventFrame,
  getInteractiveSessionMode,
  parseClarifyCommand,
  parseEventsCommand,
  parseRetryCommand,
  recordFailedRunFromAgentEvent,
  recordInteractiveSession,
  selectInteractiveSession,
} from './local-ws-client.js';

describe('selectInteractiveSession', () => {
  it('keeps chat traffic on the primary session', () => {
    expect(selectInteractiveSession('chat', { sessionId: 'chat-1' })).toEqual({
      sessionId: 'chat-1',
      shouldOpenSession: false,
    });
  });

  it('opens a dedicated run session instead of reusing the chat session', () => {
    expect(selectInteractiveSession('run', { sessionId: 'chat-1' })).toEqual({
      shouldOpenSession: true,
    });
  });

  it('reuses the dedicated run session once it exists', () => {
    expect(selectInteractiveSession('run', { sessionId: 'chat-1', runSessionId: 'run-1' })).toEqual({
      sessionId: 'run-1',
      shouldOpenSession: false,
    });
  });
});

describe('recordInteractiveSession', () => {
  it('stores the primary chat session without affecting run session state', () => {
    const state = {} as { sessionId?: string; runSessionId?: string };

    recordInteractiveSession(state, 'chat', 'chat-1');

    expect(state).toEqual({ sessionId: 'chat-1' });
  });

  it('stores a dedicated run session without overwriting the chat session', () => {
    const state = { sessionId: 'chat-1' } as { sessionId?: string; runSessionId?: string };

    recordInteractiveSession(state, 'run', 'run-1');

    expect(state).toEqual({
      sessionId: 'chat-1',
      runSessionId: 'run-1',
    });
  });

  it('moves the same id out of chat state when it is later classified as run', () => {
    const state = { sessionId: 'shared-1' } as { sessionId?: string; runSessionId?: string };

    recordInteractiveSession(state, 'run', 'shared-1');

    expect(state).toEqual({
      sessionId: undefined,
      runSessionId: 'shared-1',
    });
  });
});

describe('getInteractiveSessionMode', () => {
  it('classifies reattached run sessions from the opened frame', () => {
    expect(getInteractiveSessionMode({ invocationMode: 'run' })).toBe('run');
  });

  it('defaults opened sessions without a pinned invocation mode to chat', () => {
    expect(getInteractiveSessionMode({})).toBe('chat');
  });
});

describe('recordFailedRunFromAgentEvent', () => {
  it('tracks replayed run.failed events for retry without an explicit runId', () => {
    const state: FailedRunTrackingState = {
      failedRunSessionIds: new Map<string, string>(),
    };

    recordFailedRunFromAgentEvent(state, {
      eventType: 'run.failed',
      runId: 'run-failed',
      sessionId: 'session-1',
    });

    expect(parseRetryCommand('/retry', state.lastFailedRunId)).toBe('run-failed');
    expect(state.failedRunSessionIds.get('run-failed')).toBe('session-1');
  });

  it('ignores non-failure events', () => {
    const state: FailedRunTrackingState = {
      failedRunSessionIds: new Map<string, string>(),
    };

    recordFailedRunFromAgentEvent(state, {
      eventType: 'run.completed',
      runId: 'run-ok',
      sessionId: 'session-1',
    });

    expect(state.lastFailedRunId).toBeUndefined();
    expect(state.failedRunSessionIds.size).toBe(0);
  });
});

describe('parseClarifyCommand', () => {
  it('uses the pending clarification run when no runId is supplied', () => {
    expect(parseClarifyCommand('/clarify I want the markdown version', 'run-1')).toEqual({
      runId: 'run-1',
      message: 'I want the markdown version',
    });
  });

  it('accepts an explicit tracked runId', () => {
    expect(parseClarifyCommand('/clarify run-2 Use csv output', 'run-1', new Set(['run-2']))).toEqual({
      runId: 'run-2',
      message: 'Use csv output',
    });
  });
});

describe('parseEventsCommand', () => {
  it('reports the current realtime event mode when no explicit mode is supplied', () => {
    expect(parseEventsCommand('/event', 'compact')).toEqual({
      eventMode: 'compact',
      message: 'Realtime events are on (one-line).',
    });
  });

  it('turns realtime events on in one-line mode explicitly', () => {
    expect(parseEventsCommand('/events on', 'verbose')).toEqual({
      eventMode: 'compact',
      message: 'Realtime events enabled (one-line).',
    });
  });

  it('turns realtime events on in verbose mode explicitly', () => {
    expect(parseEventsCommand('/event on verbose', 'compact')).toEqual({
      eventMode: 'verbose',
      message: 'Realtime events enabled (verbose).',
    });
  });

  it('turns realtime events off explicitly', () => {
    expect(parseEventsCommand('/events off', 'compact')).toEqual({
      eventMode: 'off',
      message: 'Realtime events disabled.',
    });
  });

  it('rejects invalid realtime event arguments', () => {
    expect(() => parseEventsCommand('/events maybe', 'compact')).toThrow('Usage: /event [on [verbose]|off]');
  });
});

describe('formatCompactAgentEventFrame', () => {
  it('formats tool lifecycle events in the one-line run-agent style', () => {
    expect(
      formatCompactAgentEventFrame({
        type: 'agent.event',
        eventType: 'tool.started',
        data: { toolName: 'read_file' },
        runId: '12345678-aaaa-bbbb-cccc-1234567890ab',
        seq: 7,
        createdAt: '2026-04-10T12:34:56.000Z',
      }),
    ).toBe('[12:34:56] run:12345678 #7 tool read_file started');
  });

  it('formats status transitions using payload details', () => {
    expect(
      formatCompactAgentEventFrame({
        type: 'agent.event',
        eventType: 'run.status_changed',
        data: { fromStatus: 'queued', toStatus: 'running' },
        runId: '12345678-aaaa-bbbb-cccc-1234567890ab',
        seq: 2,
        createdAt: '2026-04-10T12:35:01.000Z',
      }),
    ).toBe('[12:35:01] run:12345678 #2 status queued -> running');
  });
});
