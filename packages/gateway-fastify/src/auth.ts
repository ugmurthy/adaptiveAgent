import { jwtVerify, errors as joseErrors, type JWTPayload } from 'jose';

import type { GatewayConfig } from './config.js';
import type { JsonObject, JsonValue } from './core.js';
import type { ErrorFrame } from './protocol.js';
import type { GatewayAuthProvider, ResolvedGatewayAuthProvider } from './registries.js';

export interface GatewayAuthContext {
  subject: string;
  tenantId?: string;
  roles: string[];
  claims: JsonObject;
}

export interface GatewayAuthProviderContext {
  token: string;
  settings: JsonObject;
  headers: Record<string, string | string[] | undefined>;
}

export interface GatewayUpgradeAuthenticationOptions {
  config: GatewayConfig;
  auth?: ResolvedGatewayAuthProvider;
  headers: Record<string, string | string[] | undefined>;
  url: string;
}

export interface GatewayUpgradeAuthenticationResult {
  authContext?: GatewayAuthContext;
  requestedChannelId?: string;
  isPublicChannel: boolean;
}

export interface GatewayUpgradeQuery {
  channelId?: string;
}

export class GatewayAuthError extends Error {
  readonly code: ErrorFrame['code'];
  readonly statusCode: number;
  readonly details?: JsonObject;

  constructor(
    code: ErrorFrame['code'],
    message: string,
    options: { statusCode?: number; details?: JsonObject } = {},
  ) {
    super(message);
    this.name = 'GatewayAuthError';
    this.code = code;
    this.statusCode = options.statusCode ?? 401;
    this.details = options.details;
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    gatewayAuthContext?: GatewayAuthContext;
    gatewayRequestedChannelId?: string;
    gatewayIsPublicChannel?: boolean;
  }
}

export async function authenticateGatewayUpgrade(
  options: GatewayUpgradeAuthenticationOptions,
): Promise<GatewayUpgradeAuthenticationResult> {
  const requestedChannelId = getRequestedChannelId(options.url);
  const isPublicChannel = requestedChannelId ? isPublicGatewayChannel(options.config, requestedChannelId) : false;

  if (isPublicChannel) {
    return {
      requestedChannelId,
      isPublicChannel: true,
    };
  }

  if (!options.auth) {
    return {
      requestedChannelId,
      isPublicChannel: false,
    };
  }

  const token = extractBearerToken(options.headers.authorization);
  if (!token) {
    throw new GatewayAuthError('auth_required', 'A bearer JWT is required for this WebSocket upgrade.', {
      details: requestedChannelId ? { channelId: requestedChannelId } : undefined,
    });
  }

  const authContext = await options.auth.definition.authenticate?.({
    token,
    settings: options.auth.settings,
    headers: options.headers,
  });

  if (!authContext) {
    throw new GatewayAuthError('invalid_token', 'The configured auth provider did not return an auth context.');
  }

  return {
    authContext,
    requestedChannelId,
    isPublicChannel: false,
  };
}

export function createAuthErrorFrame(error: GatewayAuthError): ErrorFrame {
  return {
    type: 'error',
    code: error.code,
    message: error.message,
    requestType: 'upgrade',
    details: error.details,
  };
}

export function createJwtAuthProvider(): GatewayAuthProvider {
  return {
    id: 'jwt',
    authenticate: authenticateJwtBearer,
  };
}

interface JwtAuthSettings {
  secret: string;
  issuer?: string;
  audience?: string | string[];
  tenantIdClaim: string;
  rolesClaim: string;
}

async function authenticateJwtBearer(context: GatewayAuthProviderContext): Promise<GatewayAuthContext> {
  const settings = parseJwtAuthSettings(context.settings);

  try {
    const { payload } = await jwtVerify(context.token, new TextEncoder().encode(settings.secret), {
      issuer: settings.issuer,
      audience: settings.audience,
    });

    return normalizeJwtAuthContext(payload, settings);
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) {
      throw new GatewayAuthError('token_expired', 'The bearer JWT has expired.');
    }

    if (error instanceof joseErrors.JOSEError) {
      throw new GatewayAuthError('invalid_token', 'The bearer JWT is invalid.');
    }

    throw error;
  }
}

function parseJwtAuthSettings(settings: JsonObject): JwtAuthSettings {
  const secret = expectNonEmptyStringSetting(settings.secret, 'auth.secret');
  const issuer = expectOptionalNonEmptyStringSetting(settings.issuer, 'auth.issuer');
  const audience = parseAudienceSetting(settings.audience, 'auth.audience');
  const tenantIdClaim = expectOptionalNonEmptyStringSetting(settings.tenantIdClaim, 'auth.tenantIdClaim') ?? 'tenantId';
  const rolesClaim = expectOptionalNonEmptyStringSetting(settings.rolesClaim, 'auth.rolesClaim') ?? 'roles';

  return {
    secret,
    issuer,
    audience,
    tenantIdClaim,
    rolesClaim,
  };
}

function normalizeJwtAuthContext(payload: JWTPayload, settings: JwtAuthSettings): GatewayAuthContext {
  const subject = typeof payload.sub === 'string' && payload.sub.trim().length > 0 ? payload.sub : undefined;
  if (!subject) {
    throw new GatewayAuthError('invalid_token', 'The bearer JWT must include a non-empty subject claim.');
  }

  return {
    subject,
    tenantId: parseOptionalStringClaim(payload[settings.tenantIdClaim]),
    roles: parseRolesClaim(payload[settings.rolesClaim]),
    claims: toJsonObject(payload),
  };
}

function getRequestedChannelId(url: string): string | undefined {
  const parsedUrl = new URL(url, 'ws://gateway.local');
  const channelId = parsedUrl.searchParams.get('channelId');

  if (!channelId) {
    return undefined;
  }

  const trimmedChannelId = channelId.trim();
  return trimmedChannelId.length > 0 ? trimmedChannelId : undefined;
}

function isPublicGatewayChannel(config: GatewayConfig, channelId: string): boolean {
  return config.channels?.list.some((channel) => channel.id === channelId && channel.isPublic === true) ?? false;
}

function extractBearerToken(headerValue: string | string[] | undefined): string | undefined {
  if (Array.isArray(headerValue)) {
    return extractBearerToken(headerValue[0]);
  }

  if (!headerValue) {
    return undefined;
  }

  const [scheme, token] = headerValue.split(/\s+/, 2);
  if (!scheme || !token || scheme.toLowerCase() !== 'bearer') {
    return undefined;
  }

  return token;
}

function parseAudienceSetting(value: JsonValue | undefined, path: string): string | string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === 'string') {
    const trimmedValue = value.trim();
    if (trimmedValue.length === 0) {
      throw new Error(`${path} must be a non-empty string when provided.`);
    }

    return trimmedValue;
  }

  if (Array.isArray(value)) {
    const audience = value.map((entry, index) => expectNonEmptyStringSetting(entry, `${path}[${index}]`));
    return audience;
  }

  throw new Error(`${path} must be a string or string array when provided.`);
}

function expectNonEmptyStringSetting(value: JsonValue | undefined, path: string): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }

  throw new Error(`${path} must be a non-empty string.`);
}

function expectOptionalNonEmptyStringSetting(value: JsonValue | undefined, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return expectNonEmptyStringSetting(value, path);
}

function parseOptionalStringClaim(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmedValue = value.trim();
  return trimmedValue.length > 0 ? trimmedValue : undefined;
}

function parseRolesClaim(value: unknown): string[] {
  if (typeof value === 'string') {
    return value
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  return [];
}

function toJsonObject(value: Record<string, unknown>): JsonObject {
  const entries = Object.entries(value)
    .map(([key, entryValue]) => {
      const jsonValue = toJsonValue(entryValue);
      return jsonValue === undefined ? undefined : ([key, jsonValue] as const);
    })
    .filter((entry): entry is readonly [string, JsonValue] => entry !== undefined);

  return Object.fromEntries(entries);
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    const items = value
      .map((entry) => toJsonValue(entry))
      .filter((entry): entry is JsonValue => entry !== undefined);
    return items;
  }

  if (typeof value === 'object') {
    return toJsonObject(value as Record<string, unknown>);
  }

  return undefined;
}
