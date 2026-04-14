import { randomUUID } from 'node:crypto';

import type { GatewayAuthContext } from './auth.js';
import type { SessionOpenFrame, SessionOpenedFrame } from './protocol.js';
import { ProtocolValidationError } from './protocol.js';
import type { GatewaySessionRecord, GatewayStores } from './stores.js';

export interface OpenGatewaySessionOptions {
  authContext?: GatewayAuthContext;
  stores: GatewayStores;
  now?: () => Date;
  sessionIdFactory?: () => string;
}

export interface GetAuthorizedGatewaySessionOptions {
  authContext?: GatewayAuthContext;
  stores: GatewayStores;
  requestType: string;
  expectedChannelId?: string;
}

export interface AssertGatewaySessionWriteAllowedOptions {
  allowPendingApprovalRunId?: string;
}

export async function openGatewaySession(
  frame: SessionOpenFrame,
  options: OpenGatewaySessionOptions,
): Promise<SessionOpenedFrame> {
  const authContext = options.authContext;
  if (!authContext) {
    throw new ProtocolValidationError(
      'auth_required',
      'An authenticated principal is required to open or reattach a session.',
      {
        requestType: frame.type,
        details: { channelId: frame.channelId },
      },
    );
  }

  const now = (options.now ?? (() => new Date()))().toISOString();
  if (frame.sessionId) {
    return openExistingSession(frame, options.stores, authContext, now);
  }

  const session: GatewaySessionRecord = {
    id: (options.sessionIdFactory ?? randomUUID)(),
    channelId: frame.channelId,
    authSubject: authContext.subject,
    tenantId: authContext.tenantId,
    status: 'idle',
    currentRunId: undefined,
    currentRootRunId: undefined,
    lastCompletedRootRunId: undefined,
    transcriptVersion: 0,
    transcriptSummary: undefined,
    metadata: frame.metadata,
    createdAt: now,
    updatedAt: now,
  };

  const storedSession = await options.stores.sessions.create(session);
  return toSessionOpenedFrame(storedSession);
}

async function openExistingSession(
  frame: SessionOpenFrame,
  stores: GatewayStores,
  authContext: GatewayAuthContext,
  now: string,
): Promise<SessionOpenedFrame> {
  const session = await getAuthorizedGatewaySession(frame.sessionId!, {
    authContext,
    stores,
    requestType: frame.type,
    expectedChannelId: frame.channelId,
  });

  const updatedSession: GatewaySessionRecord = {
    ...session,
    updatedAt: now,
  };

  const storedSession = await stores.sessions.update(updatedSession);
  return toSessionOpenedFrame(storedSession);
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

export async function getAuthorizedGatewaySession(
  sessionId: string,
  options: GetAuthorizedGatewaySessionOptions,
): Promise<GatewaySessionRecord> {
  if (!options.authContext) {
    throw new ProtocolValidationError(
      'auth_required',
      `An authenticated principal is required to access session "${sessionId}".`,
      {
        requestType: options.requestType,
        details: { sessionId },
      },
    );
  }

  const session = await options.stores.sessions.get(sessionId);
  if (!session) {
    throw new ProtocolValidationError('session_not_found', `Session "${sessionId}" does not exist.`, {
      requestType: options.requestType,
      details: { sessionId },
    });
  }

  if (session.authSubject !== options.authContext.subject) {
    throw new ProtocolValidationError(
      'session_forbidden',
      `Session "${sessionId}" belongs to a different authenticated principal.`,
      {
        requestType: options.requestType,
        details: {
          sessionId,
          channelId: session.channelId,
        },
      },
    );
  }

  if (options.expectedChannelId && session.channelId !== options.expectedChannelId) {
    throw new ProtocolValidationError(
      'invalid_frame',
      `Session "${sessionId}" belongs to channel "${session.channelId}", not "${options.expectedChannelId}".`,
      {
        requestType: options.requestType,
        details: {
          sessionId,
          channelId: options.expectedChannelId,
          expectedChannelId: session.channelId,
        },
      },
    );
  }

  return session;
}

export function assertGatewayPendingApproval(
  session: GatewaySessionRecord,
  runId: string,
  requestType: string,
): void {
  if (session.status !== 'awaiting_approval' || !session.currentRunId) {
    throw new ProtocolValidationError(
      'invalid_frame',
      `Session "${session.id}" is not awaiting approval for frame type "${requestType}".`,
      {
        requestType,
        details: {
          sessionId: session.id,
          status: session.status,
          currentRunId: session.currentRunId ?? null,
        },
      },
    );
  }

  if (session.currentRunId !== runId) {
    throw new ProtocolValidationError(
      'invalid_frame',
      `Session "${session.id}" is awaiting approval for run "${session.currentRunId}", not "${runId}".`,
      {
        requestType,
        details: {
          sessionId: session.id,
          runId,
          currentRunId: session.currentRunId,
        },
      },
    );
  }
}

export function assertGatewaySessionWriteAllowed(
  session: GatewaySessionRecord,
  requestType: string,
  options: AssertGatewaySessionWriteAllowedOptions = {},
): void {
  if (session.status === 'running') {
    throw new ProtocolValidationError(
      'session_busy',
      `Session "${session.id}" already has an active root run and cannot accept frame type "${requestType}".`,
      {
        requestType,
        details: {
          sessionId: session.id,
          status: session.status,
          currentRunId: session.currentRunId ?? null,
          currentRootRunId: session.currentRootRunId ?? null,
        },
      },
    );
  }

  if (options.allowPendingApprovalRunId) {
    assertGatewayPendingApproval(session, options.allowPendingApprovalRunId, requestType);
    return;
  }

  if (session.status === 'awaiting_approval') {
    throw new ProtocolValidationError(
      'approval_required',
      `Session "${session.id}" is awaiting approval and only approval.resolve may mutate it.`,
      {
        requestType,
        details: {
          sessionId: session.id,
          status: session.status,
          currentRunId: session.currentRunId ?? null,
          currentRootRunId: session.currentRootRunId ?? null,
        },
      },
    );
  }
}
