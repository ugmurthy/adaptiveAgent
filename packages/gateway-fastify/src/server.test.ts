import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CreatedAdaptiveAgent, DelegateDefinition, ToolDefinition } from './core.js';
import type { GatewayAuthContext } from './auth.js';
import { createAgentRegistry } from './agent-registry.js';
import type { GatewayConfig } from './config.js';
import type { AgentConfig, LoadedConfig } from './config.js';
import { createModuleRegistry } from './registries.js';
import { createGatewayServer, handleGatewaySocketMessage } from './server.js';
import { createInMemoryGatewayStores } from './stores.js';

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

  it('starts listening on the configured host and an ephemeral port', async () => {
    const app = await createGatewayServer(baseConfig);
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });

    expect(app.server.listening).toBe(true);
    expect(getListeningPort(app)).toBeGreaterThan(0);
  });

  it('routes websocket messages through the validated protocol handler', async () => {
    expect(await handleGatewaySocketMessage(JSON.stringify({ type: 'ping', id: 'heartbeat-1' }))).toEqual({
      type: 'pong',
      id: 'heartbeat-1',
    });
    expect(await handleGatewaySocketMessage(JSON.stringify({ type: 'channel.subscribe', channels: ['session:1'] }))).toEqual({
      type: 'error',
      code: 'unsupported_frame',
      message: 'Inbound frame type "channel.subscribe" is valid but not implemented yet.',
      requestType: 'channel.subscribe',
      details: undefined,
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
        channelId: 'webchat',
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
});

function createAuthContext(subject: string): GatewayAuthContext {
  return {
    subject,
    tenantId: 'acme',
    roles: ['member'],
    claims: { sub: subject, tenantId: 'acme', roles: ['member'] },
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
    resume?: NonNullable<CreatedAdaptiveAgent['agent']['resume']>;
    runtimeRuns: Record<string, { id: string; rootRunId: string; status: string }>;
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
        resume: options.resume,
      },
      runtime: {
        runStore: {
          getRun: async (runId: string) => options.runtimeRuns[runId] ?? null,
        },
        eventStore: {},
        snapshotStore: {},
        planStore: undefined,
      },
    }),
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
