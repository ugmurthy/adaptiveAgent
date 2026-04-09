import type { AgentRegistry } from './agent-registry.js';
import type { GatewayAuthContext } from './auth.js';
import type { GatewayConfig } from './config.js';
import type { JsonObject, JsonValue, RunResult } from './core.js';
import type { ApprovalRequestedFrame, RunOutputFrame, RunStartFrame } from './protocol.js';
import { ProtocolValidationError } from './protocol.js';
import { resolveGatewayRoute } from './routing.js';
import { getAuthorizedGatewaySession } from './session.js';
import type { GatewaySessionRecord, GatewayStores } from './stores.js';

export interface ExecuteGatewayRunStartOptions {
  gatewayConfig: GatewayConfig;
  agentRegistry: AgentRegistry;
  stores: GatewayStores;
  authContext?: GatewayAuthContext;
  requestedChannelId?: string;
  now?: () => Date;
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

interface ExecuteResolvedGatewayRunOptions {
  agentId: string;
  session?: GatewaySessionRecord;
  authContext?: GatewayAuthContext;
  agentRegistry: AgentRegistry;
  stores: GatewayStores;
  requestedChannelId?: string;
  nowIso: string;
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

  const runResult = await agent.agent.run({
    goal: frame.goal,
    input: frame.input,
    context: buildGatewayRunContext(frame, options.session, options.authContext, options.requestedChannelId),
    metadata: buildGatewayRunMetadata(frame, options.session?.id, options.agentId),
  });
  const rootRunId = await resolveRootRunId(agent.runtime.runStore, runResult.runId);

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

function buildGatewayRunMetadata(frame: RunStartFrame, sessionId: string | undefined, agentId: string): JsonObject {
  const gatewayMetadata: JsonObject = {
    agentId,
    invocationMode: 'run',
  };

  if (sessionId) {
    gatewayMetadata.sessionId = sessionId;
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
): Promise<string> {
  return (await runStore.getRun(runId))?.rootRunId ?? runId;
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
