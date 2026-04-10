import type { AgentRegistry } from './agent-registry.js';
import type { GatewayAuthContext } from './auth.js';
import type { GatewayConfig } from './config.js';
import type { JsonObject, JsonValue, RunResult } from './core.js';
import type {
  ApprovalRequestedFrame,
  ApprovalResolveFrame,
  ClarificationResolveFrame,
  RunOutputFrame,
  RunStartFrame,
} from './protocol.js';
import { ProtocolValidationError } from './protocol.js';
import type { RealtimeEventForwardingContext } from './realtime-events.js';
import { withForwardedRealtimeEvents } from './realtime-events.js';
import { resolveGatewayRoute } from './routing.js';
import { assertGatewaySessionWriteAllowed, getAuthorizedGatewaySession } from './session.js';
import type { GatewaySessionRecord, GatewayStores } from './stores.js';

export interface ExecuteGatewayRunStartOptions {
  gatewayConfig: GatewayConfig;
  agentRegistry: AgentRegistry;
  stores: GatewayStores;
  authContext?: GatewayAuthContext;
  requestedChannelId?: string;
  now?: () => Date;
  realtimeEvents?: Omit<RealtimeEventForwardingContext, 'fallbackAgentId' | 'fallbackSessionId' | 'rootRunId'>;
}

export interface ExecuteGatewayApprovalResolutionOptions {
  agentRegistry: AgentRegistry;
  stores: GatewayStores;
  authContext?: GatewayAuthContext;
  now?: () => Date;
  realtimeEvents?: Omit<RealtimeEventForwardingContext, 'fallbackAgentId' | 'fallbackSessionId' | 'requestId'>;
}

export interface ExecuteGatewayClarificationResolutionOptions {
  agentRegistry: AgentRegistry;
  stores: GatewayStores;
  authContext?: GatewayAuthContext;
  now?: () => Date;
  realtimeEvents?: Omit<RealtimeEventForwardingContext, 'fallbackAgentId' | 'fallbackSessionId' | 'requestId'>;
}

export async function executeGatewayRunStart(
  frame: RunStartFrame,
  options: ExecuteGatewayRunStartOptions,
): Promise<RunOutputFrame | ApprovalRequestedFrame> {
  const nowIso = (options.now ?? (() => new Date()))().toISOString();

  if (frame.sessionId) {
    const session = await getAuthorizedGatewaySession(frame.sessionId, {
      authContext: options.authContext,
      stores: options.stores,
      requestType: frame.type,
    });
    assertGatewaySessionWriteAllowed(session, frame.type);
    assertChannelAllowsInvocation(options.gatewayConfig, session.channelId, 'run', frame.type);

    const route = resolveGatewayRoute({
      gatewayConfig: options.gatewayConfig,
      agentRegistry: options.agentRegistry,
      session,
      authContext: options.authContext,
      invocationMode: 'run',
      requestType: frame.type,
      requestedAgentId: session.agentId ? undefined : frame.agentId,
      allowExplicitAgentId: true,
    });

    const runningSession = await options.stores.sessions.update({
      ...session,
      agentId: route.agentId,
      invocationMode: 'run',
      status: 'running',
      currentRunId: undefined,
      currentRootRunId: undefined,
      updatedAt: nowIso,
    });

    try {
      return await executeResolvedGatewayRun(frame, {
        agentId: route.agentId,
        session: runningSession,
        authContext: options.authContext,
        agentRegistry: options.agentRegistry,
        stores: options.stores,
        requestedChannelId: options.requestedChannelId,
        nowIso,
        realtimeEvents: options.realtimeEvents,
      });
    } catch (error) {
      if (error instanceof ProtocolValidationError) {
        throw error;
      }

      await settleSession(options.stores, runningSession, {
        status: 'failed',
        currentRunId: undefined,
        currentRootRunId: undefined,
        updatedAt: nowIso,
      });

      throw new ProtocolValidationError(
        'run_failed',
        error instanceof Error ? error.message : 'Structured run failed unexpectedly.',
        {
          requestType: frame.type,
          details: { sessionId: runningSession.id, agentId: route.agentId },
        },
      );
    }
  }

  const route = resolveGatewayRoute({
    gatewayConfig: options.gatewayConfig,
    agentRegistry: options.agentRegistry,
    session: createIsolatedRouteSession(options.authContext, options.requestedChannelId),
    authContext: options.authContext,
    invocationMode: 'run',
    requestType: frame.type,
    requestedAgentId: frame.agentId,
    allowExplicitAgentId: true,
  });
  assertChannelAllowsInvocation(options.gatewayConfig, options.requestedChannelId, 'run', frame.type);

  try {
    return await executeResolvedGatewayRun(frame, {
      agentId: route.agentId,
      authContext: options.authContext,
      agentRegistry: options.agentRegistry,
      stores: options.stores,
      requestedChannelId: options.requestedChannelId,
      nowIso,
      realtimeEvents: options.realtimeEvents,
    });
  } catch (error) {
    if (error instanceof ProtocolValidationError) {
      throw error;
    }

    throw new ProtocolValidationError(
      'run_failed',
      error instanceof Error ? error.message : 'Structured run failed unexpectedly.',
      {
        requestType: frame.type,
        details: { agentId: route.agentId },
      },
    );
  }
}

export async function executeGatewayApprovalResolution(
  frame: ApprovalResolveFrame,
  options: ExecuteGatewayApprovalResolutionOptions,
): Promise<RunOutputFrame | ApprovalRequestedFrame> {
  const nowIso = (options.now ?? (() => new Date()))().toISOString();
  const session = await getAuthorizedGatewaySession(frame.sessionId, {
    authContext: options.authContext,
    stores: options.stores,
    requestType: frame.type,
  });
  assertGatewaySessionWriteAllowed(session, frame.type, {
    allowPendingApprovalRunId: frame.runId,
  });

  const agentId = session.agentId;
  if (!agentId) {
    throw new ProtocolValidationError(
      'run_failed',
      `Session "${session.id}" does not have a routed agent for approval resolution.`,
      {
        requestType: frame.type,
        details: { sessionId: session.id, runId: frame.runId },
      },
    );
  }

  const agent = await options.agentRegistry.getAgent(agentId);
  if (!agent.agent.resolveApproval || !agent.agent.resume) {
    throw new ProtocolValidationError(
      'run_failed',
      `Agent "${agentId}" does not support approval resolution.`,
      {
        requestType: frame.type,
        details: { sessionId: session.id, runId: frame.runId, agentId },
      },
    );
  }

  const runningSession = await options.stores.sessions.update({
    ...session,
    status: 'running',
    updatedAt: nowIso,
  });

  try {
    const realtimeEvents = options.realtimeEvents
      ? {
          ...options.realtimeEvents,
          fallbackAgentId: agentId,
          fallbackSessionId: runningSession.id,
          rootRunId: session.currentRootRunId ?? frame.runId,
        }
      : undefined;

    await withForwardedRealtimeEvents(agent, realtimeEvents, () => agent.agent.resolveApproval!(frame.runId, frame.approved));
    const resumedResult = await withForwardedRealtimeEvents(agent, realtimeEvents, () => agent.agent.resume!(frame.runId));
    const rootRunId = (await resolveRootRunId(agent.runtime.runStore, resumedResult.runId)) ?? session.currentRootRunId ?? frame.runId;

    return settleStructuredRunResult(resumedResult, rootRunId, {
      agentId,
      session: runningSession,
      authContext: options.authContext,
      agentRegistry: options.agentRegistry,
      stores: options.stores,
      nowIso,
    });
  } catch (error) {
    if (error instanceof ProtocolValidationError) {
      throw error;
    }

    await settleSession(options.stores, runningSession, {
      status: 'failed',
      currentRunId: undefined,
      currentRootRunId: undefined,
      updatedAt: nowIso,
    });

    throw new ProtocolValidationError(
      'run_failed',
      error instanceof Error ? error.message : 'Approval resolution failed unexpectedly.',
      {
        requestType: frame.type,
        details: {
          sessionId: runningSession.id,
          runId: frame.runId,
          agentId,
        },
      },
    );
  }
}

export async function executeGatewayClarificationResolution(
  frame: ClarificationResolveFrame,
  options: ExecuteGatewayClarificationResolutionOptions,
): Promise<RunOutputFrame | ApprovalRequestedFrame> {
  const nowIso = (options.now ?? (() => new Date()))().toISOString();
  const session = await getAuthorizedGatewaySession(frame.sessionId, {
    authContext: options.authContext,
    stores: options.stores,
    requestType: frame.type,
  });
  assertGatewaySessionWriteAllowed(session, frame.type);

  const sessionRunLink = await options.stores.sessionRunLinks.getByRunId(frame.runId);
  if (!sessionRunLink || sessionRunLink.sessionId !== session.id) {
    throw new ProtocolValidationError(
      'invalid_frame',
      `Run "${frame.runId}" is not linked to session "${session.id}" for clarification resolution.`,
      {
        requestType: frame.type,
        details: {
          sessionId: session.id,
          runId: frame.runId,
        },
      },
    );
  }

  const agentId = session.agentId;
  if (!agentId) {
    throw new ProtocolValidationError(
      'run_failed',
      `Session "${session.id}" does not have a routed agent for clarification resolution.`,
      {
        requestType: frame.type,
        details: { sessionId: session.id, runId: frame.runId },
      },
    );
  }

  const agent = await options.agentRegistry.getAgent(agentId);
  if (!agent.agent.resolveClarification) {
    throw new ProtocolValidationError(
      'run_failed',
      `Agent "${agentId}" does not support clarification resolution.`,
      {
        requestType: frame.type,
        details: { sessionId: session.id, runId: frame.runId, agentId },
      },
    );
  }

  const runningSession = await options.stores.sessions.update({
    ...session,
    status: 'running',
    currentRunId: frame.runId,
    currentRootRunId: sessionRunLink.rootRunId,
    updatedAt: nowIso,
  });

  try {
    const clarifiedResult = await withForwardedRealtimeEvents(
      agent,
      options.realtimeEvents
        ? {
            ...options.realtimeEvents,
            fallbackAgentId: agentId,
            fallbackSessionId: runningSession.id,
            rootRunId: sessionRunLink.rootRunId,
          }
        : undefined,
      () => agent.agent.resolveClarification!(frame.runId, frame.message),
    );
    const rootRunId =
      (await resolveRootRunId(agent.runtime.runStore, clarifiedResult.runId)) ?? sessionRunLink.rootRunId ?? frame.runId;

    return settleStructuredRunResult(clarifiedResult, rootRunId, {
      agentId,
      session: runningSession,
      authContext: options.authContext,
      agentRegistry: options.agentRegistry,
      stores: options.stores,
      nowIso,
    });
  } catch (error) {
    if (error instanceof ProtocolValidationError) {
      throw error;
    }

    await settleSession(options.stores, runningSession, {
      status: 'failed',
      currentRunId: undefined,
      currentRootRunId: undefined,
      updatedAt: nowIso,
    });

    throw new ProtocolValidationError(
      'run_failed',
      error instanceof Error ? error.message : 'Clarification resolution failed unexpectedly.',
      {
        requestType: frame.type,
        details: {
          sessionId: runningSession.id,
          runId: frame.runId,
          agentId,
        },
      },
    );
  }
}

interface ExecuteResolvedGatewayRunOptions {
  agentId: string;
  session?: GatewaySessionRecord;
  authContext?: GatewayAuthContext;
  agentRegistry: AgentRegistry;
  stores: GatewayStores;
  requestedChannelId?: string;
  nowIso: string;
  realtimeEvents?: Omit<RealtimeEventForwardingContext, 'fallbackAgentId' | 'fallbackSessionId' | 'rootRunId'>;
}

async function executeResolvedGatewayRun(
  frame: RunStartFrame,
  options: ExecuteResolvedGatewayRunOptions,
): Promise<RunOutputFrame | ApprovalRequestedFrame> {
  const agent = await options.agentRegistry.getAgent(options.agentId);
  if (!agent.agent.run) {
    throw new ProtocolValidationError('run_failed', `Agent "${options.agentId}" does not expose run().`, {
      requestType: frame.type,
      details: { agentId: options.agentId },
    });
  }

  const runResult = await withForwardedRealtimeEvents(
    agent,
    options.realtimeEvents
      ? {
          ...options.realtimeEvents,
          fallbackAgentId: options.agentId,
          fallbackSessionId: options.session?.id,
        }
      : undefined,
    () =>
      agent.agent.run!({
        goal: frame.goal,
        input: frame.input,
        context: buildGatewayRunContext(frame, options.session, options.authContext, options.requestedChannelId),
        metadata: buildGatewayRunMetadata(frame, options.session?.id, options.agentId, options.realtimeEvents?.requestId),
      }),
  );
  const rootRunId = (await resolveRootRunId(agent.runtime.runStore, runResult.runId)) ?? runResult.runId;

  if (options.session) {
    await options.stores.sessionRunLinks.append({
      sessionId: options.session.id,
      runId: runResult.runId,
      rootRunId,
      invocationKind: 'run',
      metadata: frame.metadata,
      createdAt: options.nowIso,
    });
  }

  return settleStructuredRunResult(runResult, rootRunId, options);
}

async function settleStructuredRunResult(
  result: RunResult,
  rootRunId: string,
  options: ExecuteResolvedGatewayRunOptions,
): Promise<RunOutputFrame | ApprovalRequestedFrame> {
  switch (result.status) {
    case 'success': {
      if (options.session) {
        await settleSession(options.stores, options.session, {
          status: 'idle',
          currentRunId: undefined,
          currentRootRunId: undefined,
          lastCompletedRootRunId: rootRunId,
          updatedAt: options.nowIso,
        });
      }

      return {
        type: 'run.output',
        runId: result.runId,
        rootRunId,
        sessionId: options.session?.id,
        status: 'succeeded',
        output: result.output,
      };
    }
    case 'clarification_requested': {
      if (options.session) {
        await settleSession(options.stores, options.session, {
          status: 'idle',
          currentRunId: undefined,
          currentRootRunId: undefined,
          lastCompletedRootRunId: rootRunId,
          updatedAt: options.nowIso,
        });
      }

      return {
        type: 'run.output',
        runId: result.runId,
        rootRunId,
        sessionId: options.session?.id,
        status: 'succeeded',
        output: serializeClarificationRequest(result),
      };
    }
    case 'approval_requested': {
      if (options.session) {
        await settleSession(options.stores, options.session, {
          status: 'awaiting_approval',
          currentRunId: result.runId,
          currentRootRunId: rootRunId,
          updatedAt: options.nowIso,
        });
      }

      return {
        type: 'approval.requested',
        runId: result.runId,
        rootRunId,
        sessionId: options.session?.id,
        toolName: result.toolName,
        reason: result.message,
      };
    }
    case 'failure': {
      if (options.session) {
        await settleSession(options.stores, options.session, {
          status: 'failed',
          currentRunId: undefined,
          currentRootRunId: undefined,
          lastCompletedRootRunId: rootRunId,
          updatedAt: options.nowIso,
        });
      }

      return {
        type: 'run.output',
        runId: result.runId,
        rootRunId,
        sessionId: options.session?.id,
        status: 'failed',
        error: result.error,
      };
    }
  }
}

function buildGatewayRunContext(
  frame: RunStartFrame,
  session?: GatewaySessionRecord,
  authContext?: GatewayAuthContext,
  requestedChannelId?: string,
): JsonObject {
  const context: JsonObject = {
    ...(frame.context ?? {}),
    invocationMode: 'run',
  };

  if (session) {
    context.sessionId = session.id;
    context.channelId = session.channelId;
    context.authSubject = session.authSubject;

    if (session.tenantId) {
      context.tenantId = session.tenantId;
    } else if (authContext?.tenantId) {
      context.tenantId = authContext.tenantId;
    }
  } else {
    if (requestedChannelId) {
      context.channelId = requestedChannelId;
    }

    if (authContext?.subject) {
      context.authSubject = authContext.subject;
    }

    if (authContext?.tenantId) {
      context.tenantId = authContext.tenantId;
    }
  }

  if (authContext?.roles.length) {
    context.roles = authContext.roles;
  }

  return context;
}

function buildGatewayRunMetadata(
  frame: RunStartFrame,
  sessionId: string | undefined,
  agentId: string,
  requestId?: string,
): JsonObject {
  const gatewayMetadata: JsonObject = {
    agentId,
    invocationMode: 'run',
  };

  if (sessionId) {
    gatewayMetadata.sessionId = sessionId;
  }

  if (requestId) {
    gatewayMetadata.requestId = requestId;
  }

  return {
    ...(frame.metadata ?? {}),
    gateway: gatewayMetadata,
  };
}

function createIsolatedRouteSession(
  authContext: GatewayAuthContext | undefined,
  requestedChannelId: string | undefined,
): GatewaySessionRecord {
  return {
    id: '__isolated_run__',
    channelId: requestedChannelId ?? '__isolated__',
    authSubject: authContext?.subject ?? 'anonymous',
    tenantId: authContext?.tenantId,
    status: 'idle',
    transcriptVersion: 0,
    createdAt: '1970-01-01T00:00:00.000Z',
    updatedAt: '1970-01-01T00:00:00.000Z',
  };
}

function assertChannelAllowsInvocation(
  gatewayConfig: GatewayConfig,
  channelId: string | undefined,
  invocationMode: 'run',
  requestType: string,
): void {
  if (!channelId) {
    return;
  }

  const channel = gatewayConfig.channels?.list.find((entry) => entry.id === channelId);
  if (!channel?.allowedInvocationModes || channel.allowedInvocationModes.includes(invocationMode)) {
    return;
  }

  throw new ProtocolValidationError(
    'invalid_frame',
    `Channel "${channelId}" does not allow invocation mode "${invocationMode}" for frame type "${requestType}".`,
    {
      requestType,
      details: {
        channelId,
        invocationMode,
        allowedInvocationModes: channel.allowedInvocationModes,
      },
    },
  );
}

async function resolveRootRunId(
  runStore: { getRun(runId: string): Promise<{ rootRunId: string } | null> },
  runId: string,
): Promise<string | undefined> {
  return (await runStore.getRun(runId))?.rootRunId;
}

function serializeClarificationRequest(result: Extract<RunResult, { status: 'clarification_requested' }>): JsonValue {
  return {
    status: result.status,
    message: result.message,
    suggestedQuestions: result.suggestedQuestions ?? [],
  };
}

async function settleSession(
  stores: GatewayStores,
  session: GatewaySessionRecord,
  patch: Partial<GatewaySessionRecord>,
): Promise<GatewaySessionRecord> {
  return stores.sessions.update({
    ...session,
    ...patch,
  });
}
