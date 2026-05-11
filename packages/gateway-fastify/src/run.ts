import type { AgentRegistry } from './agent-registry.js';
import { acquireRunAdmission, type AcquiredRunAdmission } from './admission.js';
import type { GatewayAuthContext } from './auth.js';
import { resolveGatewayConcurrencyConfig, type GatewayConfig } from './config.js';
import type { JsonObject, JsonValue, RunResult } from './core.js';
import { executeHookSlot } from './hooks.js';
import type {
  ApprovalRequestedFrame,
  ApprovalResolveFrame,
  ClarificationResolveFrame,
  RunContinueFrame,
  RunOutputFrame,
  RunRetryFrame,
  RunStartFrame,
} from './protocol.js';
import { ProtocolValidationError } from './protocol.js';
import type { RealtimeEventForwardingContext } from './realtime-events.js';
import type { ResolvedGatewayHooks } from './registries.js';
import { withForwardedRealtimeEvents } from './realtime-events.js';
import { resolveGatewayRoute } from './routing.js';
import { assertGatewaySessionWriteAllowed, getAuthorizedGatewaySession, tryAcquireGatewaySessionRun } from './session.js';
import type { GatewaySessionRecord, GatewayStores, SessionRunLinkRecord } from './stores.js';
import { resolveGatewayImageInputs } from './uploads.js';

export interface ExecuteGatewayRunStartOptions {
  gatewayConfig: GatewayConfig;
  agentRegistry: AgentRegistry;
  stores: GatewayStores;
  authContext?: GatewayAuthContext;
  hooks?: ResolvedGatewayHooks;
  imageUploadDir?: string;
  requestedChannelId?: string;
  now?: () => Date;
  realtimeEvents?: Omit<RealtimeEventForwardingContext, 'fallbackAgentId' | 'fallbackSessionId' | 'rootRunId'>;
}

export interface ExecuteGatewayApprovalResolutionOptions {
  gatewayConfig?: GatewayConfig;
  agentRegistry: AgentRegistry;
  stores: GatewayStores;
  authContext?: GatewayAuthContext;
  hooks?: ResolvedGatewayHooks;
  now?: () => Date;
  realtimeEvents?: Omit<RealtimeEventForwardingContext, 'fallbackAgentId' | 'fallbackSessionId' | 'requestId'>;
  hasRuntimeObserver?: (rootRunId: string) => boolean;
}

export interface ExecuteGatewayClarificationResolutionOptions {
  gatewayConfig?: GatewayConfig;
  agentRegistry: AgentRegistry;
  stores: GatewayStores;
  authContext?: GatewayAuthContext;
  hooks?: ResolvedGatewayHooks;
  now?: () => Date;
  realtimeEvents?: Omit<RealtimeEventForwardingContext, 'fallbackAgentId' | 'fallbackSessionId' | 'requestId'>;
  hasRuntimeObserver?: (rootRunId: string) => boolean;
}

export interface ExecuteGatewayRunRetryOptions {
  gatewayConfig?: GatewayConfig;
  agentRegistry: AgentRegistry;
  stores: GatewayStores;
  authContext?: GatewayAuthContext;
  hooks?: ResolvedGatewayHooks;
  now?: () => Date;
  realtimeEvents?: Omit<RealtimeEventForwardingContext, 'fallbackAgentId' | 'fallbackSessionId' | 'requestId'>;
  hasRuntimeObserver?: (rootRunId: string) => boolean;
}

export interface ExecuteGatewayRunContinueOptions {
  gatewayConfig?: GatewayConfig;
  agentRegistry: AgentRegistry;
  stores: GatewayStores;
  authContext?: GatewayAuthContext;
  hooks?: ResolvedGatewayHooks;
  now?: () => Date;
  realtimeEvents?: Omit<RealtimeEventForwardingContext, 'fallbackAgentId' | 'fallbackSessionId' | 'requestId'>;
  hasRuntimeObserver?: (rootRunId: string) => boolean;
}

export async function executeGatewayRunStart(
  frame: RunStartFrame,
  options: ExecuteGatewayRunStartOptions,
): Promise<RunOutputFrame | ApprovalRequestedFrame> {
  const now = (options.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  let effectiveMetadata = frame.metadata;

  if (frame.sessionId) {
    const session = await getAuthorizedGatewaySession(frame.sessionId, {
      authContext: options.authContext,
      stores: options.stores,
      requestType: frame.type,
    });
    effectiveMetadata = await runBeforeHook(options.hooks, 'onSessionResolve', frame.type, {
      authContext: options.authContext,
      session,
      metadata: effectiveMetadata,
    });
    assertGatewaySessionWriteAllowed(session, frame.type);
    assertChannelAllowsInvocation(options.gatewayConfig, session.channelId, 'run', frame.type);
    effectiveMetadata = await runBeforeHook(options.hooks, 'beforeRoute', frame.type, {
      authContext: options.authContext,
      session,
      invocationMode: 'run',
      requestedAgentId: session.agentId ? undefined : frame.agentId,
      metadata: effectiveMetadata,
    });

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
    effectiveMetadata = await runBeforeHook(options.hooks, 'beforeRunStart', frame.type, {
      authContext: options.authContext,
      session,
      invocationMode: 'run',
      agentId: route.agentId,
      metadata: effectiveMetadata,
    });
    const effectiveFrame = effectiveMetadata === frame.metadata ? frame : { ...frame, metadata: effectiveMetadata };

    const runningSession = await tryAcquireGatewaySessionRun(session, {
      stores: options.stores,
      requestType: frame.type,
      expectedAllowedStatuses: ['idle', 'failed'],
      patch: {
      agentId: route.agentId,
      invocationMode: 'run',
      status: 'running',
      currentRunId: undefined,
      currentRootRunId: undefined,
      updatedAt: nowIso,
      },
    });

    let admission: AcquiredRunAdmission | undefined;

    try {
      admission = await acquireRunAdmission({
        stores: options.stores,
        concurrency: resolveGatewayConcurrencyConfig(options.gatewayConfig.concurrency),
        agentId: route.agentId,
        tenantId: runningSession.tenantId,
        sessionId: runningSession.id,
        requestType: frame.type,
        now,
      });
      const response = await executeResolvedGatewayRun(effectiveFrame, {
        agentId: route.agentId,
        session: runningSession,
        authContext: options.authContext,
        hooks: options.hooks,
        agentRegistry: options.agentRegistry,
        stores: options.stores,
        imageUploadDir: options.imageUploadDir,
        requestedChannelId: options.requestedChannelId,
        nowIso,
        realtimeEvents: options.realtimeEvents,
      });

      await runAfterHook(options.hooks, frame.type, {
        authContext: options.authContext,
        session: runningSession,
        agentId: route.agentId,
        result: response,
        metadata: effectiveFrame.metadata,
      });

      return response;
    } catch (error) {
      if (error instanceof ProtocolValidationError) {
        if (error.code === 'gateway_overloaded') {
          await settleSession(options.stores, runningSession, {
            status: session.status,
            currentRunId: session.currentRunId,
            currentRootRunId: session.currentRootRunId,
            updatedAt: nowIso,
          });
        }
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
    } finally {
      await admission?.release();
    }
  }

  effectiveMetadata = await runBeforeIsolatedRunHook(options.hooks, 'beforeRoute', frame.type, {
    authContext: options.authContext,
    requestedChannelId: options.requestedChannelId,
    requestedAgentId: frame.agentId,
    metadata: effectiveMetadata,
  });

  effectiveMetadata = await runBeforeIsolatedRunHook(options.hooks, 'beforeRunStart', frame.type, {
    authContext: options.authContext,
    requestedChannelId: options.requestedChannelId,
    requestedAgentId: frame.agentId,
    metadata: effectiveMetadata,
  });
  const effectiveFrame = effectiveMetadata === frame.metadata ? frame : { ...frame, metadata: effectiveMetadata };

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
    const admission = await acquireRunAdmission({
      stores: options.stores,
      concurrency: resolveGatewayConcurrencyConfig(options.gatewayConfig?.concurrency),
      agentId: route.agentId,
      tenantId: options.authContext?.tenantId,
      requestType: frame.type,
      now,
    });
    try {
      const response = await executeResolvedGatewayRun(effectiveFrame, {
        agentId: route.agentId,
        authContext: options.authContext,
        hooks: options.hooks,
        agentRegistry: options.agentRegistry,
        stores: options.stores,
        imageUploadDir: options.imageUploadDir,
        requestedChannelId: options.requestedChannelId,
        nowIso,
        realtimeEvents: options.realtimeEvents,
      });

      await runAfterHook(options.hooks, frame.type, {
        authContext: options.authContext,
        agentId: route.agentId,
        result: response,
        metadata: effectiveFrame.metadata,
      });

      return response;
    } finally {
      await admission.release();
    }
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
  const now = (options.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const session = await getAuthorizedGatewaySession(frame.sessionId, {
    authContext: options.authContext,
    stores: options.stores,
    requestType: frame.type,
  });
  await runBeforeHook(options.hooks, 'onSessionResolve', frame.type, {
    authContext: options.authContext,
    session,
    metadata: frame.metadata,
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

  const runningSession = await tryAcquireGatewaySessionRun(session, {
    stores: options.stores,
    requestType: frame.type,
    expectedAllowedStatuses: ['awaiting_approval'],
    patch: {
      status: 'running',
      updatedAt: nowIso,
    },
  });
  let admission: AcquiredRunAdmission | undefined;

  try {
    admission = await acquireRunAdmission({
      stores: options.stores,
      concurrency: resolveGatewayConcurrencyConfig(options.gatewayConfig?.concurrency),
      agentId,
      tenantId: runningSession.tenantId,
      sessionId: runningSession.id,
      requestType: frame.type,
      now,
    });
    const realtimeRootRunId = session.currentRootRunId ?? frame.runId;
    const realtimeEvents = options.realtimeEvents && !options.hasRuntimeObserver?.(realtimeRootRunId)
      ? {
          ...options.realtimeEvents,
          fallbackAgentId: agentId,
          fallbackSessionId: runningSession.id,
          rootRunId: realtimeRootRunId,
        }
      : undefined;

    await withForwardedRealtimeEvents(agent, realtimeEvents, () => agent.agent.resolveApproval!(frame.runId, frame.approved));
    const resumedResult = await withForwardedRealtimeEvents(agent, realtimeEvents, () => agent.agent.resume!(frame.runId));
    const rootRunId = (await resolveRootRunId(agent.runtime.runStore, resumedResult.runId)) ?? session.currentRootRunId ?? frame.runId;

    const response = await settleStructuredRunResult(resumedResult, rootRunId, {
      agentId,
      session: runningSession,
      authContext: options.authContext,
      hooks: options.hooks,
      agentRegistry: options.agentRegistry,
      stores: options.stores,
      nowIso,
    });

    await runAfterHook(options.hooks, frame.type, {
      authContext: options.authContext,
      session: runningSession,
      agentId,
      result: response,
      metadata: frame.metadata,
    });

    return response;
  } catch (error) {
    if (error instanceof ProtocolValidationError) {
      if (error.code === 'gateway_overloaded') {
        await settleSession(options.stores, runningSession, {
          status: session.status,
          currentRunId: session.currentRunId,
          currentRootRunId: session.currentRootRunId,
          updatedAt: nowIso,
        });
      }
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
  } finally {
    await admission?.release();
  }
}

export async function executeGatewayClarificationResolution(
  frame: ClarificationResolveFrame,
  options: ExecuteGatewayClarificationResolutionOptions,
): Promise<RunOutputFrame | ApprovalRequestedFrame> {
  const now = (options.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const session = await getAuthorizedGatewaySession(frame.sessionId, {
    authContext: options.authContext,
    stores: options.stores,
    requestType: frame.type,
  });
  await runBeforeHook(options.hooks, 'onSessionResolve', frame.type, {
    authContext: options.authContext,
    session,
    metadata: frame.metadata,
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

  const runningSession = await tryAcquireGatewaySessionRun(session, {
    stores: options.stores,
    requestType: frame.type,
    expectedAllowedStatuses: ['idle', 'failed'],
    patch: {
      status: 'running',
      currentRunId: frame.runId,
      currentRootRunId: sessionRunLink.rootRunId,
      updatedAt: nowIso,
    },
  });
  let admission: AcquiredRunAdmission | undefined;

  try {
    admission = await acquireRunAdmission({
      stores: options.stores,
      concurrency: resolveGatewayConcurrencyConfig(options.gatewayConfig?.concurrency),
      agentId,
      tenantId: runningSession.tenantId,
      sessionId: runningSession.id,
      requestType: frame.type,
      now,
    });
    const clarifiedResult = await withForwardedRealtimeEvents(
      agent,
      options.realtimeEvents && !options.hasRuntimeObserver?.(sessionRunLink.rootRunId)
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

    const response = await settleStructuredRunResult(clarifiedResult, rootRunId, {
      agentId,
      session: runningSession,
      authContext: options.authContext,
      hooks: options.hooks,
      agentRegistry: options.agentRegistry,
      stores: options.stores,
      nowIso,
    });

    await runAfterHook(options.hooks, frame.type, {
      authContext: options.authContext,
      session: runningSession,
      agentId,
      result: response,
      metadata: frame.metadata,
    });

    return response;
  } catch (error) {
    if (error instanceof ProtocolValidationError) {
      if (error.code === 'gateway_overloaded') {
        await settleSession(options.stores, runningSession, {
          status: session.status,
          currentRunId: session.currentRunId,
          currentRootRunId: session.currentRootRunId,
          updatedAt: nowIso,
        });
      }
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
  } finally {
    await admission?.release();
  }
}

export async function executeGatewayRunRetry(
  frame: RunRetryFrame,
  options: ExecuteGatewayRunRetryOptions,
): Promise<RunOutputFrame | ApprovalRequestedFrame> {
  const now = (options.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const initialSessionRunLink =
    (await options.stores.sessionRunLinks.getByRunId(frame.runId)) ??
    (await resolveLatestSessionRunLinkByRootRunId(options.stores, frame.runId));
  const resolvedSessionId = frame.sessionId ?? initialSessionRunLink?.sessionId;
  if (!resolvedSessionId) {
    throw new ProtocolValidationError(
      'invalid_frame',
      `Run "${frame.runId}" is not linked to a retryable run session.`,
      {
        requestType: frame.type,
        details: { runId: frame.runId },
      },
    );
  }

  const session = await getAuthorizedGatewaySession(resolvedSessionId, {
    authContext: options.authContext,
    stores: options.stores,
    requestType: frame.type,
  });
  await runBeforeHook(options.hooks, 'onSessionResolve', frame.type, {
    authContext: options.authContext,
    session,
    metadata: frame.metadata,
  });
  assertGatewaySessionWriteAllowed(session, frame.type);

  if (session.invocationMode && session.invocationMode !== 'run') {
    throw new ProtocolValidationError(
      'invalid_frame',
      `Session "${session.id}" is not a run session and cannot retry runs.`,
      {
        requestType: frame.type,
        details: {
          sessionId: session.id,
          invocationMode: session.invocationMode ?? null,
        },
      },
    );
  }

  const sessionRunLink =
    (initialSessionRunLink?.sessionId === session.id ? initialSessionRunLink : undefined) ??
    (await resolveSessionRunLinkByRootRunId(options.stores, session.id, frame.runId));
  if (!sessionRunLink || sessionRunLink.sessionId !== session.id || sessionRunLink.invocationKind !== 'run') {
    throw new ProtocolValidationError(
      'invalid_frame',
      `Run "${frame.runId}" is not linked to session "${session.id}" for retry.`,
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
      `Session "${session.id}" does not have a routed agent for run retry.`,
      {
        requestType: frame.type,
        details: { sessionId: session.id, runId: frame.runId },
      },
    );
  }

  const agent = await options.agentRegistry.getAgent(agentId);
  if (!agent.agent.retry) {
    throw new ProtocolValidationError(
      'run_failed',
      `Agent "${agentId}" does not support run retry.`,
      {
        requestType: frame.type,
        details: { sessionId: session.id, runId: frame.runId, agentId },
      },
    );
  }

  const runningSession = await tryAcquireGatewaySessionRun(session, {
    stores: options.stores,
    requestType: frame.type,
    expectedAllowedStatuses: ['idle', 'failed'],
    patch: {
      status: 'running',
      currentRunId: sessionRunLink.runId,
      currentRootRunId: sessionRunLink.rootRunId,
      updatedAt: nowIso,
    },
  });
  let admission: AcquiredRunAdmission | undefined;

  try {
    admission = await acquireRunAdmission({
      stores: options.stores,
      concurrency: resolveGatewayConcurrencyConfig(options.gatewayConfig?.concurrency),
      agentId,
      tenantId: runningSession.tenantId,
      sessionId: runningSession.id,
      requestType: frame.type,
      now,
    });
    const retryResult = await withForwardedRealtimeEvents(
      agent,
      options.realtimeEvents && !options.hasRuntimeObserver?.(sessionRunLink.rootRunId)
        ? {
            ...options.realtimeEvents,
            fallbackAgentId: agentId,
            fallbackSessionId: runningSession.id,
            rootRunId: sessionRunLink.rootRunId,
          }
        : undefined,
      () => agent.agent.retry!(sessionRunLink.runId),
    );
    const rootRunId = (await resolveRootRunId(agent.runtime.runStore, retryResult.runId)) ?? sessionRunLink.rootRunId ?? frame.runId;

    const response = await settleStructuredRunResult(retryResult, rootRunId, {
      agentId,
      session: runningSession,
      authContext: options.authContext,
      hooks: options.hooks,
      agentRegistry: options.agentRegistry,
      stores: options.stores,
      nowIso,
    });

    await runAfterHook(options.hooks, frame.type, {
      authContext: options.authContext,
      session: runningSession,
      agentId,
      result: response,
      metadata: frame.metadata,
    });

    return response;
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
      error instanceof Error ? error.message : 'Run retry failed unexpectedly.',
      {
        requestType: frame.type,
        details: {
          sessionId: runningSession.id,
          runId: frame.runId,
          agentId,
        },
      },
    );
  } finally {
    await admission?.release();
  }
}

export async function executeGatewayRunContinue(
  frame: RunContinueFrame,
  options: ExecuteGatewayRunContinueOptions,
): Promise<RunOutputFrame | ApprovalRequestedFrame> {
  const now = (options.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const initialSessionRunLink = frame.runId
    ? (await options.stores.sessionRunLinks.getByRunId(frame.runId)) ??
      (await resolveLatestSessionRunLinkByRootRunId(options.stores, frame.runId))
    : undefined;
  const resolvedSessionId = frame.sessionId ?? initialSessionRunLink?.sessionId;
  if (!resolvedSessionId) {
    throw new ProtocolValidationError(
      'invalid_frame',
      frame.runId
        ? `Run "${frame.runId}" is not linked to a continuable run session.`
        : 'run.continue requires a sessionId when runId is omitted.',
      {
        requestType: frame.type,
        details: frame.runId ? { runId: frame.runId } : undefined,
      },
    );
  }

  const session = await getAuthorizedGatewaySession(resolvedSessionId, {
    authContext: options.authContext,
    stores: options.stores,
    requestType: frame.type,
  });
  await runBeforeHook(options.hooks, 'onSessionResolve', frame.type, {
    authContext: options.authContext,
    session,
    metadata: frame.metadata,
  });
  assertGatewaySessionWriteAllowed(session, frame.type);

  if (session.invocationMode && session.invocationMode !== 'run') {
    throw new ProtocolValidationError(
      'invalid_frame',
      `Session "${session.id}" is not a run session and cannot continue runs.`,
      {
        requestType: frame.type,
        details: {
          sessionId: session.id,
          invocationMode: session.invocationMode ?? null,
        },
      },
    );
  }

  const agentId = session.agentId;
  if (!agentId) {
    throw new ProtocolValidationError(
      'run_failed',
      `Session "${session.id}" does not have a routed agent for run continuation.`,
      {
        requestType: frame.type,
        details: { sessionId: session.id, runId: frame.runId ?? null },
      },
    );
  }

  const agent = await options.agentRegistry.getAgent(agentId);
  if (!agent.agent.getRecoveryOptions || !agent.agent.createContinuationRun || !agent.agent.resume) {
    throw new ProtocolValidationError(
      'run_failed',
      `Agent "${agentId}" does not support run continuation.`,
      {
        requestType: frame.type,
        details: { sessionId: session.id, runId: frame.runId ?? null, agentId },
      },
    );
  }

  const sourceRunId = await resolveContinuationSourceRunId(frame, session, agent, options.stores);
  const sourceRun = await agent.runtime.runStore.getRun(sourceRunId);
  const sourceRootRunId = sourceRun?.rootRunId ?? sourceRunId;
  const recovery = await agent.agent.getRecoveryOptions(sourceRunId);
  if (!recovery.continuable || recovery.requiresReconciliation) {
    throw new ProtocolValidationError(
      'invalid_frame',
      recovery.unsafeReason ?? recovery.reason ?? `Run "${sourceRunId}" is not continuable.`,
      {
        requestType: frame.type,
        details: {
          sessionId: session.id,
          runId: sourceRunId,
          continuable: recovery.continuable,
          requiresReconciliation: recovery.requiresReconciliation ?? false,
          decision: recovery.decision,
          failureClass: recovery.failureClass,
        },
      },
    );
  }

  const runningSession = await tryAcquireGatewaySessionRun(session, {
    stores: options.stores,
    requestType: frame.type,
    expectedAllowedStatuses: ['idle', 'failed'],
    patch: {
      status: 'running',
      currentRunId: sourceRunId,
      currentRootRunId: sourceRootRunId,
      updatedAt: nowIso,
    },
  });
  let admission: AcquiredRunAdmission | undefined;

  try {
    admission = await acquireRunAdmission({
      stores: options.stores,
      concurrency: resolveGatewayConcurrencyConfig(options.gatewayConfig?.concurrency),
      agentId,
      tenantId: runningSession.tenantId,
      sessionId: runningSession.id,
      requestType: frame.type,
      now,
    });

    const continuation = await agent.agent.createContinuationRun({
      fromRunId: sourceRunId,
      ...(frame.strategy ? { strategy: frame.strategy } : {}),
      ...(frame.provider ? { provider: frame.provider } : {}),
      ...(frame.model ? { model: frame.model } : {}),
      ...(frame.requireApproval === undefined ? {} : { requireApproval: frame.requireApproval }),
      metadata: {
        ...(frame.metadata ?? {}),
        gateway: {
          action: 'continue',
          sessionId: runningSession.id,
          agentId,
          sourceRunId,
          ...(frame.provider ? { requestedProvider: frame.provider } : {}),
          ...(frame.model ? { requestedModel: frame.model } : {}),
        },
      },
    });
    const continuationRootRunId =
      (await resolveRootRunId(agent.runtime.runStore, continuation.continuationRunId)) ?? continuation.continuationRunId;

    await options.stores.sessionRunLinks.append({
      sessionId: runningSession.id,
      runId: continuation.continuationRunId,
      rootRunId: continuationRootRunId,
      invocationKind: 'run',
      metadata: frame.metadata,
      createdAt: nowIso,
    });

    const continuationSession = await settleSession(options.stores, runningSession, {
      status: 'running',
      currentRunId: continuation.continuationRunId,
      currentRootRunId: continuationRootRunId,
      updatedAt: nowIso,
    });

    const continueResult = await withForwardedRealtimeEvents(
      agent,
      options.realtimeEvents && !options.hasRuntimeObserver?.(continuationRootRunId)
        ? {
            ...options.realtimeEvents,
            fallbackAgentId: agentId,
            fallbackSessionId: continuationSession.id,
            rootRunId: continuationRootRunId,
          }
        : undefined,
      () => agent.agent.resume!(continuation.continuationRunId),
    );
    const resultRootRunId =
      (await resolveRootRunId(agent.runtime.runStore, continueResult.runId)) ?? continuationRootRunId;

    const response = await settleStructuredRunResult(continueResult, resultRootRunId, {
      agentId,
      session: continuationSession,
      authContext: options.authContext,
      hooks: options.hooks,
      agentRegistry: options.agentRegistry,
      stores: options.stores,
      nowIso,
    });

    await runAfterHook(options.hooks, frame.type, {
      authContext: options.authContext,
      session: continuationSession,
      agentId,
      result: response,
      metadata: frame.metadata,
    });

    return response;
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
      error instanceof Error ? error.message : 'Run continuation failed unexpectedly.',
      {
        requestType: frame.type,
        details: {
          sessionId: runningSession.id,
          runId: sourceRunId,
          agentId,
          ...(frame.provider ? { provider: frame.provider } : {}),
          ...(frame.model ? { model: frame.model } : {}),
        },
      },
    );
  } finally {
    await admission?.release();
  }
}

async function resolveContinuationSourceRunId(
  frame: RunContinueFrame,
  session: GatewaySessionRecord,
  agent: Awaited<ReturnType<AgentRegistry['getAgent']>>,
  stores: GatewayStores,
): Promise<string> {
  if (frame.runId) {
    const sourceRun = await agent.runtime.runStore.getRun(frame.runId);
    const sourceRootRunId = sourceRun?.rootRunId ?? frame.runId;
    const exactLink = await stores.sessionRunLinks.getByRunId(frame.runId);
    const rootLink = await resolveSessionRunLinkByRootRunId(stores, session.id, sourceRootRunId);
    if ((exactLink && exactLink.sessionId === session.id && exactLink.invocationKind === 'run') || rootLink) {
      return frame.runId;
    }

    throw new ProtocolValidationError(
      'invalid_frame',
      `Run "${frame.runId}" is not linked to session "${session.id}" for continuation.`,
      {
        requestType: frame.type,
        details: {
          sessionId: session.id,
          runId: frame.runId,
          rootRunId: sourceRootRunId,
        },
      },
    );
  }

  const links = (await stores.sessionRunLinks.listBySession(session.id)).filter((link) => link.invocationKind === 'run');
  const preferredLinks = session.status === 'failed' && session.lastCompletedRootRunId
    ? links.filter((link) => link.rootRunId === session.lastCompletedRootRunId)
    : [];
  const preferredCandidates = await listContinuableCandidateRunIds(preferredLinks, agent);
  if (preferredCandidates.length === 1) {
    return preferredCandidates[0];
  }
  if (preferredCandidates.length > 1) {
    throw ambiguousContinuationError(frame, session.id, preferredCandidates);
  }

  const candidates = await listContinuableCandidateRunIds(links, agent);
  if (candidates.length === 1) {
    return candidates[0];
  }
  if (candidates.length > 1) {
    throw ambiguousContinuationError(frame, session.id, candidates);
  }

  throw new ProtocolValidationError(
    'invalid_frame',
    `Session "${session.id}" has no continuable failed run. Pass /continue <runId> after checking recovery options.`,
    {
      requestType: frame.type,
      details: { sessionId: session.id },
    },
  );
}

async function listContinuableCandidateRunIds(
  links: SessionRunLinkRecord[],
  agent: Awaited<ReturnType<AgentRegistry['getAgent']>>,
): Promise<string[]> {
  const candidateRunIds: string[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    if (seen.has(link.runId)) {
      continue;
    }
    seen.add(link.runId);

    const run = await agent.runtime.runStore.getRun(link.runId);
    if (run?.status !== 'failed') {
      continue;
    }

    try {
      const recovery = await agent.agent.getRecoveryOptions!(link.runId);
      if (recovery.continuable && !recovery.requiresReconciliation) {
        candidateRunIds.push(link.runId);
      }
    } catch {
      // A run that cannot be analyzed for recovery is not a valid inferred continuation target.
    }
  }

  return candidateRunIds;
}

function ambiguousContinuationError(frame: RunContinueFrame, sessionId: string, candidateRunIds: string[]): ProtocolValidationError {
  return new ProtocolValidationError(
    'invalid_frame',
    `Session "${sessionId}" has multiple continuable failed runs. Use /continue <runId>.`,
    {
      requestType: frame.type,
      details: {
        sessionId,
        candidateRunIds,
      },
    },
  );
}

async function resolveSessionRunLinkByRootRunId(
  stores: GatewayStores,
  sessionId: string,
  rootRunId: string,
): Promise<SessionRunLinkRecord | undefined> {
  const links = await stores.sessionRunLinks.listByRootRunId(rootRunId);
  return links
    .filter((link) => link.sessionId === sessionId && link.invocationKind === 'run')
    .at(-1);
}

async function resolveLatestSessionRunLinkByRootRunId(
  stores: GatewayStores,
  rootRunId: string,
): Promise<SessionRunLinkRecord | undefined> {
  const links = await stores.sessionRunLinks.listByRootRunId(rootRunId);
  return links
    .filter((link) => link.invocationKind === 'run')
    .at(-1);
}

interface ExecuteResolvedGatewayRunOptions {
  agentId: string;
  session?: GatewaySessionRecord;
  authContext?: GatewayAuthContext;
  hooks?: ResolvedGatewayHooks;
  agentRegistry: AgentRegistry;
  stores: GatewayStores;
  imageUploadDir?: string;
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

  let linkedRunId: string | undefined;
  const rememberActiveRun = async (eventFrame: Parameters<RealtimeEventForwardingContext['emitFrame']>[0]) => {
    if (!options.session || linkedRunId || eventFrame.type !== 'agent.event' || !eventFrame.runId || !eventFrame.rootRunId) {
      return;
    }

    const rootRunId = eventFrame.rootRunId;
    linkedRunId = rootRunId;
    await options.stores.sessionRunLinks.append({
      sessionId: options.session.id,
      runId: linkedRunId,
      rootRunId,
      invocationKind: 'run',
      metadata: frame.metadata,
      createdAt: options.nowIso,
    });

    const latestSession = (await options.stores.sessions.get(options.session.id)) ?? options.session;
    if (latestSession.status === 'running' && !latestSession.currentRunId) {
      await options.stores.sessions.update({
        ...latestSession,
        status: 'running',
        currentRunId: linkedRunId,
        currentRootRunId: rootRunId,
        updatedAt: options.nowIso,
      });
    }
  };
  const images = await resolveGatewayImageInputs(frame.images, {
    uploadDir: options.imageUploadDir ?? '',
    authContext: options.authContext,
    requestType: frame.type,
  });

  const runResult = await withForwardedRealtimeEvents(
    agent,
    options.realtimeEvents
      ? {
          ...options.realtimeEvents,
          fallbackAgentId: options.agentId,
          fallbackSessionId: options.session?.id,
          emitFrame: async (eventFrame) => {
            await rememberActiveRun(eventFrame);
            await Promise.resolve(options.realtimeEvents?.emitFrame(eventFrame));
          },
        }
      : undefined,
    () =>
      agent.agent.run!({
        goal: frame.goal,
        input: frame.input,
        images,
        context: buildGatewayRunContext(frame, options.session, options.authContext, options.requestedChannelId),
        metadata: buildGatewayRunMetadata(frame, options.session?.id, options.agentId, options.realtimeEvents?.requestId),
      }),
  );
  const rootRunId = (await resolveRootRunId(agent.runtime.runStore, runResult.runId)) ?? runResult.runId;

  if (options.session && linkedRunId !== runResult.runId) {
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

async function runBeforeHook(
  hooks: ResolvedGatewayHooks | undefined,
  slot: 'onSessionResolve' | 'beforeRoute' | 'beforeRunStart',
  requestType: string,
  context: {
    authContext?: GatewayAuthContext;
    session: GatewaySessionRecord;
    invocationMode?: 'run';
    requestedAgentId?: string;
    agentId?: string;
    metadata?: JsonObject;
  },
): Promise<JsonObject | undefined> {
  if (!hooks) {
    return context.metadata;
  }

  const hookResult = await executeHookSlot(hooks, slot, {
    slot,
    requestType,
    authContext: context.authContext,
    session: context.session,
    invocationMode: context.invocationMode,
    requestedAgentId: context.requestedAgentId,
    agentId: context.agentId,
    metadata: context.metadata,
  });

  if (hookResult.rejected) {
    throw new ProtocolValidationError(
      'invalid_frame',
      hookResult.rejectionReason ?? `Gateway ${slot} hook rejected the request.`,
      {
        requestType,
        details: {
          sessionId: context.session.id,
          channelId: context.session.channelId,
          slot,
        },
      },
    );
  }

  return hookResult.enrichedMetadata ?? context.metadata;
}

async function runBeforeIsolatedRunHook(
  hooks: ResolvedGatewayHooks | undefined,
  slot: 'beforeRoute' | 'beforeRunStart',
  requestType: string,
  context: {
    authContext?: GatewayAuthContext;
    requestedChannelId?: string;
    requestedAgentId?: string;
    metadata?: JsonObject;
  },
): Promise<JsonObject | undefined> {
  if (!hooks) {
    return context.metadata;
  }

  const hookResult = await executeHookSlot(hooks, slot, {
    slot,
    requestType,
    authContext: context.authContext,
    requestedChannelId: context.requestedChannelId,
    requestedAgentId: context.requestedAgentId,
    invocationMode: 'run',
    metadata: context.metadata,
  });

  if (hookResult.rejected) {
    throw new ProtocolValidationError(
      'invalid_frame',
      hookResult.rejectionReason ?? `Gateway ${slot} hook rejected the request.`,
      {
        requestType,
        details: {
          ...(context.requestedChannelId ? { channelId: context.requestedChannelId } : {}),
          ...(context.requestedAgentId ? { agentId: context.requestedAgentId } : {}),
          slot,
        },
      },
    );
  }

  return hookResult.enrichedMetadata ?? context.metadata;
}

async function runAfterHook(
  hooks: ResolvedGatewayHooks | undefined,
  requestType: string,
  context: {
    authContext?: GatewayAuthContext;
    session?: GatewaySessionRecord;
    agentId: string;
    result: RunOutputFrame | ApprovalRequestedFrame;
    metadata?: JsonObject;
  },
): Promise<void> {
  if (!hooks) {
    return;
  }

  await executeHookSlot(hooks, 'afterRunResult', {
    slot: 'afterRunResult',
    requestType,
    authContext: context.authContext,
    session: context.session,
    agentId: context.agentId,
    result: context.result,
    metadata: context.metadata,
  });
}
