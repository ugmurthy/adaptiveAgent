import { describe, expect, it, vi } from 'vitest';

import { createInMemoryGatewayStores, type GatewayCronJobRecord, type GatewayCronRunRecord } from './stores.js';
import { deliverCronResult, resolveCronRunStatusForApproval } from './cron-delivery.js';

const fixedNow = () => new Date('2026-01-01T00:10:00.000Z');

function createTestJob(overrides: Partial<GatewayCronJobRecord> = {}): GatewayCronJobRecord {
  return {
    id: 'job-1',
    schedule: '*/5 * * * *',
    targetKind: 'isolated_run',
    target: { goal: 'test' },
    deliveryMode: 'none',
    delivery: {},
    enabled: true,
    nextFireAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function createTestCronRun(overrides: Partial<GatewayCronRunRecord> = {}): GatewayCronRunRecord {
  return {
    id: 'crun-1',
    jobId: 'job-1',
    fireTime: '2026-01-01T00:00:00.000Z',
    status: 'succeeded',
    startedAt: '2026-01-01T00:00:01.000Z',
    finishedAt: '2026-01-01T00:05:00.000Z',
    runId: 'run-1',
    rootRunId: 'run-1',
    ...overrides,
  };
}

describe('deliverCronResult', () => {
  describe('none delivery mode', () => {
    it('returns delivered: true immediately', async () => {
      const stores = createInMemoryGatewayStores();
      const result = await deliverCronResult({
        job: createTestJob({ deliveryMode: 'none' }),
        cronRun: createTestCronRun(),
        stores,
        now: fixedNow,
      });

      expect(result.delivered).toBe(true);
    });
  });

  describe('session delivery mode', () => {
    it('appends a system transcript message to the target session', async () => {
      const stores = createInMemoryGatewayStores();
      await stores.sessions.create({
        id: 'sess-1',
        channelId: 'main',
        authSubject: 'user-1',
        status: 'idle',
        transcriptVersion: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      const result = await deliverCronResult({
        job: createTestJob({ deliveryMode: 'session' }),
        cronRun: createTestCronRun({ sessionId: 'sess-1' }),
        stores,
        now: fixedNow,
      });

      expect(result.delivered).toBe(true);

      const messages = await stores.transcriptMessages.listBySession('sess-1');
      expect(messages).toHaveLength(1);
      expect(messages[0]!.role).toBe('system');
      expect(messages[0]!.content).toContain('completed successfully');
    });

    it('uses delivery.sessionId when cronRun.sessionId is missing', async () => {
      const stores = createInMemoryGatewayStores();
      await stores.sessions.create({
        id: 'sess-2',
        channelId: 'main',
        authSubject: 'user-1',
        status: 'idle',
        transcriptVersion: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      const result = await deliverCronResult({
        job: createTestJob({ deliveryMode: 'session', delivery: { sessionId: 'sess-2' } }),
        cronRun: createTestCronRun({ sessionId: undefined }),
        stores,
        now: fixedNow,
      });

      expect(result.delivered).toBe(true);
    });

    it('fails when no sessionId is available', async () => {
      const stores = createInMemoryGatewayStores();
      const result = await deliverCronResult({
        job: createTestJob({ deliveryMode: 'session' }),
        cronRun: createTestCronRun({ sessionId: undefined }),
        stores,
        now: fixedNow,
      });

      expect(result.delivered).toBe(false);
      expect(result.error).toContain('sessionId');
    });

    it('fails when the target session does not exist', async () => {
      const stores = createInMemoryGatewayStores();
      const result = await deliverCronResult({
        job: createTestJob({ deliveryMode: 'session' }),
        cronRun: createTestCronRun({ sessionId: 'nonexistent' }),
        stores,
        now: fixedNow,
      });

      expect(result.delivered).toBe(false);
      expect(result.error).toContain('does not exist');
    });
  });

  describe('announce delivery mode', () => {
    it('succeeds when channelId is configured', async () => {
      const stores = createInMemoryGatewayStores();
      const result = await deliverCronResult({
        job: createTestJob({
          deliveryMode: 'announce',
          delivery: { channelId: 'announcements' },
        }),
        cronRun: createTestCronRun(),
        stores,
        now: fixedNow,
      });

      expect(result.delivered).toBe(true);
    });

    it('fails when no channelId is available', async () => {
      const stores = createInMemoryGatewayStores();
      const result = await deliverCronResult({
        job: createTestJob({
          deliveryMode: 'announce',
          target: { goal: 'test' },
          delivery: {},
        }),
        cronRun: createTestCronRun(),
        stores,
        now: fixedNow,
      });

      expect(result.delivered).toBe(false);
      expect(result.error).toContain('channelId');
    });
  });

  describe('webhook delivery mode', () => {
    it('posts a completion payload to the configured URL', async () => {
      const stores = createInMemoryGatewayStores();
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
      });
      vi.stubGlobal('fetch', mockFetch);

      try {
        const result = await deliverCronResult({
          job: createTestJob({
            deliveryMode: 'webhook',
            delivery: { url: 'https://hooks.example.com/cron' },
          }),
          cronRun: createTestCronRun(),
          stores,
          now: fixedNow,
        });

        expect(result.delivered).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(1);

        const [calledUrl, calledOptions] = mockFetch.mock.calls[0]!;
        expect(calledUrl).toBe('https://hooks.example.com/cron');
        expect(calledOptions.method).toBe('POST');

        const body = JSON.parse(calledOptions.body);
        expect(body.type).toBe('cron.completed');
        expect(body.jobId).toBe('job-1');
        expect(body.status).toBe('succeeded');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('includes X-Webhook-Secret header when secret is configured', async () => {
      const stores = createInMemoryGatewayStores();
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
      vi.stubGlobal('fetch', mockFetch);

      try {
        await deliverCronResult({
          job: createTestJob({
            deliveryMode: 'webhook',
            delivery: { url: 'https://hooks.example.com/cron', secret: 's3cret' },
          }),
          cronRun: createTestCronRun(),
          stores,
          now: fixedNow,
        });

        const [, calledOptions] = mockFetch.mock.calls[0]!;
        expect(calledOptions.headers['X-Webhook-Secret']).toBe('s3cret');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('reports HTTP errors', async () => {
      const stores = createInMemoryGatewayStores();
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });
      vi.stubGlobal('fetch', mockFetch);

      try {
        const result = await deliverCronResult({
          job: createTestJob({
            deliveryMode: 'webhook',
            delivery: { url: 'https://hooks.example.com/cron' },
          }),
          cronRun: createTestCronRun(),
          stores,
          now: fixedNow,
        });

        expect(result.delivered).toBe(false);
        expect(result.error).toContain('HTTP 500');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('fails when no url is configured', async () => {
      const stores = createInMemoryGatewayStores();
      const result = await deliverCronResult({
        job: createTestJob({ deliveryMode: 'webhook', delivery: {} }),
        cronRun: createTestCronRun(),
        stores,
        now: fixedNow,
      });

      expect(result.delivered).toBe(false);
      expect(result.error).toContain('delivery.url');
    });

    it('handles fetch exceptions', async () => {
      const stores = createInMemoryGatewayStores();
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

      try {
        const result = await deliverCronResult({
          job: createTestJob({
            deliveryMode: 'webhook',
            delivery: { url: 'https://hooks.example.com/cron' },
          }),
          cronRun: createTestCronRun(),
          stores,
          now: fixedNow,
        });

        expect(result.delivered).toBe(false);
        expect(result.error).toContain('network error');
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe('unknown delivery mode', () => {
    it('returns an error', async () => {
      const stores = createInMemoryGatewayStores();
      const result = await deliverCronResult({
        job: createTestJob({ deliveryMode: 'magic' as any }),
        cronRun: createTestCronRun(),
        stores,
        now: fixedNow,
      });

      expect(result.delivered).toBe(false);
      expect(result.error).toContain('Unknown delivery mode');
    });
  });
});

describe('resolveCronRunStatusForApproval', () => {
  it('returns needs_review when policy is needs_review', () => {
    expect(resolveCronRunStatusForApproval('approval_requested', 'needs_review')).toBe('needs_review');
  });

  it('returns failed when policy is fail', () => {
    expect(resolveCronRunStatusForApproval('approval_requested', 'fail')).toBe('failed');
  });
});
