import { resolve } from 'node:path';

import type { JsonObject, JsonValue, RunResult } from '@adaptive-agent/core';

import { AgentSdk, type AgentConfigFile, type AgentSdkOptions, type AgentSdkRunOptions, type SupportedModality } from './index.js';
import { adaptiveAgentHome, expandStrings, readJson, resolveAgentConfigByName, resolveAgentDirs, resolvePath, pathExists } from './sdk-utils.js';
import type { AgentSettingsFile } from './config-types.js';

export type OrchestrationSessionStatus = 'routing' | 'running' | 'succeeded' | 'failed';
export type OrchestrationStageKind = 'single' | 'modality_specialist' | 'parallel_specialist' | 'subject_specialist' | 'final_synthesis';
export type OrchestrationExecutionShape = 'single' | 'sequential' | 'parallel_fanout_then_synthesis';
export type OrchestrationPlanNodeStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface InputClaim {
  id: string;
  modality: SupportedModality;
  source: 'goal' | 'images' | 'contentParts' | 'input';
  index?: number;
  mimeType?: string;
  name?: string;
}

export interface OrchestrationInputSelector {
  claimIds?: string[];
  includeGoal?: boolean;
  includeOriginalInput?: boolean;
  includePriorOutputs?: string[];
}

export interface OrchestrationPlanNode {
  id: string;
  agentId: string;
  stage: OrchestrationStageKind;
  dependsOn: string[];
  inputSelector?: OrchestrationInputSelector;
  outputRole?: string;
  metadata?: JsonObject;
}

export interface SubjectRoutingCandidateDiagnostic {
  agentId: string;
  score: number;
  matchedSubjects: string[];
  matchedKeywords: string[];
  selected: boolean;
  requestedAgent: boolean;
}

export interface OrchestrationRoutingDiagnostics {
  subjectCandidates: SubjectRoutingCandidateDiagnostic[];
}

export interface OrchestrationPlan {
  sessionId: string;
  requestedAgentId: string;
  detectedModalities: SupportedModality[];
  detectedSubjects: string[];
  inputClaims: InputClaim[];
  executionShape: OrchestrationExecutionShape;
  nodes: OrchestrationPlanNode[];
  finalNodeId: string;
  routingReason: string;
  routingDiagnostics: OrchestrationRoutingDiagnostics;
}

export interface OrchestrationSessionRecord {
  id: string;
  requestedAgentId: string;
  status: OrchestrationSessionStatus;
  executionShape: OrchestrationExecutionShape;
  detectedModalities: SupportedModality[];
  detectedSubjects?: string[];
  routingReason: string;
  metadata?: JsonObject;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface OrchestrationSessionRunLinkRecord {
  sessionId: string;
  nodeId: string;
  runId: string;
  rootRunId: string;
  stage: OrchestrationStageKind;
  agentId: string;
  requestedAgentId: string;
  status: OrchestrationPlanNodeStatus;
  dependsOn: string[];
  upstreamRunIds?: string[];
  metadata?: JsonObject;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface AgentCatalogEntry {
  agentId: string;
  configPath?: string;
  agentConfig: AgentConfigFile;
}

export interface OrchestrationSessionInspection {
  session: OrchestrationSessionRecord | undefined;
  links: OrchestrationSessionRunLinkRecord[];
  plan?: OrchestrationPlan;
}

export interface OrchestrationConcurrencyPolicy {
  maxConcurrentRunsPerSession?: number;
  failurePolicy?: 'fail_fast' | 'wait_for_all';
}

export interface OrchestratedRunOptions extends AgentSdkRunOptions {
  requestedAgentId?: string;
  sessionId?: string;
  finalizeWithRequestedAgent?: boolean;
  orchestrationMetadata?: JsonObject;
}

export interface OrchestratedRunStageResult {
  nodeId: string;
  stage: OrchestrationStageKind;
  agentId: string;
  runId: string;
  rootRunId: string;
  result: RunResult;
}

export interface OrchestratedRunResult {
  sessionId: string;
  requestedAgentId: string;
  detectedModalities: SupportedModality[];
  detectedSubjects: string[];
  executionShape: OrchestrationExecutionShape;
  plan: OrchestrationPlan;
  stages: OrchestratedRunStageResult[];
  finalResult: RunResult;
}

export type OrchestrationLifecycleEvent =
  | {
      type: 'orchestration.plan.created';
      sessionId: string;
      requestedAgentId: string;
      executionShape: OrchestrationExecutionShape;
      detectedModalities: SupportedModality[];
      detectedSubjects: string[];
      routingReason: string;
      nodes: Array<Pick<OrchestrationPlanNode, 'id' | 'agentId' | 'stage' | 'dependsOn'>>;
      createdAt: string;
    }
  | {
      type: 'orchestration.session.created' | 'orchestration.session.running';
      sessionId: string;
      requestedAgentId: string;
      status: OrchestrationSessionStatus;
      executionShape: OrchestrationExecutionShape;
      detectedModalities: SupportedModality[];
      detectedSubjects: string[];
      routingReason: string;
      createdAt: string;
    }
  | {
      type: 'orchestration.stage.starting';
      sessionId: string;
      requestedAgentId: string;
      nodeId: string;
      agentId: string;
      stage: OrchestrationStageKind;
      dependsOn: string[];
      createdAt: string;
    }
  | {
      type: 'orchestration.stage.linked';
      sessionId: string;
      requestedAgentId: string;
      nodeId: string;
      agentId: string;
      stage: OrchestrationStageKind;
      runId: string;
      rootRunId: string;
      status: OrchestrationPlanNodeStatus;
      createdAt: string;
    }
  | {
      type: 'orchestration.session.completed';
      sessionId: string;
      requestedAgentId: string;
      status: OrchestrationSessionStatus;
      executionShape: OrchestrationExecutionShape;
      finalRunId: string;
      createdAt: string;
    };

export interface OrchestrationSessionStore {
  create(session: OrchestrationSessionRecord): Promise<OrchestrationSessionRecord>;
  get(sessionId: string): Promise<OrchestrationSessionRecord | undefined>;
  update(session: OrchestrationSessionRecord): Promise<OrchestrationSessionRecord>;
}

export interface OrchestrationSessionRunLinkStore {
  append(link: OrchestrationSessionRunLinkRecord): Promise<OrchestrationSessionRunLinkRecord>;
  update(link: OrchestrationSessionRunLinkRecord): Promise<OrchestrationSessionRunLinkRecord>;
  listBySession(sessionId: string): Promise<OrchestrationSessionRunLinkRecord[]>;
  getByRunId(runId: string): Promise<OrchestrationSessionRunLinkRecord | undefined>;
}

export interface OrchestrationSdkOptions extends AgentSdkOptions {
  requestedAgentConfig?: AgentConfigFile;
  requestedAgentConfigPath?: string;
  agentCatalog?: AgentCatalogEntry[];
  agentCatalogPaths?: string[];
  sessionStore?: OrchestrationSessionStore;
  sessionRunLinkStore?: OrchestrationSessionRunLinkStore;
  sessionIdFactory?: () => string;
  now?: () => Date;
  concurrency?: OrchestrationConcurrencyPolicy;
  agentRunnerFactory?: (agentId: string, agentConfig: AgentConfigFile, options: AgentSdkOptions) => Promise<OrchestrationAgentRunner>;
  orchestrationListener?: (event: OrchestrationLifecycleEvent) => void;
}

export interface OrchestrationAgentRunner {
  runRaw(goal: string, options?: AgentSdkRunOptions): Promise<RunResult>;
  inspect(runId: string): Promise<{ run: { rootRunId?: string } | null }>;
  close?(): Promise<void>;
}

export class OrchestrationSdk {
  private readonly catalog = new Map<string, AgentCatalogEntry>();
  private readonly runners = new Map<string, OrchestrationAgentRunner>();
  private readonly sessionStore: OrchestrationSessionStore;
  private readonly linkStore: OrchestrationSessionRunLinkStore;
  private readonly plans = new Map<string, OrchestrationPlan>();
  private readonly sessionIdFactory: () => string;
  private readonly now: () => Date;
  private readonly concurrency: Required<OrchestrationConcurrencyPolicy>;
  private readonly defaultRequestedAgentId: string;

  private constructor(private readonly options: OrchestrationSdkOptions, entries: AgentCatalogEntry[]) {
    for (const entry of entries) {
      if (this.catalog.has(entry.agentId)) throw new Error(`Duplicate agent catalog entry "${entry.agentId}"`);
      this.catalog.set(entry.agentId, entry);
    }
    this.defaultRequestedAgentId = options.requestedAgentConfig?.id ?? options.agentConfig?.id ?? entries[0]?.agentId;
    if (!this.defaultRequestedAgentId) throw new Error('Orchestration SDK requires a requested agent config or non-empty agent catalog.');
    this.sessionStore = options.sessionStore ?? new InMemoryOrchestrationSessionStore();
    this.linkStore = options.sessionRunLinkStore ?? new InMemoryOrchestrationSessionRunLinkStore();
    this.sessionIdFactory = options.sessionIdFactory ?? randomSessionId;
    this.now = options.now ?? (() => new Date());
    this.concurrency = {
      maxConcurrentRunsPerSession: options.concurrency?.maxConcurrentRunsPerSession ?? 2,
      failurePolicy: options.concurrency?.failurePolicy ?? 'fail_fast',
    };
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
    return { session: await this.sessionStore.get(sessionId), links: await this.linkStore.listBySession(sessionId), plan: this.plans.get(sessionId) };
  }

  async close(): Promise<void> {
    await Promise.all([...this.runners.values()].map((runner) => runner.close?.()));
    this.runners.clear();
  }

  private async execute(goal: string, options: OrchestratedRunOptions): Promise<OrchestratedRunResult> {
    if (options.contextRefs && options.contextRefs.length > 0) {
      throw new Error('Context refs are not supported for orchestration until stage propagation semantics are defined.');
    }
    const sessionId = options.sessionId ?? this.sessionIdFactory();
    const requestedAgentId = options.requestedAgentId ?? this.defaultRequestedAgentId;
    const plan = buildOrchestrationPlan({ sessionId, requestedAgentId, goal, options, catalog: this.catalog, finalizeWithRequestedAgent: options.finalizeWithRequestedAgent ?? true });
    this.plans.set(sessionId, plan);
    this.emitLifecycle({
      type: 'orchestration.plan.created',
      sessionId,
      requestedAgentId,
      executionShape: plan.executionShape,
      detectedModalities: plan.detectedModalities,
      detectedSubjects: plan.detectedSubjects,
      routingReason: plan.routingReason,
      nodes: plan.nodes.map((node) => ({ id: node.id, agentId: node.agentId, stage: node.stage, dependsOn: node.dependsOn })),
      createdAt: this.now().toISOString(),
    });

    const createdAt = this.now().toISOString();
    let session = await this.sessionStore.create({ id: sessionId, requestedAgentId, status: 'routing', executionShape: plan.executionShape, detectedModalities: plan.detectedModalities, detectedSubjects: plan.detectedSubjects, routingReason: plan.routingReason, metadata: options.orchestrationMetadata, createdAt, updatedAt: createdAt });
    this.emitLifecycle({ type: 'orchestration.session.created', sessionId, requestedAgentId, status: session.status, executionShape: plan.executionShape, detectedModalities: plan.detectedModalities, detectedSubjects: plan.detectedSubjects, routingReason: plan.routingReason, createdAt: this.now().toISOString() });
    session = await this.sessionStore.update({ ...session, status: 'running', updatedAt: this.now().toISOString() });
    this.emitLifecycle({ type: 'orchestration.session.running', sessionId, requestedAgentId, status: session.status, executionShape: plan.executionShape, detectedModalities: plan.detectedModalities, detectedSubjects: plan.detectedSubjects, routingReason: plan.routingReason, createdAt: this.now().toISOString() });

    const results = new Map<string, OrchestratedRunStageResult>();
    const pending = new Set(plan.nodes.map((node) => node.id));
    let finalResult: RunResult | undefined;

    while (pending.size > 0) {
      const ready = plan.nodes.filter((node) => pending.has(node.id) && node.dependsOn.every((dependency) => results.has(dependency)));
      if (ready.length === 0) throw new Error(`Unable to make progress in orchestration plan ${sessionId}.`);

      const batch = ready.slice(0, this.concurrency.maxConcurrentRunsPerSession);
      const settled = await Promise.all(batch.map((node) => this.executeNode(goal, options, plan, node, results)));
      for (const stageResult of settled) {
        results.set(stageResult.nodeId, stageResult);
        pending.delete(stageResult.nodeId);
        if (stageResult.result.status === 'failure' && this.concurrency.failurePolicy === 'fail_fast') {
          finalResult = stageResult.result;
          pending.clear();
          break;
        }
      }
    }

    finalResult ??= results.get(plan.finalNodeId)?.result ?? [...results.values()].at(-1)?.result;
    if (!finalResult) throw new Error(`Orchestration plan ${sessionId} completed without a final result.`);
    const completedStatus = finalResult.status === 'success' ? 'succeeded' : 'failed';
    await this.sessionStore.update({ ...session, status: completedStatus, updatedAt: this.now().toISOString(), completedAt: this.now().toISOString() });
    this.emitLifecycle({ type: 'orchestration.session.completed', sessionId, requestedAgentId, status: completedStatus, executionShape: plan.executionShape, finalRunId: finalResult.runId, createdAt: this.now().toISOString() });

    return { sessionId, requestedAgentId, detectedModalities: plan.detectedModalities, detectedSubjects: plan.detectedSubjects, executionShape: plan.executionShape, plan, stages: plan.nodes.map((node) => results.get(node.id)).filter((result): result is OrchestratedRunStageResult => Boolean(result)), finalResult };
  }

  private async executeNode(goal: string, options: OrchestratedRunOptions, plan: OrchestrationPlan, node: OrchestrationPlanNode, priorResults: Map<string, OrchestratedRunStageResult>): Promise<OrchestratedRunStageResult> {
    this.emitLifecycle({ type: 'orchestration.stage.starting', sessionId: plan.sessionId, requestedAgentId: plan.requestedAgentId, nodeId: node.id, agentId: node.agentId, stage: node.stage, dependsOn: node.dependsOn, createdAt: this.now().toISOString() });
    const runner = await this.getRunner(node.agentId);
    const startedAt = this.now().toISOString();
    const runGoal = node.stage === 'final_synthesis' ? buildSynthesisGoal(goal) : goal;
    const runOptions = buildNodeOptions(options, plan, node, priorResults);
    const result = await runner.runRaw(runGoal, runOptions);
    const rootRunId = (await runner.inspect(result.runId)).run?.rootRunId ?? result.runId;
    const completedAt = this.now().toISOString();
    const status = result.status === 'success' ? 'succeeded' : result.status === 'failure' ? 'failed' : 'running';
    await this.linkStore.append({ sessionId: plan.sessionId, nodeId: node.id, runId: result.runId, rootRunId, stage: node.stage, agentId: node.agentId, requestedAgentId: plan.requestedAgentId, status, dependsOn: node.dependsOn, upstreamRunIds: node.dependsOn.map((dependency) => priorResults.get(dependency)?.runId).filter((runId): runId is string => Boolean(runId)), metadata: node.metadata, createdAt: startedAt, startedAt, completedAt });
    this.emitLifecycle({ type: 'orchestration.stage.linked', sessionId: plan.sessionId, requestedAgentId: plan.requestedAgentId, nodeId: node.id, agentId: node.agentId, stage: node.stage, runId: result.runId, rootRunId, status, createdAt: this.now().toISOString() });
    return { nodeId: node.id, stage: node.stage, agentId: node.agentId, runId: result.runId, rootRunId, result };
  }

  private emitLifecycle(event: OrchestrationLifecycleEvent): void {
    this.options.orchestrationListener?.(event);
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

export function buildOrchestrationPlan(params: { sessionId: string; requestedAgentId: string; goal: string; options: AgentSdkRunOptions; catalog: Map<string, AgentCatalogEntry>; finalizeWithRequestedAgent: boolean }): OrchestrationPlan {
  const requested = params.catalog.get(params.requestedAgentId);
  if (!requested) throw new Error(`Unknown requested agent "${params.requestedAgentId}"`);
  const inputClaims = detectInputClaims(params.goal, params.options);
  const detectedModalities = unique(inputClaims.map((claim) => claim.modality));
  const specialistModalities = detectedModalities.filter((modality) => shouldRouteToSpecialist(params.catalog, requested, modality));
  const subjectRouting = chooseSubjectSpecialist(params.catalog, params.goal, params.requestedAgentId);
  const subjectSpecialist = subjectRouting.selected;
  const detectedSubjects = subjectSpecialist?.matchedSubjects ?? [];
  const routingDiagnostics = { subjectCandidates: subjectRouting.candidates };
  if (specialistModalities.length === 0 && !subjectSpecialist) {
    return { sessionId: params.sessionId, requestedAgentId: params.requestedAgentId, detectedModalities, detectedSubjects, inputClaims, executionShape: 'single', nodes: [{ id: 'requested', agentId: params.requestedAgentId, stage: 'single', dependsOn: [], inputSelector: { includeGoal: true, includeOriginalInput: true } }], finalNodeId: 'requested', routingReason: `Requested agent "${params.requestedAgentId}" supports detected modalities: ${detectedModalities.join(', ')}.`, routingDiagnostics };
  }

  const specialistNodes: OrchestrationPlanNode[] = specialistModalities.map((modality) => {
    const specialist = chooseSpecialist(params.catalog, modality, params.requestedAgentId);
    if (!specialist) throw new Error(`No agent supports required modality "${modality}".`);
    return { id: `${modality}_specialist`, agentId: specialist.agentId, stage: specialistModalities.length === 1 ? 'modality_specialist' as const : 'parallel_specialist' as const, dependsOn: [], inputSelector: { includeGoal: true, claimIds: inputClaims.filter((claim) => claim.modality === modality).map((claim) => claim.id) }, outputRole: `${modality}_analysis` };
  });
  if (subjectSpecialist) {
    specialistNodes.push({ id: `subject_${slugify(subjectSpecialist.matchedSubjects[0] ?? subjectSpecialist.entry.agentId)}_specialist`, agentId: subjectSpecialist.entry.agentId, stage: 'subject_specialist', dependsOn: [], inputSelector: { includeGoal: true }, outputRole: `${subjectSpecialist.matchedSubjects.join('_') || 'subject'}_analysis`, metadata: { matchedSubjects: subjectSpecialist.matchedSubjects } });
  }
  if (!params.finalizeWithRequestedAgent) {
    const first = specialistNodes[0]!;
    return { sessionId: params.sessionId, requestedAgentId: params.requestedAgentId, detectedModalities, detectedSubjects, inputClaims, executionShape: specialistNodes.length === 1 ? 'single' : 'parallel_fanout_then_synthesis', nodes: specialistNodes, finalNodeId: first.id, routingReason: buildRoutingReason(params.requestedAgentId, specialistModalities, detectedSubjects, false), routingDiagnostics };
  }
  const finalNode = { id: 'final_synthesis', agentId: params.requestedAgentId, stage: 'final_synthesis' as const, dependsOn: specialistNodes.map((node) => node.id), inputSelector: { includeGoal: true, includeOriginalInput: true, includePriorOutputs: specialistNodes.map((node) => node.id) } };
  return { sessionId: params.sessionId, requestedAgentId: params.requestedAgentId, detectedModalities, detectedSubjects, inputClaims, executionShape: specialistNodes.length === 1 ? 'sequential' : 'parallel_fanout_then_synthesis', nodes: [...specialistNodes, finalNode], finalNodeId: finalNode.id, routingReason: buildRoutingReason(params.requestedAgentId, specialistModalities, detectedSubjects, true), routingDiagnostics };
}

function buildNodeOptions(options: OrchestratedRunOptions, plan: OrchestrationPlan, node: OrchestrationPlanNode, priorResults: Map<string, OrchestratedRunStageResult>): AgentSdkRunOptions {
  const priorOutputs = Object.fromEntries((node.inputSelector?.includePriorOutputs ?? node.dependsOn).map((id) => {
    const result = priorResults.get(id)?.result;
    return [id, resultToJson(result)];
  }));
  const orchestration = { sessionId: plan.sessionId, requestedAgentId: plan.requestedAgentId, selectedAgentId: node.agentId, executionShape: plan.executionShape, stage: node.stage, nodeId: node.id, dependsOn: node.dependsOn, detectedModalities: plan.detectedModalities, routingReason: plan.routingReason } satisfies JsonObject;
  if (node.stage === 'final_synthesis') {
    return { input: { originalInput: options.input ?? null, upstreamResults: priorOutputs }, context: { ...(options.context ?? {}), sessionId: plan.sessionId, orchestration }, outputSchema: options.outputSchema, metadata: { ...(options.metadata ?? {}), orchestration } };
  }
  return { ...selectNodeInputs(options, plan, node), context: { ...(options.context ?? {}), sessionId: plan.sessionId, orchestration }, outputSchema: options.outputSchema, metadata: { ...(options.metadata ?? {}), orchestration } };
}

function selectNodeInputs(options: OrchestratedRunOptions, plan: OrchestrationPlan, node: OrchestrationPlanNode): AgentSdkRunOptions {
  if (node.inputSelector?.includeOriginalInput) return options;
  const claimIds = new Set(node.inputSelector?.claimIds ?? []);
  const selectedClaims = plan.inputClaims.filter((claim) => claimIds.has(claim.id));
  return {
    ...(selectedClaims.some((claim) => claim.source === 'input') ? { input: options.input } : {}),
    ...selectImages(options, selectedClaims),
    ...selectContentParts(options, selectedClaims),
  };
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

function resultToJson(result: RunResult | undefined): JsonValue {
  if (!result) return null;
  if (result.status === 'success') return result.output;
  if (result.status === 'failure') return { status: result.status, runId: result.runId, error: result.error, code: result.code };
  return { status: result.status, runId: result.runId, message: result.message };
}

function buildSynthesisGoal(originalGoal: string): string {
  return ['Complete the original user request using the specialist result(s) already produced.', 'Do not assume access to raw attachments unless they are included explicitly.', '', `Original user request: ${originalGoal}`].join('\n');
}

function supportedModalities(config: AgentConfigFile): SupportedModality[] {
  return config.capabilities?.modalitiesSupported?.length ? config.capabilities.modalitiesSupported : ['text'];
}

function shouldRouteToSpecialist(catalog: Map<string, AgentCatalogEntry>, requested: AgentCatalogEntry, modality: SupportedModality): boolean {
  if (modality === 'text') return false;
  const requestedSupported = supportedModalities(requested.agentConfig);
  if (!requestedSupported.includes(modality)) return true;
  const specialist = chooseSpecialist(catalog, modality, requested.agentId);
  if (!specialist) return false;
  return specialistScore(specialist, modality) > specialistScore(requested, modality);
}

function chooseSpecialist(catalog: Map<string, AgentCatalogEntry>, modality: SupportedModality, excludeAgentId?: string): AgentCatalogEntry | undefined {
  return [...catalog.values()]
    .filter((entry) => entry.agentId !== excludeAgentId)
    .filter((entry) => supportedModalities(entry.agentConfig).includes(modality))
    .sort((left, right) => specialistScore(right, modality) - specialistScore(left, modality) || supportedModalities(left.agentConfig).length - supportedModalities(right.agentConfig).length || left.agentId.localeCompare(right.agentId))[0];
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

function specialistScore(entry: AgentCatalogEntry, modality: SupportedModality): number {
  let score = 0;
  if (entry.agentConfig.capabilities?.modalitiesPreferred?.includes(modality)) score += 4;
  if (entry.agentConfig.capabilities?.modalityRoles?.[modality] === 'analyze') score += 2;
  if (entry.agentId.toLowerCase().includes(modality)) score += 1;
  return score;
}

async function buildCatalog(options: OrchestrationSdkOptions): Promise<AgentCatalogEntry[]> {
  const entries = new Map<string, AgentCatalogEntry>();
  for (const entry of options.agentCatalog ?? []) entries.set(entry.agentId, entry);
  const cwd = options.cwd ?? process.cwd();
  const env = { ...(options.env ?? process.env), ...(options.settingsConfig?.env ?? {}) };
  const agentDirs = await resolveCatalogAgentDirs(options, cwd, env);
  for (const pathOrName of options.agentCatalogPaths ?? []) {
    const configPath = await resolveAgentConfigByName(pathOrName, agentDirs) ?? resolvePath(cwd, pathOrName);
    const agentConfig = expandStrings(await readJson(configPath), env) as AgentConfigFile;
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

class InMemoryOrchestrationSessionStore implements OrchestrationSessionStore {
  private readonly sessions = new Map<string, OrchestrationSessionRecord>();
  async create(session: OrchestrationSessionRecord): Promise<OrchestrationSessionRecord> { this.sessions.set(session.id, session); return session; }
  async get(sessionId: string): Promise<OrchestrationSessionRecord | undefined> { return this.sessions.get(sessionId); }
  async update(session: OrchestrationSessionRecord): Promise<OrchestrationSessionRecord> { this.sessions.set(session.id, session); return session; }
}

class InMemoryOrchestrationSessionRunLinkStore implements OrchestrationSessionRunLinkStore {
  private readonly links: OrchestrationSessionRunLinkRecord[] = [];
  async append(link: OrchestrationSessionRunLinkRecord): Promise<OrchestrationSessionRunLinkRecord> { this.links.push(link); return link; }
  async update(link: OrchestrationSessionRunLinkRecord): Promise<OrchestrationSessionRunLinkRecord> { const index = this.links.findIndex((entry) => entry.sessionId === link.sessionId && entry.nodeId === link.nodeId); if (index >= 0) this.links[index] = link; return link; }
  async listBySession(sessionId: string): Promise<OrchestrationSessionRunLinkRecord[]> { return this.links.filter((link) => link.sessionId === sessionId); }
  async getByRunId(runId: string): Promise<OrchestrationSessionRunLinkRecord | undefined> { return this.links.find((link) => link.runId === runId); }
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function randomSessionId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
