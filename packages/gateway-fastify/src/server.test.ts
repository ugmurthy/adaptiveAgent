import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  CreatedAdaptiveAgent,
  DelegateDefinition,
  JsonObject,
  JsonValue,
  RuntimeAgentEvent,
  RuntimeEventStore,
  RuntimeRunRecord,
  ToolDefinition,
} from './core.js';
import type { GatewayAuthContext } from './auth.js';
import { createAgentRegistry } from './agent-registry.js';
import { createChannelSubscriptionManager } from './channels.js';
import type { GatewayConfig } from './config.js';
import type { AgentConfig, LoadedConfig } from './config.js';
import { createEmptyResolvedHooks } from './hooks.js';
import type { OutboundFrame } from './protocol.js';
import { subscribeToForwardedRealtimeEvents } from './realtime-events.js';
import { createModuleRegistry } from './registries.js';
import { createGatewayServer, handleGatewaySocketMessage, type RuntimeObserverRegistration } from './server.js';
import { createInMemoryGatewayStores, type GatewaySessionRecord } from './stores.js';

const baseConfig: GatewayConfig = {
  server: {
    host: '127.0.0.1',
    port: 0,
    websocketPath: '/ws',
    healthPath: '/health',
  },
  bindings: [],
  hooks: {
    failurePolicy: 'fail',
    modules: [],
    onAuthenticate: [],
    onSessionResolve: [],
    beforeRoute: [],
    beforeInboundMessage: [],
    beforeRunStart: [],
    afterRunResult: [],
    onAgentEvent: [],
    beforeOutboundFrame: [],
    onDisconnect: [],
    onError: [],
  },
};

describe('createGatewayServer', () => {
  const apps: Array<Awaited<ReturnType<typeof createGatewayServer>>> = [];

  afterEach(async () => {
    await Promise.all(apps.map((app) => app.close()));
    apps.length = 0;
  });

  it('exposes the optional health endpoint', async () => {
    const app = await createGatewayServer(baseConfig);
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      websocketPath: '/ws',
    });
  });

  it('exposes admin-only gateway load status', async () => {
    const stores = createInMemoryGatewayStores();
    await stores.sessions.create({
      id: 'session-running',
      channelId: 'webchat',
      agentId: 'support-agent',
      invocationMode: 'run',
      authSubject: 'user-123',
      tenantId: 'acme',
      status: 'running',
      currentRunId: 'run-1',
      currentRootRunId: 'run-1',
      transcriptVersion: 0,
      createdAt: '2026-04-08T10:00:00.000Z',
      updatedAt: '2026-04-08T10:00:00.000Z',
    });
    await stores.sessions.create({
      id: 'session-awaiting',
      channelId: 'webchat',
      agentId: 'support-agent',
      invocationMode: 'chat',
      authSubject: 'user-123',
      tenantId: 'acme',
      status: 'awaiting_approval',
      currentRunId: 'run-2',
      currentRootRunId: 'run-2',
      transcriptVersion: 0,
      createdAt: '2026-04-08T10:01:00.000Z',
      updatedAt: '2026-04-08T10:01:00.000Z',
    });
    await stores.runAdmissions.tryAcquire(
      {
        id: 'admission-1',
        agentId: 'support-agent',
        tenantId: 'acme',
        sessionId: 'session-running',
        status: 'running',
        leaseOwner: 'gateway',
        leaseExpiresAt: '2026-04-08T10:30:00.000Z',
        createdAt: '2026-04-08T10:02:00.000Z',
        updatedAt: '2026-04-08T10:02:00.000Z',
      },
      { maxActiveRuns: 10, maxActiveRunsPerTenant: 10, maxActiveRunsPerAgent: 10 },
      '2026-04-08T10:02:00.000Z',
    );
    const app = await createGatewayServer(baseConfig, {
      stores,
      auth: createStaticAuthProvider(['admin']),
      now: () => new Date('2026-04-08T10:03:00.000Z'),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/status',
      headers: { authorization: 'Bearer admin-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      checkedAt: '2026-04-08T10:03:00.000Z',
      sessions: {
        total: 2,
        byStatus: {
          running: 1,
          awaiting_approval: 1,
        },
        running: 1,
        awaitingApproval: 1,
      },
      activeRuns: {
        total: 1,
        byAgent: {
          'support-agent': 1,
        },
        byTenant: {
          acme: 1,
        },
      },
    });
  });

  it('rejects gateway load status without the admin role', async () => {
    const app = await createGatewayServer(baseConfig, {
      auth: createStaticAuthProvider(['member']),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/status',
      headers: { authorization: 'Bearer member-token' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      type: 'error',
      code: 'session_forbidden',
      message: 'Gateway status requires the admin role.',
      requestType: 'upgrade',
      details: { requiredRole: 'admin' },
    });
  });

  it('returns persisted dashboard root runs with filters', async () => {
    const querySpy = vi.fn(async <TRow extends Record<string, unknown>>(sql: string, params?: unknown[]) => {
      expect(sql).toContain('from agent_runs root');
      expect(sql).toContain('root.status = any($3::text[])');
      expect(sql).toContain('link.session_id is not null');
      expect(sql).toContain('root.status = \'awaiting_approval\'');
      expect(params).toEqual([
        '2026-04-01T00:00:00.000Z',
        '2026-04-22T23:59:59.000Z',
        ['failed', 'running'],
        'session-1',
        '%quota%',
        26,
        50,
      ]);
      return {
        rows: [{
          root_run_id: 'root-1',
          session_id: 'session-1',
          status: 'awaiting_approval',
          goal: 'Review quota limits',
          goal_preview: 'Review quota limits',
          agent_id: 'support-agent',
          model_provider: 'openai',
          model_name: 'gpt-5.4',
          created_at: '2026-04-21T10:00:00.000Z',
          updated_at: '2026-04-21T10:01:00.000Z',
          completed_at: null,
          duration_ms: null,
          child_run_count: '2',
          tool_call_count: '3',
          total_prompt_tokens: '120',
          total_completion_tokens: '45',
          total_reasoning_tokens: '10',
          estimated_cost_usd: '0.0123',
          pending_approval: {
            runId: 'child-approval',
            rootRunId: 'root-1',
            sessionId: 'session-1',
          },
        }],
      } as unknown as { rows: TRow[]; rowCount: number };
    });
    const app = await createGatewayServer(baseConfig, {
      auth: createStaticAuthProvider(['admin']),
      traceClient: { query: querySpy },
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/runs?from=2026-04-01T00:00:00.000Z&to=2026-04-22T23:59:59.000Z&status=failed,running&session=linked&sessionId=session-1&q=quota&requiresApproval=true&limit=25&offset=50',
      headers: { authorization: 'Bearer admin-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [{
        rootRunId: 'root-1',
        sessionId: 'session-1',
        status: 'awaiting_approval',
        goal: 'Review quota limits',
        goalPreview: 'Review quota limits',
        agentId: 'support-agent',
        modelProvider: 'openai',
        modelName: 'gpt-5.4',
        createdAt: '2026-04-21T10:00:00.000Z',
        updatedAt: '2026-04-21T10:01:00.000Z',
        completedAt: null,
        durationMs: null,
        childRunCount: 2,
        toolCallCount: 3,
        totalPromptTokens: 120,
        totalCompletionTokens: 45,
        totalReasoningTokens: 10,
        estimatedCostUSD: 0.0123,
        pendingApproval: {
          runId: 'child-approval',
          rootRunId: 'root-1',
          sessionId: 'session-1',
        },
      }],
      limit: 25,
      offset: 50,
      nextOffset: null,
    });
  });

  it('rejects dashboard routes without the admin role', async () => {
    const app = await createGatewayServer(baseConfig, {
      auth: createStaticAuthProvider(['member']),
      traceClient: {
        query: async () => ({ rows: [], rowCount: 0 }),
      },
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/runs',
      headers: { authorization: 'Bearer member-token' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      type: 'error',
      code: 'session_forbidden',
      message: 'Gateway dashboard routes require the admin role.',
      requestType: 'upgrade',
      details: { requiredRole: 'admin' },
    });
  });

  it('reports dashboard trace routes as unavailable without a trace client', async () => {
    const app = await createGatewayServer(baseConfig, {
      auth: createStaticAuthProvider(['admin']),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/runs',
      headers: { authorization: 'Bearer admin-token' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      type: 'error',
      code: 'trace_store_unavailable',
      message: 'Persisted run dashboard routes require PostgreSQL runtime stores.',
    });
  });

  it('replays a linked root run from the dashboard API', async () => {
    const stores = createInMemoryGatewayStores();
    await createStoredSession(stores, {
      id: 'session-replay-1',
      channelId: 'web',
      authSubject: 'admin-token',
      agentId: 'support-agent',
      invocationMode: 'run',
      status: 'failed',
      currentRunId: 'run-replay-1',
      currentRootRunId: 'root-replay-1',
      lastCompletedRootRunId: 'root-replay-1',
    });
    await stores.sessionRunLinks.append({
      sessionId: 'session-replay-1',
      runId: 'run-replay-1',
      rootRunId: 'root-replay-1',
      invocationKind: 'run',
      createdAt: '2026-04-08T10:05:00.000Z',
    });

    const app = await createGatewayServer(baseConfig, {
      auth: createStaticAuthProvider(['admin']),
      stores,
      agentRegistry: createGatewayTestAgentRegistry({
        runtimeRuns: {
          'run-replay-1': {
            id: 'run-replay-1',
            rootRunId: 'root-replay-1',
            status: 'failed',
            result: { summary: 'replayed result' },
            errorMessage: 'run failed earlier',
          } as RuntimeRunRecord,
        },
      }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/runs/root-replay-1/replay',
      headers: { authorization: 'Bearer admin-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      sessionId: 'session-replay-1',
      rootRunId: 'root-replay-1',
      runId: 'run-replay-1',
      status: 'failed',
      policy: 'terminal_result',
      replayedFrameType: 'run.output',
      pendingApproval: null,
    });
  });

  it('rejects dashboard replay for sessionless runs', async () => {
    const app = await createGatewayServer(baseConfig, {
      auth: createStaticAuthProvider(['admin']),
      stores: createInMemoryGatewayStores(),
      agentRegistry: createGatewayTestAgentRegistry({ runtimeRuns: {} }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/runs/root-sessionless/replay',
      headers: { authorization: 'Bearer admin-token' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      type: 'error',
      code: 'replay_session_unavailable',
      message: 'No gateway run session is linked to root run "root-sessionless". Replay is not available from the dashboard for sessionless runs.',
    });
  });

  it('retries a linked failed run from the dashboard API', async () => {
    const stores = createInMemoryGatewayStores();
    await createStoredSession(stores, {
      id: 'session-retry-1',
      channelId: 'web',
      authSubject: 'admin-token',
      agentId: 'support-agent',
      invocationMode: 'run',
      status: 'failed',
      currentRunId: 'run-failed-1',
      currentRootRunId: 'root-retry-1',
    });
    await stores.sessionRunLinks.append({
      sessionId: 'session-retry-1',
      runId: 'run-failed-1',
      rootRunId: 'root-retry-1',
      invocationKind: 'run',
      createdAt: '2026-04-08T10:05:00.000Z',
    });

    const retry = vi.fn(async () => ({
      status: 'success' as const,
      runId: 'run-failed-1',
      output: { recovered: true },
      stepsUsed: 4,
      usage: { promptTokens: 12, completionTokens: 6, estimatedCostUSD: 0.0021 },
    }));

    const app = await createGatewayServer(baseConfig, {
      auth: createStaticAuthProvider(['admin']),
      stores,
      agentRegistry: createGatewayTestAgentRegistry({
        retry,
        runtimeRuns: {
          'run-failed-1': {
            id: 'run-failed-1',
            rootRunId: 'root-retry-1',
            status: 'failed',
          } as RuntimeRunRecord,
        },
      }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/runs/root-retry-1/retry',
      headers: { authorization: 'Bearer admin-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      type: 'run.output',
      runId: 'run-failed-1',
      rootRunId: 'root-retry-1',
      sessionId: 'session-retry-1',
      status: 'succeeded',
    });
    expect(retry).toHaveBeenCalledWith('run-failed-1');
  });

  it('deletes gateway sessions with no linked root runs', async () => {
    const querySpy = vi.fn(async <TRow extends Record<string, unknown>>(sql: string, params?: unknown[]) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 } as unknown as { rows: TRow[]; rowCount: number };
      }
      if (sql.includes('select s.id')) {
        expect(params).toBeUndefined();
        expect(sql).toContain('gateway_session_run_links');
        return { rows: [{ id: 'session-empty-1' }, { id: 'session-empty-2' }], rowCount: 2 } as unknown as { rows: TRow[]; rowCount: number };
      }
      expect(params).toEqual([['session-empty-1', 'session-empty-2']]);
      if (sql.includes('gateway_transcript_messages')) {
        return { rows: [], rowCount: 3 } as unknown as { rows: TRow[]; rowCount: number };
      }
      if (sql.includes('gateway_cron_runs')) {
        return { rows: [], rowCount: 1 } as unknown as { rows: TRow[]; rowCount: number };
      }
      if (sql.includes('gateway_run_admissions')) {
        return { rows: [], rowCount: 1 } as unknown as { rows: TRow[]; rowCount: number };
      }
      if (sql.includes('delete from gateway_sessions')) {
        return { rows: [], rowCount: 2 } as unknown as { rows: TRow[]; rowCount: number };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const app = await createGatewayServer(baseConfig, {
      auth: createStaticAuthProvider(['admin']),
      traceClient: { query: querySpy },
    });
    apps.push(app);

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/sessions/empty',
      headers: { authorization: 'Bearer admin-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      deletedSessions: 2,
      deletedTranscriptMessages: 3,
      clearedCronRuns: 1,
      clearedRunAdmissions: 1,
    });
    expect(querySpy.mock.calls.map((call) => call[0])).toContain('COMMIT');
  });

  it('deletes a gateway session and associated gateway records', async () => {
    const querySpy = vi.fn(async <TRow extends Record<string, unknown>>(sql: string, params?: unknown[]) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 } as unknown as { rows: TRow[]; rowCount: number };
      }
      expect(params).toEqual(['session-1']);
      if (sql.includes('select status from gateway_sessions')) {
        return { rows: [{ status: 'idle' }], rowCount: 1 } as unknown as { rows: TRow[]; rowCount: number };
      }
      if (sql.includes('gateway_transcript_messages')) {
        return { rows: [], rowCount: 2 } as unknown as { rows: TRow[]; rowCount: number };
      }
      if (sql.includes('gateway_session_run_links')) {
        return { rows: [], rowCount: 1 } as unknown as { rows: TRow[]; rowCount: number };
      }
      if (sql.includes('gateway_cron_runs')) {
        return { rows: [], rowCount: 1 } as unknown as { rows: TRow[]; rowCount: number };
      }
      if (sql.includes('gateway_run_admissions')) {
        return { rows: [], rowCount: 1 } as unknown as { rows: TRow[]; rowCount: number };
      }
      if (sql.includes('delete from gateway_sessions')) {
        return { rows: [], rowCount: 1 } as unknown as { rows: TRow[]; rowCount: number };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const app = await createGatewayServer(baseConfig, {
      auth: createStaticAuthProvider(['admin']),
      traceClient: { query: querySpy },
    });
    apps.push(app);

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/sessions/session-1',
      headers: { authorization: 'Bearer admin-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      sessionId: 'session-1',
      deletedSessions: 1,
      deletedTranscriptMessages: 2,
      deletedSessionRunLinks: 1,
      clearedCronRuns: 1,
      clearedRunAdmissions: 1,
    });
    expect(querySpy.mock.calls.map((call) => call[0])).toContain('COMMIT');
  });

  it('rejects sessionless run deletion when a session link exists', async () => {
    const rootRunId = '00000000-0000-4000-8000-000000000001';
    const querySpy = vi.fn(async <TRow extends Record<string, unknown>>(sql: string, params?: unknown[]) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 } as unknown as { rows: TRow[]; rowCount: number };
      }
      expect(params?.[0]).toBe(rootRunId);
      if (sql.includes('from agent_runs') && sql.includes('for update')) {
        return { rows: [{ id: rootRunId }], rowCount: 1 } as unknown as { rows: TRow[]; rowCount: number };
      }
      if (sql.includes('from gateway_session_run_links')) {
        return { rows: [{ count: '1' }], rowCount: 1 } as unknown as { rows: TRow[]; rowCount: number };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const app = await createGatewayServer(baseConfig, {
      auth: createStaticAuthProvider(['admin']),
      traceClient: { query: querySpy },
    });
    apps.push(app);

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/runs/${rootRunId}`,
      headers: { authorization: 'Bearer admin-token' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      type: 'error',
      code: 'run_linked_to_session',
      message: `Root run "${rootRunId}" is linked to a gateway session and cannot be deleted as sessionless.`,
      details: { rootRunId, linkedSessionCount: 1 },
    });
    expect(querySpy.mock.calls.map((call) => call[0])).toContain('ROLLBACK');
  });

  it('logs HTTP requests when request logging is enabled', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const app = await createGatewayServer({
        ...baseConfig,
        server: {
          ...baseConfig.server,
          requestLogging: true,
        },
      });
      apps.push(app);

      const response = await app.inject({
        method: 'GET',
        url: '/health',
      });

      expect(response.statusCode).toBe(200);

      const logEntries = consoleSpy.mock.calls
        .map((call) => call[0])
        .filter((value): value is string => typeof value === 'string')
        .map((value) => JSON.parse(value));

      expect(logEntries).toContainEqual(
        expect.objectContaining({
          level: 'info',
          event: 'http.request.started',
          message: 'HTTP request started',
          data: expect.objectContaining({
            method: 'GET',
            url: '/health',
          }),
        }),
      );
      expect(logEntries).toContainEqual(
        expect.objectContaining({
          level: 'info',
          event: 'http.request.completed',
          message: 'HTTP request completed',
          data: expect.objectContaining({
            method: 'GET',
            url: '/health',
            statusCode: 200,
          }),
        }),
      );
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('suppresses HTTP request lifecycle logs when request logging is silent', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const app = await createGatewayServer({
        ...baseConfig,
        server: {
          ...baseConfig.server,
          requestLogging: 'silent',
        },
      });
      apps.push(app);

      const response = await app.inject({
        method: 'GET',
        url: '/health',
      });

      expect(response.statusCode).toBe(200);
      expect(consoleSpy).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('redacts websocket query tokens from request logs', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const app = await createGatewayServer({
        ...baseConfig,
        server: {
          ...baseConfig.server,
          requestLogging: true,
        },
      });
      apps.push(app);

      const response = await app.inject({
        method: 'GET',
        url: '/health?access_token=super-secret-token&channelId=web',
      });

      expect(response.statusCode).toBe(200);

      const logEntries = consoleSpy.mock.calls
        .map((call) => call[0])
        .filter((value): value is string => typeof value === 'string')
        .map((value) => JSON.parse(value));

      expect(logEntries).toContainEqual(
        expect.objectContaining({
          level: 'info',
          event: 'http.request.started',
          data: expect.objectContaining({
            url: '/health?access_token=%5BREDACTED%5D&channelId=web',
          }),
        }),
      );
      expect(logEntries).toContainEqual(
        expect.objectContaining({
          level: 'info',
          event: 'http.request.completed',
          data: expect.objectContaining({
            url: '/health?access_token=%5BREDACTED%5D&channelId=web',
          }),
        }),
      );
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('starts listening on the configured host and an ephemeral port', async () => {
    const app = await createGatewayServer(baseConfig);
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });

    expect(app.server.listening).toBe(true);
    expect(getListeningPort(app)).toBeGreaterThan(0);
  });

  it('logs inbound and outbound WebSocket frames when request logging is enabled', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let socket: WebSocket | undefined;

    try {
      const app = await createGatewayServer({
        ...baseConfig,
        server: {
          ...baseConfig.server,
          requestLogging: true,
        },
      });
      apps.push(app);
      await app.listen({ host: '127.0.0.1', port: 0 });

      socket = await openTestWebSocket(`ws://127.0.0.1:${getListeningPort(app)}/ws`);
      socket.send(JSON.stringify({ type: 'ping', id: 'heartbeat-1' }));

      expect(await waitForSocketMessage(socket)).toBe(JSON.stringify({ type: 'pong', id: 'heartbeat-1' }));

      const logEntries = consoleSpy.mock.calls
        .map((call) => call[0])
        .filter((value): value is string => typeof value === 'string')
        .map((value) => JSON.parse(value));

      expect(logEntries).toContainEqual(
        expect.objectContaining({
          level: 'info',
          event: 'ws.frame.received',
          message: 'WebSocket frame received',
          data: expect.objectContaining({
            frameType: 'ping',
            pingId: 'heartbeat-1',
          }),
        }),
      );
      expect(logEntries).toContainEqual(
        expect.objectContaining({
          level: 'info',
          event: 'ws.frame.sent',
          message: 'WebSocket frame sent',
          data: expect.objectContaining({
            frameType: 'pong',
            pingId: 'heartbeat-1',
            source: 'response',
          }),
        }),
      );
    } finally {
      socket?.close();
      consoleSpy.mockRestore();
    }
  });

  it('includes failed run error text in outbound WebSocket frame logs', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let socket: WebSocket | undefined;

    try {
      const stores = createInMemoryGatewayStores();
      const run = vi.fn(async () => ({
        status: 'failure' as const,
        runId: 'run-failed-1',
        error: 'Model context window exceeded after approval resume',
        code: 'MODEL_ERROR' as const,
        stepsUsed: 12,
        usage: { promptTokens: 100000, completionTokens: 0, estimatedCostUSD: 0 },
      }));
      const app = await createGatewayServer(
        {
          ...createChatGatewayConfig(),
          server: {
            ...baseConfig.server,
            requestLogging: true,
          },
        },
        {
          agentRegistry: createGatewayTestAgentRegistry({
            run,
            runtimeRuns: {
              'run-failed-1': { id: 'run-failed-1', rootRunId: 'run-failed-1', status: 'failed' },
            },
          }),
          stores,
          now: () => new Date('2026-04-08T10:00:00.000Z'),
        },
      );
      apps.push(app);
      await app.listen({ host: '127.0.0.1', port: 0 });

      socket = await openTestWebSocket(`ws://127.0.0.1:${getListeningPort(app)}/ws?channelId=webchat`);
      socket.send(JSON.stringify({ type: 'run.start', goal: 'Long run that fails after approval' }));
      expect(JSON.parse(await waitForSocketMessage(socket))).toMatchObject({
        type: 'run.output',
        runId: 'run-failed-1',
        status: 'failed',
        error: 'Model context window exceeded after approval resume',
      });

      const logEntries = consoleSpy.mock.calls
        .map((call) => call[0])
        .filter((value): value is string => typeof value === 'string')
        .map((value) => JSON.parse(value));

      expect(logEntries).toContainEqual(
        expect.objectContaining({
          level: 'info',
          event: 'ws.frame.sent',
          message: 'WebSocket frame sent',
          data: expect.objectContaining({
            frameType: 'run.output',
            runId: 'run-failed-1',
            status: 'failed',
            hasError: true,
            error: 'Model context window exceeded after approval resume',
          }),
        }),
      );
    } finally {
      socket?.close();
      consoleSpy.mockRestore();
    }
  });

  it('routes websocket messages through the validated protocol handler', async () => {
    expect(await handleGatewaySocketMessage(JSON.stringify({ type: 'ping', id: 'heartbeat-1' }))).toEqual({
      type: 'pong',
      id: 'heartbeat-1',
    });
    expect(await handleGatewaySocketMessage(JSON.stringify({ type: 'channel.subscribe', channels: ['session:1'] }))).toEqual({
      type: 'session.updated',
      sessionId: '',
      status: 'idle',
      transcriptVersion: 0,
      activeRunId: undefined,
      activeRootRunId: undefined,
    });
    expect(await handleGatewaySocketMessage(JSON.stringify({ type: 'mystery.frame' }))).toEqual({
      type: 'error',
      code: 'unknown_frame_type',
      message: 'Unknown inbound frame type "mystery.frame".',
      requestType: 'mystery.frame',
      details: undefined,
    });
    expect(await handleGatewaySocketMessage('{bad json')).toMatchObject({
      type: 'error',
      code: 'invalid_json',
    });
  });

  it('creates a new session record for an authenticated principal', async () => {
    const stores = createInMemoryGatewayStores();
    const authContext = createAuthContext('user-123');

    const response = await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'session.open',
        channelId: 'webchat',
        metadata: { locale: 'en-US' },
      }),
      {
        authContext,
        stores,
        now: () => new Date('2026-04-08T10:00:00.000Z'),
        sessionIdFactory: () => 'session-1',
      },
    );

    expect(response).toEqual({
      type: 'session.opened',
      sessionId: 'session-1',
      channelId: 'webchat',
      agentId: undefined,
      status: 'idle',
    });
    expect(await stores.sessions.get('session-1')).toEqual({
      id: 'session-1',
      channelId: 'webchat',
      agentId: undefined,
      invocationMode: undefined,
      authSubject: 'user-123',
      tenantId: 'acme',
      status: 'idle',
      currentRunId: undefined,
      currentRootRunId: undefined,
      lastCompletedRootRunId: undefined,
      transcriptVersion: 0,
      transcriptSummary: undefined,
      metadata: { locale: 'en-US' },
      createdAt: '2026-04-08T10:00:00.000Z',
      updatedAt: '2026-04-08T10:00:00.000Z',
    });
  });

  it('reattaches multiple same-principal connections to the same session', async () => {
    const stores = createInMemoryGatewayStores();
    const authContext = createAuthContext('user-123');

    await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'session.open',
        channelId: 'webchat',
      }),
      {
        authContext,
        stores,
        now: () => new Date('2026-04-08T10:00:00.000Z'),
        sessionIdFactory: () => 'session-1',
      },
    );

    const response = await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'session.open',
        sessionId: 'session-1',
        channelId: 'webchat',
      }),
      {
        authContext,
        stores,
        now: () => new Date('2026-04-08T10:05:00.000Z'),
      },
    );

    expect(response).toEqual({
      type: 'session.opened',
      sessionId: 'session-1',
      channelId: 'webchat',
      agentId: undefined,
      status: 'idle',
    });
    expect(await stores.sessions.get('session-1')).toMatchObject({
      id: 'session-1',
      authSubject: 'user-123',
      createdAt: '2026-04-08T10:00:00.000Z',
      updatedAt: '2026-04-08T10:05:00.000Z',
    });
  });

  it('emits reconnect state and restores channel subscriptions when a session is reattached', async () => {
    const stores = createInMemoryGatewayStores();
    const authContext = createAuthContext('user-123');
    const channelManager = createChannelSubscriptionManager();
    const emittedFrames: OutboundFrame[] = [];
    const postResponseTasks: Array<() => Promise<void>> = [];

    await createStoredSession(stores, {
      agentId: 'support-agent',
      status: 'running',
      currentRunId: 'run-live',
      currentRootRunId: 'root-live',
      transcriptVersion: 4,
    });

    const response = await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'session.open',
        sessionId: 'session-1',
        channelId: 'webchat',
      }),
      {
        authContext,
        stores,
        channelManager,
        postResponseTasks,
        emitFrame: async (frame) => {
          emittedFrames.push(frame);
        },
        now: () => new Date('2026-04-08T10:05:00.000Z'),
      },
    );

    expect(response).toEqual({
      type: 'session.opened',
      sessionId: 'session-1',
      channelId: 'webchat',
      agentId: 'support-agent',
      status: 'running',
    });

    for (const task of postResponseTasks) {
      await task();
    }

    expect(emittedFrames).toEqual([
      {
        type: 'session.updated',
        sessionId: 'session-1',
        status: 'running',
        transcriptVersion: 4,
        activeRunId: 'run-live',
        activeRootRunId: 'root-live',
      },
    ]);
    expect(channelManager.getSubscriptions().map((subscription) => subscription.channel)).toEqual([
      'session:session-1',
      'root-run:root-live',
      'run:run-live',
      'agent:support-agent',
    ]);
  });

  it('registers a runtime observer when a running session is reattached', async () => {
    const stores = createInMemoryGatewayStores();
    const authContext = createAuthContext('user-123');
    const channelManager = createChannelSubscriptionManager();
    const emittedFrames: OutboundFrame[] = [];
    const postResponseTasks: Array<() => Promise<void>> = [];
    const registerRuntimeObserver = vi.fn(async () => undefined);

    await createStoredSession(stores, {
      agentId: 'support-agent',
      status: 'running',
      currentRunId: 'run-live',
      currentRootRunId: 'root-live',
      transcriptVersion: 4,
    });

    const response = await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'session.open',
        sessionId: 'session-1',
        channelId: 'webchat',
      }),
      {
        authContext,
        stores,
        agentRegistry: createGatewayTestAgentRegistry({
          runtimeRuns: {
            'run-live': {
              id: 'run-live',
              rootRunId: 'root-live',
              status: 'running',
              leaseOwner: 'worker-live',
              leaseExpiresAt: '2026-04-08T10:06:00.000Z',
            },
          },
        }),
        channelManager,
        postResponseTasks,
        emitFrame: async (frame) => {
          emittedFrames.push(frame);
        },
        registerRuntimeObserver,
        now: () => new Date('2026-04-08T10:05:00.000Z'),
      },
    );

    expect(response).toEqual({
      type: 'session.opened',
      sessionId: 'session-1',
      channelId: 'webchat',
      agentId: 'support-agent',
      status: 'running',
    });

    for (const task of postResponseTasks) {
      await task();
    }

    expect(emittedFrames).toEqual([
      {
        type: 'session.updated',
        sessionId: 'session-1',
        status: 'running',
        transcriptVersion: 4,
        activeRunId: 'run-live',
        activeRootRunId: 'root-live',
      },
    ]);
    expect(registerRuntimeObserver).toHaveBeenCalledWith({
      agentId: 'support-agent',
      rootRunId: 'root-live',
      sessionId: 'session-1',
    });
  });

  it('replays a pending approval request when an awaiting approval session is reattached', async () => {
    const stores = createInMemoryGatewayStores();
    const authContext = createAuthContext('user-123');
    const channelManager = createChannelSubscriptionManager();
    const emittedFrames: OutboundFrame[] = [];
    const postResponseTasks: Array<() => Promise<void>> = [];

    await createStoredSession(stores, {
      agentId: 'support-agent',
      status: 'awaiting_approval',
      currentRunId: 'run-approval',
      currentRootRunId: 'root-approval',
      transcriptVersion: 6,
    });

    const response = await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'session.open',
        sessionId: 'session-1',
        channelId: 'webchat',
      }),
      {
        authContext,
        stores,
        agentRegistry: createGatewayTestAgentRegistry({
          runtimeRuns: {
            'run-approval': {
              id: 'run-approval',
              rootRunId: 'root-approval',
              status: 'awaiting_approval',
            },
          },
        }),
        channelManager,
        postResponseTasks,
        emitFrame: async (frame) => {
          emittedFrames.push(frame);
        },
        now: () => new Date('2026-04-08T10:05:00.000Z'),
      },
    );

    expect(response).toEqual({
      type: 'session.opened',
      sessionId: 'session-1',
      channelId: 'webchat',
      agentId: 'support-agent',
      status: 'awaiting_approval',
    });

    for (const task of postResponseTasks) {
      await task();
    }

    expect(emittedFrames).toEqual([
      {
        type: 'session.updated',
        sessionId: 'session-1',
        status: 'awaiting_approval',
        transcriptVersion: 6,
        activeRunId: 'run-approval',
        activeRootRunId: 'root-approval',
      },
      {
        type: 'approval.requested',
        runId: 'run-approval',
        rootRunId: 'root-approval',
        sessionId: 'session-1',
      },
    ]);
    expect(channelManager.getSubscriptions().map((subscription) => subscription.channel)).toEqual([
      'session:session-1',
      'root-run:root-approval',
      'run:run-approval',
      'agent:support-agent',
    ]);
  });

  it('emits recovered run output after reconnecting an expired active run', async () => {
    const stores = createInMemoryGatewayStores();
    const authContext = createAuthContext('user-123');
    const channelManager = createChannelSubscriptionManager();
    const emittedFrames: OutboundFrame[] = [];
    const postResponseTasks: Array<() => Promise<void>> = [];
    const resume = vi.fn(async () => ({
      status: 'success' as const,
      runId: 'run-live',
      output: { recovered: true },
      stepsUsed: 3,
      usage: { promptTokens: 1, completionTokens: 1, estimatedCostUSD: 0 },
    }));

    await createStoredSession(stores, {
      agentId: 'support-agent',
      status: 'running',
      currentRunId: 'run-live',
      currentRootRunId: 'root-live',
      transcriptVersion: 4,
    });

    const response = await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'session.open',
        sessionId: 'session-1',
        channelId: 'webchat',
      }),
      {
        authContext,
        stores,
        agentRegistry: createGatewayTestAgentRegistry({
          resume,
          runtimeRuns: {
            'run-live': {
              id: 'run-live',
              rootRunId: 'root-live',
              status: 'running',
              leaseOwner: 'worker-old',
              leaseExpiresAt: '2026-04-08T10:04:00.000Z',
            },
          },
        }),
        channelManager,
        postResponseTasks,
        emitFrame: async (frame) => {
          emittedFrames.push(frame);
        },
        now: () => new Date('2026-04-08T10:05:00.000Z'),
      },
    );

    expect(response).toEqual({
      type: 'session.opened',
      sessionId: 'session-1',
      channelId: 'webchat',
      agentId: 'support-agent',
      status: 'idle',
    });

    for (const task of postResponseTasks) {
      await task();
    }

    expect(resume).toHaveBeenCalledWith('run-live');
    expect(emittedFrames).toEqual([
      {
        type: 'session.updated',
        sessionId: 'session-1',
        status: 'idle',
        transcriptVersion: 4,
        activeRunId: undefined,
        activeRootRunId: undefined,
      },
      {
        type: 'run.output',
        runId: 'run-live',
        rootRunId: 'root-live',
        sessionId: 'session-1',
        status: 'succeeded',
        output: { recovered: true },
      },
    ]);
    expect(channelManager.getSubscriptions().map((subscription) => subscription.channel)).toEqual([
      'session:session-1',
      'agent:support-agent',
    ]);
  });

  it('replays completed run output after reconnecting an idle completed session', async () => {
    const stores = createInMemoryGatewayStores();
    const authContext = createAuthContext('user-123');
    const channelManager = createChannelSubscriptionManager();
    const emittedFrames: OutboundFrame[] = [];
    const postResponseTasks: Array<() => Promise<void>> = [];

    await createStoredSession(stores, {
      agentId: 'support-agent',
      invocationMode: 'run',
      status: 'idle',
      lastCompletedRootRunId: 'root-finished',
      transcriptVersion: 4,
    });
    await stores.sessionRunLinks.append({
      sessionId: 'session-1',
      runId: 'run-finished',
      rootRunId: 'root-finished',
      invocationKind: 'run',
      createdAt: '2026-04-08T10:04:00.000Z',
    });

    const response = await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'session.open',
        sessionId: 'session-1',
        channelId: 'webchat',
      }),
      {
        authContext,
        stores,
        agentRegistry: createGatewayTestAgentRegistry({
          runtimeRuns: {
            'run-finished': {
              id: 'run-finished',
              rootRunId: 'root-finished',
              status: 'succeeded',
              result: { report: 'finished before reconnect' },
            },
          },
        }),
        channelManager,
        postResponseTasks,
        emitFrame: async (frame) => {
          emittedFrames.push(frame);
        },
        now: () => new Date('2026-04-08T10:05:00.000Z'),
      },
    );

    expect(response).toEqual({
      type: 'session.opened',
      sessionId: 'session-1',
      channelId: 'webchat',
      agentId: 'support-agent',
      invocationMode: 'run',
      status: 'idle',
    });

    for (const task of postResponseTasks) {
      await task();
    }

    expect(emittedFrames).toEqual([
      {
        type: 'session.updated',
        sessionId: 'session-1',
        status: 'idle',
        invocationMode: 'run',
        transcriptVersion: 4,
        activeRunId: undefined,
        activeRootRunId: undefined,
      },
      {
        type: 'run.output',
        runId: 'run-finished',
        rootRunId: 'root-finished',
        sessionId: 'session-1',
        status: 'succeeded',
        output: { report: 'finished before reconnect' },
      },
    ]);
    expect(channelManager.getSubscriptions().map((subscription) => subscription.channel)).toEqual([
      'session:session-1',
      'agent:support-agent',
    ]);
  });

  it('reattaches a run session by root run id and replays failed output', async () => {
    const stores = createInMemoryGatewayStores();
    const authContext = createAuthContext('user-123');
    const channelManager = createChannelSubscriptionManager();
    const emittedFrames: OutboundFrame[] = [];
    const postResponseTasks: Array<() => Promise<void>> = [];

    await createStoredSession(stores, {
      agentId: 'support-agent',
      invocationMode: 'run',
      status: 'failed',
      lastCompletedRootRunId: 'root-failed',
      transcriptVersion: 4,
    });
    await stores.sessionRunLinks.append({
      sessionId: 'session-1',
      runId: 'run-failed',
      rootRunId: 'root-failed',
      invocationKind: 'run',
      createdAt: '2026-04-08T10:04:00.000Z',
    });

    const response = await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'session.open',
        rootRunId: 'root-failed',
        channelId: 'webchat',
      }),
      {
        authContext,
        stores,
        agentRegistry: createGatewayTestAgentRegistry({
          runtimeRuns: {
            'run-failed': {
              id: 'run-failed',
              rootRunId: 'root-failed',
              status: 'failed',
              errorMessage: 'Model timed out after 90000ms',
            },
          },
        }),
        channelManager,
        postResponseTasks,
        emitFrame: async (frame) => {
          emittedFrames.push(frame);
        },
        now: () => new Date('2026-04-08T10:05:00.000Z'),
      },
    );

    expect(response).toEqual({
      type: 'session.opened',
      sessionId: 'session-1',
      channelId: 'webchat',
      agentId: 'support-agent',
      invocationMode: 'run',
      status: 'failed',
    });

    for (const task of postResponseTasks) {
      await task();
    }

    expect(emittedFrames).toContainEqual({
      type: 'run.output',
      runId: 'run-failed',
      rootRunId: 'root-failed',
      sessionId: 'session-1',
      status: 'failed',
      error: 'Model timed out after 90000ms',
    });
    expect(channelManager.getSubscriptions().map((subscription) => subscription.channel)).toEqual([
      'session:session-1',
      'agent:support-agent',
    ]);
  });

  it('retries a failed session-bound run without creating a new run', async () => {
    const stores = createInMemoryGatewayStores();
    const authContext = createAuthContext('user-123');
    const retry = vi.fn(async () => ({
      status: 'success' as const,
      runId: 'run-failed',
      output: { retried: true },
      stepsUsed: 2,
      usage: { promptTokens: 1, completionTokens: 1, estimatedCostUSD: 0 },
    }));

    await createStoredSession(stores, {
      agentId: 'support-agent',
      invocationMode: 'run',
      status: 'failed',
      currentRunId: undefined,
      currentRootRunId: undefined,
    });
    await stores.sessionRunLinks.append({
      sessionId: 'session-1',
      runId: 'run-failed',
      rootRunId: 'root-failed',
      invocationKind: 'run',
      createdAt: '2026-04-08T10:04:00.000Z',
    });

    const response = await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'run.retry',
        sessionId: 'session-1',
        runId: 'run-failed',
      }),
      {
        authContext,
        stores,
        agentRegistry: createGatewayTestAgentRegistry({
          retry,
          runtimeRuns: {
            'run-failed': {
              id: 'run-failed',
              rootRunId: 'root-failed',
              status: 'failed',
              errorMessage: 'Model timed out after 90000ms',
            },
          },
        }),
        now: () => new Date('2026-04-08T10:05:00.000Z'),
      },
    );

    expect(retry).toHaveBeenCalledWith('run-failed');
    expect(response).toEqual({
      type: 'run.output',
      runId: 'run-failed',
      rootRunId: 'root-failed',
      sessionId: 'session-1',
      status: 'succeeded',
      output: { retried: true },
    });
    expect(await stores.sessions.get('session-1')).toMatchObject({
      status: 'idle',
      currentRunId: undefined,
      currentRootRunId: undefined,
      lastCompletedRootRunId: 'root-failed',
    });
  });

  it('retries the latest linked run when sessionless run.retry receives a root run id', async () => {
    const stores = createInMemoryGatewayStores();
    const authContext = createAuthContext('user-123');
    const retry = vi.fn(async () => ({
      status: 'success' as const,
      runId: 'run-failed',
      output: { retried: true },
      stepsUsed: 2,
      usage: { promptTokens: 1, completionTokens: 1, estimatedCostUSD: 0 },
    }));

    await createStoredSession(stores, {
      agentId: 'support-agent',
      invocationMode: 'run',
      status: 'failed',
      currentRunId: undefined,
      currentRootRunId: undefined,
    });
    await stores.sessionRunLinks.append({
      sessionId: 'session-1',
      runId: 'run-failed',
      rootRunId: 'root-failed',
      invocationKind: 'run',
      createdAt: '2026-04-08T10:04:00.000Z',
    });

    const response = await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'run.retry',
        runId: 'root-failed',
      }),
      {
        authContext,
        stores,
        agentRegistry: createGatewayTestAgentRegistry({
          retry,
          runtimeRuns: {
            'run-failed': {
              id: 'run-failed',
              rootRunId: 'root-failed',
              status: 'failed',
              errorMessage: 'Model timed out after 90000ms',
            },
          },
        }),
        now: () => new Date('2026-04-08T10:05:00.000Z'),
      },
    );

    expect(retry).toHaveBeenCalledWith('run-failed');
    expect(response).toMatchObject({
      type: 'run.output',
      runId: 'run-failed',
      rootRunId: 'root-failed',
      sessionId: 'session-1',
      status: 'succeeded',
    });
  });

  it('does not double-forward retry events when a reconnect observer is already streaming the run', async () => {
    const stores = createInMemoryGatewayStores();
    const authContext = createAuthContext('user-123');
    const runtimeRuns: Record<string, RuntimeRunRecord> = {
      'run-failed': {
        id: 'run-failed',
        rootRunId: 'root-failed',
        status: 'failed',
        errorMessage: 'Model timed out after 90000ms',
      },
    };
    const listeners = new Set<(event: RuntimeAgentEvent) => void>();
    const eventStore: RuntimeEventStore = {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const emitRuntimeEvent = (event: RuntimeAgentEvent) => {
      for (const listener of listeners) {
        listener(event);
      }
    };
    const retry = vi.fn(async () => {
      runtimeRuns['run-failed'].status = 'running';
      emitRuntimeEvent({
        id: 'evt-retry-1',
        runId: 'run-failed',
        seq: 11,
        type: 'run.retry_started',
        payload: { status: 'running' } satisfies JsonValue,
        createdAt: '2026-04-08T10:05:00.100Z',
      });
      runtimeRuns['run-failed'].status = 'succeeded';
      return {
        status: 'success' as const,
        runId: 'run-failed',
        output: { retried: true },
        stepsUsed: 2,
        usage: { promptTokens: 1, completionTokens: 1, estimatedCostUSD: 0 },
      };
    });
    const agentRegistry = createGatewayTestAgentRegistry({
      retry,
      runtimeRuns,
      eventStore,
    });
    const emittedFrames: OutboundFrame[] = [];
    const activeObserverRootRunIds = new Set<string>();
    const observerUnsubscribers: Array<() => Promise<void>> = [];
    const registerRuntimeObserver = async (observer: RuntimeObserverRegistration) => {
      if (activeObserverRootRunIds.has(observer.rootRunId)) {
        return;
      }

      const agent = await agentRegistry.getAgent(observer.agentId);
      const unsubscribe = subscribeToForwardedRealtimeEvents(agent, {
        rootRunId: observer.rootRunId,
        fallbackAgentId: observer.agentId,
        fallbackSessionId: observer.sessionId,
        emitFrame: (frame) => {
          emittedFrames.push(frame);
        },
      });
      if (unsubscribe) {
        activeObserverRootRunIds.add(observer.rootRunId);
        observerUnsubscribers.push(unsubscribe);
      }
    };

    await createStoredSession(stores, {
      agentId: 'support-agent',
      invocationMode: 'run',
      status: 'failed',
      currentRunId: undefined,
      currentRootRunId: undefined,
    });
    await stores.sessionRunLinks.append({
      sessionId: 'session-1',
      runId: 'run-failed',
      rootRunId: 'root-failed',
      invocationKind: 'run',
      createdAt: '2026-04-08T10:04:00.000Z',
    });
    await registerRuntimeObserver({
      agentId: 'support-agent',
      rootRunId: 'root-failed',
      sessionId: 'session-1',
    });

    const response = await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'run.retry',
        sessionId: 'session-1',
        runId: 'run-failed',
      }),
      {
        authContext,
        stores,
        agentRegistry,
        emitFrame: (frame) => {
          emittedFrames.push(frame);
        },
        hasRuntimeObserver: (rootRunId) => activeObserverRootRunIds.has(rootRunId),
        now: () => new Date('2026-04-08T10:05:00.000Z'),
      },
    );

    await waitUntil(async () => emittedFrames.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    for (const unsubscribe of observerUnsubscribers) {
      await unsubscribe();
    }

    expect(response).toMatchObject({
      type: 'run.output',
      runId: 'run-failed',
      rootRunId: 'root-failed',
      sessionId: 'session-1',
      status: 'succeeded',
    });
    expect(emittedFrames).toEqual([
      {
        type: 'agent.event',
        eventType: 'run.retry_started',
        data: { status: 'running' },
        seq: 11,
        stepId: undefined,
        createdAt: '2026-04-08T10:05:00.100Z',
        sessionId: 'session-1',
        agentId: 'support-agent',
        runId: 'run-failed',
        rootRunId: 'root-failed',
        parentRunId: undefined,
      },
    ]);
  });

  it('rejects session reattachment from a different principal', async () => {
    const stores = createInMemoryGatewayStores();

    await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'session.open',
        channelId: 'webchat',
      }),
      {
        authContext: createAuthContext('user-123'),
        stores,
        now: () => new Date('2026-04-08T10:00:00.000Z'),
        sessionIdFactory: () => 'session-1',
      },
    );

    const response = await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'session.open',
        sessionId: 'session-1',
        channelId: 'webchat',
      }),
      {
        authContext: createAuthContext('user-999'),
        stores,
        now: () => new Date('2026-04-08T10:05:00.000Z'),
      },
    );

    expect(response).toEqual({
      type: 'error',
      code: 'session_forbidden',
      message: 'Session "session-1" belongs to a different authenticated principal.',
      requestType: 'session.open',
      details: {
        sessionId: 'session-1',
      },
    });
    expect(await stores.sessions.get('session-1')).toMatchObject({
      authSubject: 'user-123',
      updatedAt: '2026-04-08T10:00:00.000Z',
    });
  });

  it('executes message.send through the routed agent and persists transcript state', async () => {
    const stores = createInMemoryGatewayStores();
    const authContext = createAuthContext('user-123');
    const chat = vi.fn(async () => ({
      status: 'success' as const,
      runId: 'run-1',
      output: 'Hello back',
      stepsUsed: 1,
      usage: { promptTokens: 11, completionTokens: 5, estimatedCostUSD: 0.001 },
    }));
    const agentRegistry = createGatewayTestAgentRegistry({
      chat,
      runtimeRuns: {
        'run-1': { id: 'run-1', rootRunId: 'run-1', status: 'succeeded' },
      },
    });
    const chatConfig = createChatGatewayConfig();

    await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'session.open',
        channelId: 'webchat',
      }),
      {
        authContext,
        stores,
        now: () => new Date('2026-04-08T10:00:00.000Z'),
        sessionIdFactory: () => 'session-1',
      },
    );

    const response = await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'message.send',
        sessionId: 'session-1',
        content: 'Hello gateway',
        metadata: { locale: 'en-US' },
      }),
      {
        gatewayConfig: chatConfig,
        agentRegistry,
        authContext,
        stores,
        now: () => new Date('2026-04-08T10:01:00.000Z'),
        transcriptMessageIdFactory: createSequentialIdFactory(['message-1', 'message-2']),
      },
    );

    expect(response).toEqual({
      type: 'message.output',
      sessionId: 'session-1',
      runId: 'run-1',
      rootRunId: 'run-1',
      message: {
        role: 'assistant',
        content: 'Hello back',
      },
    });
    expect(chat).toHaveBeenCalledWith({
      messages: [{ role: 'user', content: 'Hello gateway' }],
      context: {
        sessionId: 'session-1',
        channelId: 'webchat',
        authSubject: 'user-123',
        invocationMode: 'chat',
        tenantId: 'acme',
        roles: ['member'],
      },
      metadata: {
        locale: 'en-US',
        gateway: {
          sessionId: 'session-1',
          agentId: 'support-agent',
          invocationMode: 'chat',
        },
      },
    });
    expect(await stores.transcriptMessages.listBySession('session-1')).toEqual([
      {
        id: 'message-1',
        sessionId: 'session-1',
        sequence: 1,
        role: 'user',
        content: 'Hello gateway',
        metadata: { locale: 'en-US' },
        createdAt: '2026-04-08T10:01:00.000Z',
      },
      {
        id: 'message-2',
        sessionId: 'session-1',
        sequence: 2,
        role: 'assistant',
        content: 'Hello back',
        metadata: undefined,
        createdAt: '2026-04-08T10:01:00.000Z',
      },
    ]);
    expect(await stores.sessions.get('session-1')).toMatchObject({
      agentId: 'support-agent',
      invocationMode: 'chat',
      status: 'idle',
      currentRunId: undefined,
      currentRootRunId: undefined,
      lastCompletedRootRunId: 'run-1',
      transcriptVersion: 2,
      updatedAt: '2026-04-08T10:01:00.000Z',
    });
    expect(await stores.sessionRunLinks.listBySession('session-1')).toEqual([
      {
        sessionId: 'session-1',
        runId: 'run-1',
        rootRunId: 'run-1',
        invocationKind: 'chat',
        turnIndex: 1,
        metadata: { locale: 'en-US' },
        createdAt: '2026-04-08T10:01:00.000Z',
      },
    ]);
  });

  it('preserves prior transcript history and marks the session failed when chat turns fail', async () => {
    const stores = createInMemoryGatewayStores();
    const authContext = createAuthContext('user-123');
    const chat = vi.fn(async () => ({
      status: 'failure' as const,
      runId: 'run-2',
      error: 'Model adapter failed',
      code: 'MODEL_ERROR' as const,
      stepsUsed: 1,
      usage: { promptTokens: 7, completionTokens: 0, estimatedCostUSD: 0.0004 },
    }));
    const agentRegistry = createGatewayTestAgentRegistry({
      chat,
      runtimeRuns: {
        'run-2': { id: 'run-2', rootRunId: 'run-2', status: 'failed' },
      },
    });

    await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'session.open',
        channelId: 'webchat',
      }),
      {
        authContext,
        stores,
        now: () => new Date('2026-04-08T10:00:00.000Z'),
        sessionIdFactory: () => 'session-1',
      },
    );

    const response = await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'message.send',
        sessionId: 'session-1',
        content: 'This should fail',
      }),
      {
        gatewayConfig: createChatGatewayConfig(),
        agentRegistry,
        authContext,
        stores,
        now: () => new Date('2026-04-08T10:01:00.000Z'),
      },
    );

    expect(response).toEqual({
      type: 'error',
      code: 'run_failed',
      message: 'Model adapter failed',
      requestType: 'message.send',
      details: {
        sessionId: 'session-1',
        runId: 'run-2',
        rootRunId: 'run-2',
        code: 'MODEL_ERROR',
      },
    });
    expect(await stores.transcriptMessages.listBySession('session-1')).toEqual([]);
    expect(await stores.sessions.get('session-1')).toMatchObject({
      agentId: 'support-agent',
      invocationMode: 'chat',
      status: 'failed',
      currentRunId: undefined,
      currentRootRunId: undefined,
      lastCompletedRootRunId: 'run-2',
      transcriptVersion: 0,
      updatedAt: '2026-04-08T10:01:00.000Z',
    });
    expect(await stores.sessionRunLinks.listBySession('session-1')).toEqual([
      {
        sessionId: 'session-1',
        runId: 'run-2',
        rootRunId: 'run-2',
        invocationKind: 'chat',
        turnIndex: 1,
        metadata: undefined,
        createdAt: '2026-04-08T10:01:00.000Z',
      },
    ]);
  });

  it('executes session-bound run.start through agent.run and persists session linkage', async () => {
    const stores = createInMemoryGatewayStores();
    const authContext = createAuthContext('user-123');
    const run = vi.fn(async () => ({
      status: 'success' as const,
      runId: 'run-3',
      output: { ticketId: 'T-42', priority: 'high' },
      stepsUsed: 2,
      usage: { promptTokens: 9, completionTokens: 4, estimatedCostUSD: 0.0012 },
    }));
    const agentRegistry = createGatewayTestAgentRegistry({
      run,
      runtimeRuns: {
        'run-3': { id: 'run-3', rootRunId: 'root-run-3', status: 'succeeded' },
      },
    });

    await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'session.open',
        channelId: 'webchat',
      }),
      {
        authContext,
        stores,
        now: () => new Date('2026-04-08T10:00:00.000Z'),
        sessionIdFactory: () => 'session-1',
      },
    );

    const response = await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'run.start',
        sessionId: 'session-1',
        goal: 'Create a high-priority support ticket',
        input: { priority: 'high' },
        context: { locale: 'en-US' },
        metadata: { source: 'dashboard' },
      }),
      {
        gatewayConfig: createChatGatewayConfig(),
        agentRegistry,
        authContext,
        stores,
        now: () => new Date('2026-04-08T10:02:00.000Z'),
      },
    );

    expect(response).toEqual({
      type: 'run.output',
      runId: 'run-3',
      rootRunId: 'root-run-3',
      sessionId: 'session-1',
      status: 'succeeded',
      output: { ticketId: 'T-42', priority: 'high' },
    });
    expect(run).toHaveBeenCalledWith({
      goal: 'Create a high-priority support ticket',
      input: { priority: 'high' },
      context: {
        locale: 'en-US',
        sessionId: 'session-1',
        channelId: 'webchat',
        authSubject: 'user-123',
        invocationMode: 'run',
        tenantId: 'acme',
        roles: ['member'],
      },
      metadata: {
        source: 'dashboard',
        gateway: {
          sessionId: 'session-1',
          agentId: 'support-agent',
          invocationMode: 'run',
        },
      },
    });
    expect(await stores.sessions.get('session-1')).toMatchObject({
      agentId: 'support-agent',
      invocationMode: 'run',
      status: 'idle',
      currentRunId: undefined,
      currentRootRunId: undefined,
      lastCompletedRootRunId: 'root-run-3',
      transcriptVersion: 0,
      updatedAt: '2026-04-08T10:02:00.000Z',
    });
    expect(await stores.sessionRunLinks.listBySession('session-1')).toEqual([
      {
        sessionId: 'session-1',
        runId: 'run-3',
        rootRunId: 'root-run-3',
        invocationKind: 'run',
        metadata: { source: 'dashboard' },
        createdAt: '2026-04-08T10:02:00.000Z',
      },
    ]);
  });

  it('rejects simultaneous same-session run.start while allowing only one launch', async () => {
    const stores = createInMemoryGatewayStores();
    const authContext = createAuthContext('user-123');
    let finishRun!: () => void;
    const run = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<NonNullable<CreatedAdaptiveAgent['agent']['run']>>>>((resolve) => {
          finishRun = () =>
            resolve({
              status: 'success',
              runId: 'run-concurrent',
              output: { ok: true },
              stepsUsed: 1,
              usage: { promptTokens: 1, completionTokens: 1, estimatedCostUSD: 0 },
            });
        }),
    );
    const agentRegistry = createGatewayTestAgentRegistry({
      run,
      runtimeRuns: {
        'run-concurrent': { id: 'run-concurrent', rootRunId: 'run-concurrent', status: 'succeeded' },
      },
    });
    await createStoredSession(stores);

    const context = {
      gatewayConfig: createChatGatewayConfig(),
      agentRegistry,
      authContext,
      stores,
      now: () => new Date('2026-04-08T10:02:00.000Z'),
    };
    const first = handleGatewaySocketMessage(
      JSON.stringify({ type: 'run.start', sessionId: 'session-1', goal: 'First' }),
      context,
    );
    await waitUntil(() => run.mock.calls.length === 1);
    const second = await handleGatewaySocketMessage(
      JSON.stringify({ type: 'run.start', sessionId: 'session-1', goal: 'Second' }),
      context,
    );
    finishRun();
    const firstResponse = await first;

    expect(run).toHaveBeenCalledTimes(1);
    expect(firstResponse).toMatchObject({ type: 'run.output', runId: 'run-concurrent', status: 'succeeded' });
    expect(second).toMatchObject({
      type: 'error',
      code: 'session_busy',
      requestType: 'run.start',
      details: {
        sessionId: 'session-1',
        status: 'running',
      },
    });
  });

  it('rejects independent runs above configured gateway capacity', async () => {
    const stores = createInMemoryGatewayStores();
    const authContext = createAuthContext('user-123');
    let finishRun!: () => void;
    const run = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<NonNullable<CreatedAdaptiveAgent['agent']['run']>>>>((resolve) => {
          finishRun = () =>
            resolve({
              status: 'success',
              runId: 'run-capacity',
              output: { ok: true },
              stepsUsed: 1,
              usage: { promptTokens: 1, completionTokens: 1, estimatedCostUSD: 0 },
            });
        }),
    );
    const agentRegistry = createGatewayTestAgentRegistry({
      run,
      runtimeRuns: {
        'run-capacity': { id: 'run-capacity', rootRunId: 'run-capacity', status: 'succeeded' },
      },
    });
    const gatewayConfig = {
      ...createChatGatewayConfig(),
      concurrency: {
        maxActiveRuns: 1,
        maxActiveRunsPerTenant: 8,
        maxActiveRunsPerAgent: 8,
        runAdmissionLeaseMs: 60_000,
      },
    };
    await createStoredSession(stores, { id: 'session-1' });
    await createStoredSession(stores, { id: 'session-2' });

    const first = handleGatewaySocketMessage(
      JSON.stringify({ type: 'run.start', sessionId: 'session-1', goal: 'First' }),
      { gatewayConfig, agentRegistry, authContext, stores, now: () => new Date('2026-04-08T10:02:00.000Z') },
    );
    await waitUntil(() => run.mock.calls.length === 1);
    const second = await handleGatewaySocketMessage(
      JSON.stringify({ type: 'run.start', sessionId: 'session-2', goal: 'Second' }),
      { gatewayConfig, agentRegistry, authContext, stores, now: () => new Date('2026-04-08T10:02:01.000Z') },
    );
    finishRun();
    await first;

    expect(run).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({
      type: 'error',
      code: 'gateway_overloaded',
      requestType: 'run.start',
      details: {
        limit: 'maxActiveRuns',
        activeCount: 1,
        configuredLimit: 1,
        agentId: 'support-agent',
        tenantId: 'acme',
        sessionId: 'session-2',
      },
    });
    expect(await stores.sessions.get('session-2')).toMatchObject({ status: 'idle', currentRunId: undefined });
  });

  it('forwards realtime agent events to the websocket while a session run is executing', async () => {
    const stores = createInMemoryGatewayStores();
    const authContext = createAuthContext('user-123');
    const runtimeRuns: Record<string, RuntimeRunRecord> = {};
    const listeners = new Set<(event: RuntimeAgentEvent) => void>();
    const eventStore: RuntimeEventStore = {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const emitRuntimeEvent = (event: RuntimeAgentEvent) => {
      for (const listener of listeners) {
        listener(event);
      }
    };
    const emittedFrames: unknown[] = [];
    const run = vi.fn(async (request) => {
      runtimeRuns['run-live-1'] = {
        id: 'run-live-1',
        rootRunId: 'root-live-1',
        status: 'running',
        metadata: request.metadata as JsonObject | undefined,
      };
      runtimeRuns['root-live-1'] = {
        id: 'root-live-1',
        rootRunId: 'root-live-1',
        status: 'running',
        metadata: request.metadata as JsonObject | undefined,
      };

      emitRuntimeEvent({
        id: 'evt-1',
        runId: 'run-live-1',
        seq: 1,
        type: 'run.created',
        payload: { rootRunId: 'root-live-1' } satisfies JsonValue,
        createdAt: '2026-04-08T10:02:00.100Z',
      });
      emitRuntimeEvent({
        id: 'evt-2',
        runId: 'run-live-1',
        seq: 2,
        type: 'tool.started',
        payload: { toolName: 'read_file' } satisfies JsonValue,
        createdAt: '2026-04-08T10:02:00.200Z',
      });

      runtimeRuns['run-live-1'].status = 'succeeded';
      runtimeRuns['root-live-1'].status = 'succeeded';

      return {
        status: 'success' as const,
        runId: 'run-live-1',
        output: { ok: true },
        stepsUsed: 1,
        usage: { promptTokens: 3, completionTokens: 2, estimatedCostUSD: 0.0003 },
      };
    });
    const agentRegistry = createGatewayTestAgentRegistry({
      run,
      runtimeRuns,
      eventStore,
    });

    await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'session.open',
        channelId: 'webchat',
      }),
      {
        authContext,
        stores,
        now: () => new Date('2026-04-08T10:00:00.000Z'),
        sessionIdFactory: () => 'session-1',
      },
    );

    const response = await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'run.start',
        sessionId: 'session-1',
        goal: 'Stream live events',
      }),
      {
        gatewayConfig: createChatGatewayConfig(),
        agentRegistry,
        authContext,
        stores,
        emitFrame: (frame) => {
          emittedFrames.push(frame);
        },
        now: () => new Date('2026-04-08T10:02:00.000Z'),
      },
    );

    expect(response).toEqual({
      type: 'run.output',
      runId: 'run-live-1',
      rootRunId: 'root-live-1',
      sessionId: 'session-1',
      status: 'succeeded',
      output: { ok: true },
    });
    expect(emittedFrames).toEqual([
      {
        type: 'agent.event',
        eventType: 'run.created',
        data: { rootRunId: 'root-live-1' },
        seq: 1,
        stepId: undefined,
        createdAt: '2026-04-08T10:02:00.100Z',
        sessionId: 'session-1',
        agentId: 'support-agent',
        runId: 'run-live-1',
        rootRunId: 'root-live-1',
        parentRunId: undefined,
      },
      {
        type: 'agent.event',
        eventType: 'tool.started',
        data: { toolName: 'read_file' },
        seq: 2,
        stepId: undefined,
        createdAt: '2026-04-08T10:02:00.200Z',
        sessionId: 'session-1',
        agentId: 'support-agent',
        runId: 'run-live-1',
        rootRunId: 'root-live-1',
        parentRunId: undefined,
      },
    ]);
  });

  it('persists active run linkage while a session run is still executing', async () => {
    const stores = createInMemoryGatewayStores();
    const authContext = createAuthContext('user-123');
    const runtimeRuns: Record<string, RuntimeRunRecord> = {};
    const listeners = new Set<(event: RuntimeAgentEvent) => void>();
    const eventStore: RuntimeEventStore = {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const emitRuntimeEvent = (event: RuntimeAgentEvent) => {
      for (const listener of listeners) {
        listener(event);
      }
    };
    let finishRun!: () => void;
    let emittedRunCreated!: () => void;
    const finishRunPromise = new Promise<void>((resolve) => {
      finishRun = resolve;
    });
    const emittedRunCreatedPromise = new Promise<void>((resolve) => {
      emittedRunCreated = resolve;
    });
    const run = vi.fn(async (request) => {
      runtimeRuns['root-live-pending'] = {
        id: 'root-live-pending',
        rootRunId: 'root-live-pending',
        status: 'running',
        metadata: request.metadata as JsonObject | undefined,
      };

      emitRuntimeEvent({
        id: 'evt-pending-1',
        runId: 'root-live-pending',
        seq: 1,
        type: 'run.created',
        payload: { rootRunId: 'root-live-pending' } satisfies JsonValue,
        createdAt: '2026-04-08T10:02:00.100Z',
      });
      emittedRunCreated();
      await finishRunPromise;

      runtimeRuns['root-live-pending'].status = 'succeeded';
      return {
        status: 'success' as const,
        runId: 'root-live-pending',
        output: { ok: true },
        stepsUsed: 1,
        usage: { promptTokens: 3, completionTokens: 2, estimatedCostUSD: 0.0003 },
      };
    });
    const agentRegistry = createGatewayTestAgentRegistry({
      run,
      runtimeRuns,
      eventStore,
    });

    await createStoredSession(stores, {
      agentId: 'support-agent',
    });

    const responsePromise = handleGatewaySocketMessage(
      JSON.stringify({
        type: 'run.start',
        sessionId: 'session-1',
        goal: 'Keep the active run visible before completion',
      }),
      {
        gatewayConfig: createChatGatewayConfig(),
        agentRegistry,
        authContext,
        stores,
        emitFrame: async () => undefined,
        now: () => new Date('2026-04-08T10:02:00.000Z'),
      },
    );

    await emittedRunCreatedPromise;
    await waitUntil(async () => (await stores.sessions.get('session-1'))?.currentRunId === 'root-live-pending');

    expect(await stores.sessions.get('session-1')).toMatchObject({
      status: 'running',
      currentRunId: 'root-live-pending',
      currentRootRunId: 'root-live-pending',
    });
    expect(await stores.sessionRunLinks.listBySession('session-1')).toEqual([
      {
        sessionId: 'session-1',
        runId: 'root-live-pending',
        rootRunId: 'root-live-pending',
        invocationKind: 'run',
        metadata: undefined,
        createdAt: '2026-04-08T10:02:00.000Z',
      },
    ]);

    finishRun();
    await expect(responsePromise).resolves.toMatchObject({
      type: 'run.output',
      runId: 'root-live-pending',
      rootRunId: 'root-live-pending',
      sessionId: 'session-1',
      status: 'succeeded',
    });
  });

  it('drops realtime agent events that do not match the active subscriptions', async () => {
    const stores = createInMemoryGatewayStores();
    const authContext = createAuthContext('user-123');
    const runtimeRuns: Record<string, RuntimeRunRecord> = {};
    const listeners = new Set<(event: RuntimeAgentEvent) => void>();
    const eventStore: RuntimeEventStore = {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const emitRuntimeEvent = (event: RuntimeAgentEvent) => {
      for (const listener of listeners) {
        listener(event);
      }
    };
    const channelManager = createChannelSubscriptionManager();
    channelManager.subscribe(['session:someone-else']);
    const emittedFrames: unknown[] = [];
    const run = vi.fn(async (request) => {
      runtimeRuns['run-live-2'] = {
        id: 'run-live-2',
        rootRunId: 'root-live-2',
        status: 'running',
        metadata: request.metadata as JsonObject | undefined,
      };
      runtimeRuns['root-live-2'] = {
        id: 'root-live-2',
        rootRunId: 'root-live-2',
        status: 'running',
        metadata: request.metadata as JsonObject | undefined,
      };

      emitRuntimeEvent({
        id: 'evt-3',
        runId: 'run-live-2',
        seq: 1,
        type: 'run.created',
        payload: { rootRunId: 'root-live-2' } satisfies JsonValue,
        createdAt: '2026-04-08T10:03:00.100Z',
      });

      runtimeRuns['run-live-2'].status = 'succeeded';
      runtimeRuns['root-live-2'].status = 'succeeded';

      return {
        status: 'success' as const,
        runId: 'run-live-2',
        output: { ok: true },
        stepsUsed: 1,
        usage: { promptTokens: 3, completionTokens: 2, estimatedCostUSD: 0.0003 },
      };
    });
    const agentRegistry = createGatewayTestAgentRegistry({
      run,
      runtimeRuns,
      eventStore,
    });

    await createStoredSession(stores, {
      agentId: 'support-agent',
    });

    const response = await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'run.start',
        sessionId: 'session-1',
        goal: 'Filter these events',
      }),
      {
        gatewayConfig: createChatGatewayConfig(),
        agentRegistry,
        authContext,
        stores,
        channelManager,
        emitFrame: (frame) => {
          emittedFrames.push(frame);
        },
        now: () => new Date('2026-04-08T10:03:00.000Z'),
      },
    );

    expect(response).toEqual({
      type: 'run.output',
      runId: 'run-live-2',
      rootRunId: 'root-live-2',
      sessionId: 'session-1',
      status: 'succeeded',
      output: { ok: true },
    });
    expect(emittedFrames).toEqual([]);
  });

  it('executes beforeInboundMessage hooks in the live chat path', async () => {
    const stores = createInMemoryGatewayStores();
    const authContext = createAuthContext('user-123');
    const hooks = createEmptyResolvedHooks();
    hooks.beforeInboundMessage = [
      {
        id: 'blocker',
        beforeInboundMessage: (async () => ({
          rejected: true as const,
          rejectionReason: 'Inbound messages are temporarily disabled.',
        })) as unknown as NonNullable<(typeof hooks.beforeInboundMessage)[number]['beforeInboundMessage']>,
      },
    ];

    await createStoredSession(stores, {
      agentId: 'support-agent',
    });

    const response = await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'message.send',
        sessionId: 'session-1',
        content: 'Hello?',
      }),
      {
        gatewayConfig: createChatGatewayConfig(),
        agentRegistry: createGatewayTestAgentRegistry({
          runtimeRuns: {},
        }),
        authContext,
        hooks,
        stores,
        now: () => new Date('2026-04-08T10:20:00.000Z'),
      },
    );

    expect(response).toEqual({
      type: 'error',
      code: 'invalid_frame',
      message: 'Inbound messages are temporarily disabled.',
      requestType: 'message.send',
      details: {
        sessionId: 'session-1',
        channelId: 'webchat',
        slot: 'beforeInboundMessage',
      },
    });
  });

  it('executes isolated run.start requests without creating session state', async () => {
    const stores = createInMemoryGatewayStores();
    const authContext = createAuthContext('user-123');
    const run = vi.fn(async () => ({
      status: 'success' as const,
      runId: 'run-4',
      output: { ok: true },
      stepsUsed: 1,
      usage: { promptTokens: 3, completionTokens: 2, estimatedCostUSD: 0.0003 },
    }));
    const agentRegistry = createGatewayTestAgentRegistry({
      run,
      runtimeRuns: {
        'run-4': { id: 'run-4', rootRunId: 'run-4', status: 'succeeded' },
      },
    });

    const response = await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'run.start',
        agentId: 'support-agent',
        goal: 'Check service readiness',
        context: { dryRun: true },
        metadata: { source: 'cli' },
      }),
      {
        gatewayConfig: createChatGatewayConfig(),
        agentRegistry,
        authContext,
        requestedChannelId: 'webchat',
        stores,
        now: () => new Date('2026-04-08T10:03:00.000Z'),
      },
    );

    expect(response).toEqual({
      type: 'run.output',
      runId: 'run-4',
      rootRunId: 'run-4',
      sessionId: undefined,
      status: 'succeeded',
      output: { ok: true },
    });
    expect(run).toHaveBeenCalledWith({
      goal: 'Check service readiness',
      input: undefined,
      context: {
        dryRun: true,
        invocationMode: 'run',
        channelId: 'webchat',
        authSubject: 'user-123',
        tenantId: 'acme',
        roles: ['member'],
      },
      metadata: {
        source: 'cli',
        gateway: {
          agentId: 'support-agent',
          invocationMode: 'run',
        },
      },
    });
    expect(await stores.sessionRunLinks.listBySession('session-1')).toEqual([]);
    expect(await stores.sessions.listByAuthSubject('user-123')).toEqual([]);
  });

  it('resolves approval on the same session run and returns terminal output', async () => {
    const stores = createInMemoryGatewayStores();
    const authContext = createAuthContext('user-123');
    const run = vi.fn(async () => ({
      status: 'approval_requested' as const,
      runId: 'run-approve-1',
      message: 'Approval required before invoking write_file',
      toolName: 'write_file',
    }));
    const resolveApproval = vi.fn(async () => undefined);
    const resume = vi.fn(async () => ({
      status: 'success' as const,
      runId: 'run-approve-1',
      output: { approved: true },
      stepsUsed: 2,
      usage: { promptTokens: 6, completionTokens: 4, estimatedCostUSD: 0.0008 },
    }));
    const agentRegistry = createGatewayTestAgentRegistry({
      run,
      resolveApproval,
      resume,
      runtimeRuns: {
        'run-approve-1': { id: 'run-approve-1', rootRunId: 'root-run-approve-1', status: 'awaiting_approval' },
      },
    });

    await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'session.open',
        channelId: 'webchat',
      }),
      {
        authContext,
        stores,
        now: () => new Date('2026-04-08T10:00:00.000Z'),
        sessionIdFactory: () => 'session-1',
      },
    );

    const approvalRequested = await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'run.start',
        sessionId: 'session-1',
        goal: 'Write a protected file',
      }),
      {
        gatewayConfig: createChatGatewayConfig(),
        agentRegistry,
        authContext,
        stores,
        now: () => new Date('2026-04-08T10:04:00.000Z'),
      },
    );

    expect(approvalRequested).toEqual({
      type: 'approval.requested',
      runId: 'run-approve-1',
      rootRunId: 'root-run-approve-1',
      sessionId: 'session-1',
      toolName: 'write_file',
      reason: 'Approval required before invoking write_file',
    });
    expect(await stores.sessions.get('session-1')).toMatchObject({
      status: 'awaiting_approval',
      currentRunId: 'run-approve-1',
      currentRootRunId: 'root-run-approve-1',
    });

    const response = await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'approval.resolve',
        sessionId: 'session-1',
        runId: 'run-approve-1',
        approved: true,
      }),
      {
        agentRegistry,
        authContext,
        stores,
        now: () => new Date('2026-04-08T10:05:00.000Z'),
      },
    );

    expect(response).toEqual({
      type: 'run.output',
      runId: 'run-approve-1',
      rootRunId: 'root-run-approve-1',
      sessionId: 'session-1',
      status: 'succeeded',
      output: { approved: true },
    });
    expect(resolveApproval).toHaveBeenCalledWith('run-approve-1', true);
    expect(resume).toHaveBeenCalledWith('run-approve-1');
    expect(await stores.sessions.get('session-1')).toMatchObject({
      status: 'idle',
      currentRunId: undefined,
      currentRootRunId: undefined,
      lastCompletedRootRunId: 'root-run-approve-1',
      updatedAt: '2026-04-08T10:05:00.000Z',
    });
    expect(await stores.sessionRunLinks.listBySession('session-1')).toEqual([
      {
        sessionId: 'session-1',
        runId: 'run-approve-1',
        rootRunId: 'root-run-approve-1',
        invocationKind: 'run',
        metadata: undefined,
        createdAt: '2026-04-08T10:04:00.000Z',
      },
    ]);
  });

  it('marks the session failed when approval is rejected and resumed on the same run', async () => {
    const stores = createInMemoryGatewayStores();
    const authContext = createAuthContext('user-123');
    const run = vi.fn(async () => ({
      status: 'approval_requested' as const,
      runId: 'run-approve-2',
      message: 'Approval required before invoking write_file',
      toolName: 'write_file',
    }));
    const resolveApproval = vi.fn(async () => undefined);
    const resume = vi.fn(async () => ({
      status: 'failure' as const,
      runId: 'run-approve-2',
      error: 'Approval rejected for write_file',
      code: 'APPROVAL_REJECTED' as const,
      stepsUsed: 2,
      usage: { promptTokens: 6, completionTokens: 0, estimatedCostUSD: 0.0004 },
    }));
    const agentRegistry = createGatewayTestAgentRegistry({
      run,
      resolveApproval,
      resume,
      runtimeRuns: {
        'run-approve-2': { id: 'run-approve-2', rootRunId: 'root-run-approve-2', status: 'failed' },
      },
    });

    await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'session.open',
        channelId: 'webchat',
      }),
      {
        authContext,
        stores,
        now: () => new Date('2026-04-08T10:00:00.000Z'),
        sessionIdFactory: () => 'session-1',
      },
    );

    await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'run.start',
        sessionId: 'session-1',
        goal: 'Write another protected file',
      }),
      {
        gatewayConfig: createChatGatewayConfig(),
        agentRegistry,
        authContext,
        stores,
        now: () => new Date('2026-04-08T10:06:00.000Z'),
      },
    );

    const response = await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'approval.resolve',
        sessionId: 'session-1',
        runId: 'run-approve-2',
        approved: false,
      }),
      {
        agentRegistry,
        authContext,
        stores,
        now: () => new Date('2026-04-08T10:07:00.000Z'),
      },
    );

    expect(response).toEqual({
      type: 'run.output',
      runId: 'run-approve-2',
      rootRunId: 'root-run-approve-2',
      sessionId: 'session-1',
      status: 'failed',
      error: 'Approval rejected for write_file',
    });
    expect(resolveApproval).toHaveBeenCalledWith('run-approve-2', false);
    expect(resume).toHaveBeenCalledWith('run-approve-2');
    expect(await stores.sessions.get('session-1')).toMatchObject({
      status: 'failed',
      currentRunId: undefined,
      currentRootRunId: undefined,
      lastCompletedRootRunId: 'root-run-approve-2',
      updatedAt: '2026-04-08T10:07:00.000Z',
    });
  });

  it('rejects approval.resolve from a different principal', async () => {
    const stores = createInMemoryGatewayStores();
    const run = vi.fn(async () => ({
      status: 'approval_requested' as const,
      runId: 'run-approve-3',
      message: 'Approval required before invoking write_file',
      toolName: 'write_file',
    }));
    const resolveApproval = vi.fn(async () => undefined);
    const resume = vi.fn(async () => ({
      status: 'success' as const,
      runId: 'run-approve-3',
      output: { approved: true },
      stepsUsed: 2,
      usage: { promptTokens: 6, completionTokens: 4, estimatedCostUSD: 0.0008 },
    }));
    const agentRegistry = createGatewayTestAgentRegistry({
      run,
      resolveApproval,
      resume,
      runtimeRuns: {
        'run-approve-3': { id: 'run-approve-3', rootRunId: 'root-run-approve-3', status: 'awaiting_approval' },
      },
    });

    await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'session.open',
        channelId: 'webchat',
      }),
      {
        authContext: createAuthContext('user-123'),
        stores,
        now: () => new Date('2026-04-08T10:00:00.000Z'),
        sessionIdFactory: () => 'session-1',
      },
    );

    await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'run.start',
        sessionId: 'session-1',
        goal: 'Write a protected file',
      }),
      {
        gatewayConfig: createChatGatewayConfig(),
        agentRegistry,
        authContext: createAuthContext('user-123'),
        stores,
        now: () => new Date('2026-04-08T10:08:00.000Z'),
      },
    );

    const response = await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'approval.resolve',
        sessionId: 'session-1',
        runId: 'run-approve-3',
        approved: true,
      }),
      {
        agentRegistry,
        authContext: createAuthContext('user-999'),
        stores,
        now: () => new Date('2026-04-08T10:09:00.000Z'),
      },
    );

    expect(response).toEqual({
      type: 'error',
      code: 'session_forbidden',
      message: 'Session "session-1" belongs to a different authenticated principal.',
      requestType: 'approval.resolve',
      details: {
        sessionId: 'session-1',
        channelId: 'webchat',
      },
    });
    expect(resolveApproval).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it('rejects approval.resolve when the session is awaiting a different run id', async () => {
    const stores = createInMemoryGatewayStores();
    const authContext = createAuthContext('user-123');
    const run = vi.fn(async () => ({
      status: 'approval_requested' as const,
      runId: 'run-approve-4',
      message: 'Approval required before invoking write_file',
      toolName: 'write_file',
    }));
    const resolveApproval = vi.fn(async () => undefined);
    const resume = vi.fn(async () => ({
      status: 'success' as const,
      runId: 'run-approve-4',
      output: { approved: true },
      stepsUsed: 2,
      usage: { promptTokens: 6, completionTokens: 4, estimatedCostUSD: 0.0008 },
    }));
    const agentRegistry = createGatewayTestAgentRegistry({
      run,
      resolveApproval,
      resume,
      runtimeRuns: {
        'run-approve-4': { id: 'run-approve-4', rootRunId: 'root-run-approve-4', status: 'awaiting_approval' },
      },
    });

    await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'session.open',
        channelId: 'webchat',
      }),
      {
        authContext,
        stores,
        now: () => new Date('2026-04-08T10:00:00.000Z'),
        sessionIdFactory: () => 'session-1',
      },
    );

    await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'run.start',
        sessionId: 'session-1',
        goal: 'Write a protected file',
      }),
      {
        gatewayConfig: createChatGatewayConfig(),
        agentRegistry,
        authContext,
        stores,
        now: () => new Date('2026-04-08T10:10:00.000Z'),
      },
    );

    const response = await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'approval.resolve',
        sessionId: 'session-1',
        runId: 'run-other',
        approved: true,
      }),
      {
        agentRegistry,
        authContext,
        stores,
        now: () => new Date('2026-04-08T10:11:00.000Z'),
      },
    );

    expect(response).toEqual({
      type: 'error',
      code: 'invalid_frame',
      message: 'Session "session-1" is awaiting approval for run "run-approve-4", not "run-other".',
      requestType: 'approval.resolve',
      details: {
        sessionId: 'session-1',
        runId: 'run-other',
        currentRunId: 'run-approve-4',
      },
    });
    expect(resolveApproval).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it('allows same-principal observers to reattach while rejecting new writes on running sessions', async () => {
    const stores = createInMemoryGatewayStores();
    const authContext = createAuthContext('user-123');
    const chat = vi.fn(async () => ({
      status: 'success' as const,
      runId: 'run-late-chat',
      output: 'ok',
      stepsUsed: 1,
      usage: { promptTokens: 1, completionTokens: 1, estimatedCostUSD: 0.0001 },
    }));
    const run = vi.fn(async () => ({
      status: 'success' as const,
      runId: 'run-late-structured',
      output: { ok: true },
      stepsUsed: 1,
      usage: { promptTokens: 1, completionTokens: 1, estimatedCostUSD: 0.0001 },
    }));
    const agentRegistry = createGatewayTestAgentRegistry({
      chat,
      run,
      runtimeRuns: {},
    });

    await createStoredSession(stores, {
      agentId: 'support-agent',
      invocationMode: 'chat',
      status: 'running',
      currentRunId: 'run-active',
      currentRootRunId: 'root-run-active',
    });

    const reattach = await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'session.open',
        sessionId: 'session-1',
        channelId: 'webchat',
      }),
      {
        authContext,
        stores,
        now: () => new Date('2026-04-08T10:12:00.000Z'),
      },
    );

    expect(reattach).toEqual({
      type: 'session.opened',
      sessionId: 'session-1',
      channelId: 'webchat',
      agentId: 'support-agent',
      invocationMode: 'chat',
      status: 'running',
    });

    const messageResponse = await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'message.send',
        sessionId: 'session-1',
        content: 'Can I interrupt this run?',
      }),
      {
        gatewayConfig: createChatGatewayConfig(),
        agentRegistry,
        authContext,
        stores,
        now: () => new Date('2026-04-08T10:13:00.000Z'),
      },
    );

    expect(messageResponse).toEqual({
      type: 'error',
      code: 'session_busy',
      message: 'Session "session-1" already has an active root run and cannot accept frame type "message.send".',
      requestType: 'message.send',
      details: {
        sessionId: 'session-1',
        status: 'running',
        currentRunId: 'run-active',
        currentRootRunId: 'root-run-active',
      },
    });

    const runResponse = await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'run.start',
        sessionId: 'session-1',
        goal: 'Start another run anyway',
      }),
      {
        gatewayConfig: createChatGatewayConfig(),
        agentRegistry,
        authContext,
        stores,
        now: () => new Date('2026-04-08T10:14:00.000Z'),
      },
    );

    expect(runResponse).toEqual({
      type: 'error',
      code: 'session_busy',
      message: 'Session "session-1" already has an active root run and cannot accept frame type "run.start".',
      requestType: 'run.start',
      details: {
        sessionId: 'session-1',
        status: 'running',
        currentRunId: 'run-active',
        currentRootRunId: 'root-run-active',
      },
    });
    expect(chat).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('accepts only approval.resolve while a session is awaiting approval', async () => {
    const stores = createInMemoryGatewayStores();
    const authContext = createAuthContext('user-123');
    const chat = vi.fn(async () => ({
      status: 'success' as const,
      runId: 'run-chat-after-approval',
      output: 'ok',
      stepsUsed: 1,
      usage: { promptTokens: 1, completionTokens: 1, estimatedCostUSD: 0.0001 },
    }));
    const run = vi.fn(async () => ({
      status: 'success' as const,
      runId: 'run-after-approval',
      output: { ok: true },
      stepsUsed: 1,
      usage: { promptTokens: 1, completionTokens: 1, estimatedCostUSD: 0.0001 },
    }));
    const resolveApproval = vi.fn(async () => undefined);
    const resume = vi.fn(async () => ({
      status: 'success' as const,
      runId: 'run-awaiting',
      output: { resumed: true },
      stepsUsed: 2,
      usage: { promptTokens: 2, completionTokens: 1, estimatedCostUSD: 0.0002 },
    }));
    const agentRegistry = createGatewayTestAgentRegistry({
      chat,
      run,
      resolveApproval,
      resume,
      runtimeRuns: {
        'run-awaiting': { id: 'run-awaiting', rootRunId: 'root-run-awaiting', status: 'awaiting_approval' },
      },
    });

    await createStoredSession(stores, {
      agentId: 'support-agent',
      invocationMode: 'run',
      status: 'awaiting_approval',
      currentRunId: 'run-awaiting',
      currentRootRunId: 'root-run-awaiting',
    });

    const messageResponse = await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'message.send',
        sessionId: 'session-1',
        content: 'Let me add more input first',
      }),
      {
        gatewayConfig: createChatGatewayConfig(),
        agentRegistry,
        authContext,
        stores,
        now: () => new Date('2026-04-08T10:15:00.000Z'),
      },
    );

    expect(messageResponse).toEqual({
      type: 'error',
      code: 'approval_required',
      message: 'Session "session-1" is awaiting approval and only approval.resolve may mutate it.',
      requestType: 'message.send',
      details: {
        sessionId: 'session-1',
        status: 'awaiting_approval',
        currentRunId: 'run-awaiting',
        currentRootRunId: 'root-run-awaiting',
      },
    });

    const runResponse = await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'run.start',
        sessionId: 'session-1',
        goal: 'Start another run before approving',
      }),
      {
        gatewayConfig: createChatGatewayConfig(),
        agentRegistry,
        authContext,
        stores,
        now: () => new Date('2026-04-08T10:16:00.000Z'),
      },
    );

    expect(runResponse).toEqual({
      type: 'error',
      code: 'approval_required',
      message: 'Session "session-1" is awaiting approval and only approval.resolve may mutate it.',
      requestType: 'run.start',
      details: {
        sessionId: 'session-1',
        status: 'awaiting_approval',
        currentRunId: 'run-awaiting',
        currentRootRunId: 'root-run-awaiting',
      },
    });

    const approvalResponse = await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'approval.resolve',
        sessionId: 'session-1',
        runId: 'run-awaiting',
        approved: true,
      }),
      {
        agentRegistry,
        authContext,
        stores,
        now: () => new Date('2026-04-08T10:17:00.000Z'),
      },
    );

    expect(approvalResponse).toEqual({
      type: 'run.output',
      runId: 'run-awaiting',
      rootRunId: 'root-run-awaiting',
      sessionId: 'session-1',
      status: 'succeeded',
      output: { resumed: true },
    });
    expect(chat).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(resolveApproval).toHaveBeenCalledWith('run-awaiting', true);
    expect(resume).toHaveBeenCalledWith('run-awaiting');
  });

  it('routes clarification.resolve to the linked run session', async () => {
    const stores = createInMemoryGatewayStores();
    const authContext = createAuthContext('user-123');
    const resolveClarification = vi.fn(async () => ({
      status: 'success' as const,
      runId: 'run-clarify',
      output: { clarified: true },
      stepsUsed: 2,
      usage: { promptTokens: 0, completionTokens: 0, estimatedCostUSD: 0 },
    }));
    const agentRegistry = createGatewayTestAgentRegistry({
      resolveClarification,
      runtimeRuns: {
        'run-clarify': { id: 'run-clarify', rootRunId: 'root-run-clarify', status: 'succeeded' },
      },
    });

    await createStoredSession(stores, {
      agentId: 'support-agent',
      invocationMode: 'run',
      status: 'idle',
    });
    await stores.sessionRunLinks.append({
      sessionId: 'session-1',
      runId: 'run-clarify',
      rootRunId: 'root-run-clarify',
      invocationKind: 'run',
      createdAt: '2026-04-08T10:17:00.000Z',
    });

    const response = await handleGatewaySocketMessage(
      JSON.stringify({
        type: 'clarification.resolve',
        sessionId: 'session-1',
        runId: 'run-clarify',
        message: 'Use markdown output.',
      }),
      {
        agentRegistry,
        authContext,
        stores,
        now: () => new Date('2026-04-08T10:18:00.000Z'),
      },
    );

    expect(response).toEqual({
      type: 'run.output',
      runId: 'run-clarify',
      rootRunId: 'root-run-clarify',
      sessionId: 'session-1',
      status: 'succeeded',
      output: { clarified: true },
    });
    expect(resolveClarification).toHaveBeenCalledWith('run-clarify', 'Use markdown output.');
  });
});

function createAuthContext(subject: string): GatewayAuthContext {
  return {
    subject,
    tenantId: 'acme',
    roles: ['member'],
    claims: { sub: subject, tenantId: 'acme', roles: ['member'] },
  };
}

function createStaticAuthProvider(roles: string[]) {
  return {
    definition: {
      id: 'static',
      authenticate: async ({ token }: { token: string }) => ({
        subject: token,
        tenantId: 'acme',
        roles,
        claims: { sub: token, tenantId: 'acme', roles },
      }),
    },
    settings: {},
  };
}

function createChatGatewayConfig(): GatewayConfig {
  return {
    ...baseConfig,
    transcript: {
      recentMessageWindow: 2,
      summaryTriggerWindow: 2,
      summaryMaxMessages: 4,
      summaryLineMaxLength: 80,
    },
    bindings: [
      {
        match: { channelId: 'webchat' },
        agentId: 'support-agent',
      },
    ],
    defaultAgentId: 'support-agent',
  };
}

function createTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: 'object', additionalProperties: true },
    execute: async () => ({ ok: true }),
  };
}

function createDelegate(name: string): DelegateDefinition {
  return {
    name,
    description: `${name} delegate`,
    allowedTools: [],
  };
}

function createLoadedAgentConfig(): LoadedConfig<AgentConfig> {
  return {
    path: '/tmp/support-agent.json',
    config: {
      id: 'support-agent',
      name: 'Support Agent',
      invocationModes: ['chat', 'run'],
      defaultInvocationMode: 'chat',
      model: {
        provider: 'ollama',
        model: 'qwen3.5',
      },
      tools: ['read_file'],
      delegates: ['researcher'],
    },
  };
}

function createGatewayTestAgentRegistry(
  options: {
    chat?: CreatedAdaptiveAgent['agent']['chat'];
    run?: NonNullable<CreatedAdaptiveAgent['agent']['run']>;
    resolveApproval?: NonNullable<CreatedAdaptiveAgent['agent']['resolveApproval']>;
    resolveClarification?: NonNullable<CreatedAdaptiveAgent['agent']['resolveClarification']>;
    resume?: NonNullable<CreatedAdaptiveAgent['agent']['resume']>;
    retry?: NonNullable<CreatedAdaptiveAgent['agent']['retry']>;
    runtimeRuns: Record<string, RuntimeRunRecord>;
    eventStore?: RuntimeEventStore;
  },
) {
  return createAgentRegistry({
    agents: [createLoadedAgentConfig()],
    moduleRegistry: createModuleRegistry({
      tools: [createTool('read_file')],
      delegates: [createDelegate('researcher')],
    }),
    agentFactory: async () => ({
      agent: {
        chat:
          options.chat ??
          (async () => ({
            status: 'success',
            runId: 'default-chat-run',
            output: 'ok',
            stepsUsed: 1,
            usage: { promptTokens: 0, completionTokens: 0, estimatedCostUSD: 0 },
          })),
        run: options.run,
        resolveApproval: options.resolveApproval,
        resolveClarification: options.resolveClarification,
        resume: options.resume,
        retry: options.retry,
      },
      runtime: {
        runStore: {
          getRun: async (runId: string) => options.runtimeRuns[runId] ?? null,
        },
        eventStore: options.eventStore ?? {},
        snapshotStore: {},
        planStore: undefined,
      },
    }),
  });
}

async function createStoredSession(
  stores: ReturnType<typeof createInMemoryGatewayStores>,
  overrides: Partial<GatewaySessionRecord> = {},
): Promise<GatewaySessionRecord> {
  return stores.sessions.create({
    id: 'session-1',
    channelId: 'webchat',
    authSubject: 'user-123',
    tenantId: 'acme',
    status: 'idle',
    transcriptVersion: 0,
    createdAt: '2026-04-08T10:00:00.000Z',
    updatedAt: '2026-04-08T10:00:00.000Z',
    ...overrides,
  });
}

function createSequentialIdFactory(ids: string[]): () => string {
  const pendingIds = [...ids];
  return () => {
    const nextId = pendingIds.shift();
    if (!nextId) {
      throw new Error('No more transcript ids available.');
    }

    return nextId;
  };
}

function getListeningPort(app: Awaited<ReturnType<typeof createGatewayServer>>): number {
  const address = app.server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected Fastify to be listening on an IP socket.');
  }

  return address.port;
}

async function openTestWebSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      socket.removeEventListener('open', handleOpen);
      socket.removeEventListener('error', handleError);
    };

    const handleOpen = () => {
      cleanup();
      resolve();
    };

    const handleError = (event: Event) => {
      cleanup();
      reject(new Error(`WebSocket connection failed: ${String(event.type)}`));
    };

    socket.addEventListener('open', handleOpen, { once: true });
    socket.addEventListener('error', handleError, { once: true });
  });

  return socket;
}

async function waitForSocketMessage(socket: WebSocket): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const cleanup = () => {
      socket.removeEventListener('message', handleMessage);
      socket.removeEventListener('error', handleError);
    };

    const handleMessage = (event: MessageEvent) => {
      cleanup();
      resolve(String(event.data));
    };

    const handleError = (event: Event) => {
      cleanup();
      reject(new Error(`WebSocket error while waiting for message: ${String(event.type)}`));
    };

    socket.addEventListener('message', handleMessage, { once: true });
    socket.addEventListener('error', handleError, { once: true });
  });
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  throw new Error('Timed out waiting for condition.');
}
