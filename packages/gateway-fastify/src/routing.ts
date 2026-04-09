import type { GatewayAuthContext } from './auth.js';
import type { AgentRegistry } from './agent-registry.js';
import type { GatewayBinding, GatewayConfig, InvocationMode } from './config.js';
import { ProtocolValidationError } from './protocol.js';
import type { GatewaySessionRecord } from './stores.js';

export interface ResolveGatewayRouteOptions {
  gatewayConfig: GatewayConfig;
  agentRegistry: AgentRegistry;
  session: GatewaySessionRecord;
  authContext?: GatewayAuthContext;
  invocationMode: InvocationMode;
  requestType: string;
  requestedAgentId?: string;
  allowExplicitAgentId?: boolean;
}

export interface ResolvedGatewayRoute {
  agentId: string;
  invocationMode: InvocationMode;
  source: 'session' | 'binding' | 'default' | 'explicit';
}

interface ScoredBinding {
  binding: GatewayBinding;
  index: number;
  score: number;
}

export function resolveGatewayRoute(options: ResolveGatewayRouteOptions): ResolvedGatewayRoute {
  if (options.requestedAgentId) {
    if (!options.allowExplicitAgentId) {
      throw new ProtocolValidationError(
        'invalid_frame',
        `Frame type "${options.requestType}" cannot override routing with agentId directly.`,
        {
          requestType: options.requestType,
          details: { agentId: options.requestedAgentId },
        },
      );
    }

    ensureInvocationModeAllowed(options.agentRegistry, options.requestedAgentId, options.invocationMode, options.requestType);
    return {
      agentId: options.requestedAgentId,
      invocationMode: options.invocationMode,
      source: 'explicit',
    };
  }

  if (options.session.agentId) {
    if (options.session.invocationMode && options.session.invocationMode !== options.invocationMode) {
      throw new ProtocolValidationError(
        'invalid_frame',
        `Session "${options.session.id}" is pinned to invocation mode "${options.session.invocationMode}", not "${options.invocationMode}".`,
        {
          requestType: options.requestType,
          details: {
            sessionId: options.session.id,
            invocationMode: options.session.invocationMode,
            requestedInvocationMode: options.invocationMode,
          },
        },
      );
    }

    ensureInvocationModeAllowed(options.agentRegistry, options.session.agentId, options.invocationMode, options.requestType);
    return {
      agentId: options.session.agentId,
      invocationMode: options.invocationMode,
      source: 'session',
    };
  }

  const matchedBinding = findBestMatchingBinding(options.gatewayConfig, options.session, options.authContext);
  if (matchedBinding) {
    ensureInvocationModeAllowed(options.agentRegistry, matchedBinding.agentId, options.invocationMode, options.requestType);
    return {
      agentId: matchedBinding.agentId,
      invocationMode: options.invocationMode,
      source: 'binding',
    };
  }

  if (options.gatewayConfig.defaultAgentId) {
    ensureInvocationModeAllowed(
      options.agentRegistry,
      options.gatewayConfig.defaultAgentId,
      options.invocationMode,
      options.requestType,
    );
    return {
      agentId: options.gatewayConfig.defaultAgentId,
      invocationMode: options.invocationMode,
      source: 'default',
    };
  }

  throw new ProtocolValidationError(
    'route_not_found',
    `No configured agent route matched session "${options.session.id}" for frame type "${options.requestType}".`,
    {
      requestType: options.requestType,
      details: createRouteNotFoundDetails(options.session, options.authContext),
    },
  );
}

function createRouteNotFoundDetails(
  session: GatewaySessionRecord,
  authContext?: GatewayAuthContext,
): Record<string, string | string[]> {
  const details: Record<string, string | string[]> = {
    sessionId: session.id,
    channelId: session.channelId,
  };

  if (authContext?.tenantId) {
    details.tenantId = authContext.tenantId;
  }

  if (authContext?.roles.length) {
    details.roles = authContext.roles;
  }

  return details;
}

function findBestMatchingBinding(
  gatewayConfig: GatewayConfig,
  session: GatewaySessionRecord,
  authContext?: GatewayAuthContext,
): GatewayBinding | undefined {
  const matches = gatewayConfig.bindings
    .map<ScoredBinding | undefined>((binding, index) => {
      if (!bindingMatches(binding, session, authContext)) {
        return undefined;
      }

      return {
        binding,
        index,
        score: bindingSpecificityScore(binding),
      };
    })
    .filter((entry): entry is ScoredBinding => Boolean(entry))
    .sort((left, right) => right.score - left.score || left.index - right.index);

  return matches[0]?.binding;
}

function bindingMatches(
  binding: GatewayBinding,
  session: GatewaySessionRecord,
  authContext?: GatewayAuthContext,
): boolean {
  if (binding.match.channelId && binding.match.channelId !== session.channelId) {
    return false;
  }

  if (binding.match.tenantId && binding.match.tenantId !== authContext?.tenantId) {
    return false;
  }

  if (binding.match.roles && binding.match.roles.length > 0) {
    const callerRoles = new Set(authContext?.roles ?? []);
    for (const role of binding.match.roles) {
      if (!callerRoles.has(role)) {
        return false;
      }
    }
  }

  return true;
}

function bindingSpecificityScore(binding: GatewayBinding): number {
  return (binding.match.channelId ? 4 : 0) + (binding.match.tenantId ? 2 : 0) + (binding.match.roles?.length ? 1 : 0);
}

function ensureInvocationModeAllowed(
  agentRegistry: AgentRegistry,
  agentId: string,
  invocationMode: InvocationMode,
  requestType: string,
): void {
  const metadata = agentRegistry.getMetadata(agentId);
  if (metadata.invocationModes.includes(invocationMode)) {
    return;
  }

  throw new ProtocolValidationError(
    'invalid_frame',
    `Agent "${agentId}" does not support invocation mode "${invocationMode}" for frame type "${requestType}".`,
    {
      requestType,
      details: {
        agentId,
        invocationMode,
        supportedInvocationModes: metadata.invocationModes,
      },
    },
  );
}
