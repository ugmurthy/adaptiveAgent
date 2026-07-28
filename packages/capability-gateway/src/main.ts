import { Pool } from 'pg';
import { createJwtAuthenticator, type JwtAuthOptions } from './auth.js';
import { PostgresBillingStore, runBillingMigration } from './billing.js';
import { GatewayService } from './gateway-service.js';
import { createMetadataLogger } from './logger.js';
import {
  assertRoutePolicyEnvironment,
  loadRoutePolicy,
  type RoutePolicy,
} from './route-policy.js';
import { startGatewayServer } from './server.js';

async function main(): Promise<void> {
  const env = process.env;
  const logger = createMetadataLogger();
  const routePolicy = await loadRoutePolicy(required(
    env.GATEWAY_ROUTE_POLICY_PATH,
    'GATEWAY_ROUTE_POLICY_PATH',
  ));
  assertRoutePolicyEnvironment(routePolicy, env);
  const shutdownGraceMs = positiveInteger(
    env.GATEWAY_SHUTDOWN_GRACE_MS,
    defaultShutdownGraceMs(routePolicy),
    'GATEWAY_SHUTDOWN_GRACE_MS',
  );

  const authOptions = jwtAuthOptions(env);
  const pool = new Pool({
    connectionString: required(env.DATABASE_URL, 'DATABASE_URL'),
  });

  try {
    await runBillingMigration(pool);
    const service = new GatewayService({
      routePolicy,
      billingStore: new PostgresBillingStore(pool, true),
      logger,
      serverVersion: '0.1.0',
    });
    const server = startGatewayServer({
      authenticator: createJwtAuthenticator(authOptions),
      service,
      logger,
      hostname: env.GATEWAY_HOST ?? '0.0.0.0',
      port: positiveInteger(env.GATEWAY_PORT, 3000, 'GATEWAY_PORT'),
      tls: tlsOptions(env),
      maxConnections: positiveInteger(
        env.GATEWAY_MAX_CONNECTIONS,
        1_000,
        'GATEWAY_MAX_CONNECTIONS',
      ),
      maxFrameBytes: positiveInteger(
        env.GATEWAY_MAX_FRAME_BYTES,
        1_048_576,
        'GATEWAY_MAX_FRAME_BYTES',
      ),
      maxInFlightRequests: positiveInteger(
        env.GATEWAY_MAX_IN_FLIGHT_REQUESTS,
        32,
        'GATEWAY_MAX_IN_FLIGHT_REQUESTS',
      ),
      maxBackpressureBytes: positiveInteger(
        env.GATEWAY_MAX_BACKPRESSURE_BYTES,
        1_048_576,
        'GATEWAY_MAX_BACKPRESSURE_BYTES',
      ),
      idleTimeoutMs: positiveInteger(
        env.GATEWAY_IDLE_TIMEOUT_MS,
        60_000,
        'GATEWAY_IDLE_TIMEOUT_MS',
      ),
    });

    logger.log('info', 'server.started', {
      status: 'ready',
      routePolicyVersion: routePolicy.version,
    });

    let shutdown: Promise<void> | undefined;
    const stop = (): Promise<void> => {
      if (!shutdown) {
        logger.log('info', 'server.shutdown_started', {
          status: 'draining',
          durationMs: shutdownGraceMs,
        });
        shutdown = server.stop({ gracePeriodMs: shutdownGraceMs }).then(() => {
          logger.log('info', 'server.shutdown_completed', {
            status: 'stopped',
          });
        });
      }
      return shutdown;
    };
    const handleSignal = () => void stop().catch((error) => {
      logger.log('error', 'server.shutdown_failed', {
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      process.exitCode = 1;
    });
    process.once('SIGINT', handleSignal);
    process.once('SIGTERM', handleSignal);
  } catch (error) {
    await pool.end();
    throw error;
  }
}

function jwtAuthOptions(env: NodeJS.ProcessEnv): JwtAuthOptions {
  const common = {
    issuer: required(env.GATEWAY_JWT_ISSUER, 'GATEWAY_JWT_ISSUER'),
    audience: required(env.GATEWAY_JWT_AUDIENCE, 'GATEWAY_JWT_AUDIENCE'),
    accountClaim: env.GATEWAY_JWT_ACCOUNT_CLAIM,
    tenantClaim: env.GATEWAY_JWT_TENANT_CLAIM,
    tiersClaim: env.GATEWAY_JWT_TIERS_CLAIM,
    modesClaim: env.GATEWAY_JWT_MODES_CLAIM,
  };
  if (env.GATEWAY_JWT_HMAC_SECRET && !env.GATEWAY_JWT_JWKS_URL) {
    return { ...common, hmacSecret: env.GATEWAY_JWT_HMAC_SECRET };
  }
  if (env.GATEWAY_JWT_JWKS_URL && !env.GATEWAY_JWT_HMAC_SECRET) {
    return { ...common, jwksUrl: env.GATEWAY_JWT_JWKS_URL };
  }
  throw new Error(
    'configure exactly one of GATEWAY_JWT_HMAC_SECRET or GATEWAY_JWT_JWKS_URL',
  );
}

function tlsOptions(env: NodeJS.ProcessEnv): Bun.TLSOptions | undefined {
  if (!env.GATEWAY_TLS_CERT_FILE && !env.GATEWAY_TLS_KEY_FILE) return undefined;
  if (!env.GATEWAY_TLS_CERT_FILE || !env.GATEWAY_TLS_KEY_FILE) {
    throw new Error('GATEWAY_TLS_CERT_FILE and GATEWAY_TLS_KEY_FILE must be configured together');
  }
  return {
    cert: Bun.file(env.GATEWAY_TLS_CERT_FILE),
    key: Bun.file(env.GATEWAY_TLS_KEY_FILE),
    passphrase: env.GATEWAY_TLS_KEY_PASSPHRASE,
  };
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function defaultShutdownGraceMs(routePolicy: RoutePolicy): number {
  return Math.max(
    ...Object.values(routePolicy.tiers).map(
      (tierPolicy) => (
        tierPolicy.limits.modelTimeoutMs * tierPolicy.targets.length
      ),
    ),
  ) + 5_000;
}

export function startupFailureStatus(error: unknown): string {
  if (!(error instanceof Error)) return 'startup_error';
  const safeMessagePatterns = [
    /^(?:GATEWAY_[A-Z0-9_]+|DATABASE_URL) is required$/,
    /^GATEWAY_[A-Z0-9_]+ must be a positive integer$/,
    /^GATEWAY_TLS_CERT_FILE and GATEWAY_TLS_KEY_FILE must be configured together$/,
    /^configure exactly one of GATEWAY_JWT_HMAC_SECRET or GATEWAY_JWT_JWKS_URL$/,
    /^JWT issuer and audience are required$/,
    /^JWT HMAC secret must be at least 32 bytes$/,
    /^route policy requires environment variables: [A-Z][A-Z0-9_, ]*$/,
    /^invalid route policy: [A-Za-z0-9_.\[\] -]+$/,
  ];
  if (safeMessagePatterns.some((pattern) => pattern.test(error.message))) {
    return error.message;
  }
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === 'string' && /^[A-Z0-9]{2,16}$/.test(code)) {
    return `error_${code}`;
  }
  if (error instanceof SyntaxError) return 'invalid_configuration_json';
  return 'startup_error';
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      event: 'capability_gateway.startup.failed',
      errorType: error instanceof Error ? error.name : 'UnknownError',
      status: startupFailureStatus(error),
    }));
    process.exitCode = 1;
  });
}
