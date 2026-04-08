import { describe, expect, it } from 'vitest';

import {
  InMemoryCronJobStore,
  InMemoryCronRunStore,
  InMemorySessionRunLinkStore,
  InMemorySessionStore,
  InMemoryTranscriptMessageStore,
} from './stores.js';

describe('gateway in-memory stores', () => {
  it('stores and isolates session records by auth subject', async () => {
    const store = new InMemorySessionStore();
    const created = await store.create({
      id: 'session-1',
      channelId: 'webchat',
      agentId: 'support-agent',
      invocationMode: 'chat',
      authSubject: 'user-123',
      tenantId: 'acme',
      status: 'idle',
      transcriptVersion: 0,
      metadata: { locale: 'en-US' },
      createdAt: '2026-04-08T10:00:00.000Z',
      updatedAt: '2026-04-08T10:00:00.000Z',
    });

    created.metadata = { locale: 'fr-FR' };
    const stored = await store.get('session-1');

    expect(stored?.metadata).toEqual({ locale: 'en-US' });
    expect(await store.listByAuthSubject('user-123')).toEqual([stored]);
  });

  it('preserves transcript ordering by session and sequence number', async () => {
    const store = new InMemoryTranscriptMessageStore();
    await store.append({
      id: 'message-2',
      sessionId: 'session-1',
      sequence: 2,
      role: 'assistant',
      content: 'Reply',
      createdAt: '2026-04-08T10:00:02.000Z',
    });
    await store.append({
      id: 'message-1',
      sessionId: 'session-1',
      sequence: 1,
      role: 'user',
      content: 'Hello',
      createdAt: '2026-04-08T10:00:01.000Z',
    });

    expect((await store.listBySession('session-1')).map((message) => message.id)).toEqual(['message-1', 'message-2']);
  });

  it('indexes session-run links by run id and session id', async () => {
    const store = new InMemorySessionRunLinkStore();
    await store.append({
      sessionId: 'session-1',
      runId: 'run-1',
      rootRunId: 'run-1',
      invocationKind: 'chat',
      turnIndex: 1,
      createdAt: '2026-04-08T10:00:00.000Z',
    });

    expect(await store.getByRunId('run-1')).toMatchObject({ sessionId: 'session-1', runId: 'run-1' });
    expect(await store.listBySession('session-1')).toHaveLength(1);
  });

  it('returns only enabled cron jobs that are due', async () => {
    const store = new InMemoryCronJobStore();
    await store.create({
      id: 'job-2',
      schedule: '0 * * * *',
      targetKind: 'isolated_run',
      target: { agentId: 'support-agent' },
      deliveryMode: 'none',
      delivery: {},
      enabled: true,
      nextFireAt: '2026-04-08T10:00:00.000Z',
      createdAt: '2026-04-08T09:00:00.000Z',
      updatedAt: '2026-04-08T09:00:00.000Z',
    });
    await store.create({
      id: 'job-1',
      schedule: '*/5 * * * *',
      targetKind: 'session_event',
      target: { sessionId: 'session-1' },
      deliveryMode: 'session',
      delivery: { sessionId: 'session-1' },
      enabled: true,
      nextFireAt: '2026-04-08T09:55:00.000Z',
      createdAt: '2026-04-08T09:00:00.000Z',
      updatedAt: '2026-04-08T09:00:00.000Z',
    });
    await store.create({
      id: 'job-3',
      schedule: '0 0 * * *',
      targetKind: 'isolated_chat',
      target: { agentId: 'summarizer' },
      deliveryMode: 'announce',
      delivery: { channel: 'agent:summarizer' },
      enabled: false,
      nextFireAt: '2026-04-08T09:00:00.000Z',
      createdAt: '2026-04-08T09:00:00.000Z',
      updatedAt: '2026-04-08T09:00:00.000Z',
    });

    expect((await store.listDue('2026-04-08T10:00:00.000Z')).map((job) => job.id)).toEqual(['job-1', 'job-2']);
  });

  it('tracks cron runs by job and fire time', async () => {
    const store = new InMemoryCronRunStore();
    await store.create({
      id: 'cron-run-1',
      jobId: 'job-1',
      fireTime: '2026-04-08T10:00:00.000Z',
      status: 'running',
      startedAt: '2026-04-08T10:00:01.000Z',
    });
    await store.create({
      id: 'cron-run-2',
      jobId: 'job-1',
      fireTime: '2026-04-08T11:00:00.000Z',
      status: 'queued',
      startedAt: '2026-04-08T11:00:01.000Z',
    });

    expect(await store.findByFireTime('job-1', '2026-04-08T10:00:00.000Z')).toMatchObject({ id: 'cron-run-1' });
    expect((await store.listByJob('job-1')).map((run) => run.id)).toEqual(['cron-run-1', 'cron-run-2']);
  });
});
