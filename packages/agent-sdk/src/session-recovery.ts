import {
  getSessionRecoveryTargets,
  SwarmCoordinator,
  type AgentRun,
  type RecoverRunResult,
  type RunRecoveryPlan,
  type RunResult,
  type SessionRecoveryTarget,
  type SwarmRunResult,
} from '@adaptive-agent/core';

import { AgentSdk, discoverAgentSdkAgents, type AgentConfigFile, type AgentSdkOptions } from './index.js';
import { createOrchestrationSdk, type OrchestratedRunResult } from './orchestration.js';
import { agentConfigurationFingerprint } from './sdk-utils.js';
import { createSwarmRoleAgentConfig } from './swarm-role-config.js';

export interface RecoverSessionOptions {
  sessionId: string;
  runId?: never;
  /** Disambiguate multiple orchestrated executions within a conversation. */
  executionId?: string;
  /** Disambiguate multiple swarms within a conversation. */
  coordinatorRunId?: string;
  dryRun?: boolean;
  /** Explicit continuation consent; never resolves pending tool approvals. */
  requireApproval?: boolean;
}

export interface RecoverSessionResult {
  sessionId: string;
  outcome: 'planned' | 'completed' | 'failed' | 'blocked' | 'busy' | 'ambiguous' | 'not_found';
  target?: SessionRecoveryTarget;
  candidates?: SessionRecoveryTarget[];
  reason?: string;
  plans: RunRecoveryPlan[];
  actions: RecoverRunResult[];
  result?: RunResult | SwarmRunResult | OrchestratedRunResult;
  startedRunIds?: string[];
}

export async function recoverSession(sdk: AgentSdk, options: RecoverSessionOptions, sdkOptions: AgentSdkOptions): Promise<RecoverSessionResult> {
  if (!options.sessionId?.trim() || options.runId !== undefined || (options.executionId && options.coordinatorRunId)) {
    throw new Error('Recovery requires exactly one runId or sessionId, and at most one execution selector');
  }
  const report = (outcome: RecoverSessionResult['outcome'], fields: Partial<RecoverSessionResult> = {}): RecoverSessionResult =>
    ({ sessionId: options.sessionId, outcome, plans: [], actions: [], ...fields });
  const targets = await getSessionRecoveryTargets(sdk.created.runtime, options.sessionId);
  if (!options.executionId && !options.coordinatorRunId) {
    const roots = new Set<string>();
    for (const target of targets.filter((candidate) => candidate.kind === 'run')) {
      const rootId = target.lineageRootRunId ?? target.id;
      if (roots.has(rootId)) return report('ambiguous', {
        reason: 'A run has multiple continuation branches; choose the intended run explicitly',
        candidates: targets.filter((candidate) => candidate.kind === 'run' && (candidate.lineageRootRunId ?? candidate.id) === rootId),
      });
      roots.add(rootId);
    }
  }
  const selected = options.executionId
    ? targets.filter((target) => target.kind === 'orchestration' && target.id === options.executionId)
    : options.coordinatorRunId
      ? targets.filter((target) => target.kind === 'swarm' && target.id === options.coordinatorRunId)
      : targets.filter((target) => target.status !== 'succeeded');
  if (selected.length === 0) {
    if (options.executionId || options.coordinatorRunId || targets.length === 0) {
      return report('not_found', { reason: 'No matching execution exists in this session', candidates: targets });
    }
    if (targets.length !== 1) return report('completed', { reason: 'All executions in the session have completed', candidates: targets });
    selected.push(targets[0]!);
  }
  if (selected.length > 1) return report('ambiguous', { reason: 'Several independent executions need recovery; choose a run, execution, or coordinator', candidates: selected });
  const target = selected[0]!;
  const owned: AgentSdk[] = [];
  const resolved = new Map<string, AgentSdk>();
  let catalog: Awaited<ReturnType<typeof discoverAgentSdkAgents>> | undefined;
  const runs = await sdk.created.runtime.runStore.listBySession!(options.sessionId, { order: 'asc' });

  const resolveAgent = async (agentId: string, run?: AgentRun, fallbackConfig?: AgentConfigFile): Promise<AgentSdk> => {
    let candidate = resolved.get(agentId);
    if (!candidate && agentId === sdk.config.agent.id) candidate = sdk;
    if (!candidate) {
      catalog ??= await discoverAgentSdkAgents(sdkOptions);
      const matches = catalog.agents.filter((agent) => agent.id === agentId && agent.validationState === 'valid' && !agent.archived);
      if (matches.length > 1) throw new Error(`Agent profile ${agentId} is ambiguous`);
      const profile = matches[0];
      const generated = profile ? undefined : fallbackConfig;
      // Catalog execution can persist an inline-profile placeholder rather than a loadable path.
      // A catalog profile is safe only after the historical identity/fingerprint checks below.
      const path = profile?.configPath ?? (typeof run?.metadata?.agentConfigPath === 'string' ? run.metadata.agentConfigPath : undefined);
      if (!generated && !path) throw new Error(`Agent profile ${agentId} is unavailable; configure its catalog before recovery`);
      candidate = await AgentSdk.create({
        ...sdkOptions,
        agentConfig: generated,
        agentConfigPath: generated ? undefined : path,
        settingsConfig: { ...sdk.config.settings, agent: { mode: 'fixed', ...(generated ? {} : { id: agentId, configPath: path }) } },
        settingsConfigPath: undefined,
        settingsOverrides: undefined,
        runtime: sdk.created.runtime,
      });
      owned.push(candidate);
    }
    if (candidate.config.agent.id !== agentId) throw new Error(`Historical agent ${agentId} does not match the loaded profile`);
    const fingerprint = run?.metadata?.agentConfigurationFingerprint;
    if (typeof fingerprint === 'string' && agentConfigurationFingerprint(candidate.config) !== fingerprint) {
      throw new Error(`Historical configuration for agent ${agentId} changed; automatic recovery is blocked`);
    }
    const provider = sdkOptions.modelAdapter?.provider ?? candidate.config.model.provider;
    const model = sdkOptions.modelAdapter?.model ?? candidate.config.model.model;
    const gateway = candidate.config.inference.mode === 'gateway';
    if (run && (gateway
      ? run.modelProvider !== 'adaptive-agent-gateway' || run.modelName !== `tier:${candidate.config.inference.tier}`
      : (run.modelProvider && run.modelProvider !== provider) || (run.modelName && run.modelName !== model))) {
      throw new Error(`Historical model for agent ${agentId} differs from the configured model`);
    }
    resolved.set(agentId, candidate);
    return candidate;
  };

  try {
    if (target.kind === 'run') {
      const run = runs.find((candidate) => candidate.id === target.id)!;
      const agentId = typeof run.metadata?.agentId === 'string' ? run.metadata.agentId : sdk.config.agent.id;
      const owner = await resolveAgent(agentId, run);
      if (run.status === 'succeeded') {
        return report('completed', { target, result: await owner.resumeRaw(run.id), reason: 'Run already succeeded; no execution was started' });
      }
      const active = runs.find((candidate) => candidate.rootRunId === run.rootRunId && candidate.leaseExpiresAt && Date.parse(candidate.leaseExpiresAt) > Date.now());
      if (active) return report('busy', { target, reason: `Run ${active.id} holds a live execution lease` });
      const plan = await owner.getRecoveryPlan(run.id);
      if (!plan.executable) return report('blocked', { target, plans: [plan], reason: plan.reason });
      if (options.dryRun) return report('planned', { target, plans: [plan], reason: plan.reason });
      const action = await owner.recoverRaw({ runId: run.id, requireApproval: options.requireApproval });
      return report(action.result?.status === 'success' ? 'completed' : action.result?.status === 'failure' ? 'failed' : 'blocked', {
        target, plans: [plan], actions: [action], result: action.result,
      });
    }
    if (target.kind === 'swarm') {
      const coordinator = runs.find((run) => run.id === target.id);
      if (!coordinator) return report('blocked', { target, reason: 'Swarm coordinator record is missing' });
      const raw = coordinator.metadata?.swarmExecution;
      const descriptor = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : undefined;
      const rawAgents = descriptor?.agents;
      const agents = rawAgents && typeof rawAgents === 'object' && !Array.isArray(rawAgents) ? rawAgents : undefined;
      const coordinatorId = typeof agents?.coordinatorAgentId === 'string' ? agents.coordinatorAgentId
        : typeof coordinator.metadata?.agentId === 'string' ? coordinator.metadata.agentId : sdk.config.agent.id;
      const coordinatorSdk = await resolveAgent(coordinatorId, coordinator);
      const rawWorkers = agents?.workerAgentIds;
      const workerIds = rawWorkers && typeof rawWorkers === 'object' && !Array.isArray(rawWorkers)
        ? [...new Set(Object.values(rawWorkers).filter((id): id is string => typeof id === 'string' && !!id))]
        : [];
      // Failed decomposition may precede the descriptor: its persisted catalog is authoritative.
      const workerCatalog = coordinator.input && typeof coordinator.input === 'object' && !Array.isArray(coordinator.input) ? coordinator.input.workerCatalog : undefined;
      if (Array.isArray(workerCatalog)) for (const entry of workerCatalog) {
        if (entry && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.id === 'string' && !workerIds.includes(entry.id)) workerIds.push(entry.id);
      }
      const workerAgents: Record<string, AgentSdk['agent']> = {};
      for (const id of workerIds) {
        const historical = runs.find((run) => {
          const metadata = run.metadata?.orchestration;
          return target.runIds.includes(run.id) && metadata && typeof metadata === 'object' && !Array.isArray(metadata) && metadata.agentId === id;
        });
        workerAgents[id] = (await resolveAgent(id, historical)).agent;
      }
      const qualityId = typeof agents?.qualityAgentId === 'string' ? agents.qualityAgentId : `${coordinatorId}-quality`;
      const synthesizerId = typeof agents?.synthesizerAgentId === 'string' ? agents.synthesizerAgentId : `${coordinatorId}-synthesizer`;
      const finalizerRun = (role: string) => runs.find((run) => {
        const metadata = run.metadata?.orchestration;
        return target.runIds.includes(run.id) && metadata && typeof metadata === 'object' && !Array.isArray(metadata) && metadata.role === role;
      });
      // Default finalizer profiles are derived from the historical coordinator, not the startup agent.
      const quality = await resolveAgent(qualityId, finalizerRun('quality'), qualityId === `${coordinatorId}-quality` ? createSwarmRoleAgentConfig(coordinatorSdk.config.agent, 'quality') : undefined);
      const synthesizer = await resolveAgent(synthesizerId, finalizerRun('synthesizer'), synthesizerId === `${coordinatorId}-synthesizer` ? createSwarmRoleAgentConfig(coordinatorSdk.config.agent, 'synthesizer') : undefined);
      const recovered = await new SwarmCoordinator({
        runStore: sdk.created.runtime.runStore,
        coordinatorAgent: coordinatorSdk.agent, coordinatorAgentId: coordinatorId, workerAgents,
        qualityAgent: quality.agent, qualityAgentId: qualityId,
        synthesizerAgent: synthesizer.agent, synthesizerAgentId: synthesizerId,
      }).recoverSession(options);
      return report(recovered.outcome, { ...recovered, target });
    }
    const execution = await sdk.created.runtime.orchestrationStore.getExecution(target.id);
    if (!execution) return report('blocked', { target, reason: 'The durable orchestration execution is missing' });
    // A matching catalog alone does not prove the resolved settings/model still match each run.
    for (const stage of await sdk.created.runtime.orchestrationStore.listStages(target.id)) {
      const historical = await sdk.created.runtime.runStore.getRun(stage.runId);
      if (historical) await resolveAgent(stage.agentId, historical);
    }
    catalog ??= await discoverAgentSdkAgents(sdkOptions);
    const plan = execution.plan;
    const requestedId = plan && typeof plan === 'object' && !Array.isArray(plan) && typeof plan.requestedAgentId === 'string' ? plan.requestedAgentId : sdk.config.agent.id;
    const requested = await resolveAgent(requestedId);
    const orchestration = await createOrchestrationSdk({
      ...sdkOptions,
      requestedAgentConfig: requested.config.agent,
      requestedAgentConfigPath: requested.agentPath,
      agentCatalogPaths: catalog.agents.filter((agent) => agent.validationState === 'valid' && !agent.archived).map((agent) => agent.configPath),
      runtime: sdk.created.runtime,
      orchestrationStore: sdk.created.runtime.orchestrationStore,
    });
    try {
      const recovered = await orchestration.recoverExecution(target.id, options);
      return report(recovered.outcome, { ...recovered, target });
    } finally {
      await orchestration.close();
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return report(/active execution|acquire lease|already leased|live lease/.test(reason) ? 'busy' : 'blocked', { target, reason });
  } finally {
    await Promise.all(owned.map((owner) => owner.close()));
  }
}
