import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { FastifyRequest } from 'fastify';
import type { ServiceActor } from '@adaptive-agent/service-sdk';

export type HttpAuthenticator = (request: FastifyRequest) => Promise<ServiceActor>;
export interface JwtAuthOptions { issuer: string; audience: string; jwksUrl?: string; hmacSecret?: string; tenantClaim?: string }

export function createJwtAuthenticator(options: JwtAuthOptions): HttpAuthenticator {
  if (!options.issuer || !options.audience || (!options.jwksUrl && !options.hmacSecret) || (options.jwksUrl && options.hmacSecret)) {
    throw new Error('JWT issuer, audience, and exactly one of JWKS URL or HMAC secret are required');
  }
  if (options.hmacSecret && new TextEncoder().encode(options.hmacSecret).byteLength < 32) throw new Error('JWT HMAC secret must be at least 32 bytes');
  const remoteKey = options.jwksUrl ? createRemoteJWKSet(new URL(options.jwksUrl)) : undefined;
  const localKey = options.hmacSecret ? new TextEncoder().encode(options.hmacSecret) : undefined;
  return async request => {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ') || authorization.length === 7) throw new Error('unauthorized');
    const token=authorization.slice(7);
    const algorithms = remoteKey ? ['RS256','PS256','ES256'] : ['HS256'];
    const verified = remoteKey
      ? await jwtVerify(token, remoteKey, { issuer:options.issuer, audience:options.audience, algorithms, requiredClaims:['exp'] })
      : await jwtVerify(token, localKey!, { issuer:options.issuer, audience:options.audience, algorithms, requiredClaims:['exp'] });
    const { payload } = verified;
    const tenant = payload[options.tenantClaim ?? 'tenant_id'];
    if (typeof payload.sub !== 'string' || !payload.sub.trim() || typeof tenant !== 'string' || !tenant.trim()) throw new Error('unauthorized');
    return { userId: payload.sub, tenantId: tenant };
  };
}
