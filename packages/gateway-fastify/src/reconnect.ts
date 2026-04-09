import type { GatewayAuthContext } from './auth.js';
import type { SessionOpenedFrame, SessionUpdatedFrame } from './protocol.js';
import { ProtocolValidationError } from './protocol.js';
import type { GatewaySessionRecord, GatewayStores, SessionRunLinkRecord } from './stores.js';

export interface ReconnectRecoveryResult {
  sessionOpened: SessionOpenedFrame;
  sessionUpdated: SessionUpdatedFrame;
  pendingApproval?: PendingApprovalState;
  channels: string[];
}

export interface PendingApprovalState {
  runId: string;
  rootRunId: string;
  sessionId: string;
}

export interface RestoreActiveSessionOptions {
  stores: GatewayStores;
  authContext?: GatewayAuthContext;
  now?: () => Date;
}

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

  const nowIso = (options.now ?? (() => new Date()))().toISOString();
  const updatedSession = await options.stores.sessions.update({
    ...session,
    updatedAt: nowIso,
  });

  const sessionOpened = toSessionOpenedFrame(updatedSession);
  const sessionUpdated = toSessionUpdatedFrame(updatedSession);

  const channels = buildReconnectChannels(updatedSession);

  let pendingApproval: PendingApprovalState | undefined;
  if (updatedSession.status === 'awaiting_approval' && updatedSession.currentRunId) {
    pendingApproval = {
      runId: updatedSession.currentRunId,
      rootRunId: updatedSession.currentRootRunId ?? updatedSession.currentRunId,
      sessionId: updatedSession.id,
    };
  }

  return {
    sessionOpened,
    sessionUpdated,
    pendingApproval,
    channels,
  };
}

function toSessionOpenedFrame(session: GatewaySessionRecord): SessionOpenedFrame {
  return {
    type: 'session.opened',
    sessionId: session.id,
    channelId: session.channelId,
    agentId: session.agentId,
    status: session.status,
  };
}

function toSessionUpdatedFrame(session: GatewaySessionRecord): SessionUpdatedFrame {
  return {
    type: 'session.updated',
    sessionId: session.id,
    status: session.status,
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
