import { describe, expect, it } from 'vitest';

import type { GatewayAuthContext } from './auth.js';
import type { ChannelSubscription } from './channels.js';
import type { AgentEventFrame } from './protocol.js';
import {
  authorizeChannelSubscription,
  authorizeOutboundDelivery,
  redactAuthClaims,
  redactSensitiveMetadata,
} from './outbound.js';
import { createInMemoryGatewayStores } from './stores.js';

describe('authorizeChannelSubscription', () => {
  it('rejects subscription when no auth context is present', async () => {
    const stores = createInMemoryGatewayStores();
    const subscription: ChannelSubscription = { scope: 'session', id: 's-1', channel: 'session:s-1' };

    await expect(
      authorizeChannelSubscription(subscription, {
        stores,
        requestType: 'channel.subscribe',
      }),
    ).rejects.toMatchObject({
      code: 'auth_required',
    });
  });

  it('rejects session subscription when session does not exist', async () => {
    const stores = createInMemoryGatewayStores();
    const authContext = createAuthContext('user-1');
    const subscription: ChannelSubscription = { scope: 'session', id: 'nonexistent', channel: 'session:nonexistent' };

    await expect(
      authorizeChannelSubscription(subscription, {
        authContext,
        stores,
        requestType: 'channel.subscribe',
      }),
    ).rejects.toMatchObject({
      code: 'session_not_found',
    });
  });

  it('rejects session subscription when session belongs to a different principal', async () => {
    const stores = createInMemoryGatewayStores();
    await stores.sessions.create({
      id: 's-1',
      channelId: 'webchat',
      authSubject: 'user-owner',
      status: 'idle',
      transcriptVersion: 0,
      createdAt: '2026-04-08T10:00:00.000Z',
      updatedAt: '2026-04-08T10:00:00.000Z',
    });
    const authContext = createAuthContext('user-intruder');
    const subscription: ChannelSubscription = { scope: 'session', id: 's-1', channel: 'session:s-1' };

    await expect(
      authorizeChannelSubscription(subscription, {
        authContext,
        stores,
        requestType: 'channel.subscribe',
      }),
    ).rejects.toMatchObject({
      code: 'session_forbidden',
    });
  });

  it('allows session subscription for the owning principal', async () => {
    const stores = createInMemoryGatewayStores();
    await stores.sessions.create({
      id: 's-1',
      channelId: 'webchat',
      authSubject: 'user-1',
      status: 'idle',
      transcriptVersion: 0,
      createdAt: '2026-04-08T10:00:00.000Z',
      updatedAt: '2026-04-08T10:00:00.000Z',
    });
    const authContext = createAuthContext('user-1');
    const subscription: ChannelSubscription = { scope: 'session', id: 's-1', channel: 'session:s-1' };

    await expect(
      authorizeChannelSubscription(subscription, {
        authContext,
        stores,
        requestType: 'channel.subscribe',
      }),
    ).resolves.toBeUndefined();
  });

  it('allows non-session subscription scopes for any authenticated principal', async () => {
    const stores = createInMemoryGatewayStores();
    const authContext = createAuthContext('user-1');

    for (const channel of ['run:r-1', 'root-run:root-1', 'agent:support-agent'] as const) {
      const subscription = { scope: channel.split(':')[0] as ChannelSubscription['scope'], id: channel.split(':')[1]!, channel };

      await expect(
        authorizeChannelSubscription(subscription, {
          authContext,
          stores,
          requestType: 'channel.subscribe',
        }),
      ).resolves.toBeUndefined();
    }
  });
});

describe('authorizeOutboundDelivery', () => {
  it('drops delivery when no auth context is present', () => {
    const subscription: ChannelSubscription = { scope: 'session', id: 's-1', channel: 'session:s-1' };
    const event = createAgentEvent({ sessionId: 's-1' });

    expect(authorizeOutboundDelivery(subscription, event, {})).toBe(false);
  });

  it('allows session-scoped delivery when event session matches', () => {
    const subscription: ChannelSubscription = { scope: 'session', id: 's-1', channel: 'session:s-1' };
    const event = createAgentEvent({ sessionId: 's-1' });

    expect(
      authorizeOutboundDelivery(subscription, event, { authContext: createAuthContext('user-1') }),
    ).toBe(true);
  });

  it('drops session-scoped delivery when event session does not match', () => {
    const subscription: ChannelSubscription = { scope: 'session', id: 's-1', channel: 'session:s-1' };
    const event = createAgentEvent({ sessionId: 's-other' });

    expect(
      authorizeOutboundDelivery(subscription, event, { authContext: createAuthContext('user-1') }),
    ).toBe(false);
  });

  it('allows non-session scoped deliveries for authenticated callers', () => {
    const subscription: ChannelSubscription = { scope: 'run', id: 'r-1', channel: 'run:r-1' };
    const event = createAgentEvent({ runId: 'r-1' });

    expect(
      authorizeOutboundDelivery(subscription, event, { authContext: createAuthContext('user-1') }),
    ).toBe(true);
  });
});

describe('redactSensitiveMetadata', () => {
  it('redacts known sensitive keys in event data', () => {
    const frame: AgentEventFrame = {
      type: 'agent.event',
      eventType: 'run.created',
      data: {
        runId: 'r-1',
        token: 'secret-value',
        apiKey: 'key-123',
        config: {
          password: 'hunter2',
          url: 'https://example.com',
        },
      },
    };

    const redacted = redactSensitiveMetadata(frame);

    expect(redacted.data).toEqual({
      runId: 'r-1',
      token: '[REDACTED]',
      apiKey: '[REDACTED]',
      config: {
        password: '[REDACTED]',
        url: 'https://example.com',
      },
    });
  });

  it('preserves non-sensitive data untouched', () => {
    const frame: AgentEventFrame = {
      type: 'agent.event',
      eventType: 'tool.completed',
      data: {
        toolName: 'read_file',
        output: { lines: 42 },
      },
    };

    const redacted = redactSensitiveMetadata(frame);
    expect(redacted.data).toEqual(frame.data);
  });

  it('handles null and primitive data values', () => {
    expect(redactSensitiveMetadata({ type: 'agent.event', eventType: 'test', data: null }).data).toBeNull();
    expect(redactSensitiveMetadata({ type: 'agent.event', eventType: 'test', data: 'hello' }).data).toBe('hello');
    expect(redactSensitiveMetadata({ type: 'agent.event', eventType: 'test', data: 42 }).data).toBe(42);
  });

  it('handles arrays in data', () => {
    const frame: AgentEventFrame = {
      type: 'agent.event',
      eventType: 'test',
      data: [{ secret: 'val', name: 'ok' }, 'plain'],
    };

    const redacted = redactSensitiveMetadata(frame);
    expect(redacted.data).toEqual([{ secret: '[REDACTED]', name: 'ok' }, 'plain']);
  });

  it('redacts standard JWT claim keys', () => {
    const frame: AgentEventFrame = {
      type: 'agent.event',
      eventType: 'test',
      data: {
        iat: 1234567890,
        exp: 1234567890,
        nbf: 1234567890,
        jti: 'jwt-id',
        iss: 'issuer',
        aud: 'audience',
      },
    };

    const redacted = redactSensitiveMetadata(frame);
    expect(redacted.data).toEqual({
      iat: '[REDACTED]',
      exp: '[REDACTED]',
      nbf: '[REDACTED]',
      jti: '[REDACTED]',
      iss: '[REDACTED]',
      aud: '[REDACTED]',
    });
  });
});

describe('redactAuthClaims', () => {
  it('returns only safe identity fields from the auth context', () => {
    const authContext: GatewayAuthContext = {
      subject: 'user-1',
      tenantId: 'acme',
      roles: ['member', 'admin'],
      claims: {
        sub: 'user-1',
        iat: 1234567890,
        exp: 1234567890,
        tenantId: 'acme',
        roles: ['member', 'admin'],
        secret: 'should-not-appear',
      },
    };

    expect(redactAuthClaims(authContext)).toEqual({
      subject: 'user-1',
      tenantId: 'acme',
      roles: ['member', 'admin'],
    });
  });

  it('omits tenantId when not present', () => {
    const authContext: GatewayAuthContext = {
      subject: 'user-1',
      roles: [],
      claims: { sub: 'user-1' },
    };

    expect(redactAuthClaims(authContext)).toEqual({
      subject: 'user-1',
      roles: [],
    });
  });
});

function createAuthContext(subject: string): GatewayAuthContext {
  return {
    subject,
    tenantId: 'acme',
    roles: ['member'],
    claims: { sub: subject },
  };
}

function createAgentEvent(overrides: Partial<AgentEventFrame> = {}): AgentEventFrame {
  return {
    type: 'agent.event',
    eventType: 'run.status_changed',
    data: { status: 'running' },
    ...overrides,
  };
}
