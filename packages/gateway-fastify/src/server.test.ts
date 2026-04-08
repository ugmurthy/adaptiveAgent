import { afterEach, describe, expect, it } from 'vitest';
import type { GatewayConfig } from './config.js';
import { createGatewayServer, handleGatewaySocketMessage } from './server.js';

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

  it('routes websocket messages through the validated protocol handler', () => {
    expect(handleGatewaySocketMessage(JSON.stringify({ type: 'ping', id: 'heartbeat-1' }))).toEqual({
      type: 'pong',
      id: 'heartbeat-1',
    });
    expect(handleGatewaySocketMessage(JSON.stringify({ type: 'run.start', goal: 'Inspect logs' }))).toEqual({
      type: 'error',
      code: 'unsupported_frame',
      message: 'Inbound frame type "run.start" is valid but not implemented yet.',
      requestType: 'run.start',
      details: undefined,
    });
    expect(handleGatewaySocketMessage(JSON.stringify({ type: 'mystery.frame' }))).toEqual({
      type: 'error',
      code: 'unknown_frame_type',
      message: 'Unknown inbound frame type "mystery.frame".',
      requestType: 'mystery.frame',
      details: undefined,
    });
    expect(handleGatewaySocketMessage('{bad json')).toMatchObject({
      type: 'error',
      code: 'invalid_json',
    });
  });
});

function getListeningPort(app: Awaited<ReturnType<typeof createGatewayServer>>): number {
  const address = app.server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected Fastify to be listening on an IP socket.');
  }

  return address.port;
}
