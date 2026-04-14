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
import type { JsonObject } from './core.js';
import {
  ProtocolValidationError,
  type InboundFrame,
  type OutboundFrame,
  createPongFrame,
  createProtocolErrorFrame,
  createUnsupportedFrameError,
  parseInboundFrame,
  serializeOutboundFrame,
} from './protocol.js';
import { executeHookSlot } from './hooks.js';
import { restoreActiveSession } from './reconnect.js';
import type { ResolvedGatewayAuthProvider, ResolvedGatewayHooks } from './registries.js';
import { executeGatewayApprovalResolution, executeGatewayClarificationResolution, executeGatewayRunRetry, executeGatewayRunStart } from './run.js';
import { createGatewayLogger, type GatewayLogger } from './observability.js';
import { subscribeToForwardedRealtimeEvents } from './realtime-events.js';
import { getAuthorizedGatewaySession, openGatewaySession } from './session.js';
import { createInMemoryGatewayStores, type GatewayStores } from './stores.js';

export interface CreateGatewayServerOptions {
  fastify?: FastifyServerOptions;
  auth?: ResolvedGatewayAuthProvider;
  hooks?: ResolvedGatewayHooks;
  agentRegistry?: AgentRegistry;
  stores?: GatewayStores;
  requestLogger?: GatewayLogger;
  now?: () => Date;
  sessionIdFactory?: () => string;
  transcriptMessageIdFactory?: () => string;
}

export interface GatewaySocketMessageContext {
  gatewayConfig?: GatewayConfig;
  agentRegistry?: AgentRegistry;
  authContext?: GatewayAuthContext;
  hooks?: ResolvedGatewayHooks;
  requestedChannelId?: string;
  stores?: GatewayStores;
  channelManager?: ChannelSubscriptionManager;
  emitFrame?: (frame: OutboundFrame) => Promise<void> | void;
  registerRuntimeObserver?: (observer: RuntimeObserverRegistration) => Promise<void>;
  hasRuntimeObserver?: (rootRunId: string) => boolean;
  postResponseTasks?: Array<() => Promise<void>>;
  now?: () => Date;
  sessionIdFactory?: () => string;
  transcriptMessageIdFactory?: () => string;
}

export interface RuntimeObserverRegistration {
  agentId: string;
  rootRunId: string;
  sessionId: string;
}

export async function createGatewayServer(
  config: GatewayConfig,
  options: CreateGatewayServerOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify(options.fastify);
  const stores = options.stores ?? createInMemoryGatewayStores();
  const requestLogger = options.requestLogger
    ?? (config.server.requestLogging
      ? createGatewayLogger({
          destination: config.server.requestLoggingDestination,
        })
      : undefined);
  const shouldCloseRequestLogger = options.requestLogger === undefined && requestLogger !== undefined;

  if (requestLogger) {
    const requestStartTimes = new WeakMap<object, bigint>();

    if (shouldCloseRequestLogger) {
      app.addHook('onClose', async () => {
        await requestLogger.close();
      });
    }

    app.addHook('onRequest', async (request) => {
      requestStartTimes.set(request.raw, process.hrtime.bigint());

      requestLogger.info('http.request.started', 'HTTP request started', {
        requestId: request.id,
        method: request.method,
        url: sanitizeLoggedUrl(request.url),
        remoteAddress: request.ip,
      });
    });

    app.addHook('onResponse', async (request, reply) => {
      const startedAt = requestStartTimes.get(request.raw);
      const durationMs = startedAt ? Number(process.hrtime.bigint() - startedAt) / 1_000_000 : undefined;

      requestLogger.info('http.request.completed', 'HTTP request completed', {
        requestId: request.id,
        method: request.method,
        url: sanitizeLoggedUrl(request.url),
        statusCode: reply.statusCode,
        remoteAddress: request.ip,
        ...(durationMs === undefined
          ? {}
          : {
              durationMs: Math.round(durationMs * 1000) / 1000,
            }),
      });

      requestStartTimes.delete(request.raw);
    });
  }

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

          if (options.hooks) {
            const hookResult = await executeHookSlot(options.hooks, 'onAuthenticate', {
              slot: 'onAuthenticate',
              authContext: authResult.authContext,
              requestedChannelId: authResult.requestedChannelId,
              isPublicChannel: authResult.isPublicChannel,
              headers: request.headers,
              url: request.raw.url ?? request.url,
            });

            if (hookResult.rejected) {
              throw new GatewayAuthError(
                'invalid_frame',
                hookResult.rejectionReason ?? 'Gateway authentication was rejected by a hook.',
                {
                  statusCode: 403,
                  details: {
                    ...(authResult.requestedChannelId ? { channelId: authResult.requestedChannelId } : {}),
                    slot: 'onAuthenticate',
                  },
                },
              );
            }
          }

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
      const runtimeObserverUnsubscribers: Array<() => Promise<void>> = [];
      const runtimeObserverRootRunIds = new Set<string>();
      const rawSendFrame = (frame: OutboundFrame, source: 'response' | 'realtime') => {
        if (requestLogger) {
          requestLogger.info('ws.frame.sent', 'WebSocket frame sent', {
            requestId: request.id,
            remoteAddress: request.ip,
            source,
            ...summarizeOutboundFrameForLogging(frame),
          });
        }

        socket.send(serializeOutboundFrame(frame));
      };
      const sendResponseFrame = async (frame: OutboundFrame) => {
        const preparedFrame = await prepareResponseFrame(frame, {
          hooks: options.hooks,
          authContext: request.gatewayAuthContext,
          requestedChannelId: request.gatewayRequestedChannelId,
        });

        rawSendFrame(preparedFrame, 'response');
      };
      const emitFrame = async (frame: OutboundFrame) => {
        rawSendFrame(frame, 'realtime');
      };
      const registerRuntimeObserver = async (observer: RuntimeObserverRegistration) => {
        if (!options.agentRegistry) {
          return;
        }

        if (runtimeObserverRootRunIds.has(observer.rootRunId)) {
          return;
        }

        const agent = await options.agentRegistry.getAgent(observer.agentId);
        const unsubscribe = subscribeToForwardedRealtimeEvents(agent, {
          rootRunId: observer.rootRunId,
          fallbackAgentId: observer.agentId,
          fallbackSessionId: observer.sessionId,
          emitFrame: async (frame) => {
            const subscriptions = channelManager.getSubscriptions();
            if (subscriptions.length > 0 && !channelManager.matches(frame)) {
              return;
            }

            if (options.hooks) {
              await executeHookSlot(options.hooks, 'onAgentEvent', {
                slot: 'onAgentEvent',
                authContext: request.gatewayAuthContext,
                requestedChannelId: request.gatewayRequestedChannelId,
                frame,
              });
            }

            const preparedFrame = await prepareRealtimeFrame(frame, {
              hooks: options.hooks,
              authContext: request.gatewayAuthContext,
              requestedChannelId: request.gatewayRequestedChannelId,
            });
            if (preparedFrame) {
              await emitFrame(preparedFrame);
            }
          },
        });

        if (unsubscribe) {
          runtimeObserverRootRunIds.add(observer.rootRunId);
          runtimeObserverUnsubscribers.push(unsubscribe);
        }
      };

      socket.on('close', () => {
        for (const unsubscribe of runtimeObserverUnsubscribers.splice(0)) {
          void unsubscribe().catch(() => undefined);
        }
        runtimeObserverRootRunIds.clear();

        if (!options.hooks) {
          return;
        }

        void executeHookSlot(options.hooks, 'onDisconnect', {
          slot: 'onDisconnect',
          authContext: request.gatewayAuthContext,
          requestedChannelId: request.gatewayRequestedChannelId,
          remoteAddress: request.ip,
        }).catch(() => undefined);
      });

      socket.on('message', async (message: unknown) => {
        try {
          if (requestLogger) {
            logInboundWebSocketFrame(requestLogger, request.id, request.ip, message);
          }

          const postResponseTasks: Array<() => Promise<void>> = [];
          const frame = await handleGatewaySocketMessage(message, {
            gatewayConfig: config,
            agentRegistry: options.agentRegistry,
            authContext: request.gatewayAuthContext,
            hooks: options.hooks,
            requestedChannelId: request.gatewayRequestedChannelId,
            stores,
            channelManager,
            emitFrame,
            registerRuntimeObserver,
            hasRuntimeObserver: (rootRunId) => runtimeObserverRootRunIds.has(rootRunId),
            postResponseTasks,
            now: options.now,
            sessionIdFactory: options.sessionIdFactory,
            transcriptMessageIdFactory: options.transcriptMessageIdFactory,
          });

          await sendResponseFrame(frame);

          for (const task of postResponseTasks) {
            await task();
          }
        } catch (error) {
          await executeOnErrorHook(options.hooks, {
            authContext: request.gatewayAuthContext,
            requestedChannelId: request.gatewayRequestedChannelId,
            error,
          });
          rawSendFrame(createProtocolErrorFrame(normalizeProtocolValidationError(error)), 'response');
        }
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
    const emitRealtimeFrame = createRealtimeFrameEmitter(context);
    const realtimeRequestId = emitRealtimeFrame ? randomUUID() : undefined;

    if (frame.type === 'ping') {
      return createPongFrame(frame);
    }

    if (frame.type === 'session.open' && context.stores) {
      if (frame.sessionId) {
        if (context.hooks) {
          const session = await getAuthorizedGatewaySession(frame.sessionId, {
            authContext: context.authContext,
            stores: context.stores,
            requestType: frame.type,
            expectedChannelId: frame.channelId,
          });
          await executeSessionResolveHook(context.hooks, frame.type, session, context.authContext);
        }

        const reconnectState = await restoreActiveSession(frame.sessionId, {
          stores: context.stores,
          agentRegistry: context.agentRegistry,
          authContext: context.authContext,
          now: context.now,
        });

        context.channelManager?.subscribe(reconnectState.channels);

        if (context.postResponseTasks && emitRealtimeFrame) {
          context.postResponseTasks.push(async () => {
            await emitRealtimeFrame(reconnectState.sessionUpdated);
            if (reconnectState.recoveryFrame) {
              await emitRealtimeFrame(reconnectState.recoveryFrame);
            }
            if (reconnectState.pendingApproval && reconnectState.recoveryFrame?.type !== 'approval.requested') {
              await emitRealtimeFrame({
                type: 'approval.requested',
                runId: reconnectState.pendingApproval.runId,
                rootRunId: reconnectState.pendingApproval.rootRunId,
                sessionId: reconnectState.pendingApproval.sessionId,
              });
            }
            if (
              reconnectState.session.agentId &&
              reconnectState.session.currentRootRunId &&
              (reconnectState.policy === 'observer' ||
                reconnectState.policy === 'pending_approval' ||
                reconnectState.policy === 'pending_clarification')
            ) {
              await context.registerRuntimeObserver?.({
                agentId: reconnectState.session.agentId,
                rootRunId: reconnectState.session.currentRootRunId,
                sessionId: reconnectState.session.id,
              });
            }
          });
        }

        return reconnectState.sessionOpened;
      }

      const openedSession = await openGatewaySession(frame, {
        authContext: context.authContext,
        stores: context.stores,
        now: context.now,
        sessionIdFactory: context.sessionIdFactory,
      });

      if (context.hooks) {
        const session = await getAuthorizedGatewaySession(openedSession.sessionId, {
          authContext: context.authContext,
          stores: context.stores,
          requestType: frame.type,
          expectedChannelId: frame.channelId,
        });
        await executeSessionResolveHook(context.hooks, frame.type, session, context.authContext);
      }

      return openedSession;
    }

    if (frame.type === 'message.send' && context.stores && context.gatewayConfig && context.agentRegistry) {
      return await executeGatewayChatTurn(frame, {
        gatewayConfig: context.gatewayConfig,
        agentRegistry: context.agentRegistry,
        stores: context.stores,
        authContext: context.authContext,
        hooks: context.hooks,
        now: context.now,
        transcriptMessageIdFactory: context.transcriptMessageIdFactory,
        realtimeEvents:
          realtimeRequestId && emitRealtimeFrame
            ? {
                requestId: realtimeRequestId,
                emitFrame: emitRealtimeFrame,
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
        hooks: context.hooks,
        requestedChannelId: context.requestedChannelId,
        now: context.now,
        realtimeEvents:
          realtimeRequestId && emitRealtimeFrame
            ? {
                requestId: realtimeRequestId,
                emitFrame: emitRealtimeFrame,
              }
            : undefined,
      });
    }

    if (frame.type === 'run.retry' && context.stores && context.agentRegistry) {
      return await executeGatewayRunRetry(frame, {
        agentRegistry: context.agentRegistry,
        stores: context.stores,
        authContext: context.authContext,
        hooks: context.hooks,
        now: context.now,
        realtimeEvents: emitRealtimeFrame
          ? {
              rootRunId: frame.runId,
              emitFrame: emitRealtimeFrame,
            }
          : undefined,
        hasRuntimeObserver: context.hasRuntimeObserver,
      });
    }

    if (frame.type === 'approval.resolve' && context.stores && context.agentRegistry) {
      return await executeGatewayApprovalResolution(frame, {
        agentRegistry: context.agentRegistry,
        stores: context.stores,
        authContext: context.authContext,
        hooks: context.hooks,
        now: context.now,
        realtimeEvents: emitRealtimeFrame
          ? {
              rootRunId: frame.runId,
              emitFrame: emitRealtimeFrame,
            }
          : undefined,
        hasRuntimeObserver: context.hasRuntimeObserver,
      });
    }

    if (frame.type === 'clarification.resolve' && context.stores && context.agentRegistry) {
      return await executeGatewayClarificationResolution(frame, {
        agentRegistry: context.agentRegistry,
        stores: context.stores,
        authContext: context.authContext,
        hooks: context.hooks,
        now: context.now,
        realtimeEvents: emitRealtimeFrame
          ? {
              rootRunId: frame.runId,
              emitFrame: emitRealtimeFrame,
            }
          : undefined,
        hasRuntimeObserver: context.hasRuntimeObserver,
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
    await executeOnErrorHook(context.hooks, {
      authContext: context.authContext,
      requestedChannelId: context.requestedChannelId,
      error,
    });
    const protocolError = normalizeProtocolValidationError(error);

    return createProtocolErrorFrame(protocolError);
  }
}

function createRealtimeFrameEmitter(
  context: GatewaySocketMessageContext,
): ((frame: OutboundFrame) => Promise<void>) | undefined {
  if (!context.emitFrame) {
    return undefined;
  }

  const emitFrame = context.emitFrame;

  return async (frame: OutboundFrame) => {
    if (frame.type === 'agent.event') {
      const subscriptions = context.channelManager?.getSubscriptions() ?? [];
      if (subscriptions.length > 0 && !context.channelManager?.matches(frame)) {
        return;
      }

      if (context.hooks) {
        await executeHookSlot(context.hooks, 'onAgentEvent', {
          slot: 'onAgentEvent',
          authContext: context.authContext,
          requestedChannelId: context.requestedChannelId,
          frame,
        });
      }
    }

    const preparedFrame = await prepareRealtimeFrame(frame, context);
    if (!preparedFrame) {
      return;
    }

    await Promise.resolve(emitFrame(preparedFrame));
  };
}

async function prepareResponseFrame(
  frame: OutboundFrame,
  context: Pick<GatewaySocketMessageContext, 'hooks' | 'authContext' | 'requestedChannelId'>,
): Promise<OutboundFrame> {
  const preparedFrame = await prepareRealtimeFrame(frame, context);
  if (preparedFrame) {
    return preparedFrame;
  }

  return frame.type === 'error'
    ? frame
    : {
        type: 'error',
        code: 'invalid_frame',
        message: 'Gateway outbound delivery was rejected by a hook.',
        requestType: frame.type,
        details: {
          slot: 'beforeOutboundFrame',
        },
      };
}

async function prepareRealtimeFrame(
  frame: OutboundFrame,
  context: Pick<GatewaySocketMessageContext, 'hooks' | 'authContext' | 'requestedChannelId'>,
): Promise<OutboundFrame | undefined> {
  if (!context.hooks) {
    return frame;
  }

  const hookResult = await executeHookSlot(context.hooks, 'beforeOutboundFrame', {
    slot: 'beforeOutboundFrame',
    authContext: context.authContext,
    requestedChannelId: context.requestedChannelId,
    frame,
  });

  if (hookResult.rejected) {
    return undefined;
  }

  return frame;
}

async function executeSessionResolveHook(
  hooks: ResolvedGatewayHooks,
  requestType: string,
  session: { id: string; channelId: string; status: string },
  authContext?: GatewayAuthContext,
): Promise<void> {
  const hookResult = await executeHookSlot(hooks, 'onSessionResolve', {
    slot: 'onSessionResolve',
    authContext,
    requestType,
    session,
  });

  if (hookResult.rejected) {
    throw new ProtocolValidationError(
      'invalid_frame',
      hookResult.rejectionReason ?? 'Session resolution was rejected by a hook.',
      {
        requestType,
        details: {
          sessionId: session.id,
          channelId: session.channelId,
          slot: 'onSessionResolve',
        },
      },
    );
  }
}

async function executeOnErrorHook(
  hooks: ResolvedGatewayHooks | undefined,
  context: Pick<GatewaySocketMessageContext, 'authContext' | 'requestedChannelId'> & { error: unknown },
): Promise<void> {
  if (!hooks) {
    return;
  }

  await executeHookSlot(hooks, 'onError', {
    slot: 'onError',
    authContext: context.authContext,
    requestedChannelId: context.requestedChannelId,
    error: context.error,
  }).catch(() => undefined);
}

function logInboundWebSocketFrame(logger: GatewayLogger, requestId: string, remoteAddress: string, message: unknown): void {
  try {
    const frame = parseInboundFrame(message);

    logger.info('ws.frame.received', 'WebSocket frame received', {
      requestId,
      remoteAddress,
      ...summarizeInboundFrameForLogging(frame),
    });
  } catch (error) {
    const protocolError = normalizeProtocolValidationError(error);

    logger.warn('ws.frame.rejected', 'WebSocket frame rejected', {
      requestId,
      remoteAddress,
      code: protocolError.code,
      ...(protocolError.requestType ? { requestType: protocolError.requestType } : {}),
      ...(protocolError.details ? { details: protocolError.details } : {}),
    });
  }
}

function summarizeInboundFrameForLogging(frame: InboundFrame): JsonObject {
  switch (frame.type) {
    case 'session.open':
      return {
        frameType: frame.type,
        ...(frame.sessionId ? { sessionId: frame.sessionId } : {}),
        channelId: frame.channelId,
        hasMetadata: frame.metadata !== undefined,
      };
    case 'message.send':
      return {
        frameType: frame.type,
        sessionId: frame.sessionId,
        contentLength: frame.content.length,
        hasMetadata: frame.metadata !== undefined,
      };
    case 'run.start':
      return {
        frameType: frame.type,
        ...(frame.sessionId ? { sessionId: frame.sessionId } : {}),
        ...(frame.agentId ? { agentId: frame.agentId } : {}),
        goalLength: frame.goal.length,
        hasInput: frame.input !== undefined,
        hasContext: frame.context !== undefined,
        hasMetadata: frame.metadata !== undefined,
      };
    case 'run.retry':
      return {
        frameType: frame.type,
        sessionId: frame.sessionId,
        runId: frame.runId,
        hasMetadata: frame.metadata !== undefined,
      };
    case 'approval.resolve':
      return {
        frameType: frame.type,
        sessionId: frame.sessionId,
        runId: frame.runId,
        approved: frame.approved,
        hasMetadata: frame.metadata !== undefined,
      };
    case 'clarification.resolve':
      return {
        frameType: frame.type,
        sessionId: frame.sessionId,
        runId: frame.runId,
        messageLength: frame.message.length,
        hasMetadata: frame.metadata !== undefined,
      };
    case 'channel.subscribe':
      return {
        frameType: frame.type,
        channelCount: frame.channels.length,
        channels: frame.channels,
      };
    case 'session.close':
      return {
        frameType: frame.type,
        sessionId: frame.sessionId,
      };
    case 'ping':
      return {
        frameType: frame.type,
        ...(frame.id ? { pingId: frame.id } : {}),
      };
  }
}

function summarizeOutboundFrameForLogging(frame: OutboundFrame): JsonObject {
  switch (frame.type) {
    case 'session.opened':
      return {
        frameType: frame.type,
        sessionId: frame.sessionId,
        channelId: frame.channelId,
        ...(frame.agentId ? { agentId: frame.agentId } : {}),
        ...(frame.invocationMode ? { invocationMode: frame.invocationMode } : {}),
        status: frame.status,
      };
    case 'session.updated':
      return {
        frameType: frame.type,
        sessionId: frame.sessionId,
        status: frame.status,
        ...(frame.invocationMode ? { invocationMode: frame.invocationMode } : {}),
        transcriptVersion: frame.transcriptVersion,
        ...(frame.activeRunId ? { activeRunId: frame.activeRunId } : {}),
        ...(frame.activeRootRunId ? { activeRootRunId: frame.activeRootRunId } : {}),
      };
    case 'agent.event':
      return {
        frameType: frame.type,
        eventType: frame.eventType,
        ...(frame.sessionId ? { sessionId: frame.sessionId } : {}),
        ...(frame.agentId ? { agentId: frame.agentId } : {}),
        ...(frame.runId ? { runId: frame.runId } : {}),
        ...(frame.rootRunId ? { rootRunId: frame.rootRunId } : {}),
        ...(frame.parentRunId ? { parentRunId: frame.parentRunId } : {}),
      };
    case 'message.output':
      return {
        frameType: frame.type,
        sessionId: frame.sessionId,
        ...(frame.runId ? { runId: frame.runId } : {}),
        ...(frame.rootRunId ? { rootRunId: frame.rootRunId } : {}),
        contentLength: frame.message.content.length,
      };
    case 'run.output':
      return {
        frameType: frame.type,
        runId: frame.runId,
        ...(frame.rootRunId ? { rootRunId: frame.rootRunId } : {}),
        ...(frame.sessionId ? { sessionId: frame.sessionId } : {}),
        status: frame.status,
        hasOutput: frame.output !== undefined,
        hasError: frame.error !== undefined,
      };
    case 'approval.requested':
      return {
        frameType: frame.type,
        runId: frame.runId,
        rootRunId: frame.rootRunId,
        ...(frame.sessionId ? { sessionId: frame.sessionId } : {}),
        ...(frame.toolName ? { toolName: frame.toolName } : {}),
        hasReason: frame.reason !== undefined,
      };
    case 'error':
      return {
        frameType: frame.type,
        code: frame.code,
        ...(frame.requestType ? { requestType: frame.requestType } : {}),
        hasDetails: frame.details !== undefined,
      };
    case 'pong':
      return {
        frameType: frame.type,
        ...(frame.id ? { pingId: frame.id } : {}),
      };
  }
}

function normalizeProtocolValidationError(error: unknown): ProtocolValidationError {
  return error instanceof ProtocolValidationError
    ? error
    : error instanceof Error
      ? new ProtocolValidationError('invalid_frame', error.message)
      : new ProtocolValidationError('invalid_frame', 'Unexpected WebSocket protocol error.');
}

function sanitizeLoggedUrl(url: string): string {
  const parsedUrl = new URL(url, 'http://gateway.local');
  if (!parsedUrl.searchParams.has('access_token')) {
    return url;
  }

  parsedUrl.searchParams.set('access_token', '[REDACTED]');
  const sanitizedSearch = parsedUrl.searchParams.toString();
  return `${parsedUrl.pathname}${sanitizedSearch ? `?${sanitizedSearch}` : ''}`;
}
