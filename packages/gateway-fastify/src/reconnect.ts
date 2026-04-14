import type { AgentRegistry } from './agent-registry.js';
import type { GatewayAuthContext } from './auth.js';
import type { JsonValue, RunResult, RuntimeRunRecord } from './core.js';
import type { OutboundFrame, SessionOpenedFrame, SessionUpdatedFrame } from './protocol.js';
import { ProtocolValidationError } from './protocol.js';
import type { GatewaySessionRecord, GatewayStores, SessionRunLinkRecord } from './stores.js';

export interface ReconnectRecoveryResult {
  session: GatewaySessionRecord;
  sessionOpened: SessionOpenedFrame;
  sessionUpdated: SessionUpdatedFrame;
  pendingApproval?: PendingApprovalState;
  channels: string[];
  recoveryFrame?: OutboundFrame;
  policy: ReconnectRuntimePolicy;
}

export interface PendingApprovalState {
  runId: string;
  rootRunId: string;
  sessionId: string;
}

export interface RestoreActiveSessionOptions {
  stores: GatewayStores;
  agentRegistry?: AgentRegistry;
  authContext?: GatewayAuthContext;
  now?: () => Date;
}

export type ReconnectRuntimePolicy =
  | 'session_only'
  | 'pending_approval'
  | 'pending_clarification'
  | 'terminal_result'
  | 'terminal_replay'
  | 'resumed'
  | 'observer'
  | 'resume_unavailable'
  | 'run_missing';

export async function restoreActiveSession(
  sessionId: string,
  options: RestoreActiveSessionOptions,
): Promise<ReconnectRecoveryResult> {
  if (!options.authContext) {
    throw new ProtocolValidationError(
      'auth_required',
      'An authenticated principal is required to restore a session.',
      { requestType: 'session.open', details: { sessionId } },
    );
  }

  const session = await options.stores.sessions.get(sessionId);
  if (!session) {
    throw new ProtocolValidationError(
      'session_not_found',
      `Session "${sessionId}" does not exist.`,
      { requestType: 'session.open', details: { sessionId } },
    );
  }

  if (session.authSubject !== options.authContext.subject) {
    throw new ProtocolValidationError(
      'session_forbidden',
      `Session "${sessionId}" belongs to a different authenticated principal.`,
      { requestType: 'session.open', details: { sessionId } },
    );
  }

  const now = (options.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  let updatedSession = await options.stores.sessions.update({
    ...session,
    updatedAt: nowIso,
  });
  updatedSession = await relinkSessionFromLatestRun(updatedSession, {
    stores: options.stores,
    nowIso,
  });

  let policy: ReconnectRuntimePolicy = 'session_only';
  let recoveryFrame: OutboundFrame | undefined;

  if (updatedSession.currentRunId && updatedSession.agentId && options.agentRegistry) {
    const recovery = await recoverRuntimeState(updatedSession, {
      agentRegistry: options.agentRegistry,
      stores: options.stores,
      now,
      nowIso,
    });
    updatedSession = recovery.session;
    policy = recovery.policy;
    recoveryFrame = recovery.recoveryFrame;
  } else if (updatedSession.status === 'awaiting_approval' && updatedSession.currentRunId) {
    policy = 'pending_approval';
  } else if (updatedSession.agentId && options.agentRegistry) {
    const recovery = await recoverTerminalReplay(updatedSession, {
      agentRegistry: options.agentRegistry,
      stores: options.stores,
    });
    policy = recovery.policy;
    recoveryFrame = recovery.recoveryFrame;
  }

  const sessionOpened = toSessionOpenedFrame(updatedSession);
  const sessionUpdated = toSessionUpdatedFrame(updatedSession);
  const channels = buildReconnectChannels(updatedSession);
  const pendingApproval = buildPendingApproval(updatedSession);

  return {
    session: updatedSession,
    sessionOpened,
    sessionUpdated,
    pendingApproval,
    channels,
    recoveryFrame,
    policy,
  };
}

async function recoverTerminalReplay(
  session: GatewaySessionRecord,
  options: {
    agentRegistry: AgentRegistry;
    stores: GatewayStores;
  },
): Promise<{
  recoveryFrame?: OutboundFrame;
  policy: ReconnectRuntimePolicy;
}> {
  if (session.status !== 'idle' && session.status !== 'failed') {
    return { policy: 'session_only' };
  }

  const latestRunLink = await findLatestCompletedRunLink(session, options.stores);
  if (!latestRunLink) {
    return { policy: 'session_only' };
  }

  const agent = await options.agentRegistry.getAgent(session.agentId!);
  const run =
    (await agent.runtime.runStore.getRun(latestRunLink.runId)) ??
    (latestRunLink.rootRunId !== latestRunLink.runId
      ? await agent.runtime.runStore.getRun(latestRunLink.rootRunId)
      : null);

  if (!run || !isTerminalRuntimeStatus(run.status)) {
    return { policy: 'session_only' };
  }

  return {
    policy: 'terminal_replay',
    recoveryFrame: runtimeRunToOutputFrame(run, session.id, run.rootRunId ?? latestRunLink.rootRunId),
  };
}

async function findLatestCompletedRunLink(
  session: GatewaySessionRecord,
  stores: GatewayStores,
): Promise<SessionRunLinkRecord | undefined> {
  const links = await stores.sessionRunLinks.listBySession(session.id);
  const runLinks = links.filter((link) => link.invocationKind === 'run');
  const completedRootRunId = session.lastCompletedRootRunId;

  if (completedRootRunId) {
    const matchingLinks = runLinks.filter((link) => link.rootRunId === completedRootRunId || link.runId === completedRootRunId);
    if (matchingLinks.length > 0) {
      return matchingLinks.at(-1);
    }
  }

  return runLinks.at(-1);
}

async function relinkSessionFromLatestRun(
  session: GatewaySessionRecord,
  options: {
    stores: GatewayStores;
    nowIso: string;
  },
): Promise<GatewaySessionRecord> {
  if (!shouldRelinkSessionFromLatestRun(session)) {
    return session;
  }

  const links = await options.stores.sessionRunLinks.listBySession(session.id);
  const latestRunLink = links
    .filter((link) => link.invocationKind === 'run')
    .at(-1);

  if (!latestRunLink) {
    return session;
  }

  return updateSession(options.stores, session, {
    currentRunId: latestRunLink.runId,
    currentRootRunId: latestRunLink.rootRunId,
    updatedAt: options.nowIso,
  });
}

function shouldRelinkSessionFromLatestRun(session: GatewaySessionRecord): boolean {
  if (session.currentRunId) {
    return false;
  }

  return session.status === 'running' || session.status === 'failed' || session.status === 'awaiting_approval';
}

async function recoverRuntimeState(
  session: GatewaySessionRecord,
  options: {
    agentRegistry: AgentRegistry;
    stores: GatewayStores;
    now: Date;
    nowIso: string;
  },
): Promise<{
  session: GatewaySessionRecord;
  recoveryFrame?: OutboundFrame;
  policy: ReconnectRuntimePolicy;
}> {
  const activeRunId = session.currentRunId;
  const agentId = session.agentId;
  if (!activeRunId || !agentId) {
    return { session, policy: 'session_only' };
  }

  const agent = await options.agentRegistry.getAgent(agentId);
  const run = await agent.runtime.runStore.getRun(activeRunId);
  if (!run) {
    const failedSession = await updateSession(options.stores, session, {
      status: 'failed',
      currentRunId: undefined,
      currentRootRunId: undefined,
      updatedAt: options.nowIso,
    });
    return {
      session: failedSession,
      policy: 'run_missing',
      recoveryFrame: {
        type: 'run.output',
        runId: activeRunId,
        rootRunId: session.currentRootRunId ?? activeRunId,
        sessionId: session.id,
        status: 'failed',
        error: `Run "${activeRunId}" is no longer available for reconnect.`,
      },
    };
  }

  const rootRunId = run.rootRunId ?? session.currentRootRunId ?? activeRunId;
  if (isTerminalRuntimeStatus(run.status)) {
    const settledSession = await updateSession(options.stores, session, {
      status: run.status === 'succeeded' ? 'idle' : 'failed',
      currentRunId: undefined,
      currentRootRunId: undefined,
      lastCompletedRootRunId: rootRunId,
      updatedAt: options.nowIso,
    });
    return {
      session: settledSession,
      policy: 'terminal_result',
      recoveryFrame: runtimeRunToOutputFrame(run, session.id, rootRunId),
    };
  }

  if (run.status === 'awaiting_approval') {
    const approvalSession = await updateSession(options.stores, session, {
      status: 'awaiting_approval',
      currentRunId: activeRunId,
      currentRootRunId: rootRunId,
      updatedAt: options.nowIso,
    });
    return { session: approvalSession, policy: 'pending_approval' };
  }

  if (run.status === 'clarification_requested') {
    return {
      session,
      policy: 'pending_clarification',
      recoveryFrame: {
        type: 'run.output',
        runId: run.id,
        rootRunId,
        sessionId: session.id,
        status: 'succeeded',
        output: run.result ?? {
          status: 'clarification_requested',
          message: run.errorMessage ?? 'Clarification requested',
          suggestedQuestions: [],
        },
      },
    };
  }

  if (isActiveRuntimeStatus(run.status) && isLeaseExpired(run, options.now)) {
    if (!agent.agent.resume) {
      return { session, policy: 'resume_unavailable' };
    }

    const resumedResult = await agent.agent.resume(activeRunId);
    const recoveryFrame = runResultToRecoveryFrame(resumedResult, rootRunId, session.id);
    const resumedSession = await updateSessionForRunResult(options.stores, session, resumedResult, rootRunId, options.nowIso);

    return {
      session: resumedSession,
      policy: 'resumed',
      recoveryFrame,
    };
  }

  if (isActiveRuntimeStatus(run.status)) {
    const observerSession = await updateSession(options.stores, session, {
      status: 'running',
      currentRunId: activeRunId,
      currentRootRunId: rootRunId,
      updatedAt: options.nowIso,
    });
    return { session: observerSession, policy: 'observer' };
  }

  return { session, policy: 'session_only' };
}

function buildPendingApproval(session: GatewaySessionRecord): PendingApprovalState | undefined {
  if (session.status !== 'awaiting_approval' || !session.currentRunId) {
    return undefined;
  }

  return {
    runId: session.currentRunId,
    rootRunId: session.currentRootRunId ?? session.currentRunId,
    sessionId: session.id,
  };
}

function toSessionOpenedFrame(session: GatewaySessionRecord): SessionOpenedFrame {
  return {
    type: 'session.opened',
    sessionId: session.id,
    channelId: session.channelId,
    agentId: session.agentId,
    ...(session.invocationMode ? { invocationMode: session.invocationMode } : {}),
    status: session.status,
  };
}

function toSessionUpdatedFrame(session: GatewaySessionRecord): SessionUpdatedFrame {
  return {
    type: 'session.updated',
    sessionId: session.id,
    status: session.status,
    ...(session.invocationMode ? { invocationMode: session.invocationMode } : {}),
    transcriptVersion: session.transcriptVersion,
    activeRunId: session.currentRunId,
    activeRootRunId: session.currentRootRunId,
  };
}

function buildReconnectChannels(session: GatewaySessionRecord): string[] {
  const channels: string[] = [`session:${session.id}`];

  if (session.currentRootRunId) {
    channels.push(`root-run:${session.currentRootRunId}`);
  }

  if (session.currentRunId && session.currentRunId !== session.currentRootRunId) {
    channels.push(`run:${session.currentRunId}`);
  }

  if (session.agentId) {
    channels.push(`agent:${session.agentId}`);
  }

  return channels;
}

async function updateSession(
  stores: GatewayStores,
  session: GatewaySessionRecord,
  patch: Partial<GatewaySessionRecord>,
): Promise<GatewaySessionRecord> {
  return stores.sessions.update({
    ...session,
    ...patch,
  });
}

async function updateSessionForRunResult(
  stores: GatewayStores,
  session: GatewaySessionRecord,
  result: RunResult,
  rootRunId: string,
  updatedAt: string,
): Promise<GatewaySessionRecord> {
  switch (result.status) {
    case 'success':
    case 'clarification_requested':
      return updateSession(stores, session, {
        status: 'idle',
        currentRunId: undefined,
        currentRootRunId: undefined,
        lastCompletedRootRunId: rootRunId,
        updatedAt,
      });
    case 'failure':
      return updateSession(stores, session, {
        status: 'failed',
        currentRunId: undefined,
        currentRootRunId: undefined,
        lastCompletedRootRunId: rootRunId,
        updatedAt,
      });
    case 'approval_requested':
      return updateSession(stores, session, {
        status: 'awaiting_approval',
        currentRunId: result.runId,
        currentRootRunId: rootRunId,
        updatedAt,
      });
  }
}

function runResultToRecoveryFrame(result: RunResult, rootRunId: string, sessionId: string): OutboundFrame {
  switch (result.status) {
    case 'success':
      return {
        type: 'run.output',
        runId: result.runId,
        rootRunId,
        sessionId,
        status: 'succeeded',
        output: result.output,
      };
    case 'failure':
      return {
        type: 'run.output',
        runId: result.runId,
        rootRunId,
        sessionId,
        status: 'failed',
        error: result.error,
      };
    case 'approval_requested':
      return {
        type: 'approval.requested',
        runId: result.runId,
        rootRunId,
        sessionId,
        toolName: result.toolName,
        reason: result.message,
      };
    case 'clarification_requested':
      return {
        type: 'run.output',
        runId: result.runId,
        rootRunId,
        sessionId,
        status: 'succeeded',
        output: serializeClarificationRequest(result),
      };
  }
}

function runtimeRunToOutputFrame(run: RuntimeRunRecord, sessionId: string, rootRunId: string): OutboundFrame {
  if (run.status === 'succeeded') {
    return {
      type: 'run.output',
      runId: run.id,
      rootRunId,
      sessionId,
      status: 'succeeded',
      output: run.result,
    };
  }

  return {
    type: 'run.output',
    runId: run.id,
    rootRunId,
    sessionId,
    status: 'failed',
    error: run.errorMessage ?? `Run finished with status "${run.status}".`,
  };
}

function serializeClarificationRequest(result: Extract<RunResult, { status: 'clarification_requested' }>): JsonValue {
  return {
    status: result.status,
    message: result.message,
    suggestedQuestions: result.suggestedQuestions ?? [],
  };
}

function isTerminalRuntimeStatus(status: string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function isActiveRuntimeStatus(status: string): boolean {
  return status === 'running' || status === 'awaiting_subagent' || status === 'planning' || status === 'queued';
}

function isLeaseExpired(run: RuntimeRunRecord, now: Date): boolean {
  if (!run.leaseOwner) {
    return true;
  }

  if (!run.leaseExpiresAt) {
    return true;
  }

  return new Date(run.leaseExpiresAt).getTime() <= now.getTime();
}
