import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
} from 'jose';
import {
  INFERENCE_TIERS,
  type InferenceMode,
  type InferenceTier,
} from '@adaptive-agent/gateway-protocol';
import { GatewayError } from './errors.js';

const INFERENCE_MODES = ['gateway', 'local', 'byok'] as const;

export interface GatewayPrincipal {
  subject: string;
  accountId: string;
  tenantId: string;
  allowedTiers: InferenceTier[];
  permittedModes: InferenceMode[];
  expiresAtEpochSeconds: number;
}

export type GatewayAuthenticator = (
  authorizationHeader: string | null,
) => Promise<GatewayPrincipal>;

interface JwtClaimOptions {
  issuer: string;
  audience: string;
  accountClaim?: string;
  tenantClaim?: string;
  tiersClaim?: string;
  modesClaim?: string;
}

export type JwtAuthOptions = JwtClaimOptions & (
  | { hmacSecret: string; jwksUrl?: never }
  | { jwksUrl: string; hmacSecret?: never }
);

export function createJwtAuthenticator(options: JwtAuthOptions): GatewayAuthenticator {
  if (!options.issuer.trim() || !options.audience.trim()) {
    throw new Error('JWT issuer and audience are required');
  }
  if (Boolean(options.hmacSecret) === Boolean(options.jwksUrl)) {
    throw new Error('Configure exactly one JWT HMAC secret or JWKS URL');
  }
  if (options.hmacSecret && new TextEncoder().encode(options.hmacSecret).byteLength < 32) {
    throw new Error('JWT HMAC secret must be at least 32 bytes');
  }

  const hmacKey = options.hmacSecret
    ? new TextEncoder().encode(options.hmacSecret)
    : undefined;
  const jwks = options.jwksUrl
    ? createRemoteJWKSet(new URL(options.jwksUrl))
    : undefined;

  return async (authorizationHeader) => {
    const token = readBearerToken(authorizationHeader);
    try {
      const verified = hmacKey
        ? await jwtVerify(token, hmacKey, {
            issuer: options.issuer,
            audience: options.audience,
            algorithms: ['HS256'],
            requiredClaims: ['exp', 'sub'],
          })
        : await jwtVerify(token, jwks!, {
            issuer: options.issuer,
            audience: options.audience,
            algorithms: ['RS256', 'PS256', 'ES256'],
            requiredClaims: ['exp', 'sub'],
          });
      return principalFromPayload(verified.payload, options);
    } catch (error) {
      if (error instanceof GatewayError) {
        throw error;
      }
      if (error instanceof joseErrors.JWTExpired) {
        throw new GatewayError('token_expired');
      }
      throw new GatewayError('unauthenticated', { cause: error });
    }
  };
}

function readBearerToken(header: string | null): string {
  if (!header || !/^Bearer [^\s,]+$/.test(header)) {
    throw new GatewayError('unauthenticated');
  }
  return header.slice('Bearer '.length);
}

function principalFromPayload(
  payload: JWTPayload,
  options: JwtClaimOptions,
): GatewayPrincipal {
  const subject = nonEmptyClaim(payload.sub);
  const accountId = nonEmptyClaim(payload[options.accountClaim ?? 'account_id']);
  const tenantId = nonEmptyClaim(payload[options.tenantClaim ?? 'tenant_id']);
  if (!subject || !accountId || !tenantId || typeof payload.exp !== 'number') {
    throw new GatewayError('unauthenticated');
  }

  const allowedTiers = enumArrayClaim(
    payload[options.tiersClaim ?? 'allowed_tiers'],
    INFERENCE_TIERS,
  );
  const permittedModes = enumArrayClaim(
    payload[options.modesClaim ?? 'permitted_modes'],
    INFERENCE_MODES,
  );
  if (allowedTiers.length === 0 || permittedModes.length === 0) {
    throw new GatewayError('forbidden');
  }

  return {
    subject,
    accountId,
    tenantId,
    allowedTiers,
    permittedModes,
    expiresAtEpochSeconds: payload.exp,
  };
}

function nonEmptyClaim(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.trim() &&
    new TextEncoder().encode(value).byteLength <= 256
    ? value
    : undefined;
}

function enumArrayClaim<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T[] {
  if (!Array.isArray(value) || value.some((entry) => !allowed.includes(entry as T))) {
    throw new GatewayError('forbidden');
  }
  const selected = new Set(value as T[]);
  return allowed.filter((entry) => selected.has(entry));
}
