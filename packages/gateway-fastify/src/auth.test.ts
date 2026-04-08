import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';

import { GatewayAuthError, authenticateGatewayUpgrade, createJwtAuthProvider } from './auth.js';
import type { GatewayConfig } from './config.js';

const testSecret = 'super-secret-test-key';
const authProvider = createJwtAuthProvider();

describe('authenticateGatewayUpgrade', () => {
  it('normalizes valid JWT claims into the gateway auth context', async () => {
    const result = await authenticateGatewayUpgrade({
      config: createAuthenticatedConfig(),
      auth: createResolvedJwtAuth(),
      headers: {
        authorization: `Bearer ${await signJwt({ sub: 'user-123', tenantId: 'acme', roles: ['operator', 'support'] })}`,
      },
      url: '/ws',
    });

    expect(result.isPublicChannel).toBe(false);
    expect(result.authContext).toEqual({
      subject: 'user-123',
      tenantId: 'acme',
      roles: ['operator', 'support'],
      claims: expect.objectContaining({
        sub: 'user-123',
        tenantId: 'acme',
        roles: ['operator', 'support'],
      }),
    });
  });

  it('allows public-channel upgrades without a JWT', async () => {
    const result = await authenticateGatewayUpgrade({
      config: createPublicChannelConfig(),
      auth: createResolvedJwtAuth(),
      headers: {},
      url: '/ws?channelId=public-feed',
    });

    expect(result).toEqual({
      requestedChannelId: 'public-feed',
      isPublicChannel: true,
    });
  });

  it('returns a stable error for an invalid JWT', async () => {
    await expect(
      authenticateGatewayUpgrade({
        config: createAuthenticatedConfig(),
        auth: createResolvedJwtAuth(),
        headers: {
          authorization: 'Bearer not-a-valid-token',
        },
        url: '/ws',
      }),
    ).rejects.toMatchObject({
      code: 'invalid_token',
      statusCode: 401,
    } satisfies Partial<GatewayAuthError>);
  });

  it('returns a stable error for an expired JWT', async () => {
    await expect(
      authenticateGatewayUpgrade({
        config: createAuthenticatedConfig(),
        auth: createResolvedJwtAuth(),
        headers: {
          authorization: `Bearer ${await signJwt(
            { sub: 'user-123' },
            { exp: Math.floor(Date.now() / 1000) - 60 },
          )}`,
        },
        url: '/ws',
      }),
    ).rejects.toMatchObject({
      code: 'token_expired',
      statusCode: 401,
    } satisfies Partial<GatewayAuthError>);
  });
});

function createAuthenticatedConfig(): GatewayConfig {
  return {
    server: {
      host: '127.0.0.1',
      port: 0,
      websocketPath: '/ws',
    },
    auth: {
      provider: 'jwt',
      settings: {
        secret: testSecret,
        issuer: 'https://auth.example.com',
        audience: 'adaptive-agent-gateway',
      },
    },
    bindings: [],
    hooks: {
      failurePolicy: 'fail',
      modules: [],
      onAuthenticate: [],
      onSessionResolve: [],
      beforeRoute: [],
      beforeInboundMessage: [],
      beforeRunStart: [],
      afterRunResult: [],
      onAgentEvent: [],
      beforeOutboundFrame: [],
      onDisconnect: [],
      onError: [],
    },
  };
}

function createPublicChannelConfig(): GatewayConfig {
  return {
    ...createAuthenticatedConfig(),
    channels: {
      defaults: {
        sessionConcurrency: 1,
      },
      list: [
        {
          id: 'public-feed',
          name: 'Public Feed',
          isPublic: true,
        },
      ],
    },
  };
}

function createResolvedJwtAuth() {
  return {
    definition: authProvider,
    settings: {
      secret: testSecret,
      issuer: 'https://auth.example.com',
      audience: 'adaptive-agent-gateway',
    },
  };
}

async function signJwt(
  claims: Record<string, unknown>,
  overrides: { exp?: number } = {},
): Promise<string> {
  const payload = { ...claims };
  if ('sub' in payload) {
    delete payload.sub;
  }

  const builder = new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('https://auth.example.com')
    .setAudience('adaptive-agent-gateway')
    .setIssuedAt();

  if (typeof claims.sub === 'string') {
    builder.setSubject(claims.sub);
  }

  if (typeof overrides.exp === 'number') {
    builder.setExpirationTime(overrides.exp);
  } else {
    builder.setExpirationTime('15m');
  }

  return builder.sign(new TextEncoder().encode(testSecret));
}
