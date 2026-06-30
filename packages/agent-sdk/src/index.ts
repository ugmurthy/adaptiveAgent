import {
  createAdaptiveAgent,
  createAdaptiveAgentLogger,
  type AdaptiveAgent,
  type AgentEvent,
  type ChatMessage,
  type ChatResult,
  type ContinueRunOptions,
  type ContinueRunResult,
  type ContinuationStore,
  type CreatedAdaptiveAgent,
  type EventStore,
  type JsonObject,
  type JsonValue,
  type PlanStore,
  type RecoverRunOptions,
  type RecoverRunResult,
  type RunRecoveryOptions,
  type RunRecoveryPlan,
  type RunResult,
  type RunStore,
  type SnapshotStore,
  type ToolDefinition,
  type UUID,
} from '@adaptive-agent/core';

import type {
  AgentSdkCatalogInspection,
  AgentSdkChatOptions,
  AgentSdkOptions,
  AgentSdkRunOptions,
  ResolvedAgentSdkConfig,
  ResolvedAgentSdkModuleInspection,
} from './config-types.js';
import { resolveAgentSdkConfig, resolveAgentSdkConfigWithSources } from './config-resolve.js';
import { groundTruthSystemInstructions, mergeGroundTruthContext } from './ground-truth-context.js';
import { resolveRuntimeBundle } from './postgres-runtime.js';
import { discoverCatalogAgents, discoverCatalogDelegates, resolveToolsAndDelegates } from './tool-registry.js';
import { mergeMetadata, normalizeRecovery, promptText, promptYesNo } from './sdk-utils.js';

export * from './config-types.js';
export * from './errors.js';
export { buildGroundTruthContext, mergeGroundTruthContext } from './ground-truth-context.js';
export { expandEnvironmentVariables } from './sdk-utils.js';
export { createOrchestrationSdk, OrchestrationSdk } from './orchestration.js';
export type {
  AgentCatalogEntry,
  InputClaim,
  OrchestratedRunOptions,
  OrchestratedRunResult,
  OrchestratedRunStageResult,
  OrchestrationConcurrencyPolicy,
  OrchestrationExecutionShape,
  OrchestrationInputSelector,
  OrchestrationLifecycleEvent,
  OrchestrationPlan,
  OrchestrationPlanNode,
  OrchestrationPlanNodeStatus,
  OrchestrationSessionInspection,
  OrchestrationSessionRecord,
  OrchestrationSessionRunLinkRecord,
  OrchestrationSessionStatus,
  OrchestrationStageKind,
} from './orchestration.js';

export class AgentSdk {
  readonly agent: AdaptiveAgent;
  readonly created: CreatedAdaptiveAgent<RunStore, EventStore, SnapshotStore, PlanStore | undefined, ContinuationStore>;
  readonly config: ResolvedAgentSdkConfig;
  readonly metadata: JsonObject;
  readonly registeredToolNames: string[];
  private readonly closeRuntime?: () => Promise<void>;
  private readonly clock?: () => Date;
  private unsubscribe?: () => void;

  private constructor(args: { created: CreatedAdaptiveAgent<RunStore, EventStore, SnapshotStore, PlanStore | undefined, ContinuationStore>; config: ResolvedAgentSdkConfig; metadata: JsonObject; registeredToolNames: string[]; closeRuntime?: () => Promise<void>; unsubscribe?: () => void; clock?: () => Date }) {
    this.created = args.created;
    this.agent = args.created.agent;
    this.config = args.config;
    this.metadata = args.metadata;
    this.registeredToolNames = args.registeredToolNames;
    this.closeRuntime = args.closeRuntime;
    this.clock = args.clock;
    this.unsubscribe = args.unsubscribe;
  }

  static async create(options: AgentSdkOptions = {}): Promise<AgentSdk> {
    const config = await resolveAgentSdkConfig(options);
    const runtime = options.runtime ? { mode: config.runtime.mode, runtime: options.runtime } : await resolveRuntimeBundle(config.runtime.mode, config.runtime.autoMigrate, options.env);
    const modules = await resolveToolsAndDelegates(config, options);
    const logger = options.logger ?? (config.logging.enabled ? createAdaptiveAgentLogger(config.logging) : undefined);
    const metadata: JsonObject = { agentId: config.agent.id, agentName: config.agent.name, runtimeMode: config.runtime.mode, ...(config.agent.metadata ?? {}) };
    const created = createAdaptiveAgent({
      model: config.model,
      tools: modules.tools,
      delegates: modules.delegates.length > 0 ? modules.delegates : undefined,
      delegation: config.agent.delegation,
      recovery: normalizeRecovery(config.agent.recovery),
      defaults: { ...(config.agent.defaults ?? {}), ...(config.settings.defaults ?? {}), autoApproveAll: config.interaction.approvalMode === 'auto' || config.settings.defaults?.autoApproveAll === true },
      systemInstructions: combineSystemInstructions(config.agent.systemInstructions, groundTruthSystemInstructions(config.groundTruth.enabled)),
      runtime: runtime.runtime,
      eventSink: options.eventListener ? { emit: options.eventListener } : undefined,
      logger,
    });
    const unsubscribe = config.events.subscribe && created.runtime.eventStore.subscribe ? created.runtime.eventStore.subscribe((event) => options.eventListener?.(event)) : undefined;
    return new AgentSdk({ created, config, metadata, registeredToolNames: modules.registeredToolNames, closeRuntime: runtime.close, unsubscribe, clock: options.clock });
  }

  async run(goal: string, options: AgentSdkRunOptions = {}): Promise<RunResult> {
    return this.resolveInteractions(await this.agent.run({ ...options, goal, context: this.enrichContext(options.context), metadata: mergeMetadata(this.metadata, options.metadata) }));
  }

  async runRaw(goal: string, options: AgentSdkRunOptions = {}): Promise<RunResult> {
    return this.agent.run({ ...options, goal, context: this.enrichContext(options.context), metadata: mergeMetadata(this.metadata, options.metadata) });
  }

  async chat(messageOrMessages: string | ChatMessage[], options: AgentSdkChatOptions = {}): Promise<ChatResult> {
    const messages = typeof messageOrMessages === 'string' ? [{ role: 'user' as const, content: messageOrMessages }] : messageOrMessages;
    return this.resolveInteractions(await this.agent.chat({ ...options, messages, context: this.enrichContext(options.context), metadata: mergeMetadata(this.metadata, options.metadata) }));
  }

  async chatRaw(messageOrMessages: string | ChatMessage[], options: AgentSdkChatOptions = {}): Promise<ChatResult> {
    const messages = typeof messageOrMessages === 'string' ? [{ role: 'user' as const, content: messageOrMessages }] : messageOrMessages;
    return this.agent.chat({ ...options, messages, context: this.enrichContext(options.context), metadata: mergeMetadata(this.metadata, options.metadata) });
  }

  async resume(runId: UUID): Promise<RunResult> { return this.resolveInteractions(await this.agent.resume(runId)); }
  async resumeRaw(runId: UUID): Promise<RunResult> { return this.agent.resume(runId); }
  async retry(runId: UUID): Promise<RunResult> { return this.resolveInteractions(await this.agent.retry(runId)); }
  async retryRaw(runId: UUID): Promise<RunResult> { return this.agent.retry(runId); }
  async getRecoveryOptions(runId: UUID): Promise<RunRecoveryOptions> { return this.agent.getRecoveryOptions(runId); }
  async getRecoveryPlan(runId: UUID): Promise<RunRecoveryPlan> { return this.agent.getRecoveryPlan(runId); }
  async recover(options: RecoverRunOptions): Promise<RecoverRunResult> {
    const recovered = await this.agent.recover(options);
    return recovered.result ? { ...recovered, result: await this.resolveInteractions(recovered.result) } : recovered;
  }
  async recoverRaw(options: RecoverRunOptions): Promise<RecoverRunResult> { return this.agent.recover(options); }
  async createContinuationRun(options: ContinueRunOptions): Promise<ContinueRunResult> { return this.agent.createContinuationRun(options); }
  async continueRun(options: ContinueRunOptions): Promise<RunResult> { return this.resolveInteractions(await this.agent.continueRun(options)); }
  async continueRunRaw(options: ContinueRunOptions): Promise<RunResult> { return this.agent.continueRun(options); }
  async interrupt(runId: UUID): Promise<void> { await this.agent.interrupt(runId); }
  async steer(runId: UUID, message: Parameters<AdaptiveAgent['steer']>[1]): Promise<void> { await this.agent.steer(runId, message); }
  async inspect(runId: UUID): Promise<{ run: Awaited<ReturnType<RunStore['getRun']>>; events: AgentEvent[] }> { return { run: await this.created.runtime.runStore.getRun(runId), events: await this.created.runtime.eventStore.listByRun(runId) }; }
  subscribe(listener: (event: AgentEvent) => void): () => void { return this.created.runtime.eventStore.subscribe?.(listener) ?? (() => undefined); }
  async close(): Promise<void> { this.unsubscribe?.(); this.unsubscribe = undefined; await this.closeRuntime?.(); }

  private enrichContext(context: Record<string, JsonValue> | undefined): JsonObject | undefined {
    return mergeGroundTruthContext(context, this.config.groundTruth, { now: this.clock?.() });
  }

  private async resolveInteractions<T extends RunResult | ChatResult>(initial: T): Promise<T> {
    let result: RunResult | ChatResult = initial;
    while (result.status === 'approval_requested' || result.status === 'clarification_requested') {
      if (result.status === 'approval_requested') {
        if (this.config.interaction.approvalMode === 'reject') {
          await this.agent.resolveApproval(result.runId, false);
          result = await this.agent.resume(result.runId);
        } else if (this.config.interaction.approvalMode === 'auto') {
          await this.agent.resolveApproval(result.runId, true);
          result = await this.agent.resume(result.runId);
        } else {
          const approved = await promptYesNo(`Approve tool "${result.toolName}"? [y/N] `);
          await this.agent.resolveApproval(result.runId, approved);
          result = await this.agent.resume(result.runId);
        }
        continue;
      }
      if (this.config.interaction.clarificationMode === 'fail') throw new Error(`Run ${result.runId} requested clarification: ${result.message}`);
      const answer = await promptText(`${result.message}\nClarification answer: `);
      result = await this.agent.resolveClarification(result.runId, answer);
    }
    return result as T;
  }
}

export async function createAgentSdk(options: AgentSdkOptions = {}): Promise<AgentSdk> { return AgentSdk.create(options); }

export async function loadAgentSdkConfig(options: AgentSdkOptions = {}): Promise<ResolvedAgentSdkConfig> { return resolveAgentSdkConfig(options); }

export async function inspectAgentSdkResolution(options: AgentSdkOptions = {}): Promise<ResolvedAgentSdkModuleInspection> {
  const config = await resolveAgentSdkConfig(options);
  const modules = await resolveToolsAndDelegates(config, options);
  const registeredTools = modules.registeredTools.map(pickToolInspectionFields);
  return {
    config,
    tools: modules.tools.map(pickToolInspectionFields),
    delegates: modules.delegates.map((delegate) => ({
      name: delegate.name,
      description: delegate.description,
      allowedTools: delegate.allowedTools,
    })),
    registeredTools,
    registeredToolNames: modules.registeredToolNames,
  };
}

export async function inspectAgentSdkCatalog(options: AgentSdkOptions = {}): Promise<AgentSdkCatalogInspection> {
  const resolved = await resolveAgentSdkConfigWithSources(options);
  const modules = await resolveToolsAndDelegates(resolved.config, options);
  const configuredToolNames = new Set(resolved.config.agent.tools);
  const configuredDelegateNames = new Set(resolved.config.agent.delegates ?? []);

  return {
    config: resolved.config,
    agentPath: resolved.agentPath,
    ...(resolved.settingsPath ? { settingsPath: resolved.settingsPath } : {}),
    agents: await discoverCatalogAgents(resolved.config, resolved.agentPath),
    tools: modules.registeredTools.map((tool) => ({
      ...pickToolInspectionFields(tool),
      configured: configuredToolNames.has(tool.name),
    })),
    delegates: await discoverCatalogDelegates(resolved.config, configuredDelegateNames),
  };
}

function pickToolInspectionFields(tool: ToolDefinition<any, any>): Pick<ToolDefinition<JsonValue, JsonValue>, 'name' | 'description' | 'inputSchema' | 'requiresApproval'> {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    requiresApproval: tool.requiresApproval,
  };
}

function combineSystemInstructions(agentInstructions: string | undefined, runtimeInstructions: string): string | undefined {
  const parts = [runtimeInstructions.trim(), agentInstructions?.trim()].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}
