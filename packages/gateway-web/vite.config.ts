import { defineConfig, type Plugin } from 'vite';
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SignJWT } from 'jose';

interface DevTokenRequest {
  subject?: unknown;
  tenantId?: unknown;
  roles?: unknown;
}

interface GatewayConnectionConfig {
  socketUrl?: string;
  host?: string;
  port?: number;
  websocketPath?: string;
}

const GATEWAY_CONFIG_PATH = join(homedir(), '.adaptiveAgent', 'config', 'gateway.json');
const DEFAULT_GATEWAY_JWT_SECRET = 'adaptive-agent-local-dev-secret';

function gatewayDevApi(): Plugin {
  return {
    name: 'gateway-dev-api',
    configureServer(server) {
      server.middlewares.use('/api/gateway-defaults', async (_request, response) => {
        try {
          const connection = await loadLocalGatewayConnectionConfig();

          sendJson(response, 200, {
            socketUrl: resolveGatewaySocketUrl(connection),
            channel: 'web',
            subject: 'local-dev-user',
            tenantId: 'free',
            roles: ['member'],
          });
        } catch (error) {
          sendJson(response, 500, { message: errorMessage(error) });
        }
      });

      server.middlewares.use('/api/dev-token', (request, response) => {
        if (request.method !== 'POST') {
          sendJson(response, 405, { message: 'method not allowed' });
          return;
        }

        let body = '';
        request.on('data', (chunk) => {
          body += String(chunk);
        });
        request.on('end', async () => {
          try {
            const payload = parseJsonBody(body);
            const subject = readString(payload.subject) ?? 'local-dev-user';
            const tenantId = readString(payload.tenantId) ?? 'free';
            const roles = readStringArray(payload.roles);
            const token = await mintLocalDevJwt({
              subject,
              tenantId,
              roles: roles.length > 0 ? roles : ['member'],
            });

            sendJson(response, 200, { token });
          } catch (error) {
            sendJson(response, 400, { message: errorMessage(error) });
          }
        });
      });

      server.middlewares.use(async (request, response, next) => {
        if (!request.url?.startsWith('/api/runs') && !request.url?.startsWith('/api/images')) {
          next();
          return;
        }

        await proxyGatewayApiRequest(request, response);
      });
    },
  };
}

async function proxyGatewayApiRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const connection = await loadLocalGatewayConnectionConfig();
    const target = new URL(request.url ?? '/api/runs', resolveGatewayHttpBaseUrl(connection));
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await readRequestBody(request);
    const upstream = await fetch(target, {
      method: request.method,
      headers: copyProxyHeaders(request.headers),
      body,
    });

    response.statusCode = upstream.status;
    upstream.headers.forEach((value, key) => {
      response.setHeader(key, value);
    });
    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    sendJson(response, 502, {
      type: 'error',
      code: 'gateway_dashboard_unreachable',
      message: `Could not proxy request to the local gateway: ${errorMessage(error)}`,
    });
  }
}

async function loadLocalGatewayConnectionConfig(): Promise<GatewayConnectionConfig | undefined> {
  const socketUrl = readString(process.env.GATEWAY_WEB_SOCKET_URL) ?? readString(process.env.GATEWAY_SOCKET_URL);
  if (socketUrl) {
    return { socketUrl };
  }

  const rawConfig = await loadLocalGatewayConfig();
  if (!isRecord(rawConfig) || !isRecord(rawConfig.server)) {
    return undefined;
  }

  const server = rawConfig.server;
  return {
    socketUrl: readString(server.publicSocketUrl) ?? readString(server.socketUrl),
    host: readString(server.host),
    port: typeof server.port === 'number' && Number.isInteger(server.port) && server.port > 0 ? server.port : undefined,
    websocketPath: readString(server.websocketPath),
  };
}

function resolveGatewaySocketUrl(connection: GatewayConnectionConfig | undefined): string {
  if (connection?.socketUrl) {
    return normalizeSocketUrl(connection.socketUrl);
  }

  const host = normalizeHost(connection?.host);
  const port = connection?.port ?? 8959;
  const websocketPath = connection?.websocketPath ?? '/ws';
  return `ws://${host}:${port}${websocketPath}`;
}

function resolveGatewayHttpBaseUrl(connection: GatewayConnectionConfig | undefined): string {
  if (!connection?.socketUrl) {
    const host = normalizeHost(connection?.host);
    const port = connection?.port ?? 8959;
    return `http://${host}:${port}`;
  }

  const url = new URL(normalizeSocketUrl(connection.socketUrl));
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function loadLocalGatewayJwtAuthConfig(): Promise<{
  secret?: string;
  issuer?: string;
  audience?: string | string[];
  tenantIdClaim?: string;
  rolesClaim?: string;
} | undefined> {
  const rawConfig = await loadLocalGatewayConfig();
  if (!isRecord(rawConfig) || !isRecord(rawConfig.auth)) {
    return undefined;
  }

  const auth = rawConfig.auth;
  return {
    secret: readString(auth.secret),
    issuer: readString(auth.issuer),
    audience: readAudience(auth.audience),
    tenantIdClaim: readString(auth.tenantIdClaim),
    rolesClaim: readString(auth.rolesClaim),
  };
}

async function loadLocalGatewayConfig(): Promise<unknown> {
  if (!existsSync(GATEWAY_CONFIG_PATH)) {
    return undefined;
  }

  return JSON.parse(await readFile(GATEWAY_CONFIG_PATH, 'utf-8')) as unknown;
}

async function mintLocalDevJwt(options: { subject: string; tenantId?: string; roles?: string[] }): Promise<string> {
  const auth = await loadLocalGatewayJwtAuthConfig();
  const secret = process.env.GATEWAY_JWT_SECRET ?? auth?.secret ?? DEFAULT_GATEWAY_JWT_SECRET;
  const tenantIdClaim = auth?.tenantIdClaim ?? 'tenantId';
  const rolesClaim = auth?.rolesClaim ?? 'roles';
  const payload: Record<string, string | string[]> = {};

  if (options.tenantId) {
    payload[tenantIdClaim] = options.tenantId;
  }
  if (options.roles?.length) {
    payload[rolesClaim] = [...new Set(options.roles)];
  }

  let jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(options.subject)
    .setIssuedAt()
    .setExpirationTime('7d');

  if (auth?.issuer) {
    jwt = jwt.setIssuer(auth.issuer);
  }
  if (auth?.audience) {
    jwt = jwt.setAudience(auth.audience);
  }

  return jwt.sign(new TextEncoder().encode(secret));
}

function normalizeHost(host: string | undefined): string {
  if (!host || host === '0.0.0.0' || host === '::') {
    return '127.0.0.1';
  }

  return host;
}

function normalizeSocketUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  } else if (url.protocol === 'http:') {
    url.protocol = 'ws:';
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('Gateway socket URL must use ws, wss, http, or https.');
  }

  return url.toString();
}

function parseJsonBody(body: string): DevTokenRequest {
  if (!body.trim()) {
    return {};
  }

  const parsed = JSON.parse(body) as unknown;
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as DevTokenRequest) : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0);
}

function readAudience(value: unknown): string | string[] | undefined {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const audience = readStringArray(value);
  return audience.length > 0 ? audience : undefined;
}

function copyProxyHeaders(headers: IncomingMessage['headers']): Headers {
  const proxyHeaders = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (!value || key.toLowerCase() === 'host') {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        proxyHeaders.append(key, entry);
      }
    } else {
      proxyHeaders.set(key, value);
    }
  }
  return proxyHeaders;
}

function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sendJson(response: { statusCode: number; setHeader: (key: string, value: string) => void; end: (body: string) => void }, status: number, payload: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(payload));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default defineConfig({
  plugins: [gatewayDevApi()],
});
