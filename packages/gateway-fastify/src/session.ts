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
  const sessionId = frame.sessionId!;
  const session = await stores.sessions.get(sessionId);
  if (!session) {
    throw new ProtocolValidationError('session_not_found', `Session "${sessionId}" does not exist.`, {
      requestType: frame.type,
      details: {
        sessionId,
        channelId: frame.channelId,
      },
    });
  }

  if (session.authSubject !== authContext.subject) {
    throw new ProtocolValidationError(
      'session_forbidden',
      `Session "${sessionId}" belongs to a different authenticated principal.`,
      {
        requestType: frame.type,
        details: {
          sessionId,
          channelId: session.channelId,
        },
      },
    );
  }

  if (session.channelId !== frame.channelId) {
    throw new ProtocolValidationError(
      'invalid_frame',
      `Session "${sessionId}" belongs to channel "${session.channelId}", not "${frame.channelId}".`,
      {
        requestType: frame.type,
        details: {
          sessionId,
          channelId: frame.channelId,
          expectedChannelId: session.channelId,
        },
      },
    );
  }

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
    status: session.status,
  };
}
