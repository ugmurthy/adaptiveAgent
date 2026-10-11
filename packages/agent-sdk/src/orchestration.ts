import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import {
  InMemoryOrchestrationStore,
  PreparedOrchestrationExecutor,
  type JsonObject,
  type OrchestratedRunResult,
  type OrchestrationConcurrencyPolicy,
  type OrchestrationExecutionInspection,
  type OrchestrationLifecycleEvent,
  type OrchestrationPlan,
  type OrchestrationPlanNode,
  type OrchestrationRecoveryOptions,
  type OrchestrationRecoveryResult,
  type OrchestrationSessionInspection,
  type OrchestrationSessionRunLinkStore,
  type OrchestrationSessionStore,
  type OrchestratedRunStageResult,
  type InputClaim,
  type JsonValue,
  type OrchestrationStore,
  type PreparedOrchestrationRunner,
  type PreparedOrchestrationRunNodeInput,
  type RunResult,
  type SubjectRoutingCandidateDiagnostic,
} from '@adaptive-agent/core';

import { AgentSdk, type AgentConfigFile, type AgentSdkOptions, type AgentSdkRunOptions, type SupportedModality } from './index.js';
import { resolveAgentSdkConfigWithSources } from './config-resolve.js';
import { validateAgent } from './config-validate.js';
import {
  buildDeterministicExecutionRoutingDecision,
  supportedModalities,
  validateExecutionRoutingDecision,
  type ExecutionRoutingDecision,
} from './execution-routing.js';
import { adaptiveAgentHome, expandStrings, readJson, resolveAgentConfigByName, resolveAgentDirs, resolvePath, pathExists } from './sdk-utils.js';
import type { AgentSettingsFile } from './config-types.js';
import { discoverCatalogAgentInventory } from './tool-registry.js';

// Persisted orchestration artifact contracts are owned by core; re-exported here to preserve the SDK API.
export type {
  InputClaim,
  OrchestratedRunResult,
  OrchestratedRunStageResult,
  OrchestrationConcurrencyPolicy,
  OrchestrationExecutionShape,
  OrchestrationInputSelector,
  OrchestrationLifecycleEvent,
  OrchestrationPlan,
  OrchestrationPlanNode,
  OrchestrationPlanNodeStatus,
  OrchestrationRecoveryOptions,
  OrchestrationRecoveryOutcome,
  OrchestrationRecoveryResult,
  OrchestrationRoutingDiagnostics,
  OrchestrationSessionInspection,
  OrchestrationSessionRecord,
  OrchestrationSessionRunLinkRecord,
  OrchestrationSessionRunLinkStore,
  OrchestrationSessionStatus,
  OrchestrationSessionStore,
  OrchestrationStageKind,
  SubjectRoutingCandidateDiagnostic,
} from '@adaptive-agent/core';

export interface AgentCatalogEntry {
  agentId: string;
  configPath?: string;
  agentConfig: AgentConfigFile;
}

export interface OrchestratedRunOptions extends AgentSdkRunOptions {
  executionId?: string;
  requestedAgentId?: string;
  sessionId?: string;
  catalogFingerprint?: string;
  routingDecision?: ExecutionRoutingDecision;
  finalizeWithRequestedAgent?: boolean;
  orchestrationMetadata?: JsonObject;
}

export interface OrchestratedExecutionOptions extends Omit<OrchestratedRunOptions, 'executionId' | 'sessionId' | 'requestedAgentId' | 'catalogFingerprint'> {
  executionId: string;
  requestedAgentId: string;
  catalogFingerprint?: string;
}

export interface OrchestrationSdkOptions extends AgentSdkOptions {
  requestedAgentConfig?: AgentConfigFile;
  requestedAgentConfigPath?: string;
  agentCatalog?: AgentCatalogEntry[];
  agentCatalogPaths?: string[];
  includeDiscoveredAgents?: boolean;
  sessionStore?: OrchestrationSessionStore;
  sessionRunLinkStore?: OrchestrationSessionRunLinkStore;
  orchestrationStore?: OrchestrationStore;
  catalogFingerprint?: string;
  sessionIdFactory?: () => string;
  now?: () => Date;
  concurrency?: OrchestrationConcurrencyPolicy;
  agentRunnerFactory?: (agentId: string, agentConfig: AgentConfigFile, options: AgentSdkOptions) => Promise<OrchestrationAgentRunner>;
  orchestrationListener?: (event: OrchestrationLifecycleEvent) => void;
  /**
   * While an execution is `routing`/`running`, stage activity newer than this is treated as owned by a
   * live scheduler and `recoverExecution` reports `busy`. Defaults to 60 seconds.
   */
  recoveryStaleAfterMs?: number;
}

/** Agent-profile runner: core run capabilities plus starting a raw SDK run for a stage. */
export interface OrchestrationAgentRunner extends PreparedOrchestrationRunner {
  runRaw(goal: string, options?: AgentSdkRunOptions): Promise<RunResult>;
  close?(): Promise<void>;
}

export class OrchestrationSdk {
  private readonly catalog = new Map<string, AgentCatalogEntry>();
  private readonly runners = new Map<string, OrchestrationAgentRunner>();
  private readonly sessionIdFactory: () => string;
  private readonly defaultRequestedAgentId: string;
  private orchestrationStore: OrchestrationStore;
  private readonly catalogFingerprint: string;
  private readonly executor: PreparedOrchestrationExecutor<OrchestratedRunOptions, OrchestrationAgentRunner>;

  private constructor(private readonly options: OrchestrationSdkOptions, entries: AgentCatalogEntry[]) {
    for (const entry of entries) {
      if (this.catalog.has(entry.agentId)) throw new Error(`Duplicate agent catalog entry "${entry.agentId}"`);
      this.catalog.set(entry.agentId, entry);
    }
    this.defaultRequestedAgentId = options.requestedAgentConfig?.id ?? options.agentConfig?.id ?? entries[0]?.agentId;
    if (!this.defaultRequestedAgentId) throw new Error('Orchestration SDK requires a requested agent config or non-empty agent catalog.');
    this.sessionIdFactory = options.sessionIdFactory ?? randomSessionId;
    this.orchestrationStore = options.orchestrationStore ?? new InMemoryOrchestrationStore();
    this.catalogFingerprint = options.catalogFingerprint ?? fingerprintCatalog(entries);
    this.executor = new PreparedOrchestrationExecutor<OrchestratedRunOptions, OrchestrationAgentRunner>({
      getStore: () => this.orchestrationStore,
      sessionStore: options.sessionStore,
      sessionRunLinkStore: options.sessionRunLinkStore,
      catalogFingerprint: this.catalogFingerprint,
      hasAgent: (agentId) => this.catalog.has(agentId),
      getRunner: (agentId) => this.getRunner(agentId),
      runNode: (input) => this.runNode(input),
      beforeRecovery: () => this.adoptRequestedRuntimeStore(),
      now: options.now,
      concurrency: options.concurrency,
      onLifecycleEvent: (event) => this.options.orchestrationListener?.(event),
      recoveryStaleAfterMs: options.recoveryStaleAfterMs,
    });
  }

  static async create(options: OrchestrationSdkOptions = {}): Promise<OrchestrationSdk> {
    return new OrchestrationSdk(options, await buildCatalog(options));
  }

  async run(goal: string, options: OrchestratedRunOptions = {}): Promise<OrchestratedRunResult> {
    return this.execute(goal, options);
  }

  async runRaw(goal: string, options: OrchestratedRunOptions = {}): Promise<OrchestratedRunResult> {
    return this.execute(goal, options);
  }

  async inspectSession(sessionId: string): Promise<OrchestrationSessionInspection> {
    return this.executor.inspectSession(sessionId);
  }

  async inspectExecution(executionId: string): Promise<OrchestrationExecutionInspection> {
    return this.executor.inspectExecution(executionId);
  }

  async interruptExecution(executionId: string): Promise<void> {
    return this.executor.interruptExecution(executionId);
  }

  async resumeExecution(executionId: string): Promise<OrchestratedRunResult> {
    return this.executor.resumeExecution(executionId);
  }

  /**
   * Recovers an unfinished orchestration execution from its saved plan without redecomposing.
   *
   * Successful independent stages are preserved. Each failed, paused, or stale stage is recovered at most
   * once through its own agent runner (`getRecoveryPlan` + `recoverRaw`); continuation run IDs are persisted
   * on the stage and as session run links. Downstream stages whose upstream results change are restarted
   * with fresh run IDs and recomputed input, then the saved plan continues. Cancellation, catalog drift,
   * live leases, user action, and reconciliation requirements return `blocked` or `busy` instead.
   */
  async recoverExecution(executionId: string, options: OrchestrationRecoveryOptions = {}): Promise<OrchestrationRecoveryResult> {
    return this.executor.recoverExecution(executionId, options);
  }

  async close(): Promise<void> {
    await Promise.all([...this.runners.values()].map((runner) => runner.close?.()));
    this.runners.clear();
  }

  private async adoptRequestedRuntimeStore(): Promise<void> {
    if (this.options.orchestrationStore || this.options.agentRunnerFactory) return;
    const requestedRunner = await this.getRunner(this.defaultRequestedAgentId);
    if (requestedRunner instanceof AgentSdk) this.orchestrationStore = requestedRunner.created.runtime.orchestrationStore;
  }

  private async execute(goal: string, options: OrchestratedRunOptions): Promise<OrchestratedRunResult> {
    if (options.contextRefs && options.contextRefs.length > 0) {
      throw new Error('Context refs are not supported for orchestration until stage propagation semantics are defined.');
    }
    const executionId = options.executionId ?? options.sessionId ?? this.sessionIdFactory();
    const sessionId = options.sessionId ?? executionId;
    const requestedAgentId = options.requestedAgentId ?? this.defaultRequestedAgentId;
    if (!this.options.orchestrationStore && !this.options.agentRunnerFactory) {
      const requestedRunner = await this.getRunner(requestedAgentId);
      if (requestedRunner instanceof AgentSdk) this.orchestrationStore = requestedRunner.created.runtime.orchestrationStore;
    }
    const fingerprint = options.catalogFingerprint ?? this.catalogFingerprint;
    const plan = buildOrchestrationPlan({ sessionId, requestedAgentId, goal, options, catalog: this.catalog, catalogFingerprint: fingerprint, routingDecision: options.routingDecision, finalizeWithRequestedAgent: options.finalizeWithRequestedAgent ?? true });
    if (executionId !== sessionId) plan.executionId = executionId;
    return this.executor.start({
      executionId,
      plan,
      request: { goal, options },
      persistedRequest: { goal, options: stripOrchestrationOptions(options) },
      catalogFingerprint: fingerprint,
      sessionMetadata: options.orchestrationMetadata,
    });
  }

  /** Starts one stage run: builds the stage prompt and inputs, then runs it with the allocated run/session IDs. */
  private runNode({ runner, goal, options, plan, node, priorResults, runId, sessionId }: PreparedOrchestrationRunNodeInput<OrchestratedRunOptions, OrchestrationAgentRunner>): Promise<RunResult> {
    const runGoal = buildNodeGoal(goal, node);
    const runOptions = buildNodeOptions(options, plan, node, priorResults, supportedModalities(this.catalog.get(node.agentId)!.agentConfig));
    return runner.runRaw(runGoal, { ...runOptions, runId, sessionId });
  }

  private async getRunner(agentId: string): Promise<OrchestrationAgentRunner> {
    const cached = this.runners.get(agentId);
    if (cached) return cached;
    const entry = this.catalog.get(agentId);
    if (!entry) throw new Error(`Unknown orchestration agent "${agentId}"`);
    const runner = this.options.agentRunnerFactory
      ? await this.options.agentRunnerFactory(agentId, entry.agentConfig, this.options)
      : await AgentSdk.create({ ...this.options, agentConfig: entry.agentConfig, agentConfigPath: entry.configPath, runtime: [...this.runners.values()][0] instanceof AgentSdk ? ([...this.runners.values()][0] as AgentSdk).created.runtime : this.options.runtime });
    this.runners.set(agentId, runner);
    return runner;
  }
}

export async function createOrchestrationSdk(options: OrchestrationSdkOptions = {}): Promise<OrchestrationSdk> {
  return OrchestrationSdk.create(options);
}

export function detectInputClaims(goal: string, options: AgentSdkRunOptions): InputClaim[] {
  const claims: InputClaim[] = [{ id: 'goal', modality: 'text', source: 'goal', index: 0 }];
  options.images?.forEach((image, index) => claims.push({ id: `images.${index}`, modality: 'image', source: 'images', index, name: image.name }));
  options.contentParts?.forEach((part, index) => {
    if (part.type === 'text' && part.text.trim()) claims.push({ id: `contentParts.${index}`, modality: 'text', source: 'contentParts', index });
    if (part.type === 'image') claims.push({ id: `contentParts.${index}`, modality: 'image', source: 'contentParts', index, name: part.image.name });
    if (part.type === 'file') claims.push({ id: `contentParts.${index}`, modality: 'file', source: 'contentParts', index, mimeType: part.file.mimeType, name: part.file.name });
    if (part.type === 'audio') claims.push({ id: `contentParts.${index}`, modality: 'audio', source: 'contentParts', index, mimeType: part.audio.mimeType, name: part.audio.name });
  });
  if (options.input && typeof options.input === 'object' && !Array.isArray(options.input)) {
    for (const modality of ['image', 'file', 'audio'] as const) {
      if (modality in options.input) claims.push({ id: `input.${modality}`, modality, source: 'input' });
    }
  }
  return claims;
}

export function buildOrchestrationPlan(params: { sessionId: string; requestedAgentId: string; goal: string; options: AgentSdkRunOptions; catalog: Map<string, AgentCatalogEntry>; catalogFingerprint?: string; routingDecision?: ExecutionRoutingDecision; finalizeWithRequestedAgent: boolean }): OrchestrationPlan {
  const requested = params.catalog.get(params.requestedAgentId);
  if (!requested) throw new Error(`Unknown requested agent "${params.requestedAgentId}"`);
  const inputClaims = detectInputClaims(params.goal, params.options);
  const detectedModalities = unique(inputClaims.map((claim) => claim.modality));
  if (params.routingDecision?.mode === 'direct') throw new Error('Direct execution routing cannot be launched as an orchestration plan.');
  if (params.routingDecision && params.routingDecision.primaryAgentId !== params.requestedAgentId) {
    throw new Error(`Execution routing primary agent "${params.routingDecision.primaryAgentId}" does not match requested agent "${params.requestedAgentId}".`);
  }
  const baseDecision = params.routingDecision ?? buildDeterministicExecutionRoutingDecision({
      requestedAgentId: params.requestedAgentId,
      detectedModalities,
      catalog: params.catalog,
      forceOrchestration: true,
      synthesize: params.finalizeWithRequestedAgent,
    });
  validateExecutionRoutingDecision(baseDecision, detectedModalities, params.catalog);
  const subjectRouting: { selected?: { entry: AgentCatalogEntry; matchedSubjects: string[] }; candidates: SubjectRoutingCandidateDiagnostic[] } = params.routingDecision
    ? { candidates: [] as SubjectRoutingCandidateDiagnostic[] }
    : chooseSubjectSpecialist(params.catalog, params.goal, params.requestedAgentId);
  const subjectSpecialist = subjectRouting.selected;
  const detectedSubjects = subjectSpecialist?.matchedSubjects ?? [];
  const routingDiagnostics = { subjectCandidates: subjectRouting.candidates };
  const modalityAssignments = baseDecision.assignments.filter((assignment) => assignment.agentId !== params.requestedAgentId);
  const hasSpecialists = modalityAssignments.length > 0 || Boolean(subjectSpecialist);
  const routingReason = params.routingDecision
    ? params.routingDecision.reason
    : hasSpecialists
    ? buildRoutingReason(params.requestedAgentId, modalityAssignments.flatMap((assignment) => assignment.modalities), detectedSubjects, params.finalizeWithRequestedAgent)
    : baseDecision.reason;
  const routingDecision: ExecutionRoutingDecision = {
    ...baseDecision,
    ...(params.finalizeWithRequestedAgent && hasSpecialists && !baseDecision.synthesisAgentId ? { synthesisAgentId: params.requestedAgentId } : {}),
    selectedCatalogAgentIds: unique([
      ...baseDecision.selectedCatalogAgentIds,
      ...(subjectSpecialist ? [subjectSpecialist.entry.agentId] : []),
    ]),
    reason: routingReason,
  };
  validateExecutionRoutingDecision(routingDecision, detectedModalities, params.catalog);
  const catalogFingerprint = params.catalogFingerprint ?? fingerprintCatalog([...params.catalog.values()]);
  if (!hasSpecialists) {
    return { sessionId: params.sessionId, requestedAgentId: params.requestedAgentId, catalogFingerprint, detectedModalities, detectedSubjects, inputClaims, executionShape: 'single', nodes: [{ id: 'requested', agentId: params.requestedAgentId, stage: 'single', dependsOn: [], inputSelector: { includeGoal: true, includeOriginalInput: true } }], finalNodeId: 'requested', routingReason, routingDecision, routingDiagnostics };
  }

  const specialistNodes: OrchestrationPlanNode[] = modalityAssignments.map((assignment) => {
    const slug = assignment.modalities.join('_');
    return {
      id: `${slug}_specialist`,
      agentId: assignment.agentId,
      stage: modalityAssignments.length === 1 ? 'modality_specialist' as const : 'parallel_specialist' as const,
      dependsOn: [],
      inputSelector: { includeGoal: true, claimIds: inputClaims.filter((claim) => assignment.modalities.includes(claim.modality)).map((claim) => claim.id) },
      outputRole: `${slug}_analysis`,
      metadata: { assignedModalities: assignment.modalities },
    };
  });
  if (subjectSpecialist) {
    const existing = specialistNodes.find((node) => node.agentId === subjectSpecialist.entry.agentId);
    if (existing) {
      existing.metadata = { ...(existing.metadata ?? {}), matchedSubjects: subjectSpecialist.matchedSubjects };
    } else {
      specialistNodes.push({ id: `subject_${slugify(subjectSpecialist.matchedSubjects[0] ?? subjectSpecialist.entry.agentId)}_specialist`, agentId: subjectSpecialist.entry.agentId, stage: 'subject_specialist', dependsOn: [], inputSelector: { includeGoal: true }, outputRole: `${subjectSpecialist.matchedSubjects.join('_') || 'subject'}_analysis`, metadata: { matchedSubjects: subjectSpecialist.matchedSubjects } });
    }
  }
  if (!params.finalizeWithRequestedAgent) {
    const first = specialistNodes[0]!;
    return { sessionId: params.sessionId, requestedAgentId: params.requestedAgentId, catalogFingerprint, detectedModalities, detectedSubjects, inputClaims, executionShape: specialistNodes.length === 1 ? 'single' : 'parallel_fanout_then_synthesis', nodes: specialistNodes, finalNodeId: first.id, routingReason, routingDecision, routingDiagnostics };
  }
  const finalNode = { id: 'final_synthesis', agentId: routingDecision.synthesisAgentId ?? params.requestedAgentId, stage: 'final_synthesis' as const, dependsOn: specialistNodes.map((node) => node.id), inputSelector: { includeGoal: true, includeOriginalInput: true, includePriorOutputs: specialistNodes.map((node) => node.id) } };
  return { sessionId: params.sessionId, requestedAgentId: params.requestedAgentId, catalogFingerprint, detectedModalities, detectedSubjects, inputClaims, executionShape: specialistNodes.length === 1 ? 'sequential' : 'parallel_fanout_then_synthesis', nodes: [...specialistNodes, finalNode], finalNodeId: finalNode.id, routingReason, routingDecision, routingDiagnostics };
}

function buildNodeOptions(options: OrchestratedRunOptions, plan: OrchestrationPlan, node: OrchestrationPlanNode, priorResults: Map<string, OrchestratedRunStageResult>, requestedModalities: SupportedModality[]): AgentSdkRunOptions {
  const priorOutputs = Object.fromEntries((node.inputSelector?.includePriorOutputs ?? node.dependsOn).map((id) => {
    const result = priorResults.get(id)?.result;
    return [id, resultToJson(result)];
  }));
  const orchestration = { kind: 'catalog', executionId: plan.executionId ?? plan.sessionId, sessionId: plan.sessionId, requestedAgentId: plan.requestedAgentId, selectedAgentId: node.agentId, selectedCatalogAgentIds: plan.routingDecision.selectedCatalogAgentIds, modalityAssignments: plan.routingDecision.assignments as unknown as JsonValue, routingSource: plan.routingDecision.source, catalogFingerprint: plan.catalogFingerprint, executionShape: plan.executionShape, stage: node.stage, nodeId: node.id, dependsOn: node.dependsOn, detectedModalities: plan.detectedModalities, routingReason: plan.routingReason } satisfies JsonObject;
  if (node.stage === 'final_synthesis') {
    const raw = selectSynthesisAttachments(options, requestedModalities);
    return { ...raw, input: { originalInput: filterInputModalities(options.input, new Set(requestedModalities)) ?? null, upstreamResults: priorOutputs }, context: { ...(options.context ?? {}), sessionId: plan.sessionId, orchestration }, executionContext: options.executionContext, inferenceTier: options.inferenceTier, outputSchema: options.outputSchema, metadata: { ...(options.metadata ?? {}), orchestration } };
  }
  return { ...selectNodeInputs(options, plan, node), context: { ...(options.context ?? {}), sessionId: plan.sessionId, orchestration }, executionContext: options.executionContext, inferenceTier: options.inferenceTier, outputSchema: options.outputSchema, metadata: { ...(options.metadata ?? {}), orchestration } };
}

function selectNodeInputs(options: OrchestratedRunOptions, plan: OrchestrationPlan, node: OrchestrationPlanNode): AgentSdkRunOptions {
  if (node.inputSelector?.includeOriginalInput) return options;
  const claimIds = new Set(node.inputSelector?.claimIds ?? []);
  const selectedClaims = plan.inputClaims.filter((claim) => claimIds.has(claim.id));
  return {
    ...selectStructuredInput(options, selectedClaims),
    ...selectImages(options, selectedClaims),
    ...selectContentParts(options, selectedClaims),
  };
}

function selectStructuredInput(options: OrchestratedRunOptions, claims: InputClaim[]): Pick<AgentSdkRunOptions, 'input'> {
  if (!options.input || typeof options.input !== 'object' || Array.isArray(options.input)) return {};
  const selectedModalities = new Set(claims
    .filter((claim) => claim.source === 'input')
    .map((claim) => claim.modality));
  if (selectedModalities.size === 0) return {};
  return { input: filterInputModalities(options.input, selectedModalities) };
}

function filterInputModalities(input: JsonValue | undefined, supported: Set<SupportedModality>): JsonValue | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const modalityKeys = new Set<SupportedModality>(['image', 'file', 'audio']);
  return Object.fromEntries(Object.entries(input).filter(([key]) =>
    !modalityKeys.has(key as SupportedModality) || supported.has(key as SupportedModality)
  ));
}

function selectImages(options: OrchestratedRunOptions, claims: InputClaim[]): Pick<AgentSdkRunOptions, 'images'> {
  const images = claims
    .filter((claim) => claim.source === 'images' && claim.index !== undefined)
    .map((claim) => options.images?.[claim.index!])
    .filter((image): image is NonNullable<AgentSdkRunOptions['images']>[number] => Boolean(image));
  return images.length > 0 ? { images } : {};
}

function selectContentParts(options: OrchestratedRunOptions, claims: InputClaim[]): Pick<AgentSdkRunOptions, 'contentParts'> {
  const contentParts = claims
    .filter((claim) => claim.source === 'contentParts' && claim.index !== undefined)
    .map((claim) => options.contentParts?.[claim.index!])
    .filter((part): part is NonNullable<AgentSdkRunOptions['contentParts']>[number] => Boolean(part));
  return contentParts.length > 0 ? { contentParts } : {};
}

function selectSynthesisAttachments(options: OrchestratedRunOptions, supported: SupportedModality[]): Pick<AgentSdkRunOptions, 'images' | 'contentParts'> {
  const images = supported.includes('image') ? options.images : undefined;
  const contentParts = options.contentParts?.filter((part) => (part.type === 'file' && supported.includes('file')) || (part.type === 'image' && supported.includes('image')) || (part.type === 'audio' && supported.includes('audio')) || part.type === 'text');
  return { ...(images?.length ? { images } : {}), ...(contentParts?.length ? { contentParts } : {}) };
}

function resultToJson(result: RunResult | undefined): JsonValue {
  if (!result) return null;
  if (result.status === 'success') return result.output;
  if (result.status === 'failure') return { status: result.status, runId: result.runId, error: result.error, code: result.code };
  return { status: result.status, runId: result.runId, message: result.message };
}

function buildNodeGoal(originalGoal: string, node: OrchestrationPlanNode): string {
  if (node.stage === 'final_synthesis') return buildSynthesisGoal(originalGoal);
  if (node.stage !== 'modality_specialist' && node.stage !== 'parallel_specialist') return originalGoal;
  const assignedModalities = node.metadata?.assignedModalities;
  if (!Array.isArray(assignedModalities) || assignedModalities.length === 0 || assignedModalities.some((modality) => typeof modality !== 'string')) return originalGoal;
  return [
    'Complete only the part of the original user request assigned to this specialist node.',
    `Assigned modalities: ${assignedModalities.join(', ')}.`,
    'Use the supplied inputs for those modalities now. Do not request inputs for other modalities; other specialists handle them.',
    'Return your findings for use in the final response.',
    '',
    `Original user request: ${originalGoal}`,
  ].join('\n');
}

function buildSynthesisGoal(originalGoal: string): string {
  return ['Complete the original user request using the specialist result(s) already produced.', 'Do not assume access to raw attachments unless they are included explicitly.', '', `Original user request: ${originalGoal}`].join('\n');
}

function chooseSubjectSpecialist(catalog: Map<string, AgentCatalogEntry>, goal: string, requestedAgentId: string): { selected?: { entry: AgentCatalogEntry; matchedSubjects: string[] }; candidates: SubjectRoutingCandidateDiagnostic[] } {
  const scored = [...catalog.values()].map((entry) => ({ entry, ...subjectScore(entry, goal) }));
  const requestedScore = scored.find((candidate) => candidate.entry.agentId === requestedAgentId)?.score ?? 0;
  const selected = scored
    .filter((candidate) => candidate.entry.agentId !== requestedAgentId)
    .filter((candidate) => candidate.score > 0 && candidate.score > requestedScore)
    .sort((left, right) => right.score - left.score || left.entry.agentId.localeCompare(right.entry.agentId))[0];
  return {
    selected: selected ? { entry: selected.entry, matchedSubjects: selected.matchedSubjects } : undefined,
    candidates: scored.map((candidate) => ({
      agentId: candidate.entry.agentId,
      score: candidate.score,
      matchedSubjects: candidate.matchedSubjects,
      matchedKeywords: candidate.matchedKeywords,
      selected: candidate.entry.agentId === selected?.entry.agentId,
      requestedAgent: candidate.entry.agentId === requestedAgentId,
    })),
  };
}

function subjectScore(entry: AgentCatalogEntry, goal: string): { score: number; matchedSubjects: string[]; matchedKeywords: string[] } {
  const preferredSubjects = entry.agentConfig.capabilities?.subjectsPreferred ?? [];
  const keywords = routingKeywords(entry.agentConfig.routing);
  const matchedSubjects = unique(preferredSubjects.filter((subject) => containsPhrase(goal, subject)));
  const matchedKeywords = unique(keywords.filter((keyword) => containsPhrase(goal, keyword)));
  return { score: matchedSubjects.length * 4 + matchedKeywords.length * 2, matchedSubjects: matchedSubjects.length > 0 ? matchedSubjects : matchedKeywords, matchedKeywords };
}

function routingKeywords(routing: JsonObject | undefined): string[] {
  const keywords = routing?.keywords;
  return Array.isArray(keywords) ? keywords.filter((keyword): keyword is string => typeof keyword === 'string' && keyword.trim().length > 0) : [];
}

function containsPhrase(text: string, phrase: string): boolean {
  return normalizeSearchText(text).includes(normalizeSearchText(phrase));
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function slugify(value: string): string {
  return normalizeSearchText(value).replace(/\s+/g, '_') || 'subject';
}

function buildRoutingReason(requestedAgentId: string, modalities: SupportedModality[], subjects: string[], synthesize: boolean): string {
  const parts = [
    modalities.length > 0 ? `modalities (${modalities.join(', ')})` : undefined,
    subjects.length > 0 ? `subjects (${subjects.join(', ')})` : undefined,
  ].filter((part): part is string => Boolean(part));
  return synthesize
    ? `Routed ${parts.join(' and ')} to specialist agent(s), then synthesized with requested agent "${requestedAgentId}".`
    : `Routed ${parts.join(' and ')} to specialist agent(s) without requested-agent synthesis.`;
}

async function buildCatalog(options: OrchestrationSdkOptions): Promise<AgentCatalogEntry[]> {
  const entries = new Map<string, AgentCatalogEntry>();
  const cwd = options.cwd ?? process.cwd();
  const env = { ...(options.env ?? process.env), ...(options.settingsConfig?.env ?? {}) };
  const agentDirs = await resolveCatalogAgentDirs(options, cwd, env);
  if (options.includeDiscoveredAgents) {
    const resolved = await resolveAgentSdkConfigWithSources(options);
    const inventory = await discoverCatalogAgentInventory(resolved.config, resolved.agentPath, options);
    for (const candidate of inventory.agents) {
      if (candidate.archived || candidate.validationState !== 'valid' || !candidate.invocationModes.includes('run')) continue;
      const agentConfig = validateAgent(expandStrings(await readJson(candidate.configPath), env), candidate.configPath);
      entries.set(candidate.id, { agentId: candidate.id, configPath: candidate.configPath, agentConfig });
    }
  }
  for (const entry of options.agentCatalog ?? []) entries.set(entry.agentId, entry);
  for (const pathOrName of options.agentCatalogPaths ?? []) {
    const configPath = await resolveAgentConfigByName(pathOrName, agentDirs) ?? resolvePath(cwd, pathOrName);
    const agentConfig = validateAgent(expandStrings(await readJson(configPath), env), configPath);
    entries.set(agentConfig.id, { agentId: agentConfig.id, configPath, agentConfig });
  }
  const requestedConfig = options.requestedAgentConfig ?? options.agentConfig;
  if (requestedConfig) entries.set(requestedConfig.id, { agentId: requestedConfig.id, configPath: options.requestedAgentConfigPath ?? options.agentConfigPath, agentConfig: requestedConfig });
  return [...entries.values()];
}

async function resolveCatalogAgentDirs(options: OrchestrationSdkOptions, cwd: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  let settings = options.settingsConfig;
  if (!settings) {
    const settingsPath = await findSettingsPath(options, cwd, env);
    settings = settingsPath ? await readJson(settingsPath) as AgentSettingsFile : undefined;
  }
  if (settings?.env) Object.assign(env, settings.env);
  return resolveAgentDirs(cwd, options.settingsOverrides?.agents?.dirs ?? settings?.agents?.dirs, env);
}

async function findSettingsPath(options: OrchestrationSdkOptions, cwd: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const candidates = [
    options.settingsConfigPath,
    env.ADAPTIVE_AGENT_SETTINGS,
    resolve(cwd, 'agent.settings.json'),
    resolve(adaptiveAgentHome(env), 'agent.settings.json'),
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    const path = resolvePath(cwd, candidate);
    if (await pathExists(path)) return path;
  }
  return undefined;
}

function stripOrchestrationOptions(options: OrchestratedRunOptions): OrchestratedRunOptions {
  const copy = { ...options };
  delete copy.executionId;
  delete copy.sessionId;
  delete copy.requestedAgentId;
  delete copy.catalogFingerprint;
  delete copy.routingDecision;
  return copy;
}

function fingerprintCatalog(entries: AgentCatalogEntry[]): string {
  const exactCatalog = entries
    .map((entry) => ({
      agentId: entry.agentId,
      configPath: entry.configPath ?? null,
      agentConfig: {
        ...entry.agentConfig,
        model: { ...entry.agentConfig.model, apiKey: undefined },
      },
    }))
    .sort((left, right) => left.agentId.localeCompare(right.agentId));
  return createHash('sha256').update(stableJson(exactCatalog)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function randomSessionId(): string {
  return randomUUID();
}
