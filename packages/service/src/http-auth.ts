import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { FastifyRequest } from 'fastify';
import type { ServiceActor } from '@adaptive-agent/service-sdk';

export type HttpAuthenticator = (request: FastifyRequest) => Promise<ServiceActor>;
export interface JwtAuthOptions { issuer: string; audience: string; jwksUrl?: string; hmacSecret?: string; tenantClaim?: string; roleClaim?:string; adminRole?:string }

export function createJwtAuthenticator(options: JwtAuthOptions): HttpAuthenticator {
  if (!options.issuer || !options.audience || (!options.jwksUrl && !options.hmacSecret) || (options.jwksUrl && options.hmacSecret)) {
    throw new Error('JWT issuer, audience, and exactly one of JWKS URL or HMAC secret are required');
  }
  if (options.hmacSecret && new TextEncoder().encode(options.hmacSecret).byteLength < 32) throw new Error('JWT HMAC secret must be at least 32 bytes');
  const remoteKey = options.jwksUrl ? createRemoteJWKSet(new URL(options.jwksUrl)) : undefined;
  const localKey = options.hmacSecret ? new TextEncoder().encode(options.hmacSecret) : undefined;
  return async request => {
    const authorization = request.headers.authorization;
    const protocols=String(request.headers['sec-websocket-protocol']??'').split(',').map(x=>x.trim()).filter(Boolean);
    const credentials=request.url.split('?')[0]==='/v1/ws'?protocols.filter(x=>x.startsWith('bearer.')&&x.length>7):[];
    if(credentials.length>1)throw new Error('unauthorized');
    const browserToken=credentials[0]?.slice(7);
    if (authorization && (!authorization.startsWith('Bearer ') || authorization.length === 7)) throw new Error('unauthorized');
    const token=authorization?.slice(7)??browserToken;
    if(!token)throw new Error('unauthorized');
    const algorithms = remoteKey ? ['RS256','PS256','ES256'] : ['HS256'];
    const verified = remoteKey
      ? await jwtVerify(token, remoteKey, { issuer:options.issuer, audience:options.audience, algorithms, requiredClaims:['exp'] })
      : await jwtVerify(token, localKey!, { issuer:options.issuer, audience:options.audience, algorithms, requiredClaims:['exp'] });
    const { payload } = verified;
    const tenant = payload[options.tenantClaim ?? 'tenant_id'];
    if (typeof payload.sub !== 'string' || !payload.sub.trim() || typeof tenant !== 'string' || !tenant.trim()) throw new Error('unauthorized');
    const claimed=payload[options.roleClaim??'roles'];
    const roles=(Array.isArray(claimed)?claimed:typeof claimed==='string'?[claimed]:[]).filter((x):x is string=>typeof x==='string');
    const admin=options.adminRole??'platform_admin';
    return { userId: payload.sub, tenantId: tenant, roles:roles.includes(admin)?['platform_admin']:roles.filter(x=>x!=='platform_admin') };
  };
}
