import { SignJWT } from 'jose';

import { DEFAULT_GATEWAY_JWT_SECRET, loadLocalGatewayJwtAuthConfig } from './local-dev.js';

export interface MintLocalDevJwtOptions {
  subject: string;
  tenantId?: string;
  roles?: string[];
  expiresIn?: string;
  issuer?: string;
  audience?: string | string[];
  secret?: string;
}

export interface ResolvedLocalDevJwtConfig {
  secret: string;
  secretSource: 'option' | 'env' | 'gateway-config' | 'default';
  issuer?: string;
  audience?: string | string[];
  tenantIdClaim: string;
  rolesClaim: string;
}

export async function resolveLocalDevJwtConfig(
  options: Pick<MintLocalDevJwtOptions, 'issuer' | 'audience' | 'secret'> = {},
): Promise<ResolvedLocalDevJwtConfig> {
  const gatewayAuth = await loadLocalGatewayJwtAuthConfig();
  const secretSource = options.secret
    ? 'option'
    : process.env.GATEWAY_JWT_SECRET
      ? 'env'
      : gatewayAuth?.secret
        ? 'gateway-config'
        : 'default';

  return {
    secret: options.secret ?? process.env.GATEWAY_JWT_SECRET ?? gatewayAuth?.secret ?? DEFAULT_GATEWAY_JWT_SECRET,
    secretSource,
    issuer: options.issuer ?? gatewayAuth?.issuer,
    audience: options.audience ?? gatewayAuth?.audience,
    tenantIdClaim: gatewayAuth?.tenantIdClaim ?? 'tenantId',
    rolesClaim: gatewayAuth?.rolesClaim ?? 'roles',
  };
}

export async function mintLocalDevJwt(
  options: MintLocalDevJwtOptions,
): Promise<{ token: string; config: ResolvedLocalDevJwtConfig }> {
  const config = await resolveLocalDevJwtConfig(options);
  const payload: Record<string, string | string[]> = {};

  if (options.tenantId) {
    payload[config.tenantIdClaim] = options.tenantId;
  }

  const roles = options.roles?.filter((role) => role.trim().length > 0) ?? [];
  if (roles.length > 0) {
    payload[config.rolesClaim] = [...new Set(roles)];
  }

  let jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(options.subject)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '7d');

  if (config.issuer) {
    jwt = jwt.setIssuer(config.issuer);
  }

  if (config.audience) {
    jwt = jwt.setAudience(config.audience);
  }

  return {
    token: await jwt.sign(new TextEncoder().encode(config.secret)),
    config,
  };
}
