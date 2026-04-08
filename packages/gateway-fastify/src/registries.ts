import type { DelegateDefinition, JsonObject, ToolDefinition } from './core.js';

import type {
  AgentConfig,
  GatewayAuthConfig,
  GatewayHookSlot,
  GatewayHooksConfig,
  HookFailurePolicy,
} from './config.js';
import type { GatewayAuthContext, GatewayAuthProviderContext } from './auth.js';
import { GATEWAY_HOOK_SLOTS } from './config.js';
import { RegistryResolutionError } from './errors.js';

export interface GatewayHookDefinition {
  id: string;
  onAuthenticate?(context: unknown): Promise<void> | void;
  onSessionResolve?(context: unknown): Promise<void> | void;
  beforeRoute?(context: unknown): Promise<void> | void;
  beforeInboundMessage?(context: unknown): Promise<void> | void;
  beforeRunStart?(context: unknown): Promise<void> | void;
  afterRunResult?(context: unknown): Promise<void> | void;
  onAgentEvent?(context: unknown): Promise<void> | void;
  beforeOutboundFrame?(context: unknown): Promise<void> | void;
  onDisconnect?(context: unknown): Promise<void> | void;
  onError?(context: unknown): Promise<void> | void;
}

export interface GatewayAuthProvider {
  id: string;
  authenticate?(context: GatewayAuthProviderContext): Promise<GatewayAuthContext> | GatewayAuthContext;
}

export interface CreateModuleRegistryOptions {
  tools?: ToolDefinition[];
  delegates?: DelegateDefinition[];
  hooks?: GatewayHookDefinition[];
  authProviders?: GatewayAuthProvider[];
}

export interface ResolvedAgentModules {
  tools: ToolDefinition[];
  delegates: DelegateDefinition[];
}

export interface ResolvedGatewayAuthProvider {
  definition: GatewayAuthProvider;
  settings: JsonObject;
}

export type ResolvedHookSlots = Record<GatewayHookSlot, GatewayHookDefinition[]>;

export interface ResolvedGatewayHooks extends ResolvedHookSlots {
  failurePolicy: HookFailurePolicy;
  modules: GatewayHookDefinition[];
}

export interface ResolvedGatewayModules {
  auth?: ResolvedGatewayAuthProvider;
  hooks: ResolvedGatewayHooks;
}

export class ModuleRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly delegates = new Map<string, DelegateDefinition>();
  private readonly hooks = new Map<string, GatewayHookDefinition>();
  private readonly authProviders = new Map<string, GatewayAuthProvider>();

  constructor(options: CreateModuleRegistryOptions = {}) {
    for (const tool of options.tools ?? []) {
      this.registerTool(tool);
    }

    for (const delegate of options.delegates ?? []) {
      this.registerDelegate(delegate);
    }

    for (const hook of options.hooks ?? []) {
      this.registerHook(hook);
    }

    for (const authProvider of options.authProviders ?? []) {
      this.registerAuthProvider(authProvider);
    }
  }

  registerTool(tool: ToolDefinition): void {
    registerNamedEntry(this.tools, tool.name, tool, 'tool');
  }

  registerDelegate(delegate: DelegateDefinition): void {
    registerNamedEntry(this.delegates, delegate.name, delegate, 'delegate');
  }

  registerHook(hook: GatewayHookDefinition): void {
    registerNamedEntry(this.hooks, hook.id, hook, 'hook');
  }

  registerAuthProvider(authProvider: GatewayAuthProvider): void {
    registerNamedEntry(this.authProviders, authProvider.id, authProvider, 'auth provider');
  }

  resolveAgentModules(agentConfig: AgentConfig, sourceLabel = describeAgentSource(agentConfig)): ResolvedAgentModules {
    return {
      tools: this.resolveMany(this.tools, 'tool', agentConfig.tools, sourceLabel),
      delegates: this.resolveMany(this.delegates, 'delegate', agentConfig.delegates, sourceLabel),
    };
  }

  resolveGatewayModules(
    gatewayConfig: { auth?: GatewayAuthConfig; hooks: GatewayHooksConfig },
    sourceLabel = 'gateway config',
  ): ResolvedGatewayModules {
    return {
      auth: gatewayConfig.auth ? this.resolveAuthProvider(gatewayConfig.auth, sourceLabel) : undefined,
      hooks: this.resolveHooks(gatewayConfig.hooks, sourceLabel),
    };
  }

  private resolveHooks(hooksConfig: GatewayHooksConfig, sourceLabel: string): ResolvedGatewayHooks {
    const resolvedHooks = {
      failurePolicy: hooksConfig.failurePolicy,
      modules: this.resolveMany(this.hooks, 'hook', hooksConfig.modules, `${sourceLabel} hooks.modules`),
      onAuthenticate: [] as GatewayHookDefinition[],
      onSessionResolve: [] as GatewayHookDefinition[],
      beforeRoute: [] as GatewayHookDefinition[],
      beforeInboundMessage: [] as GatewayHookDefinition[],
      beforeRunStart: [] as GatewayHookDefinition[],
      afterRunResult: [] as GatewayHookDefinition[],
      onAgentEvent: [] as GatewayHookDefinition[],
      beforeOutboundFrame: [] as GatewayHookDefinition[],
      onDisconnect: [] as GatewayHookDefinition[],
      onError: [] as GatewayHookDefinition[],
    } satisfies ResolvedGatewayHooks;

    for (const slot of GATEWAY_HOOK_SLOTS) {
      resolvedHooks[slot] = this.resolveMany(this.hooks, 'hook', hooksConfig[slot], `${sourceLabel} ${slot}`);
    }

    return resolvedHooks;
  }

  private resolveAuthProvider(authConfig: GatewayAuthConfig, sourceLabel: string): ResolvedGatewayAuthProvider {
    return {
      definition: this.resolveOne(this.authProviders, 'auth provider', authConfig.provider, `${sourceLabel} auth.provider`),
      settings: authConfig.settings,
    };
  }

  private resolveMany<TEntry>(
    registry: Map<string, TEntry>,
    kind: string,
    names: string[],
    sourceLabel: string,
  ): TEntry[] {
    return names.map((name) => this.resolveOne(registry, kind, name, sourceLabel));
  }

  private resolveOne<TEntry>(registry: Map<string, TEntry>, kind: string, name: string, sourceLabel: string): TEntry {
    const entry = registry.get(name);
    if (entry) {
      return entry;
    }

    const availableEntries = [...registry.keys()].sort();
    const availableText = availableEntries.length > 0 ? availableEntries.join(', ') : '(none registered)';
    throw new RegistryResolutionError(
      `Unknown ${kind} reference "${name}" in ${sourceLabel}. Registered ${kind}s: ${availableText}.`,
    );
  }
}

export function createModuleRegistry(options: CreateModuleRegistryOptions = {}): ModuleRegistry {
  return new ModuleRegistry(options);
}

function registerNamedEntry<TEntry>(registry: Map<string, TEntry>, key: string, entry: TEntry, kind: string): void {
  if (registry.has(key)) {
    throw new RegistryResolutionError(`Duplicate ${kind} registry entry "${key}".`);
  }

  registry.set(key, entry);
}

function describeAgentSource(agentConfig: AgentConfig): string {
  return `agent "${agentConfig.id}"`;
}
