import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import websocket from '@fastify/websocket';

import {
  GatewayAuthError,
  authenticateGatewayUpgrade,
  createAuthErrorFrame,
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

export interface CreateGatewayServerOptions {
  fastify?: FastifyServerOptions;
  auth?: ResolvedGatewayAuthProvider;
}

export async function createGatewayServer(
  config: GatewayConfig,
  options: CreateGatewayServerOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify(options.fastify);

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
    (socket) => {
    socket.on('message', (message: unknown) => {
      socket.send(serializeOutboundFrame(handleGatewaySocketMessage(message)));
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

export function handleGatewaySocketMessage(message: unknown): OutboundFrame {
  try {
    const frame = parseInboundFrame(message);
    if (frame.type === 'ping') {
      return createPongFrame(frame);
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
