import { afterEach, describe, expect, it } from 'vitest';

import type { GatewayAuthContext } from './auth.js';
import type { GatewayConfig } from './config.js';
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
    expect(await handleGatewaySocketMessage(JSON.stringify({ type: 'run.start', goal: 'Inspect logs' }))).toEqual({
      type: 'error',
      code: 'unsupported_frame',
      message: 'Inbound frame type "run.start" is valid but not implemented yet.',
      requestType: 'run.start',
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
});

function createAuthContext(subject: string): GatewayAuthContext {
  return {
    subject,
    tenantId: 'acme',
    roles: ['member'],
    claims: { sub: subject, tenantId: 'acme', roles: ['member'] },
  };
}

function getListeningPort(app: Awaited<ReturnType<typeof createGatewayServer>>): number {
  const address = app.server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected Fastify to be listening on an IP socket.');
  }

  return address.port;
}
