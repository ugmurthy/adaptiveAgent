import type {
  JsonRpcError,
  PublicGatewayError,
  PublicGatewayErrorCode,
} from '@adaptive-agent/gateway-protocol';

const RETRYABLE_CODES = new Set<PublicGatewayErrorCode>([
  'rate_limited',
  'provider_unavailable',
  'provider_timeout',
]);

const PUBLIC_MESSAGES: Record<PublicGatewayErrorCode, string> = {
  unauthenticated: 'Authentication is required',
  token_expired: 'The access token has expired',
  forbidden: 'The request is not authorized',
  tier_not_entitled: 'The requested inference tier is not entitled',
  capability_not_entitled: 'The requested capability is not available',
  invalid_params: 'The request parameters are invalid',
  idempotency_conflict: 'The idempotency key was reused with different content',
  quota_exceeded: 'The account quota has been exceeded',
  rate_limited: 'The request is rate limited',
  provider_unavailable: 'The model provider is unavailable',
  provider_timeout: 'The model provider timed out',
  cancelled: 'The request was cancelled',
  internal_error: 'The gateway could not complete the request',
};

const JSON_RPC_CODES: Record<PublicGatewayErrorCode, number> = {
  unauthenticated: -32001,
  token_expired: -32002,
  forbidden: -32003,
  tier_not_entitled: -32004,
  capability_not_entitled: -32005,
  invalid_params: -32602,
  idempotency_conflict: -32006,
  quota_exceeded: -32007,
  rate_limited: -32008,
  provider_unavailable: -32009,
  provider_timeout: -32010,
  cancelled: -32011,
  internal_error: -32603,
};

export interface GatewayErrorOptions {
  retryable?: boolean;
  retryAfterMs?: number;
  callId?: string;
  idempotencyKey?: string;
  cause?: unknown;
}

export class GatewayError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly callId?: string;
  readonly idempotencyKey?: string;

  constructor(
    readonly gatewayCode: PublicGatewayErrorCode,
    options: GatewayErrorOptions = {},
  ) {
    super(PUBLIC_MESSAGES[gatewayCode], { cause: options.cause });
    this.name = 'GatewayError';
    this.retryable = options.retryable ?? RETRYABLE_CODES.has(gatewayCode);
    this.retryAfterMs = options.retryAfterMs;
    this.callId = options.callId;
    this.idempotencyKey = options.idempotencyKey;
  }

  toPublic(traceId: string): PublicGatewayError {
    return {
      gatewayCode: this.gatewayCode,
      retryable: this.retryable,
      traceId,
      ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
      ...(this.callId === undefined ? {} : { callId: this.callId }),
      ...(this.idempotencyKey === undefined ? {} : { idempotencyKey: this.idempotencyKey }),
    };
  }

  toJsonRpc(traceId: string): JsonRpcError {
    return {
      code: JSON_RPC_CODES[this.gatewayCode],
      message: this.message,
      data: this.toPublic(traceId),
    };
  }
}

export function gatewayError(error: unknown): GatewayError {
  return error instanceof GatewayError
    ? error
    : new GatewayError('internal_error', { cause: error });
}
