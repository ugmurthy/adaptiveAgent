import { describe, expect, it } from 'bun:test';

import { activityItems, addActivity, formatDuration, modelTiming, toolSymbol, type ActivityEvent } from './activity';

const event = (value: Partial<ActivityEvent> & Pick<ActivityEvent, 'eventId'|'runId'|'seq'|'kind'>): ActivityEvent => ({
  rootRunId: 'root',
  message: value.kind,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...value,
});

describe('activity narrative', () => {
  it('deduplicates by event ID and orders each run by sequence', () => {
    let activity: Record<string, ActivityEvent[]> = {};
    activity = addActivity(activity, event({ eventId: 'two', runId: 'child', seq: 2, kind: 'step.completed' }));
    activity = addActivity(activity, event({ eventId: 'one', runId: 'child', seq: 1, kind: 'step.started' }));
    activity = addActivity(activity, event({ eventId: 'two', runId: 'child', seq: 2, kind: 'step.completed' }));
    expect(activity.root.map(({ eventId }) => eventId)).toEqual(['one', 'two']);
  });

  it('deduplicates events beyond the visible narrative window', () => {
    let activity: Record<string, ActivityEvent[]> = {};
    for (let seq = 1; seq <= 501; seq += 1) {
      activity = addActivity(activity, event({ eventId: `event-${seq}`, runId: 'root', seq, kind: 'step.started' }));
    }
    const duplicate = addActivity(activity, event({ eventId: 'event-1', runId: 'root', seq: 1, kind: 'step.started' }));
    expect(duplicate).toBe(activity);
    expect(activity.root).toHaveLength(501);
  });

  it('pairs spans by run and call ID without adding retry delay events', () => {
    const events = [
      event({ eventId: 'start-a', runId: 'root', seq: 1, kind: 'model.started', callId: 'same', provider: 'openai', model: 'gpt', createdAt: '2026-01-01T00:00:00.000Z' }),
      event({ eventId: 'retry-a', runId: 'root', seq: 2, kind: 'model.retry', callId: 'same', durationMs: 900, retryDelayMs: 5_000 }),
      event({ eventId: 'end-a', runId: 'root', seq: 3, kind: 'model.completed', callId: 'same', durationMs: 1_200, createdAt: '2026-01-01T00:00:09.000Z' }),
      event({ eventId: 'child', runId: 'child', seq: 1, kind: 'run.created', delegateName: 'researcher' }),
      event({ eventId: 'start-child', runId: 'child', seq: 2, kind: 'model.started', callId: 'same', createdAt: '2026-01-01T00:00:10.000Z' }),
    ];
    expect(modelTiming(events, Date.parse('2026-01-01T00:00:10.420Z'))).toEqual({
      completedMs: 1_200,
      current: {
        runId: 'child',
        provider: undefined,
        model: undefined,
        delegateName: 'researcher',
        elapsedMs: 420,
      },
    });
  });

  it('does not invent timestamps for malformed activity events', () => {
    const malformed = event({ eventId: 'start', runId: 'root', seq: 1, kind: 'model.started', callId: 'call', createdAt: 'invalid' });
    expect(modelTiming([malformed], Date.now())).toEqual({ completedMs: 0, current: undefined });
  });

  it('uses the authoritative model start and prefers reported terminal duration', () => {
    const started = event({
      eventId: 'start', runId: 'root', seq: 1, kind: 'model.started', callId: 'call',
      startedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:01.000Z',
    });
    expect(modelTiming([started], Date.parse('2026-01-01T00:00:03.000Z')).current?.elapsedMs).toBe(3_000);
    const completed = event({
      eventId: 'end', runId: 'root', seq: 2, kind: 'model.completed', callId: 'call',
      createdAt: '2026-01-01T00:00:05.000Z',
    });
    expect(modelTiming([started, completed], Date.now()).completedMs).toBe(5_000);
    expect(modelTiming([started, { ...completed, durationMs: 1_250 }], Date.now()).completedMs).toBe(1_250);
  });

  it('formats compact durations at every required range', () => {
    expect(formatDuration(420)).toBe('420ms');
    expect(formatDuration(3_200)).toBe('3.2s');
    expect(formatDuration(38_000)).toBe('38s');
    expect(formatDuration(128_000)).toBe('2m 08s');
    expect(formatDuration(3_840_000)).toBe('1h 04m');
  });

  it('deduplicates assistant prose per model step and updates tools in place', () => {
    const events = [
      event({ eventId: 'approval', runId: 'root', seq: 1, kind: 'approval.requested', stepId: 'step-1', toolCallId: 'call-1', toolName: 'web_search@1', toolContext: 'adaptive agents', assistantContent: 'I will research this.' }),
      event({ eventId: 'started', runId: 'root', seq: 2, kind: 'tool.started', stepId: 'step-1', toolCallId: 'call-1', toolName: 'web_search@1', toolContext: 'adaptive agents', assistantContent: 'I will research this.' }),
      event({ eventId: 'done', runId: 'root', seq: 3, kind: 'tool.completed', stepId: 'step-1', toolCallId: 'call-1', toolName: 'web_search@1', durationMs: 240, assistantContent: 'I will research this.' }),
    ];

    expect(activityItems(events)).toEqual([
      { key: 'assistant:root:step-1', type: 'assistant', actor: 'Agent', content: 'I will research this.' },
      { key: 'tool:root:call-1', type: 'tool', actor: 'Agent', toolName: 'web_search', toolContext: 'adaptive agents', state: 'Done', durationMs: 240 },
    ]);
  });

  it('maps approval rejection and invalid tool calls to skipped', () => {
    const events = [
      event({ eventId: 'rejected', runId: 'root', seq: 1, kind: 'approval.resolved', toolCallId: 'call-1', toolName: 'write_file', approved: false }),
      event({ eventId: 'invalid', runId: 'root', seq: 2, kind: 'model.tool_call_rejected', toolCallId: 'call-2', toolName: 'fetch_page' }),
    ];
    expect(activityItems(events).filter((item) => item.type === 'tool').map((item) => item.state)).toEqual(['Skipped', 'Skipped']);
    expect(toolSymbol('write_file')).toBe('▤');
    expect(toolSymbol('fetch_page')).toBe('↗');
  });
});
