import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { join } from 'node:path';

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';

import type { AgentRegistry } from './agent-registry.js';
import {
  GatewayAuthError,
  authenticateGatewayHttpRequest,
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
import { resolveGatewayRequestLogLevel, resolveGatewayRequestLoggerEnabled, type GatewayConfig } from './config.js';
import type { JsonObject, JsonValue, RuntimeRunRecord, RuntimeRunStore } from './core.js';
import {
  DashboardDeleteConflictError,
  deleteDashboardEmptySessions,
  deleteDashboardSession,
  deleteDashboardSessionlessRun,
  listDashboardRootRuns,
  loadDashboardRunTrace,
  type DashboardRunListFilters,
  type DashboardRunSort,
  type DashboardSessionFilter,
} from './dashboard-runs.js';
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
import { executeGatewayApprovalResolution, executeGatewayClarificationResolution, executeGatewayRunContinue, executeGatewayRunRetry, executeGatewayRunStart } from './run.js';
import { createGatewayLogger, type GatewayLogger } from './observability.js';
import { subscribeToForwardedRealtimeEvents } from './realtime-events.js';
import { getAuthorizedGatewaySession, openGatewaySession } from './session.js';
import { createInMemoryGatewayStores, type GatewayStores } from './stores.js';
import type { PostgresClient } from './stores-postgres.js';
import type { MessageView } from './trace-session/types.js';
import {
  MAX_GATEWAY_IMAGE_UPLOAD_BYTES,
  MAX_GATEWAY_IMAGE_UPLOAD_FILES,
  registerGatewayImageUploadRoutes,
} from './uploads.js';

export interface CreateGatewayServerOptions {
  fastify?: FastifyServerOptions;
  auth?: ResolvedGatewayAuthProvider;
  hooks?: ResolvedGatewayHooks;
  agentRegistry?: AgentRegistry;
  stores?: GatewayStores;
  traceClient?: PostgresClient;
  requestLogger?: GatewayLogger;
  imageUploadDir?: string;
  now?: () => Date;
  sessionIdFactory?: () => string;
  transcriptMessageIdFactory?: () => string;
  staleLeaseHeartbeatBefore?: Date;
}

export interface GatewaySocketMessageContext {
  gatewayConfig?: GatewayConfig;
  agentRegistry?: AgentRegistry;
  authContext?: GatewayAuthContext;
  hooks?: ResolvedGatewayHooks;
  requestedChannelId?: string;
  stores?: GatewayStores;
  imageUploadDir?: string;
  channelManager?: ChannelSubscriptionManager;
  emitFrame?: (frame: OutboundFrame) => Promise<void> | void;
  registerRuntimeObserver?: (observer: RuntimeObserverRegistration) => Promise<void>;
  hasRuntimeObserver?: (rootRunId: string) => boolean;
  postResponseTasks?: Array<() => Promise<void>>;
  now?: () => Date;
  sessionIdFactory?: () => string;
  transcriptMessageIdFactory?: () => string;
  staleLeaseHeartbeatBefore?: Date;
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
  const imageUploadDir = options.imageUploadDir ?? join(process.cwd(), 'data', 'gateway', 'uploads', 'images');
  const activeWebSocketConnections = new Set<Socket>();
  const requestLogLevel = resolveGatewayRequestLogLevel(config.server.requestLogging);
  const requestLogger = options.requestLogger
    ?? (requestLogLevel
      ? createGatewayLogger({
          destination: config.server.requestLoggingDestination,
          level: requestLogLevel,
        })
      : undefined);
  const shouldCloseRequestLogger = options.requestLogger === undefined && requestLogger !== undefined;
  const shouldLogHttpRequests = requestLogger !== undefined && resolveGatewayRequestLoggerEnabled(config.server);

  if (requestLogger) {
    const requestStartTimes = new WeakMap<object, bigint>();

    if (shouldCloseRequestLogger) {
      app.addHook('onClose', async () => {
        await requestLogger.close();
      });
    }

    if (shouldLogHttpRequests) {
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
  }

  app.addHook('onClose', async () => {
    await closeActiveWebSocketConnections(activeWebSocketConnections);
  });

  await app.register(multipart, {
    limits: {
      files: MAX_GATEWAY_IMAGE_UPLOAD_FILES,
      fileSize: MAX_GATEWAY_IMAGE_UPLOAD_BYTES,
    },
  });
  registerGatewayImageUploadRoutes(app, {
    auth: options.auth,
    uploadDir: imageUploadDir,
  });

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
      const connection = request.raw.socket;
      const channelManager = createChannelSubscriptionManager();
      const runtimeObserverUnsubscribers: Array<() => Promise<void>> = [];
      const runtimeObserverRootRunIds = new Set<string>();
      const unregisterConnection = () => {
        connection.off('close', unregisterConnection);
        activeWebSocketConnections.delete(connection);
      };
      activeWebSocketConnections.add(connection);
      connection.once('close', unregisterConnection);
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
        unregisterConnection();
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
            imageUploadDir,
            channelManager,
            emitFrame,
            registerRuntimeObserver,
            hasRuntimeObserver: (rootRunId) => runtimeObserverRootRunIds.has(rootRunId),
            postResponseTasks,
            now: options.now,
            sessionIdFactory: options.sessionIdFactory,
            transcriptMessageIdFactory: options.transcriptMessageIdFactory,
            staleLeaseHeartbeatBefore: options.staleLeaseHeartbeatBefore,
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

  registerDashboardRunRoutes(app, {
    auth: options.auth,
    stores,
    agentRegistry: options.agentRegistry,
    gatewayConfig: config,
    hooks: options.hooks,
    traceClient: options.traceClient,
    now: options.now,
  });

  if (config.server.healthPath) {
    app.get(config.server.healthPath, async () => ({
      status: 'ok',
      websocketPath: config.server.websocketPath,
    }));
  }

  const statusHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const authContext = await authenticateGatewayHttpRequest({
        auth: options.auth,
        headers: request.headers,
      });

      if (!authContext) {
        throw new GatewayAuthError('auth_required', 'Gateway status requires an authenticated admin principal.', {
          statusCode: 401,
        });
      }

      if (!authContext.roles.includes('admin')) {
        throw new GatewayAuthError('session_forbidden', 'Gateway status requires the admin role.', {
          statusCode: 403,
          details: { requiredRole: 'admin' },
        });
      }

      return await buildGatewayStatusReport(stores, options.now);
    } catch (error) {
      if (error instanceof GatewayAuthError) {
        return reply.code(error.statusCode).send(createAuthErrorFrame(error));
      }

      throw error;
    }
  };

  app.get('/status', statusHandler);

  return app;
}

async function closeActiveWebSocketConnections(connections: ReadonlySet<Socket>): Promise<void> {
  if (connections.size === 0) {
    return;
  }

  await Promise.allSettled(Array.from(connections, (connection) => closeActiveWebSocketConnection(connection)));
}

async function closeActiveWebSocketConnection(connection: Socket): Promise<void> {
  if (connection.destroyed) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      connection.off('close', finish);
      resolve();
    };

    connection.once('close', finish);
    connection.end();
    timeoutId = setTimeout(() => {
      if (!connection.destroyed) {
        connection.destroy();
      }
      finish();
    }, 250);
  });
}

interface DashboardRunRouteContext {
  auth?: ResolvedGatewayAuthProvider;
  stores: GatewayStores;
  agentRegistry?: AgentRegistry;
  gatewayConfig: GatewayConfig;
  hooks?: ResolvedGatewayHooks;
  traceClient?: PostgresClient;
  now?: () => Date;
}

class DashboardRouteInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DashboardRouteInputError';
  }
}

function registerDashboardRunRoutes(app: FastifyInstance, context: DashboardRunRouteContext): void {
  app.get<{ Querystring: Record<string, string | string[] | undefined> }>('/api/runs', async (request, reply) => {
    const authContext = await requireGatewayAdminHttpRequest(request, reply, context.auth);
    if (!authContext) {
      return reply;
    }
    if (!context.traceClient) {
      return reply.code(503).send(createGatewayHttpError('trace_store_unavailable', 'Persisted run dashboard routes require PostgreSQL runtime stores.'));
    }

    try {
      return await listDashboardRootRuns(context.traceClient, parseDashboardRunListFilters(request.query));
    } catch (error) {
      if (error instanceof DashboardRouteInputError) {
        return reply.code(400).send(createGatewayHttpError('invalid_frame', error.message));
      }
      throw error;
    }
  });

  app.delete('/api/sessions/empty', async (request, reply) => {
    const authContext = await requireGatewayAdminHttpRequest(request, reply, context.auth);
    if (!authContext) {
      return reply;
    }
    if (!context.traceClient) {
      return reply.code(503).send(createGatewayHttpError('trace_store_unavailable', 'Persisted session delete routes require PostgreSQL stores.'));
    }

    return await deleteDashboardEmptySessions(context.traceClient);
  });

  app.delete<{ Params: { sessionId: string } }>('/api/sessions/:sessionId', async (request, reply) => {
    const authContext = await requireGatewayAdminHttpRequest(request, reply, context.auth);
    if (!authContext) {
      return reply;
    }
    if (!context.traceClient) {
      return reply.code(503).send(createGatewayHttpError('trace_store_unavailable', 'Persisted session delete routes require PostgreSQL stores.'));
    }

    try {
      return await deleteDashboardSession(context.traceClient, request.params.sessionId);
    } catch (error) {
      if (error instanceof DashboardDeleteConflictError) {
        return reply.code(409).send(createGatewayHttpError(error.code, error.message, error.details));
      }
      throw error;
    }
  });

  app.get<{
    Params: { rootRunId: string };
    Querystring: Record<string, string | string[] | undefined>;
  }>('/api/runs/:rootRunId', async (request, reply) => {
    const authContext = await requireGatewayAdminHttpRequest(request, reply, context.auth);
    if (!authContext) {
      return reply;
    }
    if (!context.traceClient) {
      return reply.code(503).send(createGatewayHttpError('trace_store_unavailable', 'Persisted run trace routes require PostgreSQL runtime stores.'));
    }

    try {
      return await loadDashboardRunTrace(context.traceClient, request.params.rootRunId, parseDashboardTraceOptions(request.query));
    } catch (error) {
      if (error instanceof DashboardRouteInputError) {
        return reply.code(400).send(createGatewayHttpError('invalid_frame', error.message));
      }
      throw error;
    }
  });

  app.delete<{ Params: { rootRunId: string } }>('/api/runs/:rootRunId', async (request, reply) => {
    const authContext = await requireGatewayAdminHttpRequest(request, reply, context.auth);
    if (!authContext) {
      return reply;
    }
    if (!context.traceClient) {
      return reply.code(503).send(createGatewayHttpError('trace_store_unavailable', 'Persisted run delete routes require PostgreSQL runtime stores.'));
    }

    try {
      return await deleteDashboardSessionlessRun(context.traceClient, request.params.rootRunId);
    } catch (error) {
      if (error instanceof DashboardDeleteConflictError) {
        return reply.code(409).send(createGatewayHttpError(error.code, error.message, error.details));
      }
      throw error;
    }
  });

  app.get<{
    Params: { rootRunId: string };
    Querystring: Record<string, string | string[] | undefined>;
  }>('/api/runs/:rootRunId/messages', async (request, reply) => {
    const authContext = await requireGatewayAdminHttpRequest(request, reply, context.auth);
    if (!authContext) {
      return reply;
    }
    if (!context.traceClient) {
      return reply.code(503).send(createGatewayHttpError('trace_store_unavailable', 'Persisted run trace routes require PostgreSQL runtime stores.'));
    }

    try {
      const report = await loadDashboardRunTrace(context.traceClient, request.params.rootRunId, {
        ...parseDashboardTraceOptions(request.query),
        messages: true,
        includePlans: false,
      });
      return {
        target: report.target,
        warnings: report.warnings,
        messages: report.llmMessages,
      };
    } catch (error) {
      if (error instanceof DashboardRouteInputError) {
        return reply.code(400).send(createGatewayHttpError('invalid_frame', error.message));
      }
      throw error;
    }
  });

  app.get<{ Params: { rootRunId: string } }>('/api/runs/:rootRunId/timeline', async (request, reply) => {
    const authContext = await requireGatewayAdminHttpRequest(request, reply, context.auth);
    if (!authContext) {
      return reply;
    }
    if (!context.traceClient) {
      return reply.code(503).send(createGatewayHttpError('trace_store_unavailable', 'Persisted run trace routes require PostgreSQL runtime stores.'));
    }

    const report = await loadDashboardRunTrace(context.traceClient, request.params.rootRunId, {
      messages: false,
      includePlans: false,
    });
    return {
      target: report.target,
      warnings: report.warnings,
      timeline: report.timeline,
    };
  });

  app.get<{ Params: { rootRunId: string } }>('/api/runs/:rootRunId/plans', async (request, reply) => {
    const authContext = await requireGatewayAdminHttpRequest(request, reply, context.auth);
    if (!authContext) {
      return reply;
    }
    if (!context.traceClient) {
      return reply.code(503).send(createGatewayHttpError('trace_store_unavailable', 'Persisted run trace routes require PostgreSQL runtime stores.'));
    }

    const report = await loadDashboardRunTrace(context.traceClient, request.params.rootRunId, {
      messages: false,
      includePlans: true,
    });
    return {
      target: report.target,
      warnings: report.warnings,
      plans: report.plans,
    };
  });

  app.post<{ Params: { runId: string }; Body: { approved?: unknown; metadata?: JsonObject } }>('/api/runs/:runId/approval', async (request, reply) => {
    const authContext = await requireGatewayAdminHttpRequest(request, reply, context.auth);
    if (!authContext) {
      return reply;
    }
    if (!context.agentRegistry) {
      return reply.code(503).send(createGatewayHttpError('agent_registry_unavailable', 'Approval resolution requires an agent registry.'));
    }
    if (typeof request.body?.approved !== 'boolean') {
      return reply.code(400).send(createGatewayHttpError('invalid_frame', 'Request body must include boolean field "approved".'));
    }

    const link = await resolveDashboardApprovalSessionLink(request.params.runId, context);
    if (!link) {
      return reply.code(409).send(createGatewayHttpError(
        'approval_session_unavailable',
        `No gateway run session is linked to run "${request.params.runId}". Sessionless approval resolution is not available through the gateway dashboard yet.`,
      ));
    }

    try {
      return await executeGatewayApprovalResolution({
        type: 'approval.resolve',
        sessionId: link.sessionId,
        runId: request.params.runId,
        approved: request.body.approved,
        metadata: request.body.metadata,
      }, {
        gatewayConfig: context.gatewayConfig,
        agentRegistry: context.agentRegistry,
        stores: context.stores,
        authContext,
        hooks: context.hooks,
        now: context.now,
      });
    } catch (error) {
      if (error instanceof ProtocolValidationError) {
        return reply.code(error.code === 'session_forbidden' ? 403 : 409).send(createGatewayHttpError(error.code, error.message, error.details));
      }
      throw error;
    }
  });

  app.post<{ Params: { rootRunId: string } }>('/api/runs/:rootRunId/replay', async (request, reply) => {
    const authContext = await requireGatewayAdminHttpRequest(request, reply, context.auth);
    if (!authContext) {
      return reply;
    }
    if (!context.agentRegistry) {
      return reply.code(503).send(createGatewayHttpError('agent_registry_unavailable', 'Run replay requires an agent registry.'));
    }

    const links = await context.stores.sessionRunLinks.listByRootRunId(request.params.rootRunId);
    const latestRunLink = links.filter((link) => link.invocationKind === 'run').at(-1);
    if (!latestRunLink) {
      return reply.code(409).send(createGatewayHttpError(
        'replay_session_unavailable',
        `No gateway run session is linked to root run "${request.params.rootRunId}". Replay is not available from the dashboard for sessionless runs.`,
      ));
    }

    try {
      const reconnectState = await restoreActiveSession(latestRunLink.sessionId, {
        stores: context.stores,
        agentRegistry: context.agentRegistry,
        authContext,
        now: context.now,
        staleLeaseHeartbeatBefore: context.staleLeaseHeartbeatBefore,
      });
      return {
        sessionId: reconnectState.session.id,
        rootRunId: reconnectState.session.currentRootRunId ?? latestRunLink.rootRunId ?? request.params.rootRunId,
        runId: reconnectState.session.currentRunId ?? latestRunLink.runId ?? null,
        status: reconnectState.session.status,
        policy: reconnectState.policy,
        replayedFrameType: reconnectState.recoveryFrame?.type ?? null,
        pendingApproval: reconnectState.pendingApproval ?? null,
      };
    } catch (error) {
      if (error instanceof ProtocolValidationError) {
        return reply.code(error.code === 'session_forbidden' ? 403 : 409).send(createGatewayHttpError(error.code, error.message, error.details));
      }
      throw error;
    }
  });

  app.post<{ Params: { runId: string } }>('/api/runs/:runId/retry', async (request, reply) => {
    const authContext = await requireGatewayAdminHttpRequest(request, reply, context.auth);
    if (!authContext) {
      return reply;
    }
    if (!context.agentRegistry) {
      return reply.code(503).send(createGatewayHttpError('agent_registry_unavailable', 'Run retry requires an agent registry.'));
    }

    try {
      return await executeGatewayRunRetry({
        type: 'run.retry',
        runId: request.params.runId,
        metadata: {
          source: 'dashboard',
        },
      }, {
        gatewayConfig: context.gatewayConfig,
        agentRegistry: context.agentRegistry,
        stores: context.stores,
        authContext,
        hooks: context.hooks,
        now: context.now,
      });
    } catch (error) {
      if (error instanceof ProtocolValidationError) {
        return reply.code(error.code === 'session_forbidden' ? 403 : 409).send(createGatewayHttpError(error.code, error.message, error.details));
      }
      throw error;
    }
  });

  app.post<{ Params: { runId: string } }>('/api/runs/:runId/interrupt', async (request, reply) => {
    const authContext = await requireGatewayAuthenticatedHttpRequest(request, reply, context.auth, 'Run interrupt');
    if (!authContext) {
      return reply;
    }
    if (!context.agentRegistry) {
      return reply.code(503).send(createGatewayHttpError('agent_registry_unavailable', 'Run interrupt requires an agent registry.'));
    }

    try {
      await assertRunActionAuthorized(request.params.runId, authContext, context, 'interrupt');
      const agent = await resolveAgentForRun(request.params.runId, context);
      if (!agent.agent.interrupt) {
        return reply.code(409).send(createGatewayHttpError('unsupported_action', `Agent does not support interrupt for run "${request.params.runId}".`));
      }
      await agent.agent.interrupt(request.params.runId);
      return { runId: request.params.runId, status: 'interrupted' };
    } catch (error) {
      if (error instanceof AgentResolutionError) {
        return reply.code(error.statusCode).send(createGatewayHttpError(error.code, error.message, error.details));
      }
      if (error instanceof ProtocolValidationError) {
        return reply.code(error.code === 'session_forbidden' ? 403 : 409).send(createGatewayHttpError(error.code, error.message, error.details));
      }
      if (error instanceof GatewayAuthError) {
        return reply.code(error.statusCode).send(createAuthErrorFrame(error));
      }
      throw error;
    }
  });

  app.post<{ Params: { runId: string }; Querystring: { mode?: string }; Body: { message?: unknown; role?: unknown; metadata?: JsonObject } }>('/api/runs/:runId/steer', async (request, reply) => {
    const authContext = await requireGatewayAuthenticatedHttpRequest(request, reply, context.auth, 'Run steer');
    if (!authContext) {
      return reply;
    }
    if (!context.agentRegistry) {
      return reply.code(503).send(createGatewayHttpError('agent_registry_unavailable', 'Run steer requires an agent registry.'));
    }
    const message = request.body?.message;
    if (typeof message !== 'string' || message.trim() === '') {
      return reply.code(400).send(createGatewayHttpError('invalid_frame', 'Request body must include a non-empty string field "message".'));
    }
    const rawRole = request.body?.role;
    let role: 'user' | 'system' | undefined;
    if (rawRole !== undefined) {
      if (rawRole !== 'user' && rawRole !== 'system') {
        return reply.code(400).send(createGatewayHttpError('invalid_frame', 'Field "role" must be "user" or "system" when provided.'));
      }
      role = rawRole;
    }

    const mode = request.query.mode ?? 'leaf';
    if (mode !== 'exact' && mode !== 'leaf') {
      return reply.code(400).send(createGatewayHttpError('invalid_frame', 'Steer mode must be "exact" or "leaf".'));
    }

    try {
      await assertRunActionAuthorized(request.params.runId, authContext, context, 'steer');
      const agent = await resolveAgentForRun(request.params.runId, context);
      if (!agent.agent.steer) {
        return reply.code(409).send(createGatewayHttpError('unsupported_action', `Agent does not support steer for run "${request.params.runId}".`));
      }
      const resolved = await resolveSteerTargetForRun(request.params.runId, mode, agent.runtime.runStore);
      await agent.agent.steer(resolved.resolvedTargetRunId, {
        message,
        ...(role ? { role } : {}),
        ...(request.body?.metadata ? { metadata: request.body.metadata } : {}),
      });
      return {
        status: 'steered',
        requestedRunId: request.params.runId,
        resolvedTargetRunId: resolved.resolvedTargetRunId,
        resolution: mode,
        role: role ?? 'user',
      };
    } catch (error) {
      if (error instanceof AgentResolutionError) {
        return reply.code(error.statusCode).send(createGatewayHttpError(error.code, error.message, error.details));
      }
      if (error instanceof ProtocolValidationError) {
        return reply.code(error.code === 'session_forbidden' ? 403 : 409).send(createGatewayHttpError(error.code, error.message, error.details));
      }
      if (error instanceof GatewayAuthError) {
        return reply.code(error.statusCode).send(createAuthErrorFrame(error));
      }
      if (error instanceof SteerResolutionError) {
        return reply.code(error.statusCode).send(createGatewayHttpError(error.code, error.message, error.details));
      }
      if (error instanceof Error && /requires an active run/.test(error.message)) {
        return reply.code(409).send(createGatewayHttpError('run_not_active', error.message));
      }
      throw error;
    }
  });

  app.post<{ Params: { sessionId: string }; Body: { message?: unknown; role?: unknown; metadata?: JsonObject } }>('/api/sessions/:sessionId/steer', async (request, reply) => {
    const authContext = await requireGatewayAuthenticatedHttpRequest(request, reply, context.auth, 'Session steer');
    if (!authContext) {
      return reply;
    }
    if (!context.agentRegistry) {
      return reply.code(503).send(createGatewayHttpError('agent_registry_unavailable', 'Session steer requires an agent registry.'));
    }
    const message = request.body?.message;
    if (typeof message !== 'string' || message.trim() === '') {
      return reply.code(400).send(createGatewayHttpError('invalid_frame', 'Request body must include a non-empty string field "message".'));
    }
    const rawRole = request.body?.role;
    let role: 'user' | 'system' | undefined;
    if (rawRole !== undefined) {
      if (rawRole !== 'user' && rawRole !== 'system') {
        return reply.code(400).send(createGatewayHttpError('invalid_frame', 'Field "role" must be "user" or "system" when provided.'));
      }
      role = rawRole;
    }

    try {
      const session = await getAuthorizedGatewaySession(request.params.sessionId, {
        stores: context.stores,
        authContext,
        requestedChannelId: undefined,
      });
      const agent = session.agentId && context.agentRegistry.has(session.agentId)
        ? await context.agentRegistry.getAgent(session.agentId)
        : await resolveAgentForRun(session.currentRunId ?? session.currentRootRunId ?? '', context);
      if (!agent.agent.steer) {
        return reply.code(409).send(createGatewayHttpError('unsupported_action', `Agent does not support steer for session "${request.params.sessionId}".`));
      }
      const resolved = await resolveSteerTargetForSession(session.id, context, agent.runtime.runStore);
      await agent.agent.steer(resolved.resolvedTargetRunId, {
        message,
        ...(role ? { role } : {}),
        ...(request.body?.metadata ? { metadata: request.body.metadata } : {}),
      });
      return {
        status: 'steered',
        sessionId: session.id,
        requestedRunId: resolved.requestedRunId,
        resolvedTargetRunId: resolved.resolvedTargetRunId,
        resolution: 'session-active',
        role: role ?? 'user',
      };
    } catch (error) {
      if (error instanceof AgentResolutionError) {
        return reply.code(error.statusCode).send(createGatewayHttpError(error.code, error.message, error.details));
      }
      if (error instanceof ProtocolValidationError) {
        return reply.code(error.code === 'session_forbidden' ? 403 : 409).send(createGatewayHttpError(error.code, error.message, error.details));
      }
      if (error instanceof GatewayAuthError) {
        return reply.code(error.statusCode).send(createAuthErrorFrame(error));
      }
      if (error instanceof SteerResolutionError) {
        return reply.code(error.statusCode).send(createGatewayHttpError(error.code, error.message, error.details));
      }
      if (error instanceof Error && /requires an active run/.test(error.message)) {
        return reply.code(409).send(createGatewayHttpError('run_not_active', error.message));
      }
      throw error;
    }
  });
}

class AgentResolutionError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: JsonObject;
  constructor(code: string, message: string, statusCode: number, details?: JsonObject) {
    super(message);
    this.name = 'AgentResolutionError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

class SteerResolutionError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: JsonObject;
  constructor(code: string, message: string, statusCode: number, details?: JsonObject) {
    super(message);
    this.name = 'SteerResolutionError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

type SteerResolutionMode = 'exact' | 'leaf' | 'session-active';

interface ResolvedSteerTarget {
  requestedRunId: string;
  resolvedTargetRunId: string;
  resolution: SteerResolutionMode;
}

const STEER_ALLOWED_RUN_STATUSES = new Set(['running', 'planning', 'queued']);
const STEER_TERMINAL_RUN_STATUSES = new Set(['interrupted', 'succeeded', 'failed', 'replan_required', 'cancelled']);

async function resolveSteerTargetForRun(
  runId: string,
  mode: 'exact' | 'leaf',
  runStore: RuntimeRunStore,
): Promise<ResolvedSteerTarget> {
  const run = await requireRuntimeRun(runId, runStore);
  if (mode === 'exact') {
    assertExactSteerable(run);
    return { requestedRunId: runId, resolvedTargetRunId: run.id, resolution: 'exact' };
  }

  const leaf = await resolveActiveLeafRun(run, runStore);
  return { requestedRunId: runId, resolvedTargetRunId: leaf.id, resolution: 'leaf' };
}

async function resolveSteerTargetForSession(
  sessionId: string,
  context: DashboardRunRouteContext,
  runStore: RuntimeRunStore,
): Promise<ResolvedSteerTarget> {
  const session = await context.stores.sessions.get(sessionId);
  if (!session) {
    throw new SteerResolutionError('session_not_found', `Session "${sessionId}" does not exist.`, 404, { sessionId });
  }

  const candidateIds = new Set<string>();
  if (session.currentRunId) {
    candidateIds.add(session.currentRunId);
  }
  if (session.currentRootRunId) {
    candidateIds.add(session.currentRootRunId);
  }
  const links = await context.stores.sessionRunLinks.listBySession(sessionId);
  for (const link of links) {
    candidateIds.add(link.runId);
    candidateIds.add(link.rootRunId);
  }

  const activeRuns: RuntimeRunRecord[] = [];
  for (const candidateId of candidateIds) {
    const candidate = await runStore.getRun(candidateId);
    if (candidate && (STEER_ALLOWED_RUN_STATUSES.has(candidate.status) || candidate.status === 'awaiting_subagent')) {
      activeRuns.push(candidate);
    }
  }

  const requestedRuns = activeRuns.filter((run) => !run.parentRunId || !activeRuns.some((candidate) => candidate.id === run.parentRunId));
  if (requestedRuns.length !== 1) {
    throw new SteerResolutionError(
      'ambiguous_session_active_run',
      `Session "${sessionId}" does not have exactly one active run to steer.`,
      409,
      { sessionId, activeRunIds: requestedRuns.map((run) => run.id) },
    );
  }

  const leaf = await resolveActiveLeafRun(requestedRuns[0]!, runStore);
  return { requestedRunId: requestedRuns[0]!.id, resolvedTargetRunId: leaf.id, resolution: 'session-active' };
}

async function resolveActiveLeafRun(run: RuntimeRunRecord, runStore: RuntimeRunStore): Promise<RuntimeRunRecord> {
  let current = run;
  const seen = new Set<string>();
  while (current.status === 'awaiting_subagent') {
    if (!current.currentChildRunId) {
      throw new SteerResolutionError('missing_current_child_run', `Run "${current.id}" is awaiting a subagent but has no currentChildRunId.`, 409, { runId: current.id });
    }
    if (seen.has(current.id)) {
      throw new SteerResolutionError('cyclic_child_run', `Run hierarchy under "${run.id}" contains a cycle.`, 409, { runId: current.id });
    }
    seen.add(current.id);
    current = await requireRuntimeRun(current.currentChildRunId, runStore);
  }
  assertLeafSteerable(current);
  return current;
}

async function requireRuntimeRun(runId: string, runStore: RuntimeRunStore): Promise<RuntimeRunRecord> {
  const run = await runStore.getRun(runId);
  if (!run) {
    throw new SteerResolutionError('run_not_found', `Run "${runId}" does not exist.`, 404, { runId });
  }
  return run;
}

function assertExactSteerable(run: RuntimeRunRecord): void {
  if (run.status === 'awaiting_approval') {
    throw new SteerResolutionError('run_awaiting_approval', `Run "${run.id}" is awaiting approval; use the approval flow instead of steer.`, 409, { runId: run.id, status: run.status });
  }
  if (run.status === 'clarification_requested') {
    throw new SteerResolutionError('run_clarification_requested', `Run "${run.id}" requested clarification; use the clarification flow instead of steer.`, 409, { runId: run.id, status: run.status });
  }
  if (STEER_TERMINAL_RUN_STATUSES.has(run.status)) {
    throw new SteerResolutionError('run_not_active', `Run "${run.id}" is ${run.status}; steer requires an active run.`, 409, { runId: run.id, status: run.status });
  }
}

function assertLeafSteerable(run: RuntimeRunRecord): void {
  if (STEER_ALLOWED_RUN_STATUSES.has(run.status)) {
    return;
  }
  assertExactSteerable(run);
  throw new SteerResolutionError('run_not_steerable', `Run "${run.id}" is ${run.status}; leaf steering requires a running, planning, or queued run.`, 409, { runId: run.id, status: run.status });
}

async function resolveAgentForRun(
  runId: string,
  context: DashboardRunRouteContext,
): Promise<import('./core.js').CreatedAdaptiveAgent> {
  if (!context.agentRegistry) {
    throw new AgentResolutionError('agent_registry_unavailable', 'Agent registry is not configured.', 503);
  }

  const link = await resolveDashboardApprovalSessionLink(runId, context);
  if (link) {
    const session = await context.stores.sessions.get(link.sessionId);
    if (session?.agentId && context.agentRegistry.has(session.agentId)) {
      return await context.agentRegistry.getAgent(session.agentId);
    }
  }

  const agentIds = context.agentRegistry.listAgentIds();
  if (agentIds.length === 1 && agentIds[0]) {
    return await context.agentRegistry.getAgent(agentIds[0]);
  }

  throw new AgentResolutionError(
    'agent_not_found',
    `Unable to determine agent for run "${runId}". Provide a session-linked run or register exactly one agent.`,
    409,
    { runId },
  );
}

async function buildGatewayStatusReport(stores: GatewayStores, nowFactory: (() => Date) | undefined): Promise<JsonObject> {
  const checkedAt = (nowFactory ?? (() => new Date()))().toISOString();
  const [sessions, activeAdmissions] = await Promise.all([
    stores.sessions.listAll(),
    stores.runAdmissions.listActive(checkedAt),
  ]);
  const sessionCountsByStatus = countBy(sessions, (session) => session.status);
  const activeRunsByAgent = countBy(activeAdmissions, (admission) => admission.agentId);
  const activeRunsByTenant = countBy(activeAdmissions, (admission) => admission.tenantId ?? 'unscoped');

  return {
    checkedAt,
    sessions: {
      total: sessions.length,
      byStatus: sessionCountsByStatus,
      running: sessionCountsByStatus.running ?? 0,
      awaitingApproval: sessionCountsByStatus.awaiting_approval ?? 0,
    },
    activeRuns: {
      total: activeAdmissions.length,
      byAgent: activeRunsByAgent,
      byTenant: activeRunsByTenant,
    },
  };
}

function countBy<T>(values: T[], keyFor: (value: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const key = keyFor(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

async function requireGatewayAdminHttpRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: ResolvedGatewayAuthProvider | undefined,
): Promise<GatewayAuthContext | undefined> {
  try {
    const authContext = await authenticateGatewayHttpRequest({
      auth,
      headers: request.headers,
    });

    if (!authContext) {
      throw new GatewayAuthError('auth_required', 'Gateway dashboard routes require an authenticated admin principal.', {
        statusCode: 401,
      });
    }

    if (!authContext.roles.includes('admin')) {
      throw new GatewayAuthError('session_forbidden', 'Gateway dashboard routes require the admin role.', {
        statusCode: 403,
        details: { requiredRole: 'admin' },
      });
    }

    return authContext;
  } catch (error) {
    if (error instanceof GatewayAuthError) {
      void reply.code(error.statusCode).send(createAuthErrorFrame(error));
      return undefined;
    }
    throw error;
  }
}

async function requireGatewayAuthenticatedHttpRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: ResolvedGatewayAuthProvider | undefined,
  routeLabel: string,
): Promise<GatewayAuthContext | undefined> {
  try {
    const authContext = await authenticateGatewayHttpRequest({
      auth,
      headers: request.headers,
    });

    if (!authContext) {
      throw new GatewayAuthError('auth_required', `${routeLabel} requires an authenticated principal.`, {
        statusCode: 401,
      });
    }

    return authContext;
  } catch (error) {
    if (error instanceof GatewayAuthError) {
      void reply.code(error.statusCode).send(createAuthErrorFrame(error));
      return undefined;
    }
    throw error;
  }
}

async function assertRunActionAuthorized(
  runId: string,
  authContext: GatewayAuthContext,
  context: DashboardRunRouteContext,
  action: 'interrupt' | 'steer',
): Promise<void> {
  if (authContext.roles.includes('admin')) {
    return;
  }

  const link = await resolveDashboardRunSessionLink(runId, context);
  const session = link ? await context.stores.sessions.get(link.sessionId) : undefined;
  if (session?.authSubject === authContext.subject) {
    return;
  }

  throw new GatewayAuthError(
    'session_forbidden',
    `Run ${action} requires the admin role or the authenticated principal that initiated run "${runId}".`,
    {
      statusCode: 403,
      details: {
        runId,
        requiredRole: 'admin',
      },
    },
  );
}

function createGatewayHttpError(code: string, message: string, details?: JsonObject): JsonObject {
  return {
    type: 'error',
    code,
    message,
    ...(details ? { details } : {}),
  };
}

function parseDashboardRunListFilters(query: Record<string, string | string[] | undefined>): DashboardRunListFilters {
  const filters: DashboardRunListFilters = {};
  const from = firstQueryValue(query.from);
  const to = firstQueryValue(query.to);
  const status = query.status;
  const session = firstQueryValue(query.session);
  const sort = firstQueryValue(query.sort);

  if (from) {
    assertIsoDateQuery('from', from);
    filters.from = from;
  }
  if (to) {
    assertIsoDateQuery('to', to);
    filters.to = to;
  }
  if (status) {
    filters.status = (Array.isArray(status) ? status : status.split(','))
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  }
  if (session) {
    filters.session = parseDashboardSessionFilter(session);
  }
  if (sort) {
    filters.sort = parseDashboardRunSort(sort);
  }

  filters.sessionId = optionalTrimmedQueryValue(query.sessionId);
  filters.rootRunId = optionalTrimmedQueryValue(query.rootRunId);
  filters.runId = optionalTrimmedQueryValue(query.runId);
  filters.delegateName = optionalTrimmedQueryValue(query.delegateName);
  filters.q = optionalTrimmedQueryValue(query.q);
  filters.limit = parseIntegerQueryValue('limit', query.limit);
  filters.offset = parseIntegerQueryValue('offset', query.offset);

  const requiresApproval = firstQueryValue(query.requiresApproval);
  if (requiresApproval !== undefined) {
    filters.requiresApproval = parseBooleanQueryValue('requiresApproval', requiresApproval);
  }

  return filters;
}

function parseDashboardTraceOptions(query: Record<string, string | string[] | undefined>): {
  includePlans?: boolean;
  messages?: boolean;
  messagesView?: MessageView;
  focusRunId?: string;
} {
  const includePlans = firstQueryValue(query.includePlans);
  const messages = firstQueryValue(query.messages);
  const messagesView = firstQueryValue(query.messagesView);
  return {
    ...(includePlans === undefined ? {} : { includePlans: parseBooleanQueryValue('includePlans', includePlans) }),
    ...(messages === undefined ? {} : { messages: parseBooleanQueryValue('messages', messages) }),
    ...(messagesView === undefined ? {} : { messagesView: parseMessageView(messagesView) }),
    ...(optionalTrimmedQueryValue(query.focusRunId) ? { focusRunId: optionalTrimmedQueryValue(query.focusRunId) } : {}),
  };
}

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function optionalTrimmedQueryValue(value: string | string[] | undefined): string | undefined {
  const first = firstQueryValue(value)?.trim();
  return first && first.length > 0 ? first : undefined;
}

function parseIntegerQueryValue(name: string, value: string | string[] | undefined): number | undefined {
  const first = firstQueryValue(value);
  if (first === undefined) {
    return undefined;
  }
  const parsed = Number(first);
  if (!Number.isInteger(parsed)) {
    throw new DashboardRouteInputError(`Query parameter "${name}" must be an integer.`);
  }
  return parsed;
}

function parseBooleanQueryValue(name: string, value: string): boolean {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new DashboardRouteInputError(`Query parameter "${name}" must be "true" or "false".`);
}

function assertIsoDateQuery(name: string, value: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new DashboardRouteInputError(`Query parameter "${name}" must be a valid date or ISO timestamp.`);
  }
}

function parseDashboardSessionFilter(value: string): DashboardSessionFilter {
  if (value === 'any' || value === 'linked' || value === 'sessionless') {
    return value;
  }
  throw new DashboardRouteInputError('Query parameter "session" must be one of: any, linked, sessionless.');
}

function parseDashboardRunSort(value: string): DashboardRunSort {
  if (value === 'created_desc' || value === 'updated_desc' || value === 'duration_desc' || value === 'cost_desc') {
    return value;
  }
  throw new DashboardRouteInputError('Query parameter "sort" must be one of: created_desc, updated_desc, duration_desc, cost_desc.');
}

function parseMessageView(value: string): MessageView {
  if (value === 'compact' || value === 'delta' || value === 'full') {
    return value;
  }
  throw new DashboardRouteInputError('Query parameter "messagesView" must be one of: compact, delta, full.');
}

async function resolveDashboardApprovalSessionLink(runId: string, context: DashboardRunRouteContext): Promise<{ sessionId: string } | undefined> {
  const directLink = await context.stores.sessionRunLinks.getByRunId(runId);
  if (directLink?.invocationKind === 'run') {
    return { sessionId: directLink.sessionId };
  }

  const rootRunId = await resolveDashboardRootRunId(runId, context.traceClient);
  if (!rootRunId) {
    return undefined;
  }

  const links = await context.stores.sessionRunLinks.listByRootRunId(rootRunId);
  const latestRunLink = links.filter((link) => link.invocationKind === 'run').at(-1);
  return latestRunLink ? { sessionId: latestRunLink.sessionId } : undefined;
}

async function resolveDashboardRunSessionLink(runId: string, context: DashboardRunRouteContext): Promise<{ sessionId: string } | undefined> {
  const directLink = await context.stores.sessionRunLinks.getByRunId(runId);
  if (directLink) {
    return { sessionId: directLink.sessionId };
  }

  const rootRunId = await resolveDashboardRootRunId(runId, context.traceClient);
  if (!rootRunId) {
    return undefined;
  }

  const links = await context.stores.sessionRunLinks.listByRootRunId(rootRunId);
  const latestLink = links.at(-1);
  return latestLink ? { sessionId: latestLink.sessionId } : undefined;
}

async function resolveDashboardRootRunId(runId: string, traceClient: PostgresClient | undefined): Promise<string | undefined> {
  if (!traceClient) {
    return undefined;
  }
  const result = await traceClient.query<{ root_run_id: string }>(
    `select root_run_id::text as root_run_id from agent_runs where id = $1`,
    [runId],
  );
  return result.rows[0]?.root_run_id;
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
      if (frame.sessionId && frame.rootRunId) {
        throw new ProtocolValidationError(
          'invalid_frame',
          'Use only one of frame.sessionId or frame.rootRunId when opening a session.',
          { requestType: frame.type },
        );
      }

      if (frame.sessionId || frame.rootRunId) {
        let sessionId = frame.sessionId;
        if (frame.rootRunId) {
          const links = await context.stores.sessionRunLinks.listByRootRunId(frame.rootRunId);
          const latestRunLink = links.filter((link) => link.invocationKind === 'run').at(-1);
          if (!latestRunLink) {
            throw new ProtocolValidationError(
              'session_not_found',
              `No run session is linked to root run "${frame.rootRunId}".`,
              { requestType: frame.type, details: { rootRunId: frame.rootRunId } },
            );
          }
          sessionId = latestRunLink.sessionId;
        }

        if (!sessionId) {
          throw new ProtocolValidationError('invalid_frame', 'Session resolution failed.', { requestType: frame.type });
        }

        if (context.hooks) {
          const session = await getAuthorizedGatewaySession(sessionId, {
            authContext: context.authContext,
            stores: context.stores,
            requestType: frame.type,
            expectedChannelId: frame.channelId,
          });
          await executeSessionResolveHook(context.hooks, frame.type, session, context.authContext);
        }

        const reconnectState = await restoreActiveSession(sessionId, {
          stores: context.stores,
          agentRegistry: context.agentRegistry,
          authContext: context.authContext,
          now: context.now,
          staleLeaseHeartbeatBefore: context.staleLeaseHeartbeatBefore,
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
        imageUploadDir: context.imageUploadDir,
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
        imageUploadDir: context.imageUploadDir,
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
        gatewayConfig: context.gatewayConfig,
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

    if (frame.type === 'run.continue' && context.stores && context.agentRegistry) {
      return await executeGatewayRunContinue(frame, {
        gatewayConfig: context.gatewayConfig,
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
        gatewayConfig: context.gatewayConfig,
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
        gatewayConfig: context.gatewayConfig,
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
    case 'run.continue':
      return {
        frameType: frame.type,
        sessionId: frame.sessionId,
        runId: frame.runId,
        strategy: frame.strategy,
        provider: frame.provider,
        model: frame.model,
        requireApproval: frame.requireApproval,
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
        ...summarizeAgentEventPayloadForLogging(frame.data),
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
        ...(frame.error ? { error: truncateForLog(frame.error) } : {}),
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

function summarizeAgentEventPayloadForLogging(data: JsonValue): JsonObject {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return {};
  }

  const payload = data as JsonObject;
  const summary: JsonObject = {};
  const status = typeof payload.status === 'string' ? payload.status : undefined;
  const code = typeof payload.code === 'string' ? payload.code : typeof payload.errorCode === 'string' ? payload.errorCode : undefined;
  const failureKind = typeof payload.failureKind === 'string' ? payload.failureKind : undefined;
  const error =
    typeof payload.error === 'string'
      ? payload.error
      : typeof payload.reason === 'string'
        ? payload.reason
        : typeof payload.message === 'string'
          ? payload.message
          : undefined;

  if (status) {
    summary.eventStatus = status;
  }
  if (code) {
    summary.errorCode = code;
  }
  if (failureKind) {
    summary.failureKind = failureKind;
  }
  if (error) {
    summary.error = truncateForLog(error);
  }

  return summary;
}

function truncateForLog(value: string, maxLength = 240): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
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
