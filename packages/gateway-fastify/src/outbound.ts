import type { GatewayAuthContext } from './auth.js';
import type { ChannelSubscription } from './channels.js';
import type { JsonObject, JsonValue } from './core.js';
import type { AgentEventFrame, OutboundFrame } from './protocol.js';
import { ProtocolValidationError } from './protocol.js';
import type { GatewaySessionRecord, GatewayStores } from './stores.js';

const SENSITIVE_CLAIM_KEYS = new Set([
  'iat',
  'exp',
  'nbf',
  'jti',
  'iss',
  'aud',
  'password',
  'secret',
  'token',
  'apiKey',
  'api_key',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'privateKey',
  'private_key',
]);

export interface AuthorizeChannelSubscriptionOptions {
  authContext?: GatewayAuthContext;
  stores: GatewayStores;
  requestType: string;
}

export interface OutboundDeliveryContext {
  authContext?: GatewayAuthContext;
  sessionId?: string;
}

export async function authorizeChannelSubscription(
  subscription: ChannelSubscription,
  options: AuthorizeChannelSubscriptionOptions,
): Promise<void> {
  if (!options.authContext) {
    throw new ProtocolValidationError(
      'auth_required',
      `An authenticated principal is required to subscribe to channel "${subscription.channel}".`,
      {
        requestType: options.requestType,
        details: { channel: subscription.channel },
      },
    );
  }

  if (subscription.scope === 'session') {
    const session = await options.stores.sessions.get(subscription.id);
    if (!session) {
      throw new ProtocolValidationError(
        'session_not_found',
        `Cannot subscribe to channel "${subscription.channel}": session does not exist.`,
        {
          requestType: options.requestType,
          details: { channel: subscription.channel },
        },
      );
    }

    if (session.authSubject !== options.authContext.subject) {
      throw new ProtocolValidationError(
        'session_forbidden',
        `Cannot subscribe to channel "${subscription.channel}": session belongs to a different principal.`,
        {
          requestType: options.requestType,
          details: { channel: subscription.channel },
        },
      );
    }
  }
}

export function authorizeOutboundDelivery(
  subscription: ChannelSubscription,
  event: AgentEventFrame,
  context: OutboundDeliveryContext,
): boolean {
  if (!context.authContext) {
    return false;
  }

  if (subscription.scope === 'session') {
    return event.sessionId === subscription.id;
  }

  return true;
}

export function redactSensitiveMetadata(frame: AgentEventFrame): AgentEventFrame {
  return {
    ...frame,
    data: redactValue(frame.data),
  };
}

function redactValue(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(redactValue);
  }

  const redacted: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_CLAIM_KEYS.has(key)) {
      redacted[key] = '[REDACTED]';
    } else {
      redacted[key] = redactValue(entry);
    }
  }

  return redacted;
}

export function redactAuthClaims(authContext: GatewayAuthContext): JsonObject {
  const safe: JsonObject = {
    subject: authContext.subject,
    roles: authContext.roles,
  };

  if (authContext.tenantId) {
    safe.tenantId = authContext.tenantId;
  }

  return safe;
}
