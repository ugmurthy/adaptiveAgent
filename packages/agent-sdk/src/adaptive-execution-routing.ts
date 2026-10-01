import type { JsonSchema, JsonValue, RunResult } from '@adaptive-agent/core';

import { safeCandidateSummary } from './agent-selection.js';
import { selectAgentProfileWithTypeSafe } from './typesafe-agent-selection.js';
import type {
  AgentSdkCatalogAgent,
  SupportedModality,
  TypeSafeAgentSelectionPolicyConfig,
  TypeSafePolicyProvenance,
} from './config-types.js';
import {
  validateExecutionRoutingDecision,
  type ExecutionRoutingCatalogEntry,
  type ExecutionRoutingDecision,
} from './execution-routing.js';
import type { TaskPreparationAttachmentSummary, TaskPreparationRunner } from './task-preparation.js';
import type {
  TypeSafeAgentSelectionClient,
  TypeSafeAgentSelectionResponse,
} from './typesafe-agent-selection.js';

export interface AdaptiveExecutionRoutingRequest {
  originalObjective: string;
  candidates: AgentSdkCatalogAgent[];
  workspaceRoot: string;
  attachments: TaskPreparationAttachmentSummary;
  sessionId: string;
  maxSpecialists: number;
}

export interface AdaptiveExecutionRoutingResult {
  decision: ExecutionRoutingDecision;
  routerId: string;
  /** Set by staged TypeSafe orchestration for reporting choice confidence independently of relevance. */
  choiceConfidence?: number;
  policy?: TypeSafePolicyProvenance;
  routingRunId?: string;
  routingModel?: string;
  relevance?: number;
  usage?: { inputTokens: number; outputTokens: number };
  rejectedTypeSafe?: {
    decision: ExecutionRoutingDecision;
    model: string;
    policy?: TypeSafePolicyProvenance;
    choiceConfidence: number;
    relevance: number;
    threshold: 'confidence' | 'relevance';
    minimum: number;
    usage?: { inputTokens: number; outputTokens: number };
  };
}

export class ExecutionRoutingConfidenceError extends Error {
  constructor(
    message: string,
    readonly confidence: number,
    readonly rejectedTypeSafe?: NonNullable<AdaptiveExecutionRoutingResult['rejectedTypeSafe']>,
  ) {
    super(message);
    this.name = 'ExecutionRoutingConfidenceError';
  }
}

/** Opt-in mode-first routing for evaluation; existing automatic runs retain the combined request. */
export async function selectStagedExecutionRoutingWithTypeSafe(
  client: TypeSafeAgentSelectionClient,
  request: AdaptiveExecutionRoutingRequest,
  model: string,
  policy: TypeSafeAgentSelectionPolicyConfig = {},
): Promise<AdaptiveExecutionRoutingResult & {
  stages: Array<{ name: 'mode' | 'selection' | 'assignments'; confidence: number; relevance?: number; usage?: { inputTokens: number; outputTokens: number } }>;
}> {
  const candidates = eligibleRoutingCandidates(request.candidates);
  const modalities = routingModalities(request.attachments);
  assertModalityCoverage(candidates, modalities);
  const directCandidates = candidates.filter((candidate) =>
    modalities.every((modality) => supportedCandidateModalities(candidate).includes(modality))
  );
  const modes = directCandidates.length === 0 ? ['orchestration']
    : candidates.length === 1 ? ['direct'] : ['direct', 'orchestration'];
  let modeConfidence = 1;
  let modeUsage: { inputTokens: number; outputTokens: number } | undefined;
  let mode = modes[0]!;
  if (modes.length > 1) {
    const response = await client.evaluate({
      model,
      state: {
        objective: request.originalObjective,
        attachments: attachmentInventory(request.attachments),
        candidates: candidates.map((candidate) => ({
          id: candidate.id, name: candidate.name, description: candidate.description ?? '',
          modalities: supportedCandidateModalities(candidate), tools: candidate.tools,
        })),
        limits: { maxSpecialists: request.maxSpecialists },
      },
      questions: {
        execution_mode: {
          type: 'choice',
          instructions: policy.routing?.modeInstructions ?? null,
          criteria: {
            direct: 'One eligible profile can own and complete the entire objective.',
            orchestration: 'A distinct specialist contribution is useful and can be represented by the supplied modalities.',
          },
        },
      },
    });
    mode = readChoice(response, 'execution_mode', modes);
    modeConfidence = readChoiceConfidence(response, 'execution_mode', modes);
    if (response.usage) modeUsage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
  }
  const stages: Array<{ name: 'mode' | 'selection' | 'assignments'; confidence: number; relevance?: number; usage?: { inputTokens: number; outputTokens: number } }> = [
    { name: 'mode', confidence: modeConfidence, ...(modeUsage ? { usage: modeUsage } : {}) },
  ];
  if (policy.minimumConfidence !== undefined && modeConfidence < policy.minimumConfidence) {
    throw new ExecutionRoutingConfidenceError(
      `Execution mode confidence ${modeConfidence.toFixed(3)} is below the configured minimum ${policy.minimumConfidence.toFixed(3)}.`,
      modeConfidence,
    );
  }

  if (mode === 'direct') {
    const selection = await selectAgentProfileWithTypeSafe(client, { ...request, candidates: directCandidates }, model, policy);
    stages.push({ name: 'selection', confidence: selection.confidence!, relevance: selection.relevance, ...(selection.usage ? { usage: selection.usage } : {}) });
    const usage = combinedUsage(modeUsage, selection.usage);
    const decision: ExecutionRoutingDecision = {
      mode: 'direct', primaryAgentId: selection.selectedAgentId,
      assignments: [{ agentId: selection.selectedAgentId, modalities, reason: selection.reason }],
      selectedCatalogAgentIds: [selection.selectedAgentId], reason: selection.reason,
      confidence: Math.min(modeConfidence, selection.confidence!, selection.relevance!), source: 'typesafe',
    };
    validateRouting(decision, candidates, modalities, request.maxSpecialists);
    return { decision, routerId: `typesafe:${selection.selectionModel}`, routingModel: selection.selectionModel,
      relevance: selection.relevance, ...(usage ? { usage } : {}), stages };
  }

  const result = await selectExecutionRoutingWithTypeSafe(client, request, model, policy, 'orchestration');
  if (result.decision.assignments.every((assignment) => assignment.agentId === result.decision.primaryAgentId)) {
    throw new Error('Staged orchestration requires a specialist distinct from the primary agent.');
  }
  stages.push({ name: 'assignments', confidence: result.choiceConfidence!, relevance: result.relevance,
    ...(result.usage ? { usage: result.usage } : {}) });
  const usage = combinedUsage(modeUsage, result.usage);
  return { ...result, decision: { ...result.decision, confidence: Math.min(modeConfidence, result.decision.confidence!) },
    ...(usage ? { usage } : {}), stages };
}

function combinedUsage(...parts: Array<{ inputTokens: number; outputTokens: number } | undefined>) {
  const present = parts.filter((part): part is { inputTokens: number; outputTokens: number } => Boolean(part));
  return present.length ? {
    inputTokens: present.reduce((sum, part) => sum + part.inputTokens, 0),
    outputTokens: present.reduce((sum, part) => sum + part.outputTokens, 0),
  } : undefined;
}

export async function selectExecutionRoutingWithAgent(
  runner: TaskPreparationRunner,
  request: AdaptiveExecutionRoutingRequest,
  minimumConfidence = 0.5,
): Promise<AdaptiveExecutionRoutingResult> {
  const candidates = eligibleRoutingCandidates(request.candidates, runner.config.agent.id);
  const modalities = routingModalities(request.attachments);
  assertModalityCoverage(candidates, modalities);
  const ids = candidates.map((candidate) => candidate.id);
  const outputSchema: JsonSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['mode', 'primaryAgentId', 'assignments', 'reason', 'confidence'],
    properties: {
      mode: { enum: ['direct', 'orchestration'] },
      primaryAgentId: { enum: ids },
      synthesisAgentId: { enum: ids },
      assignments: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['agentId', 'modalities', 'reason'],
          properties: {
            agentId: { enum: ids },
            modalities: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: modalities } },
            reason: { type: 'string', minLength: 1 },
          },
        },
      },
      reason: { type: 'string', minLength: 1 },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
  };
  const result = await runner.runRaw(buildRoutingGoal(request.maxSpecialists), {
    sessionId: request.sessionId,
    input: {
      originalObjective: request.originalObjective,
      workspaceRoot: request.workspaceRoot,
      attachments: attachmentInventory(request.attachments),
      candidates: candidates.map(safeCandidateSummary) as unknown as JsonValue,
    },
    outputSchema,
    forbiddenTools: [...new Set([
      ...runner.config.agent.tools,
      ...(runner.config.agent.delegates ?? []).map((name) => `delegate.${name}`),
    ])],
    metadata: {
      command: 'execution-routing',
      role: 'execution-router',
      candidateAgentIds: ids,
    },
  });
  if (result.status !== 'success') throw new Error(formatRoutingFailure(result));
  if (!isRecord(result.output)) throw new Error('Execution router returned a non-object result.');
  const decision = parseAgentDecision(result.output, candidates, modalities);
  validateRouting(decision, candidates, modalities, request.maxSpecialists);
  enforceConfidence(decision.confidence, minimumConfidence);
  return { decision, routerId: runner.config.agent.id, routingRunId: result.runId };
}

export async function selectExecutionRoutingWithTypeSafe(
  client: TypeSafeAgentSelectionClient,
  request: AdaptiveExecutionRoutingRequest,
  model: string,
  policy: TypeSafeAgentSelectionPolicyConfig = {},
  branch?: 'orchestration',
): Promise<AdaptiveExecutionRoutingResult> {
  const candidates = eligibleRoutingCandidates(request.candidates);
  const modalities = routingModalities(request.attachments);
  assertModalityCoverage(candidates, modalities);
  const questions: Record<string, JsonValue> = {};
  const candidateSummaries = candidates.map(safeCandidateSummary);
  candidates.forEach((candidate, index) => {
    for (const modality of supportedCandidateModalities(candidate).filter((value) => modalities.includes(value))) {
      questions[relevanceKey(index, modality)] = {
        type: 'noul',
        instructions: {
          question: policy.relevance?.instructions ?? null,
          objective: '`objective`',
          modality,
          candidate: `\`candidates[${index}]\``,
        },
        criteria: policy.relevance?.criteria ?? null,
      };
    }
  });

  const directCandidates = candidates.filter((candidate) =>
    modalities.every((modality) => supportedCandidateModalities(candidate).includes(modality))
  );
  const modes = branch ? ['orchestration'] : directCandidates.length > 0 && candidates.length > 1
    ? ['direct', 'orchestration']
    : directCandidates.length > 0 ? ['direct'] : ['orchestration'];
  addChoiceQuestion(questions, 'execution_mode', modes, policy.routing?.modeInstructions ?? null, {
    direct: 'One profile should complete the objective and consume every modality.',
    orchestration: 'Different profiles should handle modalities or specialization before synthesis.',
  });
  if (!branch) addCandidateChoice(questions, 'direct_primary', directCandidates, candidateSummaries, policy, policy.routing?.primaryInstructions ?? null);
  const primaryCandidates = candidates.filter((candidate) => supportedCandidateModalities(candidate).includes('text'));
  addCandidateChoice(questions, 'orchestration_primary', primaryCandidates, candidateSummaries, policy, policy.routing?.primaryInstructions ?? null, Boolean(branch));
  if (branch) {
    for (const candidate of primaryCandidates) {
      const index = candidates.indexOf(candidate);
      questions[`candidate_${index}_primary_relevant`] = {
        type: 'noul',
        instructions: { question: 'Can this primary own the objective and synthesize specialist results?',
          objective: '`objective`', candidate: `\`candidates[${index}]\`` },
        criteria: policy.relevance?.criteria ?? null,
      };
    }
  }
  for (const modality of modalities) {
    addCandidateChoice(
      questions,
      `assignment_${modality}`,
      candidates.filter((candidate) => supportedCandidateModalities(candidate).includes(modality)),
      candidateSummaries,
      policy,
      policy.routing?.assignmentInstructions ?? null,
      Boolean(branch),
    );
  }

  const response = await client.evaluate({
    model,
    state: {
      objective: request.originalObjective,
      attachments: attachmentInventory(request.attachments),
      candidates: candidateSummaries,
      limits: { maxSpecialists: request.maxSpecialists },
    },
    questions,
  });
  const modeChoice = readChoice(response, 'execution_mode', modes);
  if (modeChoice !== 'direct' && modeChoice !== 'orchestration') throw new Error('TypeSafe execution router returned an invalid execution mode.');
  const mode = modeChoice;
  const primaryPool = mode === 'direct' ? directCandidates : primaryCandidates;
  const primaryAgentId = readChoice(response, mode === 'direct' ? 'direct_primary' : 'orchestration_primary', primaryPool.map((candidate) => candidate.id));
  let assigned = mode === 'direct'
    ? modalities.map((modality) => ({ modality, agentId: primaryAgentId }))
    : modalities.map((modality) => {
        const eligible = candidates.filter((candidate) => supportedCandidateModalities(candidate).includes(modality));
        return { modality, agentId: readChoice(response, `assignment_${modality}`, eligible.map((candidate) => candidate.id)) };
      });
  if (branch && unique(assigned.map(({ agentId }) => agentId).filter((id) => id !== primaryAgentId)).length > request.maxSpecialists) {
    assigned = boundedAssignments(response, candidates, modalities, primaryAgentId, request.maxSpecialists);
  }
  const assignments = groupAssignments(assigned);
  const choiceConfidences = [
    readChoiceConfidence(response, 'execution_mode', modes),
    readChoiceConfidence(response, mode === 'direct' ? 'direct_primary' : 'orchestration_primary', primaryPool.map((candidate) => candidate.id)),
    ...(mode === 'orchestration' ? modalities.map((modality) => {
      const eligible = candidates.filter((candidate) => supportedCandidateModalities(candidate).includes(modality));
      const key = `assignment_${modality}`;
      const confidence = readChoiceConfidence(response, key, eligible.map((candidate) => candidate.id));
      const answer = response.answers[key];
      const chosen = assigned.find((assignment) => assignment.modality === modality)!.agentId;
      return branch && answer?.type === 'choice' && chosen !== answer.choice
        ? answer.probabilities[chosen]!
        : confidence;
    }) : []),
  ];
  const relevance = assigned.map(({ modality, agentId }) => {
    const index = candidates.findIndex((candidate) => candidate.id === agentId);
    const answer = response.answers[relevanceKey(index, modality)];
    if (!answer || answer.type !== 'noul' || !isProbability(answer.noul)) {
      throw new Error(`TypeSafe execution router returned invalid relevance for agent "${agentId}" and modality "${modality}".`);
    }
    return answer.noul;
  });
  if (branch) {
    const answer = response.answers[`candidate_${candidates.findIndex((candidate) => candidate.id === primaryAgentId)}_primary_relevant`];
    if (!answer || answer.type !== 'noul' || !isProbability(answer.noul)) {
      throw new Error('TypeSafe execution router returned invalid primary synthesis relevance.');
    }
    relevance.push(answer.noul);
  }
  const confidence = Math.min(...choiceConfidences, ...relevance);
  const decision: ExecutionRoutingDecision = {
    mode,
    primaryAgentId,
    ...(mode === 'orchestration' && assignments.some((assignment) => assignment.agentId !== primaryAgentId)
      ? { synthesisAgentId: primaryAgentId }
      : {}),
    assignments,
    selectedCatalogAgentIds: unique([
      primaryAgentId,
      ...assignments.map((assignment) => assignment.agentId),
    ]),
    reason: mode === 'direct'
      ? `TypeSafe selected direct execution with "${primaryAgentId}".`
      : `TypeSafe selected specialist orchestration with primary agent "${primaryAgentId}".`,
    confidence,
    source: 'typesafe',
  };
  validateRouting(decision, candidates, modalities, request.maxSpecialists);
  const attempt = {
    decision,
    model: response.model,
    choiceConfidence: Math.min(...choiceConfidences),
    relevance: Math.min(...relevance),
    ...(response.usage ? { usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens } } : {}),
  };
  if (policy.minimumConfidence !== undefined && attempt.choiceConfidence < policy.minimumConfidence) {
    throw new ExecutionRoutingConfidenceError(
      `Execution routing confidence ${attempt.choiceConfidence.toFixed(3)} is below the configured minimum ${policy.minimumConfidence.toFixed(3)}.`,
      attempt.choiceConfidence, { ...attempt, threshold: 'confidence', minimum: policy.minimumConfidence });
  }
  if (policy.minimumRelevance !== undefined && attempt.relevance < policy.minimumRelevance) {
    throw new ExecutionRoutingConfidenceError(
      `Execution routing relevance ${attempt.relevance.toFixed(3)} is below the configured minimum ${policy.minimumRelevance.toFixed(3)}.`,
      attempt.relevance, { ...attempt, threshold: 'relevance', minimum: policy.minimumRelevance },
    );
  }
  return { decision, routerId: `typesafe:${response.model}`, routingModel: response.model, relevance: attempt.relevance,
    ...(branch ? { choiceConfidence: attempt.choiceConfidence } : {}),
    ...(attempt.usage ? { usage: attempt.usage } : {}) };
}

export function directRoutingFallback(
  candidate: AgentSdkCatalogAgent,
  attachments: TaskPreparationAttachmentSummary,
  confidence: number,
): ExecutionRoutingDecision {
  const modalities = routingModalities(attachments);
  if (!modalities.every((modality) => supportedCandidateModalities(candidate).includes(modality))) {
    throw new Error(`Low-confidence routing cannot fall back to agent "${candidate.id}" because it does not support every input modality.`);
  }
  return {
    mode: 'direct',
    primaryAgentId: candidate.id,
    assignments: [{ agentId: candidate.id, modalities, reason: 'Safe direct fallback after low-confidence adaptive routing.' }],
    selectedCatalogAgentIds: [candidate.id],
    reason: `Adaptive routing confidence ${confidence.toFixed(3)} was below policy; using configured direct fallback "${candidate.id}".`,
    confidence,
    source: 'deterministic',
  };
}

function parseAgentDecision(
  output: Record<string, JsonValue>,
  candidates: AgentSdkCatalogAgent[],
  modalities: SupportedModality[],
): ExecutionRoutingDecision {
  const ids = candidates.map((candidate) => candidate.id);
  const mode = output.mode;
  const primaryAgentId = output.primaryAgentId;
  const synthesisAgentId = output.synthesisAgentId;
  const reason = output.reason;
  const confidence = output.confidence;
  if (mode !== 'direct' && mode !== 'orchestration') throw new Error('Execution router returned an invalid mode.');
  if (typeof primaryAgentId !== 'string' || !ids.includes(primaryAgentId)) throw new Error('Execution router returned an unknown primaryAgentId.');
  if (synthesisAgentId !== undefined && (typeof synthesisAgentId !== 'string' || !ids.includes(synthesisAgentId))) throw new Error('Execution router returned an unknown synthesisAgentId.');
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('Execution router returned an empty reason.');
  if (typeof confidence !== 'number' || !isProbability(confidence)) throw new Error('Execution router returned confidence outside the range 0 to 1.');
  if (!Array.isArray(output.assignments)) throw new Error('Execution router returned invalid assignments.');
  const assignments = output.assignments.map((value) => {
    if (!isRecord(value)) throw new Error('Execution router returned a non-object assignment.');
    const agentId = value.agentId;
    const assignedModalities = value.modalities;
    const assignmentReason = value.reason;
    if (typeof agentId !== 'string' || !ids.includes(agentId)) throw new Error('Execution router assignment contains an unknown agentId.');
    if (!Array.isArray(assignedModalities) || !assignedModalities.every((modality): modality is SupportedModality => typeof modality === 'string' && modalities.includes(modality as SupportedModality))) throw new Error('Execution router assignment contains an invalid modality.');
    if (typeof assignmentReason !== 'string' || !assignmentReason.trim()) throw new Error('Execution router assignment contains an empty reason.');
    return { agentId, modalities: assignedModalities, reason: assignmentReason.trim() };
  });
  const normalizedSynthesis = mode === 'orchestration'
    && assignments.some((assignment) => assignment.agentId !== primaryAgentId)
    ? synthesisAgentId ?? primaryAgentId
    : synthesisAgentId;
  return {
    mode,
    primaryAgentId,
    ...(normalizedSynthesis ? { synthesisAgentId: normalizedSynthesis } : {}),
    assignments,
    selectedCatalogAgentIds: unique([primaryAgentId, ...(normalizedSynthesis ? [normalizedSynthesis] : []), ...assignments.map((assignment) => assignment.agentId)]),
    reason: reason.trim(),
    confidence,
    source: 'agent',
  };
}

function validateRouting(
  decision: ExecutionRoutingDecision,
  candidates: AgentSdkCatalogAgent[],
  modalities: SupportedModality[],
  maxSpecialists: number,
): void {
  validateExecutionRoutingDecision(decision, modalities, routingCatalog(candidates), { maxSpecialists });
}

function routingCatalog(candidates: AgentSdkCatalogAgent[]): Map<string, ExecutionRoutingCatalogEntry> {
  return new Map(candidates.map((candidate) => [candidate.id, {
    agentId: candidate.id,
    agentConfig: {
      id: candidate.id,
      name: candidate.name,
      invocationModes: candidate.invocationModes,
      defaultInvocationMode: candidate.defaultInvocationMode,
      model: {},
      tools: candidate.tools,
      delegates: candidate.delegates,
      capabilities: candidate.capabilities,
    },
  }]));
}

function eligibleRoutingCandidates(candidates: AgentSdkCatalogAgent[], excludedAgentId?: string): AgentSdkCatalogAgent[] {
  return candidates.filter((candidate) =>
    !candidate.archived
    && candidate.validationState === 'valid'
    && candidate.id !== excludedAgentId
    && candidate.invocationModes.includes('run')
  );
}

function routingModalities(attachments: TaskPreparationAttachmentSummary): SupportedModality[] {
  return unique([
    'text',
    ...(attachments.images.length > 0 ? ['image' as const] : []),
    ...(attachments.files.length > 0 ? ['file' as const] : []),
    ...(attachments.audio.length > 0 ? ['audio' as const] : []),
  ]);
}

function supportedCandidateModalities(candidate: AgentSdkCatalogAgent): SupportedModality[] {
  return candidate.capabilities?.modalitiesSupported?.length ? candidate.capabilities.modalitiesSupported : ['text'];
}

function assertModalityCoverage(candidates: AgentSdkCatalogAgent[], modalities: SupportedModality[]): void {
  if (candidates.length === 0) throw new Error('Adaptive execution routing requires at least one valid active run profile.');
  for (const modality of modalities) {
    if (!candidates.some((candidate) => supportedCandidateModalities(candidate).includes(modality))) {
      throw new Error(`Adaptive execution routing found no valid run profile supporting modality "${modality}".`);
    }
  }
}

function attachmentInventory(attachments: TaskPreparationAttachmentSummary): JsonValue {
  return {
    types: routingModalities(attachments),
    counts: {
      images: attachments.images.length,
      files: attachments.files.length,
      audio: attachments.audio.length,
    },
  };
}

function buildRoutingGoal(maxSpecialists: number): string {
  return [
    'Choose direct execution or a flat specialist orchestration for the supplied objective.',
    'Return only the object required by outputSchema.',
    'Use only supplied candidate agent IDs and detected modalities.',
    'Assign every modality exactly once and do not invent profiles, paths, definitions, or stages.',
    `Use at most ${maxSpecialists} specialist agents outside the primary agent.`,
    'For orchestration, choose a primary synthesis agent and group multiple modalities assigned to one agent.',
    'Choose direct only when the primary agent supports every modality.',
  ].join('\n');
}

function addCandidateChoice(
  questions: Record<string, JsonValue>,
  key: string,
  eligible: AgentSdkCatalogAgent[],
  summaries: Array<Record<string, JsonValue>>,
  policy: TypeSafeAgentSelectionPolicyConfig,
  instructions: JsonValue,
  compact = false,
): void {
  if (eligible.length <= 1) return;
  const byId = new Map(summaries.map((summary, index) => [summary.id, compact ? `\`candidates[${index}]\`` : summary]));
  questions[key] = {
    type: 'choice',
    instructions: compact && policy.selection?.candidateCriteria !== undefined
      ? { question: instructions, candidateCriteria: policy.selection.candidateCriteria }
      : instructions,
    criteria: Object.fromEntries(eligible.map((candidate) => [candidate.id, {
      profile: byId.get(candidate.id) ?? null,
      ...(compact || policy.selection?.candidateCriteria === undefined ? {} : { guidance: policy.selection.candidateCriteria }),
    }])),
  };
}

function addChoiceQuestion(
  questions: Record<string, JsonValue>,
  key: string,
  choices: string[],
  instructions: JsonValue,
  criteria: Record<string, JsonValue>,
): void {
  if (choices.length <= 1) return;
  questions[key] = { type: 'choice', instructions, criteria: Object.fromEntries(choices.map((choice) => [choice, criteria[choice] ?? choice])) };
}

function readChoice(response: TypeSafeAgentSelectionResponse, key: string, eligible: string[]): string {
  if (eligible.length === 1) return eligible[0]!;
  const answer = response.answers[key];
  if (!answer || answer.type !== 'choice' || !eligible.includes(answer.choice)) {
    throw new Error(`TypeSafe execution router returned an invalid ${key} choice.`);
  }
  return answer.choice;
}

function readChoiceConfidence(response: TypeSafeAgentSelectionResponse, key: string, eligible: string[]): number {
  if (eligible.length === 1) return 1;
  const answer = response.answers[key];
  if (!answer || answer.type !== 'choice' || !isProbability(answer.confidence)) {
    throw new Error(`TypeSafe execution router returned invalid confidence for ${key}.`);
  }
  return answer.confidence;
}

function boundedAssignments(
  response: TypeSafeAgentSelectionResponse,
  candidates: AgentSdkCatalogAgent[],
  modalities: SupportedModality[],
  primaryAgentId: string,
  maxSpecialists: number,
): Array<{ modality: SupportedModality; agentId: string }> {
  let best: Array<{ modality: SupportedModality; agentId: string }> | undefined;
  let bestScore = -Infinity;
  const visit = (index: number, assigned: Array<{ modality: SupportedModality; agentId: string }>, specialists: Set<string>, score: number) => {
    if (index === modalities.length) {
      if (specialists.size > 0 && score > bestScore) { best = [...assigned]; bestScore = score; }
      return;
    }
    const modality = modalities[index]!;
    const eligible = candidates.filter((candidate) => supportedCandidateModalities(candidate).includes(modality));
    const answer = response.answers[`assignment_${modality}`];
    for (const candidate of eligible) {
      const probability = eligible.length === 1 ? 1
        : answer?.type === 'choice' ? answer.probabilities[candidate.id] : undefined;
      if (probability === undefined || !isProbability(probability) || probability === 0) continue;
      const next = new Set(specialists);
      if (candidate.id !== primaryAgentId) next.add(candidate.id);
      if (next.size > maxSpecialists) continue;
      visit(index + 1, [...assigned, { modality, agentId: candidate.id }], next, score + Math.log(probability));
    }
  };
  visit(0, [], new Set(), 0);
  if (!best) throw new Error(`TypeSafe assignments cannot satisfy the maximum of ${maxSpecialists} specialists.`);
  return best;
}

function groupAssignments(assignments: Array<{ modality: SupportedModality; agentId: string }>) {
  const grouped = new Map<string, SupportedModality[]>();
  for (const assignment of assignments) grouped.set(assignment.agentId, [...(grouped.get(assignment.agentId) ?? []), assignment.modality]);
  return [...grouped].map(([agentId, modalities]) => ({ agentId, modalities, reason: `TypeSafe assigned ${modalities.join(', ')} to "${agentId}".` }));
}

function relevanceKey(index: number, modality: SupportedModality): string {
  return `candidate_${index}_${modality}_relevant`;
}

function enforceConfidence(confidence: number | undefined, minimum: number): void {
  if (confidence === undefined || !isProbability(confidence)) throw new Error('Execution router returned invalid confidence.');
  if (confidence < minimum) {
    throw new ExecutionRoutingConfidenceError(
      `Execution routing confidence ${confidence.toFixed(3)} is below the configured minimum ${minimum.toFixed(3)}.`,
      confidence,
    );
  }
}

function formatRoutingFailure(result: Exclude<RunResult, { status: 'success' }>): string {
  if (result.status === 'failure') return `Execution routing failed: ${result.code} ${result.error}`;
  return `Execution routing stopped with status ${result.status}: ${result.message}`;
}

function isProbability(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
