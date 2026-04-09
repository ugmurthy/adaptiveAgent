import type { CreatedAdaptiveAgent, DelegateDefinition, ToolDefinition } from './core.js';
import { describe, expect, it } from 'vitest';

import type { GatewayAuthContext } from './auth.js';
import { createAgentRegistry } from './agent-registry.js';
import type { AgentConfig, GatewayConfig, LoadedConfig } from './config.js';
import { resolveGatewayRoute } from './routing.js';
import { createModuleRegistry } from './registries.js';
import type { GatewaySessionRecord } from './stores.js';

function createTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: 'object', additionalProperties: true },
    execute: async () => ({ ok: true }),
  };
}

function createDelegate(name: string): DelegateDefinition {
  return {
    name,
    description: `${name} delegate`,
    allowedTools: [],
  };
}

function createLoadedAgent(config: Partial<AgentConfig> & Pick<AgentConfig, 'id' | 'name'>): LoadedConfig<AgentConfig> {
  return {
    path: `/tmp/${config.id}.json`,
    config: {
      id: config.id,
      name: config.name,
      invocationModes: config.invocationModes ?? ['chat', 'run'],
      defaultInvocationMode: config.defaultInvocationMode ?? 'chat',
      model: config.model ?? {
        provider: 'ollama',
        model: 'qwen3.5',
      },
      tools: config.tools ?? ['read_file'],
      delegates: config.delegates ?? ['researcher'],
      routing: config.routing,
      metadata: config.metadata,
      systemInstructions: config.systemInstructions,
      defaults: config.defaults,
    },
  };
}

function createRegistry() {
  return createAgentRegistry({
    agents: [
      createLoadedAgent({ id: 'support-agent', name: 'Support Agent' }),
      createLoadedAgent({ id: 'vip-agent', name: 'VIP Agent' }),
      createLoadedAgent({ id: 'ops-agent', name: 'Ops Agent', invocationModes: ['run'], defaultInvocationMode: 'run' }),
    ],
    moduleRegistry: createModuleRegistry({
      tools: [createTool('read_file')],
      delegates: [createDelegate('researcher')],
    }),
    agentFactory: () => createCreatedAgent(),
  });
}

function createCreatedAgent(): CreatedAdaptiveAgent {
  return {
    agent: {
      chat: async () => ({
        status: 'success',
        runId: 'run-1',
        output: 'ok',
        stepsUsed: 1,
        usage: { promptTokens: 0, completionTokens: 0, estimatedCostUSD: 0 },
      }),
    } as never,
    runtime: {
      runStore: {
        getRun: async () => null,
      } as never,
      eventStore: {} as never,
      snapshotStore: {} as never,
      planStore: undefined,
    },
  };
}

function createGatewayConfig(): GatewayConfig {
  return {
    server: {
      host: '127.0.0.1',
      port: 3000,
      websocketPath: '/ws',
    },
    bindings: [
      {
        match: { channelId: 'webchat' },
        agentId: 'support-agent',
      },
      {
        match: { tenantId: 'acme' },
        agentId: 'support-agent',
      },
      {
        match: { channelId: 'webchat', tenantId: 'acme', roles: ['vip'] },
        agentId: 'vip-agent',
      },
    ],
    defaultAgentId: 'support-agent',
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

function createSession(overrides: Partial<GatewaySessionRecord> = {}): GatewaySessionRecord {
  return {
    id: 'session-1',
    channelId: 'webchat',
    authSubject: 'user-123',
    tenantId: 'acme',
    status: 'idle',
    transcriptVersion: 0,
    createdAt: '2026-04-08T10:00:00.000Z',
    updatedAt: '2026-04-08T10:00:00.000Z',
    ...overrides,
  };
}

function createAuthContext(overrides: Partial<GatewayAuthContext> = {}): GatewayAuthContext {
  return {
    subject: 'user-123',
    tenantId: 'acme',
    roles: ['member', 'vip'],
    claims: { sub: 'user-123', tenantId: 'acme', roles: ['member', 'vip'] },
    ...overrides,
  };
}

describe('resolveGatewayRoute', () => {
  it('prefers an existing session pin before bindings and defaults', () => {
    const route = resolveGatewayRoute({
      gatewayConfig: createGatewayConfig(),
      agentRegistry: createRegistry(),
      session: createSession({ agentId: 'support-agent', invocationMode: 'chat' }),
      authContext: createAuthContext(),
      invocationMode: 'chat',
      requestType: 'message.send',
    });

    expect(route).toEqual({
      agentId: 'support-agent',
      invocationMode: 'chat',
      source: 'session',
    });
  });

  it('chooses the most specific matching binding in deterministic channel-tenant-role order', () => {
    const route = resolveGatewayRoute({
      gatewayConfig: createGatewayConfig(),
      agentRegistry: createRegistry(),
      session: createSession(),
      authContext: createAuthContext(),
      invocationMode: 'chat',
      requestType: 'message.send',
    });

    expect(route).toEqual({
      agentId: 'vip-agent',
      invocationMode: 'chat',
      source: 'binding',
    });
  });

  it('falls back to the gateway default agent when no binding matches', () => {
    const route = resolveGatewayRoute({
      gatewayConfig: createGatewayConfig(),
      agentRegistry: createRegistry(),
      session: createSession({ channelId: 'email' }),
      authContext: createAuthContext({ tenantId: 'other', roles: ['member'] }),
      invocationMode: 'chat',
      requestType: 'message.send',
    });

    expect(route).toEqual({
      agentId: 'support-agent',
      invocationMode: 'chat',
      source: 'default',
    });
  });

  it('rejects direct agent overrides for normal chat traffic', () => {
    expect(() =>
      resolveGatewayRoute({
        gatewayConfig: createGatewayConfig(),
        agentRegistry: createRegistry(),
        session: createSession(),
        authContext: createAuthContext(),
        invocationMode: 'chat',
        requestType: 'message.send',
        requestedAgentId: 'vip-agent',
      }),
    ).toThrowError('Frame type "message.send" cannot override routing with agentId directly.');
  });

  it('rejects sessions pinned to a different invocation mode', () => {
    expect(() =>
      resolveGatewayRoute({
        gatewayConfig: createGatewayConfig(),
        agentRegistry: createRegistry(),
        session: createSession({ agentId: 'ops-agent', invocationMode: 'run' }),
        authContext: createAuthContext(),
        invocationMode: 'chat',
        requestType: 'message.send',
      }),
    ).toThrowError('Session "session-1" is pinned to invocation mode "run", not "chat".');
  });
});
