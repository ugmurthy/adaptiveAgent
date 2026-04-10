import { randomUUID } from 'node:crypto';

import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import websocket from '@fastify/websocket';

import type { AgentRegistry } from './agent-registry.js';
import {
  GatewayAuthError,
  authenticateGatewayUpgrade,
  createAuthErrorFrame,
  type GatewayAuthContext,
  type GatewayUpgradeQuery,
} from './auth.js';
import {
  createChannelSubscriptionManager,
  validateChannelSubscribeFrame,
  type ChannelSubscriptionManager,
} from './channels.js';
import { executeGatewayChatTurn } from './chat.js';
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
import { executeGatewayApprovalResolution, executeGatewayClarificationResolution, executeGatewayRunStart } from './run.js';
import { openGatewaySession } from './session.js';
import { createInMemoryGatewayStores, type GatewayStores } from './stores.js';

export interface CreateGatewayServerOptions {
  fastify?: FastifyServerOptions;
  auth?: ResolvedGatewayAuthProvider;
  agentRegistry?: AgentRegistry;
  stores?: GatewayStores;
  now?: () => Date;
  sessionIdFactory?: () => string;
  transcriptMessageIdFactory?: () => string;
}

export interface GatewaySocketMessageContext {
  gatewayConfig?: GatewayConfig;
  agentRegistry?: AgentRegistry;
  authContext?: GatewayAuthContext;
  requestedChannelId?: string;
  stores?: GatewayStores;
  channelManager?: ChannelSubscriptionManager;
  emitFrame?: (frame: OutboundFrame) => void;
  now?: () => Date;
  sessionIdFactory?: () => string;
  transcriptMessageIdFactory?: () => string;
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
      const channelManager = createChannelSubscriptionManager();
      const emitFrame = (frame: OutboundFrame) => {
        socket.send(serializeOutboundFrame(frame));
      };

      socket.on('message', async (message: unknown) => {
        const frame = await handleGatewaySocketMessage(message, {
          gatewayConfig: config,
          agentRegistry: options.agentRegistry,
          authContext: request.gatewayAuthContext,
          requestedChannelId: request.gatewayRequestedChannelId,
          stores,
          channelManager,
          emitFrame,
          now: options.now,
          sessionIdFactory: options.sessionIdFactory,
          transcriptMessageIdFactory: options.transcriptMessageIdFactory,
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
    const realtimeRequestId = context.emitFrame ? randomUUID() : undefined;

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

    if (frame.type === 'message.send' && context.stores && context.gatewayConfig && context.agentRegistry) {
      return await executeGatewayChatTurn(frame, {
        gatewayConfig: context.gatewayConfig,
        agentRegistry: context.agentRegistry,
        stores: context.stores,
        authContext: context.authContext,
        now: context.now,
        transcriptMessageIdFactory: context.transcriptMessageIdFactory,
        realtimeEvents:
          realtimeRequestId && context.emitFrame
            ? {
                requestId: realtimeRequestId,
                emitFrame: context.emitFrame,
              }
            : undefined,
      });
    }

    if (frame.type === 'run.start' && context.stores && context.gatewayConfig && context.agentRegistry) {
      return await executeGatewayRunStart(frame, {
        gatewayConfig: context.gatewayConfig,
        agentRegistry: context.agentRegistry,
        stores: context.stores,
        authContext: context.authContext,
        requestedChannelId: context.requestedChannelId,
        now: context.now,
        realtimeEvents:
          realtimeRequestId && context.emitFrame
            ? {
                requestId: realtimeRequestId,
                emitFrame: context.emitFrame,
              }
            : undefined,
      });
    }

    if (frame.type === 'approval.resolve' && context.stores && context.agentRegistry) {
      return await executeGatewayApprovalResolution(frame, {
        agentRegistry: context.agentRegistry,
        stores: context.stores,
        authContext: context.authContext,
        now: context.now,
        realtimeEvents: context.emitFrame
          ? {
              rootRunId: frame.runId,
              emitFrame: context.emitFrame,
            }
          : undefined,
      });
    }

    if (frame.type === 'clarification.resolve' && context.stores && context.agentRegistry) {
      return await executeGatewayClarificationResolution(frame, {
        agentRegistry: context.agentRegistry,
        stores: context.stores,
        authContext: context.authContext,
        now: context.now,
        realtimeEvents: context.emitFrame
          ? {
              rootRunId: frame.runId,
              emitFrame: context.emitFrame,
            }
          : undefined,
      });
    }

    if (frame.type === 'channel.subscribe') {
      const manager = context.channelManager ?? createChannelSubscriptionManager();
      const { valid, invalid } = validateChannelSubscribeFrame(frame);

      if (invalid.length > 0 && valid.length === 0) {
        return createProtocolErrorFrame(
          new ProtocolValidationError(
            'invalid_frame',
            `No valid channel subscriptions in request. Invalid channels: ${invalid.join(', ')}.`,
            { requestType: frame.type, details: { invalid } },
          ),
        );
      }

      manager.subscribe(frame.channels);

      return {
        type: 'session.updated',
        sessionId: '',
        status: 'idle',
        transcriptVersion: 0,
        activeRunId: undefined,
        activeRootRunId: undefined,
      };
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
