import type { JsonSchema, JsonValue, RunResult } from '@adaptive-agent/core';

import { safeCandidateSummary } from './agent-selection.js';
import type {
  AgentSdkCatalogAgent,
  SupportedModality,
  TypeSafeAgentSelectionPolicyConfig,
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
  routingRunId?: string;
  routingModel?: string;
}

export class ExecutionRoutingConfidenceError extends Error {
  constructor(
    message: string,
    readonly confidence: number,
  ) {
    super(message);
    this.name = 'ExecutionRoutingConfidenceError';
  }
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
          question: policy.relevance?.instructions ?? 'Is this candidate a strong match for the objective and assigned modality?',
          objective: '`objective`',
          modality,
          candidate: `\`candidates[${index}]\``,
        },
        criteria: policy.relevance?.criteria ?? {
          true: 'The candidate is capable and well suited to this modality and objective.',
          false: 'The candidate is weakly matched or unsuitable for this modality or objective.',
        },
      };
    }
  });

  const directCandidates = candidates.filter((candidate) =>
    modalities.every((modality) => supportedCandidateModalities(candidate).includes(modality))
  );
  const modes = directCandidates.length > 0 && candidates.length > 1
    ? ['direct', 'orchestration']
    : directCandidates.length > 0 ? ['direct'] : ['orchestration'];
  addChoiceQuestion(questions, 'execution_mode', modes, policy.routing?.modeInstructions ?? 'Choose direct execution or specialist orchestration.', {
    direct: 'One profile should complete the objective and consume every modality.',
    orchestration: 'Different profiles should handle modalities or specialization before synthesis.',
  });
  addCandidateChoice(questions, 'direct_primary', directCandidates, candidateSummaries, policy, policy.routing?.primaryInstructions ?? 'Choose the direct execution profile.');
  const primaryCandidates = candidates.filter((candidate) => supportedCandidateModalities(candidate).includes('text'));
  addCandidateChoice(questions, 'orchestration_primary', primaryCandidates, candidateSummaries, policy, policy.routing?.primaryInstructions ?? 'Choose the primary synthesis profile.');
  for (const modality of modalities) {
    addCandidateChoice(
      questions,
      `assignment_${modality}`,
      candidates.filter((candidate) => supportedCandidateModalities(candidate).includes(modality)),
      candidateSummaries,
      policy,
      policy.routing?.assignmentInstructions ?? `Choose the best profile for the ${modality} input claims.`,
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
  const assigned = mode === 'direct'
    ? modalities.map((modality) => ({ modality, agentId: primaryAgentId }))
    : modalities.map((modality) => {
        const eligible = candidates.filter((candidate) => supportedCandidateModalities(candidate).includes(modality));
        return { modality, agentId: readChoice(response, `assignment_${modality}`, eligible.map((candidate) => candidate.id)) };
      });
  const assignments = groupAssignments(assigned);
  const choiceConfidences = [
    readChoiceConfidence(response, 'execution_mode', modes),
    readChoiceConfidence(response, mode === 'direct' ? 'direct_primary' : 'orchestration_primary', primaryPool.map((candidate) => candidate.id)),
    ...(mode === 'orchestration' ? modalities.map((modality) => {
      const eligible = candidates.filter((candidate) => supportedCandidateModalities(candidate).includes(modality));
      return readChoiceConfidence(response, `assignment_${modality}`, eligible.map((candidate) => candidate.id));
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
  const minimumConfidence = policy.minimumConfidence ?? 0.5;
  const minimumRelevance = policy.minimumRelevance ?? 0.5;
  enforceConfidence(Math.min(...choiceConfidences), minimumConfidence);
  if (Math.min(...relevance) < minimumRelevance) {
    throw new ExecutionRoutingConfidenceError(
      `Execution routing relevance ${Math.min(...relevance).toFixed(3)} is below the configured minimum ${minimumRelevance.toFixed(3)}.`,
      Math.min(...relevance),
    );
  }
  return { decision, routerId: `typesafe:${response.model}`, routingModel: response.model };
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
): void {
  if (eligible.length <= 1) return;
  const byId = new Map(summaries.map((summary) => [summary.id, summary]));
  questions[key] = {
    type: 'choice',
    instructions,
    criteria: Object.fromEntries(eligible.map((candidate) => [candidate.id, {
      profile: byId.get(candidate.id) ?? null,
      ...(policy.selection?.candidateCriteria === undefined ? {} : { guidance: policy.selection.candidateCriteria }),
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
