import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ADAPTIVE_AGENT_HOME = join(homedir(), '.adaptiveAgent');
export const GATEWAY_STORE_BASE_DIR = join(ADAPTIVE_AGENT_HOME, 'data', 'gateway');
export const GATEWAY_CONFIG_PATH = join(ADAPTIVE_AGENT_HOME, 'config', 'gateway.json');
export const AGENT_CONFIG_DIR = join(ADAPTIVE_AGENT_HOME, 'agents');
export const DEFAULT_AGENT_CONFIG_PATH = join(AGENT_CONFIG_DIR, 'default-agent.json');
export const DEFAULT_GATEWAY_JWT_SECRET = 'adaptive-agent-local-dev-secret';

export interface LocalGatewayConnectionConfig {
  host?: string;
  port?: number;
  websocketPath?: string;
}

export interface LocalGatewayJwtAuthConfig {
  provider: string;
  secret?: string;
  issuer?: string;
  audience?: string | string[];
  tenantIdClaim?: string;
  rolesClaim?: string;
}

export async function loadLocalGatewayJwtAuthConfig(): Promise<LocalGatewayJwtAuthConfig | undefined> {
  const rawConfig = await loadLocalGatewayConfig();
  if (!isRecord(rawConfig) || !isRecord(rawConfig.auth)) {
    return undefined;
  }

  const auth = rawConfig.auth;
  if (typeof auth.provider !== 'string' || auth.provider.trim().length === 0) {
    return undefined;
  }

  const audience = readAudience(auth.audience);

  return {
    provider: auth.provider,
    secret: readOptionalString(auth.secret),
    issuer: readOptionalString(auth.issuer),
    audience,
    tenantIdClaim: readOptionalString(auth.tenantIdClaim),
    rolesClaim: readOptionalString(auth.rolesClaim),
  };
}

export async function loadLocalGatewayConnectionConfig(): Promise<LocalGatewayConnectionConfig | undefined> {
  const rawConfig = await loadLocalGatewayConfig();
  if (!isRecord(rawConfig) || !isRecord(rawConfig.server)) {
    return undefined;
  }

  const server = rawConfig.server;

  return {
    host: readOptionalString(server.host),
    port: typeof server.port === 'number' && Number.isInteger(server.port) && server.port > 0 ? server.port : undefined,
    websocketPath: readOptionalString(server.websocketPath),
  };
}

async function loadLocalGatewayConfig(): Promise<unknown> {
  if (!existsSync(GATEWAY_CONFIG_PATH)) {
    return undefined;
  }

  return JSON.parse(await readFile(GATEWAY_CONFIG_PATH, 'utf-8')) as unknown;
}

function readAudience(value: unknown): string | string[] | undefined {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const audience = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  return audience.length > 0 ? audience : undefined;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
