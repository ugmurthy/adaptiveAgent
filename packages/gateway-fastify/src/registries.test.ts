import type { DelegateDefinition, ToolDefinition } from './core.js';
import { describe, expect, it } from 'vitest';

import { createJwtAuthProvider } from './auth.js';
import type { AgentConfig, GatewayConfig } from './config.js';
import { createModuleRegistry } from './registries.js';

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

describe('ModuleRegistry', () => {
  it('resolves tool, delegate, hook, and auth provider references', () => {
    const registry = createModuleRegistry({
      tools: [createTool('read_file')],
      delegates: [createDelegate('researcher')],
      hooks: [
        {
          id: 'audit',
          onAuthenticate() {
            return undefined;
          },
        },
      ],
      authProviders: [createJwtAuthProvider()],
    });
    const agentConfig: AgentConfig = {
      id: 'support-agent',
      name: 'Support Agent',
      invocationModes: ['chat', 'run'],
      defaultInvocationMode: 'chat',
      model: {
        provider: 'ollama',
        model: 'qwen3.5',
      },
      tools: ['read_file'],
      delegates: ['researcher'],
    };
    const gatewayConfig: GatewayConfig = {
      server: {
        host: '127.0.0.1',
        port: 3000,
        websocketPath: '/ws',
      },
      auth: {
        provider: 'jwt',
        settings: {
          issuer: 'https://auth.example.com',
        },
      },
      bindings: [],
      hooks: {
        failurePolicy: 'fail',
        modules: ['audit'],
        onAuthenticate: ['audit'],
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

    const resolvedAgentModules = registry.resolveAgentModules(agentConfig);
    const resolvedGatewayModules = registry.resolveGatewayModules(gatewayConfig);

    expect(resolvedAgentModules.tools.map((tool) => tool.name)).toEqual(['read_file']);
    expect(resolvedAgentModules.delegates.map((delegate) => delegate.name)).toEqual(['researcher']);
    expect(resolvedGatewayModules.auth?.definition.id).toBe('jwt');
    expect(resolvedGatewayModules.hooks.modules.map((hook) => hook.id)).toEqual(['audit']);
    expect(resolvedGatewayModules.hooks.onAuthenticate.map((hook) => hook.id)).toEqual(['audit']);
  });

  it('lists available tool and delegate names in sorted order', () => {
    const registry = createModuleRegistry({
      tools: [createTool('write_file'), createTool('read_file')],
      delegates: [createDelegate('researcher'), createDelegate('code-executor')],
    });

    expect(registry.listToolNames()).toEqual(['read_file', 'write_file']);
    expect(registry.listDelegateNames()).toEqual(['code-executor', 'researcher']);
  });

  it('fails fast for unknown agent module references', () => {
    const registry = createModuleRegistry();
    const agentConfig: AgentConfig = {
      id: 'support-agent',
      name: 'Support Agent',
      invocationModes: ['chat'],
      defaultInvocationMode: 'chat',
      model: {
        provider: 'ollama',
        model: 'qwen3.5',
      },
      tools: ['read_file'],
      delegates: [],
    };

    expect(() => registry.resolveAgentModules(agentConfig, 'agent "support-agent"')).toThrowError(
      'Unknown tool reference "read_file" in agent "support-agent". Registered tools: (none registered).',
    );
  });

  it('fails fast for unknown gateway auth and hook references', () => {
    const registry = createModuleRegistry();
    const gatewayConfig: GatewayConfig = {
      server: {
        host: '127.0.0.1',
        port: 3000,
        websocketPath: '/ws',
      },
      auth: {
        provider: 'jwt',
        settings: {},
      },
      bindings: [],
      hooks: {
        failurePolicy: 'fail',
        modules: ['audit'],
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

    expect(() => registry.resolveGatewayModules(gatewayConfig, 'gateway config')).toThrowError(
      'Unknown auth provider reference "jwt" in gateway config auth.provider. Registered auth providers: (none registered).',
    );
  });
});
