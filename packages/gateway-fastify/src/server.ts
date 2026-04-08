import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import websocket from '@fastify/websocket';

import {
  GatewayAuthError,
  authenticateGatewayUpgrade,
  createAuthErrorFrame,
  type GatewayAuthContext,
  type GatewayUpgradeQuery,
} from './auth.js';
import type { GatewayConfig } from './config.js';
import {
  ProtocolValidationError,
  type OutboundFrame,
  createPongFrame,
  createProtocolErrorFrame,
  createUnsupportedFrameError,
  parseInboundFrame,
  serializeOutboundFrame,
} from './protocol.js';
import type { ResolvedGatewayAuthProvider } from './registries.js';
import { openGatewaySession } from './session.js';
import { createInMemoryGatewayStores, type GatewayStores } from './stores.js';

export interface CreateGatewayServerOptions {
  fastify?: FastifyServerOptions;
  auth?: ResolvedGatewayAuthProvider;
  stores?: GatewayStores;
  now?: () => Date;
  sessionIdFactory?: () => string;
}

export interface GatewaySocketMessageContext {
  authContext?: GatewayAuthContext;
  stores?: GatewayStores;
  now?: () => Date;
  sessionIdFactory?: () => string;
}

export async function createGatewayServer(
  config: GatewayConfig,
  options: CreateGatewayServerOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify(options.fastify);
  const stores = options.stores ?? createInMemoryGatewayStores();

  await app.register(websocket);

  app.get<{ Querystring: GatewayUpgradeQuery }>(
    config.server.websocketPath,
    {
      websocket: true,
      preValidation: async (request, reply) => {
        try {
          const authResult = await authenticateGatewayUpgrade({
            config,
            auth: options.auth,
            headers: request.headers,
            url: request.raw.url ?? request.url,
          });

          request.gatewayAuthContext = authResult.authContext;
          request.gatewayRequestedChannelId = authResult.requestedChannelId;
          request.gatewayIsPublicChannel = authResult.isPublicChannel;
        } catch (error) {
          if (error instanceof GatewayAuthError) {
            return reply.code(error.statusCode).send(createAuthErrorFrame(error));
          }

          throw error;
        }
      },
    },
    (socket, request) => {
      socket.on('message', async (message: unknown) => {
        const frame = await handleGatewaySocketMessage(message, {
          authContext: request.gatewayAuthContext,
          stores,
          now: options.now,
          sessionIdFactory: options.sessionIdFactory,
        });

        socket.send(serializeOutboundFrame(frame));
      });
    },
  );

  if (config.server.healthPath) {
    app.get(config.server.healthPath, async () => ({
      status: 'ok',
      websocketPath: config.server.websocketPath,
    }));
  }

  return app;
}

export async function handleGatewaySocketMessage(
  message: unknown,
  context: GatewaySocketMessageContext = {},
): Promise<OutboundFrame> {
  try {
    const frame = parseInboundFrame(message);
    if (frame.type === 'ping') {
      return createPongFrame(frame);
    }

    if (frame.type === 'session.open' && context.stores) {
      return await openGatewaySession(frame, {
        authContext: context.authContext,
        stores: context.stores,
        now: context.now,
        sessionIdFactory: context.sessionIdFactory,
      });
    }

    return createProtocolErrorFrame(createUnsupportedFrameError(frame.type));
  } catch (error) {
    const protocolError =
      error instanceof ProtocolValidationError
        ? error
        : new ProtocolValidationError('invalid_frame', 'Unexpected WebSocket protocol error.');

    return createProtocolErrorFrame(protocolError);
  }
}
